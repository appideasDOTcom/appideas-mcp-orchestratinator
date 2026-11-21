<#
  Install the orchestratinator host on Windows: the counterpart of install.sh,
  with Task Scheduler where the Mac has launchd.

    powershell -ExecutionPolicy Bypass -File host\install.ps1 [-Url <board>] [-Token <secret>] <projects-dir> [more dirs...]
    powershell -ExecutionPolicy Bypass -File host\install.ps1 -Uninstall

  Writes %USERPROFILE%\.orchestratinator\host.json (roots, and url and token
  when given, keeping anything else in it), and registers a task that starts
  the host at logon and now. Run it again to change the directories; the
  running host is stopped cleanly first.

  How the task runs was measured, not chosen (pc-developer, Windows 11,
  2026-11-20, with costmo watching the screen):
  - The action is `conhost.exe --headless node.exe supervise.mjs`. node.exe as
    the action opened a Windows Terminal window that stayed; through
    `powershell -WindowStyle Hidden` it flashed one; conhost --headless showed
    nothing at all.
  - Task Scheduler does not restart a task whose program exits, so
    supervise.mjs is the keep-alive. MultipleInstances IgnoreNew keeps a
    second start from making a second host (measured).
  - Stop-ScheduledTask is a kill with no signal, so a stop is asked for first:
    the stop file, which supervise.mjs passes to the host, which finishes the
    item in hand. Only then is the task stopped.
  - "Run only when the user is logged on" (Interactive), at the user's own
    rights: the host opens windows in the person's session and reads their
    Claude Code, as the Mac's LaunchAgent does. The task's PATH is the user's
    and held WinGet\Links (psmux), %USERPROFILE%\.local\bin (claude) and
    nodejs; the host finds psmux and claude by path anyway.
  Not measured yet: the AtLogOn trigger itself (the probe was started by hand).

  The host needs psmux (winget install marlocarlo.psmux): it answers tmux's
  commands on Windows, and each desk is a window in it.
#>
[CmdletBinding()]
param(
  [string]$Url = '',
  [string]$Token = '',
  [switch]$Uninstall,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Roots = @()
)
$ErrorActionPreference = 'Stop'

$TaskName = 'Orchestratinator Host'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfDir = Join-Path $env:USERPROFILE '.orchestratinator'
$Conf = Join-Path $ConfDir 'host.json'
$LogDir = Join-Path $ConfDir 'log'
$StopFile = Join-Path $ConfDir 'host.stop'

function Stop-Host {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { return }
  if ($task.State -eq 'Running') {
    # Asked first, so the host finishes what it is doing (supervise.mjs).
    New-Item -ItemType Directory -Force -Path $ConfDir | Out-Null
    Set-Content -LiteralPath $StopFile -Value 'stop' -Encoding ASCII
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline -and (Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') { Start-Sleep -Milliseconds 500 }
    if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') {
      Write-Warning 'the host did not stop within 25s; stopping its task'
      Stop-ScheduledTask -TaskName $TaskName
    }
  }
  Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
}

if ($Uninstall) {
  Stop-Host
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "removed the task '$TaskName'. $Conf is left as it was."
  } else {
    Write-Host "there is no task '$TaskName' to remove."
  }
  exit 0
}

# psmux is how the floor drives Claude Code here: each desk is a window in it.
$tmux = Get-Command tmux -ErrorAction SilentlyContinue
$links = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\tmux.exe'
if (-not $tmux -and -not (Test-Path -LiteralPath $links)) {
  Write-Error "psmux is not installed, and the host needs it: each desk is a window in it. Install it with:  winget install marlocarlo.psmux"
  exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "node is not on PATH. Install Node.js (winget install OpenJS.NodeJS.LTS), open a new terminal, and run this again."
  exit 1
}
$NodeExe = $node.Source

if ($Roots.Count -eq 0) {
  Write-Host 'usage: install.ps1 [-Url <board>] [-Token <secret>] <projects-dir> [more dirs...]'
  Write-Host '       -Url names the board when the desks under the folders do not agree on one'
  Write-Host '       -Token gives the host the board''s shared secret, for a machine whose desks carry none'
  Write-Host '       install.ps1 -Uninstall removes the task'
  exit 2
}

# No -Token, and this shell has ORCH_AUTH_TOKEN: that is the key, as install.sh
# takes it from the shell that runs it.
$TokenFrom = '-Token'
if (-not $Token -and $env:ORCH_AUTH_TOKEN) { $Token = $env:ORCH_AUTH_TOKEN; $TokenFrom = 'ORCH_AUTH_TOKEN in this shell' }

$abs = @()
foreach ($r in $Roots) {
  if (-not (Test-Path -LiteralPath $r -PathType Container)) { Write-Error "not a directory: $r"; exit 1 }
  $abs += (Resolve-Path -LiteralPath $r).ProviderPath
}

# Keep anything already in the file this script does not manage, and the url
# and token unless given, as install.sh does. The values go to node through
# the environment and the script has no double quote in it: Windows
# PowerShell 5.1 does not escape a `"` inside an argument it hands a program,
# so a JSON list or a quoted string there arrives cut up.
New-Item -ItemType Directory -Force -Path $ConfDir, $LogDir | Out-Null
$env:ORCH_INSTALL_FILE = $Conf
$env:ORCH_INSTALL_ROOTS = (ConvertTo-Json -InputObject @($abs) -Compress)
$env:ORCH_INSTALL_URL = $Url
$env:ORCH_INSTALL_TOKEN = $Token
& $NodeExe -e @'
const fs = require('fs'); const e = process.env;
let c = {}; try { c = JSON.parse(fs.readFileSync(e.ORCH_INSTALL_FILE, 'utf8')); } catch {}
c.roots = JSON.parse(e.ORCH_INSTALL_ROOTS);
if (e.ORCH_INSTALL_URL) c.url = e.ORCH_INSTALL_URL.replace(/\/+$/, '');
if (e.ORCH_INSTALL_TOKEN) c.token = e.ORCH_INSTALL_TOKEN;
fs.writeFileSync(e.ORCH_INSTALL_FILE, JSON.stringify(c, null, 2) + '\n');
'@
$written = $LASTEXITCODE
Remove-Item Env:ORCH_INSTALL_FILE, Env:ORCH_INSTALL_ROOTS, Env:ORCH_INSTALL_URL, Env:ORCH_INSTALL_TOKEN -ErrorAction SilentlyContinue
if ($written -ne 0) { Write-Error "could not write $Conf"; exit 1 }
$said = ''; if ($Token) { $said = " (shared secret from $TokenFrom)" }
Write-Host "wrote $Conf$said"

Stop-Host

$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$action = New-ScheduledTaskAction -Execute $conhost -Argument ("--headless `"{0}`" `"{1}`"" -f $NodeExe, (Join-Path $Here 'supervise.mjs')) -WorkingDirectory $Here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "started the task '$TaskName' (node: $NodeExe) - log: $(Join-Path $LogDir 'host.log')"
Write-Host ''
Write-Host 'To sit at a desk yourself:   tmux attach -t =orch'
Write-Host '  (each desk is a window in it, the same session the floor types into)'
Write-Host 'To stop and remove the host: powershell -ExecutionPolicy Bypass -File host\install.ps1 -Uninstall'
Write-Host "To see it:                   Get-Content -Wait '$(Join-Path $LogDir 'host.log')'"
