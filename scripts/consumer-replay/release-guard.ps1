$ErrorActionPreference = 'Stop'
$crate = (Resolve-Path 'consumer/apps/linux/src-tauri').Path
$scripts = @(Get-ChildItem "$crate/target/debug/build/openclaw-desktop-linux-*/build-script-build.exe")
if ($scripts.Count -ne 1) { throw "Expected exactly one native build script, found $($scripts.Count)" }
$env:PROFILE = 'release'
$env:CARGO_CFG_TARGET_OS = 'windows'
$env:OUT_DIR = "$env:RUNNER_TEMP/release-guard"
New-Item -ItemType Directory -Path $env:OUT_DIR | Out-Null
Push-Location $crate
try {
    $prior = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    $output = & $scripts[0].FullName 2>&1 | Out-String
    $code = $LASTEXITCODE
    $PSNativeCommandUseErrorActionPreference = $prior
} finally { Pop-Location }
$output | Set-Content proof/release-guard.log
if ($code -eq 0 -or $output -notmatch 'Unsigned Windows runtime proof is restricted to debug builds') {
    throw 'The actual Tauri build script did not reject unsigned release-profile input at the expected guard.'
}
@{ passed = $true; exitCode = $code; profile = 'release'; unsignedRejected = $true } |
    ConvertTo-Json | Set-Content proof/release-guard.json
