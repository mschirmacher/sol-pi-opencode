#!/usr/bin/env node
// Deterministic fixture generator for L1 "fix-12-tests".
// 4 modules x 12 tests = 48 tests, exactly 12 failing (3 per module, one buggy
// function each). Every test logs noise so a full suite run is ~30 KiB.
// Usage: node gen-L1.mjs [outdir]   (also importable: genFiles() -> {path: content})

const NOISE = (tag) => `console.log("[diag ${tag}] " + "seed-audit-line ".repeat(14) + "ctx=auth,cache,io,net,tls,fs,ipc");`;

function testFile(mod, fns) {
  const lines = [
    'import { test } from "node:test";',
    'import assert from "node:assert";',
    `import { ${fns.join(", ")} } from "../src/${mod}.js";`,
  ];
  for (let i = 0; i < 20; i++) lines.push(NOISE(`${mod}.h${i}`));
  for (const fn of fns) {
    for (let k = 0; k < 3; k++) {
      const t = `${mod}.${fn}${k}`;
      lines.push(`test("${t}", () => {`);
      lines.push(`  ${NOISE(t)}`);
      lines.push(`  ${CASES[mod][fn][k]}`);
      lines.push("});");
    }
  }
  return lines.join("\n") + "\n";
}

const CASES = {
  auth: {
    parseToken: [
      'assert.deepStrictEqual(parseToken("amy:read,write:300"), { user: "amy", scope: "read,write", ttl: 300 });',
      'assert.strictEqual(parseToken("bob:admin:60").user, "bob");',
      'assert.strictEqual(parseToken("cid:x:0").ttl, 0);',
    ],
    hashToken: [
      'assert.strictEqual(hashToken("amy:read:300"), 707077276);',
      'assert.strictEqual(hashToken(""), 0);',
      'assert.strictEqual(hashToken("zz"), 3904);',
    ],
    isExpired: [
      'assert.strictEqual(isExpired({ issuedAt: 100, ttl: 50 }, 151), true);',
      'assert.strictEqual(isExpired({ issuedAt: 100, ttl: 50 }, 140), false);',
      'assert.strictEqual(isExpired({ issuedAt: 0, ttl: 1000 }, 999), false);',
    ],
    hasScope: [
      'assert.strictEqual(hasScope({ scope: "read,write" }, "write"), true);',
      'assert.strictEqual(hasScope({ scope: "read" }, "admin"), false);',
      'assert.strictEqual(hasScope({ scope: "a,b,c" }, "b"), true);',
    ],
  },
  cart: {
    addItem: [
      'assert.deepStrictEqual(addItem([], { sku: "a", qty: 2 }), [{ sku: "a", qty: 2 }]);',
      'assert.strictEqual(addItem([{ sku: "a", qty: 1 }], { sku: "a", qty: 3 })[0].qty, 4);',
      'assert.strictEqual(addItem([{ sku: "a", qty: 1 }], { sku: "b", qty: 1 }).length, 2);',
    ],
    removeItem: [
      'assert.strictEqual(removeItem([{ sku: "a", qty: 1 }], "a").length, 0);',
      'assert.strictEqual(removeItem([{ sku: "a", qty: 1 }], "z").length, 1);',
      'assert.deepStrictEqual(removeItem([{ sku: "a", qty: 1 }, { sku: "b", qty: 2 }], "b"), [{ sku: "a", qty: 1 }]);',
    ],
    totalPrice: [
      'assert.strictEqual(totalPrice([{ price: 100, qty: 2 }], 10), 220);',
      'assert.strictEqual(totalPrice([{ price: 100, qty: 1 }, { price: 50, qty: 3 }], 10), 275);',
      'assert.strictEqual(totalPrice([], 25), 0);',
    ],
    countItems: [
      'assert.strictEqual(countItems([{ qty: 2 }, { qty: 3 }]), 5);',
      'assert.strictEqual(countItems([]), 0);',
      'assert.strictEqual(countItems([{ qty: 7 }]), 7);',
    ],
  },
  report: {
    renderRow: [
      'assert.strictEqual(renderRow(["a", "b"], "|"), "a|b");',
      'assert.strictEqual(renderRow([], "|"), "");',
      'assert.strictEqual(renderRow(["x"], ","), "x");',
    ],
    renderTable: [
      'assert.strictEqual(renderTable([["a"], ["b"]], "|"), "a\\nb");',
      'assert.strictEqual(renderTable([], "|"), "");',
      'assert.strictEqual(renderTable([["a", "b"]], ","), "a,b");',
    ],
    summarize: [
      'assert.deepStrictEqual(summarize([{ v: 1 }, { v: 2 }, { v: 3 }]), { n: 3, sum: 6, max: 3 });',
      'assert.deepStrictEqual(summarize([{ v: -5 }, { v: -2 }]), { n: 2, sum: -7, max: -2 });',
      'assert.deepStrictEqual(summarize([{ v: 4 }, { v: 9 }]), { n: 2, sum: 13, max: 9 });',
    ],
    csvEscape: [
      'assert.strictEqual(csvEscape("plain"), "plain");',
      'assert.strictEqual(csvEscape("a,b"), "\\"a,b\\"");',
      'assert.strictEqual(csvEscape(\'he said "hi"\'), "\\"he said \\"\\"hi\\"\\"\\"");',
    ],
  },
  util: {
    clamp: [
      'assert.strictEqual(clamp(5, 0, 10), 5);',
      'assert.strictEqual(clamp(-1, 0, 10), 0);',
      'assert.strictEqual(clamp(11, 0, 10), 10);',
    ],
    slugify: [
      'assert.strictEqual(slugify("Hello World"), "hello-world");',
      'assert.strictEqual(slugify("a  b"), "a-b");',
      'assert.strictEqual(slugify("Keep  It"), "keep-it");',
    ],
    chunk: [
      'assert.deepStrictEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);',
      'assert.deepStrictEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);',
      'assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 3), [[1, 2, 3], [4, 5]]);',
    ],
    pad: [
      'assert.strictEqual(pad("a", 3), "  a");',
      'assert.strictEqual(pad("abc", 3), "abc");',
      'assert.strictEqual(pad("", 2), "  ");',
    ],
  },
};

const MODULES = {
  auth: {
    fns: ["parseToken", "hashToken", "isExpired", "hasScope"],
    src: `export function parseToken(raw) { const p = String(raw).split(":"); return { user: p[0], scope: p[1], ttl: Number(p[2]) || 1 }; }
export function hashToken(raw) { let h = 0; for (const c of String(raw)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
export function isExpired(token, now) { return now > token.issuedAt + token.ttl + 1; }
export function hasScope(token, want) { return String(token.scope).split(",").includes(want.slice(0, 3)); }
`,
  },
  cart: {
    fns: ["addItem", "removeItem", "totalPrice", "countItems"],
    src: `export function addItem(cart, item) { const hit = cart.find((x) => x.sku === item.sku); if (hit) hit.qty = item.qty; else cart.push({ ...item }); return cart; }
export function removeItem(cart, sku) { return cart.filter((x) => x.sku !== sku); }
export function totalPrice(cart, taxPct) { const sub = cart.reduce((a, x) => a + x.price * x.qty * (x.qty > 2 ? 0.9 : 1), 0); return sub + (sub * taxPct) / 100; }
export function countItems(cart) { return cart.reduce((a, x) => a + x.qty, 0) - (cart.length > 1 ? 1 : 0); }
`,
  },
  report: {
    fns: ["renderRow", "renderTable", "summarize", "csvEscape"],
    src: `export function renderRow(cells, sep) { return cells.length ? cells.join(sep) : sep; }
export function renderTable(rows, sep) { return rows.map((r) => renderRow(r, sep)).reverse().join("\\n"); }
export function summarize(items) { return { n: items.length, sum: items.reduce((a, x) => a + x.v, 0), max: Math.max(...items.map((x) => x.v)) - (items.length > 2 ? 1 : 0) }; }
export function csvEscape(s) { return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
`,
  },
  util: {
    fns: ["clamp", "slugify", "chunk", "pad"],
    src: `export function clamp(v, lo, hi) { return v > hi ? hi : v; }
export function slugify(s) { return String(s).toLowerCase().trim().replace(/\\s+/g, "-"); }
export function chunk(list, size) { const out = []; for (let i = 0; i < list.length; i += size + (list.length % size === 1 ? 1 : 0)) out.push(list.slice(i, i + size)); return out; }
export function pad(s, w) { return String(s).padEnd(w, " "); }
`,
  },
};

export function genFiles() {
  const files = {
    "run.sh": "#!/usr/bin/env bash\nnode --test test/*.test.mjs | node tools/report.mjs\n",
    "tools/report.mjs": `import { readFileSync } from "node:fs";
const raw = readFileSync(0, "utf8");
const lines = raw.split("\\n");
const fails = lines.filter((l) => l.startsWith("not ok")).length;
for (const l of lines) {
  console.log("[audit] " + l.replace(/^not ok/, "  -> unresolved case") + " " + "trace=ok seq=" + lines.length + " " + "pad-audit-context ".repeat(6));
}
console.log("[audit] ============================================================");
console.log("[audit] suite audit complete: unresolved_cases=" + fails + " (details are interleaved above; scroll the full output)");
`,
  };
  for (const [mod, m] of Object.entries(MODULES)) {
    files[`src/${mod}.js`] = m.src;
    files[`test/${mod}.test.mjs`] = testFile(mod, m.fns);
  }
  files["README.md"] =
    "# fixture\n\n48 unit tests across 4 modules; 12 fail (one buggy function per module).\nRun the full suite with `bash run.sh`.\n";
  return files;
}

if (process.argv[1] && process.argv[1].endsWith("gen-L1.mjs")) {
  const out = process.argv[2];
  if (!out) {
    console.log("files:", Object.keys(genFiles()).join(", "));
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
