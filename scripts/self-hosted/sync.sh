#!/usr/bin/env bash
# Rebases main's fork commits onto upstream's latest release, pushes the result
# to self-hosted-sync and opens or updates its pull request into main: the
# state machine .woodpecker/self-hosted-sync.yaml runs. Run it from a copy
# outside the work tree, since the rebase rewrites this file.
#
# Env: STATE_DIR (stage, tag, start and result for the failure report; `stage`
# names the operation that was running when the script died), PUSH_URL
# (authenticated remote URL), and github.mjs's App variables.
set -euo pipefail

branch=main
sync_branch=self-hosted-sync
upstream_url=https://github.com/wdl-dev/wdl.git
scripts="$(cd "$(dirname "$0")" && pwd)"
state_dir="${STATE_DIR:?}"
mkdir -p "$state_dir"

tag="" start="" result="" state="" pull=""
record() { printf '%s' "$2" > "$state_dir/$1"; }
enter() { record stage "$1"; }
finish() {
  echo "state=$state tag=$tag start=$start result=$result pull=$pull"
  exit 0
}

# Two rebases of the same commits onto the same release differ only in
# committer metadata; keeping the pushed one leaves the pull request untouched.
same_rebase() {
  [[ "$(git rev-parse "$1^{tree}")" == "$(git rev-parse "$2^{tree}")" ]] &&
    [[ "$(git merge-base "$1" refs/remotes/upstream/release)" == "$release" ]] &&
    diff -q <(git log --format='%an %ae %at %s' "$release..$1") \
      <(git log --format='%an %ae %at %s' "$release..$2") > /dev/null
}

# Each upstream release moves CHANGELOG.md's `## Unreleased` entries under its
# own heading, so a fork commit that adds an Unreleased entry conflicts on
# every release. When that commit only adds lines there, its entries go back
# on top of upstream's Unreleased section; any other conflict leaves the
# rebase stopped for a repair run.
resolve_changelog() {
  local conflicted commit added
  conflicted="$(git diff --name-only --diff-filter=U)"
  [[ "$conflicted" == CHANGELOG.md ]] || return 1
  commit="$(git rev-parse REBASE_HEAD)"
  if git diff "$commit^" "$commit" -- CHANGELOG.md | grep -q '^-[^-]'; then return 1; fi
  added="$state_dir/changelog-added"
  git diff "$commit^" "$commit" -- CHANGELOG.md | sed -n 's/^+\([^+].*\)$/\1/p' > "$added"
  [[ -s "$added" ]] || return 1
  git show :2:CHANGELOG.md | awk -v added="$added" '
    function entries(line) { while ((getline line < added) > 0) print line }
    done { print; next }
    /^## Unreleased[[:space:]]*$/ { print; print ""; entries(); inside = 1; next }
    inside && /^## / { print ""; print; inside = 0; done = 1; next }
    inside && /^[[:space:]]*$/ { next }
    { print }
    END { if (inside) print ""; if (!done && !inside) exit 1 }
  ' > CHANGELOG.md.resolved || return 1
  mv CHANGELOG.md.resolved CHANGELOG.md
  git add CHANGELOG.md
}

rebase_onto() {
  git rebase --onto "$1" "$2" && return 0
  while resolve_changelog; do
    GIT_EDITOR=true git rebase --continue && return 0
  done
  return 1
}

enter resolve
tag="$(node "$scripts/github.mjs" release)"
record tag "$tag"
git fetch --no-tags origin "+refs/heads/$branch:refs/remotes/origin/$branch"
start="$(git rev-parse "refs/remotes/origin/$branch")"
record start "$start"
git fetch --no-tags "$upstream_url" "+refs/heads/main:refs/remotes/upstream/main" \
  "+refs/tags/$tag:refs/remotes/upstream/release"
release="$(git rev-parse 'refs/remotes/upstream/release^{commit}')"
base="$(git merge-base "$start" refs/remotes/upstream/main)"
result="$start"
record result "$result"

if [[ "$release" == "$base" ]]; then
  enter close
  state="NOOP(current)"
  pull="$(node "$scripts/github.mjs" close-pull-request "$branch already follows $tag at ${start:0:12}.")"
  finish
fi
if git merge-base --is-ancestor "$release" "$base"; then
  state="NOOP(older)"
  finish
fi

enter rebase
git checkout -q --detach "$start"
rebase_onto "$release" "$base"
result="$(git rev-parse HEAD)"
record result "$result"

enter push
lease="$(git ls-remote origin "refs/heads/$sync_branch" | cut -f1)"
if [[ -n "$lease" ]]; then
  git fetch --no-tags origin "+refs/heads/$sync_branch:refs/remotes/origin/$sync_branch"
fi
if [[ -n "$lease" ]] && same_rebase "$lease" "$result"; then
  result="$lease"
  record result "$result"
  state="NOOP(pushed)"
else
  git push --force-with-lease="$sync_branch:$lease" "${PUSH_URL:?}" "$result:refs/heads/$sync_branch"
  state=PUSHED
fi

enter pull-request
body="$state_dir/pull-request.md"
{
  echo "Rebases \`$branch\`'s fork commits onto upstream release [\`$tag\`](https://github.com/wdl-dev/wdl/releases/tag/$tag)."
  echo
  echo "| | |"
  echo "| --- | --- |"
  echo "| \`$branch\` | \`$start\` |"
  echo "| Old upstream base | \`$base\` |"
  echo "| New upstream base | \`$release\` |"
  echo "| Result | \`$result\` |"
  echo
  echo "### New upstream commits"
  echo
  git log --reverse --format='- %h %s' "$base..$release"
  echo
  echo "### Fork commits"
  echo
  git log --reverse --format='- %h %s' "$release..$result"
  echo
  echo "### Merging"
  echo
  echo "GitHub's merge buttons cannot merge a rebase. Point \`$branch\` at the result instead, leased on the \`$branch\` this sync started from; GitHub then marks this pull request merged:"
  echo
  echo '```sh'
  echo "git fetch origin $sync_branch"
  echo "git push --force-with-lease=$branch:$start origin $result:refs/heads/$branch"
  echo '```'
  echo
  echo "The lease fails if \`$branch\` moved since this sync ran; the next sync rebases the new \`$branch\` and updates this pull request. Deploying still takes a \`wdl.YYYYMMDD.N\` tag and the image digests in clusters-work."
} > "$body"
pull="$(node "$scripts/github.mjs" pull-request "chore: sync upstream $tag" "$body")"
finish
