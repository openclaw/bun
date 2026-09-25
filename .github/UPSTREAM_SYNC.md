# Upstream sync for the OpenClaw fork

[`sync-upstream.yml`](workflows/sync-upstream.yml) runs daily at 06:17 UTC,
or manually from `main` in `openclaw/bun`. It freezes the fork and upstream
SHAs, merges both into `automation/sync-upstream` through GitHub's merge API,
then opens a draft PR. It does not check out or execute imported source,
change `main`, force-push, merge a PR, build or deploy Bun.

An open sync PR remains frozen, including its head, body and draft state.
Maintainers own conflict resolution, native qualification and landing with a
**merge commit** to retain upstream and contributor history. After landing,
the next run reuses the branch only if its head still matches the merged PR
and is an ancestor of `main`. Unknown or subsequently edited branches stop
the workflow; it never adopts or deletes them.

GitHub's merge API has no expected-base compare-and-swap option. Workflow runs
are serialized, and merges preserve concurrent commits rather than overwrite
them. Final ancestry and returned PR identity checks detect changed results,
but cannot lock out a maintainer editing the branch during the run. Avoid
editing it until the run finishes; inspect and requalify any reported drift.

## First activation and credentials

1. Land the workflow on the fork's `main` after review. A workflow PR alone
   does not activate its schedule.
2. In Actions, choose **Sync upstream for review**, then **Run workflow** on
   `main`. Inspect the job summary. If `main` already contains upstream, the
   expected result is an explicit no-op without a branch or PR write.
3. For the first run with new upstream commits, verify the draft's exact
   head and both frozen ancestors. Approve and inspect its CI, then perform
   the affected native qualification before landing. A successful sync job
   is not build or runtime proof.

The default credential is `GITHUB_TOKEN`, with `contents: write` and
`pull-requests: write`. The repository must allow GitHub Actions to create
pull requests. GitHub documents `Contents: write` for the merge API, but this
does not prove every import can update workflow files with the default token.
Permission failures remain failed runs; no secret or setting is changed.

If GitHub denies an import that changes workflow files, inspect the exact API
error. An authorized maintainer can provision `UPSTREAM_SYNC_TOKEN` as a
fine-grained PAT restricted to `openclaw/bun`, granting **Contents**, **Pull
requests** and **Workflows** write permissions. The optional secret replaces
the default token. `actions: write` does not grant workflow-file write access.
Provisioning or expanding credentials is a separate owner action.

With `GITHUB_TOKEN`, PR opened/synchronize/reopened events create CI runs in
an approval-required state. A maintainer must select **Approve workflows to
run**. An alternate token can trigger CI normally; inspect actual check
states and never count pending or skipped checks as qualification.

Contracts: [GitHub token events](https://docs.github.com/en/actions/concepts/security/github_token),
[merge API](https://docs.github.com/en/rest/branches/branches#merge-a-branch),
[workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).

## Recovery

- **Open PR:** finish that review first. Daily runs report its URL and exact
  head without updating it, even after a maintainer marks it ready.
- **Conflict:** the run fails and retains the review branch. Merge and resolve
  the reported frozen commits manually, preserving both histories, then open
  a review PR from that branch into `main`.
- **Permission or PR creation failure:** the branch may exist without a PR.
  After resolving permissions, inspect its ancestry and open the missing PR
  manually. If it still exactly equals `main` with no unmerged work, an owner
  may remove that exact branch before rerunning. The workflow never does this.
- **Closed without merging:** reopen and resolve the previous review before
  resuming sync. The workflow does not resurrect rejected work automatically.
- **Unknown branch:** inspect its owner and commits. Preserve human work;
  qualify and land its PR, or have its owner explicitly resolve its disposition.

## Validation

Run the focused, dependency-free automation tests and YAML checker:

```sh
node --test .github/scripts/sync-upstream.test.cjs
actionlint .github/workflows/sync-upstream.yml
git diff --check
```

The tests execute the workflow's actual API block against a stateful fake
commit graph. They cover merge ordering and ancestry, frozen PRs, no-op runs,
branch ownership, conflicts and permission failures. They do not prove live
token write permissions. Read-only API checks and the first activated run
are separate evidence; activation must not be described as complete until
that run is observed.
