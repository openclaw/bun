# Releases of the OpenClaw Bun fork

[`openclaw-release.yml`](workflows/openclaw-release.yml) builds a tagged commit
of this fork's `main` in release mode and publishes it as a GitHub release of
`openclaw/bun`. The OpenClaw macOS app embeds the darwin builds; the Tauri
desktop app downloads a pinned build on first start. Both pin a release by its
`manifest.json`.

The workflow's steps are commands of
[`scripts/openclaw-release/release.ts`](../scripts/openclaw-release/release.ts)
(tag names, provisioning, build and packaging, smoke test, manifest) and
[`sign-macos.sh`](../scripts/openclaw-release/sign-macos.sh), so each step can
also run on a Crabbox lease or a maintainer's machine.

## Cutting a release

```sh
git fetch openclaw main
tag=$(bun scripts/openclaw-release/release.ts tag --commit openclaw/main)
git tag -a "$tag" -m "$tag" openclaw/main
git push openclaw "$tag"
```

The tag push runs the workflow of the tagged commit. To build a tag with the
pipeline of another commit (a tag from before a pipeline fix, or before this
workflow reached `main`), dispatch the workflow from that commit's branch with
`tag` and `publish`. Without `tag`, a dispatch builds its ref as a dry run; so
does every pull request that changes the pipeline. A dry run's zips,
`manifest.json` and `SHA256SUMS` are the `release` artifact of the run.

A publish needs every release target to build and pass its smoke test. When a
job fails on a download (provisioning retries four times over about 12
minutes, each in a fresh container), **Re-run failed jobs** keeps the targets
that already built.
Releases are prereleases and not "latest" while
`vars.OPENCLAW_RELEASE_PRERELEASE` is unset or `true`.

Rebuilding a commit that already has a release (a toolchain or pipeline change,
not a source change) gets a new tag with `--rebuild 2` (`…-r2`). Published
assets are never replaced: packagers pin their checksums.

## Tag scheme

```text
openclaw-v<version>-<YYYYMMDD>-<fork commit, 10 hex>-webkit-<WebKit revision, 10 hex>[-r<n>]
openclaw-v1.4.3-20260925-9e3414b3f7-webkit-35e8970dfd
```

- `version` is `package.json`'s: the upstream release this fork's `main` leads up to.
- The date is the commit's committer date in UTC, so later commits sort later.
- The WebKit revision is `WEBKIT_VERSION` of `scripts/build/deps/webkit.ts` at
  that commit, the oven-sh/WebKit build the executables link. For an
  `autobuild-preview-pr-<n>-<sha>` pin it is the previewed commit.

The plan job refuses a tag whose parts disagree with its commit, and refuses to
publish a commit that is not on `main`. `Bun.revision` is the fork commit and
`process.versions.webkit` the WebKit revision; the smoke test checks both in
every executable, so a running runtime identifies its own build.

## What a release contains

| Asset                         | Contents                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun-<os>-<arch>.zip`         | `bun-<os>-<arch>/bun`: the stripped executable, in upstream's layout, so tools that unpack upstream zips (`setup-bun`'s download URL, for one) unpack these |
| `bun-<os>-<arch>-profile.zip` | the unstripped executable with its linker map, and its `.dSYM` on darwin, for symbolicating crashes                                                         |
| `manifest.json`               | what packagers pin (below)                                                                                                                                  |
| `SHA256SUMS`                  | the SHA-256 of every zip and of `manifest.json`, for `sha256sum --check`                                                                                    |

Asset names use upstream's `aarch64`; the manifest's `target` uses Node's
spelling (`darwin-arm64`, `linux-x64`, …). Zips are written with sorted entries
and fixed timestamps, so their bytes depend only on the files in them. The
zips and `manifest.json` carry a [build provenance
attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations):
`gh attestation verify bun-linux-x64.zip -R openclaw/bun`.

`manifest.json` (`schemaVersion: 1`):

```jsonc
{
  "tag": "openclaw-v1.4.3-20260925-9e3414b3f7-webkit-35e8970dfd",
  "bun": {
    "version": "1.4.3",
    "commit": "<40 hex>",
    "commitDate": "20260925",
    "revision": "1.4.3-canary.1+9e3414b3f",
  },
  "webkit": {
    "version": "<40 hex>",
    "repository": "oven-sh/WebKit",
    "prebuilt": "<release URL>",
  },
  "workflowRun": "<run URL>",
  "assets": [
    {
      "target": "darwin-arm64",
      "os": "darwin",
      "arch": "arm64",
      "minimum": "macOS 13.0",
      "name": "bun-darwin-aarch64.zip",
      "url": "…",
      "size": 0,
      "sha256": "<zip>",
      "executable": {
        "path": "bun-darwin-aarch64/bun",
        "size": 0,
        "sha256": "<extracted bun>",
      },
      "debugSymbols": {
        "name": "bun-darwin-aarch64-profile.zip",
        "url": "…",
        "size": 0,
        "sha256": "…",
      },
      "signing": {
        "kind": "developer-id",
        "teamId": "FWJYW4S8P8",
        "notarized": true,
      },
    },
  ],
}
```

A packager pins the zip's `sha256` for the download and `executable.sha256`
for what it embeds or runs, as `openclaw`'s `setup-test-bun` action already
does for the CI build. `libc` (`glibc`/`musl`) is present on Linux entries,
`signing` on darwin ones.

| Target         | Minimum                                  | Smoke-tested on    |
| -------------- | ---------------------------------------- | ------------------ |
| `darwin-arm64` | macOS 13.0                               | `macos-15`         |
| `darwin-x64`   | macOS 13.0, x86-64 with SSE4.2           | `macos-15-intel`   |
| `linux-x64`    | glibc 2.17, x86-64 with SSE4.2 (Nehalem) | `ubuntu-24.04`     |
| `linux-arm64`  | glibc 2.17, ARMv8.0-A                    | `ubuntu-24.04-arm` |

The glibc floor is the symbol-version ceiling the build's binary check enforces
(`scripts/build/binary-expectations.ts`); libstdc++ is linked statically. x64
has one variant: upstream builds every x64 target at the Nehalem baseline.

The smoke test runs the zipped executable on its own platform: `Bun.revision`
and `process.versions.webkit` must match the release, `process.platform` and
`process.arch` the target, and JavaScriptCore's DFG JIT must compile a hot
function. A signature without `allow-jit` does not crash Bun: JSC falls back to
its interpreter, so only the JIT's own compile count shows it. On macOS the test
also verifies the code signature, except on darwin-x64 without a Developer ID,
which upstream links unsigned.

## Building

Every target is cross-compiled on upstream's build image, as upstream's own CI
does (`.buildkite/ci.ts`: one Debian 13 arm64 image builds every platform with
`--target`/`--sysroot`, the macOS SDK fetched from Apple's software-update CDN
and `ld64.lld`). The build job generates that image's `bootstrap.sh` from the
source commit's `scripts/build/ci-images/spec.ts` and runs only its toolchain
sections (packages, Node.js, Bun, Ninja, CMake, LLVM, Rust, and the sysroot or
SDK the target needs) in a `debian:13` container, so the toolchain pins stay in
one place and move with upstream syncs. A unit test fails when upstream renames
one of those sections.

The build is `scripts/build.ts --profile=release --ci=on` with the target's
`--os/--arch/--abi`: ThinLTO across Bun, Rust and the `-lto` WebKit prebuilt,
path remapping, and the binary checks as errors. It links without upstream's
symbol order file (Buildkite publishes that) and without PGO. The version
string keeps upstream's canary suffix (`1.4.3-canary.1+<commit>`): these are
not upstream releases.

### Where the builds run

`vars.OPENCLAW_RELEASE_BUILD_RUNNER` selects the build runner; unset, it is
GitHub's free `ubuntu-24.04-arm`. Measured on the commit of the first release:

| Host                                                                            | Provision | Build (ninja) | Job                 | Cost per release       |
| ------------------------------------------------------------------------------- | --------- | ------------- | ------------------- | ---------------------- |
| GitHub `ubuntu-24.04-arm` (4 vCPU, 16 GB, 108 GB free disk), one job per target | 2–14 min  | 9.0–9.4 min   | 12–25 min           | $0 (public repository) |
| Crabbox `r8g.4xlarge` (16 vCPU, 128 GB), targets one after another              | 2–4.5 min | 4.0–4.5 min   | 20 min for all four | ≈ $0.20 at spot price  |

Every release target's job on GitHub fits in about a quarter of the 340-minute
timeout, with memory and disk to spare (the Crabbox build peaked at 11 GB with
16 jobs). Provisioning time is download time: the slow darwin-x64 job spent
12 minutes fetching Rust's standard libraries for the eleven targets the
upstream image installs. The evaluation targets took longer on GitHub:
windows-x64 17 min to provision (xwin's MSVC and Windows SDK download) plus
12 min of build, musl 4–10 plus 10. Signing, smoke tests and publishing run on
free GitHub-hosted runners too.

GitHub's larger runners, Blacksmith (which `openclaw/openclaw` already uses:
`blacksmith-16vcpu-ubuntu-2404-arm` at about $0.02/min would make a release
cost about $1) or Crabbox as a self-hosted runner would cut the wall-clock
time from about 25 to 10 minutes. None of that is needed for a weekly
release. A self-hosted runner on a public repository would also run
pull-request code.

## macOS signing and notarization

The `sign-macos` job signs both darwin executables with a Developer ID, the
hardened runtime and this repository's `entitlements.plist` (JIT, unsigned
executable memory, library validation off for native addons), notarizes each
zip and records the result in the manifest. A bare executable cannot have a
ticket stapled; Gatekeeper looks the notarization up online by its cdhash.

It reads the secrets the OpenClaw release fleet uses (`openclaw/release-workflows`):
`MACOS_SIGNING_P12`, `MACOS_SIGNING_P12_PASSWORD`, `ASC_KEY_ID`,
`ASC_ISSUER_ID` and `ASC_PRIVATE_KEY_P8`, from the `openclaw-release`
environment when publishing (which can then require an approval) or from the
repository. Pull requests never see them. Without them the executables stay as
upstream links them, darwin-arm64 with an ad-hoc signature and darwin-x64
unsigned, and the manifest says `"kind": "adhoc"` or `"none"` with
`"notarized": false`; setting
`vars.OPENCLAW_RELEASE_REQUIRE_SIGNING` to `true` makes a publish fail
instead. `sign-macos.sh` runs the same way on a maintainer's Mac with the
Foundation identity in the release keychain and `NOTARYTOOL_PROFILE` or the
`NOTARYTOOL_KEY*` variables of `openclaw`'s `scripts/notarize-mac-artifact.sh`.

The Mac app re-signs whatever it embeds (`scripts/codesign-mac-app.sh` in
`openclaw`), so it can embed either kind. Two things there change when it
embeds Bun instead of Node: its list of JIT runtimes needs Bun's path, or Bun
is signed without `allow-jit` and dies at its first JIT compilation, and its
runtime entitlements lack `disable-library-validation`, which Bun needs to load
native addons signed by another team.

## Other targets

**musl** (`linux-x64-musl`, `linux-arm64-musl`) builds from the same image with
Alpine 3.23 sysroots and is smoke-tested in an `alpine:3.23` container. A
dispatch builds it with `targets`. It is not a release target because no
OpenClaw consumer runs on musl: the desktop app targets glibc distributions and
the Docker image is Debian-based. The executable needs `libstdc++` and
`libgcc` from the distribution, like upstream's. Adding it to every release
costs two more build jobs.

**windows-x64** also builds from the same image (xwin's MSVC CRT and Windows
SDK, `lld-link`); a dispatch builds and smoke-tests it on `windows-2025`. A
release target additionally needs Authenticode signing, which upstream does
with DigiCert KeyLocker on a Windows agent: a certificate (a cloud-HSM-backed
OV certificate, or Azure Trusted Signing) and a signing job on a Windows
runner. Unsigned executables meet SmartScreen warnings and antivirus false
positives. The Tauri app's Windows runtime install is still a stub.

## WebKit

Releases link the oven-sh/WebKit prebuilt that `WEBKIT_VERSION` pins, the same
one upstream Bun ships. The pipeline builds no WebKit. A JavaScriptCore fix
reaches a release in one of three ways:

1. It lands in oven-sh/WebKit `main`: pin its `autobuild-<sha>` (upstream Bun
   usually does within days, and an upstream sync brings the pin along).
2. It is an open oven-sh/WebKit pull request from a branch of that repository:
   its `autobuild-preview-pr-<n>-<sha>` prebuilt can be pinned. A preview is
   built on the pull request's base, which can be weeks behind `main`.
3. Neither: the fork needs its own WebKit prebuilts (see decisions below).

The current OpenClaw CI build (`steipete/bun` `openclaw-ci-ddfce5d0-webkit-4429d113`)
carries the FTL fix of oven-sh/WebKit#578 on a local WebKit build. That pull
request is still open and its preview is 392 commits behind the pinned
`35e8970`, so releases of this fork do not have that fix yet.

## Upstream sync and security patches

Releases ride the [upstream sync](UPSTREAM_SYNC.md). The daily sync opens a
frozen draft PR; a maintainer qualifies and lands it with a merge commit. To
qualify a sync PR's release build, dispatch this workflow on
`automation/sync-upstream` without a tag: it builds and smoke-tests every
target as a dry run.

- **Routine:** land one upstream sync a week, then tag `main` once the fork's
  own CI is green. The weekly release brings upstream's WebKit bumps along
  (57 between July and September 2026, several a week lately); the fork does
  not bump WebKit on its own. OpenClaw moves its pins in its own pull requests,
  against its own CI.
- **Bun security fix upstream:** within one working day for high or critical
  issues. When the pending sync is otherwise ready, land it and release;
  otherwise cherry-pick the fix onto `main` in a pull request titled after the
  upstream one (`fix(security): backport oven-sh/bun#<n>`), then release. The
  next sync merges the upstream commit without conflict.
- **JavaScriptCore security fix:** once upstream Bun pins a WebKit containing
  it, sync or cherry-pick that pin bump (with the bindings changes it came
  with). If only oven-sh/WebKit has it, pin its `autobuild-<sha>` in a fork
  pull request and qualify with a dry run: pins are not ABI-stable, so a bump
  that needs bindings changes waits for upstream's. A fix only in WebKit
  proper, not in oven-sh/WebKit, needs route 3 above.
- **Vendored dependencies** (BoringSSL, c-ares, libuv, zlib, SQLite, …): the
  `update-*` workflows only run in `oven-sh/bun`; the fork gets those updates
  through syncs, or by cherry-picking the upstream update commit.
- **Watch:** oven-sh/bun security advisories and releases, oven-sh/WebKit
  `main`, and WebKit's security updates. Retire a release with a known
  vulnerability by publishing its successor and moving OpenClaw's pins; do not
  delete it, since pinned consumers would break instead of upgrading.

## Decisions this pipeline leaves open

1. **Where macOS signing keys may live.** `openclaw/bun` holds no signing
   secrets, so darwin assets ship as upstream links them (arm64 ad-hoc signed,
   x64 unsigned) and are not notarized. The options are to (a) add
   the fleet's five secrets to an `openclaw-release` environment of this
   repository, limited to `openclaw-v*` tags, and set
   `OPENCLAW_RELEASE_REQUIRE_SIGNING`; (b) keep the Developer ID
   in `openclaw/releases` and sign darwin assets there before publishing; or
   (c) stay as linked: the Mac app re-signs, and the Tauri app's own downloads
   carry no quarantine attribute, but anything downloaded by a browser is
   refused by Gatekeeper. Recommended: (a).
2. **Whether the fork builds its own WebKit.** Until oven-sh/WebKit#578 lands,
   releases lack the FTL fix the current OpenClaw CI build carries, so
   switching `setup-test-bun` to these releases brings back the CSS tokenizer
   loop. The options are to push #578 upstream and wait, or run an
   `openclaw/WebKit` fork that builds the release lanes (linux and macOS lto,
   and later musl and Windows). oven-sh/WebKit builds a lane in 4–15 minutes on
   32-core runners that a fork cannot use; on GitHub larger runners (Team
   plan) that is a few dollars per WebKit revision. `webkit.ts` would also have
   to take the prebuilt repository from a constant, a small fork-only change.
3. **Build runner.** Recommended: keep GitHub's free runners. Change
   `vars.OPENCLAW_RELEASE_BUILD_RUNNER` only if release latency matters.
4. **Release visibility.** Releases are prereleases and never "latest" until
   `vars.OPENCLAW_RELEASE_PRERELEASE` is `false`.
5. **Tag protection.** A ruleset on `openclaw-v*` tags (creation by
   maintainers, no updates or deletions) keeps a published release's tag from
   moving. The publish job refuses a moved tag, but only while it runs.
6. **musl and Windows.** musl is left out of releases until a consumer needs
   it; windows-x64 waits for an Authenticode certificate.
7. **Cadence.** Weekly releases after the upstream sync; security fixes within
   a working day (above).
8. **A cached builder image.** Provisioning downloads from a dozen hosts on
   every job, and one of them (`apt.llvm.org`) has failed a job's attempts for
   minutes at a time. Pushing the provisioned container to
   `ghcr.io/openclaw/bun-release-builder:<hash of the provisioning script>`
   once per toolchain change, and pulling it afterwards, would take those
   hosts out of every other release and cut about 2–14 minutes per job. It is
   free for a public package but adds a package to the organization and
   `packages: write` to the build job.

## Validation

```sh
bun test test/internal/source-lints/openclaw-release.test.ts
actionlint .github/workflows/openclaw-release.yml
shellcheck scripts/openclaw-release/sign-macos.sh
```

The unit tests cover tag names, provisioning against the generated upstream
bootstrap, manifest contents and zip reproducibility. A build is only proven
by a run of the workflow: every pull request that changes the pipeline builds
and smoke-tests all release targets.
