import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginInput } from "@opencode-ai/plugin";
import { archiveBody } from "../src/core/evidence-preserving-reducer/archive.js";
import {
  DIAGNOSTIC_COMMAND,
  REDUCER_RECEIPT_PREFIX,
  REDUCER_RECEIPT_SCHEMA,
  sha256,
  type ReducerRuntimeConfig,
} from "../src/core/evidence-preserving-reducer/config.js";
import { ineligibilityReason, reducibleToolResult } from "../src/core/evidence-preserving-reducer/candidate.js";
import { journalPath } from "../src/core/evidence-preserving-reducer/journal.js";
import { validateReceipt } from "../src/core/evidence-preserving-reducer/receipt.js";
import { createObservation } from "../src/core/observation-pack/archive.js";
import { EVIDENCE_REDUCER_RECEIPT_PREFIX } from "../src/core/observation-pack/constants.js";
import {
  createEvidencePreservingReducerHooks,
  registerReducerAgent,
  REDUCER_AGENT_NAME,
  type ReducerCallResult,
  type ReducerModelCall,
} from "../src/v1/evidence-preserving-reducer.js";

const tmpRoot = join(dirname(fileURLToPath(import.meta.url)), ".tmp");

async function tempDir(prefix: string): Promise<string> {
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(join(tmpRoot, prefix));
}

function logBody(failures = 1): string {
  let text = "build started\n";
  for (let i = 0; i < 200; i++) text += `compiling module ${String(i).padStart(4, "0")} ok\n`;
  for (let i = 0; i < failures; i++) text += `error: module ${i} failed to compile\n`;
  text += "build finished\n";
  return text;
}

function receiptJson(archiveHash: string, body: string, overrides: Record<string, unknown> = {}): string {
  const quote = body.match(/error: module 0 failed to compile/u)![0];
  return JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: archiveHash,
    status: "failure",
    uncertain: false,
    evidence: [{ kind: "failure", quote }],
    ...overrides,
  });
}

const CONFIG: ReducerRuntimeConfig = {
  maxEvidenceItems: 12,
  maxQuoteChars: 600,
  minLogBytes: 4_096,
  maxChars: 600_000,
  timeoutMs: 5_000,
  providerID: "test",
  modelID: "test-model",
};

// ---------- validateReceipt (the safety property) ----------

test("validateReceipt: valid receipt accepted with verified evidence", async () => {
  const dir = await tempDir("epr-valid-");
  const body = logBody();
  const archive = await archiveBody(dir, body);
  const result = validateReceipt(receiptJson(archive.hash, body), archive, body, true);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "failure");
    assert.equal(result.value.uncertain, false);
    assert.equal(result.value.evidence.length, 1);
    assert.equal(result.value.evidence[0]?.kind, "failure");
    assert.ok(body.includes(result.value.evidence[0]!.quote));
  }
});

test("validateReceipt: tampered quote rejected (not byte-exact in body)", async () => {
  const dir = await tempDir("epr-tamper-");
  const body = logBody();
  const archive = await archiveBody(dir, body);
  const raw = JSON.parse(receiptJson(archive.hash, body)) as Record<string, unknown>;
  (raw.evidence as { quote: string }[])[0]!.quote = "error: module 0 failed to compile-ish";
  const result = validateReceipt(JSON.stringify(raw), archive, body, true);
  assert.deepEqual(result, { ok: false, reason: "unverifiable-quote" });
});

test("validateReceipt: source_sha256 mismatch rejected", async () => {
  const dir = await tempDir("epr-hash-");
  const body = logBody();
  const archive = await archiveBody(dir, body);
  const result = validateReceipt(receiptJson(sha256("other"), body), archive, body, true);
  assert.deepEqual(result, { ok: false, reason: "schema-mismatch" });
});

test("validateReceipt: status mismatch rejected (failure log, success receipt)", async () => {
  const dir = await tempDir("epr-status-");
  const body = logBody();
  const archive = await archiveBody(dir, body);
  const result = validateReceipt(receiptJson(archive.hash, body, { status: "success" }), archive, body, true);
  assert.deepEqual(result, { ok: false, reason: "schema-mismatch" });
});

test("validateReceipt: too many evidence items rejected", async () => {
  const dir = await tempDir("epr-count-");
  const body = logBody(20);
  const archive = await archiveBody(dir, body);
  const evidence = Array.from({ length: 13 }, (_, i) => ({ kind: "failure", quote: `error: module ${i} failed to compile` }));
  const raw = JSON.stringify({ schema: REDUCER_RECEIPT_SCHEMA, source_sha256: archive.hash, status: "failure", uncertain: false, evidence });
  const result = validateReceipt(raw, archive, body, true);
  assert.deepEqual(result, { ok: false, reason: "schema-mismatch" });
});

test("validateReceipt: over-long quote rejected", async () => {
  const dir = await tempDir("epr-long-");
  const body = `x${"z".repeat(700)}\nerror: ${"y".repeat(700)} failed\n`;
  const archive = await archiveBody(dir, body);
  const quote = body.match(/error: y+ failed/u)![0];
  const raw = JSON.stringify({ schema: REDUCER_RECEIPT_SCHEMA, source_sha256: archive.hash, status: "failure", uncertain: false, evidence: [{ kind: "failure", quote }] });
  const result = validateReceipt(raw, archive, body, true);
  assert.deepEqual(result, { ok: false, reason: "unverifiable-quote" });
});

test("validateReceipt: likely-secret quote rejected", async () => {
  const dir = await tempDir("epr-secret-");
  const body = `${logBody()}api_key=sk-supersecret-value\n`;
  const archive = await archiveBody(dir, body);
  const raw = JSON.stringify({ schema: REDUCER_RECEIPT_SCHEMA, source_sha256: archive.hash, status: "failure", uncertain: false, evidence: [{ kind: "failure", quote: "api_key=sk-supersecret-value" }] });
  const result = validateReceipt(raw, archive, body, true);
  assert.deepEqual(result, { ok: false, reason: "likely-secret-quote" });
});

test("validateReceipt: uncertain flag preserved; invalid json rejected", async () => {
  const dir = await tempDir("epr-uncertain-");
  const body = logBody();
  const archive = await archiveBody(dir, body);
  const result = validateReceipt(receiptJson(archive.hash, body, { uncertain: true }), archive, body, true);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.uncertain, true);
  assert.deepEqual(validateReceipt("not json", archive, body, true), { ok: false, reason: "invalid-json" });
});

test("validateReceipt: failing log with failure signal needs failure evidence", async () => {
  const dir = await tempDir("epr-missing-");
  const body = logBody();
  const archive = await archiveBody(dir, body);
  const raw = JSON.stringify({ schema: REDUCER_RECEIPT_SCHEMA, source_sha256: archive.hash, status: "failure", uncertain: false, evidence: [{ kind: "summary", quote: "build finished" }] });
  assert.deepEqual(validateReceipt(raw, archive, body, true), { ok: false, reason: "missing-failure-evidence" });
});

// ---------- candidate eligibility ----------

test("candidate: bash diagnostic command qualifies; non-diagnostic does not", async () => {
  const body = logBody();
  const reducible = await reducibleToolResult({ tool: "bash", args: { command: "npm test" } }, { output: body, metadata: { exit: 1 } });
  assert.ok(reducible);
  assert.equal(reducible.isError, true);
  assert.equal(ineligibilityReason(reducible, { minLogBytes: 4_096, maxChars: 600_000 }), undefined);
  const other = await reducibleToolResult({ tool: "bash", args: { command: "ls -la" } }, { output: body, metadata: { exit: 0 } });
  assert.ok(other);
  assert.equal(ineligibilityReason(other, { minLogBytes: 4_096, maxChars: 600_000 }), "command-not-diagnostic");
  assert.ok(DIAGNOSTIC_COMMAND.test("cargo test"));
});

test("candidate: below minLogBytes and likely-secret are ineligible", async () => {
  const small = await reducibleToolResult({ tool: "bash", args: { command: "npm test" } }, { output: "tiny log", metadata: { exit: 0 } });
  assert.equal(ineligibilityReason(small, { minLogBytes: 4_096, maxChars: 600_000 }), "below-min-log-bytes");
  const secret = await reducibleToolResult({ tool: "bash", args: { command: "npm test" } }, { output: `${logBody()}\nAuthorization: Bearer abc123\n`, metadata: { exit: 0 } });
  assert.equal(ineligibilityReason(secret, { minLogBytes: 4_096, maxChars: 600_000 }), "likely-secret");
});

test("candidate: fused edit then_run section extracted with failed status", async () => {
  const fused = `edited file ok\n\n[then_run:failed] command exited with code 2\n${logBody()}`;
  const reducible = await reducibleToolResult({ tool: "edit", args: { thenRun: { command: "npm test" } } }, { output: fused, metadata: {} });
  assert.ok(reducible);
  assert.equal(reducible.isError, true);
  // SoL-Pi candidate.ts semantics: when the marker is followed by a space
  // (Action Fusion's format), the inline section keeps that leading space.
  assert.ok(reducible.body.startsWith(" command exited with code 2"));
  const replaced = reducible.projectReceipt("RECEIPT");
  assert.ok(replaced.startsWith("edited file ok\n\n[then_run:failed]\nRECEIPT"));
});

// ---------- end-to-end via hooks with fake ReducerModelCall ----------

async function makeHooks(config: ReducerRuntimeConfig, call: ReducerModelCall) {
  const cache = await tempDir("epr-cache-");
  process.env.XDG_CACHE_HOME = cache;
  const input = { client: {} } as unknown as PluginInput;
  const hooks = createEvidencePreservingReducerHooks(input, config, call);
  return { hooks, cache };
}

function fakeReducer(build: (hash: string, body: string) => string): ReducerModelCall {
  return async ({ archive, body }) => {
    const result: ReducerCallResult = { ok: true, outputText: build(archive.hash, body), provider: "p", model: "m", totalTokens: 7 };
    return result;
  };
}

test("e2e: valid receipt replaces output with marker-carrying receipt", async () => {
  const { hooks, cache } = await makeHooks(CONFIG, fakeReducer((hash, body) => receiptJson(hash, body)));
  const body = logBody();
  const output = { title: "npm test", output: body, metadata: { exit: 1 } };
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_e2e1", callID: "call1", args: { command: "npm test" } }, output);
  assert.ok(output.output.startsWith(REDUCER_RECEIPT_PREFIX));
  assert.ok(output.output.includes("verified_evidence:"));
  // Cross-check: ObservationPack never re-packs a receipt-marked part.
  assert.equal(EVIDENCE_REDUCER_RECEIPT_PREFIX, REDUCER_RECEIPT_PREFIX);
  assert.equal(createObservation({ toolName: "bash", callID: "call1", text: output.output, dir: cache }), undefined);
  // Journal recorded the decision.
  const path = journalPath(join(cache, "opencode", "sol-pi", "ses_e2e1"), "ses_e2e1");
  let journal = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      journal = await readFile(path, "utf8");
      if (journal.includes('"kind":"applied"')) break;
    } catch {
      // journal write still queued
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(journal.includes('"kind":"candidate"'));
  assert.ok(journal.includes('"kind":"applied"'));
});

test("e2e: invalid receipt leaves original output untouched (fail-open)", async () => {
  const { hooks } = await makeHooks(CONFIG, fakeReducer(() => "{not valid json"));
  const body = logBody();
  const output = { title: "npm test", output: body, metadata: { exit: 1 } };
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_e2e2", callID: "call2", args: { command: "npm test" } }, output);
  assert.equal(output.output, body);
});

test("e2e: throwing ReducerModelCall leaves output untouched (fail-open)", async () => {
  const { hooks } = await makeHooks(CONFIG, async () => {
    throw new Error("model down");
  });
  const body = logBody();
  const output = { title: "npm test", output: body, metadata: { exit: 1 } };
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_e2e3", callID: "call3", args: { command: "npm test" } }, output);
  assert.equal(output.output, body);
});

test("e2e: same callID is never reduced twice", async () => {
  let calls = 0;
  const { hooks } = await makeHooks(CONFIG, async (params) => {
    calls += 1;
    return fakeReducer((hash, body) => receiptJson(hash, body))(params);
  });
  const body = logBody();
  const output = { title: "npm test", output: body, metadata: { exit: 1 } };
  const input = { tool: "bash", sessionID: "ses_e2e4", callID: "call4", args: { command: "npm test" } };
  await hooks["tool.execute.after"]!(input, output);
  assert.ok(output.output.startsWith(REDUCER_RECEIPT_PREFIX));
  await hooks["tool.execute.after"]!(input, { title: "", output: output.output, metadata: { exit: 1 } });
  assert.equal(calls, 1);
});

test("e2e: outputs already marked (receipt/placeholder) are skipped", async () => {
  let calls = 0;
  const { hooks } = await makeHooks(CONFIG, async (params) => {
    calls += 1;
    return fakeReducer((hash, body) => receiptJson(hash, body))(params);
  });
  const marked = `${REDUCER_RECEIPT_PREFIX}\n${logBody()}`;
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_e2e5", callID: "c5", args: { command: "npm test" } }, { title: "", output: marked, metadata: { exit: 1 } });
  const placeholder = `[large tool result replaced by sol-pi observation-pack]\nid: obs_000000000000000000000000\n${logBody()}`;
  await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_e2e5", callID: "c6", args: { command: "npm test" } }, { title: "", output: placeholder, metadata: { exit: 1 } });
  assert.equal(calls, 0);
});

test("config hook registers hidden no-tools reducer agent", async () => {
  const cfg: { agent?: Record<string, unknown> } = {};
  const hooks = createEvidencePreservingReducerHooks({ client: {} } as unknown as PluginInput, CONFIG, async () => ({ ok: false, outputText: "", provider: "", model: "", totalTokens: 0 }));
  await hooks.config!(cfg as never);
  const agent = cfg.agent?.[REDUCER_AGENT_NAME] as Record<string, unknown>;
  assert.equal(agent.mode, "subagent");
  assert.equal(agent.hidden, true);
  assert.equal(agent.steps, 1);
  assert.deepEqual(agent.permission, { "*": "deny" });
  assert.ok(typeof agent.prompt === "string" && (agent.prompt as string).includes("untrusted"));
  registerReducerAgent(cfg);
});
