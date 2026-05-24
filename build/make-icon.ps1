#requires -Version 5.0
# Build a proper multi-resolution Windows ICO from the source PNG.
# Source is 2080x1540 (non-square) — letterbox onto a square canvas, then
# downsample to 16/32/48/64/128/256 and pack as PNG-in-ICO (Vista+ format).

param(
  [string]$Source = "$PSScriptRoot/../app/assets/iris-icon.png",
  [string]$Output = "$PSScriptRoot/icon.ico"
)

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
$size = [Math]::Max($src.Width, $src.Height)
Write-Host "Source: $($src.Width)x$($src.Height) -> square canvas: ${size}x${size}"

# Square canvas with transparent background, source centered.
$square = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($square)
$g.Clear([System.Drawing.Color]::Transparent)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$offsetX = [int](($size - $src.Width) / 2)
$offsetY = [int](($size - $src.Height) / 2)
$g.DrawImage($src, $offsetX, $offsetY, $src.Width, $src.Height)
$g.Dispose()
$src.Dispose()

# Downsample to each target size and capture PNG bytes.
$sizes = @(256, 128, 64, 48, 32, 16)
$pngBlobs = New-Object 'System.Collections.Generic.List[byte[]]'

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g2.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g2.Clear([System.Drawing.Color]::Transparent)
  $g2.DrawImage($square, 0, 0, $s, $s)
  $g2.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBlobs.Add($ms.ToArray())
  $bmp.Dispose()
  Write-Host ("  {0,3}x{0,-3} -> {1,7} bytes" -f $s, $ms.Length)
}
$square.Dispose()

# Build ICO file.
#   ICONDIR        (6 bytes)
#   ICONDIRENTRY[] (16 bytes per image)
#   image data     (PNG blobs concatenated)
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out

# ICONDIR
$bw.Write([uint16]0)              # Reserved
$bw.Write([uint16]1)              # Type = 1 (icon)
$bw.Write([uint16]$sizes.Count)   # ImageCount

# ICONDIRENTRY array — offsets need to point past all directory entries
$dataOffset = 6 + ($sizes.Count * 16)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $blob = $pngBlobs[$i]
  # Width / Height: 0 means 256
  $w = if ($s -eq 256) { 0 } else { $s }
  $h = $w
  $bw.Write([byte]$w)
  $bw.Write([byte]$h)
  $bw.Write([byte]0)        # ColorCount (0 for >=8bpp)
  $bw.Write([byte]0)        # Reserved
  $bw.Write([uint16]1)      # Planes
  $bw.Write([uint16]32)     # BitCount
  $bw.Write([uint32]$blob.Length)
  $bw.Write([uint32]$dataOffset)
  $dataOffset += $blob.Length
}

# Image data
foreach ($blob in $pngBlobs) { $bw.Write($blob) }

$bw.Flush()
[System.IO.File]::WriteAllBytes($Output, $out.ToArray())
$bw.Dispose()

$outFull = (Resolve-Path $Output).Path
$outSize = (Get-Item $outFull).Length
Write-Host "Wrote $outFull ($outSize bytes)"
