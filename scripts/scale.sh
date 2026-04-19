#!/bin/bash
# Dynamic scaling script for Public Pool
# Usage: ./scale.sh [replicas] [db_pool_max]
# Example: ./scale.sh 5 50   (8-core/16GB production)
# Example: ./scale.sh 2 20   (4-core/8GB entry-level)
# Example: ./scale.sh 8 80   (16-core/32GB high-performance)

set -e

REPLICAS=${1:-5}
DB_POOL_MAX=${2:-50}
INSTANCE_COUNT=$REPLICAS

# Calculate per-instance DB pool size
POOL_PER_INSTANCE=$((DB_POOL_MAX / INSTANCE_COUNT))
if [ "$POOL_PER_INSTANCE" -lt 5 ]; then
    echo "WARNING: Only $POOL_PER_INSTANCE connections per instance. Minimum recommended is 5."
    echo "Consider increasing DB_POOL_MAX or reducing replicas."
    POOL_PER_INSTANCE=5
fi

echo "========================================"
echo "  Public Pool Dynamic Scaling"
echo "========================================"
echo "Target replicas:     $REPLICAS"
echo "Total DB connections: $DB_POOL_MAX"
echo "Per-instance pool:    $POOL_PER_INSTANCE"
echo ""

# Export for docker-compose
export INSTANCE_COUNT
export DB_POOL_MAX

# For Docker Compose (standalone)
if command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
# For Docker Compose V2 (plugin)
elif docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
else
    echo "Error: docker-compose not found"
    exit 1
fi

echo "Scaling public-pool service..."
$COMPOSE_CMD -f docker-compose-production.yaml up -d --scale public-pool=$REPLICAS

echo ""
echo "Current container status:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep public-pool || true

echo ""
echo "Scaled to $REPLICAS replicas successfully."
