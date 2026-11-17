# Download only the required official NVIDIA NGX SDK files; never vendor SDK headers in git.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dlssRoot = Join-Path $repoRoot '.cache/dlss/310.9.16'
$commit = '9981c6350dc58c0ce21f024fd65e31e851c31689'
$files = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'dlss-sdk.json') | ConvertFrom-Json
foreach ($file in $files) {
  $target = Join-Path $dlssRoot $file.path
  if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $file.sha256) { continue }
  New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
  & curl.exe --fail --location --silent --show-error "https://raw.githubusercontent.com/NVIDIA/DLSS/$commit/$($file.path)" -o $target
  if ($LASTEXITCODE -ne 0) { throw "DLSS SDK download failed: $($file.path)" }
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) { throw "DLSS SDK checksum mismatch: $($file.path)" }
}
$runtime = Join-Path $dlssRoot 'lib/Windows_x86_64/rel/nvngx_dlss.dll'
if ((Get-AuthenticodeSignature -LiteralPath $runtime).Status -ne 'Valid') { throw 'NVIDIA DLSS runtime signature is invalid.' }
return $dlssRoot
