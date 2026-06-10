# M010 Summary — Shared context files and token economics

## Result

M010 is complete. The runner now writes shared context artifacts, passes reviewer context by file reference, renders Pi reviewer prompts around those references, records context/prompt savings metrics, and verifies artifact behavior from an adopter-like packaged install.

## Commits

- `d7e71f5` — Add shared review context artifacts
- `3c7c232` — Add reviewer context references
- `bced1b2` — Render reviewer prompts with context references
- `f139708` — Add context token savings metrics
- Verify packaged context artifacts

## Verification

Latest verification before this summary:

```bash
bun run check
# 125 pass, 0 fail, 819 expect() calls

bun run smoke:external-package
# external package smoke passed: ai-code-review-factory-0.1.0.tgz; provider dry-run skipped

bun run pack:smoke
# package smoke passed: ai-code-review-factory-0.1.0.tgz (78 files)
```

## Follow-ups

- Pre-existing #21 risk-tier recalibration note remains in `src/runner/risk-classifier.ts`; it was intentionally not committed with M010.
- `M009-SUMMARY.md` remains untracked from the prior milestone wrap-up unless the user wants to add it.
- S04 estimated input-token savings use a byte/4 approximation; future provider telemetry can replace or calibrate the estimate.
- Backlog: validate or normalize reviewer self-labeling in model output (`finding.reviewer`).
