# Drive the native "Select Workspace Directory" folder dialog that the dsh
# host opens for the Web GUI's workspace picker.
#
# This exists for automated acceptance checks of the desktop build: the dialog
# is a real Win32 IFileOpenDialog owned by a dsh helper process, so it is driven
# here through UI Automation instead of by a human click.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\select-workspace-dialog.ps1 -Path "D:\AI projects\temp"

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Title = 'Select Workspace Directory'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$byName = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, $Title)

$dialog = $null
for ($attempt = 0; $attempt -lt 20 -and $null -eq $dialog; $attempt++) {
  $dialog = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $byName)
  if ($null -eq $dialog) { Start-Sleep -Milliseconds 500 }
}
if ($null -eq $dialog) { throw "dialog '$Title' not found" }
Write-Host "dialog: $($dialog.Current.Name) ($($dialog.Current.ClassName))"

# Type the absolute path into the file-name field.
$editCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit)

$typed = $false
for ($attempt = 0; $attempt -lt 10 -and -not $typed; $attempt++) {
  $edit = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
  if ($null -eq $edit) { Start-Sleep -Milliseconds 400; continue }
  try {
    $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value.SetValue($Path)
    $typed = $true
  } catch {
    Start-Sleep -Milliseconds 400
  }
}
if (-not $typed) { throw "could not type into the folder dialog: $Path" }
Write-Host "typed: $Path"
Start-Sleep -Milliseconds 600

# Confirm. Some dialogs need a second confirmation once the path navigated.
for ($attempt = 0; $attempt -lt 3; $attempt++) {
  $stillOpen = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $byName)
  if ($null -eq $stillOpen) { break }
  $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $buttons = $stillOpen.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  $chosen = $null
  foreach ($button in $buttons) {
    $caption = $button.Current.Name
    if ($caption -match '^(选择文件夹|Select Folder|打开|Open|确定|OK)$') { $chosen = $button; break }
  }
  if ($null -eq $chosen) { throw 'no confirm button found in the folder dialog' }
  $chosen.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Write-Host "invoked: $($chosen.Current.Name)"
  Start-Sleep -Milliseconds 1200
}

if ($null -ne $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $byName)) {
  throw 'the folder dialog is still open after confirming'
}
Write-Host 'dialog closed'
