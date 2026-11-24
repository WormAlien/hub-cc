param(
  [string]$Mode = 'on',
  [string]$Provider = 'freegg',
  [string]$ScriptPath = '',
  [switch]$RegistryArray
)
$ErrorActionPreference = 'Stop'
if (-not $ScriptPath) { $ScriptPath = Join-Path $PSScriptRoot '..\routing\keepalive-restart.ps1' }
$source = Get-Content -LiteralPath $ScriptPath -Raw
$start = $source.IndexOf("# Registered provider rate balancing is a persisted user choice")
$end = $source.IndexOf("# KVOTUM (:20182)", $start)
if ($start -lt 0 -or $end -le $start) { throw 'provider persisted-rate restart block not found' }
$block = $source.Substring($start, $end - $start)
$tempHome = Join-Path ([System.IO.Path]::GetTempPath()) ('freegg-restart-rate-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $tempHome '.claude') | Out-Null
try {
  $legacyFreeggBalance = $env:FREEGG_RATE_BALANCE
  $legacyFreeggScope = $env:FREEGG_RATE_SCOPE
  $profileDir = $tempHome
  $Port = if ($Provider -eq 'freegg') { 20184 } else { 20999 }
  $dir = $tempHome
  $perPort = @{ $Port = @{} }
  $providerName = if ($Provider -eq 'freegg') { 'FreeGG' } else { 'Synthetic' }
  Remove-Item Env:FREEGG_RATE_BALANCE -ErrorAction SilentlyContinue
  Remove-Item Env:FREEGG_RATE_SCOPE -ErrorAction SilentlyContinue
  Remove-Item Env:RATE_BALANCE -ErrorAction SilentlyContinue
  Remove-Item Env:RATE_BALANCE_SCOPE -ErrorAction SilentlyContinue
  Remove-Item Env:CUSTOM_PROVIDER_ID -ErrorAction SilentlyContinue
  Remove-Item Env:CUSTOM_PROVIDER_NAME -ErrorAction SilentlyContinue
  Remove-Item Env:SESSIONS_FILE -ErrorAction SilentlyContinue
  $pfx = if ($Provider -eq 'freegg') { 'fg' } else { 'zz' }
  $sessionsName = "$Provider-sessions.json"
  $sessionsPath = Join-Path $tempHome $sessionsName
  '[]' | Set-Content -LiteralPath $sessionsPath -Encoding UTF8
  $registry = @{}
  $registry[$Provider] = @{ pfx = $pfx; name = $providerName; port = $Port; scope = 'account'; enabled = $false; sessionsFile = ('$ROUTING/' + $sessionsName) }
  $registryJson = $registry | ConvertTo-Json -Depth 5
  if ($RegistryArray) { $registryJson = '[' + $registryJson + ']' }
  $registryJson | Set-Content -LiteralPath (Join-Path $tempHome 'rate-balance-providers.json') -Encoding UTF8
  $rateName = if ($Provider -eq 'freegg') { 'freegg-rate-policy.json' } else { "$Provider-rate-policy.json" }
  $cfg = Join-Path $tempHome ".claude\$rateName"
  switch ($Mode) {
    'on'      { '{"enabled":true}' | Set-Content -LiteralPath $cfg -Encoding UTF8 }
    'off'     { '{"enabled":false}' | Set-Content -LiteralPath $cfg -Encoding UTF8 }
    'array'   { '[{"enabled":true}]' | Set-Content -LiteralPath $cfg -Encoding UTF8 }
    'corrupt' { '{broken' | Set-Content -LiteralPath $cfg -Encoding UTF8 }
    'missing' { }
    default   { throw "Unknown mode $Mode" }
  }
  Invoke-Expression $block
  if ($RegistryArray) {
    if ($env:RATE_BALANCE -eq '1' -or $env:FREEGG_RATE_BALANCE -eq '1') { throw 'array registry unexpectedly enabled balancing' }
    if ($env:CUSTOM_PROVIDER_ID -or $env:CUSTOM_PROVIDER_NAME -or $env:SESSIONS_FILE) { throw 'array registry unexpectedly enriched provider settings' }
    Write-Host 'check-freegg-restart-rate: array registry PASS'
    return
  }
  if ($Mode -eq 'array' -and $env:RATE_BALANCE -ne '0') { throw "array root unexpectedly enabled balancing" }
  $expectOn = $Mode -eq 'on'
  if ($Provider -eq 'freegg') {
    if ($env:FREEGG_RATE_BALANCE -ne $(if ($expectOn) { '1' } else { '0' })) { throw "unexpected balance=$env:FREEGG_RATE_BALANCE for $Mode" }
    if ($env:FREEGG_RATE_SCOPE -ne $(if ($expectOn) { 'account' } else { 'off' })) { throw "unexpected scope=$env:FREEGG_RATE_SCOPE for $Mode" }
  }
  if ($env:RATE_BALANCE -ne $(if ($expectOn) { '1' } else { '0' })) { throw "unexpected generic balance=$env:RATE_BALANCE for $Mode" }
  if ($env:RATE_BALANCE_SCOPE -ne $(if ($expectOn) { 'account' } else { 'off' })) { throw "unexpected generic scope=$env:RATE_BALANCE_SCOPE for $Mode" }
  if ($env:CUSTOM_PROVIDER_ID -ne $Provider) { throw "generic provider id was not exported after registry enrichment" }
  if ($env:CUSTOM_PROVIDER_NAME -ne $providerName) { throw "generic provider name was not exported after registry enrichment" }
  if ($env:SESSIONS_FILE -ne $sessionsPath) { throw "generic sessions file was not exported: $env:SESSIONS_FILE" }
  Write-Host "check-freegg-restart-rate: $Mode PASS"
} finally {
  if ($null -ne $legacyFreeggBalance) { $env:FREEGG_RATE_BALANCE = $legacyFreeggBalance } else { Remove-Item Env:FREEGG_RATE_BALANCE -ErrorAction SilentlyContinue }
  if ($null -ne $legacyFreeggScope) { $env:FREEGG_RATE_SCOPE = $legacyFreeggScope } else { Remove-Item Env:FREEGG_RATE_SCOPE -ErrorAction SilentlyContinue }
  Remove-Item Env:RATE_BALANCE -ErrorAction SilentlyContinue
  Remove-Item Env:RATE_BALANCE_SCOPE -ErrorAction SilentlyContinue
  Remove-Item Env:CUSTOM_PROVIDER_ID -ErrorAction SilentlyContinue
  Remove-Item Env:CUSTOM_PROVIDER_NAME -ErrorAction SilentlyContinue
  Remove-Item Env:SESSIONS_FILE -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tempHome -Recurse -Force -ErrorAction SilentlyContinue
}
