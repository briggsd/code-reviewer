# Inline publishing readiness

Inline comments/discussions are still deferred. Summary comments/notes remain the only write-back path in the templates.

Before any future GitHub or GitLab inline publisher posts a finding, it must pass `evaluateInlinePublishReadiness()` from `src/publisher/inline-readiness.ts`.

## Gate inputs

The readiness gate takes:

- current `ChangeMetadata`, including the provider head SHA,
- the provider `DiffSummary`, including per-file patches,
- findings proposed for inline publication,
- optional `expectedHeadSha` used when those findings were generated.

## Blocking conditions

The gate blocks inline publishing when any of these are true:

- the review was generated for a stale head SHA,
- the provider diff is truncated/overflowed,
- the finding has no location,
- the finding has no explicit line or side,
- the file is not present in the provider diff,
- the file is binary,
- the provider omitted patch text,
- the finding points to the right side of a deleted file,
- the finding points to the left side of an added file,
- the requested line is not present in the provider patch hunk.

This is intentionally conservative. A blocked inline finding can still be shown in the summary comment; the whole review should not fail only because inline coordinates are unsafe.

## Future publisher contract

Future inline publishers should use this sequence:

1. Fetch fresh change metadata and diff from the VCS provider.
2. Call `evaluateInlinePublishReadiness({ change, diff, findings, expectedHeadSha: reviewHeadSha })`.
3. Publish only `readyFindings` inline.
4. Keep `blockedFindings` in the summary with their block reasons in trace/debug output.
5. Re-fetch or abort if `stale_head_sha` appears.

## Why this exists

Inline APIs require provider-specific coordinates. GitHub uses PR review comment coordinates with commit SHA/path/line/side. GitLab diff discussions require diff refs and line positions. Posting with stale or guessed coordinates creates noisy, misleading comments. The readiness gate gives the future provider-specific publishers a shared safety precondition before they call those APIs.
