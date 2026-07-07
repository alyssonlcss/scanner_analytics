param(
  [string]$EdgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  [int]$Port = 9222
)

try {
  $debugInfo = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
  if ($debugInfo.StatusCode -eq 200) {
    Write-Host "Edge remote debugging is already available on port $Port."
    exit 0
  }
} catch {
}

$edgeProcesses = Get-Process -Name msedge -ErrorAction SilentlyContinue
if ($edgeProcesses) {
  Write-Host "Closing existing Edge processes so remote debugging can be enabled on port $Port..."
  $edgeProcesses | Stop-Process -Force
  Start-Sleep -Seconds 1
}

if (-not (Test-Path $EdgePath)) {
  throw "Edge executable not found at: $EdgePath"
}

if (Test-Path "../.env") {
  $envContent = Get-Content "../.env"
} elseif (Test-Path ".env") {
  $envContent = Get-Content ".env"
} else {
  $envContent = @()
}

$runBackground = $false

foreach ($line in $envContent) {
  if ($line -match "^SPOTFIRE_BACKGROUND=(.*)$") {
    if ($matches[1] -eq "true") { $runBackground = $true }
  }
}

Write-Host "Starting Edge with remote debugging on port $Port..."
Start-Process $EdgePath "--remote-debugging-port=$Port"
Write-Host "Edge started. You can now run 'npm run dev'."