#!/usr/bin/env bash
# Moves the fork's overlay (origin/main minus upstream/main) onto the current
# upstream/main, locally, and checks the result. Pushing is left to a person:
# the script prints the commands, because it rewrites the fork's main.
#
# USAGE: perf/sync-upstream.sh <branch>
#   <branch>  a local branch to create at the rebased overlay, e.g. sync/main
#
# Rebase, not merge: the overlay stays a linear list (`upstream/main..main`)
# whose library commits can each be cherry-picked onto upstream. An overlay
# commit that upstream has meanwhile taken in identical form is dropped by the
# rebase itself; one taken in another form conflicts and is resolved by hand.
# After pushing, re-run bench-aa: the base changed, so must the calibration.
set -euo pipefail

branch=${1:?usage: perf/sync-upstream.sh <branch>}
repo_root=$(git rev-parse --show-toplevel)

git fetch upstream --quiet
git fetch origin --quiet
old_main=$(git rev-parse origin/main)
old_base=$(git merge-base upstream/main origin/main)
new_base=$(git rev-parse upstream/main)

if [[ $old_base == "$new_base" ]]; then
  echo "origin/main already sits on upstream/main ($new_base); nothing to do"
  exit 0
fi

echo "overlay: $(git rev-list --count "$old_base..origin/main") commits on ${old_base:0:10}"
echo "upstream/main: $(git rev-list --count "$old_base..upstream/main") new commits, now ${new_base:0:10}"

# The rebase runs in a temporary worktree of its own, so the caller's working
# tree (which may hold uncommitted work) is never touched.
tmp="$HOME/.cache/agent-work/protobuf-es/sync-worktree"
if [[ -e $tmp ]]; then
  echo "a previous sync worktree still exists: $tmp (git worktree remove it first)" >&2
  exit 1
fi
git branch "$branch" origin/main
git worktree add --quiet "$tmp" "$branch"
if ! git -C "$tmp" rebase --onto upstream/main "$old_base" "$branch"; then
  echo "rebase stopped on a conflict; resolve it in $tmp, then 'git rebase --continue' there" >&2
  exit 1
fi
git worktree remove "$tmp"

# Each overlay commit (one squash-merged pull request) must still be of one
# kind; the overlay as a whole holds both kinds by design.
while read -r sha; do
  if ! "$repo_root/perf/overlay-paths.sh" "$sha^" "$sha" > /dev/null; then
    echo "overlay commit $sha mixes library and tooling changes or touches upstream files" >&2
    exit 1
  fi
done < <(git rev-list --reverse "upstream/main..$branch")

cat <<EOF

Rebased overlay is on '$branch'. Before pushing:
  perf/check.sh $branch --label sync-${new_base:0:10}
Then, with the owner's approval:
  git push --force-with-lease=main:$old_main origin $branch:main
and rebase any open pull request branch:
  git rebase --onto origin/main $old_main <pr-branch>
  git push --force-with-lease origin <pr-branch>
and run bench-aa on main.
EOF
