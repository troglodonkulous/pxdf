<#
.SYNOPSIS
    Checks, without launching Ledset, whether Ledset will list and decode a
    media file.

.DESCRIPTION
    Reproduces the two gates a file has to pass to appear and play in Ledset's
    media list. Both are taken from decompiled/LedSet.decompiled.cs (decompiler output, not published):

      1. Extension filter -- MediaListProcessor.CheckIfVideoFile (line 3578)
         accepts only .MP4 .AVI .FLV .MOV .WMV .MPG. Anything else, including
         every still-image format, is skipped when the folder is scanned.

      2. Decodability -- MediaListInitThreadHandler (line 3035) calls
         VideoGrabber.GetThumbnail on each listed file. VideoGrabber.dll is a
         thin DirectShow wrapper that ships no codecs of its own, so a file
         with a codec Windows cannot resolve is listed but yields no thumbnail
         and does not play.

    This script applies gate 1 in PowerShell and gate 2 by P/Invoking the real
    VideoGrabber.dll. A file that passes both will work in Ledset.

    VideoGrabber.dll is 32-bit, so this script re-launches itself under 32-bit
    PowerShell when needed.

.EXAMPLE
    .\tools\Test-LedsetCanLoad.ps1 -Path .\test-patterns
#>
[CmdletBinding()]
param(
    # Defaults to ..\test-patterns relative to this script.
    [string]$Path,

    # Folder holding VideoGrabber.dll and its MFC/CRT dependencies.
    [string]$ReleaseDir = "$HOME\OneDrive\Documents\Dance Floor\Release",

    # Where to drop the probe thumbnails. Deliberately not the 'thn' folder
    # Ledset uses, so this never disturbs Ledset's own cache.
    [string]$WorkDir
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Path)) {
    $Path = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\test-patterns'
}
$Path = [System.IO.Path]::GetFullPath($Path)

# --- re-launch 32-bit if we are in a 64-bit host -----------------------------
if ([Environment]::Is64BitProcess) {
    $ps32 = Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path $ps32)) { throw "32-bit PowerShell not found at $ps32" }
    Write-Host "VideoGrabber.dll is 32-bit; re-launching under $ps32" -ForegroundColor DarkGray
    & $ps32 -ExecutionPolicy Bypass -NoProfile -File $MyInvocation.MyCommand.Path `
        -Path $Path -ReleaseDir $ReleaseDir
    exit $LASTEXITCODE
}

if (-not (Test-Path (Join-Path $ReleaseDir 'VideoGrabber.dll'))) {
    throw "VideoGrabber.dll not found in $ReleaseDir"
}
if (-not $WorkDir) {
    $WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) 'ddf-grabber-probe'
}
if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir | Out-Null }

# The DLL pulls in mfc140u / msvcp140 / vcruntime140 from its own folder, so it
# has to be loaded with that folder on the search path.
Add-Type -Namespace Ddf -Name Native -MemberDefinition @'
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetDllDirectory(string lpPathName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadLibrary(string lpFileName);

    [DllImport("VideoGrabber.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool InitGrabber();

    [DllImport("VideoGrabber.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool GenerateThumbnail(string videoFile, string thumbnailFile);

    [DllImport("VideoGrabber.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Auto, SetLastError = true)]
    public static extern void ReleaseGrabber();
'@

[void][Ddf.Native]::SetDllDirectory($ReleaseDir)
if ([IntPtr]::Zero -eq [Ddf.Native]::LoadLibrary((Join-Path $ReleaseDir 'VideoGrabber.dll'))) {
    throw "LoadLibrary failed for VideoGrabber.dll (error $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message))"
}

$supported = @('.MP4', '.AVI', '.FLV', '.MOV', '.WMV', '.MPG')

if (-not [Ddf.Native]::InitGrabber()) {
    throw "InitGrabber() returned false -- DirectShow could not be initialised."
}

try {
    $files = if (Test-Path $Path -PathType Container) {
        Get-ChildItem $Path -File | Sort-Object Name
    }
    else {
        @(Get-Item $Path)
    }

    $results = foreach ($f in $files) {
        $listed = $supported -contains $f.Extension.ToUpper()
        $decoded = $null
        $note = ''

        if (-not $listed) {
            $note = 'extension not in Ledset filter'
        }
        else {
            $thumb = Join-Path $WorkDir ($f.BaseName + '.bmp')
            if (Test-Path $thumb) { Remove-Item $thumb -Force }
            try {
                [void][Ddf.Native]::GenerateThumbnail($f.FullName, $thumb)
            }
            catch {
                $note = "GenerateThumbnail threw: $($_.Exception.Message)"
            }
            $decoded = (Test-Path $thumb) -and ((Get-Item $thumb).Length -gt 0)
            if (-not $decoded -and -not $note) { $note = 'no thumbnail produced -- codec not decodable' }
        }

        [pscustomobject]@{
            File     = $f.Name
            Listed   = $listed
            Decodes  = $decoded
            WorksInLedset = ($listed -and $decoded -eq $true)
            Note     = $note
        }
    }

    $results | Format-Table -AutoSize

    $bad = @($results | Where-Object { $_.Listed -and -not $_.WorksInLedset })
    if ($bad.Count) {
        Write-Host "$($bad.Count) file(s) will appear in Ledset but fail to play." -ForegroundColor Yellow
    }
    $ok = @($results | Where-Object { $_.WorksInLedset })
    Write-Host "$($ok.Count) file(s) will load and play in Ledset." -ForegroundColor Green
}
finally {
    [Ddf.Native]::ReleaseGrabber()
}
