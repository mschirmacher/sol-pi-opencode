#!/usr/bin/env node
// P6c/P6d A/B single-run harness: drives real opencode 1.19.0 against the devbox-ai
// proxy (token-metered, cost 0) for one (arm, task) pair, then runs the verifier.
// Reuses the working invocation + provider config + plugin shim from spike-p6-e2e.
// opencode runs detached (nohup-style, own process group) and the harness polls
// for the exit sentinel, so the whole script can be launched with `nohup ... &`
// from a shell without any single foreground call exceeding tool timeouts.
// Usage: node scripts/ab/run-arm.mjs --arm <off|on|op-only> --task <ID> [--tasks-dir tasks|tasks-long] [--run N]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(new URL("../..", import.meta.url).pathname);
const AB = join(REPO, ".ab");
const MODEL = "qwen3.8-flash-next-iq3_xxs";
const BASE_URL = "http://aux.schirmacher.dev:8080/v1";
const RUN_TIMEOUT = 900_000;

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const arm = arg("arm");
const task = arg("task");
const tasksDir = arg("tasks-dir") ?? "tasks";
const runN = Number(arg("run") ?? "1");
if (!["off", "on", "op-only"].includes(arm)) {
  console.error("usage: run-arm.mjs --arm off|on|op-only --task <ID> [--tasks-dir DIR] [--run N]");
  process.exit(2);
}
const { TASKS } = await import(new URL(`./${tasksDir}/index.mjs`, import.meta.url).href);
if (!TASKS[task]) {
  console.error(`unknown task ${task} (tasks dir: ${tasksDir}; have: ${Object.keys(TASKS).join(",")})`);
  process.exit(2);
}

const dir = join(AB, arm, `${task}-r${runN}`);
rmSync(dir, { recursive: true, force: true });
for (const sub of ["", ".opencode/plugins", ".data", ".cache", ".config/opencode"]) {
  mkdirSync(join(dir, sub), { recursive: true });
}

const T = TASKS[task];
for (const [name, content] of Object.entries(T.files)) {
  const p = join(dir, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}
spawnSync("git", ["init", "-q"], { cwd: dir });
spawnSync("git", ["config", "user.email", "ab@local"], { cwd: dir });
spawnSync("git", ["config", "user.name", "ab"], { cwd: dir });
spawnSync("git", ["add", "-A"], { cwd: dir });
spawnSync("git", ["commit", "-qm", "fixture"], { cwd: dir });

// Plugin shim loaded in ALL arms (off/on/op-only) so the only difference between
// arms is the sol-pi.json config, not whether the plugin is present.
writeFileSync(
  join(dir, ".opencode", "plugins", "sol-pi.ts"),
  `export { server, SolPiOpenCodePlugin } from "${REPO}/src/index.ts";\nexport { default } from "${REPO}/src/index.ts";\n`,
);

const ON = {
  observationPack: { enabled: true, thresholdBytes: 10240, fullSends: 2, excerptBytes: 1024 },
  actionFusion: { enabled: true },
  evidencePreservingReducer: { enabled: true, minLogBytes: 4096, providerID: "devbox-ai", modelID: MODEL },
  onlineContextCompact: { enabled: true },
};
const OFF = {
  observationPack: { enabled: false },
  actionFusion: { enabled: false },
  evidencePreservingReducer: { enabled: false },
  onlineContextCompact: { enabled: false },
};
const OPONLY = {
  observationPack: { enabled: true, thresholdBytes: 10240, fullSends: 2, excerptBytes: 1024 },
  actionFusion: { enabled: false },
  evidencePreservingReducer: { enabled: false },
  onlineContextCompact: { enabled: false },
};
const cfg = arm === "on" ? ON : arm === "op-only" ? OPONLY : OFF;
writeFileSync(join(dir, ".opencode", "sol-pi.json"), JSON.stringify(cfg, null, 2));

// Provider config: key referenced by env var name, never hardcoded. Config file
// itself lives under .ab/ (gitignored) and is regenerated at runtime.
writeFileSync(
  join(dir, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      provider: {
        "devbox-ai": {
          npm: "@ai-sdk/openai-compatible",
          name: "devbox-ai",
          options: { baseURL: BASE_URL, apiKey: "{env:SOL_PI_AB_KEY}", timeout: false },
          models: { [MODEL]: { name: MODEL, limit: { context: 262144, output: 8192 } } },
        },
      },
      model: `devbox-ai/${MODEL}`,
    },
    null,
    2,
  ),
);

// Resolve the proxy key from env, else from the local opencode auth store. Never
// printed, never committed.
let key = process.env.SOL_PI_AB_DEVBOX_KEY;
if (!key) {
  try {
    key = JSON.parse(readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf8"))["devbox-ai"].key;
  } catch {}
}
if (!key) {
  console.error("no devbox-ai key available");
  process.exit(3);
}

const logPath = join(dir, "opencode.log");
const exitPath = join(dir, "opencode.exit");
const promptPath = join(dir, ".prompt.txt");
writeFileSync(promptPath, T.prompt);
const env = {
  ...process.env,
  SOL_PI_AB_KEY: key,
  XDG_DATA_HOME: join(dir, ".data"),
  XDG_CACHE_HOME: join(dir, ".cache"),
  XDG_CONFIG_HOME: join(dir, ".config"),
  OPENCODE_CONFIG_DIR: join(dir, ".config", "opencode"),
  HOME: homedir(),
  TMPDIR: tmpdir(),
  PWD: dir,
  OPENCODE: undefined,
  OPENCODE_PID: undefined,
};

const t0 = Date.now();
const child = spawn(
  "bash",
  ["-c", `opencode run --auto --model devbox-ai/${MODEL} "$(cat ${JSON.stringify(promptPath)})" > ${JSON.stringify(logPath)} 2>&1; echo $? > ${JSON.stringify(exitPath)}`],
  { cwd: dir, env, detached: true, stdio: "ignore" },
);
child.unref();
let timedOut = false;
while (!existsSync(exitPath)) {
  if (Date.now() - t0 > RUN_TIMEOUT) {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    break;
  }
  spawnSync("sleep", ["5"]);
}
const opencodeExit = timedOut ? -1 : Number(readFileSync(exitPath, "utf8").trim());

// Verifier: kept out of the fixture; written only after the agent run finished.
let verifyCmd;
if (T.verifyScript) {
  writeFileSync(join(dir, ".verify.sh"), T.verifyScript);
  verifyCmd = "bash .verify.sh";
} else {
  verifyCmd = T.verify;
}
const v = spawnSync("bash", ["-c", verifyCmd], { cwd: dir, timeout: 120_000, encoding: "utf8" });
const score = v.status === 0 ? 1 : 0;
const scoreMatch = /SCORE (\d+)\/(\d+)/.exec(v.stdout || "");
const verifierScorePartial = scoreMatch ? Number(scoreMatch[1]) / Number(scoreMatch[2]) : score;

const rec = {
  arm,
  task,
  run: runN,
  tasksDir,
  title: T.title,
  opencodeExit,
  timedOut,
  verifierScore: score,
  verifierScorePartial,
  durationMs: Date.now() - t0,
  verifierOut: (v.stdout || "").slice(-400),
  verifierErr: (v.stderr || "").slice(-400),
  runOut: existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-1000) : "",
  runErr: "",
  db: join(dir, ".data", "opencode", "opencode.db"),
  cacheDir: join(dir, ".cache"),
};
mkdirSync(join(AB, "results"), { recursive: true });
writeFileSync(join(dir, "result.json"), JSON.stringify(rec, null, 2));
const resultPath = join(AB, "results", `${arm}-${task}-r${runN}.json`);
writeFileSync(resultPath, JSON.stringify(rec, null, 2));

// Copy the per-run result JSON into the tracked results dir and commit it.
const tracked = join(REPO, "docs", "plan", "ab-results-long");
mkdirSync(tracked, { recursive: true });
const trackedPath = join(tracked, `${arm}-${task}-r${runN}.json`);
writeFileSync(trackedPath, JSON.stringify(rec, null, 2));
const rel = `docs/plan/ab-results-long/${arm}-${task}-r${runN}.json`;
spawnSync("git", ["add", rel], { cwd: REPO });
spawnSync("git", ["commit", "-m", `P6d: result ${arm}-${task}-r${runN}`, "--", rel], { cwd: REPO });

console.log(
  `RESULT arm=${arm} task=${task} run=${runN} opencodeExit=${opencodeExit} timedOut=${timedOut} score=${score} partial=${verifierScorePartial.toFixed(2)} dur=${rec.durationMs}ms`,
);
