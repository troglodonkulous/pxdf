param([int]$SettleMs = 120, [int]$OkMs = 300, [int]$CapMs = 200, [int]$ExpandMs = 220, [string]$OutDir, [switch]$Full)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
'@ -Name U2 -Namespace W2
[void][W2.U2]::SetProcessDPIAware()

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$win = $null
$c = $walker.GetFirstChild($AE::RootElement)
while ($c -ne $null) { if ($c.Current.Name -like "*Mapper*") { $win = $c; break }; $c = $walker.GetNextSibling($c) }
$hwnd = [IntPtr]$win.Current.NativeWindowHandle
[void][W2.U2]::SetForegroundWindow($hwnd)
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# cache element handles once - big speedup vs re-finding every cycle
$cache = @{}
foreach ($aid in @('cbo_Type','cbo_FeetOfWidth','cbo_FeetOfHeight','btn_OK')) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $aid)
  $cache[$aid] = $win.FindFirst($TS::Descendants, $cond)
}
$liCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
$txCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)

# A WPF ComboBox realises no ListItem until its popup opens, so FindAll on a
# closed combo returns zero items and every Pick below fails on a null. Expand
# first, always. (The dropdown virtualises -- 10 of 32 render on screen -- but
# expanding realises all 32 to UIA, which is why the sweep can reach 64 ft.)
function Items($aid){
  $ec = $cache[$aid].GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  if ($ec.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Expanded) {
    $ec.Expand()
    Start-Sleep -Milliseconds $ExpandMs
  }
  return $cache[$aid].FindAll($TS::Descendants,$liCond)
}
function Collapse($aid){
  try {
    $ec = $cache[$aid].GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    if ($ec.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $ec.Collapse() }
  } catch { }
}
function PickIdx($aid,$idx){
  $its = Items $aid
  $its[$idx].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
  Collapse $aid
}
function PickName($aid,$n){
  $its = Items $aid
  foreach($i in $its){
    if($i.Current.Name -eq $n){
      $i.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
      Collapse $aid
      return $true
    }
  }
  Collapse $aid
  return $false
}
function Names($aid){
  $its = Items $aid
  $out=@(); foreach($i in $its){ $out += $i.Current.Name }
  Collapse $aid
  return $out
}
function Sel($aid){ $s=$cache[$aid].GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern).Current.GetSelection(); if($s.Count){$s[0].Current.Name}else{'<none>'} }

$typeNames = @('6x6_4P','6x6_8P','8x8_4P','8x8_8P')

# Default: the eight-config sample, one per interesting shape. -Full sweeps
# every width the app offers, per floor type, which is the ~100-config archive
# a future diagram generator would be graded against.
#
# The width and height lists are read off the live combos rather than typed in
# here: each floor type repopulates them with its own legal envelope, and a
# hard-coded list would silently drift from the app. The Width dropdown
# virtualises (10 of 32 items render at a time) but UIA reaches all of them --
# the printed item count per type is how you check that stayed true.
if ($Full) {
  $configs = @()
  foreach ($ti in 0..3) {
    PickIdx 'cbo_Type' $ti
    Start-Sleep -Milliseconds ($SettleMs * 3)
    $widths  = @(Names 'cbo_FeetOfWidth')
    $heights = @(Names 'cbo_FeetOfHeight')
    Write-Output ("{0,-8} widths={1} heights={2}" -f $typeNames[$ti], $widths.Count, $heights.Count)
    # One mid height per type: row count provably affects neither the edge
    # segment count nor the controller count (handoff 1 S2.3), so sweeping
    # heights would buy a four-fold repeat of the same picture.
    $h = $heights[[int]($heights.Count / 2)]
    foreach ($w in $widths) { $configs += ,@($ti, $w, $h) }
  }
  Write-Output ("-Full: {0} configs" -f $configs.Count)
} else {
  $configs = @(
    @(3,'8','6'), @(3,'12','8'), @(3,'16','12'), @(3,'24','10'),
    @(2,'16','10'), @(0,'12','8'), @(1,'20','10'), @(3,'32','16')
  )
}
$bmp = New-Object System.Drawing.Bitmap(1920,1080)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$sz  = New-Object System.Drawing.Size(1920,1080)

$swAll = [Diagnostics.Stopwatch]::StartNew()
foreach ($cfg in $configs) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $ti=$cfg[0]; $wf=$cfg[1]; $hf=$cfg[2]
  try {
    PickIdx 'cbo_Type' $ti
    Start-Sleep -Milliseconds $SettleMs
    $okW = PickName 'cbo_FeetOfWidth' $wf
    $okH = PickName 'cbo_FeetOfHeight' $hf
    Start-Sleep -Milliseconds $SettleMs
    $cache['btn_OK'].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds $OkMs

    $all = $win.FindAll($TS::Descendants,$txCond)
    $nc=0; foreach($t in $all){ if($t.Current.Name -like 'Controller *' -and $t.Current.ClassName -eq 'Text'){$nc++} }

    Start-Sleep -Milliseconds $CapMs
    $g.CopyFromScreen(0,0,0,0,$sz)
    $f = Join-Path $OutDir ("cfg_{0}_{1}x{2}.png" -f $typeNames[$ti],$wf,$hf)
    $bmp.Save($f,[System.Drawing.Imaging.ImageFormat]::Png)
    $sw.Stop()
    Write-Output ("{0,-8} W={1,-3} H={2,-3} -> wOK={3} hOK={4} actualW={5} actualH={6} CTRL={7}  {8:N2}s" -f `
      $typeNames[$ti],$wf,$hf,$okW,$okH,(Sel 'cbo_FeetOfWidth'),(Sel 'cbo_FeetOfHeight'),$nc,$sw.Elapsed.TotalSeconds)
  } catch {
    $sw.Stop()
    Write-Output ("{0,-8} W={1,-3} H={2,-3} -> FAILED: {3}  {4:N2}s" -f $typeNames[$ti],$wf,$hf,$_.Exception.Message,$sw.Elapsed.TotalSeconds)
  }
}
$swAll.Stop()
$g.Dispose(); $bmp.Dispose()
Write-Output ("TOTAL {0:N2}s for {1} configs => {2:N2}s/config" -f $swAll.Elapsed.TotalSeconds,$configs.Count,($swAll.Elapsed.TotalSeconds/$configs.Count))
