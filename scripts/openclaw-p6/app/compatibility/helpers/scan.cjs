const fs=require("node:fs");
const path=require("node:path");
const {builtinModules}=require("node:module");
const ts=require(process.env.PROBE_TYPESCRIPT);
const root=process.env.PROBE_MODULES;
const builtin=new Set(builtinModules.flatMap(x=>[x,x.replace(/^node:/,""),"node:"+x.replace(/^node:/,"")]));
const records=[];let files=0,bytes=0;
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.isFile()&&/\.[cm]?js$/.test(e.name))scan(f);}}
function scan(file){const source=fs.readFileSync(file,"utf8");files++;bytes+=Buffer.byteLength(source);const parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
for(const node of parsed.statements){let module,names=[];
if(ts.isImportDeclaration(node)){module=node.moduleSpecifier;if(node.importClause){if(node.importClause.name)names.push("default");const b=node.importClause.namedBindings;if(b&&ts.isNamedImports(b))names.push(...b.elements.map(x=>(x.propertyName??x.name).text));}}
else if(ts.isExportDeclaration(node)&&node.moduleSpecifier){module=node.moduleSpecifier;const b=node.exportClause;if(b&&ts.isNamedExports(b))names.push(...b.elements.map(x=>(x.propertyName??x.name).text));}
if(!module||!ts.isStringLiteral(module))continue;const specifier=module.text;if(!builtin.has(specifier)&&!specifier.startsWith("node:")&&!specifier.startsWith("bun:"))continue;
const line=parsed.getLineAndCharacterOfPosition(node.getStart()).line+1;
records.push({file:path.relative(root,file),line,specifier,names,kind:ts.isImportDeclaration(node)?"import":"export"});}}
walk(root);
const groups={};for(const row of records){const canonical=row.specifier.startsWith("bun:")?row.specifier:"node:"+row.specifier.replace(/^node:/,"");groups[canonical]??={names:new Set(),count:0};for(const name of row.names)groups[canonical].names.add(name);groups[canonical].count++;}
const modules=Object.entries(groups).sort().map(([specifier,x])=>({specifier,names:[...x.names].sort(),sites:x.count}));
const result={root,files,bytes,sites:records.length,modules,records};fs.writeFileSync(process.env.PROBE_OUTPUT,JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify({files,bytes,sites:records.length,modules:modules.length,namedExports:modules.reduce((n,x)=>n+x.names.length,0)}));
