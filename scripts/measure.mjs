#!/usr/bin/env node
// P6 session-log miner: mines opencode's SQLite session store for the three
// SoL-Pi waste signatures (Action Fusion adjacency, ObservationPack replay,
// OCC compaction). No deps: node:sqlite (Node >= 22.5).
//
//   node scripts/measure.mjs --db ~/.local/share/opencode/opencode.db [--json out.json] [--verbose]

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const THRESHOLD_BYTES = 10240;
export const CHARS_PER_TOKEN = 4;
export const FULL_SENDS = 2; // ObservationPack keeps 2 full sends; beyond that replay is waste

export const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit", "edit_file", "write_file"]);
export const RUN_TOOLS = new Set(["bash", "shell", "run", "exec", "execute", "command"]);

function parseToolPart(data) {
  if (data.type !== "tool") return null;
  const state = data.state ?? {};
  const output = typeof state.output === "string" ? state.output : null;
  return { tool: String(data.tool ?? ""), callID: String(data.callID ?? ""), output, status: state.status ?? null };
}

function outputBytes(toolPart, offloadDir) {
  // inline part output, and the offloaded file if present; take the larger (offload replaces inline)
  let inline = toolPart.output != null ? Buffer.byteLength(toolPart.output, "utf8") : 0;
  let file = 0;
  if (offloadDir && toolPart.callID) {
    const p = join(offloadDir, toolPart.callID);
    if (existsSync(p)) file = readFileSync(p).length;
  }
  return { inline, file, size: Math.max(inline, file) };
}

export function analyzeSession(session, messages, parts, offloadDir) {
  const byMessage = new Map();
  for (const p of parts) {
    if (!byMessage.has(p.message_id)) byMessage.set(p.message_id, []);
    byMessage.get(p.message_id).push(p);
  }

  // assistant turns only: each assistant message == one provider request
  const turns = [];
  for (const m of messages) {
    const data = JSON.parse(m.data);
    if (data.role !== "assistant") continue;
    const mp = byMessage.get(m.id) ?? [];
    const turn = { id: m.id, role: data.role, tools: [], compactionParts: 0, stepFinishes: 0 };
    for (const p of mp) {
      const d = JSON.parse(p.data);
      if (d.type === "compaction" || (typeof d.type === "string" && /compact/i.test(d.type))) turn.compactionParts++;
      if (d.type === "step-finish") turn.stepFinishes++;
      const t = parseToolPart(d);
      if (t) turn.tools.push({ ...t, time: p.time_created, partId: p.id });
    }
    turns.push(turn);
  }

  // flat tool sequence with turn index
  const seq = [];
  turns.forEach((t, ti) => t.tools.forEach((tool) => seq.push({ ...tool, turn: ti })));

  // --- Action Fusion: edit->run adjacency ---
  let editParts = 0, adjacent = 0, sameTurn = 0, crossTurn = 0;
  const nextAction = new Map(); // tool -> count (next action after an edit/write part)
  for (let i = 0; i < seq.length; i++) {
    const cur = seq[i];
    if (!EDIT_TOOLS.has(cur.tool)) continue;
    editParts++;
    const nxt = seq[i + 1];
    if (!nxt) continue;
    nextAction.set(nxt.tool, (nextAction.get(nxt.tool) ?? 0) + 1);
    if (!RUN_TOOLS.has(nxt.tool)) continue;
    if (nxt.turn === cur.turn) { adjacent++; sameTurn++; }
    else if (nxt.turn === cur.turn + 1) { adjacent++; crossTurn++; } // nxt is first tool of next turn (seq order)
  }
  const adjacencyRate = editParts ? adjacent / editParts : 0;
  const bashNext = nextAction.get("bash") ?? 0;
  const runNext = [...nextAction.entries()].filter(([t]) => RUN_TOOLS.has(t)).reduce((a, [, n]) => a + n, 0);
  const nextTotal = [...nextAction.values()].reduce((a, n) => a + n, 0);
  const bashShareOfNext = nextTotal ? bashNext / nextTotal : 0;
  const runShareOfNext = nextTotal ? runNext / nextTotal : 0;

  // SoL-Pi comparable: % of cross-turn transitions that are edit/write -> run candidates
  const toolTurns = turns.map((t, i) => ({ i, first: t.tools[0]?.tool, last: t.tools.at(-1)?.tool })).filter((t) => t.first);
  let transitions = 0, eligibleTransitions = 0;
  for (let k = 0; k + 1 < toolTurns.length; k++) {
    transitions++;
    if (EDIT_TOOLS.has(toolTurns[k].last) && RUN_TOOLS.has(toolTurns[k + 1].first)) eligibleTransitions++;
  }
  const eligibleTransitionRate = transitions ? eligibleTransitions / transitions : 0;

  // --- ObservationPack: large-output replay ---
  // provider requests after first appearance = assistant turns strictly after the turn
  // in which the output first appeared (each assistant turn = one provider request).
  const assistantTurns = turns.length;
  const largeOutputs = [];
  let replayBytes = 0, replayTokens = 0;
  seq.forEach((tool, idx) => {
    const { inline, file, size } = outputBytes(tool, offloadDir);
    if (size < THRESHOLD_BYTES) return;
    const requestsAfter = assistantTurns - (tool.turn + 1);
    const replays = Math.max(0, requestsAfter - FULL_SENDS);
    const bytes = size * replays;
    const tokens = Math.round(bytes / CHARS_PER_TOKEN);
    replayBytes += bytes;
    replayTokens += tokens;
    largeOutputs.push({
      partId: tool.partId, callID: tool.callID, tool: tool.tool, turn: tool.turn,
      inlineBytes: inline, offloadBytes: file, sizeBytes: size,
      requestsAfterFirstAppearance: requestsAfter, replays, replayableBytes: bytes, replayableTokens: tokens,
    });
  });

  // --- OCC: compaction activity ---
  const compactionParts = turns.reduce((a, t) => a + t.compactionParts, 0);
  const timeCompacting = session.time_compacting ?? null;

  // --- totals ---
  const toolCalls = seq.length;
  const tokens = {
    input: session.tokens_input ?? 0,
    output: session.tokens_output ?? 0,
    reasoning: session.tokens_reasoning ?? 0,
    cacheRead: session.tokens_cache_read ?? 0,
    cacheWrite: session.tokens_cache_write ?? 0,
  };

  return {
    id: session.id, slug: session.slug, title: session.title, agent: session.agent ?? null,
    timeCreated: session.time_created, timeCompacting,
    messages: messages.length, assistantTurns, toolCalls,
    actionFusion: {
      editParts, adjacent, sameTurn, crossTurn, adjacencyRate,
      transitions, eligibleTransitions, eligibleTransitionRate,
      bashShareOfNext, runShareOfNext,
      nextActions: Object.fromEntries([...nextAction.entries()].sort((a, b) => b[1] - a[1])),
    },
    observationPack: { thresholdBytes: THRESHOLD_BYTES, largeOutputs, replayBytes, replayTokens },
    occ: { compactionParts, timeCompacting, note: compactionParts === 0 && timeCompacting == null ? "no compaction observed" : null },
    tokens, cost: session.cost ?? 0,
  };
}

export function analyzeDatabase(dbPath, { offloadDir } = {}) {
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  const dir = offloadDir ?? join(dirname(resolve(dbPath)), "tool-output");
  const sessions = db.prepare("SELECT * FROM session ORDER BY time_created").all();
  const messages = db.prepare("SELECT * FROM message ORDER BY time_created, id").all();
  const parts = db.prepare("SELECT * FROM part ORDER BY time_created, id").all();
  const bySession = new Map();
  for (const m of messages) (bySession.get(m.session_id) ?? bySession.set(m.session_id, []).get(m.session_id)).push(m);
  const bySessionParts = new Map();
  for (const p of parts) (bySessionParts.get(p.session_id) ?? bySessionParts.set(p.session_id, []).get(p.session_id)).push(p);
  const out = sessions.map((s) =>
    analyzeSession(s, bySession.get(s.id) ?? [], bySessionParts.get(s.id) ?? [], existsSync(dir) ? dir : null),
  );
  db.close();
  return { dbPath: resolve(dbPath), offloadDir: existsSync(dir) ? dir : null, sessions: out };
}

export function aggregate(result) {
  const s = result.sessions;
  const sum = (f) => s.reduce((a, x) => a + f(x), 0);
  const editParts = sum((x) => x.actionFusion.editParts);
  const adjacent = sum((x) => x.actionFusion.adjacent);
  const transitions = sum((x) => x.actionFusion.transitions);
  const eligible = sum((x) => x.actionFusion.eligibleTransitions);
  return {
    sessions: s.length,
    messages: sum((x) => x.messages),
    toolCalls: sum((x) => x.toolCalls),
    editParts,
    adjacent,
    adjacencyRate: editParts ? adjacent / editParts : 0,
    transitions,
    eligibleTransitions: eligible,
    eligibleTransitionRate: transitions ? eligible / transitions : 0,
    largeOutputs: sum((x) => x.observationPack.largeOutputs.length),
    replayBytes: sum((x) => x.observationPack.replayBytes),
    replayTokens: sum((x) => x.observationPack.replayTokens),
    compactionParts: sum((x) => x.occ.compactionParts),
    sessionsWithCompaction: s.filter((x) => x.occ.compactionParts > 0 || x.timeCompacting != null).length,
    tokens: {
      input: sum((x) => x.tokens.input), output: sum((x) => x.tokens.output),
      reasoning: sum((x) => x.tokens.reasoning), cacheRead: sum((x) => x.tokens.cacheRead),
      cacheWrite: sum((x) => x.tokens.cacheWrite),
    },
    cost: sum((x) => x.cost),
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const num = (x) => x.toLocaleString("en-US");

export function formatTable(result) {
  const lines = [];
  lines.push(`db: ${result.dbPath}`);
  lines.push(`tool-output offload dir: ${result.offloadDir ?? "(none)"}`);
  lines.push("");
  lines.push("session                                   msgs  tools  edit  adj%  elig%  bash%  big  replayTok  cmp");
  lines.push("-".repeat(96));
  for (const s of result.sessions) {
    lines.push(
      `${(s.slug || s.title).slice(0, 40).padEnd(40)} ${String(s.messages).padStart(4)} ${String(s.toolCalls).padStart(6)} ` +
      `${String(s.actionFusion.editParts).padStart(5)} ${pct(s.actionFusion.adjacencyRate).padStart(6)} ` +
      `${pct(s.actionFusion.eligibleTransitionRate).padStart(6)} ${pct(s.actionFusion.bashShareOfNext).padStart(6)} ` +
      `${String(s.observationPack.largeOutputs.length).padStart(4)} ${num(s.observationPack.replayTokens).padStart(10)} ` +
      `${String(s.occ.compactionParts).padStart(3)}`,
    );
  }
  const a = aggregate(result);
  lines.push("-".repeat(96));
  lines.push(
    `TOTAL (${a.sessions} sessions)`.padEnd(40) + ` ${String(a.messages).padStart(4)} ${String(a.toolCalls).padStart(6)} ` +
    `${String(a.editParts).padStart(5)} ${pct(a.adjacencyRate).padStart(6)} ${pct(a.eligibleTransitionRate).padStart(6)} ` +
    `${"-".repeat(6)} ${String(a.largeOutputs).padStart(4)} ${num(a.replayTokens).padStart(10)} ${String(a.compactionParts).padStart(3)}`,
  );
  lines.push("");
  lines.push(`Action Fusion: ${a.adjacent}/${a.editParts} edit parts adjacent to a run (${pct(a.adjacencyRate)}); ` +
    `${a.eligibleTransitions}/${a.transitions} cross-turn transitions eligible (${pct(a.eligibleTransitionRate)})`);
  lines.push(`ObservationPack: ${a.largeOutputs} outputs >= ${num(THRESHOLD_BYTES)} B -> est. ${num(a.replayBytes)} replayable bytes = ${num(a.replayTokens)} tokens`);
  lines.push(`OCC: ${a.compactionParts} compaction parts; ${a.sessionsWithCompaction} sessions with time_compacting/compaction parts` +
    (a.compactionParts === 0 && a.sessionsWithCompaction === 0 ? " (zero: no compaction occurred in this dataset)" : ""));
  lines.push(`Totals: ${a.messages} messages, ${a.toolCalls} tool calls, tokens in/out/reasoning=${num(a.tokens.input)}/${num(a.tokens.output)}/${num(a.tokens.reasoning)}, cache read/write=${num(a.tokens.cacheRead)}/${num(a.tokens.cacheWrite)}, cost=${a.cost.toFixed(4)}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = { db: null, json: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i];
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db || args.help) {
    console.log("usage: node scripts/measure.mjs --db <path-to-opencode.db> [--json <out.json>] [--verbose]");
    process.exit(args.help ? 0 : 2);
  }
  const result = analyzeDatabase(args.db);
  console.log(formatTable(result));
  if (args.verbose) {
    for (const s of result.sessions) {
      console.log(`\n== ${s.slug} (${s.id}) agent=${s.agent} turns=${s.assistantTurns} ==`);
      console.log(`  nextActions after edit/write: ${JSON.stringify(s.actionFusion.nextActions)}`);
      for (const o of s.observationPack.largeOutputs) {
        console.log(`  big: ${o.tool} call=${o.callID} size=${o.sizeBytes}B inline=${o.inlineBytes} offload=${o.offloadBytes} after=${o.requestsAfterFirstAppearance} replays=${o.replays} -> ${o.replayableTokens} tok`);
      }
    }
  }
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ ...result, aggregate: aggregate(result) }, null, 2));
    console.log(`\nwrote ${args.json}`);
  }
}
