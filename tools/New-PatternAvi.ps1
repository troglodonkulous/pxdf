<#
.SYNOPSIS
    Generates uncompressed 24-bit AVI test patterns that Ledset can actually load.

.DESCRIPTION
    Ledset's media list only accepts video files. From LedSet.exe
    (MediaListProcessor.CheckIfVideoFile, decompiled/LedSet.decompiled.cs:3578)
    the accepted extensions are exactly:

        .MP4  .AVI  .FLV  .MOV  .WMV  .MPG

    Still images (.png/.bmp/.gif) are invisible to it -- there is no image code
    path at all. So every test pattern has to be a video file.

    Beyond that, the file has to be decodable by VideoGrabber.dll, which is a
    thin DirectShow wrapper with no bundled codecs. An H.264-in-AVI file is
    listed but produces neither a thumbnail nor playback. Uncompressed BI_RGB
    is the safe choice and is what the known-good 07-tilewalk.avi uses.

    This script emits that exact container: RIFF/AVI, single 'vids' stream,
    BI_RGB 24bpp top-down, 10 fps, with an idx1 index. The chunk layout
    (including the JUNK padding that puts 'movi' at offset 5666) mirrors
    07-tilewalk.avi byte-for-byte so the files are structurally identical to
    the one confirmed working on this rig.

.EXAMPLE
    .\tools\New-PatternAvi.ps1 -All

.EXAMPLE
    .\tools\New-PatternAvi.ps1 -Pattern red -OutFile .\test-patterns\03-red.avi
#>
[CmdletBinding(DefaultParameterSetName = 'All')]
param(
    [Parameter(ParameterSetName = 'One', Mandatory)]
    [ValidateSet('black', 'white', 'red', 'green', 'blue', 'halves', 'tilewalk', 'sweep')]
    [string]$Pattern,

    [Parameter(ParameterSetName = 'One', Mandatory)]
    [string]$OutFile,

    [Parameter(ParameterSetName = 'All')]
    [switch]$All,

    # Defaults to ..\test-patterns relative to this script.
    [Parameter(ParameterSetName = 'All')]
    [string]$OutDir,

    # 07-tilewalk.avi is the confirmed-working ground-truth file and the one the
    # timing sheet describes. It is not overwritten unless you ask.
    [Parameter(ParameterSetName = 'All')]
    [switch]$IncludeTilewalk,

    [int]$Width = 64,
    [int]$Height = 40,
    [int]$Fps = 10,
    [int]$TileSize = 8,

    # Seconds per pattern for the static patterns.
    [double]$Seconds = 6,

    # Seconds each tile is held in the tilewalk / sweep patterns.
    [double]$Hold = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- AVI writer

function Write-UncompressedAvi {
    <#
      Frames are byte[] of length Width*Height*3, top-down, BGR order --
      i.e. a bottom-up-flag-negated BI_RGB DIB, which is what a 24bpp AVI
      frame chunk contains. Stride is Width*3; for Width=64 that is 192,
      already 4-byte aligned, but the writer asserts it rather than assuming.
    #>
    param(
        [string]$Path,
        [System.Collections.Generic.List[byte[]]]$Frames,
        [int]$Width,
        [int]$Height,
        [int]$Fps
    )

    $stride = $Width * 3
    if ($stride % 4 -ne 0) {
        throw "Width $Width gives a $stride-byte stride, which is not 4-byte aligned. DIB rows must be padded; this writer does not pad."
    }
    $frameBytes = $stride * $Height
    foreach ($f in $Frames) {
        if ($f.Length -ne $frameBytes) {
            throw "Frame is $($f.Length) bytes, expected $frameBytes."
        }
    }

    $n = $Frames.Count
    $usecPerFrame = [int][Math]::Round(1000000.0 / $Fps)

    # Chunk layout, matching 07-tilewalk.avi exactly:
    #   @0     RIFF ....       'AVI '
    #   @12      LIST 4588     'hdrl'
    #   @24        avih 56
    #   @88        LIST 4244   'strl'
    #   @100         strh 56
    #   @164         strf 40
    #   @212         JUNK 4120
    #   @4340      JUNK 260
    #   @4608    LIST 26       'INFO'
    #   @4620      ISFT 13 (+1 pad)
    #   @4642    JUNK 1016
    #   @5666    LIST ....     'movi'
    #   @5678      00dc chunks
    #   @....    idx1 (16 bytes per frame)
    $ms = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter($ms)

    function fourcc([System.IO.BinaryWriter]$bw, [string]$s) {
        $bw.Write([System.Text.Encoding]::ASCII.GetBytes($s))
    }
    function junk([System.IO.BinaryWriter]$bw, [int]$payload) {
        fourcc $bw 'JUNK'
        $bw.Write([uint32]$payload)
        $bw.Write((New-Object byte[] $payload))
    }

    $moviPayload = $n * (8 + $frameBytes)   # each frame: '00dc' + size + data
    $moviListSize = 4 + $moviPayload        # includes the 'movi' fourcc
    $idx1Payload = $n * 16
    $riffSize = 4 + (8 + 4588) + (8 + 26) + (8 + 1016) + (8 + $moviListSize) + (8 + $idx1Payload)

    fourcc $w 'RIFF'; $w.Write([uint32]$riffSize); fourcc $w 'AVI '

    # --- hdrl
    fourcc $w 'LIST'; $w.Write([uint32]4588); fourcc $w 'hdrl'

    # AVIMAINHEADER
    fourcc $w 'avih'; $w.Write([uint32]56)
    $w.Write([uint32]$usecPerFrame)          # dwMicroSecPerFrame
    $w.Write([uint32]($frameBytes * $Fps))   # dwMaxBytesPerSec
    $w.Write([uint32]0)                      # dwPaddingGranularity
    $w.Write([uint32]0x910)                  # dwFlags: HASINDEX|ISINTERLEAVED|TRUSTCKTYPE
    $w.Write([uint32]$n)                     # dwTotalFrames
    $w.Write([uint32]0)                      # dwInitialFrames
    $w.Write([uint32]1)                      # dwStreams
    $w.Write([uint32]1048576)                # dwSuggestedBufferSize
    $w.Write([uint32]$Width)                 # dwWidth
    $w.Write([uint32]$Height)                # dwHeight
    $w.Write([uint32]0); $w.Write([uint32]0); $w.Write([uint32]0); $w.Write([uint32]0)  # dwReserved

    # --- strl
    fourcc $w 'LIST'; $w.Write([uint32]4244); fourcc $w 'strl'

    # AVISTREAMHEADER
    fourcc $w 'strh'; $w.Write([uint32]56)
    fourcc $w 'vids'                         # fccType
    $w.Write([uint32]0)                      # fccHandler = 0 for uncompressed
    $w.Write([uint32]0)                      # dwFlags
    $w.Write([uint16]0)                      # wPriority
    $w.Write([uint16]0)                      # wLanguage
    $w.Write([uint32]0)                      # dwInitialFrames
    $w.Write([uint32]1)                      # dwScale
    $w.Write([uint32]$Fps)                   # dwRate  -> rate/scale = fps
    $w.Write([uint32]0)                      # dwStart
    $w.Write([uint32]$n)                     # dwLength
    $w.Write([uint32]$frameBytes)            # dwSuggestedBufferSize
    $w.Write([uint32]::MaxValue)             # dwQuality = -1 (default)
    $w.Write([uint32]0)                      # dwSampleSize (0 = variable/video)
    $w.Write([uint16]0); $w.Write([uint16]0) # rcFrame left, top
    $w.Write([uint16]$Width); $w.Write([uint16]$Height)  # rcFrame right, bottom

    # BITMAPINFOHEADER
    fourcc $w 'strf'; $w.Write([uint32]40)
    $w.Write([uint32]40)                     # biSize
    $w.Write([int32]$Width)                  # biWidth
    $w.Write([int32](-$Height))              # biHeight < 0 => top-down rows
    $w.Write([uint16]1)                      # biPlanes
    $w.Write([uint16]24)                     # biBitCount
    $w.Write([uint32]0)                      # biCompression = BI_RGB
    $w.Write([uint32]$frameBytes)            # biSizeImage
    $w.Write([uint32]0); $w.Write([uint32]0) # biX/YPelsPerMeter
    $w.Write([uint32]0); $w.Write([uint32]0) # biClrUsed / biClrImportant

    junk $w 4120                             # ffmpeg leaves room for indx here
    junk $w 260                              # ...and for an odml/dmlh block here

    # --- INFO
    fourcc $w 'LIST'; $w.Write([uint32]26); fourcc $w 'INFO'
    fourcc $w 'ISFT'; $w.Write([uint32]13)
    $w.Write([System.Text.Encoding]::ASCII.GetBytes("ddf-patterns"))
    $w.Write([byte]0)
    $w.Write([byte]0)                        # pad to even

    junk $w 1016

    if ($ms.Position -ne 5666) {
        throw "Header layout drifted: 'movi' would start at $($ms.Position), expected 5666."
    }

    # --- movi
    fourcc $w 'LIST'; $w.Write([uint32]$moviListSize); fourcc $w 'movi'
    $index = New-Object System.Collections.Generic.List[uint32]
    $rel = 4                                 # offsets in idx1 are from the 'movi' fourcc
    foreach ($f in $Frames) {
        fourcc $w '00dc'
        $w.Write([uint32]$frameBytes)
        $w.Write($f)
        $index.Add([uint32]$rel)
        $rel += 8 + $frameBytes
    }

    # --- idx1
    fourcc $w 'idx1'; $w.Write([uint32]$idx1Payload)
    foreach ($off in $index) {
        fourcc $w '00dc'
        $w.Write([uint32]0x10)               # AVIIF_KEYFRAME
        $w.Write([uint32]$off)
        $w.Write([uint32]$frameBytes)
    }

    $w.Flush()
    [System.IO.File]::WriteAllBytes($Path, $ms.ToArray())
    $w.Dispose(); $ms.Dispose()
}

# ------------------------------------------------------------ frame painting

function New-Frame {
    param([int]$Width, [int]$Height)
    New-Object byte[] ($Width * $Height * 3)
}

function Set-Pixel {
    param([byte[]]$Buf, [int]$Width, [int]$X, [int]$Y, [int]$R, [int]$G, [int]$B)
    $i = ($Y * $Width + $X) * 3
    $Buf[$i] = [byte]$B      # DIB byte order is B, G, R
    $Buf[$i + 1] = [byte]$G
    $Buf[$i + 2] = [byte]$R
}

function New-SolidFrame {
    param([int]$Width, [int]$Height, [int]$R, [int]$G, [int]$B)
    $f = New-Frame -Width $Width -Height $Height
    for ($i = 0; $i -lt $f.Length; $i += 3) {
        $f[$i] = [byte]$B; $f[$i + 1] = [byte]$G; $f[$i + 2] = [byte]$R
    }
    return $f
}

function New-PatternFrames {
    param([string]$Pattern, [int]$Width, [int]$Height, [int]$Fps, [int]$TileSize, [double]$Seconds, [double]$Hold)

    $frames = New-Object System.Collections.Generic.List[byte[]]
    $staticCount = [int][Math]::Round($Seconds * $Fps)
    $holdCount = [int][Math]::Round($Hold * $Fps)

    function Repeat([byte[]]$f, [int]$count) {
        for ($i = 0; $i -lt $count; $i++) { $frames.Add($f) }
    }

    switch ($Pattern) {
        'black' { Repeat (New-SolidFrame $Width $Height 0 0 0) $staticCount }
        'white' { Repeat (New-SolidFrame $Width $Height 255 255 255) $staticCount }
        'red' { Repeat (New-SolidFrame $Width $Height 255 0 0) $staticCount }
        'green' { Repeat (New-SolidFrame $Width $Height 0 255 0) $staticCount }
        'blue' { Repeat (New-SolidFrame $Width $Height 0 0 255) $staticCount }

        'halves' {
            # Left half white, right half black -- matches 06-halves.png.
            $f = New-Frame -Width $Width -Height $Height
            for ($y = 0; $y -lt $Height; $y++) {
                for ($x = 0; $x -lt [int]($Width / 2); $x++) {
                    Set-Pixel $f $Width $x $y 255 255 255
                }
            }
            Repeat $f $staticCount
        }

        'tilewalk' {
            # Same sequence as tilewalk_timing.md: black lead-in, then one tile
            # at a time. Keep this list and that sheet in step.
            $seq = @(
                @(0, 0), @(1, 0), @(2, 0), @(3, 0),
                @(0, 1), @(0, 2), @(0, 3), @(0, 4),
                @(7, 0), @(7, 4), @(4, 2)
            )
            Repeat (New-SolidFrame $Width $Height 0 0 0) $holdCount
            foreach ($t in $seq) {
                $f = New-Frame -Width $Width -Height $Height
                $x0 = $t[0] * $TileSize
                $y0 = $t[1] * $TileSize
                for ($y = $y0; $y -lt $y0 + $TileSize; $y++) {
                    for ($x = $x0; $x -lt $x0 + $TileSize; $x++) {
                        Set-Pixel $f $Width $x $y 255 255 255
                    }
                }
                Repeat $f $holdCount
            }
        }

        'sweep' {
            # One-pixel white column stepping x = 0..W-1, then a one-pixel white
            # row stepping y = 0..H-1, one frame each. At 10 fps and 64x40 that
            # is 6.4 s of column sweep then 4.0 s of row sweep.
            Repeat (New-SolidFrame $Width $Height 0 0 0) $holdCount
            for ($x = 0; $x -lt $Width; $x++) {
                $f = New-Frame -Width $Width -Height $Height
                for ($y = 0; $y -lt $Height; $y++) { Set-Pixel $f $Width $x $y 255 255 255 }
                $frames.Add($f)
            }
            Repeat (New-SolidFrame $Width $Height 0 0 0) $holdCount
            for ($y = 0; $y -lt $Height; $y++) {
                $f = New-Frame -Width $Width -Height $Height
                for ($x = 0; $x -lt $Width; $x++) { Set-Pixel $f $Width $x $y 255 255 255 }
                $frames.Add($f)
            }
        }
    }

    return $frames
}

function Build-One {
    param([string]$Pattern, [string]$Path)
    $frames = New-PatternFrames -Pattern $Pattern -Width $Width -Height $Height -Fps $Fps `
        -TileSize $TileSize -Seconds $Seconds -Hold $Hold
    Write-UncompressedAvi -Path $Path -Frames $frames -Width $Width -Height $Height -Fps $Fps
    $len = (Get-Item $Path).Length
    "{0,-22} {1,4} frames  {2,6:N1}s  {3,10:N0} bytes" -f (Split-Path $Path -Leaf), $frames.Count, ($frames.Count / $Fps), $len
}

# ------------------------------------------------------------------- entry

if ($PSCmdlet.ParameterSetName -eq 'One') {
    $dir = Split-Path -Parent ([System.IO.Path]::GetFullPath($OutFile))
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    Build-One -Pattern $Pattern -Path ([System.IO.Path]::GetFullPath($OutFile))
    return
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\test-patterns'
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

"Writing $Width x $Height @ $Fps fps, uncompressed 24-bit, to $OutDir"
""

$set = [ordered]@{
    '01-black.avi'  = 'black'
    '02-white.avi'  = 'white'
    '03-red.avi'    = 'red'
    '04-green.avi'  = 'green'
    '05-blue.avi'   = 'blue'
    '06-halves.avi' = 'halves'
    '08-sweep.avi'  = 'sweep'
}
if ($IncludeTilewalk) { $set['07-tilewalk.avi'] = 'tilewalk' }

foreach ($name in $set.Keys) {
    Build-One -Pattern $set[$name] -Path (Join-Path $OutDir $name)
}

""
"Done. In Ledset: browse to this folder, then press Refresh to rebuild thumbnails."
