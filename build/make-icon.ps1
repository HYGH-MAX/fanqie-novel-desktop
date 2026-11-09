# Generates build/icon.ico (multi-size) and src/icon.png for the app.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot   # project root (script lives in build/)
$buildDir = Join-Path $root 'build'
$srcDir = Join-Path $root 'src'
New-Item -ItemType Directory -Force -Path $buildDir, $srcDir | Out-Null

function New-TomatoBitmap([int]$size) {
    $bmp = [System.Drawing.Bitmap]::new($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = $size / 512.0

    # body: gradient tomato
    $rect = [System.Drawing.RectangleF]::new([float](60 * $s), [float](100 * $s), [float](392 * $s), [float](372 * $s))
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddEllipse($rect)
    $brush = [System.Drawing.Drawing2D.PathGradientBrush]::new($path)
    $brush.CenterColor = [System.Drawing.Color]::FromArgb(255, 255, 122, 71)
    $brush.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(255, 226, 45, 27))
    $brush.CenterPoint = [System.Drawing.PointF]::new([float](210 * $s), [float](210 * $s))
    $g.FillPath($brush, $path)

    # highlight
    $hi = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(70, 255, 255, 255))
    $g.FillEllipse($hi, [float](130 * $s), [float](165 * $s), [float](110 * $s), [float](78 * $s))
    $hi.Dispose()

    # leaves: green star on top
    $leafBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 61, 168, 96))
    $cx = 256 * $s
    $cy = 118 * $s
    for ($i = 0; $i -lt 5; $i++) {
        $angle = (-90 + $i * 72) * [Math]::PI / 180
        $lx = $cx + [Math]::Cos($angle) * 34 * $s
        $ly = $cy + [Math]::Sin($angle) * 34 * $s
        $w = 96 * $s
        $h = 54 * $s
        $g.TranslateTransform([float]$lx, [float]$ly)
        $g.RotateTransform([float]($angle * 180 / [Math]::PI + 90))
        $g.FillEllipse($leafBrush, [float](-$w / 2), [float](-$h / 2), [float]$w, [float]$h)
        $g.ResetTransform()
    }
    # stem
    $stem = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 88, 150, 62))
    $g.FillRectangle($stem, [float](250 * $s), [float](60 * $s), [float](12 * $s), [float](48 * $s))
    $stem.Dispose()
    $leafBrush.Dispose()

    # soft bottom shading
    $shade = [System.Drawing.Drawing2D.PathGradientBrush]::new($path)
    $shade.CenterColor = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)
    $shade.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(38, 120, 12, 6))
    $shade.CenterPoint = [System.Drawing.PointF]::new([float](256 * $s), [float](220 * $s))
    $g.FillPath($shade, $path)

    $g.Dispose()
    return $bmp
}

# src/icon.png : 512 px window icon
$big = New-TomatoBitmap 512
$big.Save((Join-Path $srcDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()

# build/icon.ico : multi-size, PNG-compressed entries
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @()
foreach ($sz in $sizes) {
    $bmp = New-TomatoBitmap $sz
    $ms = [System.IO.MemoryStream]::new()
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += , @{ size = $sz; bytes = $ms.ToArray() }
    $ms.Dispose()
    $bmp.Dispose()
}

$out = [System.IO.MemoryStream]::new()
$bw = [System.IO.BinaryWriter]::new($out)
$bw.Write([UInt16]0)                # reserved
$bw.Write([UInt16]1)                # type: icon
$bw.Write([UInt16]$pngs.Count)      # count

$offset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
    $dim = if ($p.size -ge 256) { 0 } else { $p.size }
    $bw.Write([Byte]$dim)
    $bw.Write([Byte]$dim)
    $bw.Write([Byte]0)
    $bw.Write([Byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$p.bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $p.bytes.Length
}
foreach ($p in $pngs) { $bw.Write($p.bytes) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $buildDir 'icon.ico'), $out.ToArray())
$bw.Dispose()
$out.Dispose()

"icon.png  : " + (Get-Item (Join-Path $srcDir 'icon.png')).Length + ' bytes'
"icon.ico  : " + (Get-Item (Join-Path $buildDir 'icon.ico')).Length + ' bytes'
