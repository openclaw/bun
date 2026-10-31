import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=fs.realpathSync(process.argv[2]);
const owner=await import(pathToFileURL(path.join(root,'scripts/lib/bun-standalone-plugins.mjs')));
const ids=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const selection=owner.planStandalonePlugins(root,ids);
function walk(dir,relative='dist') {
 const files=[];
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
  if(['node_modules','control-ui','worker-artifacts'].includes(entry.name))continue;
  const name=path.posix.join(relative,entry.name);
  if(entry.isDirectory()&&!entry.isSymbolicLink())files.push(...walk(path.join(dir,entry.name),name));
  else if(entry.isFile()&&/\.[cm]?js$/.test(entry.name))files.push(name);
 }
 return files;
}
const inventory=walk(path.join(root,'dist')).toSorted();
const selected=await owner.selectStandalonePluginModules(root,inventory,selection);
const embeddedPaths=Object.fromEntries(selected.map(entry=>[entry,`/synthetic-image/${entry}`]));
const contract=owner.createStandalonePluginContract({runtimeRoot:root,plugins:selection,embeddedPaths});
console.log(JSON.stringify({sourceRoot:root,inventory:inventory.length,selected:selected.length,plugins:Object.keys(contract.plugins).length,sdkExports:Object.keys(contract.sdk).length,defaults:Object.fromEntries(['active-memory','device-pair','talk-voice'].map(id=>[id,contract.plugins[id]])),proof:'Real desktop module-selection and plugin-contract owners; synthetic image paths, no native/runtime execution'},null,2));
