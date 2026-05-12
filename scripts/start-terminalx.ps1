$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Port = if ($env:TERMINALX_PORT) { $env:TERMINALX_PORT } else { "8787" }
$Url = "http://127.0.0.1:$Port"
$OllamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"

Set-Location $Root

function Test-HttpOk {
  param([string] $TargetUrl)
  try {
    $response = Invoke-WebRequest -Uri $TargetUrl -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Wait-Http {
  param(
    [string] $TargetUrl,
    [int] $TimeoutSeconds = 30
  )
  $started = Get-Date
  while (((Get-Date) - $started).TotalSeconds -lt $TimeoutSeconds) {
    if (Test-HttpOk $TargetUrl) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing TerminalX dependencies..."
  npm.cmd install
}

if ((Test-Path $OllamaExe) -and -not (Get-Process -Name "ollama" -ErrorAction SilentlyContinue)) {
  Write-Host "Starting Ollama..."
  Start-Process -FilePath $OllamaExe -WindowStyle Hidden
}

if (Test-Path $OllamaExe) {
  Wait-Http "http://127.0.0.1:11434/api/tags" 20 | Out-Null
}

if (-not (Test-HttpOk "$Url/api/health")) {
  Write-Host "Starting TerminalX at $Url ..."
  Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev" -WorkingDirectory $Root -WindowStyle Hidden
  if (-not (Wait-Http "$Url/api/health" 40)) {
    Write-Host "TerminalX did not start on $Url."
    Write-Host "Try changing TERMINALX_PORT or run npm.cmd run dev to see logs."
    Read-Host "Press Enter to close"
    exit 1
  }
}

Start-Process "$Url/?v=terminalx-launcher#chat"
Write-Host "TerminalX is running at $Url"
Write-Host "Login: admin@terminalx.local / change-me-now"
