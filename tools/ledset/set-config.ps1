param(
  [int]$TypeIndex,      # 0=6x6_4P 1=6x6_8P 2=8x8_4P 3=8x8_8P
  [string]$WidthFeet,
  [string]$HeightFeet,
  [string]$OutPng
)
$ErrorActionPreference = 'Stop'
$t0 = Get-Date

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
'@ -Name U -Namespace W
[void][W.U]::SetProcessDPIAware()

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$root = $AE::RootElement

$win = $null
$c = $walker.GetFirstChild($root)
while ($c -ne $null) { if ($c.Current.Name -like "*Mapper*") { $win = $c; break }; $c = $walker.GetNextSibling($c) }
if ($win -eq $null) { throw "Mapper window not found" }

function ByAid($aid) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $aid)
  $e = $win.FindFirst($TS::Descendants, $cond)
  if ($e -eq $null) { throw "element $aid not found" }
  return $e
}
function Items($el) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
  return $el.FindAll($TS::Descendants, $cond)
}
function SelectIndex($aid, $idx) {
  $el = ByAid $aid
  $its = Items $el
  if ($idx -lt 0 -or $idx -ge $its.Count) { throw "$aid index $idx out of range (count=$($its.Count))" }
  $p = $its[$idx].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $p.Select()
}
function SelectByName($aid, $name) {
  $el = ByAid $aid
  $its = Items $el
  for ($i=0; $i -lt $its.Count; $i++) {
    if ($its[$i].Current.Name -eq $name) {
      $p = $its[$i].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $p.Select(); return $i
    }
  }
  throw "$aid : no item named '$name' (have: $((($its|%{$_.Current.Name}) -join ',')))"
}
function CurSel($aid) {
  $el = ByAid $aid
  $sp = $el.GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern)
  $s = $sp.Current.GetSelection()
  if ($s.Count -eq 0) { return "<none>" }
  return $s[0].Current.Name
}
# read the visible text of a closed combo (the ContentPresenter TextBlock)
function ComboText($aid) {
  $el = ByAid $aid
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
  $ts = $el.FindAll($TS::Descendants, $cond)
  $out = @()
  foreach ($t in $ts) { if ($t.Current.Name) { $out += $t.Current.Name } }
  return ($out -join '/')
}

# ---- ORDER MATTERS: Type first (it repopulates Width/Height) ----
SelectIndex 'cbo_Type' $TypeIndex
Start-Sleep -Milliseconds 250
$wi = SelectByName 'cbo_FeetOfWidth'  $WidthFeet
$hi = SelectByName 'cbo_FeetOfHeight' $HeightFeet
Start-Sleep -Milliseconds 150

$tSet = Get-Date

# ---- click OK via InvokePattern ----
$ok = ByAid 'btn_OK'
$ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Start-Sleep -Milliseconds 600
$tOk = Get-Date

Write-Output ("STATE type_sel='" + (CurSel 'cbo_Type') + "' type_text='" + (ComboText 'cbo_Type') + "' W=" + (CurSel 'cbo_FeetOfWidth') + " H=" + (CurSel 'cbo_FeetOfHeight'))

# ---- count drawn controller boxes on the canvas ----
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
$all = $win.FindAll($TS::Descendants, $cond)
$ctrl = @(); $pwr = 0
foreach ($t in $all) {
  $n = $t.Current.Name
  if ($n -like 'Controller *' -and $t.Current.ClassName -eq 'Text') { $ctrl += $n }
  if ($n -eq 'Power' -and $t.Current.ClassName -eq 'Text') { $pwr++ }
}
Write-Output ("CONTROLLERS=" + $ctrl.Count + " [" + (($ctrl | Sort-Object -Unique) -join ',') + "]  POWER_BOXES=" + $pwr)

# ---- screenshot: crop to canvas region (left of the 1695px control panel) ----
$hwnd = [IntPtr]$win.Current.NativeWindowHandle
[void][W.U]::ShowWindow($hwnd, 3)          # SW_MAXIMIZE (do NOT use 9/SW_RESTORE - it un-maximizes)
[void][W.U]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 500
$W = 1920; $H = 1080
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size($W, $H)))
$g.Dispose()
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$tEnd = Get-Date

Write-Output ("SAVED " + $OutPng + " (" + [int]((Get-Item $OutPng).Length/1024) + " KB)")
Write-Output ("TIMING set_combos={0:N2}s  ok_click={1:N2}s  screenshot={2:N2}s  TOTAL={3:N2}s" -f `
  ($tSet-$t0).TotalSeconds, ($tOk-$tSet).TotalSeconds, ($tEnd-$tOk).TotalSeconds, ($tEnd-$t0).TotalSeconds)
