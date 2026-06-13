#!/usr/bin/env bash
# new-worktree.sh — spin up a gate-ready, isolated git worktree for parallel agent work.
#
# WHY: one repo = one HEAD = one index = one working tree. Two agents in the SAME checkout
# collide — agent B's `git checkout -b` makes agent A's next `git commit` land on B's branch,
# and A's `git push` ships a stale base (see the `shared-worktree-head-collision` scar). The
# fix is one checkout per agent. This script removes the three frictions that otherwise make
# a fresh worktree fail the gate: (1) no node_modules, (2) bun not on the non-interactive PATH,
# (3) remembering the teardown. Mirrors the `run-codex.sh` precedent — invoke by path, not via
# package.json (this is dev workflow, not shipped product).
#
# Usage:
#   .claude/skills/delegate-implement/new-worktree.sh <branch> [base]
#     <branch>  full branch name, house convention <backend>/<issue#>-<slug>
#               e.g. sonnet/142-structured-reader
#     [base]    branch to fork from (default: main)
#
# Example:
#   .claude/skills/delegate-implement/new-worktree.sh sonnet/142-foo
#   -> creates ../acrf-wt-sonnet-142-foo, node_modules symlinked, ready for `bun run gate`.
#
# Run from anywhere inside the main checkout. Tear down with rm-worktree.sh when the PR merges.
set -euo pipefail

BRANCH="${1:-}"
BASE="${2:-main}"

if [[ -z "$BRANCH" ]]; then
  echo "usage: new-worktree.sh <branch> [base]   (e.g. sonnet/142-foo main)" >&2
  exit 2
fi

# Resolve the MAIN checkout even when invoked from inside a linked worktree:
# --git-common-dir points at the shared .git (the main worktree's), so its parent IS the main
# checkout. (--show-toplevel would return the *current* worktree's root — wrong from a worktree.)
MAIN="$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")"
PARENT="$(dirname "$MAIN")"
# Sanitize slashes so the dir name is flat and predictable.
SLUG="$(printf '%s' "$BRANCH" | tr '/' '-')"
DIR="$PARENT/acrf-wt-$SLUG"

if [[ -e "$DIR" ]]; then
  echo "error: $DIR already exists — pick another branch or remove it first." >&2
  exit 1
fi

if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "error: branch '$BRANCH' already exists. Use rm-worktree.sh or pick a new name." >&2
  exit 1
fi

echo "→ creating worktree $DIR  (branch $BRANCH off $BASE)"
git -C "$MAIN" worktree add -b "$BRANCH" "$DIR" "$BASE"

# A fresh worktree has no deps; the gate needs them. Symlink the main checkout's node_modules
# (bun tolerates a symlinked node_modules) — instant vs a full `bun install`.
if [[ -d "$MAIN/node_modules" ]]; then
  ln -s "$MAIN/node_modules" "$DIR/node_modules"
  echo "→ symlinked node_modules → $MAIN/node_modules"
else
  echo "warning: $MAIN/node_modules absent — run 'bun install' before the gate." >&2
fi

cat <<EOF

✓ Worktree ready. Point an agent (or a new Claude Code / Codex session) at it with:

    export PATH="\$HOME/.bun/bin:\$PATH"
    cd "$DIR"
    bun run gate    # verify it's green before starting

Branch:   $BRANCH  (off $BASE)
Teardown: .claude/skills/delegate-implement/rm-worktree.sh $BRANCH
EOF
