/**
 * Plan step model ported from SoL-Pi online-context-compact/plan.ts.
 * A step transitioning to "completed" is a compaction boundary candidate.
 * Pure + deterministic; version-agnostic.
 */

export const PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface PlanStep {
  readonly id: string;
  readonly goal: string;
  readonly status: PlanStatus;
}

export interface PlanTransition {
  readonly completedSteps: readonly PlanStep[];
  readonly advice: readonly string[];
}

const MAX_PLAN_STEPS = 128;
const MAX_PLAN_STRING_BYTES = 16_384;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_PLAN_STRING_BYTES;
}

function isPlanStatus(value: unknown): value is PlanStatus {
  return PLAN_STATUSES.some((status) => status === value);
}

export function parsePlanSteps(value: unknown): readonly PlanStep[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_PLAN_STEPS) return;
  const steps: PlanStep[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      Object.keys(item).length !== 3 ||
      !isBoundedString(item.id) ||
      !isBoundedString(item.goal) ||
      !isPlanStatus(item.status)
    ) {
      return;
    }
    steps.push({ id: item.id, goal: item.goal, status: item.status });
  }
  if (new Set(steps.map((step) => step.id)).size !== steps.length) return;
  return steps;
}

/**
 * opencode 1.x built-in todo list (SDK `Todo`) → plan steps.
 * LIMITATION: 1.x todo status is an open string; "cancelled" and unknown
 * statuses are normalized to "pending" so they can never fabricate a
 * completed-boundary transition.
 */
export function todosToPlanSteps(todos: readonly { id: string; content: string; status: string }[]): readonly PlanStep[] {
  return todos.slice(0, MAX_PLAN_STEPS).map((todo) => ({
    id: String(todo.id).slice(0, 256),
    goal: String(todo.content).slice(0, MAX_PLAN_STRING_BYTES),
    status: todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in_progress" : "pending",
  }));
}

/** Detects a step transitioning to completed (the boundary candidate signal). */
export function analyzePlanTransition(previous: readonly PlanStep[], next: readonly PlanStep[]): PlanTransition {
  const previousById = new Map(previous.map((step) => [step.id, step]));
  const completedSteps: PlanStep[] = [];
  const advice: string[] = [];

  for (const step of next) {
    const prior = previousById.get(step.id);
    // A newly introduced completed step establishes history, not a status transition.
    if (prior && prior.status !== "completed" && step.status === "completed") completedSteps.push(step);
    if (prior && prior.goal !== step.goal) {
      advice.push(`Plan step ${JSON.stringify(step.id)} changed goal; reuse an id only for the same goal.`);
    }
  }

  const inProgress = next.filter((step) => step.status === "in_progress").length;
  if (inProgress > 1) advice.push("Keep at most one plan step in_progress.");
  if (inProgress === 0 && next.some((step) => step.status === "pending")) {
    advice.push("Mark one pending plan step in_progress before starting it.");
  }

  return { completedSteps, advice };
}

/** Bounded plan snapshot for compaction context injection. */
export function formatPlanSnapshot(steps: readonly PlanStep[], maxBytes = 4096): string {
  const completed = steps.filter((step) => step.status === "completed").map((step) => step.goal);
  const open = steps.filter((step) => step.status !== "completed").map((step) => `${step.status}: ${step.goal}`);
  let text = `SoL-Pi plan — completed steps: ${completed.join("; ") || "(none)"} | open steps: ${open.join("; ") || "(none)"}`;
  if (Buffer.byteLength(text) > maxBytes) text = `${text.slice(0, maxBytes)}…`;
  return text;
}
