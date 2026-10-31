const input=await Bun.file(process.argv[2]).json();
const rows=[];
for(const mod of input.modules){try {const value=await import(mod.specifier);const available=Object.keys(value).sort();const missing=mod.names.filter(name=>!Object.prototype.hasOwnProperty.call(value,name));rows.push({...mod,missing,available,undefinedValues:mod.names.filter(name=>value[name]===undefined)});}catch(error){rows.push({...mod,error:String(error),missing:mod.names});}}
const result={revision:Bun.revision,version:Bun.version,execPath:process.execPath,modules:rows,missing:rows.filter(x=>x.error||x.missing.length)};
await Bun.write(process.argv[3],JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify({version:result.version,missing:result.missing},null,2));
