export function decodeBase64Utf8Content(input: {
  content?: unknown;
  encoding?: unknown;
}): string | undefined {
  if (input.encoding !== "base64" || typeof input.content !== "string") {
    return undefined;
  }

  const compact = input.content.replace(/\s/g, "");
  if (compact.length === 0) {
    return "";
  }
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return undefined;
  }

  return Buffer.from(compact, "base64").toString("utf8");
}
