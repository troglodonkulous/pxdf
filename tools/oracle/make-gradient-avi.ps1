<#
.SYNOPSIS
    Renders `mapper.patterns.gradient24` as an uncompressed AVI Ledset can play --
    the media file the multi-controller / intra-tile oracle capture needs.

.DESCRIPTION
    A critic reviewing the mapper found the real gap: every existing capture is
    tile-uniform (solid colours, or one lit tile at a time), so nothing on the
    wire today constrains sub-tile pixel order or port assignment. Swap the
    intra-tile scan table for a wrong one, or wire tile columns to the wrong
    ports, and every current capture still passes. `gradient24` -- a 24-bit
    encoding where every pixel's own (x, y) is baked into its colour -- is the
    one pattern that can catch a permutation; a solid colour cannot.

    This script does NOT reimplement the gradient formula independently: the
    per-pixel arithmetic below is transcribed 1:1 from `mapper/patterns.py`'s
    `gradient24()` and cross-checked against it byte-for-byte by
    `tools/oracle/tests/test_make_gradient_avi.py` before this file is trusted
    for anything. If that formula ever changes in `mapper/`, this script's
    output silently stops matching what the harness expects -- the test catches
    that; nothing here re-derives the formula from first principles.

    The AVI *container* writer (`Write-UncompressedAvi` below) began as a
    byte-for-byte copy of the writer in `tools/New-PatternAvi.ps1`, which
    mirrored `07-tilewalk.avi` -- the file already confirmed to load and play
    correctly in Ledset on this rig. That script generated the retired 64 x 40
    set (`01`-`08`) and was deleted on 2026-08-13; this is now the only copy of
    the writer, so the hand-diff the duplication used to require is gone with
    it. `07-tilewalk.avi` remains the reference the layout was matched against.

.EXAMPLE
    .\tools\oracle\make-gradient-avi.ps1 -Cols 10 -Rows 5 -TileSize 8 -Seconds 6 `
        -OutFile .\tools\oracle\media\09-gradient24-8x8_4P-10x5.avi

    Then, at the attended session: copy or symlink that file into whatever
    folder Ledset's media list is pointed at (`Configure.ini`'s `ProgramPath`,
    currently `test-patterns\`), press Refresh in Ledset so it rebuilds
    thumbnails, and it will appear in the media list like any other pattern.
#>
param(
    [int]$Cols = 10,
    [int]$Rows = 5,
    [int]$TileSize = 8,
    [int]$Fps = 10,
    [double]$Seconds = 6,
    [Parameter(Mandatory=$true)][string]$OutFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Width = $Cols * $TileSize
$Height = $Rows * $TileSize

# ---------------------------------------------------------------- AVI writer
# RIFF/AVI, single 'vids' stream, BI_RGB 24bpp top-down, with an idx1 index,
# matching 07-tilewalk.avi's chunk layout. Originally copied from
# tools/New-PatternAvi.ps1, which was deleted on 2026-08-13 with the retired
# 64 x 40 pattern set; this is the surviving copy.

function Write-UncompressedAvi {
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

    $moviPayload = $n * (8 + $frameBytes)
    $moviListSize = 4 + $moviPayload
    $idx1Payload = $n * 16
    $riffSize = 4 + (8 + 4588) + (8 + 26) + (8 + 1016) + (8 + $moviListSize) + (8 + $idx1Payload)

    fourcc $w 'RIFF'; $w.Write([uint32]$riffSize); fourcc $w 'AVI '

    fourcc $w 'LIST'; $w.Write([uint32]4588); fourcc $w 'hdrl'

    fourcc $w 'avih'; $w.Write([uint32]56)
    $w.Write([uint32]$usecPerFrame)
    $w.Write([uint32]($frameBytes * $Fps))
    $w.Write([uint32]0)
    $w.Write([uint32]0x910)
    $w.Write([uint32]$n)
    $w.Write([uint32]0)
    $w.Write([uint32]1)
    $w.Write([uint32]1048576)
    $w.Write([uint32]$Width)
    $w.Write([uint32]$Height)
    $w.Write([uint32]0); $w.Write([uint32]0); $w.Write([uint32]0); $w.Write([uint32]0)

    fourcc $w 'LIST'; $w.Write([uint32]4244); fourcc $w 'strl'

    fourcc $w 'strh'; $w.Write([uint32]56)
    fourcc $w 'vids'
    $w.Write([uint32]0)
    $w.Write([uint32]0)
    $w.Write([uint16]0)
    $w.Write([uint16]0)
    $w.Write([uint32]0)
    $w.Write([uint32]1)
    $w.Write([uint32]$Fps)
    $w.Write([uint32]0)
    $w.Write([uint32]$n)
    $w.Write([uint32]$frameBytes)
    $w.Write([uint32]::MaxValue)
    $w.Write([uint32]0)
    $w.Write([uint16]0); $w.Write([uint16]0)
    $w.Write([uint16]$Width); $w.Write([uint16]$Height)

    fourcc $w 'strf'; $w.Write([uint32]40)
    $w.Write([uint32]40)
    $w.Write([int32]$Width)
    $w.Write([int32](-$Height))
    $w.Write([uint16]1)
    $w.Write([uint16]24)
    $w.Write([uint32]0)
    $w.Write([uint32]$frameBytes)
    $w.Write([uint32]0); $w.Write([uint32]0)
    $w.Write([uint32]0); $w.Write([uint32]0)

    junk $w 4120
    junk $w 260

    fourcc $w 'LIST'; $w.Write([uint32]26); fourcc $w 'INFO'
    fourcc $w 'ISFT'; $w.Write([uint32]13)
    $w.Write([System.Text.Encoding]::ASCII.GetBytes("pxdf-patterns"))
    $w.Write([byte]0)
    $w.Write([byte]0)

    junk $w 1016

    if ($ms.Position -ne 5666) {
        throw "Header layout drifted: 'movi' would start at $($ms.Position), expected 5666."
    }

    fourcc $w 'LIST'; $w.Write([uint32]$moviListSize); fourcc $w 'movi'
    $index = New-Object System.Collections.Generic.List[uint32]
    $rel = 4
    foreach ($f in $Frames) {
        fourcc $w '00dc'
        $w.Write([uint32]$frameBytes)
        $w.Write($f)
        $index.Add([uint32]$rel)
        $rel += 8 + $frameBytes
    }

    fourcc $w 'idx1'; $w.Write([uint32]$idx1Payload)
    foreach ($off in $index) {
        fourcc $w '00dc'
        $w.Write([uint32]0x10)
        $w.Write([uint32]$off)
        $w.Write([uint32]$frameBytes)
    }

    $w.Flush()
    [System.IO.File]::WriteAllBytes($Path, $ms.ToArray())
    $w.Dispose(); $ms.Dispose()
}

# ------------------------------------------------------ gradient24 (mirrors
# mapper/patterns.py::gradient24 exactly -- red carries the tile index, green
# carries y, blue carries x. Cross-checked byte-for-byte by
# tools/oracle/tests/test_make_gradient_avi.py against the real Python source.)

function New-Gradient24Frame {
    param([int]$Width, [int]$Height, [int]$TileSize, [int]$Cols)
    $buf = New-Object byte[] ($Width * $Height * 3)
    for ($y = 0; $y -lt $Height; $y++) {
        $tileRow = [Math]::Floor($y / $TileSize)
        for ($x = 0; $x -lt $Width; $x++) {
            $tileCol = [Math]::Floor($x / $TileSize)
            $r = (([int]$tileRow * $Cols + [int]$tileCol) * 7 + 1) -band 0xFF
            $g = $y -band 0xFF
            $b = $x -band 0xFF
            $i = ($y * $Width + $x) * 3
            $buf[$i]     = [byte]$b   # DIB byte order is B, G, R
            $buf[$i + 1] = [byte]$g
            $buf[$i + 2] = [byte]$r
        }
    }
    return $buf
}

# --------------------------------------------------------------------- build

$dir = Split-Path -Parent ([System.IO.Path]::GetFullPath($OutFile))
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$frame = New-Gradient24Frame -Width $Width -Height $Height -TileSize $TileSize -Cols $Cols
$count = [int][Math]::Round($Seconds * $Fps)
$frames = New-Object System.Collections.Generic.List[byte[]]
for ($i = 0; $i -lt $count; $i++) { $frames.Add($frame) }

Write-UncompressedAvi -Path ([System.IO.Path]::GetFullPath($OutFile)) -Frames $frames -Width $Width -Height $Height -Fps $Fps

$len = (Get-Item $OutFile).Length
"{0}  {1}x{2} px ({3}x{4} tiles)  {5} frames  {6:N1}s  {7:N0} bytes" -f `
    (Split-Path $OutFile -Leaf), $Width, $Height, $Cols, $Rows, $frames.Count, ($frames.Count / $Fps), $len
