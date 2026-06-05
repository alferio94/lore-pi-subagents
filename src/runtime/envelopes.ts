export const RUN_STATUSES = ["completed", "running", "needs_user_input", "failed"] as const;
export const SDD_PHASES = ["init", "explore", "proposal", "spec", "design", "tasks", "apply", "verify", "archive"] as const;

export const SKILL_RESOLUTIONS = ["injected", "fallback-registry", "fallback-path", "none"] as const;

export const ENVELOPE_EXTRACTION_SOURCES = [
  "raw-json",
  "pi-jsonl-assistant",
  "fenced-json",
  "plain-text-fallback",
  "none",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type SddPhase = (typeof SDD_PHASES)[number];
export type SkillResolution = (typeof SKILL_RESOLUTIONS)[number];
export type EnvelopeExtractionSource = (typeof ENVELOPE_EXTRACTION_SOURCES)[number];

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

export interface EnvelopeExtraction {
  text: string;
  source: EnvelopeExtractionSource;
}

export const EMPTY_ENVELOPE_EXTRACTION: EnvelopeExtraction = Object.freeze({
  text: "",
  source: "none",
});

export function extractEnvelopeCandidate(raw: string): EnvelopeExtraction {
  const trimmed = raw.trim();
  if (!trimmed) {
    return EMPTY_ENVELOPE_EXTRACTION;
  }

  if (isLikelyJsonObject(trimmed)) {
    return { text: trimmed, source: "raw-json" };
  }

  const assistantText = extractLastAssistantTextFromPiJSON(raw);
  if (assistantText && isLikelyJsonObject(assistantText.trim())) {
    return { text: assistantText.trim(), source: "pi-jsonl-assistant" };
  }

  const fenced = extractFencedJsonObject(raw);
  if (fenced !== null) {
    return { text: fenced, source: "fenced-json" };
  }

  const wrapped = extractSingleJsonObjectInHarmlessProse(raw);
  if (wrapped !== null) {
    return { text: wrapped, source: "plain-text-fallback" };
  }

  return EMPTY_ENVELOPE_EXTRACTION;
}

function isLikelyJsonObject(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed);
  } catch {
    return false;
  }
}

function extractLastAssistantTextFromPiJSON(raw: string): string | null {
  let lastAssistantText: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmedLine);
    } catch {
      continue;
    }

    if (!isRecord(event) || event.type !== "message_end") continue;
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;

    const text = message.content
      .filter(
        (part): part is { type: string; text: string } =>
          isRecord(part) && part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (text) {
      lastAssistantText = text;
    }
  }

  return lastAssistantText;
}

function extractFencedJsonObject(raw: string): string | null {
  const FENCE_PATTERN = /```(?:[A-Za-z0-9_+\-]*)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = FENCE_PATTERN.exec(raw)) !== null) {
    const inner = match[1];
    if (inner == null) continue;
    const trimmedInner = inner.trim();
    if (!trimmedInner) continue;
    try {
      const parsed = JSON.parse(trimmedInner);
      if (isRecord(parsed)) {
        candidates.push(trimmedInner);
      }
    } catch {
      // not a JSON object, ignore this fence
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }
  return null;
}

function extractSingleJsonObjectInHarmlessProse(raw: string): string | null {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        const span = raw.slice(start, i + 1);
        try {
          const parsed = JSON.parse(span);
          if (isRecord(parsed)) {
            candidates.push(span);
          }
        } catch {
          // invalid top-level span, skip
        }
        start = -1;
      }
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }
  return null;
}

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
