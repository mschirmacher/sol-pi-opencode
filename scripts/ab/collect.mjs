#!/usr/bin/env node
// P6c A/B collector: reads .ab/results/*.json + each run's opencode SQLite DB,
// sums real billed tokens per arm/task (reuses measure.mjs analyzeDatabase),
// computes paired on-off deltas, and writes docs/plan/ab-results.json.
// Usage: node scripts/ab/collect.mjs [off on op-only]
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyzeDatabase, aggregate } from "../measure.mjs";

const REPO = resolve(new URL("../..", import.meta.url).pathname);
const AB = join(REPO, ".ab");
const TASKS = ["T1", "T2", "T3", "T4", "T5"];
const ARMS = process.argv.slice(2).filter((a) => ["off", "on", "op-only"].includes(a));
const arms = ARMS.length ? ARMS : ["off", "on"];

function load(arm, task) {
  const rp = join(AB, "results", `${arm}-${task}.json`);
  if (!existsSync(rp)) return null;
  const rec = JSON.parse(readFileSync(rp, "utf8"));
  let m = null;
  if (rec.db && existsSync(rec.db)) {
    try {
      const res = analyzeDatabase(rec.db);
      const agg = aggregate(res);
      const t = agg.tokens;
      const total = t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
      m = {
        total,
        input: t.input,
        output: t.output,
        cacheRead: t.cacheRead,
        reasoning: t.reasoning,
        turns: res.sessions.reduce((a, s) => a + s.assistantTurns, 0),
        sessions: agg.sessions,
        toolCalls: agg.toolCalls,
        replayTokens: agg.replayTokens,
        adjacencyRate: agg.adjacencyRate,
        eligibleRate: agg.eligibleTransitionRate,
      };
    } catch (e) {
      m = { error: String(e) };
    }
  }
  return { rec, m };
}

const rows = [];
for (const task of TASKS) {
  const byArm = {};
  for (const arm of arms) byArm[arm] = load(arm, task);
  rows.push({ task, byArm });
}

const pct = (x) => (x == null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);
const num = (x) => (x == null ? "—" : x.toLocaleString("en-US"));

console.log(`arms: ${arms.join(", ")}\n`);
console.log("task  arm       exit score turns  tokTotal     in        cacheR     out       replayTok  adj%");
console.log("-".repeat(104));
for (const { task, byArm } of rows) {
  for (const arm of arms) {
    const e = byArm[arm];
    if (!e) {
      console.log(`${task}   ${arm.padEnd(7)}  (no run)`);
      continue;
    }
    const m = e.m && !e.m.error ? e.m : {};
    console.log(
      `${task}   ${arm.padEnd(7)}  ${String(e.rec.opencodeExit).padStart(3)}  ${e.rec.verifierScore}     ` +
        `${String(m.turns ?? "—").padStart(4)}  ${num(m.total).padStart(10)}  ${num(m.input).padStart(8)}  ` +
        `${num(m.cacheRead).padStart(9)}  ${num(m.output).padStart(8)}  ${num(m.replayTokens).padStart(9)}  ` +
        `${m.adjacencyRate != null ? (m.adjacencyRate * 100).toFixed(0) : "—"}`,
    );
  }
  if (byArm.off && byArm.on && byArm.off.m?.total != null && byArm.on.m?.total != null) {
    const d = ((byArm.on.m.total - byArm.off.m.total) / byArm.off.m.total) * 100;
    console.log(`      paired on-off tokens: ${pct(d)}   score off=${byArm.off.rec.verifierScore} on=${byArm.on.rec.verifierScore}`);
  }
  console.log("");
}

// per-arm totals
const totals = {};
for (const arm of arms) {
  let total = 0, turns = 0, score = 0, runs = 0, replay = 0;
  for (const { byArm } of rows) {
    const e = byArm[arm];
    if (!e) continue;
    runs++;
    score += e.rec.verifierScore;
    if (e.m && !e.m.error) {
      total += e.m.total;
      turns += e.m.turns;
      replay += e.m.replayTokens;
    }
  }
  totals[arm] = { total, turns, score, runs, replay };
}
console.log("arm totals:");
for (const arm of arms) {
  const t = totals[arm];
  console.log(`  ${arm.padEnd(7)} runs=${t.runs} score=${t.score}/5 tokTotal=${num(t.total)} turns=${t.turns} replayTok=${num(t.replay)}`);
}
if (totals.off?.total && totals.on?.total) {
  const d = ((totals.on.total - totals.off.total) / totals.off.total) * 100;
  console.log(`\nTOTAL paired on-off tokens: ${pct(d)}  (off=${num(totals.off.total)} on=${num(totals.on.total)})`);
}

mkdirSync(join(REPO, "docs", "plan"), { recursive: true });
writeFileSync(
  join(REPO, "docs", "plan", "ab-results.json"),
  JSON.stringify({ arms, rows, totals }, null, 2),
);
console.log(`\nwrote docs/plan/ab-results.json`);
