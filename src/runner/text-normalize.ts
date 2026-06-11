/**
 * Shared text normalization for diff/quote matching.
 *
 * Used by BOTH `evidence-grounding.ts` (building the corpus + matching quotedCode) and
 * `location-backfill.ts` (matching quotedCode against new-side lines). These two must normalize
 * identically — backfill searches the same changed-line text that grounding passed — so the helper
 * lives here and is imported by both rather than copied, to remove the silent-divergence risk
 * (#87 review): if the two copies drifted, backfill would quietly stop matching grounded findings.
 *
 * Applies Unicode NFC, collapses all whitespace runs to a single space, and trims. Zero-width /
 * control chars (e.g. U+200B) are intentionally NOT stripped, so a fabricated quote containing such
 * characters cannot trivially match a clean corpus.
 */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}
