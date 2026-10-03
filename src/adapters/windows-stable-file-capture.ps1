Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Failure([string] $Code) {
  try {
    [Console]::Out.Write(([ordered]@{ error_code = $Code } | ConvertTo-Json -Compress))
  } catch {}
  exit 2
}

try {
  $rawRequest = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($rawRequest)) { Write-Failure 'request_invalid' }
  $request = $rawRequest | ConvertFrom-Json

  $expectedNames = @('canonical_path','max_bytes','include_bytes','hold_open_ms')
  $actualNames = @($request.PSObject.Properties.Name | Sort-Object)
  $wantedNames = @($expectedNames | Sort-Object)
  if (@(Compare-Object $actualNames $wantedNames).Count -ne 0) { Write-Failure 'request_invalid' }
  if (-not ($request.canonical_path -is [string]) -or [string]::IsNullOrWhiteSpace($request.canonical_path)) {
    Write-Failure 'request_invalid'
  }
  if (-not ($request.include_bytes -is [bool])) { Write-Failure 'request_invalid' }

  $maxBytes = [int64]$request.max_bytes
  if ($maxBytes -lt 1 -or $maxBytes -gt 1073741824 -or [double]$request.max_bytes -ne [double]$maxBytes) {
    Write-Failure 'request_invalid'
  }
  $holdOpenMs = [int]$request.hold_open_ms
  if ($holdOpenMs -lt 0 -or $holdOpenMs -gt 5000 -or [double]$request.hold_open_ms -ne [double]$holdOpenMs) {
    Write-Failure 'request_invalid'
  }

  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class RdcWebsiteStudioFileIdentityV1 {
    [StructLayout(LayoutKind.Sequential)]
    public struct FILETIME {
        public uint LowDateTime;
        public uint HighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BY_HANDLE_FILE_INFORMATION {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandle(
        SafeFileHandle hFile,
        out BY_HANDLE_FILE_INFORMATION lpFileInformation);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFinalPathNameByHandle(
        SafeFileHandle hFile,
        [Out] StringBuilder lpszFilePath,
        uint cchFilePath,
        uint dwFlags);
}
"@

  $stream = $null
  $memory = $null
  $sha = $null
  try {
    $stream = [System.IO.FileStream]::new(
      $request.canonical_path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::Read,
      65536,
      [System.IO.FileOptions]::SequentialScan
    )

    $info = New-Object RdcWebsiteStudioFileIdentityV1+BY_HANDLE_FILE_INFORMATION
    if (-not [RdcWebsiteStudioFileIdentityV1]::GetFileInformationByHandle($stream.SafeFileHandle, [ref]$info)) {
      Write-Failure 'identity_failed'
    }

    $attributes = [uint32]$info.FileAttributes
    if (
      ($attributes -band 0x10) -ne 0 -or
      ($attributes -band 0x40) -ne 0 -or
      ($attributes -band 0x400) -ne 0 -or
      [uint32]$info.NumberOfLinks -ne 1
    ) {
      Write-Failure 'unsafe_file'
    }

    $reportedSize = (([uint64]$info.FileSizeHigh -shl 32) -bor [uint64]$info.FileSizeLow)
    if ($reportedSize -gt [uint64]$maxBytes -or [uint64]$stream.Length -ne $reportedSize) {
      Write-Failure 'size_invalid'
    }

    $builder = New-Object System.Text.StringBuilder 32768
    $finalLength = [RdcWebsiteStudioFileIdentityV1]::GetFinalPathNameByHandle(
      $stream.SafeFileHandle,
      $builder,
      [uint32]$builder.Capacity,
      0
    )
    if ($finalLength -eq 0 -or $finalLength -ge [uint32]$builder.Capacity) {
      Write-Failure 'final_path_failed'
    }
    $finalPath = $builder.ToString()
    if ($finalPath.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
      Write-Failure 'unsafe_path'
    }
    if ($finalPath.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
      $finalPath = $finalPath.Substring(4)
    }
    if ($finalPath.StartsWith('\\', [StringComparison]::Ordinal)) {
      Write-Failure 'unsafe_path'
    }

    $fileIndex = (([uint64]$info.FileIndexHigh -shl 32) -bor [uint64]$info.FileIndexLow)
    $sourceIdentity = 'win32:{0:x8}:{1:x16}' -f [uint32]$info.VolumeSerialNumber, $fileIndex

    $fileTimeTicks = (([uint64]$info.LastWriteTime.HighDateTime -shl 32) -bor [uint64]$info.LastWriteTime.LowDateTime)
    $unixTicks = [decimal]$fileTimeTicks - [decimal]116444736000000000
    $unixMs = [int64][Math]::Round(
      [double]($unixTicks / [decimal]10000),
      0,
      [MidpointRounding]::AwayFromZero
    )
    $modifiedAt = [DateTimeOffset]::FromUnixTimeMilliseconds($unixMs).UtcDateTime.ToString(
      "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
      [Globalization.CultureInfo]::InvariantCulture
    )

    $memory = [System.IO.MemoryStream]::new()
    $buffer = New-Object byte[] 65536
    $total = [int64]0
    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $total += [int64]$read
      if ($total -gt $maxBytes) { Write-Failure 'size_invalid' }
      $memory.Write($buffer, 0, $read)
    }
    if ($total -ne [int64]$reportedSize) { Write-Failure 'size_changed' }

    $bytes = $memory.ToArray()
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash($bytes)
    $digest = 'sha256:' + ([BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant())

    if ($holdOpenMs -gt 0) {
      Start-Sleep -Milliseconds $holdOpenMs
    }

    $bytesBase64 = $null
    if ($request.include_bytes) {
      $bytesBase64 = [Convert]::ToBase64String($bytes)
    }

    $response = [ordered]@{
      canonical_path = $finalPath
      source_identity = $sourceIdentity
      size_bytes = [int64]$reportedSize
      modified_at = $modifiedAt
      content_digest = $digest
      hard_link_count = [int]$info.NumberOfLinks
      is_file = $true
      is_symlink = $false
      is_reparse_point = $false
      bytes_base64 = $bytesBase64
    }
    [Console]::Out.Write(($response | ConvertTo-Json -Compress))
  } finally {
    if ($sha -ne $null) { $sha.Dispose() }
    if ($memory -ne $null) { $memory.Dispose() }
    if ($stream -ne $null) { $stream.Dispose() }
  }
} catch {
  Write-Failure 'capture_failed'
}
