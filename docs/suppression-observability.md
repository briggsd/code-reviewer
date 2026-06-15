# Suppression-observability principle

**Keystone design rule for M020 — Output integrity & completeness**

---

## The principle

Any deterministic step that **discards, filters, or suppresses reviewer output** must ship
with three things:

1. **A drop/suppression-rate signal** — counts only (M008 discipline: no finding text, diff
   text, prompt content, or secrets). The count is surfaced as a `telemetry:quality` segment
   with a threshold that flags a *climbing* rate. A rising rate is a quality hypothesis, not
   noise — it means the gate is over-firing or the input set has drifted outside the gate's
   design intent.

2. **Visible-on-drop** — the discarded item is observable at the moment of the drop: in the
   published artifact (PR/MR comment), the JSONL trace, or both. A human reviewer and any
   downstream eval can see *what* was removed and *why*. Silent suppression is not an option.

3. **A labeled regression case** — for any suppression *classifier*, a test scenario that
   asserts both directions: "this valid item must survive" and "this bad item must drop." If
   over-suppression ships, a test fails instead of the failure shipping silently.

**Review-bar corollary:** a PR that adds a suppression gate must answer in its description —
*"what is this gate's false-positive rate, and how will we know if it climbs?"* — not just
"does it perform the suppression." The answer must point to the drop-rate signal and the
regression case, or explain why this gate has no false-positive risk.

---

## Placement rationale

This principle is extensive enough (three obligations + corollary + inventory) to warrant its
own page rather than being appended to the seven design principles in `docs/architecture.md`.
The architecture principles list stays legible with a pointer (design principle 3 note — added
in M020 S01). The dedicated page is the canonical reference that M020 slices S02 (#209),
S03 (#222), and S04 (#219) each cite in their PR descriptions.

---

## Inventory: existing suppression points

The table below maps each deterministic suppression gate to its current state against the
three requirements. Citations reference the source at M020 S01 time (branch `main` at
`a268bf7`).

| Gate | What it suppresses | Drop-rate signal | Visible-on-drop | Regression case |
|---|---|---|---|---|
| Evidence grounding | Findings whose `quotedCode` is not found in the diff-hunk corpus (demoted to low-confidence, non-blocking) | **Has** | **Has** | **Has (unit)** |
| Diff filter | Files excluded from review (binary, lockfile, vendored, generated, ignored-path) | **Has** | **Has (trace)** | **Has (unit)** |
| Patch admission | Files demoted to name+stat-only when total patch bytes exceed the per-tier budget | **Has** | **Has** | **Has (unit)** |
| Deletion-hunk pruning | Pure-deletion-only hunks removed from review context | **Has** | **Has (trace)** | **Has (unit)** |
| Inline-readiness gates | Findings blocked from inline write-back (fallback to summary) | **Gap** | **Gap** | **Has (unit)** |
| Reviewer-failure handling | Findings from failed reviewers excluded; degraded-summary path | **Has** | **Has** | **Has (integration)** |
| Structured-output validation (prose path) | Individual invalid findings dropped with count reported | **Has** | **Has** | **Has (unit)** |
| Structured-output validation (structured-tool path) | Any invalid finding throws the whole reviewer — all-or-nothing | **Gap (S04 #219)** | **Gap (S04 #219)** | **Gap (S04 #219)** |

---

## Detail per gate

### Evidence grounding

**What:** `assessFindingGrounding` in `src/runner/evidence-grounding.ts` partitions coordinator
findings into `grounded` (cited code found in the changed file's grounding corpus) and `dropped`
(not found). Patch hunks remain the floor, including deleted lines; when changed-file content is
available (from PR/MR HEAD or the local git working tree), a budget-bounded full-file corpus
promotes findings that quote real code from an unchanged region of the same changed file (#214).
Dropped findings are not silently discarded — they are down-weighted to `confidence: "low"` and
kept in a labeled non-blocking block (`groundingWithheld`), per the #207 reframe.

**Drop-rate signal.** `groundingDroppedCount` is emitted in `src/runner/run-review.ts` (line
421) and carried into `run_metrics` telemetry via `src/runner/run-metrics.ts` (lines 163 and
291-292) as `grounding.droppedFindingCount`. `telemetry:quality` tracks `groundingDropRate`
(run-level: fraction of runs with any grounding drop) and `groundingWithholdRate` (finding-level:
demoted ÷ produced) with breaching thresholds in `src/state/quality-report.ts` (lines 46-48,
97-120).

**Visible-on-drop.** (a) Summary comment: `formatWithheldGroup` in
`src/publisher/summary-markdown.ts` (lines 296-311) renders a labeled "Low-confidence findings
(kept, non-blocking)" block listing every demoted finding. (b) JSONL trace: a `grounding.applied`
event is emitted in `src/runner/run-review.ts` (lines 441-454) with `droppedFindingCount` and
per-dropped metadata (reviewer, severity, category, title — counts + labels only, no diff or
prompt text).

`grounding.full_content_corpus` is also emitted as a trace-only, counts-only marker when full
changed-file content was available for grounding. It records availability, inclusion, skipped-by-
budget count, included bytes, and budget bytes — no paths, file bodies, prompts, or finding text.

**Regression case.** `test/evidence-grounding.test.ts` has 20+ unit tests covering both
directions: "finding with quotedCode matching a patch line → grounded" and "finding with
quotedCode NOT in any patch (fabricated) → dropped," plus carve-outs for the no-quote and
sub-threshold cases and #214 full-file promotion/budget behavior. `test/evidence-grounding-spine.test.ts`
covers the run-through-coordinator integration path, including #214's full-content-only quote
promotion and #239's precision regression: a valid critical finding cites unchanged real code from
`changedFileContents`, a fabricated critical quote is down-weighted to the non-blocking
`groundingWithheld` block, and trace/telemetry/context-artifact assertions prove the full-file-only
code remains counts-only. `evals/scenarios-dev/full-file-grounding-precision.json` is the matching
dev-split live-eval scenario for valid-finding survival under full-file grounding. `telemetry:quality`
threshold tests are in `test/quality-report.test.ts` (lines 50-83).

---

### Diff filter

**What:** `filterDiff` in `src/runner/diff-filter.ts` (line 16) removes files from the reviewed
diff by reason: `binary`, `lockfile`, `vendored`, `generated` (path-glob or content-marker), or
`ignored_path`. The filtered-out files are accumulated as `ignoredFiles` in `DiffFilterResult`.
Sensitive paths short-circuit and are never filtered.

**Drop-rate signal.** `ignoredFileCount` (total) and `ignoredByReason` (breakdown) are written
into the `context.built` JSONL trace. `ignoredFileCount` and `reviewedFileCount` also appear in
`run_metrics`; `telemetry:quality` tracks `diffFilterDropRate` as a file-level rate
(`ignoredFileCount / (ignoredFileCount + reviewedFileCount)`) with `maxDiffFilterDropRate`.

**Visible-on-drop.** The `context.built` trace in `src/runner/run-review.ts` (lines 260-263)
lists each ignored file by path and reason (capped at 100). Path-level visibility is trace-only;
the PR comment does not surface filtered files.

**Regression case.** `test/diff-filter.test.ts` has unit tests covering each filter reason,
including the sensitive-path short-circuit. Both "file must be filtered" and "file must survive"
directions are covered.

---

### Patch admission

**What:** `decidePatchAdmission` in `src/runner/patch-admission.ts` (line 54) ranks files by a
3-key comparator — signal-bearing files (`lowSignal=false`) before low-signal bulk
(`lowSignal=true`), then `patchBytes` ascending, then `path` ascending (#218) — and greedily
admits patch bodies up to the per-tier byte budget. So a logic file wins the budget over a
smaller test fixture / snapshot / generated-data file; low-signal bulk is demoted preferentially.
Files that exceed the budget are demoted to name+stat-only (`demotedPaths`). The decision is
graceful degradation — the run continues with `degraded: true` and a clearly-marked summary notice.

**Drop-rate signal.** The `admission` block appears in the `context.built` trace with counts and
byte totals, including counts-only `lowSignalDemotedFileCount` for #218 demotions. Admission
counts also appear in `run_metrics`; `telemetry:quality` tracks `patchAdmissionDegradedRate` as
the fraction of measured runs whose admission gate degraded at least one file, with
`maxPatchAdmissionDegradedRate`.

**Visible-on-drop.** (a) Summary comment: when `admissionDecision.degraded` is true,
`formatPartialBySize` in `src/publisher/summary-markdown.ts` (lines 250-272) renders a "Partial
review by size" warning block listing the demoted file paths (capped at 20) in the PR comment.
(b) `summary.partialBySize.droppedPaths` carries the demoted paths in `run.json`/`summary.json`.

**Regression case.** `test/patch-admission.test.ts` covers the unit logic (under budget,
over-budget greedy admission, all-demoted floor). `test/patch-admission-spine.test.ts` covers
the integration wiring. Both "file admitted" and "file demoted" directions are covered.

---

### Deletion-hunk pruning

**What:** `pruneDeletionOnlyHunks` in `src/runner/prune-deletion-hunks.ts` (line 33) drops
hunks from a patch that contain no added (`+`) lines. Mixed hunks (remove-then-add) are kept in
full. Files whose every hunk is pruned away have their patch body omitted entirely
(`patch: undefined`) and are written as name-only entries in the context artifacts.

**Drop-rate signal.** `deletionHunksPruned` and `deletedFileBodiesPruned` counts are written
into the `context.built` trace. When deletion-pruning counts are present in `run_metrics`,
`telemetry:quality` tracks `deletionPruningRate` as the fraction of measured runs with any
deletion-pruning activity, with `maxDeletionPruningRate`.

**Visible-on-drop.** The pruned-hunk counts appear in the `context.built` trace
(`contextArtifacts.deletionHunksPruned`, `deletedFileBodiesPruned`). Deleted-body files still
appear by name in the context, so reviewers see the file existed; the absence of a patch body is
the signal. The PR comment does not surface deletion-pruning counts.

**Regression case.** `test/prune-deletion-hunks.test.ts` covers the unit logic: hunks with no
`+` lines are dropped, mixed hunks are kept, and the `droppedHunks` count is asserted in both
directions.

---

### Inline-readiness gates

**What:** `evaluateInlinePublishReadiness` in `src/publisher/inline-readiness.ts` (line 45)
classifies which findings can be published as inline PR/MR comments and which must fall back to
the summary. A finding is blocked for reasons including: stale head SHA, truncated diff, missing
location, missing/unsupported side, file not in diff, binary file, missing patch, deleted/added
file side mismatch, or line not in patch.

**Drop-rate signal. GAP.** There is no count of inline-blocked findings in `run_metrics` or
`telemetry:quality`. The `publisher.completed` trace event (in `src/publisher/publish-inline.ts`
and `src/publisher/publish-summary.ts`) records whether inline publishing succeeded or fell back,
but there is no per-finding blocked count reaching the telemetry stream. An operator cannot tell
from `telemetry:quality` whether the inline block rate is climbing.

**Visible-on-drop. GAP.** Blocked findings fall back to the summary comment (the intended
fallback path), but there is no explicit artifact-level marker that a finding was "blocked from
inline and promoted to summary." The PR/MR summary renders the finding, so it is not silently
lost, but the reason for the fallback is not surfaced.

**Regression case.** `test/inline-readiness.test.ts` covers the unit logic for every block
reason (`stale_head_sha`, `diff_truncated`, `missing_location`, `missing_line`, etc.) in both
directions. The classification itself is well-tested; the missing piece is the drop-rate signal
and the visible-on-drop artifact.

---

### Reviewer-failure handling

**What:** When a reviewer agent fails (classification: `schema_invalid`, `truncated`,
`context_overflow`, `provider_error`, `auth`, `rate_limited`, etc.), its findings are excluded
from the coordinator's synthesized summary. If all reviewers fail with content-class errors,
the run degrades to a published `review_failed`/`fail` summary naming the failed roles (#212).
Operational failures crash the run loudly.

**Drop-rate signal.** `failedReviewerCount` is carried in `summary.degraded.failedReviewerCount`
and in `run_metrics` via `src/runner/run-review.ts` (lines 957 and 1073). `telemetry:quality`
tracks `reviewerFailureRate` in `src/state/quality-report.ts` (lines 164-168) with a
`maxReviewerFailureRate` threshold.

**Visible-on-drop.** (a) Summary comment: `formatDegradedBanner` in
`src/publisher/summary-markdown.ts` (lines 278-290) renders a "Degraded review — N of M
reviewers failed" warning listing the failed role names when any reviewer failed. (b) JSONL
trace: each failed reviewer emits an `agent.failed` event.

**Regression case.** The degraded-review path is exercised in integration tests. The
`telemetry:quality` `reviewerFailureRate` threshold is tested in `test/quality-report.test.ts`.

---

### Structured-output validation — prose path

**What:** The prose-fallback path in `src/runtime/reviewer-output-validation.ts` (line 26,
`parseReviewerOutput`) parses the model's text output tolerantly: corrupt individual findings
are dropped while their valid siblings survive, and `droppedFindingCount` records the partial
drop.

**Drop-rate signal.** `droppedFindingCount` is emitted in the `agent.output` trace event (only
when > 0). `telemetry:quality` tracks `proseFindingDropRate` from counts-only prose-path
`agent.output` events (`droppedFindingCount / (findingCount + droppedFindingCount)`) with
`maxProseFindingDropRate`.

**Visible-on-drop.** The `agent.output` event carries `droppedFindingCount` so an operator
inspecting the trace can see how many findings were dropped by the prose parser. The surviving
findings reach the published comment normally.

**Regression case.** `test/reviewer-output-validation.test.ts` (lines 67-88) has a direct test:
"drops one invalid finding while keeping its valid sibling, and counts the drop" with a
`droppedFindingCount` assertion.

---

### Structured-output validation — structured-tool path

**What:** The structured-tool path in `src/runtime/structured-tool-output.ts` (line 68,
`parseReviewerToolArgs`) validates `submit_findings` tool-call arguments. It is
**all-or-nothing**: if any finding fails `validateFinding`, the whole reviewer throws
(`schema_invalid` classification) — there is no per-finding tolerant drop.

**Drop-rate signal. GAP (#219, S04).** There is no `droppedFindingCount` on the structured
path: the code path in `src/runtime/pi-agent-runtime.ts` (lines 608-609) hardcodes
`droppedFindingCount: 0` for the structured branch. An invalid finding silently discards the
whole reviewer output via a classified failure rather than surfacing a partial drop. The
asymmetry with the prose path is documented in the comment at lines 605-607 of that file and
is the tracked gap that S04 (#219) will fix: make the structured path tolerant like the prose
path (drop individual invalid findings, count and surface the drops).

**Visible-on-drop. GAP (#219, S04).** Because the structured path throws on any invalid
finding, the drop surfaces as a reviewer failure (`agent.failed`) rather than a partial
`droppedFindingCount` in `agent.output`. A valid finding that happens to share a batch with an
invalid one is lost without an explicit partial-drop signal.

**Regression case. GAP (#219, S04).** There is no test asserting that a valid finding in a
mixed-validity structured-tool response survives when an invalid sibling is present. The current
behavior (throw) makes this untestable without first fixing the gap. After S04 lands, a
regression case asserting "valid finding survives invalid sibling on the structured path" should
be added.

---

## Gaps and candidate follow-ups

The inventory above surfaces the following gaps not yet tracked as issues. The coordinator
will triage which to file:

1. **Inline-readiness — no drop-rate signal and no visible-on-drop artifact.** This is the
   most complete gap: blocked-finding count is neither in `run_metrics` nor in the PR comment.
   A PR author cannot tell which of their findings were "blocked from inline" vs "rendered in
   summary by design." (Issue #222 tracks the false-absence / completeness fix; the drop-rate
   signal and visible-on-drop for the gate itself are a separate follow-up.)

2. **Evidence grounding — no eval scenario for valid-finding survival.** Unit and spine tests now
   assert that a valid full-content-only quote survives grounding (#214), but there is still no
   sealed eval scenario in `evals/scenarios/`. #239 can add that regression on top of the promoter.

---

## Cross-references

- `docs/architecture.md` — design principles (pointer at principle 3 note)
- `docs/milestones/M020-ROADMAP.md` — S01 decision record and sequencing
- S02 (#209) — false-absence fix (inline-readiness + summary coherence)
- S03 (#222) — false-absence soundness / prompt-floor for the absent-finding signal
- S04 (#219) — structured-tool path all-or-nothing gap fix
- #214 — evidence-grounding full-file-corpus promoter
- #239 — sealed eval/regression for valid-finding survival
