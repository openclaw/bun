import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function resolveLaunchTarget(options) {
  const usingRuntime = Boolean(options.runtime || options.entry);
  assert(Boolean(options.artifact) !== usingRuntime,
    'select either --artifact or the --runtime/--entry pair');
  if (usingRuntime) {
    assert(options.runtime && options.entry, '--runtime and --entry are required together');
    const binary = fs.realpathSync(options.runtime);
    const entry = fs.realpathSync(options.entry);
    fs.accessSync(binary, fs.constants.X_OK);
    assert(fs.statSync(entry).isFile(), '--entry must be a file');
    return { kind: 'runtime-entry', artifact: null, binary, entry, prefix: [entry] };
  }
  const artifact = fs.realpathSync(options.artifact);
  const binary = path.join(artifact, 'openclaw');
  fs.accessSync(binary, fs.constants.X_OK);
  assert(fs.statSync(path.join(artifact, 'runtime')).isDirectory(), 'artifact runtime/ is missing');
  return { kind: 'standalone', artifact, binary, entry: null, prefix: [] };
}

export function launchArguments(target, args) {
  return [...target.prefix, ...args];
}
