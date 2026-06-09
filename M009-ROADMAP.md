# M009 Roadmap Stub — Trusted prompt quality and prompt-boundary safety

> Stub status: tentative. Build this out after M008 lands and the trace/resilience substrate is stable.

## Vision

Improve review quality by moving from generic reviewer instructions to trusted, domain-specific reviewer definitions, while documenting and enforcing the boundary between trusted factory-operator resources and untrusted reviewed-repo content.

## Source Issues

- GitHub #17 — Docs: trusted-operator vs untrusted-repo resource boundary
- GitHub #14 — Sanitize user-controlled fields for prompt-boundary injection
- GitHub #10 — Reviewer prompts: per-domain what-to-flag / what-NOT-to-flag modules
- GitHub #13 — Coordinator judgment pass: dedup / reasonableness filter / verification + approval-bias rubric

## Tentative Success Criteria

- Docs clearly state that reviewed-repo Pi resources remain disabled in CI and only factory-controlled reviewer definitions are trusted.
- User-controlled metadata is sanitized/escaped before prompt assembly in one central path.
- MVP reviewer prompt modules exist for `security`, `code_quality`, and `documentation`.
- Every reviewer module includes what to flag, what not to flag, severity calibration, output expectations, and shared mandatory rules.
- Coordinator prompting and deterministic fallback reduce duplicate/noisy findings instead of only sorting by severity.

## Tentative Slices

- [x] **S01: Document trusted-operator vs untrusted-repo boundary** `risk:medium` `depends:[]` `issues:[#17]`
  > After this: security/fork-safety docs explain the two resource layers and the invariant that reviewed-repo Pi resources stay disabled.

- [x] **S02: Central prompt-boundary sanitization** `risk:high` `depends:[S01]` `issues:[#14]`
  > After this: title, description, comments, file paths, and prior findings are sanitized/escaped before runtime prompt assembly, with hostile-description tests.
  > **Our injection vector differs from Cloudflare's.** They strip a fixed XML tag set (`mr_input`, `mr_body`, `changed_files`, `previous_review`, …) via `/<\/?(?:tag)[^>]*>/gi` because their prompts use XML delimiters. Our prompts embed user content via `JSON.stringify`, so the equivalent vector is **JSON-structure breakout**, and sanitization must be JSON-structure-aware (escape/normalize delimiters our own prompts rely on) — the literal tag list is not portable.
  > **Quote-repair is in scope as an attack surface.** `repairUnescapedStringQuotes` in `src/runtime/pi-agent-runtime.ts` rewrites malformed quotes to recover JSON; a hostile MR field could weaponize that repair path. S02 must review/constrain the repair heuristic, not just sanitize inputs.

- [x] **S03: Portable reviewer prompt module contract** `risk:medium` `depends:[S01,S02]` `issues:[#10,#16]`
  > After this: code has a runtime-neutral contract for trusted reviewer definitions, separate from reviewed-repo resources.
  > Implemented: `ReviewerDefinition` is now part of the runtime contract; reviewer selection uses only factory-owned trusted definitions, and reviewed-repo config can enable/disable known roles but cannot define new reviewer authority.
  > Note: this slice resolves the **near-term form of #16** — the contract *is* the plugin API, realized natively per runtime adapter; we do not build a Cloudflare-style plugin lifecycle here. Only the full-lifecycle escalation remains open in M012.

- [ ] **S04: MVP per-domain reviewer modules** `risk:medium` `depends:[S03]` `issues:[#10]`
  > After this: `security`, `code_quality`, and `documentation` reviewers use domain-specific flag/non-flag guidance and severity rubrics.
  > S04 must differentiate severity calibration and output expectations per domain. In particular, `documentation` should either use a docs-specific critical bar or avoid exposing `critical` findings unless documentation errors can plausibly cause unsafe rollout, outage, or data loss.
  > Preserve per-definition versioning when content diverges (for example, bump only `security.*` when tuning the security reviewer definition).

- [ ] **S05: Coordinator judgment and deterministic dedup floor** `risk:medium` `depends:[S04]` `issues:[#13]`
  > After this: coordinator prompts require dedup/reasonableness/source verification, and fallback summaries perform deterministic dedup plus an approval-bias decision rubric.
  > **Target rubric (from the Cloudflare primary source):** only suggestions → `approved_with_comments`; **single warning with no production risk → `approved_with_comments`**; **multiple warnings suggesting a risk pattern → `minor_issues` (unapprove)**; any critical or production-safety risk → `significant_concerns` (block).
  > **Fix the current over-block:** today `chooseDecision` in `src/runner/run-review.ts` maps *any* single warning → `minor_issues`, which unapproves where Cloudflare would approve-with-comments. Encode the single-vs-multiple-warning distinction.

- [ ] **S06: Prompt quality verification sweep** `risk:medium` `depends:[S02,S04,S05]` `issues:[#10,#13,#14,#17]`
  > After this: tests lock trusted-resource docs, hostile input handling, reviewer module coverage, and coordinator fallback behavior.

## Deferred From This Stub

- Shared context files and token-economics work (#11) belongs in M010.
- Full Cloudflare-style plugin lifecycle / `ConfigureContext` adoption (#16) remains a decision, not implementation; M009 only resolves the near-term trusted reviewer/coordinator contract seam.
- Product analytics and telemetry sinks (#19/#20) belong after M008 metrics are stable.
