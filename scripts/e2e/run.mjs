#!/usr/bin/env node
// P6 E2E harness: drives real opencode 1.19.0 against scripts/e2e/mock.mjs.
// Usage: node scripts/e2e/run.mjs <scenario>
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = resolve(new URL("../..", import.meta.url).pathname);
const E2E = join(REPO, ".e2e");
const PORT = Number(process.env.MOCK_PORT || 8787);

const scenarioName = process.argv[2];
if (!scenarioName) {
  console.error("usage: run.mjs <s1|s2|s3|s4>");
  process.exit(2);
}

// ---------- fixtures ----------
function bigText() {
  const lines = ["BIGSTART line one"];
  for (let i = 0; i < 400; i++) lines.push(`LINE ${i} ${"pad".repeat(30)} payload ${i}`);
  lines.push("MIDDLE_MARKER_XYZZY should not appear once replaced");
  for (let i = 0; i < 400; i++) lines.push(`LINE b${i} ${"pad".repeat(30)} payload ${i}`);
  lines.push("BIGEND last line");
  return lines.join("\n") + "\n";
}
function buildLog() {
  const lines = [];
  for (let i = 0; i < 120; i++) lines.push(`[build ${i}] compiling module foo_${i} with flags -O2 -Wall`);
  lines.push("warning: unused variable `scratch` in module foo_42");
  lines.push("Build succeeded: 132 targets, 0 errors, 1 warning");
  lines.push("Total time: 41.7s");
  return lines.join("\n") + "\n";
}

// ---------- scenarios ----------
const SCENARIOS = {
  s1: {
    goal: "run the big command and summarize",
    solPi: { observationPack: { enabled: true, thresholdBytes: 10240, fullSends: 2, excerptBytes: 1024 } },
    fixtures: { "big.txt": bigText() },
    script: {
      entries: [
        { match: "run the big command", tool_calls: [{ name: "bash", arguments: { command: "cat big.txt" } }] },
        { match: "cat big.txt", tool_calls: [{ name: "bash", arguments: { command: "echo SECOND_OK" } }] },
        { match: "SECOND_OK", tool_calls: [{ name: "bash", arguments: { command: "echo THIRD_OK" } }] },
        { match: "THIRD_OK", content: "done" },
      ],
      fallback: { content: "ok" },
    },
    assert: (ctx) => {
      const full = ctx.bodies.filter((b) => textOf(b).includes("MIDDLE_MARKER_XYZZY"));
      const repl = ctx.bodies.filter((b) => textOf(b).includes("large tool result replaced by sol-pi observation-pack"));
      expect(full.length === 2, `expected 2 full-output requests, got ${full.length}`);
      expect(repl.length >= 1, "no placeholder request found");
      const last = ctx.bodies[ctx.bodies.length - 1];
      expect(textOf(last).includes("id: obs_"), "placeholder lacks obs_ handle");
      expect(!textOf(last).includes("MIDDLE_MARKER_XYZZY"), "last request still carries full output");
      expect(toolNames(last).includes("sol_pi_recall"), "sol_pi_recall tool missing from later request");
      expect(ctx.archiveFiles.length >= 1, "no archive file under XDG cache sol-pi dir");
      const dbParts = dbQuery(ctx.db, "SELECT data FROM part");
      expect(dbParts.some((d) => d.includes("MIDDLE_MARKER_XYZZY")), "stored history lost the full output");
    },
  },
  s2: {
    goal: "edit a.txt and fuse a command",
    solPi: { actionFusion: { enabled: true } },
    fixtures: { "a.txt": "hello\n" },
    script: {
      entries: [
        {
          match: "edit a.txt and fuse",
          tool_calls: [{
            name: "edit",
            arguments: { filePath: "a.txt", oldString: "hello", newString: "world", thenRun: { command: "echo FUSED_OK" } },
          }],
        },
        { match: "then_run:succeeded", content: "done" },
      ],
      fallback: { content: "ok" },
    },
    assert: (ctx) => {
      const first = ctx.bodies.find((b) => toolNames(b).includes("edit"));
      const editTool = first ? toolSchema(first, "edit") : undefined;
      expect(editTool && JSON.stringify(editTool).includes("thenRun"), "thenRun missing from edit tool schema");
      expect(readFileSync(join(ctx.dir, "a.txt"), "utf8").includes("world"), "built-in edit not applied");
      const fused = ctx.bodies.find((b) => textOf(b).includes("[then_run:succeeded]"));
      expect(fused, "no [then_run:succeeded] observation found");
      expect(textOf(fused).includes("FUSED_OK"), "then_run stdout missing from observation");
    },
  },
  s3: {
    goal: "run the build and report",
    solPi: { evidencePreservingReducer: { enabled: true, minLogBytes: 2048, providerID: "mock", modelID: "test" } },
    fixtures: {
      "build.log": buildLog(),
      Makefile: ".PHONY: all\nall:\n\tcat build.log\n",
    },
    script: {
      entries: [
        { match: "run the build and report", tool_calls: [{ name: "bash", arguments: { command: "make -s" } }] },
        {
          match: "<untrusted_log>",
          type: "receipt",
          receipt: {
            file: "build.log",
            quotes: [
              { kind: "warning", quote: "warning: unused variable `scratch` in module foo_42" },
              { kind: "summary", quote: "Build succeeded: 132 targets, 0 errors, 1 warning" },
            ],
          },
        },
        { match: "sol_pi_evidence_receipt_v1", content: "done" },
      ],
      fallback: { content: "ok" },
    },
    assert: (ctx) => {
      expect(ctx.bodies.some((b) => textOf(b).includes("<untrusted_log>")), "reducer throwaway model call never happened");
      const last = ctx.bodies[ctx.bodies.length - 1];
      expect(textOf(last).includes("sol_pi_evidence_receipt_v1"), "receipt marker missing from final request");
      expect(!textOf(last).includes("compiling module foo_7"), "raw build log still in final request");
      const sessions = dbQuery(ctx.db, "SELECT id FROM session");
      expect(sessions.length === 1, `expected 1 session (throwaway deleted), got ${sessions.length}`);
      const journals = findFiles(ctx.cacheSolPi, "reducer-journal-");
      expect(journals.length === 1, "no reducer journal");
      expect(readFileSync(journals[0], "utf8").includes('"kind":"applied"'), "journal has no applied entry");
    },
  },
  s4: {
    goal: "track the plan with todos",
    solPi: { onlineContextCompact: { enabled: true, windowReserveTokens: 1, minRequestsBetween: 1 } },
    modelLimit: { context: 8000, output: 2000 },
    fixtures: {},
    script: {
      entries: [
        {
          match: "track the plan",
          usage: { prompt_tokens: 7000, completion_tokens: 500 },
          tool_calls: [{ name: "todowrite", arguments: { todos: [{ content: "step one", status: "completed", priority: "high" }] } }],
        },
        { match: "step one", usage: { prompt_tokens: 7100, completion_tokens: 100 }, content: "all done" },
      ],
      fallback: { content: "Summary: step one completed; nothing else pending." },
    },
    assert: (ctx) => {
      expect(ctx.code === 0, `opencode run exited with ${ctx.code}: ${ctx.stderr.slice(-400)}`);
      const occ = findFiles(join(ctx.cacheSolPi, "_occ"), "");
      expect(occ.length >= 1, "no OCC state file (events never fired)");
      const compacted = dbQuery(ctx.db, "SELECT time_compacted FROM session");
      const compactionParts = dbQuery(ctx.db, "SELECT data FROM part").filter((d) => d.includes('"type":"compaction"'));
      expect(compacted.some((t) => t !== null) || compactionParts.length > 0, "no compaction observed (time_compacted null, no compaction part)");
    },
  },
};

// ---------- helpers ----------
function textOf(body) {
  return JSON.stringify(body.messages ?? []);
}
function toolNames(body) {
  return (body.tools ?? []).map((t) => t.function?.name ?? t.name);
}
function toolSchema(body, name) {
  const t = (body.tools ?? []).find((x) => (x.function?.name ?? x.name) === name);
  return t?.function?.parameters ?? t?.parameters;
}
function expect(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + msg);
}
function dbQuery(db, sql) {
  if (!existsSync(db)) throw new Error("ASSERT: no DB at " + db);
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d.prepare(sql).all().map((r) => Object.values(r)[0]);
  } finally {
    d.close();
  }
}
function findFiles(dir, prefix) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(p, prefix));
    else if (e.name.startsWith(prefix)) out.push(p);
  }
  return out;
}

// ---------- orchestration ----------
const sc = SCENARIOS[scenarioName];
const dir = join(E2E, scenarioName);
rmSync(dir, { recursive: true, force: true });
for (const sub of ["", ".opencode/plugins", ".data", ".cache", ".config"]) mkdirSync(join(dir, sub), { recursive: true });
for (const [name, content] of Object.entries(sc.fixtures)) writeFileSync(join(dir, name), content);
spawnSync("git", ["init", "-q"], { cwd: dir });
spawnSync("git", ["config", "user.email", "e2e@local"], { cwd: dir });
spawnSync("git", ["config", "user.name", "e2e"], { cwd: dir });

writeFileSync(join(dir, ".opencode", "plugins", "sol-pi.ts"),
  `export { server, SolPiOpenCodePlugin } from "${REPO}/src/index.ts";\nexport { default } from "${REPO}/src/index.ts";\n`);
writeFileSync(join(dir, ".opencode", "sol-pi.json"), JSON.stringify(sc.solPi, null, 2));
writeFileSync(join(dir, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  provider: {
    mock: {
      npm: "@ai-sdk/openai-compatible",
      name: "Mock",
      options: { baseURL: `http://127.0.0.1:${PORT}/v1`, apiKey: "dummy" },
      models: { test: { name: "Test", limit: sc.modelLimit ?? { context: 30000, output: 4000 } } },
    },
  },
  model: "mock/test",
}, null, 2));

const scriptPath = join(dir, "mock-script.json");
writeFileSync(scriptPath, JSON.stringify(sc.script));
const logPath = join(dir, "requests.jsonl");

const mock = spawn(process.execPath, [join(REPO, "scripts", "e2e", "mock.mjs")], {
  env: { ...process.env, MOCK_PORT: String(PORT), MOCK_SCRIPT: scriptPath, MOCK_LOG: logPath },
  stdio: ["ignore", "pipe", "pipe"],
});
let mockOut = "";
mock.stdout.on("data", (c) => (mockOut += c));
mock.stderr.on("data", (c) => (mockOut += c));

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("mock never became ready: " + mockOut);
}

let code = -1, stdout = "", stderr = "";
try {
  await waitReady();
  const r = spawnSync("opencode", ["run", "--auto", "--print-logs", "--log-level", "DEBUG", "--model", "mock/test", sc.goal], {
    cwd: dir,
    env: {
      ...process.env,
      XDG_DATA_HOME: join(dir, ".data"),
      XDG_CACHE_HOME: join(dir, ".cache"),
      XDG_CONFIG_HOME: join(dir, ".config"),
      HOME: homedir(),
      TMPDIR: tmpdir(),
      PWD: dir,
      OPENCODE_CONFIG_DIR: join(dir, ".config", "opencode"),
      OPENCODE: undefined,
      OPENCODE_PID: undefined,
    },
    timeout: 180_000,
    encoding: "utf8",
  });
  code = r.status ?? -1;
  stdout = r.stdout || "";
  stderr = r.stderr || "";
} finally {
  mock.kill("SIGKILL");
}

const cacheSolPi = join(dir, ".cache", "opencode", "sol-pi");
const bodies = existsSync(logPath)
  ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).body)
  : [];

const ctx = {
  dir, code, stdout, stderr, bodies,
  db: join(dir, ".data", "opencode", "opencode.db"),
  cacheSolPi,
  archiveFiles: findFiles(cacheSolPi, "obs_").concat(findFiles(cacheSolPi, "observation")),
};

console.log(`scenario=${scenarioName} opencode_exit=${code} requests=${bodies.length}`);
try {
  sc.assert(ctx);
  console.log(`PASS ${scenarioName}`);
  process.exit(0);
} catch (err) {
  console.log(`FAIL ${scenarioName}: ${err.message}`);
  writeFileSync(join(dir, "run-stderr.log"), stderr);
  console.log("--- stdout ---\n" + stdout.slice(-1500));
  console.log("--- stderr ---\n" + stderr.slice(-1500));
  console.log("--- mock ---\n" + mockOut.slice(-500));
  process.exit(1);
}
