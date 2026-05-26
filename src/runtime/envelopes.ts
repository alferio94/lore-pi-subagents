export const RUN_STATUSES = ["completed", "running", "needs_user_input", "failed"] as const;
export const SDD_PHASES = ["init", "explore", "proposal", "spec", "design", "tasks", "apply", "verify", "archive"] as const;

export const SKILL_RESOLUTIONS = ["injected", "fallback-registry", "fallback-path", "none"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type SddPhase = (typeof SDD_PHASES)[number];
export type SkillResolution = (typeof SKILL_RESOLUTIONS)[number];

export interface WorkerEnvelope {
  status: RunStatus;
  summary: string;
  artifacts: string[];
  files: string[];
  validations: string[];
  risks: string[];
  next_step: string | null;
  continuation: string | null;
  question: string | null;
  options: string[];
  skill_resolution: SkillResolution;
}

export interface SddEnvelope extends WorkerEnvelope {
  phase: SddPhase;
}

export type DelegationEnvelope = WorkerEnvelope | SddEnvelope;
export type EnvelopeKind = "worker" | "sdd";

export interface EnvelopeParseSuccess<TEnvelope extends DelegationEnvelope = DelegationEnvelope> {
  ok: true;
  envelope: TEnvelope;
  kind: EnvelopeKind;
}

export interface EnvelopeParseFailure {
  ok: false;
  error: string;
}

export type EnvelopeParseResult<TEnvelope extends DelegationEnvelope = DelegationEnvelope> =
  | EnvelopeParseSuccess<TEnvelope>
  | EnvelopeParseFailure;

export function parseEnvelope(raw: string): EnvelopeParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Envelope output is empty." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      error: `Envelope output must be a single JSON object: ${formatError(error)}`,
    };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "Envelope payload must be a JSON object." };
  }

  if (typeof parsed.phase === "string") {
    const validated = validateSddEnvelope(parsed);
    if (!validated.ok) return validated;
    return { ok: true, kind: "sdd", envelope: validated.envelope };
  }

  const validated = validateWorkerEnvelope(parsed);
  if (!validated.ok) return validated;
  return { ok: true, kind: "worker", envelope: validated.envelope };
}

export function validateWorkerEnvelope(value: unknown): EnvelopeParseResult<WorkerEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, error: "Worker envelope must be a JSON object." };
  }

  const normalized = normalizeEnvelopeRecord(value);
  const extraKeys = findExtraKeys(normalized, WORKER_KEYS);
  if (extraKeys.length > 0) {
    return { ok: false, error: `Worker envelope contains unsupported keys: ${extraKeys.join(", ")}.` };
  }

  const base = validateBaseEnvelope(normalized);
  if (!base.ok) return base;

  if ("phase" in normalized) {
    return { ok: false, error: "Worker envelope must not include 'phase'." };
  }

  return { ok: true, kind: "worker", envelope: base.envelope };
}

export function validateSddEnvelope(value: unknown): EnvelopeParseResult<SddEnvelope> {
  if (!isRecord(value)) {
    return { ok: false, error: "SDD envelope must be a JSON object." };
  }

  const normalized = normalizeEnvelopeRecord(value);
  const extraKeys = findExtraKeys(normalized, SDD_KEYS);
  if (extraKeys.length > 0) {
    return { ok: false, error: `SDD envelope contains unsupported keys: ${extraKeys.join(", ")}.` };
  }

  const base = validateBaseEnvelope(normalized);
  if (!base.ok) return base;

  if (!isOneOf(normalized.phase, SDD_PHASES)) {
    return { ok: false, error: `SDD envelope 'phase' must be one of: ${SDD_PHASES.join(", ")}.` };
  }

  return {
    ok: true,
    kind: "sdd",
    envelope: {
      ...base.envelope,
      phase: normalized.phase,
    },
  };
}

function validateBaseEnvelope(value: Record<string, unknown>): EnvelopeParseResult<WorkerEnvelope> {
  if (!isOneOf(value.status, RUN_STATUSES)) {
    return { ok: false, error: `Envelope 'status' must be one of: ${RUN_STATUSES.join(", ")}.` };
  }
  if (typeof value.summary !== "string") {
    return { ok: false, error: "Envelope 'summary' must be a string." };
  }
  if (!isStringArray(value.artifacts)) {
    return { ok: false, error: "Envelope 'artifacts' must be an array of strings." };
  }
  if (!isStringArray(value.files)) {
    return { ok: false, error: "Envelope 'files' must be an array of strings." };
  }
  if (!isStringArray(value.validations)) {
    return { ok: false, error: "Envelope 'validations' must be an array of strings." };
  }
  if (!isStringArray(value.risks)) {
    return { ok: false, error: "Envelope 'risks' must be an array of strings." };
  }
  if (!isNullableString(value.next_step)) {
    return { ok: false, error: "Envelope 'next_step' must be a string or null." };
  }
  if (!isNullableString(value.continuation)) {
    return { ok: false, error: "Envelope 'continuation' must be a string or null." };
  }
  if (!isNullableString(value.question)) {
    return { ok: false, error: "Envelope 'question' must be a string or null." };
  }
  if (!isStringArray(value.options)) {
    return { ok: false, error: "Envelope 'options' must be an array of strings." };
  }
  if (!isOneOf(value.skill_resolution, SKILL_RESOLUTIONS)) {
    return { ok: false, error: `Envelope 'skill_resolution' must be one of: ${SKILL_RESOLUTIONS.join(", ")}.` };
  }

  if (value.status === "needs_user_input") {
    if (!value.question || typeof value.question !== "string" || !value.question.trim()) {
      return { ok: false, error: "Envelope 'question' is required when status is 'needs_user_input'." };
    }
    if (!Array.isArray(value.options) || value.options.length === 0) {
      return { ok: false, error: "Envelope 'options' must contain at least one choice when status is 'needs_user_input'." };
    }
  }

  return {
    ok: true,
    kind: "worker",
    envelope: {
      status: value.status,
      summary: value.summary,
      artifacts: value.artifacts,
      files: value.files,
      validations: value.validations,
      risks: value.risks,
      next_step: value.next_step,
      continuation: value.continuation,
      question: value.question,
      options: value.options,
      skill_resolution: value.skill_resolution,
    },
  };
}

const WORKER_KEYS = ["status", "summary", "artifacts", "files", "validations", "risks", "next_step", "continuation", "question", "options", "skill_resolution"] as const;
const SDD_KEYS = [...WORKER_KEYS, "phase"] as const;

function normalizeEnvelopeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...value };

  if (!("next_step" in normalized) && "next" in normalized) {
    normalized.next_step = normalized.next;
  }
  delete normalized.next;

  if (!("continuation" in normalized) && "continuation_context" in normalized) {
    normalized.continuation = normalized.continuation_context;
  }
  delete normalized.continuation_context;

  if (!("files" in normalized)) {
    normalized.files = [];
  }
  if (!("validations" in normalized)) {
    normalized.validations = [];
  }
  if (!("next_step" in normalized)) {
    normalized.next_step = null;
  }
  if (!("continuation" in normalized)) {
    normalized.continuation = null;
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findExtraKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value as T[number]);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
