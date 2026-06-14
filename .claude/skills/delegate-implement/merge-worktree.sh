#!/usr/bin/env bash
# merge-worktree.sh — land a lane PR and tear its worktree down in one idempotent command.
#
# Why this exists: `gh pr merge <N> --squash --delete-branch` run from INSIDE a lane worktree
# aborts mid-way — gh tries to `git checkout main` in the current worktree to delete the local
# branch, but `main` is held by the primary checkout (`fatal: 'main' is already used by
# worktree`), so it merges server-side but never deletes the remote branch. Then teardown needs
# --force because this repo squash-merges and `git branch -d` doesn't see a squash as merged.
# This script runs the always-works sequence instead — no `--delete-branch`, explicit remote
# delete, force teardown — and is safe to re-run after a partial failure (each step is a no-op
# if already done).
#
# Usage:
#   .claude/skills/delegate-implement/merge-worktree.sh <pr#> [branch] [--force]
#     <pr#>      the PR number to squash-merge.
#     [branch]   the lane branch (e.g. sonnet/176-foo). Optional — defaults to the PR's
#                head branch (resolved via `gh pr view`).
#     --force    override both safety gates: (1) skip the blocking-check green-gate (merge even
#                if "Type-check & tests" isn't SUCCESS), and (2) tear the worktree down even if it
#                has uncommitted changes. WITHOUT --force, teardown refuses a dirty worktree so
#                stray work isn't silently lost. (Branch deletion always force-deletes with `-D`
#                — a squash-merge isn't seen as merged by `git branch -d` — but that's safe once
#                the PR is merged; the dangerous knob is the dirty-worktree bypass, which --force
#                gates.)
set -euo pipefail

PR=""
BRANCH=""
FORCE=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE="--force" ;;
    --*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *)
      if [[ -z "$PR" ]]; then PR="$arg"
      elif [[ -z "$BRANCH" ]]; then BRANCH="$arg"
      else echo "unexpected argument: $arg" >&2; exit 2
      fi
      ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "usage: merge-worktree.sh <pr#> [branch] [--force]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve the MAIN checkout even when invoked from inside a linked worktree (see new-worktree.sh).
MAIN="$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")"

# Resolve branch from the PR when not supplied.
if [[ -z "$BRANCH" ]]; then
  BRANCH="$(gh pr view "$PR" --json headRefName -q .headRefName)"
  if [[ -z "$BRANCH" ]]; then
    echo "error: could not resolve head branch for PR #$PR — pass it explicitly." >&2
    exit 1
  fi
  echo "→ resolved branch: $BRANCH"
fi

STATE="$(gh pr view "$PR" --json state -q .state)"

if [[ "$STATE" == "MERGED" ]]; then
  echo "→ PR #$PR already merged; skipping merge, running cleanup only."
else
  if [[ "$STATE" != "OPEN" ]]; then
    echo "error: PR #$PR is $STATE (not OPEN/MERGED) — refusing to merge." >&2
    exit 1
  fi
  # Green-gate on the one BLOCKING check (SKILL.md: the blocking merge gate is only
  # "Type-check & tests"; the real-Pi AI review is advisory). --force skips this.
  if [[ -z "$FORCE" ]]; then
    # `statusCheckRollup` can carry more than one entry for the same check name (e.g. a re-run);
    # take the last (most-recent) conclusion so $CHECK is a single value, not a multi-line string
    # that would never compare equal to "SUCCESS".
    CHECK="$(gh pr view "$PR" --json statusCheckRollup \
      -q '.statusCheckRollup[] | select(.name=="Type-check & tests") | .conclusion' 2>/dev/null \
      | tail -n1 || true)"
    if [[ "$CHECK" != "SUCCESS" ]]; then
      echo "error: blocking check 'Type-check & tests' is '${CHECK:-not found}', not SUCCESS." >&2
      echo "       wait for it to pass, or re-run with --force to override." >&2
      exit 1
    fi
    echo "✓ blocking check 'Type-check & tests' is green"
  fi
  echo "→ squash-merging PR #$PR"
  # No --delete-branch: that's the footgun (see header). Remote branch is deleted explicitly below.
  gh pr merge "$PR" --squash
  echo "✓ PR #$PR squash-merged"
fi

# Delete the remote branch explicitly (idempotent — a no-op if already gone).
if git -C "$MAIN" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git -C "$MAIN" push origin --delete "$BRANCH"
  echo "✓ remote branch $BRANCH deleted"
else
  echo "→ remote branch $BRANCH already gone"
fi

# Local worktree + branch teardown. rm-worktree.sh's `--force` does double duty — it force-deletes
# the branch (needed: a squash-merge isn't seen as merged by `-d`) AND bypasses its dirty-worktree
# guard. The branch force-delete is safe now the PR is merged; the dirty-worktree bypass is NOT, so
# guard it: refuse a worktree with uncommitted work unless the caller explicitly passed --force.
# Find the worktree's ACTUAL path by asking git for the checkout of $BRANCH — don't reconstruct
# the `acrf-wt-<slug>` convention path, or the guard would silently skip (and still pass --force)
# whenever a worktree sits elsewhere. Empty = no worktree checks out this branch (nothing to lose).
DIR="$(git -C "$MAIN" worktree list --porcelain | awk -v b="refs/heads/$BRANCH" '
  $1=="worktree"{p=substr($0,10)} $1=="branch"&&$2==b{print p; exit}')"
if [[ -z "$FORCE" && -n "$DIR" && -d "$DIR" ]]; then
  # Ignore the node_modules symlink (rm-worktree.sh strips it; the gitignore dir-pattern doesn't
  # match a symlink, so it shows as untracked). Anything else uncommitted is real work.
  DIRTY="$(git -C "$DIR" status --porcelain | grep -v '^?? node_modules$' || true)"
  if [[ -n "$DIRTY" ]]; then
    echo "error: worktree $DIR has uncommitted changes — refusing to force-tear-down (it would discard them):" >&2
    echo "$DIRTY" >&2
    echo "       commit/stash/discard them, or re-run merge-worktree.sh with --force." >&2
    exit 1
  fi
fi
echo "→ tearing down local worktree + branch"
"$SCRIPT_DIR/rm-worktree.sh" "$BRANCH" --force --delete-branch
