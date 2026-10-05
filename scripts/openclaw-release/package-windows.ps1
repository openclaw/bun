param(
  [Parameter(Mandatory)][string]$Dist,
  [Parameter(Mandatory)][long]$Mtime,
  [Parameter(Mandatory)][ValidateSet('SignedRelease', 'UnsignedTest')][string]$Mode
)
$ErrorActionPreference = 'Stop'
$Dist = (Resolve-Path -LiteralPath $Dist).Path
$expectedSignerSubject = 'CN=OpenClaw Foundation, O=OpenClaw Foundation, L=Mill Valley, S=California, C=US'
$targets = @(
  @{ Name = 'windows-x64'; Triplet = 'bun-windows-x64'; Machine = 0x8664 },
  @{ Name = 'windows-arm64'; Triplet = 'bun-windows-aarch64'; Machine = 0xaa64 }
)
$found = 0
function Hash([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function Pack([string]$Directory) {
  $root = Join-Path $Dist $Directory
  $stream = [IO.File]::Open((Join-Path $Dist "$Directory.zip"), [IO.FileMode]::CreateNew)
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in (Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName)) {
      $relative = [IO.Path]::GetRelativePath($Dist, $file.FullName).Replace('\', '/')
      $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = [DateTimeOffset]::FromUnixTimeSeconds($Mtime)
      $inputStream = $file.OpenRead()
      $outputStream = $entry.Open()
      try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
  } finally { $archive.Dispose(); $stream.Dispose() }
}
foreach ($target in $targets) {
  $triplet = $target.Triplet
  if (-not (Test-Path -LiteralPath (Join-Path $Dist $triplet))) {
    if ($Mode -eq 'SignedRelease') { throw "Missing release target $triplet" }
    continue
  }
  $found++
  $executables = @((Join-Path $Dist "$triplet/bun.exe"), (Join-Path $Dist "$triplet-profile/bun-profile.exe"))
  foreach ($exe in $executables) {
    $bytes = [IO.File]::ReadAllBytes($exe)
    $pe = [BitConverter]::ToInt32($bytes, 0x3c)
    if ([BitConverter]::ToUInt16($bytes, $pe + 4) -ne $target.Machine) { throw "Wrong PE architecture: $exe" }
    if ($Mode -eq 'SignedRelease') {
      $signature = Get-AuthenticodeSignature -LiteralPath $exe
      if ($signature.Status -ne 'Valid') { throw "$exe Authenticode signature was $($signature.Status)." }
      if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -cne $expectedSignerSubject) {
        throw "$exe has an unexpected signer subject."
      }
      if (-not $signature.TimeStamperCertificate) { throw "$exe has no timestamp certificate." }
    }
  }
  Pack $triplet
  Pack "$triplet-profile"
  $record = @{
    authenticodeSigned = $Mode -eq 'SignedRelease'
    testOnly = $Mode -eq 'UnsignedTest'
    executableSha256 = Hash $executables[0]
    profileExecutableSha256 = Hash $executables[1]
    archiveSha256 = Hash (Join-Path $Dist "$triplet.zip")
    profileArchiveSha256 = Hash (Join-Path $Dist "$triplet-profile.zip")
  }
  if ($Mode -eq 'SignedRelease') { $record.signerSubject = $expectedSignerSubject }
  $record | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Dist "$($target.Name).signing.json")
}
if ($found -eq 0) { throw 'No Windows executables to package.' }
