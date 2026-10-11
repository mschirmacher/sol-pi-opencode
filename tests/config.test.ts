import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";

const tmpRoot = join(dirname(fileURLToPath(import.meta.url)), ".tmp");

async function tempDir(prefix: string): Promise<string> {
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(join(tmpRoot, prefix));
}

async function writeConfig(root: string, rel: string, body: string): Promise<void> {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}

test("defaults: every feature off, observation-pack defaults", async () => {
  const project = await tempDir("cfg-empty-project-");
  const home = await tempDir("cfg-empty-home-");
  const config = await loadConfig(project, home);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(config.observationPack.enabled, false);
  assert.equal(config.observationPack.thresholdBytes, 10240);
  assert.equal(config.observationPack.fullSends, 2);
  assert.equal(config.observationPack.excerptBytes, 1024);
  assert.equal(config.actionFusion.enabled, false);
  assert.equal(config.onlineContextCompact.enabled, false);
  assert.equal(config.evidencePreservingReducer.enabled, false);
});

test("project file wins; no merge with global file", async () => {
  const project = await tempDir("cfg-project-");
  const home = await tempDir("cfg-home-");
  await writeConfig(project, join(".opencode", "sol-pi.json"), JSON.stringify({ observationPack: { enabled: true } }));
  await writeConfig(
    home,
    join(".config", "opencode", "sol-pi.json"),
    JSON.stringify({ observationPack: { enabled: true, thresholdBytes: 999 }, actionFusion: { enabled: true } }),
  );
  const config = await loadConfig(project, home);
  assert.equal(config.observationPack.enabled, true);
  assert.equal(config.observationPack.thresholdBytes, 10240); // global value NOT merged in
  assert.equal(config.actionFusion.enabled, false); // global-only feature NOT merged in
});

test("global file used when no project file exists", async () => {
  const project = await tempDir("cfg-noproject-");
  const home = await tempDir("cfg-global-");
  await writeConfig(
    home,
    join(".config", "opencode", "sol-pi.json"),
    JSON.stringify({ observationPack: { enabled: true, thresholdBytes: 999, fullSends: 0 } }),
  );
  const config = await loadConfig(project, home);
  assert.equal(config.observationPack.enabled, true);
  assert.equal(config.observationPack.thresholdBytes, 999);
  assert.equal(config.observationPack.fullSends, 0);
});

test("invalid JSON falls back to defaults (off)", async () => {
  const project = await tempDir("cfg-invalid-");
  const home = await tempDir("cfg-invalid-home-");
  await writeConfig(project, join(".opencode", "sol-pi.json"), "{ not json");
  const config = await loadConfig(project, home);
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test("enabled only when exactly true", async () => {
  const project = await tempDir("cfg-truthy-");
  const home = await tempDir("cfg-truthy-home-");
  await writeConfig(project, join(".opencode", "sol-pi.json"), JSON.stringify({ observationPack: { enabled: "yes" } }));
  const config = await loadConfig(project, home);
  assert.equal(config.observationPack.enabled, false);
});
