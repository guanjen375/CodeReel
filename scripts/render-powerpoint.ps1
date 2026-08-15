param(
  [Parameter(Mandatory = $true)][string]$PptxPath,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [Parameter(Mandatory = $true)][int]$ExpectedSlides,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [Parameter(Mandatory = $true)][string]$AllowedRoot
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedFullPath {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  $full = [System.IO.Path]::GetFullPath($PathValue)
  $pathRoot = [System.IO.Path]::GetPathRoot($full)
  if ([string]::Equals($full, $pathRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $full
  }
  return $full.TrimEnd([char[]]@(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  ))
}

function Assert-NoReparseDirectoryChain {
  param([Parameter(Mandatory = $true)][string]$DirectoryPath)
  $current = Get-NormalizedFullPath $DirectoryPath
  while ($true) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (-not $item.PSIsContainer) {
        throw "Expected a directory, but found a different item: $current"
      }
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Safety check failed: directory path contains a reparse point: $current"
      }
    }
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if ([string]::IsNullOrWhiteSpace($parent) -or
        [string]::Equals($parent, $current, [System.StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $current = Get-NormalizedFullPath $parent
  }
}

function Assert-SafeDirectoryPath {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$AllowRoot
  )
  $candidateFull = Get-NormalizedFullPath $Candidate
  $rootFull = Get-NormalizedFullPath $Root
  $rootPrefix = $rootFull.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
  $isRoot = [string]::Equals($candidateFull, $rootFull, [System.StringComparison]::OrdinalIgnoreCase)
  if ((-not $AllowRoot -and $isRoot) -or
      (-not $isRoot -and -not $candidateFull.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "$Label must be strictly inside AllowedRoot: $candidateFull"
  }
  Assert-NoReparseDirectoryChain $candidateFull
  return $candidateFull
}

function Assert-SafeFilePath {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $full = Get-NormalizedFullPath $FilePath
  [void](Assert-SafeDirectoryPath ([System.IO.Path]::GetDirectoryName($full)) $Root "$Label parent directory" -AllowRoot)
  if (Test-Path -LiteralPath $full) {
    $item = Get-Item -LiteralPath $full -Force
    if ($item.PSIsContainer) { throw "$Label must be a file, but is a directory: $full" }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Safety check failed: $Label must not be a reparse point: $full"
    }
  }
  return $full
}

function Assert-NoPowerPointRunning {
  $existing = @(Get-Process -Name 'POWERPNT' -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 0) {
    $processIds = ($existing | ForEach-Object { $_.Id }) -join ', '
    throw "PowerPoint is already running (PID: $processIds). Rendering was cancelled to avoid interfering with the existing session."
  }
}

if ($ExpectedSlides -lt 1) { throw 'ExpectedSlides must be greater than zero.' }

$resolvedAllowed = Get-NormalizedFullPath $AllowedRoot
if (-not (Test-Path -LiteralPath $resolvedAllowed -PathType Container)) {
  throw "AllowedRoot does not exist or is not a directory: $resolvedAllowed"
}
Assert-NoReparseDirectoryChain $resolvedAllowed

$resolvedPptx = (Resolve-Path -LiteralPath $PptxPath).Path
$resolvedOutput = Assert-SafeDirectoryPath $OutputDir $resolvedAllowed 'OutputDir'
$resolvedReport = Get-NormalizedFullPath $ReportPath
[void](Assert-SafeFilePath $resolvedReport $resolvedAllowed 'ReportPath')
$reportDirectory = [System.IO.Path]::GetDirectoryName($resolvedReport)

[void][System.IO.Directory]::CreateDirectory($resolvedOutput)
[void][System.IO.Directory]::CreateDirectory($reportDirectory)
# Recheck after directory creation in case the path resolved through a reparse point.
[void](Assert-SafeDirectoryPath $resolvedOutput $resolvedAllowed 'OutputDir')
[void](Assert-SafeDirectoryPath $reportDirectory $resolvedAllowed 'ReportPath parent directory')
[void](Assert-SafeFilePath $resolvedReport $resolvedAllowed 'ReportPath')

Assert-NoPowerPointRunning

$tempRoot = Join-Path $resolvedAllowed ('.codereel-powerpoint-render-' + [Guid]::NewGuid().ToString('N'))
$tempExport = Join-Path $tempRoot 'export'
$tempBackup = Join-Path $tempRoot 'backup'
[void][System.IO.Directory]::CreateDirectory($tempExport)
[void][System.IO.Directory]::CreateDirectory($tempBackup)
[void](Assert-SafeDirectoryPath $tempRoot $resolvedAllowed 'render temporary directory')
[void](Assert-SafeDirectoryPath $tempExport $resolvedAllowed 'render export directory')
[void](Assert-SafeDirectoryPath $tempBackup $resolvedAllowed 'render backup directory')

$powerPoint = $null
$presentation = $null
$ownsPowerPoint = $false
$reportPartial = $null
$report = $null

try {
  try {
    # Create a COM instance only after confirming that POWERPNT is not already running.
    Assert-NoPowerPointRunning
    $powerPoint = New-Object -ComObject PowerPoint.Application
    $ownsPowerPoint = $true
    $powerPoint.Visible = [Microsoft.Office.Core.MsoTriState]::msoTrue
    $presentation = $powerPoint.Presentations.Open($resolvedPptx, $true, $false, $false)
    if ($presentation.Slides.Count -ne $ExpectedSlides) {
      throw "Expected $ExpectedSlides slides, found $($presentation.Slides.Count)."
    }
    [void](Assert-SafeDirectoryPath $tempExport $resolvedAllowed 'render export directory')
    $presentation.Export($tempExport, 'PNG', 1920, 1080)
  }
  finally {
    $cleanupErrors = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $presentation) {
      try { $presentation.Close() }
      catch { $cleanupErrors.Add("CodeReel presentation close failed: $($_.Exception.Message)") }
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
      catch { $cleanupErrors.Add("CodeReel presentation COM release failed: $($_.Exception.Message)") }
      $presentation = $null
    }
    if ($ownsPowerPoint -and $null -ne $powerPoint) {
      $canQuit = $false
      try {
        $remainingPresentations = [int]$powerPoint.Presentations.Count
        if ($remainingPresentations -eq 0) {
          $canQuit = $true
        }
        else {
          $cleanupErrors.Add("PowerPoint still has $remainingPresentations presentation(s) after closing the CodeReel deck. Quit was skipped to preserve them.")
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
      $powerPoint = $null
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    if ($cleanupErrors.Count -gt 0) {
      throw "PowerPoint cleanup failed: $($cleanupErrors -join ' | ')"
    }
  }

  $rawPngs = @(Get-ChildItem -LiteralPath $tempExport -File | Where-Object { $_.Extension -ieq '.png' })
  if ($rawPngs.Count -ne $ExpectedSlides) {
    throw "Expected $ExpectedSlides rendered slides in temporary export, found $($rawPngs.Count)."
  }

  foreach ($file in $rawPngs) {
    $match = [regex]::Match($file.Name, '^(?:slide-)?(\d+)\.png$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) {
      $match = [regex]::Match($file.Name, '(\d+)\.png$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
    if (-not $match.Success) { throw "Cannot identify the PowerPoint export filename: $($file.Name)" }
    $number = [int]$match.Groups[1].Value
    if ($number -lt 1 -or $number -gt $ExpectedSlides) {
      throw "PowerPoint exported a slide number outside the expected range: $($file.Name)"
    }
    $normalized = Join-Path $tempExport "slide-$number.png"
    if (-not [string]::Equals($file.FullName, $normalized, [System.StringComparison]::OrdinalIgnoreCase)) {
      if (Test-Path -LiteralPath $normalized) { throw "PowerPoint exported a duplicate slide number: $number" }
      [System.IO.File]::Move($file.FullName, $normalized)
    }
  }

  [void][System.Reflection.Assembly]::LoadWithPartialName('System.Drawing')
  for ($number = 1; $number -le $ExpectedSlides; $number += 1) {
    $rendered = Join-Path $tempExport "slide-$number.png"
    if (-not (Test-Path -LiteralPath $rendered -PathType Leaf)) {
      throw "Missing rendered slide: slide-$number.png"
    }
    $renderedItem = Get-Item -LiteralPath $rendered -Force
    if ($renderedItem.Length -le 0) { throw "Rendered slide is empty: $($renderedItem.Name)" }
    $image = $null
    try {
      $image = [System.Drawing.Image]::FromFile($rendered)
      if ($image.Width -ne 1920 -or $image.Height -ne 1080) {
        throw "Rendered slide has the wrong dimensions: $($renderedItem.Name) = $($image.Width)x$($image.Height)"
      }
    }
    finally {
      if ($null -ne $image) { $image.Dispose() }
    }
  }

  $installed = [System.Collections.Generic.List[object]]::new()
  $staleMoved = [System.Collections.Generic.List[object]]::new()
  $reportChange = $null
  try {
    [void](Assert-SafeDirectoryPath $tempBackup $resolvedAllowed 'render backup directory')
    for ($number = 1; $number -le $ExpectedSlides; $number += 1) {
      $source = Join-Path $tempExport "slide-$number.png"
      $target = Join-Path $resolvedOutput "slide-$number.png"
      [void](Assert-SafeFilePath $target $resolvedAllowed "committed slide $number")
      if (Test-Path -LiteralPath $target) {
        $backup = Join-Path $tempBackup "previous-slide-$number.png"
        [System.IO.File]::Replace($source, $target, $backup, $true)
        $installed.Add([pscustomobject]@{ Target = $target; Backup = $backup; Existed = $true })
      }
      else {
        [System.IO.File]::Move($source, $target)
        $installed.Add([pscustomobject]@{ Target = $target; Backup = $null; Existed = $false })
      }
    }

    $expectedNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    for ($number = 1; $number -le $ExpectedSlides; $number += 1) {
      [void]$expectedNames.Add("slide-$number.png")
    }
    $existingSlides = @(Get-ChildItem -LiteralPath $resolvedOutput -File | Where-Object { $_.Name -match '^slide-\d+\.png$' })
    foreach ($file in $existingSlides) {
      if ($expectedNames.Contains($file.Name)) { continue }
      [void](Assert-SafeFilePath $file.FullName $resolvedAllowed 'stale slide')
      $backup = Join-Path $tempBackup ('stale-' + [Guid]::NewGuid().ToString('N') + '.png')
      [System.IO.File]::Move($file.FullName, $backup)
      $staleMoved.Add([pscustomobject]@{ Target = $file.FullName; Backup = $backup })
    }

    $finalSlides = @(Get-ChildItem -LiteralPath $resolvedOutput -File | Where-Object { $expectedNames.Contains($_.Name) })
    if ($finalSlides.Count -ne $ExpectedSlides) {
      throw "Expected $ExpectedSlides committed slides, found $($finalSlides.Count)."
    }

    $report = [ordered]@{
      schemaVersion = 1
      renderer = 'Microsoft PowerPoint COM'
      pptx = $resolvedPptx
      outputDir = $resolvedOutput
      slides = $ExpectedSlides
      width = 1920
      height = 1080
      generatedAt = [DateTime]::UtcNow.ToString('o')
    }
    $reportJson = $report | ConvertTo-Json -Depth 5
    $reportPartial = Join-Path $reportDirectory ('.' + [System.IO.Path]::GetFileName($resolvedReport) + '.' + [Guid]::NewGuid().ToString('N') + '.partial')
    [void](Assert-SafeFilePath $reportPartial $resolvedAllowed 'render report temporary file')
    [System.IO.File]::WriteAllText($reportPartial, $reportJson + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    [void](Assert-SafeFilePath $resolvedReport $resolvedAllowed 'ReportPath')
    if (Test-Path -LiteralPath $resolvedReport) {
      $reportBackup = Join-Path $tempBackup 'previous-report.json'
      [System.IO.File]::Replace($reportPartial, $resolvedReport, $reportBackup, $true)
      $reportChange = [pscustomobject]@{ Target = $resolvedReport; Backup = $reportBackup; Existed = $true }
    }
    else {
      [System.IO.File]::Move($reportPartial, $resolvedReport)
      $reportChange = [pscustomobject]@{ Target = $resolvedReport; Backup = $null; Existed = $false }
    }
    $reportPartial = $null
  }
  catch {
    $originalError = $_
    $rollbackErrors = [System.Collections.Generic.List[string]]::new()

    if ($null -ne $reportChange) {
      try {
        if ($reportChange.Existed -and (Test-Path -LiteralPath $reportChange.Backup)) {
          if (Test-Path -LiteralPath $reportChange.Target) {
            [System.IO.File]::Replace($reportChange.Backup, $reportChange.Target, $null, $true)
          }
          else { [System.IO.File]::Move($reportChange.Backup, $reportChange.Target) }
        }
        elseif (-not $reportChange.Existed -and (Test-Path -LiteralPath $reportChange.Target)) {
          [System.IO.File]::Delete($reportChange.Target)
        }
      }
      catch { $rollbackErrors.Add($_.Exception.Message) }
    }

    for ($index = $staleMoved.Count - 1; $index -ge 0; $index -= 1) {
      $operation = $staleMoved[$index]
      try {
        if (Test-Path -LiteralPath $operation.Backup) {
          [System.IO.File]::Move($operation.Backup, $operation.Target)
        }
      }
      catch { $rollbackErrors.Add($_.Exception.Message) }
    }

    for ($index = $installed.Count - 1; $index -ge 0; $index -= 1) {
      $operation = $installed[$index]
      try {
        if ($operation.Existed -and (Test-Path -LiteralPath $operation.Backup)) {
          if (Test-Path -LiteralPath $operation.Target) {
            [System.IO.File]::Replace($operation.Backup, $operation.Target, $null, $true)
          }
          else { [System.IO.File]::Move($operation.Backup, $operation.Target) }
        }
        elseif (-not $operation.Existed -and (Test-Path -LiteralPath $operation.Target)) {
          [System.IO.File]::Delete($operation.Target)
        }
      }
      catch { $rollbackErrors.Add($_.Exception.Message) }
    }

    if ($rollbackErrors.Count -gt 0) {
      throw "Failed to commit rendered results: $($originalError.Exception.Message) Rollback also failed: $($rollbackErrors -join ' | ')"
    }
    throw $originalError
  }

  $report | ConvertTo-Json -Compress
}
finally {
  if ($null -ne $reportPartial -and (Test-Path -LiteralPath $reportPartial)) {
    try {
      [void](Assert-SafeFilePath $reportPartial $resolvedAllowed 'render report temporary file')
      [System.IO.File]::Delete($reportPartial)
    }
    catch { Write-Warning "Could not clean up the render report temporary file: $($_.Exception.Message)" }
  }
  if (Test-Path -LiteralPath $tempRoot) {
    try {
      [void](Assert-SafeDirectoryPath $tempRoot $resolvedAllowed 'render temporary directory')
      Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
    catch { Write-Warning "Could not clean up the render temporary directory: $($_.Exception.Message)" }
  }
}
