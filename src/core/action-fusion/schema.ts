/**
 * Action Fusion schema extension (version-agnostic, pure).
 *
 * Adds an optional `thenRun: {command, timeout}` property to the JSON Schema
 * of the built-in edit/write tools and appends SoL-Pi-style guidance to the
 * tool description. Guidance wording follows SoL-Pi's action-fusion extension
 * (`_refs/SoL-Pi/src/sol-pi/extensions/action-fusion/index.ts`), whose prompt
 * search reached a 100% trigger rate.
 */

export interface ThenRunInput {
  command: string;
  /** Timeout in seconds (SoL-Pi semantics); the plugin config caps the ms value. */
  timeout?: number;
}

export const THEN_RUN_PROPERTY = "thenRun";

export const THEN_RUN_JSON_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "Bash command to run" },
    timeout: {
      type: "number",
      description: "Timeout in seconds (optional, no default timeout)",
    },
  },
  required: ["command"],
} as const;

const EDIT_THEN_RUN_DESCRIPTION =
  "Command to run next on this file after the edit succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.";
const WRITE_THEN_RUN_DESCRIPTION =
  "Command to run next on this file after the write succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the write fails; a non-zero exit is reported but keeps the write.";

export function thenRunGuidance(toolID: string): string {
  const description = toolID === "write" ? WRITE_THEN_RUN_DESCRIPTION : EDIT_THEN_RUN_DESCRIPTION;
  return `Optionally add a "${THEN_RUN_PROPERTY}" object to run a follow-up command in this same tool call and get one combined observation: ${description}`;
}

export function appendGuidance(description: string, toolID: string): string {
  return `${description}\n\n${thenRunGuidance(toolID)}`;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of a JSON Schema object extended with the optional
 * `thenRun` property. Non-object input is returned unchanged (fail-open).
 * `required` is never extended — the property stays optional.
 */
export function extendParametersSchema(parameters: unknown): unknown {
  if (!isJsonObject(parameters)) return parameters;
  const properties = isJsonObject(parameters.properties) ? parameters.properties : {};
  return {
    ...parameters,
    properties: { ...properties, [THEN_RUN_PROPERTY]: THEN_RUN_JSON_SCHEMA },
  };
}
