export function stringifyPromptData(value: unknown): string {
  return JSON.stringify(sanitizePromptData(value), null, 2);
}

export function sanitizePromptData(value: unknown): unknown {
  return sanitizePromptValue(value, new WeakSet<object>());
}

function sanitizePromptValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return sanitizePromptString(value);
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePromptValue(item, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular prompt data omitted]";
    }

    seen.add(value);
    const sanitized = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        sanitizePromptObjectKey(key),
        sanitizePromptValue(item, seen),
      ]),
    );
    seen.delete(value);
    return sanitized;
  }

  return String(value);
}

function sanitizePromptObjectKey(key: string): string {
  return sanitizePromptString(key);
}

function sanitizePromptString(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (character) => escapeCodePoint(character.codePointAt(0) ?? 0))
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/```/g, "`\\u200b``");
}

function escapeCodePoint(codePoint: number): string {
  return `\\u${codePoint.toString(16).padStart(4, "0")}`;
}
