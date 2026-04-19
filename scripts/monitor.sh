#!/bin/bash
# Resource monitoring script for Public Pool on 4-core/8GB servers
# Run with: watch -n 5 ./scripts/monitor.sh

echo "=== Public Pool Resource Monitor ==="
echo "Timestamp: $(date)"
echo ""

# Docker stats (if running in Docker)
if command -v docker &> /dev/null; then
    echo "--- Docker Container Stats ---"
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.PIDs}}" 2>/dev/null || echo "No containers running"
    echo ""
fi

# PostgreSQL connection count
echo "--- PostgreSQL Connections ---"
if command -v psql &> /dev/null; then
    psql -U publicpool -d publicpool -c "SELECT count(*) as active_connections FROM pg_stat_activity;" 2>/dev/null || echo "psql not available or connection failed"
else
    echo "psql not installed"
fi
echo ""

# System resources
echo "--- System Resources ---"
echo "CPU Load: $(cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}')"
echo "Memory:"
free -h 2>/dev/null || echo "free command not available"
echo ""

# Process count
echo "--- Node Processes ---"
ps aux 2>/dev/null | grep -c "node" || echo "0"
echo ""

echo "=== End Monitor ==="
