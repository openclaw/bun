$ErrorActionPreference = 'Stop'
$tools = Join-Path $PWD 'hang-tools'
New-Item -ItemType Directory -Force $tools | Out-Null
Invoke-WebRequest 'https://download.sysinternals.com/files/Procdump.zip' -OutFile "$tools/procdump.zip"
Expand-Archive "$tools/procdump.zip" "$tools/procdump"
$procdump = (Resolve-Path "$tools/procdump/procdump64a.exe").Path
if ((Get-AuthenticodeSignature $procdump).Status -ne 'Valid') { throw 'ProcDump signature is invalid.' }
$cdb = "${env:ProgramFiles(x86)}/Windows Kits/10/Debuggers/arm64/cdb.exe"
if (Test-Path $cdb) { $cdb = (Resolve-Path $cdb).Path } else { $cdb = '-' }
@{ procdump = $procdump; cdb = $cdb; procdumpHash = (Get-FileHash $procdump).Hash; cdbAvailable = ($cdb -ne '-') } | ConvertTo-Json | Set-Content "$tools/tools.json"
"procdump=$procdump" >> $env:GITHUB_OUTPUT
"cdb=$cdb" >> $env:GITHUB_OUTPUT
