# icon-from-image.ps1
# Takes a source image, detects background / crops square, applies rounded-corner
# transparency with anti-aliased mask and padding, outputs 1024x1024 PNG and a
# multi-size PNG-in-ICO file.

param(
    [Parameter(Mandatory = $true)][string]$SourceImage,
    [string]$PngOutput = "build/icon-1024.png",
    [string]$IcoOutput = "build/icon.ico",
    [int]$Size = 1024,
    [int]$CornerRadiusPercent = 18,   # corner radius as % of final size
    [int]$PaddingPercent = 8,         # padding around artwork, % of final size
    [switch]$AutoCrop                 # trim uniform background border before squaring
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $SourceImage)) { throw "Source image not found: $SourceImage" }

$src = [System.Drawing.Image]::FromFile((Resolve-Path $SourceImage).Path)
try {
    # ---------------------------------------------------------------
    # 1. Optional background trim: detect near-uniform background from
    #    the corner pixels and crop the largest differing region.
    # ---------------------------------------------------------------
    $cropX = 0; $cropY = 0; $cropW = $src.Width; $cropH = $src.Height
    if ($AutoCrop) {
        $bmp = New-Object System.Drawing.Bitmap($src)
        try {
            $corners = @(
                $bmp.GetPixel(0, 0),
                $bmp.GetPixel($bmp.Width - 1, 0),
                $bmp.GetPixel(0, $bmp.Height - 1),
                $bmp.GetPixel($bmp.Width - 1, $bmp.Height - 1)
            )
            # Background is dark neutral/bluish; the artwork is a navy square
            # whose bottom fades dark, plus a soft drop shadow. Detect pixels
            # that are clearly blue-dominant (navy/glow) rather than the
            # neutral background or shadow, then take the largest run of
            # rows/columns with enough hits (isolated pixels ignored).
            $corner = $bmp.GetPixel(0, 0)
            $isBg = { param($p) (($p.B - $p.R) -lt 24) -or ($p.B -lt ($corner.B - 7)) }

            $rowHits = New-Object int[] $bmp.Height
            for ($y = 0; $y -lt $bmp.Height; $y++) {
                $n = 0
                for ($x = 0; $x -lt $bmp.Width; $x += 2) { if (-not (& $isBg $bmp.GetPixel($x, $y))) { $n++ } }
                $rowHits[$y] = $n
            }
            $rowThr = [int]($bmp.Width * 0.02)
            function Find-LongestRun([int[]]$counts, [int]$thr) {
                $bs = 0; $be = -1; $s = -1
                for ($i = 0; $i -lt $counts.Length; $i++) {
                    if ($counts[$i] -ge $thr) { if ($s -lt 0) { $s = $i } }
                    else { if ($s -ge 0) { if (($i - 1 - $s) -gt ($be - $bs)) { $bs = $s; $be = $i - 1 }; $s = -1 } }
                }
                if ($s -ge 0 -and ($counts.Length - 1 - $s) -gt ($be - $bs)) { $bs = $s; $be = $counts.Length - 1 }
                return @($bs, $be)
            }
            $r = Find-LongestRun $rowHits $rowThr
            $top = $r[0]; $bottom = $r[1]
            $colHits = New-Object int[] $bmp.Width
            for ($x = 0; $x -lt $bmp.Width; $x++) {
                $n = 0
                for ($y = $top; $y -le $bottom; $y += 2) { if (-not (& $isBg $bmp.GetPixel($x, $y))) { $n++ } }
                $colHits[$x] = $n
            }
            $colThr = [int]((($bottom - $top) / 2) * 0.02)
            $r = Find-LongestRun $colHits $colThr
            $left = $r[0]; $right = $r[1]
            Write-Host "Detected crop box: x $left..$right, y $top..$bottom"
            if ($right -gt $left -and $bottom -gt $top) {
                $cropX = $left; $cropY = $top
                $cropW = $right - $left + 1; $cropH = $bottom - $top + 1
            }
        } finally { $bmp.Dispose() }
    }

    # ---------------------------------------------------------------
    # 2. Square crop centered on the (possibly trimmed) region.
    # ---------------------------------------------------------------
    $side = [Math]::Min($cropW, $cropH)
    $sqX = $cropX + [int](($cropW - $side) / 2)
    $sqY = $cropY + [int](($cropH - $side) / 2)

    $srcRect = New-Object System.Drawing.Rectangle($sqX, $sqY, $side, $side)

    # ---------------------------------------------------------------
    # 3. Draw into a padded square canvas with HighQualityBicubic.
    # ---------------------------------------------------------------
    $pad = [int]($Size * $PaddingPercent / 100)
    $inner = $Size - 2 * $pad
    $work = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $g = [System.Drawing.Graphics]::FromImage($work)
        try {
            $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $dstRect = New-Object System.Drawing.Rectangle($pad, $pad, $inner, $inner)
            $g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
        } finally { $g.Dispose() }

        # -----------------------------------------------------------
        # 4. Rounded-corner transparency via anti-aliased GraphicsPath mask.
        #    Draw the mask at 4x then downsample for soft edges.
        # -----------------------------------------------------------
        $radius = [int]($Size * $CornerRadiusPercent / 100)
        $mask = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $mg = [System.Drawing.Graphics]::FromImage($mask)
            try {
                $mg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
                $mg.Clear([System.Drawing.Color]::Transparent)
                $path = New-Object System.Drawing.Drawing2D.GraphicsPath
                $d = $radius * 2
                $path.AddArc(0, 0, $d, $d, 180, 90)
                $path.AddArc($Size - $d - 1, 0, $d, $d, 270, 90)
                $path.AddArc($Size - $d - 1, $Size - $d - 1, $d, $d, 0, 90)
                $path.AddArc(0, $Size - $d - 1, $d, $d, 90, 90)
                $path.CloseFigure()
                $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
                $mg.FillPath($brush, $path)
                $brush.Dispose(); $path.Dispose()
            } finally { $mg.Dispose() }

            # Apply mask to alpha channel.
            $mb = $mask
            $wd = $work.Width; $ht = $work.Height
            $wData = $work.LockBits((New-Object System.Drawing.Rectangle(0, 0, $wd, $ht)), [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $mData = $mb.LockBits((New-Object System.Drawing.Rectangle(0, 0, $wd, $ht)), [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            try {
                $wPtr = $wData.Scan0; $mPtr = $mData.Scan0
                $stride = $wData.Stride
                $bytes = New-Object byte[] ($stride * $ht)
                [System.Runtime.InteropServices.Marshal]::Copy($wPtr, $bytes, 0, $bytes.Length)
                $mBytes = New-Object byte[] ($stride * $ht)
                [System.Runtime.InteropServices.Marshal]::Copy($mPtr, $mBytes, 0, $mBytes.Length)
                for ($i = 3; $i -lt $bytes.Length; $i += 4) {
                    $bytes[$i] = [byte]($bytes[$i] * $mBytes[$i] / 255)
                }
                [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $wPtr, $bytes.Length)
            } finally {
                $work.UnlockBits($wData); $mb.UnlockBits($mData)
            }
        } finally { $mask.Dispose() }

        # -----------------------------------------------------------
        # 5. Save 1024x1024 PNG.
        # -----------------------------------------------------------
        function Resolve-PathRel($p) {
            $full = $p
            if (-not [System.IO.Path]::IsPathRooted($p)) { $full = Join-Path (Get-Location) $p }
            return $full
        }
        $outDir = Split-Path -Parent (Resolve-PathRel $PngOutput)
        $pngFull = Resolve-PathRel $PngOutput
        $icoFull = Resolve-PathRel $IcoOutput
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pngFull) | Out-Null
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $icoFull) | Out-Null
        $work.Save($pngFull, [System.Drawing.Imaging.ImageFormat]::Png)

        # -----------------------------------------------------------
        # 6. Multi-size PNG-in-ICO (256,128,64,48,32,24,16) with correct
        #    ICONDIR + ICONDIRENTRY headers. PNG-compressed entries are
        #    valid for 256 and smaller per the Vista+ ICO format.
        # -----------------------------------------------------------
        $sizes = @(256, 128, 64, 48, 32, 24, 16)
        $pngs = @()
        foreach ($s in $sizes) {
            $ms = New-Object System.IO.MemoryStream
            $small = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $sg = [System.Drawing.Graphics]::FromImage($small)
            $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $sg.DrawImage($work, (New-Object System.Drawing.Rectangle(0, 0, $s, $s)))
            $sg.Dispose()
            $small.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $small.Dispose()
            $pngs += , $ms.ToArray()
            $ms.Dispose()
        }

        # ICONDIR: reserved(2)=0, type(2)=1, count(2)=n
        $fs = [System.IO.File]::Create($icoFull)
        $bw = New-Object System.IO.BinaryWriter($fs)
        try {
            $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
            $offset = 6 + 16 * $sizes.Count
            for ($i = 0; $i -lt $sizes.Count; $i++) {
                $s = $sizes[$i]
                $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))  # width (0 = 256)
                $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))  # height
                $bw.Write([byte]0)      # color palette
                $bw.Write([byte]0)      # reserved
                $bw.Write([uint16]1)    # color planes
                $bw.Write([uint16]32)   # bits per pixel
                $bw.Write([uint32]$pngs[$i].Length)   # data size
                $bw.Write([uint32]$offset)            # data offset
                $offset += $pngs[$i].Length
            }
            foreach ($p in $pngs) { $bw.Write($p) }
        } finally { $bw.Dispose(); $fs.Dispose() }

        Write-Host "Wrote $pngFull and $icoFull"
    } finally { $work.Dispose() }
} finally { $src.Dispose() }

