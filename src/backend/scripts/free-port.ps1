param(
  [int]$Port = 3000
)

$connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1

if ($null -eq $connection) {
  Write-Host "Port $Port is already free."
  exit 0
}

$process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue

if ($null -eq $process) {
  throw "Found a listener on port $Port (PID $($connection.OwningProcess)), but the process could not be resolved."
}

$safeProcessNames = @('node', 'npm', 'pnpm', 'bun', 'deno')
$processName = $process.ProcessName.ToLowerInvariant()

if ($safeProcessNames -notcontains $processName) {
  throw "Refusing to stop process '$($process.ProcessName)' (PID $($process.Id)) on port $Port."
}

Write-Host "Stopping $($process.ProcessName) (PID $($process.Id)) using port $Port..."
Stop-Process -Id $process.Id -Force

Start-Sleep -Milliseconds 300

$stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $stillListening) {
  throw "Port $Port is still in use after stopping PID $($process.Id)."
}

Write-Host "Port $Port has been released."
