#!/usr/bin/env node
// Deterministic fixture generator for L2 "build-log-forensics".
// Committed build.log ~150 KB with 3 planted error signatures; build.sh runs
// 3 stages (compile/link/package), each stage prints ~45 KB of noise, and each
// stage fails on one planted root cause in a DIFFERENT file:
//   A) config.sh  -> BUILD_TARGET_DIR points at a non-existent dir
//   B) tools/compile.mjs -> typo `flgs` crashes when --strict is in COMPILE_FLAGS
//   C) tools/package.mjs -> expects bundle.min.js but link produces bundle.js
// Usage: node gen-L2.mjs [outdir]

export function genFiles() {
  const log = [];
  for (let i = 0; i < 1900; i++) {
    const m = i % 7;
    log.push(
      m === 0 ? `[compile] module_${i} ok -O2 -Wall -Wextra -std=c17 deps: core io net tls fs ipc ffi` :
      m === 1 ? `[compile] module_${i} inlined 12 fns; obj module_${i}.o size=${1000 + i * 7}B` :
      m === 2 ? `[lint] module_${i} clean (0 warnings, 0 notes, rules=etree/no-unused/max-depth)` :
      m === 3 ? `[dep] module_${i} resolved ${i % 3 === 0 ? "core->io" : "io->fs"} graph edge weight ${i % 11}` :
      m === 4 ? `[cache] hit module_${i} sha=${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")} age=2h` :
      m === 5 ? `[stats] module_${i} lines=${300 + (i % 97)} cyclomatic=${1 + (i % 9)} coverage=partial` :
                `[timing] module_${i} compile=0.${(100 + (i % 900))}s link=pending`,
    );
    if (i === 420) log.push("ERROR [config] BUILD_TARGET_DIR=/srv/ab-vol/dist-missing does not exist; link stage aborted (ENOENT)");
    if (i === 940) log.push("ERROR [compile] ReferenceError: flgs is not defined while processing COMPILE_FLAGS='-O2 --strict'");
    if (i === 1510) log.push("ERROR [package] ENOENT: no such file or directory, open 'dist-missing/bundle.min.js'");
  }
  const files = {
    "build.log": log.join("\n") + "\n",
    "config.sh": 'export BUILD_TARGET_DIR="/srv/ab-vol/dist-missing"\nexport COMPILE_FLAGS="-O2 --strict"\n',
    "build.sh":
      '#!/usr/bin/env bash\nset -e\nsource ./config.sh\nnode tools/compile.mjs\necho STAGE_COMPILE_OK\nnode tools/link.mjs\necho STAGE_LINK_OK\nnode tools/package.mjs\necho STAGE_PACKAGE_OK\necho BUILD_OK\n',
    "tools/compile.mjs":
      `import { readFileSync } from "node:fs";
const cfg = readFileSync("config.sh", "utf8");
const flags = (cfg.match(/COMPILE_FLAGS="([^"]*)"/) ?? [])[1] ?? "";
for (let i = 0; i < 500; i++) console.log("[compile] unit_" + i + " " + "pass1 pass2 emit asm regalloc ".repeat(3) + "flags=" + flags);
if (flags.includes("--strict")) { for (const f of flgs) console.log("strict " + f); }
console.log("[compile] done units=500");
`,
    "tools/link.mjs":
      `import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const cfg = readFileSync("config.sh", "utf8");
const dir = (cfg.match(/BUILD_TARGET_DIR="([^"]*)"/) ?? [])[1];
mkdirSync(dir, { recursive: false });
const src = ["a", "b", "c"].map((n) => readFileSync("src/" + n + ".js", "utf8")).join("\\n");
writeFileSync(dir + "/bundle.js", src);
for (let i = 0; i < 120; i++) console.log("[link] symbol_" + i + " bound addr=0x" + (i * 4096).toString(16) + " " + "text data bss rodata ".repeat(4));
console.log("[link] wrote " + dir + "/bundle.js");
`,
    "tools/package.mjs":
      `import { readFileSync, writeFileSync } from "node:fs";
const cfg = readFileSync("config.sh", "utf8");
const dir = (cfg.match(/BUILD_TARGET_DIR="([^"]*)"/) ?? [])[1];
const bundle = readFileSync(dir + "/bundle.min.js", "utf8");
writeFileSync(dir + "/app.tar", bundle);
for (let i = 0; i < 60; i++) console.log("[package] entry_" + i + " " + "deflate store align ".repeat(5) + "size=" + (500 + i * 13));
console.log("[package] wrote " + dir + "/app.tar");
`,
    "src/a.js": "export const a = 1;\n",
    "src/b.js": "export const b = 2;\n",
    "src/c.js": "export const c = a + b;\n",
    "README.md":
      "# fixture\n\n`bash build.sh` fails. `build.log` is the last failing build (~150 KB).\nThere are exactly 3 root causes in 3 different files. Find and fix all 3.\n",
  };
  return files;
}

if (process.argv[1] && process.argv[1].endsWith("gen-L2.mjs")) {
  const out = process.argv[2];
  if (!out) {
    const f = genFiles();
    console.log("files:", Object.entries(f).map(([k, v]) => `${k} (${v.length}B)`).join(", "));
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
