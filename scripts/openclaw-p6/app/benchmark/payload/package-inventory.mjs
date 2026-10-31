import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function inspectPackageExtensions(packageRoot) {
  const root = path.join(packageRoot, 'dist/extensions');
  const directories = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const plugins = [], nonPluginDirectories = [];
  for (const directory of directories) {
    const filename = path.join(root, directory, 'openclaw.plugin.json');
    if (!fs.existsSync(filename)) { nonPluginDirectories.push(directory); continue; }
    const bytes = fs.readFileSync(filename);
    plugins.push({ directory, id: JSON.parse(bytes).id,
      manifestSha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { directories, plugins, nonPluginDirectories };
}
