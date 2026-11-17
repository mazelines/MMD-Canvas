$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nativeOut = Join-Path $repoRoot 'out/dx12'
New-Item -ItemType Directory -Force -Path $nativeOut | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw 'Visual Studio C++ x64 tools are required.' }
$vcRoot = (Get-ChildItem -LiteralPath (Join-Path $vsRoot 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdkVersion = (Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'um/d3d12.h') } | Sort-Object Name -Descending | Select-Object -First 1).Name
$vcBin = Join-Path $vcRoot 'bin/Hostx64/x64'
$sdkBin = Join-Path $sdkRoot "bin/$sdkVersion/x64"
$env:PATH = "$vcBin;$sdkBin;$env:PATH"
$env:INCLUDE = "$vcRoot/include;$sdkRoot/Include/$sdkVersion/ucrt;$sdkRoot/Include/$sdkVersion/shared;$sdkRoot/Include/$sdkVersion/um;$sdkRoot/Include/$sdkVersion/winrt"
$env:LIB = "$vcRoot/lib/x64;$sdkRoot/Lib/$sdkVersion/ucrt/x64;$sdkRoot/Lib/$sdkVersion/um/x64"
foreach ($entry in @('vertexMain:vs', 'outlineVertex:vs', 'outlineMain:ps', 'normalMain:ps', 'colorMain:ps', 'packMain:cs', 'mipMain:cs', 'cortaoMain:cs', 'outputMain:cs')) {
  $parts = $entry.Split(':')
  & (Join-Path $sdkBin 'dxc.exe') -E $parts[0] -T "$($parts[1])_6_6" -I (Join-Path $repoRoot 'native/dx12') -I (Join-Path $repoRoot 'renderer/vendor/cortao') -Fo (Join-Path $nativeOut "$($parts[0]).cso") (Join-Path $repoRoot 'native/dx12/viewport.hlsl')
  if ($LASTEXITCODE -ne 0) { throw "Shader compilation failed: $entry" }
}
& (Join-Path $vcBin 'cl.exe') /nologo /std:c++20 /EHsc /O2 /W4 /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX /MT (Join-Path $repoRoot 'native/dx12/main.cpp') "/Fo$nativeOut/" "/Fe$nativeOut/mmd-dx12.exe" /link d3d12.lib dxgi.lib dxguid.lib
if ($LASTEXITCODE -ne 0) { throw 'DX12 native build failed.' }
Write-Output "Built $nativeOut/mmd-dx12.exe"
Copy-Item -LiteralPath (Join-Path $repoRoot 'renderer/vendor/cortao/32x32x24x32_R32_UINT.bin') -Destination $nativeOut
