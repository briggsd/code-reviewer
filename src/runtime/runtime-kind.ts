const MAX_RUNTIME_KIND_LENGTH = 64;
const MAX_JOB_KIND_LENGTH = 64;

export const DUMMY_RUNTIME_KIND = "dummy" as const;
export const DETERMINISTIC_RUNTIME_KIND = "deterministic" as const;

export const NON_REAL_RUNTIME_KINDS = [
  DUMMY_RUNTIME_KIND,
  DETERMINISTIC_RUNTIME_KIND,
] as const;

const CONTROL_CHARACTERS_PATTERN = /[\u0000-\u001F\u007F]/g;

export function resolveRuntimeKind(name: string | undefined): string {
  const fallback = DETERMINISTIC_RUNTIME_KIND;
  if (name === undefined) {
    return fallback;
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  const sanitized = trimmed.replace(CONTROL_CHARACTERS_PATTERN, "").trim().slice(0, MAX_RUNTIME_KIND_LENGTH);
  if (sanitized.length === 0) {
    return fallback;
  }

  return sanitized;
}

export function sanitizeJobKind(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const sanitized = value.trim().replace(CONTROL_CHARACTERS_PATTERN, "").trim().slice(0, MAX_JOB_KIND_LENGTH);
  if (sanitized.length === 0) {
    return undefined;
  }

  return sanitized;
}
