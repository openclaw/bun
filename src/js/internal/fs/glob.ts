// Port of Node.js lib/internal/fs/glob.js (v26.3.0):
//   https://github.com/nodejs/node/blob/50c35fea9e64d50ab3bb5f359e8523de89d6c798/lib/internal/fs/glob.js
// backed by a vendored copy of minimatch (Node's deps/minimatch/index.js, ISC license):
//   https://github.com/nodejs/node/blob/50c35fea9e64d50ab3bb5f359e8523de89d6c798/deps/minimatch/index.js
// shared in internal/fs/glob-matcher; its vendored block is not edited but for types.
//
// This is not backed by Bun.Glob: the vendored test-fs-glob.mjs (448 cases)
// exercises minimatch-specific semantics — withFileTypes Dirents, the
// exclude-array matching rules, symlink-walking and dotfile rules — that
// Bun.Glob.scan does not implement (328/448 fail with the Bun.Glob-backed
// version on main). Replace this with Bun.Glob once those gaps are closed
// natively.
const { validateObject, validateString, validateBoolean, validateArray } = require("internal/validators");
const { join, resolve, basename, dirname, isAbsolute } = require("node:path");
const { kEmptyObject } = require("internal/shared");
const { createMatcher, lazyMinimatch, matchGlobPattern } = require("internal/fs/glob-matcher");
import type { Minimatch, PatternPart } from "./glob-matcher";

const isWindows = process.platform === "win32";

// node:fs and node:fs/promises cannot be required at module scope:
// node:fs/promises requires this module at its top level.

type Dirent = $Node.Dirent;
type Stats = $Node.Stats;

interface GlobOptions {
  cwd?: string | URL;
  exclude?: string[] | ((entry: Dirent | string) => boolean);
  followSymlinks?: boolean;
  withFileTypes?: boolean;
}

function compareDirentName(a: Dirent, b: Dirent) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
function identity<T>(v: T) {
  return v;
}
function nullOnReject() {
  return null;
}
function emptyArrayOnReject(): Dirent[] {
  return [];
}
function excludeNothing(_path: string) {
  return false;
}
function makeMatchersExclude(matchers: Minimatch[]) {
  return function isExcludedByMatchers(value: string) {
    for (const matcher of matchers) {
      if (matcher.match(value)) return true;
    }
    return false;
  };
}
function statForFileTypes(cache: Cache, root: string, path: string) {
  return cache.statSync(isAbsolute(path) ? path : join(root, path));
}

const kStats = Symbol("stats");
let _DirentFromStats: (new (name: string, stats: Stats, path: string) => Dirent) | undefined;
function lazyDirentFromStats() {
  if (_DirentFromStats === undefined) {
    const { Dirent } = require("node:fs");
    class DirentFromStats extends Dirent {
      declare [kStats]: Stats;
      constructor(name: string, stats: Stats, path: string) {
        super(name, null!, path);
        this[kStats] = stats;
      }
    }
    for (const key of [
      "isBlockDevice",
      "isCharacterDevice",
      "isDirectory",
      "isFIFO",
      "isFile",
      "isSocket",
      "isSymbolicLink",
    ] as const) {
      DirentFromStats.prototype[key] = function (this: DirentFromStats) {
        return this[kStats][key]();
      };
    }
    _DirentFromStats = DirentFromStats;
  }
  return _DirentFromStats;
}

function toPathIfFileURL(url: string | URL | null | undefined): string | null | undefined {
  if (url == null || typeof url === "string") {
    return url;
  }
  return require("internal/url").toPathIfFileURL(url);
}

async function getDirent(path: string) {
  let stat: Stats;
  try {
    stat = await require("node:fs/promises").lstat(path);
  } catch {
    return null;
  }
  const DirentFromStats = lazyDirentFromStats();
  return new DirentFromStats(basename(path), stat, dirname(path));
}

function sortDirents(dirents: Dirent[]) {
  return dirents.sort(compareDirentName);
}

function getDirentSync(path: string) {
  let stat: Stats;
  try {
    stat = require("node:fs").lstatSync(path);
  } catch {
    return null;
  }
  const DirentFromStats = lazyDirentFromStats();
  return new DirentFromStats(basename(path), stat, dirname(path));
}

function validateStringArrayOrFunction(value: unknown, name: string) {
  if ($isArray(value)) {
    for (let i = 0; i < value.length; ++i) {
      if (typeof value[i] !== "string") {
        throw $ERR_INVALID_ARG_TYPE(`${name}[${i}]`, "string", value[i]);
      }
    }
    return;
  }
  if (typeof value !== "function") {
    throw $ERR_INVALID_ARG_TYPE(name, ["string[]", "function"], value);
  }
}

function validateStringArray(value: string[], name: string) {
  validateArray(value, name);
  for (let i = 0; i < value.length; ++i) {
    validateString(value[i], `${name}[${i}]`);
  }
}

function cloneSet(values: Set<string>) {
  const cloned = new Set<string>();
  for (const value of values) {
    cloned.add(value);
  }
  return cloned;
}

class Cache {
  // One `Glob` walks with promises or without, so a table holds promises or values.
  #cache = new Map<string, Set<string>>();
  #statsCache = new Map<string, Dirent | null | Promise<Dirent | null>>();
  #followStatsCache = new Map<string, Stats | null | Promise<Stats | null>>();
  #readdirCache = new Map<string, Dirent[] | Promise<Dirent[]>>();
  #realpathCache = new Map<string, string | null | Promise<string | null>>();

  stat(path: string) {
    const cached = this.#statsCache.get(path);
    if (cached) {
      return cached;
    }
    const promise = getDirent(path);
    this.#statsCache.set(path, promise);
    return promise;
  }
  statSync(path: string) {
    const cached = this.#statsCache.get(path);
    // Do not return a promise from a sync function.
    if (cached && !(cached instanceof Promise)) {
      return cached;
    }
    const val = getDirentSync(path);
    this.#statsCache.set(path, val);
    return val;
  }
  followStat(path: string) {
    const cached = this.#followStatsCache.get(path);
    if (cached) {
      return cached;
    }
    const promise = require("node:fs/promises").stat(path).then(identity, nullOnReject);
    this.#followStatsCache.set(path, promise);
    return promise;
  }
  followStatSync(path: string) {
    const cached = this.#followStatsCache.get(path);
    if (cached && !(cached instanceof Promise)) {
      return cached;
    }
    let val: Stats | null;
    try {
      val = require("node:fs").statSync(path);
    } catch {
      val = null;
    }
    this.#followStatsCache.set(path, val);
    return val;
  }
  realpath(path: string) {
    const cached = this.#realpathCache.get(path);
    if (cached) {
      return cached;
    }
    const promise = require("node:fs/promises").realpath(path).then(identity, nullOnReject);
    this.#realpathCache.set(path, promise);
    return promise;
  }
  realpathSync(path: string) {
    const cached = this.#realpathCache.get(path);
    if (cached && !(cached instanceof Promise)) {
      return cached;
    }
    let val: string | null;
    try {
      val = require("node:fs").realpathSync(path);
    } catch {
      val = null;
    }
    this.#realpathCache.set(path, val);
    return val;
  }
  addToStatCache(path: string, val: Dirent) {
    this.#statsCache.set(path, val);
  }
  async readdir(path: string) {
    const cached = this.#readdirCache.get(path);
    if (cached) {
      return cached;
    }
    const promise = require("node:fs/promises").readdir(path, { __proto__: null, withFileTypes: true }).then(
      // The traversal bookkeeping (the seen-cache and the "**/.." queueing)
      // is sensitive to the order directory entries are visited in; some
      // orders make it drop results (reproducible in node itself by feeding
      // it the same order). Sort entries so traversal is deterministic and
      // matches the orders the upstream algorithm is known to handle.
      sortDirents,
      emptyArrayOnReject,
    );
    this.#readdirCache.set(path, promise);
    return promise;
  }
  readdirSync(path: string) {
    const cached = this.#readdirCache.get(path);
    if (cached) {
      return cached as Dirent[];
    }
    let val: Dirent[];
    try {
      // Sorted for deterministic traversal; see the comment in readdir().
      val = sortDirents(require("node:fs").readdirSync(path, { __proto__: null, withFileTypes: true }));
    } catch {
      val = [];
    }
    this.#readdirCache.set(path, val);
    return val;
  }
  add(path: string, pattern: Pattern) {
    let cache = this.#cache.get(path);
    if (!cache) {
      cache = new Set();
      this.#cache.set(path, cache);
    }
    const originalSize = cache.size;
    for (const index of pattern.indexes) {
      cache.add(pattern.cacheKey(index));
    }
    return cache.size !== originalSize + pattern.indexes.size;
  }
  seen(path: string, pattern: Pattern, index: number) {
    return this.#cache.get(path)?.has(pattern.cacheKey(index));
  }
}

class Pattern {
  #pattern: PatternPart[];
  #globStrings: string[];
  indexes: Set<number>;
  symlinks: Set<number>;
  realpaths: Set<string>;
  last: number;

  constructor(
    pattern: PatternPart[],
    globStrings: string[],
    indexes: Set<number>,
    symlinks: Set<number>,
    realpaths = new Set<string>(),
  ) {
    this.#pattern = pattern;
    this.#globStrings = globStrings;
    this.indexes = indexes;
    this.symlinks = symlinks;
    this.realpaths = realpaths;
    this.last = pattern.length - 1;
  }

  isLast(isDirectory: boolean) {
    return (
      this.indexes.has(this.last) ||
      (this.at(-1) === "" && isDirectory && this.indexes.has(this.last - 1) && this.at(-2) === lazyMinimatch().GLOBSTAR)
    );
  }
  isFirst() {
    return this.indexes.has(0);
  }
  get hasSeenSymlinks() {
    for (const i of this.indexes) {
      if (!this.symlinks.has(i)) return true;
    }
    return false;
  }
  at(index: number) {
    return this.#pattern.at(index);
  }
  child(indexes: Set<number>, symlinks = new Set<number>(), realpaths = this.realpaths) {
    return new Pattern(this.#pattern, this.#globStrings, indexes, symlinks, realpaths);
  }
  test(index: number, path: string) {
    if (index > this.#pattern.length) {
      return false;
    }
    const pattern = this.#pattern[index];
    if (pattern === lazyMinimatch().GLOBSTAR) {
      return true;
    }
    if (typeof pattern === "string") {
      return pattern === path;
    }
    if (typeof (pattern as RegExp)?.test === "function") {
      return (pattern as RegExp).test(path);
    }
    return false;
  }

  cacheKey(index: number) {
    let key = "";
    for (let i = index; i < this.#globStrings.length; i++) {
      key += this.#globStrings[i];
      if (i !== this.#globStrings.length - 1) {
        key += "/";
      }
    }
    return key;
  }
}

class ResultSet extends Set<string> {
  #root = ".";
  #isExcluded: (path: string) => boolean = excludeNothing;

  setup(root: string, isExcludedFn: (path: string) => boolean) {
    this.#root = root;
    this.#isExcluded = isExcludedFn;
  }

  add(value: string): any {
    if (this.#isExcluded(resolve(this.#root, value))) {
      return false;
    }
    super.add(value);
    return true;
  }
}

class Glob {
  #root: string;
  #exclude: ((entry: Dirent | string) => boolean) | undefined;
  #cache = new Cache();
  #results = new ResultSet();
  #queue: Array<{ __proto__: null; path: string; patterns: Pattern[] }> = [];
  #subpatterns = new Map<string, Pattern[]>();
  #patterns: Pattern[];
  #withFileTypes: boolean;
  #followSymlinks = false;
  #isExcluded: (path: string) => boolean = excludeNothing;
  matchers: Minimatch[];
  constructor(pattern: string | string[], options: GlobOptions = kEmptyObject) {
    validateObject(options, "options");
    const { exclude, cwd, followSymlinks, withFileTypes } = options;
    this.#root = toPathIfFileURL(cwd) ?? process.cwd();
    if (followSymlinks != null) {
      validateBoolean(followSymlinks, "options.followSymlinks");
      this.#followSymlinks = followSymlinks;
    }
    this.#withFileTypes = !!withFileTypes;
    if (exclude != null) {
      validateStringArrayOrFunction(exclude, "options.exclude");
      if ($isArray(exclude)) {
        // Convert the path part of exclude patterns to absolute paths for
        // consistent comparison before instantiating matchers.
        const matchers: Minimatch[] = [];
        for (const pat of exclude) {
          matchers.push(createMatcher(resolve(this.#root, pat)));
        }
        this.#isExcluded = makeMatchersExclude(matchers);
        this.#results.setup(this.#root, this.#isExcluded);
      } else {
        this.#exclude = exclude;
      }
    }
    let patterns: string[];
    if (typeof pattern === "object") {
      validateStringArray(pattern, "patterns");
      patterns = pattern;
    } else {
      validateString(pattern, "patterns");
      patterns = [pattern];
    }
    this.matchers = [];
    this.#patterns = [];
    for (const pat of patterns) {
      const matcher = createMatcher(pat);
      this.matchers.push(matcher);
      for (let i = 0; i < matcher.set.length; i++) {
        this.#patterns.push(
          new Pattern(matcher.set[i], matcher.globParts[i], new Set<number>().add(0), new Set<number>()),
        );
      }
    }
  }

  globSync() {
    this.#queue.push({ __proto__: null, path: ".", patterns: this.#patterns });
    while (this.#queue.length > 0) {
      const item = this.#queue.pop()!;
      for (let i = 0; i < item.patterns.length; i++) {
        this.#addSubpatterns(item.path, item.patterns[i]);
      }
      for (const [path, patterns] of this.#subpatterns) {
        this.#queue.push({ __proto__: null, path, patterns });
      }
      this.#subpatterns.clear();
    }
    return Array.from<string, Dirent | string | null>(
      this.#results,
      this.#withFileTypes ? statForFileTypes.bind(null, this.#cache, this.#root) : undefined!,
    );
  }
  #isDirectorySync(path: string, stat: Dirent | null, pattern: Pattern) {
    if (stat?.isDirectory()) {
      return true;
    }
    if (!stat?.isSymbolicLink()) {
      return false;
    }
    if (this.#followSymlinks) {
      return !!this.#cache.followStatSync(path)?.isDirectory();
    }
    return pattern.hasSeenSymlinks;
  }
  async #isDirectory(path: string, stat: Dirent | null, pattern: Pattern) {
    if (stat?.isDirectory()) {
      return true;
    }
    if (!stat?.isSymbolicLink()) {
      return false;
    }
    if (this.#followSymlinks) {
      return !!(await this.#cache.followStat(path))?.isDirectory();
    }
    return pattern.hasSeenSymlinks;
  }
  #nextRealpathsSync(path: string, isDirectory: boolean, pattern: Pattern) {
    if (!this.#followSymlinks || !isDirectory) {
      return pattern.realpaths;
    }
    const real = this.#cache.realpathSync(path);
    if (real === null) {
      return pattern.realpaths;
    }
    const realpaths = cloneSet(pattern.realpaths);
    realpaths.add(real);
    return realpaths;
  }
  async #nextRealpaths(path: string, isDirectory: boolean, pattern: Pattern) {
    if (!this.#followSymlinks || !isDirectory) {
      return pattern.realpaths;
    }
    const real = await this.#cache.realpath(path);
    if (real === null) {
      return pattern.realpaths;
    }
    const realpaths = cloneSet(pattern.realpaths);
    realpaths.add(real);
    return realpaths;
  }
  async #isCyclic(path: string, isDirectory: boolean, pattern: Pattern) {
    if (!this.#followSymlinks || !isDirectory) {
      return false;
    }
    const real = await this.#cache.realpath(path);
    return real !== null && pattern.realpaths.has(real);
  }
  #isCyclicSync(path: string, isDirectory: boolean, pattern: Pattern) {
    if (!this.#followSymlinks || !isDirectory) {
      return false;
    }
    const real = this.#cache.realpathSync(path);
    return real !== null && pattern.realpaths.has(real);
  }
  #addSubpattern(path: string, pattern: Pattern) {
    if (this.#isExcluded(path)) {
      return;
    }
    const fullpath = resolve(this.#root, path);

    // If path is a directory, add trailing slash and test patterns again.
    if (this.#isExcluded(`${fullpath}/`) && this.#cache.statSync(fullpath)!.isDirectory()) {
      return;
    }

    if (this.#exclude) {
      if (this.#withFileTypes) {
        // Key by absolute path: the stat cache is populated with entry
        // fullpaths, and a relative lstat would resolve against
        // process.cwd() instead of options.cwd (upstream passes `path`
        // here, which silently skips the exclude callback when cwd
        // differs).
        const stat = this.#cache.statSync(fullpath);
        if (stat !== null) {
          if (this.#exclude(stat)) {
            return;
          }
        }
      } else if (this.#exclude(path)) {
        return;
      }
    }
    if (!this.#subpatterns.has(path)) {
      this.#subpatterns.set(path, [pattern]);
    } else {
      this.#subpatterns.get(path)!.push(pattern);
    }
  }
  #addSubpatterns(path: string, pattern: Pattern) {
    const seen = this.#cache.add(path, pattern);
    if (seen) {
      return;
    }
    const fullpath = resolve(this.#root, path);
    const stat = this.#cache.statSync(fullpath);
    const last = pattern.last;
    const isDirectory = this.#isDirectorySync(fullpath, stat, pattern);
    const isLast = pattern.isLast(isDirectory);
    const isFirst = pattern.isFirst();

    if (this.#isExcluded(fullpath)) {
      return;
    }
    if (isFirst && isWindows && typeof pattern.at(0) === "string" && (pattern.at(0) as string).endsWith(":")) {
      // Absolute path, go to root
      this.#addSubpattern(`${pattern.at(0) as string}\\`, pattern.child(new Set<number>().add(1)));
      return;
    }
    if (isFirst && pattern.at(0) === "") {
      // Absolute path, go to root
      this.#addSubpattern("/", pattern.child(new Set<number>().add(1)));
      return;
    }
    if (isFirst && pattern.at(0) === "..") {
      // Start with .., go to parent
      this.#addSubpattern("../", pattern.child(new Set<number>().add(1)));
      return;
    }
    if (isFirst && pattern.at(0) === ".") {
      // Start with ., proceed
      this.#addSubpattern(".", pattern.child(new Set<number>().add(1)));
      return;
    }

    if (isLast && typeof pattern.at(-1) === "string") {
      // Add result if it exists
      const p = pattern.at(-1);
      const stat = this.#cache.statSync(join(fullpath, p));
      if (stat && (p || isDirectory)) {
        this.#results.add(join(path, p));
      }
      if (pattern.indexes.size === 1 && pattern.indexes.has(last)) {
        return;
      }
    } else if (
      isLast &&
      pattern.at(-1) === lazyMinimatch().GLOBSTAR &&
      (path !== "." || pattern.at(0) === "." || (last === 0 && stat))
    ) {
      // If pattern ends with **, add to results
      // if path is ".", add it only if pattern starts with "." or pattern is exactly "**"
      this.#results.add(path);
    }

    if (!isDirectory || this.#isCyclicSync(fullpath, isDirectory, pattern)) {
      return;
    }

    const nextRealpaths = this.#nextRealpathsSync(fullpath, isDirectory, pattern);

    let children: Dirent[];
    const firstPattern = pattern.indexes.size === 1 && pattern.at(pattern.indexes.values().next().value!);
    if (typeof firstPattern === "string") {
      const stat = this.#cache.statSync(join(fullpath, firstPattern));
      if (stat) {
        setDirentName(stat, firstPattern);
        children = [stat];
      } else {
        return;
      }
    } else {
      children = this.#cache.readdirSync(fullpath);
    }

    for (let i = 0; i < children.length; i++) {
      const entry = children[i];
      const entryPath = join(path, entry.name);
      const entryFullpath = join(fullpath, entry.name);
      this.#cache.addToStatCache(entryFullpath, entry);
      const entryIsDirectory =
        entry.isDirectory() ||
        (this.#followSymlinks && entry.isSymbolicLink() && !!this.#cache.followStatSync(entryFullpath)?.isDirectory());

      const subPatterns = new Set<number>();
      const nSymlinks = new Set<number>();
      for (const index of pattern.indexes) {
        // For each child, check potential patterns
        if (this.#cache.seen(entryPath, pattern, index) || this.#cache.seen(entryPath, pattern, index + 1)) {
          return;
        }
        const current = pattern.at(index);
        const nextIndex = index + 1;
        const next = pattern.at(nextIndex);
        const fromSymlink = !this.#followSymlinks && pattern.symlinks.has(index);

        if (current === lazyMinimatch().GLOBSTAR) {
          const isDot = entry.name[0] === ".";
          const nextMatches = pattern.test(nextIndex, entry.name);

          let nextNonGlobIndex = nextIndex;
          while (pattern.at(nextNonGlobIndex) === lazyMinimatch().GLOBSTAR) {
            nextNonGlobIndex++;
          }

          const matchesDot = isDot && pattern.test(nextNonGlobIndex, entry.name);

          if ((isDot && !matchesDot) || (this.#exclude && this.#exclude(this.#withFileTypes ? entry : entry.name))) {
            continue;
          }
          if (!fromSymlink && entryIsDirectory) {
            // If directory, add ** to its potential patterns
            subPatterns.add(index);
          } else if (!fromSymlink && index === last) {
            // If ** is last, add to results
            this.#results.add(entryPath);
          }

          // Any pattern after ** is also a potential pattern
          // so we can already test it here
          if (nextMatches && nextIndex === last && !isLast) {
            // If next pattern is the last one, add to results
            this.#results.add(entryPath);
          } else if (nextMatches && entryIsDirectory) {
            // Pattern matched, meaning two patterns forward
            // are also potential patterns
            // e.g **/b/c when entry is a/b - add c to potential patterns
            subPatterns.add(index + 2);
          }
          if ((nextMatches || pattern.at(0) === ".") && (entryIsDirectory || entry.isSymbolicLink()) && !fromSymlink) {
            // If pattern after ** matches, or pattern starts with "."
            // and entry is a directory or symlink, add to potential patterns
            subPatterns.add(nextIndex);
          }

          if (!this.#followSymlinks && entry.isSymbolicLink()) {
            nSymlinks.add(index);
          }

          if (next === ".." && entryIsDirectory) {
            // In case pattern is "**/..",
            // both parent and current directory should be added to the queue
            // if this is the last pattern, add to results instead
            const parent = join(path, "..");
            if (nextIndex < last) {
              if (!this.#subpatterns.has(path) && !this.#cache.seen(path, pattern, nextIndex + 1)) {
                this.#subpatterns.set(path, [pattern.child(new Set<number>().add(nextIndex + 1))]);
              }
              if (!this.#subpatterns.has(parent) && !this.#cache.seen(parent, pattern, nextIndex + 1)) {
                this.#subpatterns.set(parent, [pattern.child(new Set<number>().add(nextIndex + 1))]);
              }
            } else {
              if (!this.#cache.seen(path, pattern, nextIndex)) {
                this.#cache.add(path, pattern.child(new Set<number>().add(nextIndex)));
                this.#results.add(path);
              }
              if (!this.#cache.seen(path, pattern, nextIndex) || !this.#cache.seen(parent, pattern, nextIndex)) {
                this.#cache.add(parent, pattern.child(new Set<number>().add(nextIndex)));
                this.#results.add(parent);
              }
            }
          }
        }
        if (typeof current === "string") {
          if (pattern.test(index, entry.name) && index !== last) {
            // If current pattern matches entry name
            // the next pattern is a potential pattern
            subPatterns.add(nextIndex);
          } else if (current === "." && pattern.test(nextIndex, entry.name)) {
            // If current pattern is ".", proceed to test next pattern
            if (nextIndex === last) {
              this.#results.add(entryPath);
            } else {
              subPatterns.add(nextIndex + 1);
            }
          }
        }
        if (typeof current === "object" && pattern.test(index, entry.name)) {
          // If current pattern is a regex that matches entry name (e.g *.js)
          // add next pattern to potential patterns, or to results if it's the last pattern
          if (index === last) {
            this.#results.add(entryPath);
          } else if (entryIsDirectory) {
            subPatterns.add(nextIndex);
          }
        }
      }
      if (subPatterns.size > 0) {
        // If there are potential patterns, add to queue
        this.#addSubpattern(entryPath, pattern.child(subPatterns, nSymlinks, nextRealpaths));
      }
    }
  }

  async *glob() {
    this.#queue.push({ __proto__: null, path: ".", patterns: this.#patterns });
    while (this.#queue.length > 0) {
      const item = this.#queue.pop()!;
      for (let i = 0; i < item.patterns.length; i++) {
        yield* this.#iterateSubpatterns(item.path, item.patterns[i]);
      }
      for (const [path, patterns] of this.#subpatterns) {
        this.#queue.push({ __proto__: null, path, patterns });
      }
      this.#subpatterns.clear();
    }
  }
  async *#iterateSubpatterns(path: string, pattern: Pattern): AsyncGenerator<Dirent | string | null, void, unknown> {
    const seen = this.#cache.add(path, pattern);
    if (seen) {
      return;
    }
    const fullpath = resolve(this.#root, path);
    const stat = await this.#cache.stat(fullpath);
    const last = pattern.last;
    const isDirectory = await this.#isDirectory(fullpath, stat, pattern);
    const isLast = pattern.isLast(isDirectory);
    const isFirst = pattern.isFirst();

    if (this.#isExcluded(fullpath)) {
      return;
    }
    if (isFirst && isWindows && typeof pattern.at(0) === "string" && (pattern.at(0) as string).endsWith(":")) {
      // Absolute path, go to root
      this.#addSubpattern(`${pattern.at(0) as string}\\`, pattern.child(new Set<number>().add(1)));
      return;
    }
    if (isFirst && pattern.at(0) === "") {
      // Absolute path, go to root
      this.#addSubpattern("/", pattern.child(new Set<number>().add(1)));
      return;
    }
    if (isFirst && pattern.at(0) === "..") {
      // Start with .., go to parent
      this.#addSubpattern("../", pattern.child(new Set<number>().add(1)));
      return;
    }
    if (isFirst && pattern.at(0) === ".") {
      // Start with ., proceed
      this.#addSubpattern(".", pattern.child(new Set<number>().add(1)));
      return;
    }

    if (isLast && typeof pattern.at(-1) === "string") {
      // Add result if it exists
      const p = pattern.at(-1);
      const stat = await this.#cache.stat(join(fullpath, p));
      if (stat && (p || isDirectory)) {
        const result = join(path, p);
        if (!this.#results.has(result)) {
          if (this.#results.add(result)) {
            yield this.#withFileTypes ? stat : result;
          }
        }
      }
      if (pattern.indexes.size === 1 && pattern.indexes.has(last)) {
        return;
      }
    } else if (
      isLast &&
      pattern.at(-1) === lazyMinimatch().GLOBSTAR &&
      (path !== "." || pattern.at(0) === "." || (last === 0 && stat))
    ) {
      // If pattern ends with **, add to results
      // if path is ".", add it only if pattern starts with "." or pattern is exactly "**"
      if (!this.#results.has(path)) {
        if (this.#results.add(path)) {
          yield this.#withFileTypes ? stat : path;
        }
      }
    }

    if (!isDirectory || (await this.#isCyclic(fullpath, isDirectory, pattern))) {
      return;
    }

    const nextRealpaths = await this.#nextRealpaths(fullpath, isDirectory, pattern);

    let children: Dirent[];
    const firstPattern = pattern.indexes.size === 1 && pattern.at(pattern.indexes.values().next().value!);
    if (typeof firstPattern === "string") {
      const stat = await this.#cache.stat(join(fullpath, firstPattern));
      if (stat) {
        setDirentName(stat, firstPattern);
        children = [stat];
      } else {
        return;
      }
    } else {
      children = await this.#cache.readdir(fullpath);
    }

    for (let i = 0; i < children.length; i++) {
      const entry = children[i];
      const entryPath = join(path, entry.name);
      const entryFullpath = join(fullpath, entry.name);
      this.#cache.addToStatCache(entryFullpath, entry);
      const entryIsDirectory =
        entry.isDirectory() ||
        (this.#followSymlinks &&
          entry.isSymbolicLink() &&
          !!(await this.#cache.followStat(entryFullpath))?.isDirectory());

      const subPatterns = new Set<number>();
      const nSymlinks = new Set<number>();
      for (const index of pattern.indexes) {
        // For each child, check potential patterns
        if (this.#cache.seen(entryPath, pattern, index) || this.#cache.seen(entryPath, pattern, index + 1)) {
          return;
        }
        const current = pattern.at(index);
        const nextIndex = index + 1;
        const next = pattern.at(nextIndex);
        const fromSymlink = !this.#followSymlinks && pattern.symlinks.has(index);

        if (current === lazyMinimatch().GLOBSTAR) {
          const isDot = entry.name[0] === ".";
          const nextMatches = pattern.test(nextIndex, entry.name);

          let nextNonGlobIndex = nextIndex;
          while (pattern.at(nextNonGlobIndex) === lazyMinimatch().GLOBSTAR) {
            nextNonGlobIndex++;
          }

          const matchesDot = isDot && pattern.test(nextNonGlobIndex, entry.name);

          if ((isDot && !matchesDot) || (this.#exclude && this.#exclude(this.#withFileTypes ? entry : entry.name))) {
            continue;
          }
          if (!fromSymlink && entryIsDirectory) {
            // If directory, add ** to its potential patterns
            subPatterns.add(index);
          } else if (!fromSymlink && index === last) {
            // If ** is last, add to results
            if (!this.#results.has(entryPath) && this.#results.add(entryPath)) {
              yield this.#withFileTypes ? entry : entryPath;
            }
          }

          // Any pattern after ** is also a potential pattern
          // so we can already test it here
          if (nextMatches && nextIndex === last && !isLast) {
            // If next pattern is the last one, add to results
            if (!this.#results.has(entryPath) && this.#results.add(entryPath)) {
              yield this.#withFileTypes ? entry : entryPath;
            }
          } else if (nextMatches && entryIsDirectory) {
            // Pattern matched, meaning two patterns forward
            // are also potential patterns
            // e.g **/b/c when entry is a/b - add c to potential patterns
            subPatterns.add(index + 2);
          }
          if ((nextMatches || pattern.at(0) === ".") && (entryIsDirectory || entry.isSymbolicLink()) && !fromSymlink) {
            // If pattern after ** matches, or pattern starts with "."
            // and entry is a directory or symlink, add to potential patterns
            subPatterns.add(nextIndex);
          }

          if (!this.#followSymlinks && entry.isSymbolicLink()) {
            nSymlinks.add(index);
          }

          if (next === ".." && entryIsDirectory) {
            // In case pattern is "**/..",
            // both parent and current directory should be added to the queue
            // if this is the last pattern, add to results instead
            const parent = join(path, "..");
            if (nextIndex < last) {
              if (!this.#subpatterns.has(path) && !this.#cache.seen(path, pattern, nextIndex + 1)) {
                this.#subpatterns.set(path, [pattern.child(new Set<number>().add(nextIndex + 1))]);
              }
              if (!this.#subpatterns.has(parent) && !this.#cache.seen(parent, pattern, nextIndex + 1)) {
                this.#subpatterns.set(parent, [pattern.child(new Set<number>().add(nextIndex + 1))]);
              }
            } else {
              if (!this.#cache.seen(path, pattern, nextIndex)) {
                this.#cache.add(path, pattern.child(new Set<number>().add(nextIndex)));
                if (!this.#results.has(path)) {
                  if (this.#results.add(path)) {
                    yield this.#withFileTypes ? this.#cache.statSync(fullpath) : path;
                  }
                }
              }
              if (!this.#cache.seen(path, pattern, nextIndex) || !this.#cache.seen(parent, pattern, nextIndex)) {
                this.#cache.add(parent, pattern.child(new Set<number>().add(nextIndex)));
                if (!this.#results.has(parent)) {
                  if (this.#results.add(parent)) {
                    yield this.#withFileTypes ? this.#cache.statSync(join(this.#root, parent)) : parent;
                  }
                }
              }
            }
          }
        }
        if (typeof current === "string") {
          if (pattern.test(index, entry.name) && index !== last) {
            // If current pattern matches entry name
            // the next pattern is a potential pattern
            subPatterns.add(nextIndex);
          } else if (current === "." && pattern.test(nextIndex, entry.name)) {
            // If current pattern is ".", proceed to test next pattern
            if (nextIndex === last) {
              if (!this.#results.has(entryPath)) {
                if (this.#results.add(entryPath)) {
                  yield this.#withFileTypes ? entry : entryPath;
                }
              }
            } else {
              subPatterns.add(nextIndex + 1);
            }
          }
        }
        if (typeof current === "object" && pattern.test(index, entry.name)) {
          // If current pattern is a regex that matches entry name (e.g *.js)
          // add next pattern to potential patterns, or to results if it's the last pattern
          if (index === last) {
            if (!this.#results.has(entryPath)) {
              if (this.#results.add(entryPath)) {
                yield this.#withFileTypes ? entry : entryPath;
              }
            }
          } else if (entryIsDirectory) {
            subPatterns.add(nextIndex);
          }
        }
      }
      if (subPatterns.size > 0) {
        // If there are potential patterns, add to queue
        this.#addSubpattern(entryPath, pattern.child(subPatterns, nSymlinks, nextRealpaths));
      }
    }
  }
}

// `name` may not be writable on native Dirent instances.
function setDirentName(dirent: Dirent, name: string) {
  try {
    dirent.name = name;
  } catch {
    Object.defineProperty(dirent, "name", {
      value: name,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

function glob(pattern: string | string[], options?: GlobOptions) {
  return new Glob(pattern, options).glob();
}

function globSync(pattern: string | string[], options?: GlobOptions) {
  return new Glob(pattern, options).globSync();
}

export default { glob, globSync, Glob, matchGlobPattern };
