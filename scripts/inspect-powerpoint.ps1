param(
  [Parameter(Mandatory = $true)][string]$PptxPath,
  [Parameter(Mandatory = $true)][int]$ExpectedSlides,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [Parameter(Mandatory = $true)][string]$AllowedRoot
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
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
    throw "PowerPoint is already running (PID: $processIds). Inspection was cancelled to avoid interfering with the existing session."
  }
}

if ($ExpectedSlides -lt 1) { throw 'ExpectedSlides must be greater than zero.' }

$resolvedAllowed = Get-NormalizedFullPath $AllowedRoot
if (-not (Test-Path -LiteralPath $resolvedAllowed -PathType Container)) {
  throw "AllowedRoot does not exist or is not a directory: $resolvedAllowed"
}
Assert-NoReparseDirectoryChain $resolvedAllowed

$resolvedPptx = (Resolve-Path -LiteralPath $PptxPath).Path
$resolvedReport = Get-NormalizedFullPath $ReportPath
[void](Assert-SafeFilePath $resolvedReport $resolvedAllowed 'ReportPath')
$reportDirectory = [System.IO.Path]::GetDirectoryName($resolvedReport)

Assert-NoPowerPointRunning
[void][System.IO.Directory]::CreateDirectory($reportDirectory)
[void](Assert-SafeDirectoryPath $reportDirectory $resolvedAllowed 'ReportPath parent directory')
[void](Assert-SafeFilePath $resolvedReport $resolvedAllowed 'ReportPath')

$powerPoint = $null
$presentation = $null
$ownsPowerPoint = $false
$issues = [System.Collections.Generic.List[object]]::new()
$checkedTextFrames = 0
try {
  Assert-NoPowerPointRunning
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $ownsPowerPoint = $true
  $powerPoint.Visible = [Microsoft.Office.Core.MsoTriState]::msoTrue
  $presentation = $powerPoint.Presentations.Open($resolvedPptx, $true, $false, $false)
  if ($presentation.Slides.Count -ne $ExpectedSlides) {
    throw "Expected $ExpectedSlides slides, found $($presentation.Slides.Count)."
  }
  $slideWidth = [double]$presentation.PageSetup.SlideWidth
  $slideHeight = [double]$presentation.PageSetup.SlideHeight
  foreach ($slide in $presentation.Slides) {
    foreach ($shape in $slide.Shapes) {
      $left = [double]$shape.Left
      $top = [double]$shape.Top
      $right = $left + [double]$shape.Width
      $bottom = $top + [double]$shape.Height
      if ($left -lt -0.5 -or $top -lt -0.5 -or $right -gt $slideWidth + 0.5 -or $bottom -gt $slideHeight + 0.5) {
        $issues.Add([ordered]@{
          type = 'shape-outside-slide'; slide = [int]$slide.SlideIndex; shape = [string]$shape.Name
          left = [math]::Round($left, 2); top = [math]::Round($top, 2)
          right = [math]::Round($right, 2); bottom = [math]::Round($bottom, 2)
        })
      }
      $claimsText = $false
      try {
        $claimsText = ($shape.HasTextFrame -eq -1 -and $shape.TextFrame2.HasText -eq -1)
        if ($claimsText) {
          $checkedTextFrames += 1
          $range = $shape.TextFrame2.TextRange
          $availableHeight = [double]$shape.Height - [double]$shape.TextFrame2.MarginTop - [double]$shape.TextFrame2.MarginBottom
          $availableWidth = [double]$shape.Width - [double]$shape.TextFrame2.MarginLeft - [double]$shape.TextFrame2.MarginRight
          $boundHeight = [double]$range.BoundHeight
          $boundWidth = [double]$range.BoundWidth
          $fontSize = [double]$range.Font.Size
          if ($boundHeight -gt $availableHeight + 2.0) {
            $text = ([string]$range.Text).Trim()
            $issues.Add([ordered]@{
              type = 'text-overflow'; slide = [int]$slide.SlideIndex; shape = [string]$shape.Name
              boundHeight = [math]::Round($boundHeight, 2); availableHeight = [math]::Round($availableHeight, 2)
              text = $text.Substring(0, [math]::Min(120, $text.Length))
            })
          }
          if ($boundWidth -gt $availableWidth + 2.0) {
            $text = ([string]$range.Text).Trim()
            $issues.Add([ordered]@{
              type = 'text-overflow-width'; slide = [int]$slide.SlideIndex; shape = [string]$shape.Name
              boundWidth = [math]::Round($boundWidth, 2); availableWidth = [math]::Round($availableWidth, 2)
              text = $text.Substring(0, [math]::Min(120, $text.Length))
            })
          }
          if ($fontSize -gt 0 -and $fontSize -lt 8.0) {
            $issues.Add([ordered]@{
              type = 'text-too-small'; slide = [int]$slide.SlideIndex; shape = [string]$shape.Name
              fontSize = [math]::Round($fontSize, 2)
            })
          }
        }
      }
      catch {
        $issues.Add([ordered]@{
          type = 'text-inspection-error'; slide = [int]$slide.SlideIndex; shape = [string]$shape.Name
          error = $_.Exception.Message
        })
      }
    }
  }
}
finally {
  $cleanupErrors = [System.Collections.Generic.List[string]]::new()
  if ($null -ne $presentation) {
    try { $presentation.Close() }
    catch { $cleanupErrors.Add("CodeReel presentation close failed: $($_.Exception.Message)") }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
    catch { $cleanupErrors.Add("CodeReel presentation COM release failed: $($_.Exception.Message)") }
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
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  if ($cleanupErrors.Count -gt 0) {
    throw "PowerPoint cleanup failed: $($cleanupErrors -join ' | ')"
  }
}

if ($checkedTextFrames -eq 0) {
  $issues.Add([ordered]@{ type = 'no-text-frames-checked'; error = 'PowerPoint inspection did not successfully inspect any text frame.' })
}

$report = [ordered]@{
  schemaVersion = 1
  pptx = $resolvedPptx
  slides = $ExpectedSlides
  checkedTextFrames = $checkedTextFrames
  issueCount = $issues.Count
  issues = @($issues)
  passed = ($issues.Count -eq 0)
  generatedAt = [DateTime]::UtcNow.ToString('o')
}

$reportPartial = Join-Path $reportDirectory ('.' + [System.IO.Path]::GetFileName($resolvedReport) + '.' + [Guid]::NewGuid().ToString('N') + '.partial')
$reportBackup = Join-Path $reportDirectory ('.' + [System.IO.Path]::GetFileName($resolvedReport) + '.' + [Guid]::NewGuid().ToString('N') + '.backup')
try {
  [void](Assert-SafeFilePath $reportPartial $resolvedAllowed 'inspection report temporary file')
  $reportJson = $report | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($reportPartial, $reportJson + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  [void](Assert-SafeFilePath $resolvedReport $resolvedAllowed 'ReportPath')
  if (Test-Path -LiteralPath $resolvedReport) {
    [System.IO.File]::Replace($reportPartial, $resolvedReport, $reportBackup, $true)
  }
  else {
    [System.IO.File]::Move($reportPartial, $resolvedReport)
  }
}
finally {
  foreach ($temporary in @($reportPartial, $reportBackup)) {
    if (Test-Path -LiteralPath $temporary) {
      try {
        [void](Assert-SafeFilePath $temporary $resolvedAllowed 'inspection report temporary file')
        [System.IO.File]::Delete($temporary)
      }
      catch { Write-Warning "Could not clean up the inspection report temporary file: $($_.Exception.Message)" }
    }
  }
}

$report | ConvertTo-Json -Compress -Depth 8
if ($issues.Count -gt 0) { exit 2 }
