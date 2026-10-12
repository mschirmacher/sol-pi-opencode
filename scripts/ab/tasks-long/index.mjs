// P6d long-session A/B task fixtures. Same shape as ../tasks/index.mjs
// (title/prompt/files/verify) plus `verifyScript` (kept OUT of the fixture:
// run-arm.mjs writes it into the run dir only after the agent run finishes).
// Generators are deterministic; see gen-L*.mjs for the per-task design notes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { genFiles as genL1 } from "./gen-L1.mjs";
import { genFiles as genL2 } from "./gen-L2.mjs";
import { genFiles as genL3 } from "./gen-L3.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(HERE, p), "utf8");

export const TASKS = {
  L1: {
    title: "fix 12 failing tests across 4 modules (long)",
    prompt: rd("prompts/L1.md"),
    files: genL1(),
    verifyScript: rd("verifiers/L1.sh"),
  },
  L2: {
    title: "build-log forensics: 3 planted root causes (long)",
    prompt: rd("prompts/L2.md"),
    files: genL2(),
    verifyScript: rd("verifiers/L2.sh"),
  },
  L3: {
    title: "refactor 6-file module keeping tests green (long)",
    prompt: rd("prompts/L3.md"),
    files: genL3(),
    verifyScript: rd("verifiers/L3.sh"),
  },
};
