/** Build local WebKit's pinned ICU, using the lane's filtering and data packer. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

interface Options {
  source: string;
  output: string;
  cc: string;
  cxx: string;
  ar: string;
  ranlib: string;
  flags: string[];
  target?: string;
  cross: boolean;
  jobs: number;
}
const options: Options = JSON.parse(process.argv[2]!);
const { source, output } = options;
const recipe = join(source, "icu");
const pin = JSON.parse(readFileSync(join(recipe, "source.json"), "utf8"));
if (!/^\d+\.\d+$/.test(pin.version) || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error("Invalid WebKit ICU pin");
const identity = createHash("sha256")
  .update(JSON.stringify(options))
  .update(readFileSync(import.meta.filename));
for (const file of readdirSync(recipe).sort()) identity.update(file).update(readFileSync(join(recipe, file)));
const stamp = join(output, ".identity");
const expected = identity.digest("hex");
const libraries = ["libicui18n.a", "libicuuc.a", "libicudata.a"];
if (
  existsSync(stamp) &&
  readFileSync(stamp, "utf8") === expected &&
  libraries.every(lib => existsSync(join(output, "lib", lib)))
)
  process.exit(0);

const work = `${output}.work`;
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
function run(command: string[], cwd = work, env: NodeJS.ProcessEnv = process.env, capture = false): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command[0]} failed (${result.status})\n${result.stderr ?? ""}`);
  return result.stdout ?? "";
}
const archive = join(work, "icu.tgz");
run([
  "curl",
  "-fL",
  "--retry",
  "5",
  `https://github.com/unicode-org/icu/releases/download/release-${pin.version}/icu4c-${pin.version}-sources.tgz`,
  "-o",
  archive,
]);
if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== pin.sha256)
  throw new Error("ICU checksum mismatch");
run(["tar", "-xf", archive, "--strip-components=1"]);
run(["patch", "-p1", "-i", join(recipe, "udata-decompress-hook.patch")]);
const src = join(work, "source");
const host = join(work, "host");
const toolsEnv = {
  ...process.env,
  CC: options.cc,
  CXX: options.cxx,
  AR: options.ar,
  RANLIB: options.ranlib,
  CFLAGS: "-Os",
  CXXFLAGS: "-Os",
  LDFLAGS: "-fuse-ld=lld",
};
let icupkg = join(src, "bin", "icupkg");
if (options.cross) {
  mkdirSync(host);
  run(
    [join(src, "configure"), "--disable-shared", "--enable-static", "--disable-samples", "--disable-tests"],
    host,
    toolsEnv,
  );
  run(["make", `-j${options.jobs}`], host, toolsEnv);
  icupkg = join(host, "bin", "icupkg");
}
const flags = options.flags.join(" ");
const env = {
  ...toolsEnv,
  CFLAGS: `${flags} -Os -std=c17`,
  CXXFLAGS: `${flags} -Os -DUCONFIG_NO_LEGACY_CONVERSION=1 -std=c++20 -fno-exceptions -fno-c++-static-destructors`,
  LDFLAGS: `${flags} -fuse-ld=lld`,
};
const cross = options.cross ? [`--host=${options.target}`, `--with-cross-build=${host}`] : [];
run(
  [
    "./configure",
    ...cross,
    `--prefix=${output}`,
    "--enable-static",
    "--disable-shared",
    "--disable-layoutex",
    "--disable-layout",
    "--with-data-packaging=static",
    "--disable-samples",
    "--disable-debug",
    "--disable-tests",
    "--disable-extras",
    "--disable-icuio",
  ],
  src,
  env,
);
run(["make", `-j${options.jobs}`], src, env);
const data = join(src, "data", "in", `icudt${pin.version.split(".")[0]}l.dat`);
const ns = join(work, "numbering");
mkdirSync(ns);
run([icupkg, "-x", "numberingSystems.res", data, "-d", ns], src, env);
const systems = run(["strings", "-el", join(ns, "numberingSystems.res")], src, env, true);
for (const line of systems.split("\n")) {
  const locale = /^([A-Za-z_][A-Za-z_]*)\//.exec(line)?.[1];
  if (locale && !["ja", "zh", "zh_Hant"].includes(locale)) throw new Error(`ICU rbnf keep-list is stale: ${locale}`);
}
const remove = run([icupkg, "-l", data], src, env, true)
  .split("\n")
  .filter(
    name =>
      /\.(cnv|spp|cfu)$|^cnvalias\.icu$|^translit\/|^rbnf\/|^unames\.icu$/.test(name) &&
      !/^rbnf\/(root|res_index|ja|zh|zh_Hant)\.res$/.test(name),
  );
const removeList = join(work, "remove.txt");
writeFileSync(removeList, remove.join("\n") + "\n");
const filtered = data.replace(/\.dat$/, "_filtered.dat");
run([icupkg, "--auto_toc_prefix", "-r", removeList, data, filtered], src, env);
renameSync(filtered, data);
rmSync(join(src, "data", "out"), { recursive: true, force: true });
rmSync(join(src, "lib", "libicudata.a"));
run(["make", `-j${options.jobs}`], src, env);
run(["make", "install"], src, env);
run(
  [
    process.execPath,
    join(recipe, "compress-data.ts"),
    data,
    join(output, "lib", "libicudata.a"),
    "--skip",
    join(recipe, "keep-raw.txt"),
    "--icupkg",
    icupkg,
    "--cc",
    `${options.cc} ${flags}`,
    "--ar",
    options.ar,
  ],
  src,
  env,
);
writeFileSync(stamp, expected);
rmSync(work, { recursive: true, force: true });
