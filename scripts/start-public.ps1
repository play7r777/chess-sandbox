# Запуск Chess Sandbox с публичным URL для друзей.
#
# Поднимает FastAPI-сервер на 0.0.0.0:<Port> и параллельно стартует
# выбранный туннель (ngrok или playit.gg), чтобы кенты из других стран
# могли подключаться по полученной ссылке.
#
# Примеры:
#   .\scripts\start-public.ps1                 # ngrok (по умолчанию)
#   .\scripts\start-public.ps1 -Tunnel playit  # playit.gg
#   .\scripts\start-public.ps1 -Tunnel none    # просто 0.0.0.0, тоннель сам
#   .\scripts\start-public.ps1 -Port 9000
#
# ngrok нужно поставить отдельно: https://ngrok.com/download
# playit.gg: https://playit.gg/download

param(
    [ValidateSet("ngrok", "playit", "none")]
    [string]$Tunnel = "ngrok",
    [int]$Port = 8001
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $repoRoot

# Найти Python из .venv, если он есть.
$pythonExe = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $pythonExe)) {
    $pythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $pythonExe) {
        Write-Host "Не нашёл python ни в .venv, ни в PATH." -ForegroundColor Red
        Write-Host "Создай venv: py -3.11 -m venv .venv && .venv\Scripts\activate && pip install -e ." -ForegroundColor Yellow
        exit 1
    }
}

# Привязка к 0.0.0.0, чтобы туннель видел сервер.
$env:CHESS_HOST = "0.0.0.0"
$env:CHESS_PORT = "$Port"

Write-Host "→ Старт сервера на 0.0.0.0:$Port ..." -ForegroundColor Cyan
$server = Start-Process -PassThru -FilePath $pythonExe `
    -ArgumentList "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "$Port" `
    -NoNewWindow

# Подождать пока uvicorn проснётся.
Start-Sleep -Seconds 2

$tunnelProc = $null
$publicUrl = $null
try {
    if ($Tunnel -eq "ngrok") {
        $ngrok = Get-Command ngrok -ErrorAction SilentlyContinue
        if (-not $ngrok) {
            Write-Host "ngrok не найден в PATH. Скачай: https://ngrok.com/download" -ForegroundColor Red
            Write-Host "После установки: ngrok config add-authtoken <твой_токен>" -ForegroundColor Yellow
            throw "ngrok missing"
        }
        Write-Host "→ Старт ngrok ..." -ForegroundColor Cyan
        $tunnelProc = Start-Process -PassThru -FilePath $ngrok.Source `
            -ArgumentList "http", "$Port", "--log=stdout" -NoNewWindow

        # ngrok поднимает локальный API на :4040 — оттуда вытаскиваем URL.
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
                # API ещё не готов — пробуем дальше.
            }
        }
        if ($publicUrl) {
            Write-Host ""
            Write-Host "✓ Публичный URL: $publicUrl" -ForegroundColor Green
            Write-Host "  Скинь кентам — они открывают в браузере и играют."
            Write-Host "  На бесплатном тарифе ngrok может показать одну страницу-предупреждение"
            Write-Host "  с кнопкой 'Visit Site' — это нормально, кликают и играют."
            Write-Host ""
        } else {
            Write-Host "Не смог достучаться до ngrok API (http://127.0.0.1:4040)." -ForegroundColor Yellow
            Write-Host "Открой эту страницу в браузере и скопируй URL вручную." -ForegroundColor Yellow
        }
    }
    elseif ($Tunnel -eq "playit") {
        $playit = Get-Command playit -ErrorAction SilentlyContinue
        if (-not $playit) {
            Write-Host "playit не найден в PATH. Скачай: https://playit.gg/download" -ForegroundColor Red
            throw "playit missing"
        }
        Write-Host "→ Старт playit ..." -ForegroundColor Cyan
        $tunnelProc = Start-Process -PassThru -FilePath $playit.Source -NoNewWindow
        Write-Host ""
        Write-Host "playit запущен. Дальше через веб-интерфейс:" -ForegroundColor Green
        Write-Host "  1. Открой https://playit.gg/account/tunnels/add"
        Write-Host "  2. Выбери тип 'HTTPS' (для веба + WebSocket)"
        Write-Host "  3. Local port: $Port"
        Write-Host "  4. Получишь URL вида https://*.playit.gg — скинь его кентам."
        Write-Host ""
    }
    else {
        Write-Host ""
        Write-Host "Сервер слушает 0.0.0.0:$Port. Туннель подними сам." -ForegroundColor Green
        Write-Host "Например: ngrok http $Port  или  playit-cli." -ForegroundColor Yellow
        Write-Host ""
    }

    Write-Host "Ctrl+C чтобы остановить." -ForegroundColor DarkGray
    Wait-Process -Id $server.Id
} finally {
    if ($tunnelProc -and -not $tunnelProc.HasExited) {
        Write-Host "→ Останавливаю туннель ..." -ForegroundColor DarkGray
        Stop-Process -Id $tunnelProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($server -and -not $server.HasExited) {
        Write-Host "→ Останавливаю сервер ..." -ForegroundColor DarkGray
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
}
