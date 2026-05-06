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
        $ngrok = Get-Command ngrok -ErrorAction SilentlyContinue
        if (-not $ngrok) {
            Write-Host "ngrok not found in PATH. Install: https://ngrok.com/download" -ForegroundColor Red
            Write-Host "After install: ngrok config add-authtoken <YOUR_TOKEN>" -ForegroundColor Yellow
            throw "ngrok missing"
        }
        Write-Host "-> Starting ngrok ..." -ForegroundColor Cyan
        $tunnelProc = Start-Process -PassThru -FilePath $ngrok.Source `
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
            Write-Host ""
            Write-Host "OK  Public URL: $publicUrl" -ForegroundColor Green
            Write-Host "    Send it to your friends - they open it in a browser and play."
            Write-Host "    On the ngrok free plan first-time visitors see a 'Visit Site'"
            Write-Host "    warning page; one click and they're in."
            Write-Host ""
        } else {
            Write-Host "Could not reach the ngrok API (http://127.0.0.1:4040)." -ForegroundColor Yellow
            Write-Host "Open that page in a browser and copy the URL manually." -ForegroundColor Yellow
        }
    }
    elseif ($Tunnel -eq "playit") {
        $playit = Get-Command playit -ErrorAction SilentlyContinue
        if (-not $playit) {
            Write-Host "playit not found in PATH. Install: https://playit.gg/download" -ForegroundColor Red
            throw "playit missing"
        }
        Write-Host "-> Starting playit ..." -ForegroundColor Cyan
        $tunnelProc = Start-Process -PassThru -FilePath $playit.Source -NoNewWindow
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
