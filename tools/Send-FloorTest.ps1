<#
.SYNOPSIS
  Independent test sender for the TP-878 / Kingstar LED floor controller.

.DESCRIPTION
  Implements the wire protocol documented in docs/DECOMP_FINDINGS.md. Written
  from that specification — it contains no vendor code.

  Purpose is verification at the floor, not production use:
    * prove the decompiled mapping actually lights the right pixels
    * answer the open question of whether the end-of-frame flag is required
    * check colour order on real hardware

  Uses a normal UDP socket (System.Net.Sockets.UdpClient). No raw sockets, no
  admin rights, nothing for AMSI to object to.

.EXAMPLE
  # See what would be sent, without touching the network
  .\Send-FloorTest.ps1 -Pattern white -DryRun

.EXAMPLE
  # Solid red for 5 seconds
  .\Send-FloorTest.ps1 -Pattern red -Duration 5

.EXAMPLE
  # THE EOF TEST: blink with the end-of-frame flag suppressed
  .\Send-FloorTest.ps1 -Pattern blink -NoEof -Duration 10

.EXAMPLE
  # Walk one lit tile across the floor, 2s per tile
  .\Send-FloorTest.ps1 -Pattern tilewalk -Hold 2
#>
[CmdletBinding()]
param(
    [int]$Cols = 8,                 # tile columns
    [int]$Rows = 5,                 # tile rows
    [int]$PortsPerController = 8,   # 8 for *_8P floor types, 4 for *_4P

    [ValidateSet('black','white','red','green','blue','halves','tile','pixel','tilewalk','blink','ramp')]
    [string]$Pattern = 'white',

    [int]$TileCol = 0,              # for -Pattern tile
    [int]$TileRow = 0,
    [int]$PixelX  = 0,              # for -Pattern pixel
    [int]$PixelY  = 0,

    [ValidateSet('BGR','RGB')]
    [string]$ColorOrder = 'BGR',    # findings say the vendor sends BGR

    [switch]$NoEof,                 # suppress the 0x80 end-of-frame flag
    [double]$Duration = 5,          # seconds
    [double]$Hold = 2,              # seconds per step, for -Pattern tilewalk
    [int]$Fps = 10,                 # vendor uses ~10 (Thread.Sleep(100))

    [string]$Address = '255.255.255.255',
    [int]$Port = 60001,
    [string]$LocalIP,               # bind to a specific NIC, e.g. 10.200.50.78

    [switch]$DryRun,                # print packet plan, send nothing
    [switch]$ListInterfaces
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- constants --
$TILE_W          = 8
$TILE_H          = 8
$BYTES_PER_TILE  = $TILE_W * $TILE_H * 3     # 192
$BODY_MAX        = 507                        # hard-coded in the vendor sender
$MAGIC           = 0xFF
$CONST_BYTE2     = 0x01
$EOF_FLAG        = 0x80

if ($ListInterfaces) {
    Get-NetIPAddress -AddressFamily IPv4 |
        Select-Object InterfaceAlias, IPAddress, PrefixLength |
        Sort-Object InterfaceAlias | Format-Table -AutoSize
    return
}

# ------------------------------------------------------------ derived sizes --
$WidthPx         = $TILE_W * $Cols
$HeightPx        = $TILE_H * $Rows
$portDataSize    = $BYTES_PER_TILE * $Rows
$packetsPerPort  = [int][Math]::Ceiling($portDataSize / [double]$BODY_MAX)
$controllerCount = [int][Math]::Ceiling($Cols / [double]$PortsPerController)

Write-Host ""
Write-Host "Floor      : $Cols x $Rows tiles = ${WidthPx}x${HeightPx} px" -ForegroundColor Cyan
Write-Host "Ports/ctrl : $PortsPerController   ->  $controllerCount controller(s)" -ForegroundColor Cyan
Write-Host "portDataSize=$portDataSize  packetsPerPort=$packetsPerPort  colour=$ColorOrder" -ForegroundColor Cyan
if ($NoEof) { Write-Host "EOF FLAG   : SUPPRESSED  (testing whether the controller needs it)" -ForegroundColor Yellow }
Write-Host ""

# ------------------------------------------------------- framebuffer helpers --
# Logical framebuffer, top-left origin, 3 bytes/px in R,G,B order.
# Colour-order conversion happens once, at pack time.
function New-Frame { , (New-Object 'byte[]' ($WidthPx * $HeightPx * 3)) }

function Set-Pixel {
    param([byte[]]$Frame, [int]$X, [int]$Y, [byte]$R, [byte]$G, [byte]$B)
    if ($X -lt 0 -or $X -ge $WidthPx -or $Y -lt 0 -or $Y -ge $HeightPx) { return }
    $i = ($Y * $WidthPx + $X) * 3
    $Frame[$i] = $R; $Frame[$i+1] = $G; $Frame[$i+2] = $B
}

function Set-Solid {
    param([byte[]]$Frame, [byte]$R, [byte]$G, [byte]$B)
    for ($i = 0; $i -lt $Frame.Length; $i += 3) {
        $Frame[$i] = $R; $Frame[$i+1] = $G; $Frame[$i+2] = $B
    }
}

function Set-TileLit {
    param([byte[]]$Frame, [int]$TCol, [int]$TRow, [byte]$R = 255, [byte]$G = 255, [byte]$B = 255)
    for ($dy = 0; $dy -lt $TILE_H; $dy++) {
        for ($dx = 0; $dx -lt $TILE_W; $dx++) {
            Set-Pixel $Frame ($TCol*$TILE_W + $dx) ($TRow*$TILE_H + $dy) $R $G $B
        }
    }
}

# ------------------------------------------------------------------ packing --
# Logical framebuffer -> vendor send buffer.
#   tiles are column-major:  base = (Rows*tileCol + tileRow) * 192
#   within a tile, row-major (identity scan table for 8x8 floor types)
function ConvertTo-SendBuffer {
    param([byte[]]$Frame)
    $buf = New-Object 'byte[]' ($Cols * $Rows * $BYTES_PER_TILE)
    for ($tc = 0; $tc -lt $Cols; $tc++) {
        for ($tr = 0; $tr -lt $Rows; $tr++) {
            $tileBase = ($Rows * $tc + $tr) * $BYTES_PER_TILE
            for ($yIn = 0; $yIn -lt $TILE_H; $yIn++) {
                for ($xIn = 0; $xIn -lt $TILE_W; $xIn++) {
                    $slot = $yIn * $TILE_W + $xIn
                    $src  = (($tr*$TILE_H + $yIn) * $WidthPx + ($tc*$TILE_W + $xIn)) * 3
                    $dst  = $tileBase + $slot * 3
                    $r = $Frame[$src]; $g = $Frame[$src+1]; $b = $Frame[$src+2]
                    if ($ColorOrder -eq 'BGR') {
                        $buf[$dst] = $b; $buf[$dst+1] = $g; $buf[$dst+2] = $r
                    } else {
                        $buf[$dst] = $r; $buf[$dst+1] = $g; $buf[$dst+2] = $b
                    }
                }
            }
        }
    }
    ,$buf
}

# Send buffer -> ordered list of datagrams, exactly as the vendor emits them.
function Build-Packets {
    param([byte[]]$SendBuf)
    $packets = New-Object 'System.Collections.Generic.List[byte[]]'
    for ($ci = 0; $ci -lt $controllerCount; $ci++) {
        $portsHere = $PortsPerController
        $rem = $Cols % $PortsPerController
        if ($ci -eq ($controllerCount - 1) -and $rem -ne 0) { $portsHere = $rem }

        for ($pi = 0; $pi -lt $portsHere; $pi++) {
            $globalCol = $PortsPerController * $ci + $pi
            $portBase  = $globalCol * $portDataSize

            for ($ki = 0; $ki -lt $packetsPerPort; $ki++) {
                $off     = $ki * $BODY_MAX
                $bodyLen = $BODY_MAX
                $b4      = $ki
                if ($ki -eq ($packetsPerPort - 1)) {
                    $bodyLen = $portDataSize - $off
                    if ($pi -eq ($portsHere - 1) -and -not $NoEof) { $b4 = $ki -bor $EOF_FLAG }
                }
                $pkt = New-Object 'byte[]' ($bodyLen + 5)
                $pkt[0] = $MAGIC
                $pkt[1] = [byte]$ci
                $pkt[2] = $CONST_BYTE2
                $pkt[3] = [byte]$pi
                $pkt[4] = [byte]$b4
                [Array]::Copy($SendBuf, $portBase + $off, $pkt, 5, $bodyLen)
                $packets.Add($pkt) | Out-Null
            }
        }
    }
    ,$packets
}

# ----------------------------------------------------------- frame painting --
function Get-Frame {
    param([int]$Step)
    $f = New-Frame
    switch ($Pattern) {
        'black'  { }
        'white'  { Set-Solid $f 255 255 255 }
        'red'    { Set-Solid $f 255 0 0 }
        'green'  { Set-Solid $f 0 255 0 }
        'blue'   { Set-Solid $f 0 0 255 }
        'halves' {
            for ($y=0; $y -lt $HeightPx; $y++) {
                for ($x=0; $x -lt $WidthPx; $x++) {
                    if ($x -lt ($WidthPx/2)) { Set-Pixel $f $x $y 255 0 0 }
                    else                     { Set-Pixel $f $x $y 0 0 255 }
                }
            }
        }
        'ramp' {
            # x -> red, y -> green. Makes any mis-mapping visually obvious.
            for ($y=0; $y -lt $HeightPx; $y++) {
                for ($x=0; $x -lt $WidthPx; $x++) {
                    Set-Pixel $f $x $y ([byte](255*$x/[Math]::Max(1,$WidthPx-1))) ([byte](255*$y/[Math]::Max(1,$HeightPx-1))) 0
                }
            }
        }
        'tile'   { Set-TileLit $f $TileCol $TileRow }
        'pixel'  { Set-Pixel $f $PixelX $PixelY 255 255 255 }
        'blink'  { if ($Step % 2 -eq 0) { Set-Solid $f 255 255 255 } }
        'tilewalk' {
            $n  = $Cols * $Rows
            $ix = $Step % $n
            Set-TileLit $f ([int][Math]::Floor($ix / $Rows)) ($ix % $Rows)
        }
    }
    ,$f
}

function Get-StepLabel {
    param([int]$Step)
    switch ($Pattern) {
        'tilewalk' {
            $n = $Cols * $Rows; $ix = $Step % $n
            "tile (col=$([int][Math]::Floor($ix/$Rows)), row=$($ix % $Rows))"
        }
        'blink' { if ($Step % 2 -eq 0) { 'WHITE' } else { 'black' } }
        default { $Pattern }
    }
}

# --------------------------------------------------------------- dry run ------
if ($DryRun) {
    $pkts = Build-Packets (ConvertTo-SendBuffer (Get-Frame 0))
    $total = 0
    Write-Host "Packet plan for one frame:" -ForegroundColor Green
    Write-Host ("  {0,-4} {1,-5} {2,-5} {3,-6} {4,-7} {5}" -f 'idx','ctrl','port','pkt','byte4','length')
    for ($i = 0; $i -lt $pkts.Count; $i++) {
        $p = $pkts[$i]; $total += $p.Length
        Write-Host ("  {0,-4} {1,-5} {2,-5} {3,-6} 0x{4:X2}    {5}" -f $i, $p[1], $p[3], ($p[4] -band 0x7F), $p[4], $p.Length)
    }
    Write-Host ""
    Write-Host "  $($pkts.Count) packets, $total bytes/frame" -ForegroundColor Green
    $eofCount = @($pkts | Where-Object { ($_[4] -band $EOF_FLAG) -ne 0 }).Count
    Write-Host "  end-of-frame flags: $eofCount (expected $(if($NoEof){0}else{$controllerCount}))" -ForegroundColor Green
    Write-Host ""
    return
}

# ------------------------------------------------------------------ sending --
if ($LocalIP) {
    $bind = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Parse($LocalIP), 0)
    $udp  = New-Object System.Net.Sockets.UdpClient($bind)
    Write-Host "Bound to $LocalIP" -ForegroundColor DarkGray
} else {
    $udp = New-Object System.Net.Sockets.UdpClient
}
$udp.EnableBroadcast = $true
$ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Parse($Address), $Port)

$frameMs   = [int](1000 / $Fps)
$stepFrames = [Math]::Max(1, [int]($Hold * $Fps))
$totalFrames = [int]($Duration * $Fps)
if ($Pattern -eq 'tilewalk') { $totalFrames = $Cols * $Rows * $stepFrames }

Write-Host "Sending to ${Address}:${Port} at ${Fps} fps for $([Math]::Round($totalFrames/$Fps,1))s. Ctrl+C to stop." -ForegroundColor Green
Write-Host ""

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$lastLabel = ''
$sent = 0
try {
    for ($n = 0; $n -lt $totalFrames; $n++) {
        $step = switch ($Pattern) {
            'tilewalk' { [int][Math]::Floor($n / $stepFrames) }
            'blink'    { [int][Math]::Floor($n / $stepFrames) }
            default    { $n }
        }
        $label = Get-StepLabel $step
        if ($label -ne $lastLabel) {
            Write-Host ("  [{0,6:N1}s] {1}" -f ($sw.ElapsedMilliseconds/1000), $label)
            $lastLabel = $label
        }

        foreach ($p in (Build-Packets (ConvertTo-SendBuffer (Get-Frame $step)))) {
            [void]$udp.Send($p, $p.Length, $ep)   # no inter-packet delay, as the vendor does
            $sent++
        }

        $target = ($n + 1) * $frameMs
        $sleep  = $target - $sw.ElapsedMilliseconds
        if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
    }
}
finally {
    $udp.Close()
    Write-Host ""
    Write-Host "Sent $sent packets in $([Math]::Round($sw.ElapsedMilliseconds/1000,1))s." -ForegroundColor Green
}
