# Usage Meter Desktop - Windows tray front-end (PowerShell 5.1, pure .NET, no compiled binaries).
# Contract: desktop/src/shared/tray.ts. Keep this file ASCII-only (PS 5.1 reads BOM-less files as ANSI).
param([switch]$SelfTest, [double]$TestScale = 0, [string]$StateFile = '')
Set-StrictMode -Version 2

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:HasNative = $false
try {
  Add-Type -Namespace UM -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
  $script:HasNative = $true
  [void][UM.Native]::SetProcessDPIAware()
} catch { }
[System.Windows.Forms.Application]::EnableVisualStyles()

# ---------------------------------------------------------------- constants / colours
$script:W = 340
$script:Scale = 1.0
$script:Dot = [string][char]0xB7
$script:Dash = [string][char]0x2014
$script:Ell = [string][char]0x2026
function Hex([string]$h) { [System.Drawing.ColorTranslator]::FromHtml($h) }
function Mix($a, $b, [double]$t) { # t of a over b
  [System.Drawing.Color]::FromArgb(255, [int]($a.R * $t + $b.R * (1 - $t)), [int]($a.G * $t + $b.G * (1 - $t)), [int]($a.B * $t + $b.B * (1 - $t)))
}
$script:cBg = Hex '#1f1e1d'; $script:cFg = Hex '#e8e6e3'
$script:cBlue = Hex '#5aa9ff'; $script:cWarn = Hex '#e0a84a'; $script:cBad = Hex '#f0786a'
$script:cMuted = Mix $script:cFg $script:cBg 0.60
$script:cLine = Mix $script:cFg $script:cBg 0.12
$script:cBorder = Mix $script:cFg $script:cBg 0.20
$script:fNorm = New-Object System.Drawing.Font('Segoe UI', 10)
$script:fSmall = New-Object System.Drawing.Font('Segoe UI', 8.5)
$script:fHead = New-Object System.Drawing.Font('Segoe UI Semibold', 10.5)
$script:fLink = New-Object System.Drawing.Font('Segoe UI', 8.5, [System.Drawing.FontStyle]::Underline)
$script:RefreshRect = New-Object System.Drawing.Rectangle(0, 0, 0, 0)

$TF = [System.Windows.Forms.TextFormatFlags]
$script:flL = $TF::NoPadding -bor $TF::SingleLine -bor $TF::VerticalCenter -bor $TF::EndEllipsis -bor $TF::Left
$script:flR = $TF::NoPadding -bor $TF::SingleLine -bor $TF::VerticalCenter -bor $TF::Right
$script:flWrap = $TF::NoPadding -bor $TF::WordBreak -bor $TF::Left

function Prop($o, [string]$n) {
  if ($null -eq $o) { return $null }
  $p = $o.PSObject.Properties[$n]
  if ($null -eq $p) { return $null }
  return $p.Value
}
function PxS([double]$v) { [int][Math]::Round($v * $script:Scale) }
function ToneColor($t) {
  switch ([string]$t) { 'warn' { $script:cWarn } 'bad' { $script:cBad } default { $script:cBlue } }
}
function FmtPct($v, [bool]$sub, [string]$prefix = '') {
  if ($null -eq $v) { return $script:Dash }
  $n = [double]$v
  if ($sub -and $n -gt 0 -and $n -lt 1) { return ($prefix + '<1%') }
  return ($prefix + ('{0}%' -f [int][Math]::Round($n)))
}
function ParseTime($v) {
  if ($null -eq $v -or "$v" -eq '') { return $null }
  try {
    if ($v -is [datetime]) { return ([datetimeoffset]$v) }
    return [datetimeoffset]::Parse([string]$v, [System.Globalization.CultureInfo]::InvariantCulture)
  } catch { return $null }
}
function FmtCountdown($iso) {
  $t = ParseTime $iso
  if ($null -eq $t) { return '' }
  $sec = [long][Math]::Floor(($t - [datetimeoffset]::UtcNow).TotalSeconds)
  if ($sec -le 0) { return 'now' }
  $d = [long][Math]::Floor($sec / 86400); $h = [long][Math]::Floor(($sec % 86400) / 3600)
  $m = [long][Math]::Floor(($sec % 3600) / 60); $s = $sec % 60
  if ($d -gt 0) { return ('{0}d {1}h {2}m {3:00}s' -f $d, $h, $m, $s) }
  if ($h -gt 0) { return ('{0}h {1}m {2:00}s' -f $h, $m, $s) }
  if ($m -gt 0) { return ('{0}m {1:00}s' -f $m, $s) }
  return ('{0}s' -f $s)
}
function FmtAgo($ms) {
  if ($null -eq $ms) { return '' }
  $sec = [long][Math]::Max(0, [Math]::Floor(([datetimeoffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$ms) / 1000))
  if ($sec -lt 60) { return "Updated ${sec}s ago" }
  if ($sec -lt 3600) { return ('Updated {0}m ago' -f [long][Math]::Floor($sec / 60)) }
  return ('Updated {0}h ago' -f [long][Math]::Floor($sec / 3600))
}

# ---------------------------------------------------------------- popup rendering (owner drawn)
function Txt($g, [string]$text, $font, $x, $y, $w, $h, $color, $flags) {
  if ($w -le 0) { return }
  $r = New-Object System.Drawing.Rectangle([int]$x, [int]$y, [int]$w, [int]$h)
  [System.Windows.Forms.TextRenderer]::DrawText($g, $text, $font, $r, $color, $script:cBg, $flags)
}
function TxtW($g, [string]$text, $font) {
  $sz = [System.Windows.Forms.TextRenderer]::MeasureText($g, $text, $font, (New-Object System.Drawing.Size(2000, 100)), ($TF::NoPadding -bor $TF::SingleLine))
  return $sz.Width
}
function Bar($g, $x, $y, $w, $pct, $color) {
  $h = PxS 3
  $tb = New-Object System.Drawing.SolidBrush($script:cLine)
  $g.FillRectangle($tb, $x, $y, $w, $h); $tb.Dispose()
  if ($null -ne $pct) {
    $fw = [int][Math]::Max((PxS 2), [Math]::Round($w * [Math]::Min(100, [Math]::Max(0, [double]$pct)) / 100))
    $fb = New-Object System.Drawing.SolidBrush($color)
    $g.FillRectangle($fb, $x, $y, $fw, $h); $fb.Dispose()
  }
}
function HLine($g, $y, $x0, $x1) {
  $p = New-Object System.Drawing.Pen($script:cLine, 1)
  $g.DrawLine($p, $x0, $y, $x1, $y); $p.Dispose()
}
function Clock($g, $x, $y, $color) { # small drawn clock, ~ 11 logical px, top-left x,y
  $d = PxS 10
  $p = New-Object System.Drawing.Pen($color, [single]([Math]::Max(1.0, $script:Scale * 1.2)))
  $g.SmoothingMode = 'AntiAlias'
  $g.DrawEllipse($p, [single]($x + 0.5), [single]($y + 0.5), [single]($d - 1), [single]($d - 1))
  $cx = $x + $d / 2.0; $cy = $y + $d / 2.0
  $g.DrawLine($p, [single]$cx, [single]$cy, [single]$cx, [single]($y + $d * 0.22))
  $g.DrawLine($p, [single]$cx, [single]$cy, [single]($x + $d * 0.74), [single]$cy)
  $g.SmoothingMode = 'Default'; $p.Dispose()
}

function New-RoundPath([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [single]($r * 2)
  $p.AddArc([single]$x, [single]$y, $d, $d, 180, 90)
  $p.AddArc([single]($x + $w - $d), [single]$y, $d, $d, 270, 90)
  $p.AddArc([single]($x + $w - $d), [single]($y + $h - $d), $d, $d, 0, 90)
  $p.AddArc([single]$x, [single]($y + $h - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# Draws the whole popup; returns total height in device px. Drawing on a 1x1 bitmap = pure measurement.
function Draw-Popup($g, [double]$scale, $st, [string]$statusText) {
  $script:Scale = $scale
  $pad = PxS 14; $W = PxS $script:W; $right = $W - $pad; $inner = $W - 2 * $pad
  $g.Clear($script:cBg)
  $y = PxS 12
  $plan = Prop $st 'plan'
  $head = 'Claude usage'
  $hw = TxtW $g $head $script:fHead
  Txt $g $head $script:fHead $pad $y ($hw + (PxS 4)) (PxS 22) $script:cFg $script:flL
  if ($plan) {
    $pl = ([string]$plan).Substring(0, 1).ToUpper() + ([string]$plan).Substring(1)
    Txt $g ($script:Dot + ' ' + $pl) $script:fSmall ($pad + $hw + (PxS 8)) $y (PxS 100) (PxS 22) $script:cMuted $script:flL
  }
  $ak = [string](Prop $st 'accountKind'); $apl = ''
  if ($plan) { $apl = ([string]$plan).Substring(0, 1).ToUpper() + ([string]$plan).Substring(1) }
  $sub = 'Claude Desktop'; $subc = $script:cMuted
  if ($apl) { $sub = 'Claude Desktop ' + $script:Dot + ' ' + $apl + ' account' }   # data comes only from Claude Desktop sessions
  Txt $g $sub $script:fSmall $pad ($y + (PxS 22)) $inner (PxS 16) $subc $script:flL
  $y += PxS 48

  if ($null -eq $st) {
    Txt $g $statusText $script:fNorm $pad $y $inner (PxS 22) $script:cMuted $script:flL
    $y += PxS 30
  } else {
    $lblW = PxS 108; $pctX = $pad + (PxS 114); $pctW = PxS 44; $rX = $pad + (PxS 162); $rW = $inner - (PxS 162)
    foreach ($l in @(Prop $st 'limits')) {
      if ($null -eq $l) { continue }
      $tc = ToneColor (Prop $l 'tone')
      $pv = Prop $l 'pct'
      Txt $g ((Prop $l 'label') + ':') $script:fNorm $pad $y $lblW (PxS 20) $script:cFg $script:flL
      $pcol = $tc; if ($null -eq $pv) { $pcol = $script:cMuted }
      Txt $g (FmtPct $pv $false) $script:fNorm $pctX $y $pctW (PxS 20) $pcol $script:flL
      $cd = FmtCountdown (Prop $l 'resetsAt')
      if ($cd) {
        $tw = TxtW $g $cd $script:fSmall
        Txt $g $cd $script:fSmall $rX $y $rW (PxS 20) $script:cMuted $script:flR
        Clock $g ($right - $tw - (PxS 15)) ($y + (PxS 5)) $script:cMuted
      }
      Bar $g $pad ($y + (PxS 24)) $inner $pv $tc
      $y += PxS 36
    }
    $note = Prop $st 'limitsNote'
    if ($note) {
      $sz = [System.Windows.Forms.TextRenderer]::MeasureText($g, [string]$note, $script:fSmall, (New-Object System.Drawing.Size($inner, 1000)), $script:flWrap)
      Txt $g ([string]$note) $script:fSmall $pad $y $inner $sz.Height $script:cMuted $script:flWrap
      $y += $sz.Height + (PxS 8)
    }

    # Models
    $y += PxS 2
    HLine $g $y $pad $right
    $y += PxS 8
    # Exact-usage mode (no plan limits from Claude Desktop): columns show token counts instead of limit %.
    $hdr = @(Prop $st 'modelHeader'); $exact = ($hdr.Count -eq 3 -and $null -ne $hdr[0])
    if ($exact) { $cTok = PxS 52; $cWk = PxS 62; $c5 = PxS 56 } else { $cTok = PxS 56; $cWk = PxS 44; $c5 = PxS 44 }
    $gap = PxS 6
    $tokX = $right - $cTok; $wkX = $tokX - $gap - $cWk; $f5X = $wkX - $gap - $c5
    $mlW = $f5X - $pad - (PxS 8)
    $h1 = '5h'; $h2 = 'Week'; $h3 = 'Tokens'
    if ($exact) { $h1 = [string]$hdr[0]; $h2 = [string]$hdr[1]; $h3 = [string]$hdr[2] }
    Txt $g 'Models' $script:fSmall $pad $y $mlW (PxS 16) $script:cMuted $script:flL
    Txt $g $h1 $script:fSmall $f5X $y $c5 (PxS 16) $script:cMuted $script:flR
    Txt $g $h2 $script:fSmall $wkX $y $cWk (PxS 16) $script:cMuted $script:flR
    Txt $g $h3 $script:fSmall $tokX $y $cTok (PxS 16) $script:cMuted $script:flR
    $y += PxS 22
    $est = ((Prop $st 'modelsEstimated') -eq $true)
    $apx = ''; if ($est) { $apx = [string][char]0x2248 }
    $models = @(Prop $st 'models')
    if ($models.Count -eq 0 -or $null -eq $models[0]) {
      Txt $g 'No model usage yet' $script:fSmall $pad $y $inner (PxS 18) $script:cMuted $script:flL
      $y += PxS 24
    } else {
      foreach ($m in $models) {
        Txt $g ((Prop $m 'label') + ':') $script:fNorm $pad $y $mlW (PxS 20) $script:cFg $script:flL
        $p5 = Prop $m 'pct5h'; $pw = Prop $m 'pctWeek'
        if ($exact) {
          Txt $g ([string](Prop $m 'text5h')) $script:fNorm $f5X $y $c5 (PxS 20) $script:cFg $script:flR
          Txt $g ([string](Prop $m 'textWeek')) $script:fNorm $wkX $y $cWk (PxS 20) $script:cFg $script:flR
          Txt $g ([string](Prop $m 'tokensText')) $script:fSmall $tokX $y $cTok (PxS 20) $script:cMuted $script:flR
          Bar $g $pad ($y + (PxS 24)) $inner (Prop $m 'barPct') $script:cBlue
        } else {
          $c5c = $script:cBlue; if ($null -eq $p5) { $c5c = $script:cMuted }
          $cwc = $script:cBlue; if ($null -eq $pw) { $cwc = $script:cMuted }
          Txt $g (FmtPct $p5 $true $apx) $script:fNorm $f5X $y $c5 (PxS 20) $c5c $script:flR
          Txt $g (FmtPct $pw $true $apx) $script:fNorm $wkX $y $cWk (PxS 20) $cwc $script:flR
          Txt $g ([string](Prop $m 'tokensText')) $script:fSmall $tokX $y $cTok (PxS 20) $script:cMuted $script:flR
          Bar $g $pad ($y + (PxS 24)) $inner $p5 $script:cBlue
        }
        $y += PxS 34
      }
    }
    $o = Prop $st 'other'
    if ($null -ne $o) {
      Txt $g 'Other:' $script:fNorm $pad $y $mlW (PxS 20) $script:cMuted $script:flL
      Txt $g (FmtPct (Prop $o 'pct5h') $true $apx) $script:fNorm $f5X $y $c5 (PxS 20) $script:cMuted $script:flR
      Txt $g (FmtPct (Prop $o 'pctWeek') $true $apx) $script:fNorm $wkX $y $cWk (PxS 20) $script:cMuted $script:flR
      $y += PxS 26
    }
    if ($est) {
      Txt $g ($apx + ' estimated from Claude Desktop usage') $script:fSmall $pad $y $inner (PxS 16) $script:cMuted $script:flL
      $y += PxS 20
    }
  }

  # footer
  $y += PxS 2
  HLine $g $y $pad $right
  $y += PxS 6
  $ago = ''; if ($null -ne $st) { $ago = FmtAgo (Prop $st 'updatedAt') }
  $lw = TxtW $g 'Refresh' $script:fLink
  Txt $g $ago $script:fSmall $pad $y ($inner - $lw - (PxS 8)) (PxS 18) $script:cMuted $script:flL
  Txt $g 'Refresh' $script:fLink ($right - $lw) $y $lw (PxS 18) $script:cBlue $script:flR
  $script:RefreshRect = New-Object System.Drawing.Rectangle(($right - $lw - (PxS 4)), $y, ($lw + (PxS 8)), (PxS 18))
  $y += PxS 18 + (PxS 14)

  $bc = [System.Drawing.Color]::FromArgb(46, $script:cFg.R, $script:cFg.G, $script:cFg.B)
  $bp = New-Object System.Drawing.Pen($bc, 1)
  $bpath = New-RoundPath 0.5 0.5 ($W - 1) ($y - 1) ((PxS 10) - 1)
  $g.SmoothingMode = 'AntiAlias'; $g.DrawPath($bp, $bpath); $g.SmoothingMode = 'Default'
  $bpath.Dispose(); $bp.Dispose()
  return $y
}
function Measure-Popup([double]$scale, $st, [string]$statusText) {
  $bmp = New-Object System.Drawing.Bitmap(4, 4)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try { return (Draw-Popup $g $scale $st $statusText) } finally { $g.Dispose(); $bmp.Dispose() }
}

# ---------------------------------------------------------------- tray icon drawing
# The Claude logo is read at runtime from the installed Claude Desktop app (never copied into the repo).
$script:ClaudeBase = $null
$script:ClaudeBaseTried = $false
function Find-ClaudeExe {
  try {
    $p = Get-AppxPackage -Name Claude -ErrorAction Stop | Select-Object -First 1
    if ($p) { $e = Join-Path $p.InstallLocation 'app\claude.exe'; if (Test-Path $e) { return $e } }
  } catch { }
  try {
    $pr = Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
    if ($pr) { return $pr.Path }
  } catch { }
  return $null
}
function Get-ClaudeBase {   # cached 32x32 ARGB bitmap of the Claude icon, or $null
  if ($script:ClaudeBaseTried) { return $script:ClaudeBase }
  $script:ClaudeBaseTried = $true
  try {
    $exe = Find-ClaudeExe
    if ($exe) {
      $ic = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
      if ($ic) {
        $b = $ic.ToBitmap()
        $script:ClaudeBase = New-Object System.Drawing.Bitmap($b)
        $b.Dispose(); $ic.Dispose()
      }
    }
  } catch { $script:ClaudeBase = $null }
  return $script:ClaudeBase
}
function Get-TraySize {
  $s = 16
  try { $s = [System.Windows.Forms.SystemInformation]::SmallIconSize.Width } catch { }
  if ($s -lt 16) { $s = 16 }
  return $s
}

function New-DrawnIconBitmap($pct, $tone, [bool]$err) {   # fallback when the Claude icon is unavailable
  $bmp = New-Object System.Drawing.Bitmap(32, 32, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  $path = New-RoundPath 0 0 31 31 7
  $bg = New-Object System.Drawing.SolidBrush($script:cBg); $g.FillPath($bg, $path)
  $grey = Hex '#8a8884'
  $ringRect = New-Object System.Drawing.RectangleF(3.5, 3.5, 25, 25)
  $trackPen = New-Object System.Drawing.Pen((Mix $script:cFg $script:cBg 0.22), 3.5)
  $g.DrawEllipse($trackPen, $ringRect)
  $label = ''
  if ($err) {
    $p = New-Object System.Drawing.Pen($grey, 3.5); $g.DrawEllipse($p, $ringRect); $p.Dispose(); $label = '!'
  } elseif ($null -eq $pct) {
    $p = New-Object System.Drawing.Pen($grey, 3.5); $g.DrawEllipse($p, $ringRect); $p.Dispose(); $label = '-'
  } else {
    $n = [int][Math]::Max(0, [Math]::Min(100, [Math]::Round([double]$pct)))
    $p = New-Object System.Drawing.Pen((ToneColor $tone), 3.5)
    $p.StartCap = 'Flat'; $p.EndCap = 'Flat'
    if ($n -ge 100) { $g.DrawEllipse($p, $ringRect) } elseif ($n -gt 0) { $g.DrawArc($p, $ringRect, -90, [single]($n * 3.6)) }
    $p.Dispose(); $label = [string]$n
  }
  $px = 16; if ($label.Length -eq 2) { $px = 13 } elseif ($label.Length -ge 3) { $px = 10.5 }
  $font = New-Object System.Drawing.Font('Segoe UI', [single]$px, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $wb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $g.DrawString($label, $font, $wb, (New-Object System.Drawing.RectangleF(0, 0.5, 32, 32)), $sf)
  $wb.Dispose(); $sf.Dispose(); $font.Dispose(); $trackPen.Dispose(); $bg.Dispose(); $path.Dispose(); $g.Dispose()
  return $bmp
}
function New-IconBitmap($pct, $tone, [bool]$err, [int]$size) {
  $base = Get-ClaudeBase
  if ($null -eq $base) { return (New-DrawnIconBitmap $pct $tone $err) }
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.SmoothingMode = 'AntiAlias'
  $g.DrawImage($base, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $d = [int][Math]::Round($size * 0.375)
  $x = $size - $d; $y = $size - $d
  if ($err) { $fill = $script:cBad }
  elseif ($null -eq $pct) { $fill = Hex '#8a8884' }
  else { $fill = ToneColor $tone }
  $ob = New-Object System.Drawing.SolidBrush($script:cBg)
  $g.FillEllipse($ob, [single]($x - 1), [single]($y - 1), [single]($d + 1), [single]($d + 1)); $ob.Dispose()   # dark 1px outline
  $fb = New-Object System.Drawing.SolidBrush($fill)
  $g.FillEllipse($fb, [single]$x, [single]$y, [single]($d - 1), [single]($d - 1)); $fb.Dispose()
  if ($err) {
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $font = New-Object System.Drawing.Font('Segoe UI', [single]([Math]::Max(5, $d * 0.95)), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
    $wb = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.DrawString('!', $font, $wb, (New-Object System.Drawing.RectangleF([single]$x, [single]($y + 0.5), [single]($d - 1), [single]($d - 1))), $sf)
    $wb.Dispose(); $sf.Dispose(); $font.Dispose()
  }
  $g.Dispose()
  return $bmp
}
function New-TrayIcon($pct, $tone, [bool]$err, [int]$size = 0) {
  if ($size -le 0) { $size = Get-TraySize }
  $bmp = New-IconBitmap $pct $tone $err $size
  $h = $bmp.GetHicon()
  $tmp = [System.Drawing.Icon]::FromHandle($h)
  $icon = [System.Drawing.Icon]$tmp.Clone()
  $tmp.Dispose()
  if ($script:HasNative) { [void][UM.Native]::DestroyIcon($h) }
  $bmp.Dispose()
  return $icon
}
# ---------------------------------------------------------------- self test
if ($SelfTest) {
  $now = [datetimeoffset]::UtcNow
  $fake = [pscustomobject]@{
    ok = $true; updatedAt = ($now.ToUnixTimeMilliseconds() - 3000); plan = 'pro'; limitsSource = 'account'
    limitsNote = 'Showing Claude Code CLI account ' + [string][char]0x2014 + ' sign in with your Claude Desktop account from the tray menu'
    accountKind = 'cli'
    limits = @(
      [pscustomobject]@{ label = 'Session (5h)'; pct = 42; resetsAt = $now.AddSeconds(3 * 3600 + 5 * 60).ToString('o'); tone = 'ok' },
      [pscustomobject]@{ label = 'Weekly'; pct = 11; resetsAt = $now.AddSeconds(6 * 86400 + 16 * 3600 + 25 * 60).ToString('o'); tone = 'ok' },
      [pscustomobject]@{ label = 'Weekly Opus'; pct = $null; resetsAt = $null; tone = 'ok' },
      [pscustomobject]@{ label = 'Weekly Sonnet'; pct = 83; resetsAt = $now.AddSeconds(86400).ToString('o'); tone = 'warn' })
    models = @(
      [pscustomobject]@{ label = 'Opus 5.5'; pct5h = 30; pctWeek = 6; tokens = 48000; tokensText = '48k' },
      [pscustomobject]@{ label = 'Sonnet 5.5'; pct5h = 0.4; pctWeek = 3; tokens = 1200000; tokensText = '1.2M' },
      [pscustomobject]@{ label = 'Claude Haiku 4.5 (very long name)'; pct5h = $null; pctWeek = $null; tokens = 900; tokensText = '900' })
    other = [pscustomobject]@{ pct5h = 12; pctWeek = 2 }
    tooltip = 'Claude'; iconPct = 42; iconTone = 'ok'
  }
  $dir = $PSScriptRoot
  $tmpG = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero); $dpi = $tmpG.DpiX; $tmpG.Dispose()
  $s = $dpi / 96.0
  if ($TestScale -gt 0) { $s = $TestScale }
  $suffix = ''; if ($TestScale -gt 0) { $suffix = '-' + $TestScale }
  $fake | Add-Member -NotePropertyName modelsEstimated -NotePropertyValue $true -Force
  # -StateFile <json>: render a saved /api/tray response instead of the sample state (to check the real popup)
  if ($StateFile) { $fake = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json; $suffix = '-state' }
  $h = Measure-Popup $s $fake ''
  $bmp = New-Object System.Drawing.Bitmap([int](PxS $script:W), $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  [void](Draw-Popup $g $s $fake ''); $g.Dispose()
  $bmp.Save((Join-Path $dir ('selftest' + $suffix + '.png')), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  # icon strip: rows = tray sizes 16/20/24/32 (drawn 4x), columns = 42 ok, 87 warn, 100 bad, no data, error
  $sizes = @(16, 20, 24, 32)
  $strip = New-Object System.Drawing.Bitmap(680, 544)
  $sg = [System.Drawing.Graphics]::FromImage($strip); $sg.Clear((Hex '#444444'))
  $sg.InterpolationMode = 'NearestNeighbor'; $sg.PixelOffsetMode = 'Half'
  $r = 0
  foreach ($sz in $sizes) {
    $i = 0
    foreach ($ic1 in @(@(42, 'ok', $false), @(87, 'warn', $false), @(100, 'bad', $false), @($null, 'ok', $false), @($null, 'ok', $true))) {
      $b = New-IconBitmap $ic1[0] $ic1[1] $ic1[2] $sz
      $sg.DrawImage($b, ($i * 136 + 4), ($r * 136 + 4), 128, 128); $b.Dispose(); $i++
    }
    $r++
  }
  $sg.Dispose(); $strip.Save((Join-Path $dir 'selftest-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png); $strip.Dispose()
  # second variant: tray-owned Claude Desktop account (Max)
  $fake.plan = 'max'; $fake.accountKind = 'tray'; $fake.limitsNote = $null
  $h2 = Measure-Popup $s $fake ''
  $bmp = New-Object System.Drawing.Bitmap([int](PxS $script:W), $h2)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  [void](Draw-Popup $g $s $fake ''); $g.Dispose()
  $bmp.Save((Join-Path $dir ('selftest-tray' + $suffix + '.png')), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Output "selftest ok (dpi $dpi, popup height $h)"
  return
}

# ---------------------------------------------------------------- single instance
$created = $false
$script:Mutex = New-Object System.Threading.Mutex($true, 'Local\UsageMeterTray', [ref]$created)
if (-not $created) { return }

# ---------------------------------------------------------------- server discovery / start / HTTP
$script:InstancePath = Join-Path $env:APPDATA 'UsageMeterDesktop\instance.json'
$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path   # desktop/
$script:ServerPath = Join-Path $script:RepoRoot 'dist\server.cjs'
$script:StartedAt = $null
$script:State = $null
$script:Status = 'starting'          # ok | starting | down
$script:StatusText = 'Starting' + $script:Ell
$script:LastKey = ''
$script:Tick = 0
$script:ForceRefresh = $true
$script:NodeErrShown = $false

function Http([string]$url, [string]$method = 'GET', [string]$body = $null, [int]$timeout = 2000) {
  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Method = $method; $req.Timeout = $timeout; $req.ReadWriteTimeout = $timeout; $req.Proxy = $null
    if ($body) {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
      $req.ContentType = 'application/json'; $req.ContentLength = $bytes.Length
      $rs = $req.GetRequestStream(); $rs.Write($bytes, 0, $bytes.Length); $rs.Close()
    }
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $txt = $sr.ReadToEnd(); $sr.Close(); $resp.Close()
    if ($txt) { return ($txt | ConvertFrom-Json) }
    return $true
  } catch { return $null }
}
function Read-Instance {
  try {
    if (-not (Test-Path $script:InstancePath)) { return $null }
    $i = Get-Content -Raw -Path $script:InstancePath | ConvertFrom-Json
    if ((Prop $i 'port') -and (Prop $i 'key')) { return $i }
  } catch { }
  return $null
}
function Test-Health($inst) {
  $h = Http ('http://127.0.0.1:{0}/health' -f $inst.port) 'GET' $null 1500
  return ($null -ne $h -and (Prop $h 'app') -eq 'usage-meter-desktop')
}
function Start-Server {
  $script:StartedAt = Get-Date
  $node = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) {
    $script:Status = 'down'; $script:StatusText = 'Node.js not found'
    if (-not $script:NodeErrShown) { $script:NodeErrShown = $true; $script:Ni.ShowBalloonTip(6000, 'Usage Meter', 'Node.js was not found. Install Node and run "npm run build" in the desktop folder.', [System.Windows.Forms.ToolTipIcon]::Error) }
    return
  }
  if (-not (Test-Path $script:ServerPath)) {
    $script:Status = 'down'; $script:StatusText = 'Not built: run npm run build'
    if (-not $script:NodeErrShown) { $script:NodeErrShown = $true; $script:Ni.ShowBalloonTip(6000, 'Usage Meter', 'desktop\dist\server.cjs is missing. Run "npm install && npm run build" in the desktop folder.', [System.Windows.Forms.ToolTipIcon]::Error) }
    return
  }
  try {
    Start-Process -FilePath $node.Source -ArgumentList @(('"{0}"' -f $script:ServerPath), '--headless', '--parent-pid', $PID) -WindowStyle Hidden | Out-Null
    $script:Status = 'starting'; $script:StatusText = 'Starting' + $script:Ell
  } catch {
    $script:Status = 'down'; $script:StatusText = 'Could not start server'
  }
}
function Refresh-State {
  $script:ForceRefresh = $false
  $inst = Read-Instance
  $st = $null
  if ($null -ne $inst) {
    $st = Http ('http://127.0.0.1:{0}/u/{1}/api/tray' -f $inst.port, $inst.key) 'GET' $null 2000
    if ($null -ne $st -and $null -eq (Prop $st 'limits')) { $st = $null }
  }
  if ($null -ne $st) {
    $script:State = $st; $script:Status = 'ok'; $script:StatusText = ''
    $script:NodeErrShown = $false
  } else {
    $script:State = $null
    $recent = ($null -ne $script:StartedAt) -and (((Get-Date) - $script:StartedAt).TotalSeconds -lt 20)
    if ($recent) {
      $script:Status = 'starting'; $script:StatusText = 'Starting' + $script:Ell
    } else {
      $healthy = ($null -ne $inst) -and (Test-Health $inst)
      if (-not $healthy) {
        if ($null -eq $script:StartedAt -or (((Get-Date) - $script:StartedAt).TotalSeconds -ge 30)) { Start-Server }
        if ($script:Status -ne 'starting' -and $script:StatusText -eq '') { $script:StatusText = 'Server not running' }
        if ($script:Status -eq 'ok') { $script:Status = 'down'; $script:StatusText = 'Server not running' }
      } else {
        $script:Status = 'down'; $script:StatusText = 'No data yet'
      }
    }
  }
  Update-Icon
  if ($script:Popup.Visible) { Resize-Popup; $script:Popup.Invalidate() }
}
function Post-Request([string]$type, [int]$timeout = 20000) {
  $inst = Read-Instance
  if ($null -eq $inst) { return $null }
  return (Http ('http://127.0.0.1:{0}/u/{1}/api/request' -f $inst.port, $inst.key) 'POST' ('{{"type":"{0}"}}' -f $type) $timeout)
}
function Send-Quit {
  $inst = Read-Instance
  if ($null -ne $inst) { [void](Http ('http://127.0.0.1:{0}/u/{1}/api/request' -f $inst.port, $inst.key) 'POST' '{"type":"quit"}' 1500) }
}

# ---------------------------------------------------------------- tray icon + tooltip
function Update-Icon {
  $err = ($script:Status -ne 'ok')
  $pct = $null; $tone = 'ok'; $tip = ''
  if (-not $err) {
    $pct = Prop $script:State 'iconPct'; $tone = [string](Prop $script:State 'iconTone'); $tip = [string](Prop $script:State 'tooltip')
  } elseif ($script:Status -eq 'starting') { $tip = 'Usage Meter: starting' + $script:Ell }
  else { $tip = 'Usage Meter: not running' }
  if (-not $tip) { $tip = 'Usage Meter' }
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 60) + $script:Ell }
  $script:Ni.Text = $tip
  $key = '{0}|{1}|{2}' -f $pct, $tone, $err
  if ($key -ne $script:LastKey) {
    $script:LastKey = $key
    $new = New-TrayIcon $pct $tone $err
    $old = $script:Ni.Icon
    $script:Ni.Icon = $new
    if ($null -ne $old -and $old -ne $script:BootIcon) { $old.Dispose() }
  }
}

# ---------------------------------------------------------------- popup form
$script:Popup = New-Object System.Windows.Forms.Form
$script:Popup.FormBorderStyle = 'None'; $script:Popup.ShowInTaskbar = $false; $script:Popup.TopMost = $true
$script:Popup.StartPosition = 'Manual'; $script:Popup.BackColor = $script:cBg
$script:Popup.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic').SetValue($script:Popup, $true, $null)
$script:LastHide = [datetime]::MinValue
$script:RegionKey = ''

function Resize-Popup {
  $g = $script:Popup.CreateGraphics(); $s = $g.DpiX / 96.0; $g.Dispose()
  $h = Measure-Popup $s $script:State $script:StatusText
  $w = [int][Math]::Round($script:W * $s)
  if ($script:Popup.ClientSize.Width -ne $w -or $script:Popup.ClientSize.Height -ne $h) {
    $script:Popup.ClientSize = New-Object System.Drawing.Size($w, $h)
  }
  if ($script:RegionKey -ne "$w x $h") {
    $script:RegionKey = "$w x $h"
    $rp = New-RoundPath 0 0 $w $h ([Math]::Round(10 * $s))
    $oldRegion = $script:Popup.Region
    $script:Popup.Region = New-Object System.Drawing.Region($rp)
    $rp.Dispose(); if ($null -ne $oldRegion) { $oldRegion.Dispose() }
  }
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $m = [int][Math]::Round(8 * $s)
  $script:Popup.Location = New-Object System.Drawing.Point(($wa.Right - $script:Popup.Width - $m), ($wa.Bottom - $script:Popup.Height - $m))
}
$script:Popup.Add_Paint({
  param($sender, $e)
  try {
    $e.Graphics.TextRenderingHint = 'ClearTypeGridFit'
    [void](Draw-Popup $e.Graphics ($e.Graphics.DpiX / 96.0) $script:State $script:StatusText)
  } catch { }
})
$script:Popup.Add_Deactivate({ if ($script:Popup.Visible) { $script:Popup.Hide(); $script:LastHide = Get-Date } })
$script:Popup.Add_MouseMove({
  param($sender, $e)
  if ($script:RefreshRect.Contains($e.Location)) { $script:Popup.Cursor = [System.Windows.Forms.Cursors]::Hand } else { $script:Popup.Cursor = [System.Windows.Forms.Cursors]::Default }
})
$script:Popup.Add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq 'Left' -and $script:RefreshRect.Contains($e.Location)) { Refresh-State }
})
$script:Popup.Add_KeyDown({ param($s2, $e) if ($e.KeyCode -eq 'Escape') { $script:Popup.Hide(); $script:LastHide = Get-Date } })

function Show-Popup {
  if ($script:Popup.Visible) { $script:Popup.Hide(); $script:LastHide = Get-Date; return }
  if (((Get-Date) - $script:LastHide).TotalMilliseconds -lt 300) { return }   # click that just dismissed it
  Refresh-State
  Resize-Popup
  $script:Popup.Show(); $script:Popup.Activate()
  if ($script:HasNative) { [void][UM.Native]::SetForegroundWindow($script:Popup.Handle) }
  $script:Popup.Invalidate()
}

# ---------------------------------------------------------------- start-with-Windows shortcut
function Get-StartupLink { Join-Path ([Environment]::GetFolderPath('Startup')) 'Usage Meter.lnk' }
function Set-Autostart([bool]$on) {
  $lnk = Get-StartupLink
  if ($on) {
    $sh = New-Object -ComObject WScript.Shell
    $sc = $sh.CreateShortcut($lnk)
    $sc.TargetPath = 'powershell.exe'
    $sc.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $PSScriptRoot 'UsageMeterTray.ps1')
    $sc.WorkingDirectory = $PSScriptRoot
    $sc.WindowStyle = 7
    $sc.Description = 'Usage Meter tray'
    $sc.Save()
  } elseif (Test-Path $lnk) { Remove-Item $lnk -Force }
}

# ---------------------------------------------------------------- NotifyIcon + menu
$script:Ni = New-Object System.Windows.Forms.NotifyIcon
$script:BootIcon = New-TrayIcon $null 'ok' $true
$script:Ni.Icon = $script:BootIcon
$script:Ni.Text = 'Usage Meter: starting' + $script:Ell

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miShow = New-Object System.Windows.Forms.ToolStripMenuItem('Show usage')
$miRefresh = New-Object System.Windows.Forms.ToolStripMenuItem('Refresh')
$miAuto = New-Object System.Windows.Forms.ToolStripMenuItem('Start with Windows')
$miQuit = New-Object System.Windows.Forms.ToolStripMenuItem('Quit')
[void]$menu.Items.Add($miShow); [void]$menu.Items.Add($miRefresh); [void]$menu.Items.Add($miAuto)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)); [void]$menu.Items.Add($miQuit)
$script:Ni.ContextMenuStrip = $menu
$menu.Add_Opening({
  $miAuto.Checked = (Test-Path (Get-StartupLink))
})
$miShow.Add_Click({ if (-not $script:Popup.Visible) { $script:LastHide = [datetime]::MinValue; Show-Popup } })
$miRefresh.Add_Click({ Refresh-State })
$miAuto.Add_Click({
  try { Set-Autostart (-not (Test-Path (Get-StartupLink))) }
  catch { $script:Ni.ShowBalloonTip(4000, 'Usage Meter', 'Could not change the startup shortcut.', [System.Windows.Forms.ToolTipIcon]::Warning) }
})
$ctx = New-Object System.Windows.Forms.ApplicationContext
$script:Timer = New-Object System.Windows.Forms.Timer
$miQuit.Add_Click({
  try { Send-Quit } catch { }
  $script:Timer.Stop(); $script:Popup.Hide()
  $script:Ni.Visible = $false; $script:Ni.Dispose()
  try { $script:Mutex.ReleaseMutex() } catch { }
  $ctx.ExitThread()
})
$script:Ni.Add_MouseClick({ param($s2, $e) if ($e.Button -eq 'Left') { Show-Popup } })

# ---------------------------------------------------------------- main loop
$script:Timer.Interval = 1000
$script:Timer.Add_Tick({
  try {
    $script:Tick++
    $due = $script:ForceRefresh -or ($script:Tick % 5 -eq 0) -or (($script:Status -ne 'ok') -and ($script:Tick % 2 -eq 0))
    if ($due) { Refresh-State }
    elseif ($script:Popup.Visible) { $script:Popup.Invalidate() }
  } catch { }
})
$script:Ni.Visible = $true
$script:Timer.Start()
try { Refresh-State } catch { }
[System.Windows.Forms.Application]::Run($ctx)
