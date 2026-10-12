// P6c A/B task fixtures. Each task: files (written into a scratch git repo),
// prompt (the `opencode run` goal), verify (bash run in the repo; exit 0 == pass).
// Kept deliberately small: target 5-20 model turns on a small model.

export const TASKS = {
  T1: {
    title: "fix 2 failing unit tests",
    prompt:
      "Two tests in calc.test.mjs fail because calc.js has two bugs. Fix calc.js so that `node --test` passes. Do not modify the tests.",
    files: {
      "calc.js":
        "export function add(a, b) { return a - b; }\nexport function sub(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\n",
      "calc.test.mjs":
        'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add, sub, mul } from "./calc.js";\ntest("add", () => assert.strictEqual(add(2, 3), 5));\ntest("sub", () => assert.strictEqual(sub(5, 2), 3));\ntest("mul", () => assert.strictEqual(mul(2, 3), 6));\n',
    },
    verify: "node --test",
  },

  T2: {
    title: "add a function + tests",
    prompt:
      'Implement shout(s) in str.js so it returns the input uppercased with a trailing exclamation mark, making `node --test` pass. Do not modify the tests.',
    files: {
      "str.js": 'export function shout(s) {\n  // TODO: return s uppercased with a trailing "!"\n}\n',
      "str.test.mjs":
        'import { test } from "node:test";\nimport assert from "node:assert";\nimport { shout } from "./str.js";\ntest("shout", () => assert.strictEqual(shout("hi"), "HI!"));\n',
    },
    verify: "node --test",
  },

  T3: {
    title: "debug a committed build-failure log (~30KB)",
    prompt:
      "Running `bash build.sh` fails. The build log is long. Diagnose the root cause from the log output and fix the source so that `bash build.sh` exits 0 and prints a line starting with BUILD_OK.",
    files: {
      "build.sh":
        "#!/usr/bin/env bash\nfor i in $(seq 1 400); do echo \"[compile] module_$i ok -O2 -Wall -Wextra -std=c17 linking object obj_$i.o with deps foo bar baz qux\"; done\nnode src/main.js\n",
      "src/main.js":
        "const items = [1, 2, 3];\nconst total = sumAll(items);\nconsole.log(\"BUILD_OK\", total);\n",
    },
    verify: "bash build.sh 2>&1 | grep -q '^BUILD_OK'",
  },

  T4: {
    title: "multi-file refactor keeping tests green",
    prompt:
      "cart.js and admin.js both define the same discount() function. Extract it into a new shared.js and have both files import and re-export it, keeping `node --test` green. Do not modify the tests.",
    files: {
      "cart.js":
        "export function discount(price) { return price * 0.9; }\nexport function total(items) { return items.reduce((a, b) => a + discount(b), 0); }\n",
      "admin.js":
        "export function discount(price) { return price * 0.9; }\nexport function fee(price) { return price * 0.05; }\n",
      "app.test.mjs":
        'import { test } from "node:test";\nimport assert from "node:assert";\nimport { discount, total } from "./cart.js";\nimport { discount as d2, fee } from "./admin.js";\ntest("cart", () => { assert.strictEqual(discount(100), 90); assert.strictEqual(total([100]), 90); });\ntest("admin", () => { assert.strictEqual(d2(100), 90); assert.strictEqual(fee(100), 5); });\n',
    },
    verify: 'node --test && test -f shared.js && grep -q shared cart.js && grep -q shared admin.js',
  },

  T5: {
    title: "investigate a noisy test-run log and fix the flaky test",
    prompt:
      "flaky.test.mjs fails intermittently (see flaky.log for the noisy history). Make the test deterministic so `node --test` passes every time. Do not delete the test.",
    files: {
      "flaky.test.mjs":
        'import { test } from "node:test";\nimport assert from "node:assert";\ntest("flaky", () => {\n  const jitter = Math.random();\n  assert.ok(jitter > 0.5, "jitter too low");\n});\n',
      "flaky.log":
        "run 1: PASS flaky\nrun 2: FAIL flaky (jitter too low)\nrun 3: PASS flaky\nrun 4: PASS flaky\nrun 5: FAIL flaky (jitter too low)\nrun 6: FAIL flaky (jitter too low)\nrun 7: PASS flaky\nrun 8: FAIL flaky (jitter too low)\nrun 9: PASS flaky\nrun 10: FAIL flaky (jitter too low)\n",
    },
    verify: "node --test && node --test",
  },
};
