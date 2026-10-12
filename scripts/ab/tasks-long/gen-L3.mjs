#!/usr/bin/env node
// Deterministic fixture generator for L3 "refactor-with-tests".
// 6-file module + behavior tests; data/config.json ~40 KB that the code reads.
// Refactor: rename public API (getRecord->fetchRecord, listRecords->listRecordsV2)
// and move validate.js into store.js, keeping the suite green. Tests log noise so
// each run is ~25 KiB.
// Usage: node gen-L3.mjs [outdir]

export function genFiles() {
  const recs = [];
  for (let i = 1; i <= 560; i++) {
    const id = `r${String(i).padStart(4, "0")}`;
    recs.push(`    "${id}": { "name": "entity-${i}", "kind": "${["alpha", "beta", "gamma"][i % 3]}", "value": ${i * 13 % 997}, "active": ${i % 4 !== 0} }`);
  }
  const config = `{\n  "version": 3,\n  "generated": "fixture-deterministic",\n  "records": {\n${recs.join(",\n")}\n  }\n}\n`;
  const maxVal = Math.max(...Array.from({ length: 560 }, (_, i) => ((i + 1) * 13) % 997));

  const files = {
    "data/config.json": config,
    "run.sh": "#!/usr/bin/env bash\nnode --test test/*.test.mjs\n",
    "src/index.js": `export { getRecord, listRecords, activeCount, topValue } from "./api.js";\n`,
    "src/api.js": `import { readStore } from "./store.js";
import { formatRecord, formatList } from "./format.js";

export function getRecord(id) {
  const rec = readStore().records[id];
  return rec ? formatRecord(id, rec) : null;
}

export function listRecords(kind) {
  const all = Object.entries(readStore().records).filter(([, r]) => r.kind === kind);
  return formatList(all);
}

export function activeCount() {
  return Object.values(readStore().records).filter((r) => r.active).length;
}

export function topValue() {
  let best = null;
  for (const r of Object.values(readStore().records)) if (!best || r.value > best.value) best = r;
  return best ? best.value : 0;
}
`,
    "src/store.js": `import { loadConfig } from "./config-loader.js";
import { validateRecord } from "./validate.js";

let cache = null;
export function readStore() {
  if (!cache) {
    const cfg = loadConfig();
    for (const [id, r] of Object.entries(cfg.records)) validateRecord(id, r);
    cache = cfg;
  }
  return cache;
}
`,
    "src/config-loader.js": `import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadConfig() {
  return JSON.parse(readFileSync(join(process.cwd(), "data", "config.json"), "utf8"));
}
`,
    "src/validate.js": `export function validateRecord(id, rec) {
  if (typeof id !== "string" || !/^r\\d{4}$/.test(id)) throw new Error("bad id " + id);
  if (typeof rec?.name !== "string" || typeof rec?.value !== "number") throw new Error("bad record " + id);
  return true;
}
`,
    "src/format.js": `export function formatRecord(id, rec) {
  return { id, name: rec.name, kind: rec.kind, value: rec.value, active: !!rec.active };
}

export function formatList(entries) {
  return entries.map(([id, r]) => formatRecord(id, r)).sort((a, b) => a.id.localeCompare(b.id));
}
`,
  };

  const tests = [
    'import { test } from "node:test";',
    'import assert from "node:assert";',
    'import { getRecord, listRecords, activeCount, topValue } from "../src/index.js";',
  ];
  for (let i = 0; i < 40; i++) tests.push(`console.log("[suite-h ${i}] " + "refactor-guard ".repeat(24) + "keep-green after every file change");`);
  const cases = [
    'assert.strictEqual(getRecord("r0001").name, "entity-1");',
    'assert.strictEqual(getRecord("r0001").kind, "beta");',
    'assert.strictEqual(getRecord("r0560").value, (560 * 13) % 997);',
    'assert.strictEqual(getRecord("nope"), null);',
    'assert.strictEqual(listRecords("alpha").length, 186);',
    'assert.strictEqual(listRecords("beta")[0].id, "r0001");',
    'assert.strictEqual(listRecords("gamma").at(-1).kind, "gamma");',
    'assert.strictEqual(listRecords("none").length, 0);',
    'assert.strictEqual(activeCount(), 420);',
    `assert.strictEqual(topValue(), ${maxVal});`,
    'assert.strictEqual(getRecord("r0101").active, true);',
    'assert.strictEqual(getRecord("r0104").active, false);',
    'assert.strictEqual(listRecords("alpha").at(-1).id, "r0558");',
    'assert.strictEqual(getRecord("r0002").kind, "gamma");',
    'assert.strictEqual(getRecord("r0003").kind, "alpha");',
    'assert.ok(activeCount() < 560);',
  ];
  cases.forEach((c, i) => {
    tests.push(`test("behavior.${String(i).padStart(2, "0")}", () => {`);
    tests.push(`  console.log("[case ${i}] " + "assertion-trail ".repeat(24) + "module=records,io=fs,mode=strict");`);
    tests.push(`  ${c}`);
    tests.push("});");
  });
  files["test/behavior.test.mjs"] = tests.join("\n") + "\n";
  files["README.md"] =
    "# fixture\n\n6-file module under src/, behavior tests in test/, data/config.json (~40 KB).\nRefactor per the task prompt; keep `bash run.sh` green after every file change.\n";
  return files;
}

if (process.argv[1] && process.argv[1].endsWith("gen-L3.mjs")) {
  const out = process.argv[2];
  if (!out) {
    console.log("files:", Object.entries(genFiles()).map(([k, v]) => `${k} (${v.length}B)`).join(", "));
  } else {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const [name, content] of Object.entries(genFiles())) {
      mkdirSync(join(out, name, ".."), { recursive: true });
      writeFileSync(join(out, name), content);
    }
    console.log(`wrote ${Object.keys(genFiles()).length} files to ${out}`);
  }
}
