<#
Live verification of the XML control path (HANDOFF decision 5): write a
Ledset-loadable mapper XML to the file Ledset already reads its geometry
from -- Configure.ini's `MapperPath` -- close and relaunch Ledset, and
confirm the Mapper page reports back the geometry we wrote. No selection
changes anywhere in this script: every AutomationElement call below is a
read, or `cbo_Type`'s `ExpandCollapsePattern.Expand()`/`Collapse()` (see
`TypeComboText` below), which opens and closes the dropdown but does not
change `SelectedIndex` and fires no `SelectionChanged` -- verified live
2026-08-08 (RuntimeId of the selected item identical before and after).
There is no Select() and no Invoke() in this file.

Never touches the Player page: relaunching Ledset always opens on the
Mapper page (`App.ShowAppWin()` in the decompiled source), and this script
does not navigate anywhere from there.

Restores the target XML file's original on-disk content before exiting
(so the *file* is left exactly as found; only the running app's in-memory
state reflects the geometry loaded during verification), and restores
whatever window had focus when the script started, so the operator's
terminal gets focus back at the end -- not Ledset.

Requires LedSet.exe already running: this script closes and relaunches
that instance. It does not cold-start one, and `OnlyRunOneInstance()` in
the vendor code means a second instance cannot coexist with the first
anyway (decompiled/LedSet.decompiled.cs:696).

Must be run attended -- it takes the foreground and briefly closes Ledset.

Usage:
    python -m mapper xml --type 8x8_4P --cols 10 --rows 5 --out candidate.xml
    powershell -File tools\oracle\verify-xml-control-path.ps1 `
        -CandidateXml candidate.xml `
        -ExpectType 8x8_4P -ExpectWidthFeet 20 -ExpectHeightFeet 10 -ExpectControllers 3
#>
param(
  [string]$LedSetExe = "C:\Users\USER\dev\Dance Floor\Release\LedSet.exe",
  [Parameter(Mandatory=$true)][string]$CandidateXml,
  [string]$ExpectType,
  [int]$ExpectWidthFeet,
  [int]$ExpectHeightFeet,
  [int]$ExpectControllers
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@ -Name U3 -Namespace W3
[void][W3.U3]::SetProcessDPIAware()
$prevForeground = [W3.U3]::GetForegroundWindow()
Write-Output ("stashed foreground window handle: " + $prevForeground)

$result = [ordered]@{
  ok = $false
  mapperPath = $null
  typeText = $null
  widthSel = $null
  heightSel = $null
  controllerCount = $null
  matchesExpected = $null
  error = $null
}

try {
    $proc = Get-Process -Name "LedSet" -ErrorAction Stop
    if (@($proc).Count -gt 1) { throw "more than one LedSet process is running; refusing to guess which one" }

    # ---- discover the live MapperPath target, read-only ----
    $configureIni = Join-Path (Split-Path $LedSetExe) "Configure.ini"
    $iniLine = Get-Content $configureIni | Where-Object { $_ -match '^MapperPath=(.*)$' } | Select-Object -First 1
    if (-not $iniLine) { throw "Configure.ini has no MapperPath= line" }
    $mapperPath = $iniLine -replace '^MapperPath=', ''
    if (-not $mapperPath -or -not (Test-Path $mapperPath)) {
        throw "Configure.ini's MapperPath ('$mapperPath') does not point at an existing file -- refusing to guess-write one"
    }
    $result.mapperPath = $mapperPath
    Write-Output "MapperPath target: $mapperPath"

    $originalXml = Get-Content -Raw $mapperPath
    $candidateXml = Get-Content -Raw $CandidateXml

    # ---- write the candidate geometry, close, relaunch, verify, always restore ----
    Set-Content -Path $mapperPath -Value $candidateXml -NoNewline
    try {
        Write-Output ("closing LedSet PID " + $proc.Id + " (CloseMainWindow -- runs the vendor's own Closing handler, " +
                       "which calls PipeMsgSend.SetTimer(false) before Application.Current.Shutdown())")
        [void]$proc.CloseMainWindow()
        $exited = $proc.WaitForExit(10000)
        if (-not $exited) { throw "LedSet did not exit within 10s of CloseMainWindow(); aborting without relaunch" }
        Start-Sleep -Milliseconds 500

        Write-Output "relaunching..."
        Start-Process -FilePath $LedSetExe | Out-Null

        $AE = [System.Windows.Automation.AutomationElement]
        $TS = [System.Windows.Automation.TreeScope]
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $win = $null
        $deadline = (Get-Date).AddSeconds(20)
        while (-not $win -and (Get-Date) -lt $deadline) {
            $c = $walker.GetFirstChild($AE::RootElement)
            while ($c -ne $null) {
                if ($c.Current.Name -like "*Mapper*") { $win = $c; break }
                $c = $walker.GetNextSibling($c)
            }
            if (-not $win) { Start-Sleep -Milliseconds 500 }
        }
        if (-not $win) { throw "Mapper window did not appear within 20s of relaunch" }
        Start-Sleep -Milliseconds 500   # let OpenFile()/Btn_OK_Click finish its redraw

        function ByAid($aid) {
            $cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $aid)
            $e = $win.FindFirst($TS::Descendants, $cond)
            if ($e -eq $null) { throw "element $aid not found" }
            return $e
        }
        # SelectionPattern read -- READ ONLY, no Select()
        function CurSel($aid) {
            $el = ByAid $aid
            $sp = $el.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern)
            $s = $sp.Current.GetSelection()
            if ($s.Count -eq 0) { return "<none>" }
            return $s[0].Current.Name
        }

        # cbo_Type's ListBoxItem.Name is the shared class ToString() for all four
        # entries (Handoff 1 S2.3) -- only the rendered combo TEXT distinguishes,
        # because cbo_Type.DisplayMemberPath = "DisplayName" (LedSet.decompiled.cs:1217,
        # FloorTypeSet(FloorType) ctor around line 2241 sets DisplayName = "8x8_4P" etc).
        #
        # A closed cbo_Type has ZERO Text descendants -- confirmed live 2026-08-08 by
        # exhaustive enumeration (every AutomationElement.*Property on the selected
        # item, LegacyIAccessible unavailable in this UIA assembly, ItemContainerPattern
        # only ever returns the one already-selected container). The item's DisplayName
        # TextBlock is not realized until the popup opens at least once. Expanding it
        # does not change the selection -- Expand()/Collapse() touch
        # ExpandCollapseState only, confirmed by RuntimeId identical before and after --
        # and once realized the item containers stay realized after Collapse(), so this
        # reads the same as before: no click, no keystroke, nothing chosen.
        function TypeComboText($aid) {
            $el = ByAid $aid
            $sp = $el.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern)
            $selected = $sp.Current.GetSelection()[0]
            $selectedId = $selected.GetRuntimeId() -join ','

            $ecp = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            $ecp.Expand()
            try {
                $liCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
                $items = $el.FindAll($TS::Descendants, $liCond)
                $txCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
                foreach ($it in $items) {
                    if (($it.GetRuntimeId() -join ',') -eq $selectedId) {
                        $t = $it.FindFirst($TS::Descendants, $txCond)
                        if ($t -ne $null) { return $t.Current.Name }
                    }
                }
                return ""
            }
            finally {
                $ecp.Collapse()
            }
        }
        $typeText = TypeComboText 'cbo_Type'
        $widthSel = CurSel 'cbo_FeetOfWidth'
        $heightSel = CurSel 'cbo_FeetOfHeight'

        $txCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
        $all = $win.FindAll($TS::Descendants, $txCond)
        $ctrl = @()
        foreach ($t in $all) {
            if ($t.Current.Name -like 'Controller *' -and $t.Current.ClassName -eq 'Text') { $ctrl += $t.Current.Name }
        }
        $controllerCount = ($ctrl | Sort-Object -Unique).Count

        $result.typeText = $typeText
        $result.widthSel = $widthSel
        $result.heightSel = $heightSel
        $result.controllerCount = $controllerCount

        Write-Output ("OBSERVED  type='" + $typeText + "'  width=" + $widthSel + "ft  height=" + $heightSel + "ft  controllers=" + $controllerCount)
        Write-Output ("EXPECTED  type='" + $ExpectType + "'  width=" + $ExpectWidthFeet + "ft  height=" + $ExpectHeightFeet + "ft  controllers=" + $ExpectControllers)

        $matches = ($typeText -eq $ExpectType) -and ([int]$widthSel -eq $ExpectWidthFeet) -and
                   ([int]$heightSel -eq $ExpectHeightFeet) -and ($controllerCount -eq $ExpectControllers)
        $result.matchesExpected = $matches
        $result.ok = $true
        Write-Output ("MATCH: " + $matches)
    }
    finally {
        # ---- always restore the file's original content, whatever happened above ----
        Set-Content -Path $mapperPath -Value $originalXml -NoNewline
        Write-Output "restored original MapperPath file content"
    }
}
catch {
    $result.error = $_.Exception.Message
    Write-Output ("ERROR: " + $_.Exception.Message)
}
finally {
    Start-Sleep -Milliseconds 300
    [void][W3.U3]::SetForegroundWindow($prevForeground)
    Write-Output "restored previous foreground window"
}

Write-Output "---RESULT-JSON---"
Write-Output ($result | ConvertTo-Json -Compress)
