# Syntax-only parser check: parse keepalive-restart.ps1 without executing its process lifecycle.
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path (Join-Path $PSScriptRoot '..\routing\keepalive-restart.ps1')),
  [ref]$tokens,
  [ref]$errors
) | Out-Null
if ($errors.Count -gt 0) {
  $errors | ForEach-Object { Write-Error $_.Message }
  exit 1
}
Write-Host 'check-keepalive-restart-syntax: PASS'
