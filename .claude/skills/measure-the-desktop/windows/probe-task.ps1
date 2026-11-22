<#
  Run something the way the Windows host runs: from a hidden scheduled task,
  under `conhost.exe --headless`, as the logged-on user, with Task Scheduler's
  environment and not your shell's.

    probe-task.ps1 <program> [args...]     register (no trigger), start, wait for launch.cjs to log its end line
    probe-task.ps1 -Remove                 stop and delete the task

  <program> and its args are handed to launch.cjs, which execFiles them with
  no shell and writes START/END lines to out.jsonl in $env:PROBE_DIR
  (default %TEMP%\orch-desktop-probe). For example, the shipped folder dialog:

    probe-task.ps1 C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File <repo>\host\dialog-win.ps1 C:\Users

  and a Windows Terminal window (needs -Show: see SKILL.md, "windowsHide"):

    probe-task.ps1 -Show "$env:LOCALAPPDATA\Microsoft\WindowsApps\wt.exe" -w new new-tab --title probe-1 cmd

  The task has no trigger: it starts only when this script starts it, and
  nothing on the machine can start it later. Remove it when done.

  Why a task and not your shell: a process started from your window inherits
  your window's place in front (and your Claude Code's CLAUDE_* markers), so
  it measures your window, not the host's context. The installed host runs
  as this task does (host/install.ps1).
#>
# PositionalBinding off: otherwise PowerShell binds the program's path to -Name,
# the first positional string, and the task is named after the program.
[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$Remove,
  [switch]$Show,
  [string]$Name = 'orch-desktop-probe',
  [int]$WaitSeconds = 180,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Program = @()
)
$ErrorActionPreference = 'Stop'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    Write-Host "removed the task '$Name'"
  } else { Write-Host "there is no task '$Name'" }
  exit 0
}
if ($Program.Count -eq 0) { Get-Help $PSCommandPath; exit 2 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path -LiteralPath $node)) { Write-Error 'node is not on PATH or in Program Files\nodejs'; exit 1 }

$probeDir = if ($env:PROBE_DIR) { $env:PROBE_DIR } else { Join-Path $env:TEMP 'orch-desktop-probe' }
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
$out = Join-Path $probeDir 'out.jsonl'
$before = if (Test-Path -LiteralPath $out) { @(Get-Content -LiteralPath $out).Count } else { 0 }

# Task Scheduler takes one argument string. Each argument is quoted for
# conhost/node's command-line parsing; an argument with a double quote in it
# is not supported here (none of the measured ones had one).
$launch = Join-Path $PSScriptRoot 'launch.cjs'
$quoted = @($launch, '--out', $probeDir) + $(if ($Show) { @('--show') } else { @() }) + $Program | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_ + '"' } else { $_ } }
$argLine = '--headless "' + $node + '" ' + ($quoted -join ' ')

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\conhost.exe') -Argument $argLine -WorkingDirectory $PSScriptRoot
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $Name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
$t0 = Get-Date
Start-ScheduledTask -TaskName $Name
Write-Host ("started '{0}' at {1:HH:mm:ss.f}; out: {2}" -f $Name, $t0, $out)

$deadline = $t0.AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  if ((Test-Path -LiteralPath $out) -and (@(Get-Content -LiteralPath $out -Encoding UTF8 | Select-Object -Skip $before) -match '"event":"end"')) { break }
  Start-Sleep -Milliseconds 500
}
Get-Content -LiteralPath $out -Encoding UTF8 | Select-Object -Skip $before
