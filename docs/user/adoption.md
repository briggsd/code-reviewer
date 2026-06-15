# Adoption guide

Use this guide when wiring AI Code Review Factory into another repository. For the Fortis/self-managed GitLab beta operator checklist, see [Fortis GitLab beta onboarding](fortis-gitlab-beta.md).

## Recommended adoption path

1. **Pin the package source.** Set `AI_REVIEW_PACKAGE` to an immutable npm tarball URL, an exact registry package version, or a full Git commit SHA for internal smoke only. For the Fortis/self-managed GitLab beta, prefer a versioned internal tarball URL and keep the package private/`UNLICENSED`; public npm is not required. Do not use `main`, floating tags, `latest`, or a checkout of the runner repository as the adopter install source.
2. **Start with dry-run only.** Copy `examples/ci/github-actions-ai-review.yml`, `examples/ci/github-actions-ai-review-action.yml`, or the Fortis/self-managed GitLab beta template at `examples/ci/gitlab-ai-review.yml`, keep the runtime variables at `dummy`, and verify `.ai-review/` artifacts upload successfully. For self-managed GitLab, keep `AI_REVIEW_GITLAB_API_BASE_URL` set to `$CI_API_V4_URL` or your explicit `https://gitlab.example.com/api/v4` endpoint.
3. **Enable same-repo/same-project summary publishing.** Keep dry-run and publish jobs separate. Only the guarded publish job should use write permissions and `--publish-summary`.
4. **Optionally enable GitHub inline publishing in the guarded write-back job.** Only after summary publishing is stable, add `--publish-inline` for same-repository GitHub PRs. Keep the default dry-run job inline-free.
5. **Switch to Pi only in trusted jobs.** After summary-only dummy runs are stable, replace `--runtime dummy` with `--runtime pi` in a trusted job that can install Pi and access model credentials.
6. **Inspect failure artifacts before rerunning.** For failed runtime/model/schema runs, inspect `.ai-review/runs/<runId>/run.json` and `trace.jsonl`. Runtime failures should persist `run.json.error` and end the trace with `review.failed`.

## Minimal GitHub shape

```yaml
env:
  AI_REVIEW_PACKAGE: https://gitlab.example.com/fortis/dev-tools/ai-code-review-factory/-/releases/v0.1.0/downloads/ai-code-review-factory-0.1.0.tgz

jobs:
  dry-run:
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.0
      - run: bun add --global "$AI_REVIEW_PACKAGE"
      - run: |
          ai-code-review run \
            --provider github \
            --repo "${{ github.repository }}" \
            --change-id "${{ github.event.pull_request.number }}" \
            --head-sha "${{ github.event.pull_request.head.sha }}" \
            --runtime dummy \
            --output-dir .ai-review \
            --ci-exit
```

Use the full raw CLI template in `examples/ci/github-actions-ai-review.yml` or the wrapper template in `examples/ci/github-actions-ai-review-action.yml` for the separate guarded publish job. The wrapper is documented in [GitHub Action wrapper](github-action-wrapper.md).

> **The summary comment's visible Markdown is not a stable interface.** Its layout changed
> in #33 (grouped by reviewer, collapsed details) and may change again. Tooling that needs
> the decision, outcome, or finding data programmatically should read the run artifacts
> (`run.json` / `summary.json`) or the hidden `<!-- ai-code-review-factory -->` metadata
> block — those are the stable surfaces; never parse the human-facing comment text.

## What has been live-tested

- **GitHub same-repository summary publishing:** PR #2 verified dry-run, artifact upload, same-repo summary publishing, and idempotent update of a single bot summary comment.
- **GitHub re-review metadata:** seeded provider-backed publishes against PR #2 verified new, recurring, and fixed finding classification from hidden metadata.
- **Packaged external install:** `bun run smoke:external-package` verifies isolated Bun global install plus installed `ai-code-review` execution; a live GitHub provider-backed variant has run successfully.
- **Packaged Pi runtime:** `AI_REVIEW_LIVE_PI=1 bun run smoke:pi` has run successfully through the packed CLI and Pi JSON mode, producing `run.json`, `summary.json`, and `trace.jsonl` artifacts.
- **Failure observability:** tests simulate runtime failure and assert persisted `run.json.error` plus a terminal `review.failed` trace event.
- **GitHub inline publishing:** unit/adapter coverage verifies readiness gating, GitHub review comment creation, skipped reasons, and duplicate suppression. Live smoke status is tracked in `inline-publishing.md` and `workflow-smoke-test.md`.
- **GitLab inline publishing:** unit/adapter coverage verifies readiness gating, MR diff-discussion creation with `diff_refs` positioning (RIGHT→`new_line`, LEFT→`old_line`), skipped reasons, and duplicate suppression. Not yet live-smoke-tested; MVP limitations (renamed files, single-page discussion dedup) are documented in `inline-publishing.md`.
- **GitLab live summary publishing:** M005 smoke against `test-group-zinga/general` MR #3 verified metadata/diff fetch, summary note publish, and idempotent update of one GitLab note.

## Not yet live-tested or intentionally deferred

- **GitLab inline discussions — live smoke:** the adapter posts MR diff discussions (unit-tested), but a live model-backed smoke against a real GitLab MR has not been run yet. Same readiness gates as GitHub.
- **Container image, GitHub Action wrapper, GitLab component wrapper:** deferred until the CLI/package interface and safety controls stabilize.
- **Fork privileged write-back:** not enabled by default. Fork PRs/MRs should remain artifact/status-only unless a separate approved privileged reporter flow is designed.

## Upgrade notes

- **Content-marker generated-file detection (#24).** This version adds `generatedFileMarkers`: the diff filter now also skips a file when an **added** line in its patch head contains a configured marker (default just `// @generated`), in addition to the existing path globs. On upgrade, files that add a `// @generated` line start being excluded from review (counted as `generated` ignores; each dropped path is named in the `context.built` trace). To opt out, set `"generatedFileMarkers": []` in `.ai-review.json`; to change the set, list your own markers (it **replaces** the default wholesale). `sensitivePaths` still short-circuits before marker detection, so security-critical files are never dropped. See [configuration.md](configuration.md).
- **Deterministic summary body on grounding-drop (#206).** When evidence-grounding demotes one or more findings, `summary.body` (in `summary.json` and the published comment) is now generated **deterministically** from the surviving set — `Risk tier: … / Risk reason: … / Files reviewed: … / Files ignored: … / Findings: N` — instead of reusing the coordinator's pre-grounding prose, which could narrate findings that didn't survive grounding. A `_N finding(s) shown at low confidence (kept, non-blocking)…_` note is still appended, and the demoted findings stay visible in the "⚠️ Low-confidence findings (kept, non-blocking)" render block (#204, #207) at `confidence: "low"` — they are kept but non-blocking, never silently dropped. Runs where grounding demotes nothing are unaffected (the coordinator's prose is preserved). Programmatic consumers that read `summary.body` from `summary.json` will see this fixed-template content the first time grounding demotes a finding.

- **Oversized diffs degrade gracefully instead of hard-failing (#145).** Previously a diff that exceeded the model context limit failed the run with a non-retryable `context_overflow` (no summary produced). Now a **patch-admission gate** runs before the model call: when total (post-deletion-pruning) patch bytes exceed the per-tier `patchBudgets` budget (defaults: trivial 64 KB / lite 512 KB / full 4 MB — see [configuration.md](configuration.md)), the review still completes but ranks files **signal-aware** — signal-bearing logic files are admitted first (regardless of size), then the remaining budget is filled smallest-first — and demotes the overflow to **name + line-stat only**, with low-signal bulk (test fixtures, snapshots, generated data) demoted preferentially (#218, M021). The published comment then carries a prominent **`⚠️ Partial review by size`** block listing the omitted files. **What to expect on upgrade:** a large PR/MR that used to show a red `context_overflow` failure will instead show a green/partial review with that warning block — this is the new expected behavior, not a silent regression. In a fixture-heavy diff, the logic now wins the byte budget over smaller fixtures (so `code_quality` converges instead of being crowded out). **Low-signal classification rules (#218):** a file is treated as low-signal when its path has a `__snapshots__/` segment, ends in `*.snap`/`*.golden`, lives under `examples/fixtures/`, or is a `.json`/`.jsonl`/`.txt`/`.csv` data file under a `fixtures/`/`__fixtures__/` segment. Test *logic* (`*.test.ts`/`*.spec.ts`), any `.ts`/`.js` source, and files matched by `sensitivePaths` are **never** low-signal. This rule set is **not user-configurable** (it is internal to the factory, not a `.ai-review.json` key) — the only adopter lever is `patchBudgets`: a repo whose `fixtures/` dirs hold large *signal-bearing* data can raise the relevant tier budget so nothing is demoted. `context_overflow` remains only as the safety net for genuine post-degradation model overflow.

- **Hidden-metadata `schemaVersion` bump 3 → 4 (#145).** The `<!-- ai-code-review-factory … -->` metadata block embedded in the published comment now reports `schemaVersion: 4` and may carry a new optional `partialBySize` counts block (admitted/dropped file counts and byte totals; **counts only — no paths or content cross this boundary**). The bump is **additive and backward-compatible**: parsers that ignore unknown keys are unaffected. **Action:** any tooling that asserts an exact `schemaVersion === 3` on the metadata block must be updated to accept `>= 3` (or `4`).

- **Hidden-metadata `schemaVersion` bump 4 → 5 (#149).** The metadata block now reports `schemaVersion: 5` and adds an optional `findingsHash` field: a 16-hex-character SHA-256 prefix of the sorted stable finding-ID set (empty string when there are no findings). The hash lets tooling detect a stable finding set across re-reviews without comparing full ID arrays. The bump is **additive and backward-compatible**: parsers that ignore unknown keys are unaffected. **Action:** any tooling that asserts an exact `schemaVersion === 4` on the metadata block must be updated to accept `>= 4` (or `5`). **Operator note:** when a re-review detects that the finding set is unchanged since the last review (converged — all prior findings are recurring, none new/fixed/withheld), the summary comment re-post is **suppressed** to avoid noise. CI status and exit code are never affected by convergence. To force a re-post regardless, pass `--force-review` to the CLI.

- **Hidden-metadata `schemaVersion` bump 5 → 6 (#279).** The metadata block now reports `schemaVersion: 6` and adds an optional `resolvedLog` field: an array of `{ stableId, title, resolvedAtSha }` objects accumulated across re-review rounds, recording which findings were resolved and in which commit. The log is capped at 50 entries (oldest dropped when exceeded) and is absent until at least one finding is classified `fixed` in a re-review. The bump is **additive and backward-compatible**: parsers that ignore unknown keys are unaffected. **Action:** any tooling that asserts an exact `schemaVersion === 5` on the metadata block must be updated to accept `>= 5` (or `6`).

- [ ] Bun is installed before `bun add --global "$AI_REVIEW_PACKAGE"`.
- [ ] `AI_REVIEW_PACKAGE` is an immutable internal tarball URL or exact-version pinned package source.
- [ ] Self-managed GitLab jobs pass `--api-base-url` from `$CI_API_V4_URL` or an explicit `AI_REVIEW_GITLAB_API_BASE_URL`.
- [ ] Dry-run and publish jobs are separate.
- [ ] GitLab beta templates keep `AI_REVIEW_DRY_RUN_RUNTIME` and `AI_REVIEW_PUBLISH_RUNTIME` explicit, defaulting to `dummy` until trusted model-backed jobs are approved.
- [ ] Fork PR/MR jobs do not receive write tokens or model/runtime credentials.
- [ ] `.ai-review/` artifacts upload even on failure.
- [ ] Summary publishing updates an existing bot comment/note instead of duplicating it.
- [ ] Pi/model credentials are only available in trusted jobs.
- [ ] Runtime failures leave `run.json.error` and `trace.jsonl` ending in `review.failed`.
- [ ] Inline publishing remains disabled by default; if enabled (GitHub or GitLab), it is same-repo/trusted and uses `--publish-inline` behind readiness gates.
