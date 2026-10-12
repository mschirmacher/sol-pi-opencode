import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { analyzePlanTransition, todosToPlanSteps } from "../src/core/online-context-compact/plan.js";
import { decideCompaction, requestsPerBoundaryLowerBound } from "../src/core/online-context-compact/economics.js";
import {
  averageContextTokenIncrement,
  createFileStore,
  createMemoryStore,
  initialState,
  parseState,
  recordBoundary,
  recordCompaction,
  recordRequest,
  requestsSinceLastCompaction,
} from "../src/core/online-context-compact/state.js";
import { createOnlineContextCompactHooks } from "../src/v1/online-context-compact.js";

const tmpRoot = join(dirname(fileURLToPath(import.meta.url)), ".tmp");

async function tempDir(prefix: string): Promise<string> {
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(join(tmpRoot, prefix));
}

const ECON_INPUT = {
  boundaryRequestCounts: [10, 10, 10],
  remainingBoundaries: 3,
  contextTokens: 60_000,
  contextWindowTokens: null,
  averageContextTokenIncrement: null,
  archiveTokens: 60_000,
  memoTokens: 2_000,
  priorCompactionCount: 0,
  requestsSinceLastCompaction: null,
  cacheWriteReadRatio: 12.5,
} as const;

test("economics: compacts when savings repay the rewrite cost within the horizon", () => {
  const d = decideCompaction(ECON_INPUT);
  assert.equal(d.expectedSavings, 58_000);
  assert.equal(d.rewriteCost, 2_000 * 11.5);
  assert.ok(d.breakevenRequests !== null && d.breakevenRequests < 1);
  assert.equal(d.compact, true);
  assert.equal(d.reason, "economic");
});

test("economics: refuses when savings never repay the rewrite cost", () => {
  const d = decideCompaction({ ...ECON_INPUT, archiveTokens: 3_000, memoTokens: 2_000 });
  assert.equal(d.expectedSavings, 1_000);
  assert.equal(d.compact, false);
  assert.equal(d.reason, "deferred_economic");
});

test("economics: cacheWriteReadRatio charge raises rewrite cost, savings unchanged", () => {
  const cheap = decideCompaction({ ...ECON_INPUT, cacheWriteReadRatio: 2 });
  const pricey = decideCompaction({ ...ECON_INPUT, cacheWriteReadRatio: 12.5 });
  assert.equal(cheap.expectedSavings, pricey.expectedSavings);
  assert.equal(cheap.rewriteCost, 2_000 * 1);
  assert.ok(pricey.rewriteCost > cheap.rewriteCost);
});

test("economics: subsequentCompactionMargin blocks a 2nd compaction that the 1st would allow", () => {
  const base = {
    ...ECON_INPUT,
    boundaryRequestCounts: [1, 1, 1],
    remainingBoundaries: 1,
    contextTokens: 9_000,
    archiveTokens: 8_500,
    memoTokens: 500,
  } as const;
  const first = decideCompaction(base);
  assert.equal(first.compact, true);
  const second = decideCompaction({ ...base, priorCompactionCount: 1, requestsSinceLastCompaction: 10 });
  assert.equal(second.compact, false);
  assert.equal(second.reason, "deferred_subsequent_margin");
});

test("economics: stddev lower bound shrinks the request horizon", () => {
  const counts = [2, 20, 20];
  const { lowerBound } = requestsPerBoundaryLowerBound(counts, 1);
  assert.ok(Math.abs(lowerBound - (14 - Math.sqrt(108))) < 1e-9);
  const withStddev = decideCompaction({ ...ECON_INPUT, boundaryRequestCounts: counts, remainingBoundaries: 1 });
  const meanOnly = decideCompaction({ ...ECON_INPUT, boundaryRequestCounts: counts, remainingBoundaries: 1, config: { stddevK: 0 } });
  assert.equal(withStddev.expectedRemainingRequests, 4);
  assert.equal(meanOnly.expectedRemainingRequests, 15);
});

test("economics: minRequestsBetween cooldown defers an otherwise economic compaction", () => {
  const d = decideCompaction({ ...ECON_INPUT, priorCompactionCount: 1, requestsSinceLastCompaction: 1 });
  assert.equal(d.compact, false);
  assert.equal(d.reason, "deferred_post_compaction_cooldown");
});

test("economics: window protection compacts even inside the cooldown", () => {
  const d = decideCompaction({
    ...ECON_INPUT,
    contextWindowTokens: 100_000,
    contextTokens: 90_000,
    archiveTokens: 90_000,
    priorCompactionCount: 1,
    requestsSinceLastCompaction: 1,
  });
  assert.equal(d.windowProtection, true);
  assert.equal(d.compact, true);
  assert.equal(d.reason, "window_protection");
});

test("plan: pending/in_progress -> completed is a boundary; newly completed is not", () => {
  const t = analyzePlanTransition(
    [
      { id: "a", goal: "A", status: "pending" },
      { id: "b", goal: "B", status: "in_progress" },
      { id: "c", goal: "C", status: "completed" },
    ],
    [
      { id: "a", goal: "A", status: "completed" },
      { id: "b", goal: "B", status: "completed" },
      { id: "d", goal: "D", status: "completed" },
    ],
  );
  assert.deepEqual(t.completedSteps.map((s) => s.id), ["a", "b"]);
});

test("plan: cancelled/unknown todo statuses never fabricate a completed boundary", () => {
  const steps = todosToPlanSteps([
    { id: "1", content: "x", status: "cancelled" },
    { id: "2", content: "y", status: "weird" },
  ]);
  assert.deepEqual(steps.map((s) => s.status), ["pending", "pending"]);
  const t = analyzePlanTransition(
    [{ id: "1", goal: "x", status: "in_progress" }],
    [{ id: "1", goal: "x", status: "cancelled" } as never],
  );
  assert.equal(t.completedSteps.length, 0);
});

test("state: round-trip through injectable memory store; corrupt payloads rejected", async () => {
  const store = createMemoryStore();
  let s = initialState();
  s = recordRequest(s, 1_000);
  s = recordRequest(s, 1_500);
  s = recordBoundary(s, [{ id: "a", goal: "A", status: "completed" }]);
  s = recordCompaction(s);
  await store.save("sess-1", s);
  const loaded = await store.load("sess-1");
  assert.deepEqual(loaded, s);
  assert.equal(s.requestCount, 2);
  assert.equal(s.lastCompactionRequestCount, 2);
  assert.equal(s.compactionCount, 1);
  assert.equal(s.lastContextTokens, null);
  assert.deepEqual(s.completedBoundaryRequestCounts, [2]);
  assert.equal(requestsSinceLastCompaction(s), 0);
  assert.equal(averageContextTokenIncrement(s), 500);
  assert.equal(parseState({ version: 2 }), undefined);
  assert.equal(await store.load("missing"), undefined);
});

test("state: file store round-trip under a temp dir", async () => {
  const store = createFileStore(await tempDir("occ-state-"));
  const s = recordBoundary(recordRequest(initialState(), 42), []);
  await store.save("ses s/1", s);
  assert.deepEqual(await store.load("ses s/1"), s);
});

function fakeInput(client: unknown): PluginInput {
  return { client, directory: process.cwd(), worktree: process.cwd() } as unknown as PluginInput;
}

const OCC_CONFIG = {
  enabled: true,
  windowReserveTokens: 16_384,
  cacheWriteReadRatio: 12.5,
  minRequestsBetween: 2,
  subsequentCompactionMargin: 1.5,
} as const;

async function driveBoundary(hooks: Hooks, sessionID: string): Promise<void> {
  const event = hooks.event;
  assert.ok(event);
  await event({
    event: { type: "message.part.updated", properties: { sessionID, part: { type: "step-finish", tokens: { input: 60_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } } } as never,
  });
  await event({
    event: { type: "todo.updated", properties: { sessionID, todos: [{ id: "1", content: "g", status: "in_progress" }] } } as never,
  });
  await event({
    event: { type: "message.part.updated", properties: { sessionID, part: { type: "step-finish", tokens: { input: 60_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } } } as never,
  });
  await event({
    event: { type: "todo.updated", properties: { sessionID, todos: [{ id: "1", content: "g", status: "completed" }] } } as never,
  });
  await event({ event: { type: "session.idle", properties: { sessionID } } as never });
}

test("v1 wiring: summarize is called at the idle firing point when economics says compact", async () => {
  let summarized: unknown = undefined;
  const hooks = createOnlineContextCompactHooks(
    fakeInput({
      session: {
        messages: async () => ({ data: [{ info: { role: "user", model: { providerID: "p", modelID: "m" } } }] }),
        summarize: async (args: unknown) => {
          summarized = args;
          return { data: true };
        },
      },
      provider: { list: async () => ({ data: { providers: [{ id: "p", models: { m: { limit: { context: 200_000, output: 8_000 } } } }] } }) },
    }),
    OCC_CONFIG,
  );
  await driveBoundary(hooks, "s-ok");
  assert.deepEqual((summarized as { body: unknown }).body, { providerID: "p", modelID: "m" });
});

test("v1 wiring: fail-open when the session model is not resolvable", async () => {
  let summarized = false;
  const hooks = createOnlineContextCompactHooks(
    fakeInput({
      session: {
        messages: async () => {
          throw new Error("no messages");
        },
        summarize: async () => {
          summarized = true;
          return { data: true };
        },
      },
      provider: { list: async () => ({ data: { providers: [] } }) },
    }),
    OCC_CONFIG,
  );
  await driveBoundary(hooks, "s-fail");
  assert.equal(summarized, false);
});

test("v1 wiring: disabled config registers no hooks", () => {
  const hooks = createOnlineContextCompactHooks(fakeInput({}), { ...OCC_CONFIG, enabled: false });
  assert.deepEqual(hooks, {});
});
