# agy-cred.ps1 - read/write the Antigravity CLI credential entry in the Windows vault.
#
# Why this file exists. `agy` keeps its Google sign-in in the Windows Credential Manager as
# ONE entry with a FIXED name (`gemini:antigravity`), per OS user. There is no --profile,
# --auth-store, --data-dir or environment variable to relocate it (upstream issues #155 and
# #381 are open). So "N accounts" cannot be done by copying a config folder: the entry itself
# has to be saved per account and put back before a run.
#
# Commands:
#   dump            - metadata of the entry only: target, user, type, persist, blob length,
#                     and whether the blob looks like JSON. THE SECRET IS NEVER PRINTED.
#   list            - every vault entry whose target mentions gemini or antigravity.
#   save  -Path F   - write the entry's blob to file F (raw bytes).
#   load  -Path F   - put the blob from file F into the vault (same target/user/persist).
#
# Run as a file, not through an inline command: this box is Windows and inline PowerShell
# output gets mangled to cp866. Keep this script ASCII - no BOM problems, no code page games.

param(
    [Parameter(Mandatory = $true)][ValidateSet('dump', 'list', 'save', 'load')][string]$Action,
    [string]$Path,
    [string]$Target = 'gemini:antigravity',
    [string]$User = 'antigravity'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
}

public static class Vault {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, uint reserved, out IntPtr credentialPtr);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr buffer);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, uint type, uint flags);
}
'@

$CRED_TYPE_GENERIC = 1

function Read-Entry([string]$t) {
    $ptr = [IntPtr]::Zero
    if (-not [Vault]::CredRead($t, $CRED_TYPE_GENERIC, 0, [ref]$ptr)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "CredRead failed for '$t' (win32 $code)"
    }
    try {
        $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CREDENTIAL])
        $bytes = New-Object byte[] $cred.CredentialBlobSize
        if ($cred.CredentialBlobSize -gt 0) {
            [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
        }
        return [pscustomobject]@{ Cred = $cred; Bytes = $bytes }
    } finally {
        [Vault]::CredFree($ptr)
    }
}

switch ($Action) {
    'dump' {
        $e = Read-Entry $Target
        $text = [Text.Encoding]::UTF8.GetString($e.Bytes)
        $isJson = $text.TrimStart().StartsWith('{')
        $hasRefresh = $text -match 'refresh_token'
        # Metadata only. The blob IS the OAuth credential: printing it would put a live
        # token into the log, and the log goes into screenshots.
        [pscustomobject]@{
            target      = $Target
            user        = $e.Cred.UserName
            type        = $e.Cred.Type
            persist     = $e.Cred.Persist
            blob_bytes  = $e.Cred.CredentialBlobSize
            looks_json  = $isJson
            has_refresh = $hasRefresh
        } | ConvertTo-Json -Compress
    }
    'list' {
        # Not implemented on purpose unless needed: CredEnumerate needs another P/Invoke and
        # nothing here uses it yet. `cmdkey /list` shows the entry names without secrets.
        Write-Output 'use cmdkey /list to see entry names; this helper works with -Target'
    }
    'save' {
        if (-not $Path) { throw 'save needs -Path' }
        $e = Read-Entry $Target
        [IO.File]::WriteAllBytes($Path, $e.Bytes)
        Write-Output ("saved {0} bytes from '{1}' into {2}" -f $e.Bytes.Length, $Target, $Path)
    }
    'load' {
        if (-not $Path) { throw 'load needs -Path' }
        if (-not (Test-Path -LiteralPath $Path)) { throw "no file at $Path" }
        $bytes = [IO.File]::ReadAllBytes($Path)
        $existing = $null
        try { $existing = Read-Entry $Target } catch { }
        $blobPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
        try {
            [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blobPtr, $bytes.Length)
            $cred = New-Object CREDENTIAL
            $cred.Type = $CRED_TYPE_GENERIC
            $cred.TargetName = $Target
            $cred.UserName = $User
            $cred.CredentialBlob = $blobPtr
            $cred.CredentialBlobSize = [uint32]$bytes.Length
            # Keep the persist level the entry already had; local machine is the default.
            $cred.Persist = if ($existing) { $existing.Cred.Persist } else { 2 }
            if (-not [Vault]::CredWrite([ref]$cred, 0)) {
                $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                throw "CredWrite failed (win32 $code)"
            }
        } finally {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
        }
        Write-Output ("loaded {0} bytes into '{1}'" -f $bytes.Length, $Target)
    }
}
