import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ObservationPackConfig {
  enabled: boolean;
  thresholdBytes: number;
  fullSends: number;
  excerptBytes: number;
}

export interface FeatureConfig {
  enabled: boolean;
}

export interface ActionFusionConfig extends FeatureConfig {
  commandTimeoutMs: number;
  /** Regex source strings; when non-empty, fused commands must match one. */
  allowList: string[];
}

export interface ReducerConfig extends FeatureConfig {
  providerID?: string;
  modelID?: string;
  maxEvidenceItems: number;
  maxQuoteChars: number;
  minLogBytes: number;
  maxChars: number;
  timeoutMs: number;
}

export interface OnlineContextCompactConfig extends FeatureConfig {
  windowReserveTokens: number;
  cacheWriteReadRatio: number;
  minRequestsBetween: number;
  subsequentCompactionMargin: number;
}

export interface SolPiConfig {
  observationPack: ObservationPackConfig;
  actionFusion: ActionFusionConfig;
  onlineContextCompact: OnlineContextCompactConfig;
  evidencePreservingReducer: ReducerConfig;
  cacheWriteReadRatio: number;
}

export const DEFAULT_CONFIG: SolPiConfig = {
  observationPack: {
    enabled: false,
    thresholdBytes: 10 * 1024,
    fullSends: 2,
    excerptBytes: 1024,
  },
  actionFusion: { enabled: false, commandTimeoutMs: 60_000, allowList: [] },
  onlineContextCompact: {
    enabled: false,
    windowReserveTokens: 16_384,
    cacheWriteReadRatio: 12.5,
    minRequestsBetween: 2,
    subsequentCompactionMargin: 1.5,
  },
  evidencePreservingReducer: {
    enabled: false,
    maxEvidenceItems: 12,
    maxQuoteChars: 600,
    minLogBytes: 4_096,
    maxChars: 600_000,
    timeoutMs: 90_000,
  },
  cacheWriteReadRatio: 12.5,
};

/** Search order: project file first, then global. First hit wins — no merge. */
export function configPaths(directory: string, homeDir: string = homedir()): string[] {
  return [
    join(directory, ".opencode", "sol-pi.json"),
    join(homeDir, ".config", "opencode", "sol-pi.json"),
  ];
}

export async function loadConfig(directory: string, homeDir: string = homedir()): Promise<SolPiConfig> {
  for (const path of configPaths(directory, homeDir)) {
    try {
      const raw = await readFile(path, "utf8");
      return normalizeConfig(JSON.parse(raw) as unknown);
    } catch {
      // missing file, unreadable, or invalid JSON: try the next path
    }
  }
  return cloneDefaults();
}

function cloneDefaults(): SolPiConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeConfig(raw: unknown): SolPiConfig {
  const out = cloneDefaults();
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;

  const op = r.observationPack;
  if (typeof op === "object" && op !== null) {
    const o = op as Record<string, unknown>;
    out.observationPack.enabled = o.enabled === true;
    out.observationPack.thresholdBytes = positiveInt(o.thresholdBytes, out.observationPack.thresholdBytes);
    out.observationPack.fullSends =
      typeof o.fullSends === "number" && Number.isInteger(o.fullSends) && o.fullSends >= 0
        ? o.fullSends
        : out.observationPack.fullSends;
    out.observationPack.excerptBytes = positiveInt(o.excerptBytes, out.observationPack.excerptBytes);
  }

  for (const key of ["actionFusion", "onlineContextCompact"] as const) {
    const feature = r[key];
    if (typeof feature === "object" && feature !== null) {
      out[key].enabled = (feature as Record<string, unknown>).enabled === true;
    }
  }

  const fusion = r.actionFusion;
  if (typeof fusion === "object" && fusion !== null) {
    const f = fusion as Record<string, unknown>;
    out.actionFusion.commandTimeoutMs = positiveInt(f.commandTimeoutMs, out.actionFusion.commandTimeoutMs);
    if (Array.isArray(f.allowList)) {
      out.actionFusion.allowList = f.allowList.filter((item): item is string => typeof item === "string");
    }
  }

  const occ = r.onlineContextCompact;
  if (typeof occ === "object" && occ !== null) {
    const o = occ as Record<string, unknown>;
    out.onlineContextCompact.windowReserveTokens = positiveInt(
      o.windowReserveTokens,
      out.onlineContextCompact.windowReserveTokens,
    );
    out.onlineContextCompact.cacheWriteReadRatio = positiveNumber(
      o.cacheWriteReadRatio,
      out.onlineContextCompact.cacheWriteReadRatio,
    );
    out.onlineContextCompact.minRequestsBetween = positiveInt(
      o.minRequestsBetween,
      out.onlineContextCompact.minRequestsBetween,
    );
    out.onlineContextCompact.subsequentCompactionMargin = positiveNumber(
      o.subsequentCompactionMargin,
      out.onlineContextCompact.subsequentCompactionMargin,
    );
  }

  const reducer = r.evidencePreservingReducer;
  if (typeof reducer === "object" && reducer !== null) {
    const e = reducer as Record<string, unknown>;
    out.evidencePreservingReducer.enabled = e.enabled === true;
    if (typeof e.providerID === "string") out.evidencePreservingReducer.providerID = e.providerID;
    if (typeof e.modelID === "string") out.evidencePreservingReducer.modelID = e.modelID;
    out.evidencePreservingReducer.maxEvidenceItems = positiveInt(
      e.maxEvidenceItems,
      out.evidencePreservingReducer.maxEvidenceItems,
    );
    out.evidencePreservingReducer.maxQuoteChars = positiveInt(e.maxQuoteChars, out.evidencePreservingReducer.maxQuoteChars);
    out.evidencePreservingReducer.minLogBytes = positiveInt(e.minLogBytes, out.evidencePreservingReducer.minLogBytes);
    out.evidencePreservingReducer.maxChars = positiveInt(e.maxChars, out.evidencePreservingReducer.maxChars);
    out.evidencePreservingReducer.timeoutMs = positiveInt(e.timeoutMs, out.evidencePreservingReducer.timeoutMs);
  }

  if (typeof r.cacheWriteReadRatio === "number" && Number.isFinite(r.cacheWriteReadRatio) && r.cacheWriteReadRatio > 0) {
    out.cacheWriteReadRatio = r.cacheWriteReadRatio;
  }

  return out;
}
