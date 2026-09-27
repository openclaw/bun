#!/usr/bin/env bun
/**
 * Release pipeline of the OpenClaw Bun fork: tag names, host provisioning,
 * release builds, packaging, smoke checks and the manifest app packagers pin.
 * `.github/OPENCLAW_RELEASE.md` describes the pipeline; the workflow is
 * `.github/workflows/openclaw-release.yml`.
 *
 *   bun scripts/openclaw-release/release.ts tag [--commit <rev>] [--rebuild <n>]
 *   bun scripts/openclaw-release/release.ts plan [--tag <tag>] [--publish]
 *   bun scripts/openclaw-release/release.ts provision --source <dir> --target <t>...
 *   bun scripts/openclaw-release/release.ts build --source <dir> --target <t> --out <dir>
 *   bun scripts/openclaw-release/release.ts smoke --zip <zip> --target <t> --commit <sha> --webkit <sha>
 *   bun scripts/openclaw-release/release.ts manifest --dist <dir> --tag <tag> --commit <sha> --out <dir>
 *
 * Every command takes `--source <dir>`, the checkout of the commit being
 * released (default: the current directory). The pipeline's own code can come
 * from a different commit than the source it builds: a dispatch from `main`
 * can rebuild an older tag.
 */

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export type TargetName =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-arm64"
  | "linux-x64-musl"
  | "linux-arm64-musl"
  | "windows-x64";

export interface Target {
  name: TargetName;
  os: "darwin" | "linux" | "windows";
  /** Node's `process.arch` spelling. */
  arch: "arm64" | "x64";
  /** scripts/build.ts `--arch`. */
  buildArch: "aarch64" | "x64";
  abi?: "gnu" | "musl" | undefined;
  /** Upstream's artifact name (scripts/build/ci.ts computeBunTriplet); the zips use it so tools that unpack upstream zips unpack these. */
  triplet: string;
  exe: string;
  /** Sections of the upstream build image's bootstrap.sh this target needs beyond the common toolchain. */
  sysroots: readonly string[];
  /** Built by a tag push. The others are built only when a dispatch names them. */
  release: boolean;
  /** GitHub-hosted runner (and container) that runs the executable for the smoke test. */
  smoke: { runner: string; container?: string };
}

const alpine = "alpine:3.23";

export const targets: Record<TargetName, Target> = {
  "darwin-arm64": target("darwin-arm64", "darwin", "arm64", undefined, ["macos-sdk"], true, { runner: "macos-15" }),
  "darwin-x64": target("darwin-x64", "darwin", "x64", undefined, ["macos-sdk"], true, { runner: "macos-15-intel" }),
  "linux-x64": target("linux-x64", "linux", "x64", "gnu", ["glibc-sysroot"], true, { runner: "ubuntu-24.04" }),
  "linux-arm64": target("linux-arm64", "linux", "arm64", "gnu", ["glibc-sysroot"], true, {
    runner: "ubuntu-24.04-arm",
  }),
  "linux-x64-musl": target("linux-x64-musl", "linux", "x64", "musl", ["musl-sysroot"], false, {
    runner: "ubuntu-24.04",
    container: alpine,
  }),
  "linux-arm64-musl": target("linux-arm64-musl", "linux", "arm64", "musl", ["musl-sysroot"], false, {
    runner: "ubuntu-24.04-arm",
    container: alpine,
  }),
  "windows-x64": target("windows-x64", "windows", "x64", undefined, ["windows-sysroot"], false, {
    runner: "windows-2025",
  }),
};

function target(
  name: TargetName,
  os: Target["os"],
  arch: Target["arch"],
  abi: Target["abi"],
  sysroots: readonly string[],
  release: boolean,
  smoke: Target["smoke"],
): Target {
  const buildArch = arch === "arm64" ? "aarch64" : "x64";
  const triplet = `bun-${os}-${buildArch}${abi === "musl" ? "-musl" : ""}`;
  const exe = os === "windows" ? "bun.exe" : "bun";
  return { name, os, arch, buildArch, abi, triplet, exe, sysroots, release, smoke };
}

export const releaseTargets: readonly TargetName[] = (Object.keys(targets) as TargetName[]).filter(
  name => targets[name].release,
);

/** The workflow's matrix entries. Darwin executables are smoke-tested from the signing job's artifact. */
export function matrix(names: readonly TargetName[]) {
  return names.map(name => {
    const t = targets[name];
    return {
      target: name,
      triplet: t.triplet,
      runner: t.smoke.runner,
      container: t.smoke.container ?? "",
      artifact: `${t.os === "darwin" ? "signed" : "build"}-${name}`,
    };
  });
}

export function parseTargets(list: string): TargetName[] {
  const names = list
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!(name in targets)) throw new Error(`unknown target ${name}; known: ${Object.keys(targets).join(", ")}`);
  }
  return [...new Set(names)] as TargetName[];
}

// ───────────────────────────────────────────────────────────────────── tags

/**
 * `openclaw-v<bun version>-<commit date>-<bun commit>-webkit-<webkit revision>[-r<n>]`, e.g.
 * `openclaw-v1.4.3-20260925-9e3414b3f7-webkit-35e8970dfd`. The date is the commit's committer date in UTC, so tags of
 * later commits sort later; `-r<n>` rebuilds a commit that was already released.
 */
export const tagPattern =
  /^openclaw-v(?<version>\d+\.\d+\.\d+)-(?<date>\d{8})-(?<commit>[0-9a-f]{10})-webkit-(?<webkit>[0-9a-f]{8,12})(?:-r(?<rebuild>[2-9]|[1-9]\d+))?$/;

export interface TagParts {
  version: string;
  date: string;
  commit: string;
  webkit: string;
  rebuild?: number | undefined;
}

export function parseTag(tag: string): TagParts {
  const match = tagPattern.exec(tag);
  if (!match?.groups) {
    throw new Error(
      `${tag} is not a release tag: expected openclaw-v<version>-<YYYYMMDD>-<10 hex commit>-webkit-<webkit revision>[-r<n>]`,
    );
  }
  const { version, date, commit, webkit, rebuild } = match.groups as {
    version: string;
    date: string;
    commit: string;
    webkit: string;
    rebuild?: string;
  };
  return { version, date, commit, webkit, ...(rebuild ? { rebuild: Number(rebuild) } : {}) };
}

export function formatTag(parts: TagParts): string {
  const rebuild = parts.rebuild && parts.rebuild > 1 ? `-r${parts.rebuild}` : "";
  return `openclaw-v${parts.version}-${parts.date}-${parts.commit.slice(0, 10)}-webkit-${webkitTagPart(parts.webkit)}${rebuild}`;
}

/**
 * The WebKit part of a tag. `WEBKIT_VERSION` is a 40-hex commit of oven-sh/WebKit, or an
 * `autobuild-preview-pr-<n>-<8 hex>` tag whose trailing hex is the previewed commit.
 */
export function webkitTagPart(webkitVersion: string): string {
  const hex = /([0-9a-f]{8,40})$/.exec(webkitVersion)?.[1];
  if (!hex) throw new Error(`cannot derive a WebKit revision from WEBKIT_VERSION ${webkitVersion}`);
  return hex.slice(0, 10);
}

/** The oven-sh/WebKit release a WEBKIT_VERSION downloads from (scripts/build/deps/webkit.ts prebuiltUrl). */
export function webkitReleaseTag(webkitVersion: string): string {
  return webkitVersion.startsWith("autobuild-") ? webkitVersion : `autobuild-${webkitVersion}`;
}

// ────────────────────────────────────────────────────────────── the source

export interface SourceFacts {
  commit: string;
  /** Committer date of the commit, UTC, YYYYMMDD. */
  date: string;
  version: string;
  webkitVersion: string;
}

export function sourceFacts(source: string, rev = "HEAD"): SourceFacts {
  const commit = git(source, "rev-parse", "--verify", `${rev}^{commit}`);
  const epoch = Number(git(source, "log", "-1", "--format=%ct", commit));
  const date = new Date(epoch * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  const pkg = JSON.parse(git(source, "show", `${commit}:package.json`)) as { version: string };
  const webkitVersion = parseWebkitVersion(git(source, "show", `${commit}:scripts/build/deps/webkit.ts`));
  return { commit, date, version: pkg.version, webkitVersion };
}

export function parseWebkitVersion(webkitTs: string): string {
  const version = /export const WEBKIT_VERSION = "([^"]+)"/.exec(webkitTs)?.[1];
  if (!version) throw new Error("scripts/build/deps/webkit.ts has no WEBKIT_VERSION");
  return version;
}

export function tagFor(facts: SourceFacts, rebuild?: number): string {
  return formatTag({
    version: facts.version,
    date: facts.date,
    commit: facts.commit,
    webkit: facts.webkitVersion,
    rebuild,
  });
}

/** Every way a tag can disagree with the commit it points at. */
export function tagMismatches(tag: string, facts: SourceFacts): string[] {
  const parts = parseTag(tag);
  const problems: string[] = [];
  if (!facts.commit.startsWith(parts.commit))
    problems.push(`tag names commit ${parts.commit}, points at ${facts.commit}`);
  if (parts.version !== facts.version)
    problems.push(`tag names version ${parts.version}, package.json has ${facts.version}`);
  if (parts.date !== facts.date) problems.push(`tag names date ${parts.date}, the commit is dated ${facts.date}`);
  if (parts.webkit !== webkitTagPart(facts.webkitVersion)) {
    problems.push(`tag names WebKit ${parts.webkit}, scripts/build/deps/webkit.ts pins ${facts.webkitVersion}`);
  }
  return problems;
}

// ───────────────────────────────────────────────────────────── provisioning

/** The upstream build image every target is cross-compiled on (.buildkite/ci.ts buildHostPlatform). */
const buildImageKey = "linux-aarch64-debian";

/** Sections of its bootstrap.sh every build needs. The rest set up a Buildkite agent, services and caches. */
const commonSections = ["packages", "agent-account", "nodejs", "bun", "bun-ninja", "cmake", "llvm", "rust"];

export function sectionsFor(names: readonly TargetName[]): string[] {
  const extra = new Set(names.flatMap(name => targets[name].sysroots));
  return [...commonSections, ...extra];
}

/** Splits a generated bootstrap.sh at its `# ---- <tool>` banners. */
export function splitBootstrap(script: string): { header: string; sections: Map<string, string> } {
  const parts = script.split(/^(?=# ---- )/m);
  const header = parts.shift() ?? "";
  const sections = new Map<string, string>();
  for (const part of parts) {
    const name = /^# ---- (\S+)/.exec(part)![1]!;
    sections.set(name, part);
  }
  return { header, sections };
}

export function provisionScript(bootstrap: string, wanted: readonly string[]): string {
  const { header, sections } = splitBootstrap(bootstrap);
  const missing = wanted.filter(name => !sections.has(name));
  if (missing.length) {
    throw new Error(
      `the ${buildImageKey} bootstrap has no section ${missing.join(", ")}; scripts/build/ci-images/spec.ts changed, update sectionsFor()`,
    );
  }
  // Kept in the bootstrap's order, which is the order its tools depend on each other.
  const kept = [...sections].filter(([name]) => wanted.includes(name)).map(([, body]) => body);
  return [header, ...kept].join("");
}

/**
 * Generates the upstream build image's bake directory in `source` and writes a provisioning script next to its
 * bootstrap.sh (which the macos-sdk section needs, for xmac.mjs). Returns the script's path.
 */
export function provision(source: string, names: readonly TargetName[]): string {
  const generated = run(["bun", join(source, "scripts/build/ci-images/spec.ts"), buildImageKey], { cwd: source });
  const directory = generated.trim().split(/\s+/)[1];
  if (!directory || !existsSync(join(directory, "bootstrap.sh"))) {
    throw new Error(`spec.ts did not generate ${buildImageKey}: ${generated}`);
  }
  const out = join(directory, "openclaw-provision.sh");
  writeFileSync(out, provisionScript(readFileSync(join(directory, "bootstrap.sh"), "utf8"), sectionsFor(names)));
  return out;
}

// ──────────────────────────────────────────────────────────────── building

export function buildArgs(t: Target, buildDir: string): string[] {
  return [
    "scripts/build.ts",
    "--profile=release",
    // Reproducibility flags of CI builds (path remapping) and fatal binary checks, without Buildkite's packaging.
    "--ci=on",
    `--os=${t.os}`,
    `--arch=${t.buildArch}`,
    ...(t.os === "linux" ? [`--abi=${t.abi}`] : []),
    `--build-dir=${buildDir}`,
  ];
}

/** Builds one target and packages `<triplet>.zip` and `<triplet>-profile.zip` into `out`. */
export function build(source: string, name: TargetName, out: string, mtime: number): void {
  const t = targets[name];
  const buildDir = join(source, "build", `openclaw-${name}`);
  const started = Date.now();
  run(["bun", ...buildArgs(t, buildDir)], { cwd: source, stdio: "inherit" });
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`openclaw-release: ${name} built in ${minutes} min`);

  mkdirSync(out, { recursive: true });
  const stripped = join(buildDir, t.exe);
  const profile = join(buildDir, t.os === "windows" ? "bun-profile.exe" : "bun-profile");
  const debugInfo = [
    `${profile}.dSYM`,
    join(buildDir, "bun-profile.pdb"),
    join(buildDir, "bun-profile.linker-map"),
    join(buildDir, "features.json"),
  ].filter(existsSync);
  zip(join(out, `${t.triplet}.zip`), t.triplet, [stripped], mtime);
  zip(join(out, `${t.triplet}-profile.zip`), `${t.triplet}-profile`, [profile, ...debugInfo], mtime);
  writeFileSync(
    join(out, `${name}.build.json`),
    JSON.stringify({ target: name, buildMinutes: Number(minutes), host: hostDescription() }, null, 2) + "\n",
  );
}

function hostDescription(): string {
  const cpus = run(["nproc"], {}).trim();
  const mem = /MemTotal:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
  return `${process.platform}-${process.arch}, ${cpus} CPUs, ${mem ? Math.round(Number(mem) / 1048576) : "?"} GiB`;
}

/**
 * A zip whose one top-level directory is `dir`, like upstream's (scripts/build/ci.ts makeZip), and whose bytes depend
 * only on the files: entries are sorted, stamped with `mtime` (seconds since the epoch) and written in UTC, since zip
 * stores local time, and `-X` leaves out the owner and access-time fields.
 */
export function zip(path: string, dir: string, files: string[], mtime: number): void {
  const stage = mkdtempSync(join(tmpdir(), "openclaw-zip-"));
  try {
    mkdirSync(join(stage, dir));
    for (const file of files) run(["cp", "-RL", file, join(stage, dir, basename(file))], {});
    const entries: string[] = [];
    const walk = (entry: string) => {
      const full = join(stage, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) for (const child of readdirSync(full)) walk(join(entry, child));
      if (!stat.isSymbolicLink()) utimesSync(full, mtime, mtime);
      entries.push(stat.isDirectory() ? `${entry}/` : entry);
    };
    walk(dir);
    entries.sort();
    rmSync(path, { force: true });
    run(["zip", "-X", "-q", "-y", resolve(path), ...entries], { cwd: stage, env: { ...process.env, TZ: "UTC" } });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────── smoke test

/** Runs the binary of `zipPath` on this machine and checks it is the build the release says it is. */
export function smoke(zipPath: string, name: TargetName, commit: string, webkitVersion: string): void {
  const t = targets[name];
  const dir = mkdtempSync(join(tmpdir(), "openclaw-smoke-"));
  try {
    run(["unzip", "-q", zipPath, "-d", dir], {});
    const exe = join(dir, t.triplet, t.exe);
    const facts = JSON.parse(
      run(
        [
          exe,
          "-e",
          // Without a working JIT (a hardened-runtime signature lacking allow-jit, say) JSC falls back to the
          // interpreter and still computes the right sum; numberOfDFGCompiles then reports 1000000, JSC's "no
          // JIT" answer. The sum of 7i for i < 1e5, mod 1000003, is 545003.
          `const { numberOfDFGCompiles } = require("bun:jsc");
           function f(n) { let s = 0; for (let i = 0; i < n; i++) s = (s + i * 7) % 1000003; return s; }
           let sum = 0;
           for (let round = 0; round < 50 && !(numberOfDFGCompiles(f) > 0); round++)
             for (let k = 0; k < 200; k++) sum = f(1e5);
           console.log(JSON.stringify({ revision: Bun.revision, version: Bun.version, webkit: process.versions.webkit,
             platform: process.platform, arch: process.arch, sum: f(1e5), dfg: numberOfDFGCompiles(f) }))`,
        ],
        {},
      ),
    ) as {
      revision: string;
      version: string;
      webkit: string;
      platform: string;
      arch: string;
      sum: number;
      dfg: number;
    };
    const problems: string[] = [];
    if (facts.revision !== commit) problems.push(`Bun.revision is ${facts.revision}, expected ${commit}`);
    if (facts.webkit !== webkitVersion)
      problems.push(`process.versions.webkit is ${facts.webkit}, expected ${webkitVersion}`);
    const platform = t.os === "windows" ? "win32" : t.os;
    if (facts.platform !== platform || facts.arch !== t.arch) {
      problems.push(`runs as ${facts.platform}-${facts.arch}, expected ${platform}-${t.arch}`);
    }
    if (facts.sum !== 545003) problems.push(`the loop computed ${facts.sum}`);
    if (!(facts.dfg > 0 && facts.dfg < 1000000))
      problems.push(`the DFG JIT did not compile (numberOfDFGCompiles: ${facts.dfg})`);
    if (problems.length) throw new Error(`${name} smoke test failed:\n  ${problems.join("\n  ")}`);
    console.log(`${name}: ${run([exe, "--revision"], {}).trim()}, WebKit ${facts.webkit}, DFG compiles: ${facts.dfg}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ──────────────────────────────────────────────────────────────── manifest

export interface Signing {
  /**
   * `developer-id`: a Developer ID and the hardened runtime. Otherwise what the link leaves: an ad-hoc signature
   * with the entitlements on arm64 (`adhoc`), none on x64 (`none`), which upstream ships unsigned too.
   */
  kind: "developer-id" | "adhoc" | "none";
  identity?: string;
  teamId?: string;
  notarized: boolean;
  notarySubmissionId?: string;
}

export interface ManifestInput {
  tag: string;
  repository: string;
  facts: SourceFacts;
  revisionString?: string | undefined;
  workflowRun?: string | undefined;
  dist: string;
  /** TargetName → signing record (darwin only). Defaults to the linker's ad-hoc signature on darwin. */
  signing: Partial<Record<TargetName, Signing>>;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The machine-readable description of a release: one entry per target with its archive's URL, size and SHA-256, the
 * SHA-256 of the executable inside it, and how it is signed. Packagers pin `assets[].sha256` (the download) and
 * `assets[].executable.sha256` (what they embed).
 */
export function manifest(input: ManifestInput) {
  const { tag, repository, facts, dist } = input;
  const download = `https://github.com/${repository}/releases/download/${tag}`;
  const names = (Object.keys(targets) as TargetName[]).filter(name =>
    existsSync(join(dist, `${targets[name].triplet}.zip`)),
  );
  if (!names.length) throw new Error(`no release zips in ${dist}`);
  const assets = names.map(name => {
    const t = targets[name];
    const archive = join(dist, `${t.triplet}.zip`);
    const executable = extractedDigest(archive, `${t.triplet}/${t.exe}`);
    const profile = join(dist, `${t.triplet}-profile.zip`);
    return {
      target: name,
      os: t.os,
      arch: t.arch,
      ...(t.abi ? { libc: t.abi === "gnu" ? "glibc" : "musl" } : {}),
      minimum: minimumFor(t),
      name: basename(archive),
      url: `${download}/${basename(archive)}`,
      size: statSync(archive).size,
      sha256: sha256File(archive),
      executable: { path: `${t.triplet}/${t.exe}`, ...executable },
      ...(existsSync(profile)
        ? {
            debugSymbols: {
              name: basename(profile),
              url: `${download}/${basename(profile)}`,
              size: statSync(profile).size,
              sha256: sha256File(profile),
            },
          }
        : {}),
      ...(t.os === "darwin"
        ? {
            signing:
              input.signing[name] ??
              ({ kind: t.arch === "arm64" ? "adhoc" : "none", notarized: false } satisfies Signing),
          }
        : {}),
    };
  });
  return {
    schemaVersion: 1,
    tag,
    repository,
    release: `https://github.com/${repository}/releases/tag/${tag}`,
    bun: {
      version: facts.version,
      commit: facts.commit,
      commitDate: facts.date,
      // What `bun --revision` prints; Bun.revision is `commit`.
      ...(input.revisionString ? { revision: input.revisionString } : {}),
    },
    webkit: {
      // process.versions.webkit of every executable in this release.
      version: facts.webkitVersion,
      repository: "oven-sh/WebKit",
      prebuilt: `https://github.com/oven-sh/WebKit/releases/tag/${webkitReleaseTag(facts.webkitVersion)}`,
    },
    ...(input.workflowRun ? { workflowRun: input.workflowRun } : {}),
    assets,
  };
}

function minimumFor(t: Target): string {
  if (t.os === "darwin") return "macOS 13.0";
  if (t.os === "windows") return "Windows 10 1809";
  const cpu = t.arch === "x64" ? "x86-64 with SSE4.2 (Nehalem)" : "ARMv8.0-A";
  return t.abi === "musl" ? `musl libc with libstdc++ and libgcc, ${cpu}` : `glibc 2.17, ${cpu}`;
}

function extractedDigest(archive: string, member: string): { size: number; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-manifest-"));
  try {
    run(["unzip", "-q", archive, member, "-d", dir], {});
    const path = join(dir, member);
    return { size: statSync(path).size, sha256: sha256File(path) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `<sha256>  <name>` for every file of the release, as `sha256sum -c` reads it. */
export function checksums(files: readonly string[]): string {
  return (
    files
      .map(path => `${sha256File(path)}  ${basename(path)}`)
      .sort((a, b) => a.slice(66).localeCompare(b.slice(66)))
      .join("\n") + "\n"
  );
}

export function releaseNotes(m: ReturnType<typeof manifest>): string {
  const rows = m.assets.map(a => {
    const signing = a.signing ? ` ${a.signing.kind}${a.signing.notarized ? ", notarized" : ""} |` : " — |";
    return `| \`${a.target}\` | \`${a.name}\` | ${a.size.toLocaleString("en-US")} | \`${a.sha256}\` |${signing}`;
  });
  const unsigned = m.assets.filter(a => a.signing && a.signing.kind !== "developer-id").map(a => `\`${a.target}\``);
  return [
    `OpenClaw Bun fork build of [\`${m.bun.commit}\`](https://github.com/${m.repository}/commit/${m.bun.commit}) (Bun ${m.bun.version}${m.bun.revision ? `, \`bun --revision\` ${m.bun.revision}` : ""}), linked against the oven-sh/WebKit prebuilt [\`${m.webkit.version}\`](${m.webkit.prebuilt}).`,
    "",
    "Pin assets by `manifest.json` (`assets[].sha256` for the archive, `assets[].executable.sha256` for the binary inside it). `SHA256SUMS` lists every file of the release. Build provenance: `gh attestation verify <file> -R " +
      m.repository +
      "`.",
    "",
    "| Target | Archive | Bytes | SHA-256 | macOS signature |",
    "| --- | --- | ---: | --- | --- |",
    ...rows,
    "",
    ...(unsigned.length
      ? [
          `${unsigned.join(" and ")} ${unsigned.length > 1 ? "are" : "is"} not signed with a Developer ID or notarized: none is configured for this repository yet. arm64 carries the linker's ad-hoc signature, x64 none, as upstream links them. An app that embeds them re-signs them; macOS refuses them when a browser downloaded them.`,
          "",
        ]
      : []),
    ...(m.workflowRun ? [`Built by ${m.workflowRun}.`, ""] : []),
  ].join("\n");
}

// ───────────────────────────────────────────────────────────────── helpers

function git(cwd: string, ...args: string[]): string {
  return run(["git", ...args], { cwd }).trim();
}

function run(argv: string[], options: Omit<SpawnSyncOptions, "encoding">): string {
  const result = spawnSync(argv[0]!, argv.slice(1), { maxBuffer: 1 << 28, ...options, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.stdio === "inherit" ? "" : `\n${result.stderr ?? ""}${result.stdout ?? ""}`;
    throw new Error(`${argv.join(" ")} exited with ${result.status ?? result.signal}${detail}`);
  }
  return result.stdout ?? "";
}

function output(name: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

// ────────────────────────────────────────────────────────────────────── CLI

function isAncestor(source: string, commit: string, ref: string): boolean {
  return spawnSync("git", ["merge-base", "--is-ancestor", commit, ref], { cwd: source }).status === 0;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      source: { type: "string", default: "." },
      commit: { type: "string" },
      rebuild: { type: "string" },
      tag: { type: "string" },
      publish: { type: "boolean", default: false },
      main: { type: "string", default: "origin/main" },
      target: { type: "string", multiple: true },
      targets: { type: "string" },
      out: { type: "string" },
      zip: { type: "string" },
      webkit: { type: "string" },
      dist: { type: "string" },
      repository: { type: "string", default: process.env.GITHUB_REPOSITORY ?? "openclaw/bun" },
      "workflow-run": { type: "string" },
      revision: { type: "string" },
    },
  });
  const source = resolve(values.source!);
  const names = (): TargetName[] => {
    const list = [...(values.target ?? []), ...(values.targets ? [values.targets] : [])].join(",");
    const parsed = parseTargets(list);
    if (!parsed.length) throw new Error("name at least one --target");
    return parsed;
  };

  switch (command) {
    case "tag": {
      const facts = sourceFacts(source, values.commit ?? "HEAD");
      console.log(tagFor(facts, values.rebuild ? Number(values.rebuild) : undefined));
      return;
    }
    case "plan": {
      // A tag is verified against its commit; without one the checkout is built as a dry run.
      const tag = values.tag || undefined;
      const facts = sourceFacts(source, tag ? `refs/tags/${tag}` : "HEAD");
      if (tag) {
        const problems = tagMismatches(tag, facts);
        if (problems.length) throw new Error(`${tag} does not describe its commit:\n  ${problems.join("\n  ")}`);
      }
      if (values.publish) {
        if (!tag) throw new Error("publishing needs a release tag");
        if (!isAncestor(source, facts.commit, values.main!)) {
          throw new Error(`${facts.commit} is not on ${values.main}; only commits of the fork's main are released`);
        }
      }
      const built = values.targets?.trim() ? parseTargets(values.targets) : [...releaseTargets];
      if (values.publish && releaseTargets.some(name => !built.includes(name))) {
        throw new Error(`a published release has every release target: ${releaseTargets.join(", ")}`);
      }
      output("matrix", JSON.stringify(matrix(built)));
      output("darwin", String(built.some(name => targets[name].os === "darwin")));
      output("commit", facts.commit);
      output("tag", tag ?? tagFor(facts));
      output("version", facts.version);
      output("webkit", facts.webkitVersion);
      output("publish", String(values.publish));
      return;
    }
    case "provision": {
      console.log(provision(source, names()));
      return;
    }
    case "build": {
      const name = names()[0]!;
      build(source, name, resolve(values.out ?? "dist"), Number(git(source, "log", "-1", "--format=%ct", "HEAD")));
      return;
    }
    case "smoke": {
      const name = names()[0]!;
      smoke(resolve(values.zip!), name, values.commit!, values.webkit!);
      return;
    }
    case "manifest": {
      const tag = values.tag!;
      const dist = resolve(values.dist!);
      const out = resolve(values.out ?? dist);
      const facts = sourceFacts(source, values.commit ?? "HEAD");
      const signing: ManifestInput["signing"] = {};
      for (const file of readdirSync(dist).filter(f => f.endsWith(".signing.json"))) {
        signing[file.slice(0, -".signing.json".length) as TargetName] = JSON.parse(
          readFileSync(join(dist, file), "utf8"),
        );
      }
      const m = manifest({
        tag,
        repository: values.repository!,
        facts,
        revisionString: values.revision,
        workflowRun: values["workflow-run"],
        dist,
        signing,
      });
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
      const released = readdirSync(dist)
        .filter(f => f.endsWith(".zip"))
        .map(f => join(dist, f));
      writeFileSync(join(out, "SHA256SUMS"), checksums([...released, join(out, "manifest.json")]));
      writeFileSync(join(out, "release-notes.md"), releaseNotes(m));
      console.log(readFileSync(join(out, "SHA256SUMS"), "utf8"));
      return;
    }
    default:
      throw new Error(`unknown command ${command ?? "(none)"}; see the header of ${import.meta.path}`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`openclaw-release: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
