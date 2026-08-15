[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = 'Stop'

$existing = @(Get-Process -Name 'POWERPNT' -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
  [ordered]@{
    available = $false
    reason = 'powerpoint-running'
    error = 'PowerPoint is already running. The check was cancelled to avoid interfering with the existing session.'
    processIds = @($existing | ForEach-Object { $_.Id })
  } | ConvertTo-Json -Compress
  exit 3
}

$powerPoint = $null
$ownsPowerPoint = $false
$version = $null
$operationError = $null
$cleanupErrors = [System.Collections.Generic.List[string]]::new()
$sessionChanged = $false

try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $ownsPowerPoint = $true
  $version = [string]$powerPoint.Version
}
catch {
  $operationError = $_.Exception.Message
}
finally {
  if ($ownsPowerPoint -and $null -ne $powerPoint) {
    $canQuit = $false
    try {
      $remainingPresentations = [int]$powerPoint.Presentations.Count
      if ($remainingPresentations -eq 0) {
        $canQuit = $true
      }
      else {
        $sessionChanged = $true
        $cleanupErrors.Add("PowerPoint gained $remainingPresentations presentation(s) during the check. Quit was skipped to preserve them.")
      }
    }
    catch {
      $cleanupErrors.Add("Could not verify Presentations.Count; Quit was skipped: $($_.Exception.Message)")
    }

    if ($canQuit) {
      try { $powerPoint.Quit() }
      catch { $cleanupErrors.Add("PowerPoint Quit failed: $($_.Exception.Message)") }
    }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint) }
    catch { $cleanupErrors.Add("PowerPoint COM release failed: $($_.Exception.Message)") }
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

if ($cleanupErrors.Count -gt 0) {
  [ordered]@{
    available = $false
    reason = $(if ($sessionChanged) { 'powerpoint-session-changed' } else { 'powerpoint-cleanup-failed' })
    error = ($cleanupErrors -join ' | ')
  } | ConvertTo-Json -Compress
  exit 2
}
if ($null -ne $operationError) {
  [ordered]@{ available = $false; error = $operationError } | ConvertTo-Json -Compress
  exit 2
}

[ordered]@{ available = $true; version = $version } | ConvertTo-Json -Compress
