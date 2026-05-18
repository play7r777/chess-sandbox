# Chess Sandbox - public tunnel launcher (Windows PowerShell).
#
# Binds the FastAPI server to 0.0.0.0:<Port> and spawns the chosen
# tunnel (ngrok or playit.gg) so friends from other countries can
# connect by URL.
#
# Examples:
#   .\scripts\start-public.ps1                  # ngrok (default)
#   .\scripts\start-public.ps1 -Tunnel playit   # playit.gg
#   .\scripts\start-public.ps1 -Tunnel none     # bind 0.0.0.0 only
#   .\scripts\start-public.ps1 -Port 9000
#
# Install ngrok separately: https://ngrok.com/download
# Install playit:           https://playit.gg/download
#
# Compatible with Windows PowerShell 5.1 and PowerShell 7+.
# Script is intentionally kept in plain ASCII so PS 5.1 (which reads
# .ps1 files using the system codepage by default) does not mangle it.

param(
    [ValidateSet("ngrok", "playit", "none")]
    [string]$Tunnel = "ngrok",
    [int]$Port = 8001
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $repoRoot

# Resolve a tunnel binary by name. Looks in this order:
#   1) <repoRoot>\scripts\<name>.exe   (drop the binary next to this script)
#   2) <repoRoot>\<name>.exe            (drop the binary in the project root)
#   3) PATH
function Resolve-TunnelBinary($name) {
    $candidates = @(
        (Join-Path $PSScriptRoot "$name.exe"),
        (Join-Path $repoRoot "$name.exe")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# Locate Python: prefer .venv\Scripts\python.exe, fall back to PATH.
$pythonExe = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $pythonExe)) {
    $pyCmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pyCmd) {
        Write-Host "Python not found in .venv or PATH." -ForegroundColor Red
        Write-Host "Create venv: py -3.11 -m venv .venv ; .venv\Scripts\pip install -e ." -ForegroundColor Yellow
        exit 1
    }
    $pythonExe = $pyCmd.Source
}

# Bind to 0.0.0.0 so the tunnel can reach uvicorn.
$env:CHESS_HOST = "0.0.0.0"
$env:CHESS_PORT = "$Port"

# Auto-generate CHESS_AUTH_TOKEN on first launch unless the user has
# already exported one or explicitly opted into the insecure path.
# Without this the backend now refuses to bind to a non-loopback host
# because anyone with the public URL would be able to forge client_id
# and overwrite somebody else's profile.
$insecureOptIn = ($env:CHESS_ALLOW_INSECURE_PUBLIC -eq "1")
if (-not $insecureOptIn -and [string]::IsNullOrEmpty($env:CHESS_AUTH_TOKEN)) {
    $bytes = New-Object byte[] 16
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [System.BitConverter]::ToString($bytes).Replace("-", "").ToLower()
    $env:CHESS_AUTH_TOKEN = $token
    Write-Host "-> Generated CHESS_AUTH_TOKEN=$token (visit URL with ?token=... once to set the cookie)" -ForegroundColor DarkGray
}

# Auto-generate CHESS_HOST_TOKEN. Only the operator's host URL gets
# this baked in; the URL shared with friends keeps the auth token
# only, so they can play but can't touch the shared Stockfish
# settings (threads / hash / skill).
if ([string]::IsNullOrEmpty($env:CHESS_HOST_TOKEN)) {
    $bytes = New-Object byte[] 16
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $hostToken = [System.BitConverter]::ToString($bytes).Replace("-", "").ToLower()
    $env:CHESS_HOST_TOKEN = $hostToken
    Write-Host "-> Generated CHESS_HOST_TOKEN=$hostToken (host-only; engine settings)" -ForegroundColor DarkGray
}

Write-Host "-> Starting server on 0.0.0.0:$Port ..." -ForegroundColor Cyan
$server = Start-Process -PassThru -FilePath $pythonExe `
    -ArgumentList "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "$Port" `
    -NoNewWindow

# Give uvicorn a moment to bind.
Start-Sleep -Seconds 2

$tunnelProc = $null
$publicUrl = $null
try {
    if ($Tunnel -eq "ngrok") {
        $ngrokPath = Resolve-TunnelBinary "ngrok"
        if (-not $ngrokPath) {
            Write-Host "ngrok not found." -ForegroundColor Red
            Write-Host "Either:" -ForegroundColor Yellow
            Write-Host "  - drop ngrok.exe into  $PSScriptRoot" -ForegroundColor Yellow
            Write-Host "  - drop ngrok.exe into  $repoRoot" -ForegroundColor Yellow
            Write-Host "  - add the ngrok folder to PATH (and restart this terminal)" -ForegroundColor Yellow
            Write-Host "Get ngrok: https://ngrok.com/download" -ForegroundColor Yellow
            Write-Host "First-run setup: ngrok config add-authtoken <YOUR_TOKEN>" -ForegroundColor Yellow
            throw "ngrok missing"
        }
        Write-Host "-> Starting ngrok ($ngrokPath) ..." -ForegroundColor Cyan
        $tunnelProc = Start-Process -PassThru -FilePath $ngrokPath `
            -ArgumentList "http", "$Port", "--log=stdout" -NoNewWindow

        # ngrok exposes a local admin API on :4040 - poll it for the URL.
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 500
            try {
                $api = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 2
                $https = $api.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1
                if ($https) {
                    $publicUrl = $https.public_url
                    break
                }
            } catch {
                # API not ready yet - keep polling.
            }
        }
        if ($publicUrl) {
            # Append the auth token so the first hit drops the
            # ``chess_auth`` cookie and subsequent navigation / WS
            # opens succeed without the URL parameter. Friends get
            # ONE link to share — no copy-paste of the secret.
            $shareUrl = $publicUrl
            if (-not [string]::IsNullOrEmpty($env:CHESS_AUTH_TOKEN)) {
                $shareUrl = "$publicUrl/?token=$($env:CHESS_AUTH_TOKEN)"
            }
            $hostUrl = $shareUrl
            if (-not [string]::IsNullOrEmpty($env:CHESS_HOST_TOKEN)) {
                if ($shareUrl.Contains("?")) {
                    $hostUrl = "$shareUrl&host_token=$($env:CHESS_HOST_TOKEN)"
                } else {
                    $hostUrl = "$shareUrl/?host_token=$($env:CHESS_HOST_TOKEN)"
                }
            }
            Write-Host ""
            Write-Host "OK  Public URL (share with friends): $shareUrl" -ForegroundColor Green
            if ($hostUrl -ne $shareUrl) {
                Write-Host "    Your host URL (DO NOT share): $hostUrl" -ForegroundColor Cyan
            }
            Write-Host "    On the ngrok free plan first-time visitors see a 'Visit Site'"
            Write-Host "    warning page; one click and they're in."
            if (-not [string]::IsNullOrEmpty($env:CHESS_AUTH_TOKEN)) {
                Write-Host "    The ?token=... part is consumed once and stored in an HttpOnly" -ForegroundColor DarkGray
                Write-Host "    cookie; reload/share without the suffix after the first visit." -ForegroundColor DarkGray
            }
            Write-Host ""
        } else {
            Write-Host "Could not reach the ngrok API (http://127.0.0.1:4040)." -ForegroundColor Yellow
            Write-Host "Open that page in a browser and copy the URL manually." -ForegroundColor Yellow
        }
    }
    elseif ($Tunnel -eq "playit") {
        $playitPath = Resolve-TunnelBinary "playit"
        if (-not $playitPath) {
            Write-Host "playit not found." -ForegroundColor Red
            Write-Host "Either:" -ForegroundColor Yellow
            Write-Host "  - drop playit.exe into  $PSScriptRoot" -ForegroundColor Yellow
            Write-Host "  - drop playit.exe into  $repoRoot" -ForegroundColor Yellow
            Write-Host "  - add the playit folder to PATH (and restart this terminal)" -ForegroundColor Yellow
            Write-Host "Get playit: https://playit.gg/download" -ForegroundColor Yellow
            throw "playit missing"
        }
        Write-Host "-> Starting playit ($playitPath) ..." -ForegroundColor Cyan
        $tunnelProc = Start-Process -PassThru -FilePath $playitPath -NoNewWindow
        Write-Host ""
        Write-Host "playit started. Configure the tunnel via the web console:" -ForegroundColor Green
        Write-Host "  1. Open https://playit.gg/account/tunnels/add"
        Write-Host "  2. Type: HTTPS  (so WebSocket party rooms work)"
        Write-Host "  3. Local port: $Port"
        Write-Host "  4. You get a URL like https://*.playit.gg - share it with friends."
        Write-Host ""
    }
    else {
        Write-Host ""
        Write-Host "Server is listening on 0.0.0.0:$Port. Bring up your own tunnel." -ForegroundColor Green
        Write-Host "For example: ngrok http $Port  or  any other tunnel of choice." -ForegroundColor Yellow
        Write-Host ""
    }

    Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
    Wait-Process -Id $server.Id
} finally {
    if ($tunnelProc -and -not $tunnelProc.HasExited) {
        Write-Host "-> Stopping tunnel ..." -ForegroundColor DarkGray
        Stop-Process -Id $tunnelProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($server -and -not $server.HasExited) {
        Write-Host "-> Stopping server ..." -ForegroundColor DarkGray
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
}
