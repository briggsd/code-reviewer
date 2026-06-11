# M009 Summary — Trusted prompt quality and prompt-boundary safety

## Result

M009 is complete. The runner now has a trusted reviewer-definition contract, domain-specific reviewer modules, central prompt-boundary sanitization, coordinator judgment guidance, deterministic fallback dedup/decision behavior, and a prompt-quality verification sweep.

## Commits

- `8dfeb8a` — Document trusted review resource boundary
- `9f26555` — Sanitize Pi prompt boundary data
- `b413a50` — Add trusted reviewer definition contract
- `8b72261` — Add domain-specific reviewer guidance
- `d4fa5e8` — Add coordinator judgment and dedup floor
- `97b48bb` — Add prompt quality verification sweep

## Verification

Latest full-suite verification before this summary:

```bash
bun run check
# 122 pass, 0 fail, 780 expect() calls
```

## Follow-ups

- Pre-existing #21 risk-tier recalibration note remains in `src/runner/risk-classifier.ts`; it was intentionally not committed with M009.
- Backlog: validate or normalize reviewer self-labeling in model output (`finding.reviewer`) so a reviewer cannot mislabel its own findings.
- M010 is the likely next milestone for shared context files and token economics.
