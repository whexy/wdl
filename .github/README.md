# whexy/wdl

A fork of [wdl-dev/wdl](https://github.com/wdl-dev/wdl) that runs the staging
WDL in Wenxuan's cluster. Upstream's own README is [`README.md`](../README.md).

`main` is an upstream release with the fork's commits on top. Upstream updates
come in by rebase, never by merge, so `main` is rewritten and anything that
consumes the fork pins a commit or a tag.

## What the fork adds

| Path                                                               | What                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| [`.woodpecker/images.yaml`](../.woodpecker/images.yaml)            | Builds the images to the private `ghcr.io/whexy/wdl-{workerd,rust}` |
| [`.woodpecker/self-hosted-sync.yaml`](../.woodpecker/self-hosted-sync.yaml), [`scripts/self-hosted/`](../scripts/self-hosted) | Rebases `main` onto each upstream release      |
| Runtime and DO fixes                                               | Fork commits on `main`; each sync pull request lists them           |

GitHub Actions is turned off for the repository: upstream's
[`release.yml`](workflows/release.yml) would publish to Docker Hub on the
same `wdl.*` tags the fork pushes. All of the fork's CI runs on Woodpecker.

## Ship a change

1. Land the commit on `main`. Keep fork code in new files where possible:
   every edit to an upstream file is a future rebase conflict.
2. Tag `main` as `wdl.YYYYMMDD.N` and push the tag. `images.yaml` builds and
   publishes both images under that tag.
3. In clusters-work, set the base `ref` and both image digests in
   `gitops/apps/wdl/kustomization.yaml` (its `docs/wdl.md` has the upgrade
   steps).

## Follow upstream

The Woodpecker cron `self-hosted-sync` runs daily on `main`. When upstream has
published a release past `main`'s base, it rebases `main`'s fork commits onto
the release, pushes the result to `self-hosted-sync` as the whexy-bot App, and
opens or updates the pull request `chore: sync upstream <release>`.

GitHub's merge buttons cannot merge a rebase. To take the sync, run the leased
command in the pull request's body, which points `main` at the result; GitHub
then marks the pull request merged. The lease fails if `main` moved, and the
next sync rebases the new `main`. Taking a sync deploys nothing until you tag
it (step 2 above).

Each run logs one line, `state=PUSHED`, `NOOP(current|older|pushed)` or
`FAILED(<stage>)`, with the release and the start and result commits. Run a
sync by hand with `woodpecker-cli pipeline create whexy/wdl --branch main`.

## When a sync fails

A failed sync posts to the Woodpecker secret `t3_repair_webhook`, the webhook
of the T3 Code scheduled task "Repair a failed WDL fork upstream sync" (host
mudd, project WDL). The task replays the rebase in a scratch worktree,
resolves conflicts, runs upstream's checks, and pushes the repair to
`self-hosted-sync` and its pull request, never to `main`. It messages Wenxuan
on WeChat when it cannot repair the branch.

A fork commit that only adds `## Unreleased` entries to `CHANGELOG.md`
conflicts on every upstream release. The sync settles those conflicts itself
by putting the fork's entries back on top of the Unreleased section.

The task, its project and the secret are tied together. Recreating the task
gives it a new webhook URL, which has to go into `t3_repair_webhook` again.
