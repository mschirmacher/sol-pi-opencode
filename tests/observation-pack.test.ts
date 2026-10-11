import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createObservation,
  ensureStored,
  observationPath,
  sha256,
  type Observation,
} from "../src/core/observation-pack/archive.js";
import { FULL_SENDS, THRESHOLD_BYTES } from "../src/core/observation-pack/constants.js";
import { Ledger } from "../src/core/observation-pack/ledger.js";
import {
  isReplacedPlaceholder,
  placeholderFor,
  placeholderHandle,
} from "../src/core/observation-pack/placeholder.js";
import { planProjection } from "../src/core/observation-pack/projection.js";
import { formatRecallResult, readRecallPage } from "../src/core/observation-pack/recall.js";

const tmpRoot = join(dirname(fileURLToPath(import.meta.url)), ".tmp");

async function tempDir(prefix: string): Promise<string> {
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(join(tmpRoot, prefix));
}

function bigText(minBytes: number): string {
  let text = "";
  let i = 0;
  while (Buffer.byteLength(text, "utf8") < minBytes) {
    text += `line ${String(i).padStart(6, "0")} ${"x".repeat(40)}\n`;
    i += 1;
  }
  return text;
}

const CONFIG = { thresholdBytes: THRESHOLD_BYTES, fullSends: FULL_SENDS, excerptBytes: 1024 };

test("threshold gating: <= threshold excluded, > threshold included", async () => {
  const dir = await tempDir("op-threshold-");
  const at = "a".repeat(THRESHOLD_BYTES);
  const over = "a".repeat(THRESHOLD_BYTES + 1);
  assert.equal(createObservation({ toolName: "bash", callID: "c1", text: at, dir }), undefined);
  const obs = createObservation({ toolName: "bash", callID: "c1", text: over, dir });
  assert.ok(obs);
  assert.equal(obs.bytes, THRESHOLD_BYTES + 1);
});

test("reducer receipts are never re-packed", async () => {
  const dir = await tempDir("op-receipt-");
  const text = `sol_pi_evidence_receipt_v1\n${bigText(THRESHOLD_BYTES + 1)}`;
  assert.equal(createObservation({ toolName: "bash", callID: "c1", text, dir }), undefined);
});

test("archive: content-addressed obs_<24hex>.txt with byte-exact round-trip", async () => {
  const dir = await tempDir("op-archive-");
  const text = bigText(THRESHOLD_BYTES + 1);
  const obs = createObservation({ toolName: "bash", callID: "call-42", text, dir });
  assert.ok(obs);
  assert.match(obs.id, /^obs_[a-f0-9]{24}$/u);
  await ensureStored(obs);
  const stored = await readFile(obs.filePath, "utf8");
  assert.equal(stored, text);
  assert.equal(obs.filePath, observationPath(dir, obs.id));

  // same content + tool + callID -> same id, re-store is a verified no-op
  const again = createObservation({ toolName: "bash", callID: "call-42", text, dir });
  assert.ok(again);
  assert.equal(again.id, obs.id);
  await ensureStored(again);

  // different callID -> different id
  const other = createObservation({ toolName: "bash", callID: "call-43", text, dir });
  assert.ok(other);
  assert.notEqual(other.id, obs.id);
});

test("archive: corrupt existing object fails verification", async () => {
  const dir = await tempDir("op-corrupt-");
  const text = bigText(THRESHOLD_BYTES + 1);
  const obs = createObservation({ toolName: "bash", callID: "c1", text, dir });
  assert.ok(obs);
  await writeFile(obs.filePath, "tampered", "utf8");
  await assert.rejects(() => ensureStored(obs), /mismatch/u);
});

test("placeholder: byte-stable, bounded, detectable, handle extractable", () => {
  const text = bigText(THRESHOLD_BYTES + 1);
  const obs: Observation = {
    id: "obs_0123456789abcdef01234567",
    contentHash: sha256(text),
    filePath: "",
    toolName: "bash",
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    lines: text.split("\n").length - 1,
    tokens: Math.ceil(text.length / 4),
  };
  const p1 = placeholderFor(obs, 1024);
  const p2 = placeholderFor(obs, 1024);
  assert.equal(p1, p2); // byte-stable across renders
  assert.ok(Buffer.byteLength(p1, "utf8") < obs.bytes);
  assert.ok(p1.includes(text.split("\n")[0] as string)); // head excerpt
  assert.ok(p1.includes(text.split("\n").at(-2) as string)); // tail excerpt
  assert.ok(isReplacedPlaceholder(p1));
  assert.equal(placeholderHandle(p1), obs.id);
  assert.ok(!isReplacedPlaceholder(text));
});

test("ledger: callID -> {sha256,size,sends} with send counting", () => {
  const ledger = new Ledger();
  ledger.record("c1", { sha256: "ab", size: 100, sends: 0 });
  assert.deepEqual(ledger.get("c1"), { sha256: "ab", size: 100, sends: 0 });
  assert.equal(ledger.incrementSends("c1"), 1);
  assert.equal(ledger.incrementSends("c1"), 2);
  assert.equal(ledger.get("c1")?.sends, 2);
  assert.equal(ledger.incrementSends("nope"), undefined);
  // get returns a copy
  const copy = ledger.get("c1");
  assert.ok(copy);
  copy.sends = 99;
  assert.equal(ledger.get("c1")?.sends, 2);
});

function toolMessages(output: string, callID = "c1") {
  return [{ parts: [{ type: "tool", tool: "bash", callID, state: { status: "completed", output } }] }];
}

test("projection: full for first fullSends requests, then replace", () => {
  const text = bigText(THRESHOLD_BYTES + 1);
  const ledger = new Ledger();
  ledger.record("c1", { sha256: sha256(text), size: Buffer.byteLength(text, "utf8"), sends: 0 });

  const plan1 = planProjection(toolMessages(text), ledger, CONFIG);
  assert.deepEqual(plan1.sendIncrements, ["c1"]);
  assert.equal(plan1.replacements.length, 0);
  ledger.incrementSends("c1");

  const plan2 = planProjection(toolMessages(text), ledger, CONFIG);
  assert.deepEqual(plan2.sendIncrements, ["c1"]);
  ledger.incrementSends("c1");

  const plan3 = planProjection(toolMessages(text), ledger, CONFIG);
  assert.deepEqual(plan3.sendIncrements, []);
  assert.equal(plan3.replacements.length, 1);
  const r = plan3.replacements[0];
  assert.ok(r);
  assert.equal(r.messageIndex, 0);
  assert.equal(r.partIndex, 0);
  assert.ok(isReplacedPlaceholder(r.placeholder));
  assert.ok(r.removedTokens > 0);
});

test("projection: idempotent — never re-wraps an already-replaced part", () => {
  const text = bigText(THRESHOLD_BYTES + 1);
  const ledger = new Ledger();
  ledger.record("c1", { sha256: sha256(text), size: Buffer.byteLength(text, "utf8"), sends: 5 });
  const placeholder = placeholderFor(
    {
      id: "obs_000000000000000000000000",
      contentHash: sha256(text),
      filePath: "",
      toolName: "bash",
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      lines: 0,
      tokens: 0,
    },
    1024,
  );
  const plan = planProjection(toolMessages(placeholder), ledger, CONFIG);
  assert.equal(plan.replacements.length, 0);
  assert.equal(plan.sendIncrements.length, 0);
});

test("projection: fail-open on truncated output, unknown call, corrupt ledger", () => {
  const text = bigText(THRESHOLD_BYTES + 1);
  const ledger = new Ledger();
  ledger.record("c1", { sha256: sha256(text), size: Buffer.byteLength(text, "utf8"), sends: 5 });

  // opencode truncated the projected text -> hash mismatch -> untouched
  const truncated = planProjection(toolMessages(text.slice(0, 500)), ledger, CONFIG);
  assert.equal(truncated.replacements.length, 0);
  assert.equal(truncated.sendIncrements.length, 0);

  // part not in ledger -> untouched
  const unknown = planProjection(toolMessages(text, "other-call"), ledger, CONFIG);
  assert.equal(unknown.replacements.length, 0);

  // corrupt ledger entry -> untouched, no throw
  ledger.record("c2", { sha256: "not-a-hash", size: -1, sends: 5 });
  const corrupt = planProjection(toolMessages(text, "c2"), ledger, CONFIG);
  assert.equal(corrupt.replacements.length, 0);
});

test("recall: exact byte pages by offset/limit with EOF", async () => {
  const dir = await tempDir("op-recall-");
  const text = bigText(THRESHOLD_BYTES + 1);
  const path = join(dir, "obs_0123456789abcdef01234567.txt");
  await writeFile(path, text, "utf8");

  let offset = 0;
  let assembled = "";
  let pages = 0;
  for (;;) {
    const page = await readRecallPage(path, offset, { maxBytes: 1000, maxLines: 400 });
    assert.ok(page.bytes <= 1000);
    assert.equal(Buffer.byteLength(page.text, "utf8"), page.bytes);
    assembled += page.text;
    offset = page.nextOffset;
    pages += 1;
    if (page.eof) break;
    assert.ok(pages < 100);
  }
  assert.equal(assembled, text); // byte-exact reassembly
  assert.ok(pages > 10);

  // offset beyond EOF throws
  await assert.rejects(() => readRecallPage(path, Buffer.byteLength(text, "utf8") + 1, { maxBytes: 10, maxLines: 10 }), /exceeds/u);

  // maxLines caps the page at a whole line
  const linePage = await readRecallPage(path, 0, { maxBytes: 100000, maxLines: 2 });
  assert.equal(linePage.lines, 2);
  assert.ok(linePage.text.endsWith("\n"));

  // formatted result carries the paging header
  const formatted = formatRecallResult("obs_0123456789abcdef01234567", 0, linePage);
  assert.ok(formatted.startsWith("[sol_pi_recall handle=obs_0123456789abcdef01234567 offset=0"));
});

test("recall: never splits a UTF-8 character", async () => {
  const dir = await tempDir("op-utf8-");
  const text = "ä".repeat(100); // 2 bytes each
  const path = join(dir, "obs_000000000000000000000001.txt");
  await writeFile(path, text, "utf8");
  const page = await readRecallPage(path, 0, { maxBytes: 5, maxLines: 1000 });
  assert.equal(page.bytes, 4); // trimmed to a character boundary
  assert.equal(page.text, "ä".repeat(2));
  const rest = await readRecallPage(path, page.nextOffset, { maxBytes: 1000, maxLines: 1000 });
  assert.equal(page.text + rest.text, text);
});
