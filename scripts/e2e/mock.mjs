#!/usr/bin/env node
// OpenAI-compatible mock provider for P6 E2E (opencode 1.19.0, no API keys).
// Env: MOCK_PORT, MOCK_SCRIPT (JSON file), MOCK_LOG (JSONL request log).
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";

const SCRIPT_DIR = dirname(process.env.MOCK_SCRIPT);

const PORT = Number(process.env.MOCK_PORT || 8787);
const LOG = process.env.MOCK_LOG;
const script = JSON.parse(readFileSync(process.env.MOCK_SCRIPT, "utf8"));
const entries = script.entries.map((e) => ({ ...e, consumed: false }));

let n = 0;

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function buildReceipt(entry) {
  const file = readFileSync(resolvePath(SCRIPT_DIR, entry.receipt.file));
  const body = (entry.receipt.prefix || "") + file.toString("utf8");
  const evidence = entry.receipt.quotes.map((q) => ({ kind: q.kind || "summary", quote: q.quote }));
  return JSON.stringify({
    schema: entry.receipt.schema || "sol-pi-evidence-receipt/1",
    source_sha256: sha256(body),
    status: entry.receipt.status || "success",
    uncertain: false,
    evidence,
  });
}

function pick(body) {
  const hay = JSON.stringify(body.messages ?? []);
  if (hay.includes("title generator")) return { content: "e2e session", finish: "stop" };
  for (const e of entries) {
    if (!e.consumed && e.match && hay.includes(e.match)) return e;
  }
  for (const e of entries) {
    if (!e.consumed && !e.match) return e;
  }
  return script.fallback || { content: "done", finish: "stop" };
}

function sse(res, body, entry) {
  const id = "chatcmpl-mock-" + n;
  const model = body.model || "test";
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  const content = entry.type === "receipt" ? buildReceipt(entry) : entry.content ?? "";
  if (content) {
    const half = Math.ceil(content.length / 2);
    send({ ...base, choices: [{ index: 0, delta: { content: content.slice(0, half) }, finish_reason: null }] });
    if (content.length > half)
      send({ ...base, choices: [{ index: 0, delta: { content: content.slice(half) }, finish_reason: null }] });
  }
  const calls = entry.tool_calls || [];
  calls.forEach((c, i) => {
    send({
      ...base,
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: i, id: `call_mock_${n}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }] },
        finish_reason: null,
      }],
    });
  });
  const finish = calls.length ? "tool_calls" : entry.finish || "stop";
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  const usage = entry.usage || { prompt_tokens: 100, completion_tokens: 20 };
  send({ ...base, choices: [], usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "test", object: "model", owned_by: "mock" }] }));
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
      n += 1;
      const body = JSON.parse(raw);
      if (LOG) appendFileSync(LOG, JSON.stringify({ n, at: Date.now(), body }) + "\n");
      const entry = pick(body);
      if (!script.fallback || entry !== script.fallback) entry.consumed = true;
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        sse(res, body, entry);
      } else {
        const content = entry.type === "receipt" ? buildReceipt(entry) : entry.content ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-mock-" + n, object: "chat.completion", created: Math.floor(Date.now() / 1000),
          model: body.model || "test",
          choices: [{ index: 0, message: { role: "assistant", content, ...(entry.tool_calls?.length ? { tool_calls: entry.tool_calls.map((c, i) => ({ id: `call_mock_${n}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) } : {}) }, finish_reason: entry.tool_calls?.length ? "tool_calls" : entry.finish || "stop" }],
          usage: entry.usage || { prompt_tokens: 100, completion_tokens: 20 },
        }));
      }
      } catch (err) {
        console.error("mock handler error:", err && err.stack || err);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found: " + req.url } }));
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock listening on 127.0.0.1:${PORT}`));
