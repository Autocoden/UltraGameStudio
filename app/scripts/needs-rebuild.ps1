# Exit code 1 = source contents changed (rebuild needed); 0 = up to date.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File needs-rebuild.ps1 <exePath> <projectRoot>
param([string]$ExePath, [string]$Root, [switch]$WriteStamp)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { exit 1 }
$exe = Get-Item -LiteralPath $ExePath
$rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')

$dirs = @(
  "$Root\app\src",
  "$Root\app\src-tauri\src",
  "$Root\app\scripts",
  "$Root\app\cli",
  "$Root\packages\protocol"
) | Where-Object { Test-Path $_ }
$src = @()
if ($dirs.Count -gt 0) {
  $src = Get-ChildItem -Recurse -File $dirs -Include *.ts, *.tsx, *.rs, *.css, *.html, *.json, *.mjs, *.js, *.ps1
}
$cfgPaths = @(
  "$Root\app\index.html",
  "$Root\app\package.json",
  "$Root\app\package-lock.json",
  "$Root\app\vite.config.ts",
  "$Root\app\tailwind.config.ts",
  "$Root\app\tsconfig.json",
  "$Root\app\tsconfig.app.json",
  "$Root\app\tsconfig.cli.json",
  "$Root\app\tsconfig.node.json",
  "$Root\app\src-tauri\tauri.conf.json",
  "$Root\app\src-tauri\tauri.macos.conf.json",
  "$Root\app\src-tauri\tauri.linux.conf.json",
  "$Root\app\src-tauri\Cargo.toml",
  "$Root\app\src-tauri\Cargo.lock",
  "$Root\app\src-tauri\build.rs",
  "$Root/backend/src/workspace-skill-service.mjs",
  "$Root/app/src-tauri/rust-toolchain.toml",
  "$Root\app\src-tauri\capabilities\default.json"
) | Where-Object { Test-Path $_ }
$cfg = @()
if ($cfgPaths.Count -gt 0) { $cfg = Get-ChildItem -File $cfgPaths }

$all = @($src) + @($cfg)
[string[]]$lines = @($all | Sort-Object FullName -Unique | ForEach-Object {
  $relative = $_.FullName.Substring($rootPath.Length + 1).Replace('\', '/')
  $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  "$relative`:$hash"
})
[Array]::Sort($lines, [StringComparer]::Ordinal)
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  $sourceHash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
} finally {
  $sha.Dispose()
}
$exeHash = (Get-FileHash -LiteralPath $exe.FullName -Algorithm SHA256).Hash
$stampPath = "$($exe.FullName).sources.json"
if ($WriteStamp) {
  $stamp = @{ version = 1; sourceHash = $sourceHash; exeHash = $exeHash }
  $temporary = "$stampPath.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($temporary, ($stamp | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $stampPath -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
  exit 0
}
if (-not (Test-Path -LiteralPath $stampPath -PathType Leaf)) { exit 1 }
try {
  $stamp = Get-Content -LiteralPath $stampPath -Raw | ConvertFrom-Json
} catch {
  exit 1
}
if ($stamp.version -eq 1 -and $stamp.sourceHash -eq $sourceHash -and $stamp.exeHash -eq $exeHash) {
  exit 0
}
exit 1
