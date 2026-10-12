#!/usr/bin/env node
// P6c/P6d A/B collector: reads .ab/results/*.json + each run's opencode SQLite DB,
// sums real billed tokens per arm/task (reuses measure.mjs analyzeDatabase),
// derives per-run mechanism FIRING COUNTERS from run artifacts (XDG cache sol-pi
// dir + DB parts), computes paired on-off deltas, and writes docs/plan/ab-results.json.
// Usage: node scripts/ab/collect.mjs [off on op-only] [--tasks T1,L1,...] [--run N]
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { analyzeDatabase, aggregate } from "../measure.mjs";

const REPO = resolve(new URL("../..", import.meta.url).pathname);
const AB = join(REPO, ".ab");

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const TASKS = (arg("tasks") ?? "T1,T2,T3,T4,T5").split(",").filter(Boolean);
const RUN = Number(arg("run") ?? "1");
const ARMS = process.argv.slice(2).filter((a) => ["off", "on", "op-only"].includes(a));
const arms = ARMS.length ? ARMS : ["off", "on"];

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Mechanism firing counters derived from artifacts (no src/ changes):
//  ObservationPack: archive files (obs_*.txt) under $XDG_CACHE/opencode/sol-pi/**
//    + placeholder handle lines in stored tool parts (ledger is in-memory only).
//  Reducer: journal JSONL entry count (reducer-journal-*.jsonl).
//  OCC: state files under _occ/ + recorded transitions (compactionCount +
//    completed boundary counts) + compaction parts in DB (from measure).
//  Action Fusion: [then_run:succeeded|failed|skipped] tags in stored tool parts.
function firingCounters(rec) {
  const c = {
    obsArchiveFiles: 0,
    obsPlaceholderParts: 0,
    reducerJournalEntries: 0,
    occStateFiles: 0,
    occTransitions: 0,
    fusionTags: { succeeded: 0, failed: 0, skipped: 0 },
  };
  const solpi = rec.cacheDir ? join(rec.cacheDir, "opencode", "sol-pi") : null;
  if (solpi && existsSync(solpi)) {
    for (const f of walk(solpi)) {
      const b = basename(f);
      if (/^obs_[a-f0-9]{24}\.txt$/.test(b)) c.obsArchiveFiles++;
      else if (/^reducer-journal-.*\.jsonl$/.test(b)) {
        c.reducerJournalEntries += readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length;
      } else if (b.endsWith(".json") && f.includes(`${join("", "_occ")}`)) {
        c.occStateFiles++;
        try {
          const st = JSON.parse(readFileSync(f, "utf8"));
          c.occTransitions += (st.compactionCount ?? 0) + (st.completedBoundaryRequestCounts?.length ?? 0);
        } catch {}
      }
    }
  }
  if (rec.db && existsSync(rec.db)) {
    const db = new DatabaseSync(resolve(rec.db), { readOnly: true });
    for (const row of db.prepare("SELECT data FROM part WHERE data LIKE '%\"type\":\"tool\"%'").all()) {
      const d = row.data;
      for (const tag of ["succeeded", "failed", "skipped"]) {
        c.fusionTags[tag] += (d.match(new RegExp(`\\[then_run:${tag}\\]`, "g")) ?? []).length;
      }
      c.obsPlaceholderParts += (d.match(/id: obs_[a-f0-9]{24}/g) ?? []).length;
    }
    db.close();
  }
  c.fusionTagsTotal = c.fusionTags.succeeded + c.fusionTags.failed + c.fusionTags.skipped;
  return c;
}

function load(arm, task) {
  const candidates = [join(AB, "results", `${arm}-${task}-r${RUN}.json`), join(AB, "results", `${arm}-${task}.json`)];
  const rp = candidates.find(existsSync);
  if (!rp) return null;
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
        adjacent: agg.adjacent,
        adjacencyRate: agg.adjacencyRate,
        eligibleRate: agg.eligibleTransitionRate,
        compactionParts: agg.compactionParts,
      };
    } catch (e) {
      m = { error: String(e) };
    }
  }
  try {
    rec.counters = firingCounters(rec);
    writeFileSync(rp, JSON.stringify(rec, null, 2));
    const tracked = join(REPO, "docs", "plan", "ab-results-long", `${arm}-${task}-r${RUN}.json`);
    if (existsSync(tracked)) {
      writeFileSync(tracked, JSON.stringify(rec, null, 2));
      spawnSync("git", ["add", tracked.slice(REPO.length + 1)], { cwd: REPO });
      spawnSync("git", ["commit", "-m", `P6d: counters ${arm}-${task}-r${RUN}`, "--", tracked.slice(REPO.length + 1)], { cwd: REPO });
    }
  } catch (e) {
    rec.counters = { error: String(e) };
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

console.log(`arms: ${arms.join(", ")}  tasks: ${TASKS.join(",")}  run: ${RUN}\n`);
console.log("task  arm       exit score turns  tokTotal     in        cacheR     out       replayTok  adj  obsArc obsPh jrn occS occT fus");
console.log("-".repeat(128));
for (const { task, byArm } of rows) {
  for (const arm of arms) {
    const e = byArm[arm];
    if (!e) {
      console.log(`${task}   ${arm.padEnd(7)}  (no run)`);
      continue;
    }
    const m = e.m && !e.m.error ? e.m : {};
    const c = e.rec.counters ?? {};
    console.log(
      `${task}   ${arm.padEnd(7)}  ${String(e.rec.opencodeExit).padStart(3)}  ${e.rec.verifierScore}     ` +
        `${String(m.turns ?? "—").padStart(4)}  ${num(m.total).padStart(10)}  ${num(m.input).padStart(8)}  ` +
        `${num(m.cacheRead).padStart(9)}  ${num(m.output).padStart(8)}  ${num(m.replayTokens).padStart(9)}  ` +
        `${String(m.adjacent ?? "—").padStart(3)}  ${String(c.obsArchiveFiles ?? "—").padStart(5)} ${String(c.obsPlaceholderParts ?? "—").padStart(4)} ` +
        `${String(c.reducerJournalEntries ?? "—").padStart(3)} ${String(c.occStateFiles ?? "—").padStart(4)} ${String(c.occTransitions ?? "—").padStart(4)} ` +
        `${String(c.fusionTagsTotal ?? "—").padStart(3)}`,
    );
  }
  if (byArm.off && byArm.on && byArm.off.m?.total != null && byArm.on.m?.total != null) {
    const d = ((byArm.on.m.total - byArm.off.m.total) / byArm.off.m.total) * 100;
    console.log(`      paired on-off tokens: ${pct(d)}   score off=${byArm.off.rec.verifierScore} on=${byArm.on.rec.verifierScore}`);
  }
  console.log("");
}

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
  console.log(`  ${arm.padEnd(7)} runs=${t.runs} score=${t.score}/${TASKS.length} tokTotal=${num(t.total)} turns=${t.turns} replayTok=${num(t.replay)}`);
}
if (totals.off?.total && totals.on?.total) {
  const d = ((totals.on.total - totals.off.total) / totals.off.total) * 100;
  console.log(`\nTOTAL paired on-off tokens: ${pct(d)}  (off=${num(totals.off.total)} on=${num(totals.on.total)})`);
}

mkdirSync(join(REPO, "docs", "plan"), { recursive: true });
writeFileSync(
  join(REPO, "docs", "plan", "ab-results.json"),
  JSON.stringify({ arms, run: RUN, rows, totals }, null, 2),
);
console.log(`\nwrote docs/plan/ab-results.json`);
