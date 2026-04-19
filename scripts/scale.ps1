# Dynamic scaling script for Public Pool (Windows PowerShell)
# Usage: .\scale.ps1 [replicas] [db_pool_max]
# Example: .\scale.ps1 5 50   (8-core/16GB production)
# Example: .\scale.ps1 2 20   (4-core/8GB entry-level)
# Example: .\scale.ps1 8 80   (16-core/32GB high-performance)

param(
    [int]$Replicas = 5,
    [int]$DbPoolMax = 50
)

$InstanceCount = $Replicas
$PoolPerInstance = [math]::Max(5, [math]::Floor($DbPoolMax / $InstanceCount))

if ($PoolPerInstance -lt 5) {
    Write-Warning "Only $PoolPerInstance connections per instance. Minimum recommended is 5."
    Write-Warning "Consider increasing DB_POOL_MAX or reducing replicas."
    $PoolPerInstance = 5
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Public Pool Dynamic Scaling" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Target replicas:      $Replicas"
Write-Host "Total DB connections: $DbPoolMax"
Write-Host "Per-instance pool:    $PoolPerInstance"
Write-Host ""

$env:INSTANCE_COUNT = $InstanceCount
$env:DB_POOL_MAX = $DbPoolMax

# Detect docker compose command
$composeCmd = $null
if (Get-Command "docker-compose" -ErrorAction SilentlyContinue) {
    $composeCmd = "docker-compose"
} elseif (docker compose version 2>$null) {
    $composeCmd = "docker compose"
} else {
    Write-Error "Error: docker-compose not found"
    exit 1
}

Write-Host "Scaling public-pool service..."
& $composeCmd -f docker-compose-production.yaml up -d --scale public-pool=$Replicas

Write-Host ""
Write-Host "Current container status:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | Select-String "public-pool"

Write-Host ""
Write-Host "Scaled to $Replicas replicas successfully." -ForegroundColor Green
