import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { analyzeDatabase, aggregate, THRESHOLD_BYTES } from "../scripts/measure.mjs";

const dir = join(import.meta.dirname, `.measure-fixture-${process.pid}`);
const dbPath = join(dir, "opencode.db");
const offloadDir = join(dir, "tool-output");

function msg(id, sessionId, role, t) {
  return [id, sessionId, t, t, JSON.stringify({ role, tokens: { input: 1, output: 1, cache: {} }, cost: 0 })];
}
function part(id, messageId, sessionId, t, data) {
  return [id, messageId, sessionId, t, t, JSON.stringify(data)];
}
function toolPart(id, messageId, sessionId, t, tool, callID, output) {
  return part(id, messageId, sessionId, t, { type: "tool", tool, callID, state: { status: "completed", input: {}, output } });
}

function buildFixture() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(offloadDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
      slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL,
      share_url text, summary_additions integer, summary_deletions integer, summary_files integer,
      summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL,
      tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
      tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL,
      revert text, permission text, agent text, model text, time_created integer NOT NULL,
      time_updated integer NOT NULL, time_compacting integer, time_archived integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
      time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  const insS = db.prepare("INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated,time_compacting,cost,tokens_input,tokens_output,tokens_cache_read,tokens_cache_write,tokens_reasoning,agent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insM = db.prepare("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?)");
  const insP = db.prepare("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)");

  // --- S1: adjacency + replay (5 assistant turns) ---
  insS.run("S1", "p1", "s1", "/x", "s1", "1.19.0", 1, 100, null, 0, 10, 20, 30, 0, 0, "orchestrator");
  insM.run(...msg("u1", "S1", "user", 1));
  ["a1", "a2", "a3", "a4", "a5"].forEach((id, i) => insM.run(...msg(id, "S1", "assistant", 2 + i)));
  let t = 10;
  const P = [];
  P.push(toolPart("p1", "a1", "S1", t++, "edit", "c1", "x"));
  P.push(toolPart("p2", "a1", "S1", t++, "bash", "c2", "B".repeat(20000))); // big inline, turn 0
  P.push(toolPart("p3", "a2", "S1", t++, "read", "call_off1", "tiny"));    // offloaded 15000 B, turn 1
  P.push(toolPart("p4", "a2", "S1", t++, "write", "c3", "y"));             // last tool of turn 1
  P.push(toolPart("p5", "a3", "S1", t++, "bash", "c5", "z"));              // first tool of turn 2
  P.push(toolPart("p6", "a4", "S1", t++, "edit", "c6", "w"));              // no next tool
  P.push(part("p7", "a5", "S1", t++, { type: "text", text: "done" }));
  for (const p of P) insP.run(...p);
  writeFileSync(join(offloadDir, "call_off1"), "O".repeat(15000));

  // --- S2: compaction observed ---
  insS.run("S2", "p1", "s2", "/x", "s2", "1.19.0", 200, 300, 250, 0.5, 1, 2, 0, 0, 0, "build");
  insM.run(...msg("b1", "S2", "assistant", 201));
  insP.run(...part("q1", "b1", "S2", 202, { type: "compaction", text: "summary" }));

  // --- S3: nothing ---
  insS.run("S3", "p1", "s3", "/x", "s3", "1.19.0", 400, 410, null, 0, 0, 0, 0, 0, 0, "build");
  db.close();
}

buildFixture();
after(() => rmSync(dir, { recursive: true, force: true }));

const result = analyzeDatabase(dbPath);
const s1 = result.sessions.find((s) => s.id === "S1");
const s2 = result.sessions.find((s) => s.id === "S2");
const s3 = result.sessions.find((s) => s.id === "S3");

test("offload dir discovered next to db", () => {
  assert.equal(result.offloadDir, offloadDir);
});

test("edit->run adjacency math", () => {
  const af = s1.actionFusion;
  assert.equal(af.editParts, 3);
  assert.equal(af.sameTurn, 1);
  assert.equal(af.crossTurn, 1);
  assert.equal(af.adjacent, 2);
  assert.equal(af.adjacencyRate, 2 / 3);
  assert.equal(af.transitions, 3);
  assert.equal(af.eligibleTransitions, 1);
  assert.equal(af.eligibleTransitionRate, 1 / 3);
  assert.equal(af.bashShareOfNext, 1);
  assert.deepEqual(af.nextActions, { bash: 2 });
});

test("large-output replay math (inline + offload)", () => {
  const op = s1.observationPack;
  assert.equal(op.thresholdBytes, THRESHOLD_BYTES);
  assert.equal(op.largeOutputs.length, 2);
  const inline = op.largeOutputs.find((o) => o.callID === "c2");
  const off = op.largeOutputs.find((o) => o.callID === "call_off1");
  assert.equal(inline.sizeBytes, 20000);
  assert.equal(inline.requestsAfterFirstAppearance, 4); // 5 assistant turns, appeared in turn 0
  assert.equal(inline.replays, 2);                      // 4 - 2 full sends
  assert.equal(inline.replayableBytes, 40000);
  assert.equal(inline.replayableTokens, 10000);         // 4 chars/token
  assert.equal(off.inlineBytes, 4);
  assert.equal(off.offloadBytes, 15000);
  assert.equal(off.sizeBytes, 15000);
  assert.equal(off.requestsAfterFirstAppearance, 3);
  assert.equal(off.replays, 1);
  assert.equal(off.replayableBytes, 15000);
  assert.equal(off.replayableTokens, 3750);
  assert.equal(op.replayBytes, 55000);
  assert.equal(op.replayTokens, 13750);
});

test("replay clamps to zero when output appears late", () => {
  const late = analyzeDatabase(dbPath).sessions.find((s) => s.id === "S1");
  assert.ok(late.observationPack.largeOutputs.every((o) => o.replays >= 0));
});

test("compaction counting", () => {
  assert.equal(s2.occ.compactionParts, 1);
  assert.equal(s2.timeCompacting, 250);
  assert.equal(s1.occ.compactionParts, 0);
  assert.equal(s1.occ.note, "no compaction observed");
  assert.equal(s3.occ.compactionParts, 0);
  assert.equal(s3.timeCompacting, null);
});

test("aggregate totals", () => {
  const a = aggregate(result);
  assert.equal(a.sessions, 3);
  assert.equal(a.messages, 7);
  assert.equal(a.toolCalls, 6);
  assert.equal(a.editParts, 3);
  assert.equal(a.adjacencyRate, 2 / 3);
  assert.equal(a.eligibleTransitionRate, 1 / 3);
  assert.equal(a.replayTokens, 13750);
  assert.equal(a.compactionParts, 1);
  assert.equal(a.sessionsWithCompaction, 1);
  assert.equal(a.tokens.input, 11);
  assert.equal(a.cost, 0.5);
});
