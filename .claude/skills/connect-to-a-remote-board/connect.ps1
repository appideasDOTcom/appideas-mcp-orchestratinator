# Reads what a connection from this PC to a board on another machine needs,
# and prints what is still to do. Reads only, unless -StartTunnel is given.
#
#   connect.ps1 -Address 10.0.42.166 [-Port 6724] [-LocalPort 6724] [-User <mac user>]
#               [-Channel appideas-mcp-orchestratinator] [-Agent <name>] [-Folder <dir>] [-StartTunnel]
#
# The key is never an argument (it would land in the shell's history). To check
# one, put it in $env:ORCH_KEY for the run. It is never printed.
[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory)][string]$Address,
  [int]$Port = 6724,
  [int]$LocalPort = 0,
  [string]$User,
  [string]$Channel = 'appideas-mcp-orchestratinator',
  [string]$Agent = '<agent-name>',
  [string]$Folder = (Get-Location).Path,
  [switch]$StartTunnel
)
if (-not $LocalPort) { $LocalPort = $Port }
function Tcp($h, $p) {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.ConnectAsync($h, $p).Wait(3000) -and $c.Connected } catch { $false } finally { $c.Dispose() }
}
function Health($url) {
  try {
    $c = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "$url/health").Content
    # A reply with no charset comes back as bytes in 5.1.
    if ($c -is [byte[]]) { [Text.Encoding]::UTF8.GetString($c) } else { $c }
  } catch { $null }
}

"== what is there"
$ssh = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
"ssh client:        " + $(if ($ssh) { $ssh } else { 'MISSING (Settings > System > Optional features > OpenSSH Client)' })
$pub = Get-ChildItem "$env:USERPROFILE\.ssh\id_*.pub" -ErrorAction SilentlyContinue | Select-Object -First 1
"ssh key:           " + $(if ($pub) { $pub.FullName } else { 'none (ssh-keygen -t ed25519)' })
$direct = Tcp $Address $Port
"board ${Address}:${Port} direct: $direct"
$sshOpen = Tcp $Address 22
"ssh ${Address}:22:  $sshOpen"

$listen = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$tunnel = $null
if ($listen) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listen.OwningProcess)"
  $cmd = $proc.CommandLine
  if ($proc.Name -eq 'ssh.exe' -and $cmd -match "-L\s*${LocalPort}:[^ ]*:${Port}\b" -and $cmd -match [regex]::Escape($Address)) {
    $tunnel = $proc.ProcessId
    "local ${LocalPort}:        a tunnel to $Address is up (ssh pid $tunnel)"
  } else {
    "local ${LocalPort}:        TAKEN by $($proc.Name) pid $($proc.ProcessId), not a tunnel to $Address; pick another -LocalPort"
  }
} else { "local ${LocalPort}:        free" }

# A board that answers on its address needs no tunnel. The desktop app's board
# listens on 127.0.0.1 only, so for it the direct test is False and the tunnel is the way.
$base = if ($direct) { "http://${Address}:$Port" } else { "http://localhost:$LocalPort" }

if ($StartTunnel -and -not $direct -and -not $tunnel -and -not $listen) {
  if (-not $User) { "-StartTunnel needs -User"; exit 2 }
  & ssh.exe -o BatchMode=yes -o ConnectTimeout=5 "$User@$Address" exit 2>$null
  if ($LASTEXITCODE -ne 0) {
    "ssh as $User could not sign in without a password (exit $LASTEXITCODE): the key is not on the Mac yet, or it has a passphrase. Run the tunnel command below yourself."
  } else {
    $a = @('-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-L', "${LocalPort}:127.0.0.1:$Port", "$User@$Address")
    $p = Start-Process ssh.exe -ArgumentList $a -WindowStyle Minimized -PassThru
    Start-Sleep -Seconds 2
    $tunnel = if ($p.HasExited) { $null } else { $p.Id }
    "tunnel started: " + $(if ($tunnel) { "ssh pid $tunnel, in a minimized window of its own (close it to end the tunnel)" } else { "ssh exited at once (exit $($p.ExitCode))" })
  }
}

$h = Health $base
# A port held by anything but the tunnel answers for itself: the PC's own
# desktop app takes 6724 when it is free (windows-desktop-dev, msg 4374), and
# then /health answers from the PC's board and an agent talks to it with no error.
$wrong = $listen -and -not $tunnel -and -not $direct
if ($wrong) {
  "health at ${base}: answered by $($proc.Name) pid $($proc.ProcessId), NOT the board on $Address" + $(if ($h) { " ($h)" } else { '' })
  "   Bind nowhere until ${LocalPort} is the tunnel's: quit that program (the PC's Orchestratinator app, if that is it) or use -LocalPort."
} else {
  "health at ${base}: " + $(if ($h) { $h } else { 'no answer' })
}
if ($h -and $env:ORCH_KEY -and -not $wrong) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Method Post "$base/mcp" -ContentType 'application/json' `
      -Headers @{ 'X-Orchestratinator-Key' = $env:ORCH_KEY; 'X-Channel' = $Channel; 'X-Agent' = $Agent; Accept = 'application/json, text/event-stream' } `
      -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"connect-check","version":"0"}}}'
    "key: accepted (HTTP $($r.StatusCode))"
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    # 503 since 0.16.0 (mcpGuard in src/auth.js: a 401 is remembered by Claude
    # Code as needs-auth for every board of that name); 401 from a board before it.
    "key: " + $(if ($code -eq 503 -or $code -eq 401) { "REFUSED ($code): not this board's key" } else { "HTTP $code" })
  }
}

# What this folder is bound to already: a local-scope entry outranks the folder's .mcp.json.
$cj = "$env:USERPROFILE\.claude.json"
$fold = ($Folder -replace '\\', '/').TrimEnd('/')
$local = $null
if (Test-Path $cj) {
  $j = Get-Content $cj -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($pr in $j.projects.PSObject.Properties) {
    if ($pr.Name.TrimEnd('/') -ieq $fold -and $pr.Value.mcpServers.orchestratinator) { $local = $pr.Value.mcpServers.orchestratinator }
  }
}
"local-scope entry for this folder: " + $(if ($local) { "$($local.url) as $($local.headers.'X-Channel')/$($local.headers.'X-Agent') (it wins over .mcp.json)" } else { 'none' })
"folder .mcp.json: " + $(if (Test-Path (Join-Path $Folder '.mcp.json')) { 'present' } else { 'none' })

"`n== still to do"
if (-not $direct -and -not $tunnel) {
  $u = if ($User) { $User } else { '<mac-user>' }
  "1. On the Mac, once: System Settings > General > Sharing > Remote Login on."
  if ($pub) { "2. Put this PC's key on the Mac, once (asks the Mac password):`n   type `"$($pub.FullName)`" | ssh $u@$Address `"mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys`"" }
  "3. Start the tunnel in a PowerShell window of its own, and leave it open:`n   ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L ${LocalPort}:127.0.0.1:$Port $u@$Address"
}
"4. The key, read on the Mac in the folder bound to that board:  claude mcp get orchestratinator"
"5. Save this as $(Join-Path $Folder '.mcp.json') with the key put in:"
@"
{
  "mcpServers": {
    "orchestratinator": {
      "type": "http",
      "url": "$base/mcp",
      "headers": {
        "X-Channel": "$Channel",
        "X-Agent": "$Agent",
        "X-Orchestratinator-Key": "<paste the board's key>"
      }
    }
  }
}
"@
if ($local) { "   This folder has a local-scope entry, which wins over the file. Either remove it (claude mcp remove -s local orchestratinator) or bind with the command in 6 instead." }
"6. Or, instead of the file (local scope, nothing in the folder):`n   claude mcp add -s local --transport http orchestratinator $base/mcp -H `"X-Channel: $Channel`" -H `"X-Agent: $Agent`" -H `"X-Orchestratinator-Key: <key>`""
"7. In Claude Code: /mcp (approve the folder's server the first time), then whoami."
