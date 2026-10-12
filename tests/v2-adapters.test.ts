/**
 * P5 wiring tests for the opencode 2.x adapters.
 *
 * These test OUR wiring against a minimal fake ctx (hook/transform
 * recorders, storage Map, generate.text stub, event.subscribe async
 * iterable) — not opencode itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerObservationPack, type ObservationPackContext } from "../src/v2/observation-pack.js";
import { registerActionFusion, type ActionFusionContext } from "../src/v2/action-fusion.js";
import { registerOnlineContextCompact, type OnlineContextCompactContext } from "../src/v2/online-context-compact.js";
import { registerEvidencePreservingReducer, type ReducerContext } from "../src/v2/reducer.js";
import { PLACEHOLDER_MARKER } from "../src/core/observation-pack/placeholder.js";
import { REDUCER_RECEIPT_PREFIX } from "../src/core/evidence-preserving-reducer/config.js";
import type { ObservationPackConfig, ActionFusionConfig, OnlineContextCompactConfig, ReducerConfig } from "../src/core/config.js";

type Cb = (event: Record<string, unknown>) => unknown;

function makeFake() {
  const toolHooks = new Map<string, Cb[]>();
  const sessionHooks = new Map<string, Cb[]>();
  const transforms: Array<(editor: Record<string, unknown>) => void> = [];
  const storage = new Map<string, unknown>();
  const events: unknown[] = [];
  const compactCalls: Array<Record<string, unknown>> = [];
  let generateStub: (input: { prompt: string }) => Promise<{ text: string }> = async () => ({ text: "" });

  const reg = { dispose: async () => {} };
  const ctx = {
    tool: {
      hook: async (name: string, cb: Cb) => {
        const list = toolHooks.get(name) ?? [];
        list.push(cb);
        toolHooks.set(name, list);
        return reg;
      },
      transform: async (cb: (editor: Record<string, unknown>) => void) => {
        transforms.push(cb);
        return reg;
      },
      reload: async () => {},
      list: async () => [],
    },
    session: {
      hook: async (name: string, cb: Cb) => {
        const list = sessionHooks.get(name) ?? [];
        list.push(cb);
        sessionHooks.set(name, list);
        return reg;
      },
      compact: async (input: Record<string, unknown>) => {
        compactCalls.push(input);
      },
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      remove: async (key: string) => {
        storage.delete(key);
      },
      scan: async () => ({ entries: [] }),
    },
    generate: {
      text: async (input: { prompt: string }) => generateStub(input),
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          let i = 0;
          for (;;) {
            if (options?.signal?.aborted) return;
            if (i < events.length) yield events[i++];
            else await new Promise((resolve) => setTimeout(resolve, 5));
          }
        },
      }),
    },
    location: { directory: process.cwd() },
  };

  const fire = async (domain: Map<string, Cb[]>, name: string, event: Record<string, unknown>) => {
    for (const cb of domain.get(name) ?? []) await cb(event);
  };
  const runTransforms = (editor: Record<string, unknown>) => {
    for (const cb of transforms) cb(editor);
  };
  const setGenerate = (stub: (input: { prompt: string }) => Promise<{ text: string }>) => {
    generateStub = stub;
  };

  return { ctx, toolHooks, sessionHooks, transforms, storage, events, compactCalls, fire, runTransforms, setGenerate };
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const opConfig = (over: Partial<ObservationPackConfig> = {}): ObservationPackConfig => ({
  enabled: true,
  thresholdBytes: 16,
  fullSends: 1,
  excerptBytes: 64,
  ...over,
});

// --- ObservationPack -------------------------------------------------------

test("observation-pack: disabled registers nothing", async () => {
  const f = makeFake();
  const cleanup = await registerObservationPack(f.ctx as unknown as ObservationPackContext, { ...opConfig(), enabled: false });
  assert.equal(f.toolHooks.size, 0);
  assert.equal(f.sessionHooks.size, 0);
  assert.equal(f.transforms.length, 0);
  await cleanup();
});

test("observation-pack: enabled registers after-hook, context-hook, transform", async () => {
  const f = makeFake();
  const cleanup = await registerObservationPack(f.ctx as unknown as ObservationPackContext, opConfig());
  assert.ok(f.toolHooks.has("execute.after"));
  assert.ok(f.sessionHooks.has("context"));
  assert.equal(f.transforms.length, 1);
  await cleanup();
});

test("observation-pack: after-hook archives and persists ledger to storage", async () => {
  const f = makeFake();
  const cleanup = await registerObservationPack(f.ctx as unknown as ObservationPackContext, opConfig());
  await f.fire(f.toolHooks, "execute.after", {
    tool: "bash",
    sessionID: "s-arch",
    id: "call-1",
    status: "completed",
    input: {},
    result: { output: "x".repeat(200) },
  });
  await waitFor(() => f.storage.has("observation-pack/ledger"));
  const ledger = f.storage.get("observation-pack/ledger") as Record<string, { sha256: string; size: number; sends: number }>;
  assert.ok(ledger["call-1"]);
  assert.equal(ledger["call-1"]!.sends, 0);
  await cleanup();
});

test("observation-pack: context-hook replaces only after fullSends", async () => {
  const f = makeFake();
  const cleanup = await registerObservationPack(f.ctx as unknown as ObservationPackContext, opConfig({ fullSends: 1 }));
  const text = "y".repeat(200);
  await f.fire(f.toolHooks, "execute.after", {
    tool: "bash",
    sessionID: "s-proj",
    id: "call-2",
    status: "completed",
    input: {},
    result: { output: text },
  });
  await waitFor(() => f.storage.has("observation-pack/ledger"));

  const message = { role: "tool", content: [{ type: "tool-result", id: "call-2", name: "bash", result: { type: "text", value: text } }] };
  // First send: still full (sends 0 < fullSends 1).
  const ev1 = { sessionID: "s-proj", messages: [message] };
  await f.fire(f.sessionHooks, "context", ev1);
  const first = (ev1.messages[0]!.content[0] as { result: { value: string } }).result.value;
  assert.equal(first, text);
  // Second send: replaced with placeholder (copy-on-write: the array entry
  // is replaced, the original message object stays untouched).
  const ev2 = { sessionID: "s-proj", messages: [message] };
  await f.fire(f.sessionHooks, "context", ev2);
  const second = (ev2.messages[0]!.content[0] as { result: { value: string } }).result.value;
  assert.ok(second.includes(PLACEHOLDER_MARKER));
  assert.equal((message.content[0] as { result: { value: string } }).result.value, text);
  await cleanup();
});

test("observation-pack: recall tool added via transform", async () => {
  const f = makeFake();
  const cleanup = await registerObservationPack(f.ctx as unknown as ObservationPackContext, opConfig());
  let added: { name: string; execute: (input: unknown, context: { sessionID: string }) => Promise<{ content?: string }> } | undefined;
  f.runTransforms({
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    add: (tool: unknown) => {
      added = tool as typeof added;
    },
    update: () => {},
    remove: () => {},
  });
  assert.ok(added);
  assert.equal(added!.name, "sol_pi_recall");
  const result = await added!.execute({ handle: "obs_bad" }, { sessionID: "s" });
  assert.match(String(result.content), /unknown observation handle/);
  await cleanup();
});

// --- Action Fusion ---------------------------------------------------------

const fusionConfig = (over: Partial<ActionFusionConfig> = {}): ActionFusionConfig => ({
  enabled: true,
  commandTimeoutMs: 5000,
  allowList: [],
  ...over,
});

test("action-fusion: disabled registers nothing", async () => {
  const f = makeFake();
  const cleanup = await registerActionFusion(f.ctx as unknown as ActionFusionContext, { ...fusionConfig(), enabled: false });
  assert.equal(f.toolHooks.size, 0);
  assert.equal(f.transforms.length, 0);
  await cleanup();
});

test("action-fusion: transform extends edit/write description and schema", async () => {
  const f = makeFake();
  const cleanup = await registerActionFusion(f.ctx as unknown as ActionFusionContext, fusionConfig());
  assert.equal(f.transforms.length, 1);
  const updated = new Map<string, { description: string; input: unknown }>();
  f.runTransforms({
    list: () => [],
    get: () => undefined,
    namespace: () => {},
    add: () => {},
    update: (id: string, mutate: (tool: { description: string; input: unknown }) => void) => {
      const tool = { description: `desc-${id}`, input: { type: "object", properties: { filePath: { type: "string" } } } };
      mutate(tool);
      updated.set(id, tool);
    },
    remove: () => {},
  });
  for (const id of ["edit", "write"]) {
    const tool = updated.get(id);
    assert.ok(tool, `update called for ${id}`);
    assert.match(tool!.description, /thenRun/);
    assert.ok((tool!.input as { properties: Record<string, unknown> }).properties.thenRun);
  }
  await cleanup();
});

test("action-fusion: before-hook strips thenRun from input args", async () => {
  const f = makeFake();
  const cleanup = await registerActionFusion(f.ctx as unknown as ActionFusionContext, fusionConfig());
  const args: Record<string, unknown> = { filePath: "a.ts", thenRun: { command: "echo hi" } };
  await f.fire(f.toolHooks, "execute.before", { tool: "edit", sessionID: "s", agent: "a", messageID: "m", id: "c1", input: args });
  assert.equal("thenRun" in args, false);
  assert.equal(args.filePath, "a.ts");
  await cleanup();
});

test("action-fusion: after-hook runs thenRun and tags the combined observation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "solpi-fusion-"));
  const file = join(dir, "a.ts");
  writeFileSync(file, "content");
  const f = makeFake();
  const cleanup = await registerActionFusion(f.ctx as unknown as ActionFusionContext, fusionConfig());
  const args: Record<string, unknown> = { filePath: file, thenRun: { command: "echo fused-ok" } };
  await f.fire(f.toolHooks, "execute.before", { tool: "edit", sessionID: "s-fuse", agent: "a", messageID: "m", id: "c2", input: args });
  const event: Record<string, unknown> = { tool: "edit", sessionID: "s-fuse", agent: "a", messageID: "m", id: "c2", status: "completed", result: { output: "edited a.ts" } };
  await f.fire(f.toolHooks, "execute.after", event);
  const output = (event.result as { output: string }).output;
  assert.match(output, /\[then_run:succeeded\]/);
  assert.match(output, /fused-ok/);
  assert.match(output, /^edited a\.ts/);
  await cleanup();
});

// --- Online Context Compact ------------------------------------------------

const occConfig = (over: Partial<OnlineContextCompactConfig> = {}): OnlineContextCompactConfig => ({
  enabled: true,
  windowReserveTokens: 16384,
  cacheWriteReadRatio: 12.5,
  minRequestsBetween: 1,
  subsequentCompactionMargin: 1.5,
  ...over,
});

test("occ: disabled registers nothing", async () => {
  const f = makeFake();
  const cleanup = await registerOnlineContextCompact(f.ctx as unknown as OnlineContextCompactContext, { ...occConfig(), enabled: false });
  assert.equal(f.toolHooks.size, 0);
  assert.equal(f.sessionHooks.size, 0);
  await cleanup();
});

test("occ: todo boundary + step events persist state; compaction hook injects snapshot", async () => {
  const f = makeFake();
  const cleanup = await registerOnlineContextCompact(f.ctx as unknown as OnlineContextCompactContext, occConfig());
  assert.ok(f.toolHooks.has("execute.after"));
  assert.ok(f.sessionHooks.has("compaction"));

  // Plan transition with a completed step via the todo tool (2.x has no todo.updated event).
  await f.fire(f.toolHooks, "execute.after", {
    tool: "todowrite",
    sessionID: "s-occ",
    id: "t1",
    status: "completed",
    input: {},
    result: { output: JSON.stringify([{ content: "step one", status: "completed" }, { content: "step two", status: "pending" }]) },
  });
  // Step-finish token accounting via the event clock.
  f.events.push({
    type: "session.step.ended",
    data: { sessionID: "s-occ", tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } },
  });
  await waitFor(() => {
    const s = f.storage.get("occ/state/s-occ") as { lastContextTokens: number | null } | undefined;
    return s?.lastContextTokens === 110;
  });
  const state = f.storage.get("occ/state/s-occ") as { plan: unknown[]; lastContextTokens: number };
  assert.equal(state.plan.length, 2);
  assert.equal(state.lastContextTokens, 110);

  const hookEvent = { sessionID: "s-occ", system: [] as Array<{ type: string; text: string }> };
  await f.fire(f.sessionHooks, "compaction", hookEvent);
  assert.equal(hookEvent.system.length, 1);
  assert.match(hookEvent.system[0]!.text, /step one/);
  await cleanup();
});

// --- Evidence-Preserving Reducer -------------------------------------------

const reducerConfig = (over: Partial<ReducerConfig> = {}): ReducerConfig => ({
  enabled: true,
  providerID: "testprov",
  modelID: "testmodel",
  maxEvidenceItems: 5,
  maxQuoteChars: 200,
  minLogBytes: 16,
  maxChars: 100_000,
  timeoutMs: 5000,
  ...over,
});

const BASH_CANDIDATE = (id: string) => ({
  tool: "bash",
  sessionID: "s-red",
  id,
  status: "completed",
  input: { command: "npm test" },
  result: {
    output: `running tests\nline with failure signal here\nall done ok\n${"padding ".repeat(300)}`,
    metadata: { exit: 0 },
  },
});

test("reducer: disabled registers nothing", async () => {
  const f = makeFake();
  const cleanup = await registerEvidencePreservingReducer(f.ctx as unknown as ReducerContext, { ...reducerConfig(), enabled: false });
  assert.equal(f.toolHooks.size, 0);
  await cleanup();
});

test("reducer: valid receipt replaces event.result with marker", async () => {
  const f = makeFake();
  f.setGenerate(async ({ prompt }) => {
    const hash = /source_sha256=([a-f0-9]{64})/.exec(prompt)?.[1] ?? "";
    return {
      text: JSON.stringify({
        schema: "sol-pi-evidence-receipt/1",
        source_sha256: hash,
        status: "success",
        uncertain: false,
        evidence: [{ kind: "summary", quote: "all done ok" }],
      }),
    };
  });
  const cleanup = await registerEvidencePreservingReducer(f.ctx as unknown as ReducerContext, reducerConfig());
  const event = BASH_CANDIDATE("r1") as unknown as Record<string, unknown>;
  await f.fire(f.toolHooks, "execute.after", event);
  const output = (event.result as { output: string }).output;
  assert.ok(output.startsWith(REDUCER_RECEIPT_PREFIX));
  assert.ok(output.includes("source_sha256="));
  await cleanup();
});

test("reducer: invalid receipt leaves result untouched (fail-open)", async () => {
  const f = makeFake();
  f.setGenerate(async () => ({ text: "this is not a receipt" }));
  const cleanup = await registerEvidencePreservingReducer(f.ctx as unknown as ReducerContext, reducerConfig());
  const event = BASH_CANDIDATE("r2") as unknown as Record<string, unknown>;
  const before = JSON.stringify(event.result);
  await f.fire(f.toolHooks, "execute.after", event);
  assert.equal(JSON.stringify(event.result), before);
  await cleanup();
});
