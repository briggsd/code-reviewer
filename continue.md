# Continue — AI Code Review Factory / #37 MERGED, dogfood surfaced over-spend (#40 is next)

## Last action

- **#37 (coordinator reviewer-label validation) — MERGED & CLOSED.** `origin/main` at `6b6eaec "Validate coordinator reviewer labels"`; local `main` in sync. Reviewed at high effort (`/code-review`): **0 correctness bugs**; the case/normalization "asymmetry" candidate was refuted — both `enforceReviewerRole` (`=== role`) and `enforceCoordinatorReviewerRoles` (`allowedSet.has`) are exact-match and consistent. The merge commit landed exactly the **4 intended files** (`pi-agent-runtime.ts`, `test/pi-runtime.test.ts`, `architecture.md`, `fork-safety.md`) — the #21 note and `M009-SUMMARY.md` were correctly excluded and remain uncommitted. One optional, non-blocking cleanup deferred: the two enforce fns are near-duplicates → could share one allowed-set-parameterized primitive (matches existing #32 style).
  - **Implementation**: `enforceCoordinatorReviewerRoles` membership-checks each coordinator finding's `reviewer` against `["coordinator", ...input.selectedReviewers.map(r => r.role)]`; out-of-set → normalized to `"coordinator"` + a bounded `reviewerRoleAdjustments` trace entry. `parseCoordinatorOutput` now returns `{ summary, reviewerRoleAdjustments }` (single caller updated). Ordering: `validateFinding` (drops model ids) → role enforcement → stable-id assignment, so stable IDs are never keyed on an out-of-set attacker-chosen role. Docs updated (`architecture.md` documents the `reviewerRoleAdjustments` schema — closes that open thread; `fork-safety.md`).
- **Local dogfood of #37 via `--git-diff --runtime pi`** surfaced two real factory gaps and one auth gotcha (all below). The live run hit the 11-min timeout: lite tier, `security` (3 findings) + `documentation` (4) completed, **`code_quality` timed out at the 6-min per-reviewer budget** (2,413 tool calls) → `review.failed`, partial findings discarded. This is exactly **#40**.
- **Filed #39, #40; bumped #21.** See State.

## Next action — priority shifted: #40(+#21) jumps the M013 waves

1. **#40 (risk-tier over-spend / 11-min timeout) — priority:high, the real next work.** It causes review *failures* on small diffs, which blocks reliable dogfooding. Cheapest high-leverage slice: **tier-scaled timeouts + tier-coupled tool policy** (disable repo-crawl tools for `lite`/`trivial`). Root cause: tool access is keyed on `safetyMode` not tier (`run-review.ts:648` → `createRuntimeToolPolicy`), and timeouts are flat across tiers (`default-config.ts:31` `reviewerMs:360_000`/`overallMs:660_000`). Sequence **#21 alongside** (now priority:high) — #21 = "is the tier right?", #40 = "does the tier actually cost less?".
2. **#39 (provider-error masking) — opportunistic.** Do it while in the Pi runtime; cheap, prevents future blind debugging.
3. **M013 waves slip behind #40/#21**: Wave 1 #27 (boundary lint), Wave 2 (#33→#28), Wave 3 (#26), Wave 4 (#29). #20 (analytics) still unblocked.
4. **Defer the two filed UX items** (#41 heartbeat, #42 `--pi-api-key`) until the tool is reliable.

## State

- Branch: `main`, in sync with `origin/main` at `6b6eaec` (#37 merged). Working tree still carries untracked `M009-SUMMARY.md` (and this `continue.md` edit).
- **Issues filed this session:**
  - **#39** (`bug,resilience,observability,priority:medium`) — Pi runtime masks provider error envelopes (`{"type":"error",...}`, e.g. out-of-usage) as a confusing `Unexpected identifier "Finding"` JSON-parse `SyntaxError`; misclassified `unknown`/non-retryable.
  - **#40** (`bug,resilience,priority:high`) — risk tier doesn't bound reviewer effort; lite-tier over-spends and fails the overall timeout. Acceptance criteria include "preserve partial specialist findings on overall timeout."
  - **#21** bumped `priority:low → priority:high` + comment: now blocks M013 waves (was M012 parking-lot).
- **UX enhancements (filed, deferred behind #40):**
  - **#41** (`enhancement,inspiration-gap,observability`) — surface review progress / "still thinking…" (Cloudflare gap). The `heartbeat` event already exists (`pi-agent-runtime.ts:456`) but has no consumer; CLI prints only the final summary.
  - **#42** (`enhancement,resilience`) — `--pi-api-key` passthrough so the runtime can force API-key auth instead of falling through to a stored pi OAuth. See auth gotcha below.
- Open issues: **#39/#40** (new, #40 priority:high), **#41/#42** (UX, deferred behind #40), **#21** (high, blocks M013), **M011** #20 (unblocked), **M013** #26/#27/#28/#29/#33, **M012** parking lot #15/#16/#22/#23/#24. (#37 closed/merged.)

## Open threads

- **pi auth gotcha (ACTIVE local state):** pi prefers the OAuth credential in `~/.pi/agent/auth.json` (Claude subscription, was out of usage) over the `ANTHROPIC_API_KEY` the factory forwards via env — only an explicit `pi --api-key` overrides, which the factory never passes. **Removed the `anthropic` block from `~/.pi/agent/auth.json`** (backup: `~/.pi/agent/auth.json.bak-preA`) so pi falls back to the `.env` key. **Interactive pi now also uses the API key (real billing); restore the backup when done dogfooding** (`cp ~/.pi/agent/auth.json.bak-preA ~/.pi/agent/auth.json`). This is what #--pi-api-key (drafted) would fix in-product.
- `M009-SUMMARY.md` remains untracked — decide keep vs delete.
- **#37** captures the coordinator-label residual; the harder half (detecting in-set valid-but-wrong-role spoofing) may need its own slice + a provenance marker from coordinator → specialist finding.
- `.env` holds the Anthropic API key (gitignored; Bun auto-loads it for `bun run`).
- **Local review loops:**
  - Fast/no-PR (#38): `bun run src/cli.ts run --git-diff [--base main] --runtime pi --pi-provider anthropic --pi-model claude-sonnet-4-6 --output-dir .ai-review --format markdown`. Default base HEAD = uncommitted only; `--base main` for committed branch work; untracked files need `git add -N`. No publish. **NB: large/whole-tree diffs hit #40's timeout — narrow the diff (commit + `--base main`) for a clean run.**
  - Against a real PR: same with `--provider github --repo briggsd/ai-code-review-factory --change-id <N> --head-sha $(git rev-parse HEAD)` (no `--publish-summary`).
  - Both write `telemetry.jsonl` + `trace.jsonl` under `.ai-review/runs/<id>/`.

## Do not

- Do not include `M009-SUMMARY.md` unless explicitly deciding to keep that prior artifact.
- Do not reopen PR #9 or work on the deleted branch `real-review-smoke-pr`.
- Do not reopen closed issues #10/#11/#12/#13/#14/#17/#18/#19/#25/#31/#32 unless new regressions appear.
- Do not expose provider secrets or disable the real Pi review workflow by default.
