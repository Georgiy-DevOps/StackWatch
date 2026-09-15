# Run with PowerShell 7. Produces a source archive without runtime data or Git history.
[CmdletBinding()]
param([string]$Destination)
$ErrorActionPreference='Stop'
$pulseRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $Destination) { $Destination=Join-Path (Split-Path -Parent $pulseRoot) 'pulsewatch-v2.zip' }
$pulseZipPath=[IO.Path]::GetFullPath($Destination)
$pulseOutputFolder=[IO.Path]::GetDirectoryName($pulseZipPath)
if (-not (Test-Path -LiteralPath $pulseOutputFolder -PathType Container)) { throw 'Destination folder must exist' }
$pulseTemporary=Join-Path $pulseOutputFolder ('pulsewatch-build-'+[Guid]::NewGuid().ToString('N')+'.zip')
$pulseExcluded=@('.git','data','watchdog-data','backups','node_modules')
$pulseFiles=@(Get-ChildItem -LiteralPath $pulseRoot -Recurse -Force -File | Where-Object {
  $relative=[IO.Path]::GetRelativePath($pulseRoot,$_.FullName)
  $ignoredPart=(($relative -split '[\\/]') | Where-Object { $_ -in $pulseExcluded })
  $privateEnv=$_.Name -like '.env*' -and $_.Name -notlike '*.example'
  -not $ignoredPart -and -not $privateEnv -and $_.Name -notmatch '^(runtime-settings\.json|connection-.*\.json|ssh_known_hosts.*|id_rsa.*|id_ed25519.*)$' -and $_.Name -notmatch '\.(log|sqlite(-.*)?|db(-.*)?|key|pem|p12|pfx|zip|tar|tar\.gz|tgz)$'
})
$pulseZip=[IO.Compression.ZipFile]::Open($pulseTemporary,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $pulseFiles) {
    $entry='pulsewatch/'+[IO.Path]::GetRelativePath($pulseRoot,$file.FullName).Replace('\','/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($pulseZip,$file.FullName,$entry,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $pulseZip.Dispose() }
$pulseCheck=[IO.Compression.ZipFile]::OpenRead($pulseTemporary)
try {
  if (@($pulseCheck.Entries | Where-Object { $_.FullName -match '(^|/)(\.git|data|watchdog-data|backups)/|/\.env(\.[^/]*)?$' -and $_.Name -notlike '*.example' }).Count) { throw 'Unexpected private data' }
  $pulseCount=$pulseCheck.Entries.Count
} finally { $pulseCheck.Dispose() }
# Both move targets have been resolved to explicit files in the chosen output directory.
if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($pulseTemporary)) -ne $pulseOutputFolder -or [IO.Path]::GetDirectoryName($pulseZipPath) -ne $pulseOutputFolder) { throw 'Invalid archive destination' }
Move-Item -LiteralPath $pulseTemporary -Destination $pulseZipPath -Force
@{entries=$pulseCount;contains_private_data=$false;bytes=(Get-Item -LiteralPath $pulseZipPath).Length} | ConvertTo-Json -Compress
