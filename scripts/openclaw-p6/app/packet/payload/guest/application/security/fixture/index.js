const { dlopen, FFIType } = require('bun:ffi');
function probe() {
  const first = dlopen('/mnt/p6/security/libp6mdwe.so', {
    p6_get_mdwe:{args:[],returns:FFIType.i64},
    p6_try_exec:{args:[],returns:FFIType.i32},
    p6_try_rwx:{args:[],returns:FFIType.i32},
  });
  let row;
  try { row={kind:'actual-application-plugin-main',isMainThread:require('node:worker_threads').isMainThread,pid:process.pid,executable:process.execPath,arch:process.arch,platform:process.platform,mdwe:Number(first.symbols.p6_get_mdwe()),rwToRx:first.symbols.p6_try_exec(),rwx:first.symbols.p6_try_rwx()}; }
  finally { first.close(); }
  const second=dlopen('/mnt/p6/security/libp6fileexec.so',{p6_file_private_rx:{args:[],returns:FFIType.i32}});
  try { row.filePrivateRx=second.symbols.p6_file_private_rx(); }
  finally { second.close(); }
  console.log('P6_MDWE_RESULT '+JSON.stringify(row));
  if(row.mdwe!==Number(process.env.P6_EXPECT_MDWE)||row.isMainThread!==true||row.rwToRx!==-13||row.rwx!==-13||row.filePrivateRx!==42) process.exitCode=1;
}
module.exports={id:'p6-mdwe-fixture',name:'P6 MDWE fixture',register(api){
 api.registerCli(({program})=>{program.command('p6-mdwe').description('Synthetic MDWE qualification').action(probe);},{descriptors:[{name:'p6-mdwe',description:'Synthetic MDWE qualification',hasSubcommands:false}]});
}};
