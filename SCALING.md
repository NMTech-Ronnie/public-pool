# Public Pool Scaling Guide

This guide covers how to scale Public Pool from a single instance up to multi-core deployments.

## Architecture Overview

Public Pool uses a **Leader-Worker** multi-process architecture:

- **Leader**: One process elected via PostgreSQL Advisory Lock. Handles ZMQ/RPC polling, block template generation, and global notifications.
- **Workers**: Additional processes that share the mining load. They read block height from the `chain_state` table.
- **PostgreSQL**: Shared database with connection pooling.

**Why multiple instances?** Node.js runs on a single event loop. When handling thousands of concurrent Stratum TCP connections + share validation + merkle tree computation, a single process will hit CPU saturation on one core. Running multiple instances distributes load across physical CPU cores.

---

## Quick Reference by Hardware

### 8-core / 16GB RAM (Recommended for production)

The `docker-compose-production.yaml` is pre-tuned for this profile.

| Service | Replicas | CPU Limit | Memory Limit | Notes |
|---------|----------|-----------|--------------|-------|
| `postgres` | 1 | 3.0 cores | 4 GB | shared_buffers=4GB, max_connections=150 |
| `public-pool` | 5 | 1.0 core each | 1.5 GB each | 5 instances overcome single-core bottleneck |
| `bitcoind` | 1 | ~1 core | ~2 GB | External bitcoind recommended for large pools |

**DB Pool**: `DB_POOL_MAX=50` ÷ `INSTANCE_COUNT=5` = **10 connections per instance**

**Expected capacity**: ~5,000–8,000 concurrent miners

### 4-core / 8GB RAM (Entry-level)

| Service | Replicas | CPU Limit | Memory Limit | Notes |
|---------|----------|-----------|--------------|-------|
| `postgres` | 1 | 2.0 cores | 3 GB | shared_buffers=2GB, max_connections=100 |
| `public-pool` | 2 | 1.5 cores each | 1.5 GB each | Leader + 1 Worker |
| `bitcoind` | 1 | ~1 core | ~1.5 GB | Run on same host or external |

**DB Pool**: `DB_POOL_MAX=20` ÷ `INSTANCE_COUNT=2` = **10 connections per instance**

**Expected capacity**: ~1,500–2,000 concurrent miners

### 16-core / 32GB+ RAM (High-performance)

| Service | Replicas | CPU Limit | Memory Limit | Notes |
|---------|----------|-----------|--------------|-------|
| `postgres` | 1 | 4.0 cores | 6 GB | Consider dedicated DB host |
| `public-pool` | 8–10 | 1.0 core each | 1.5 GB each | Maximize core utilization |
| `bitcoind` | 1 | ~2 cores | ~4 GB | External bitcoind strongly recommended |

**DB Pool**: `DB_POOL_MAX=80`–`100`

**Expected capacity**: ~15,000+ concurrent miners

---

## PostgreSQL Tuning

### 8-core / 16GB Profile (docker-compose-production.yaml defaults)

```
max_connections = 150
shared_buffers = 4GB
effective_cache_size = 12GB
work_mem = 40MB
maintenance_work_mem = 1GB
max_worker_processes = 8
max_parallel_workers_per_gather = 4
max_parallel_workers = 8
max_parallel_maintenance_workers = 4
wal_buffers = 32MB
min_wal_size = 2GB
max_wal_size = 8GB
```

### 4-core / 8GB Profile

```
max_connections = 100
shared_buffers = 2GB
effective_cache_size = 6GB
work_mem = 20MB
maintenance_work_mem = 512MB
max_worker_processes = 4
max_parallel_workers_per_gather = 2
max_parallel_workers = 4
max_parallel_maintenance_workers = 2
wal_buffers = 16MB
min_wal_size = 1GB
max_wal_size = 4GB
```

---

## Dynamic Connection Pool

The DB connection pool is auto-calculated per instance:

```
pool_max_per_instance = max(5, floor(DB_POOL_MAX / INSTANCE_COUNT))
```

Example:
- `DB_POOL_MAX=50`, `INSTANCE_COUNT=5` → 10 connections per instance
- `DB_POOL_MAX=80`, `INSTANCE_COUNT=8` → 10 connections per instance
- `DB_POOL_MAX=20`, `INSTANCE_COUNT=2` → 10 connections per instance

**Rule of thumb**: Never go below 5 connections per instance or the pool will starve under burst load.

---

## Scaling Strategies

### 1. Vertical Scaling (More Power per Instance)

Increase resources per instance without adding replicas:

```bash
# Increase memory limit in docker-compose-production.yaml
# public-pool deploy.resources.limits.memory: 1.5G -> 3G

# Increase DB pool
docker-compose -f docker-compose-production.yaml up -d \
  -e DB_POOL_MAX=60 \
  -e JOB_CACHE_TTL_MS=180000
```

### 2. Horizontal Scaling (More Instances)

Add more pool instances to distribute miner connections across CPU cores:

```bash
# Linux/macOS — scale to 8 instances with 80 total DB connections
./scripts/scale.sh 8 80

# Windows PowerShell
.\scripts\scale.ps1 8 80
```

### 3. Manual Docker Compose Scaling

```bash
# Scale to 6 instances
docker-compose -f docker-compose-production.yaml up -d --scale public-pool=6

# With custom env
docker-compose -f docker-compose-production.yaml up -d \
  --scale public-pool=6 \
  -e INSTANCE_COUNT=6 \
  -e DB_POOL_MAX=60
```

---

## Scaling Thresholds

| Miner Count | Hardware | Replicas | DB_POOL_MAX | Notes |
|-------------|----------|----------|-------------|-------|
| < 500 | 4c/8G | 1 | 20 | Single instance, no scaling needed |
| 500 – 2,000 | 4c/8G | 2 | 20 | Balanced for entry-level hardware |
| 2,000 – 5,000 | 8c/16G | 5 | 50 | **Production sweet spot** |
| 5,000 – 8,000 | 8c/16G | 5-6 | 50-60 | Monitor CPU loadavg < 7.0 |
| 8,000 – 15,000 | 16c/32G | 8-10 | 80-100 | External bitcoind recommended |
| 15,000+ | 16c+/32G+ | 10+ | 100+ | Dedicated PG host, load balancer |

---

## Environment Variables for Scaling

| Variable | Default | Description |
|----------|---------|-------------|
| `INSTANCE_COUNT` | 5 | Number of pool instances (used to divide DB pool) |
| `DB_POOL_MAX` | 50 | Total max DB connections across all instances |
| `JOB_CACHE_TTL_MS` | 120000 | Job cache TTL in ms (lower = less memory) |
| `BITCOIN_POLL_MS` | 500 | Leader block polling interval |
| `WORKER_POLL_MS` | 1000 | Worker chain_state polling interval |

---

## Monitoring

### Quick Monitor (Linux/macOS)

```bash
# Auto-refresh every 5 seconds
watch -n 5 ./scripts/monitor.sh
```

### Key Metrics by Hardware

| Metric | 4-core Target | 8-core Target | 16-core Target |
|--------|---------------|---------------|----------------|
| CPU Load (loadavg) | < 3.5 | < 7.0 | < 14.0 |
| Free Memory | > 500MB | > 1GB | > 2GB |
| DB Connections | < 100 | < 150 | < 200 |
| Pool Instances | 1-2 | 4-6 | 8-10 |

### Docker Stats

```bash
# Watch all containers in real-time
docker stats

# One-shot snapshot
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}"
```

### Per-Instance Leader Detection

```bash
# Check which container is the current leader
docker logs public-pool 2>&1 | grep -i "leader\|advisory"
```

---

## Graceful Shutdown

All pool instances support graceful shutdown:

```bash
# Graceful — waits up to 30s for connections to close
# Leader releases advisory lock, another instance takes over
 docker-compose -f docker-compose-production.yaml stop -t 30 public-pool

# Force — immediate termination (may lose shares in flight)
docker-compose -f docker-compose-production.yaml kill public-pool
```

On shutdown each instance:
1. Stops accepting new Stratum connections
2. Closes existing socket connections
3. Leader releases PostgreSQL advisory lock
4. Closes all DB pool connections

---

## Troubleshooting

### High Memory Usage

```bash
# 1. Reduce cache TTL (trade memory for DB load)
export JOB_CACHE_TTL_MS=60000

# 2. Reduce replicas if over-provisioned
./scripts/scale.sh 3 30

# 3. Check for leaks: memory should plateau after warm-up
docker stats --no-stream
```

### CPU Saturation on One Core (Single-Core Bottleneck)

**Symptom**: One CPU core at 100%, others idle. High share reject rate.

**Solution**: Increase `INSTANCE_COUNT` so load spreads across more cores:

```bash
# From 2 to 5 instances on 8-core machine
./scripts/scale.sh 5 50
```

Verify distribution:
```bash
docker stats --no-stream | grep public-pool
```

### DB Connection Exhaustion

```bash
# Check active connections
psql -U publicpool -d publicpool -c "SELECT count(*) FROM pg_stat_activity;"

# Check idle connections
psql -U publicpool -d publicpool -c "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;"

# Remedies:
# 1. Increase PG max_connections in docker-compose command args
# 2. Increase DB_POOL_MAX
# 3. Lower pool idle timeout (add to TypeORM extra: { idleTimeoutMillis: 10000 })
```

### Leader Election Issues

```bash
# Verify advisory lock is held
psql -U publicpool -d publicpool -c "SELECT pid, granted FROM pg_locks WHERE locktype = 'advisory' AND objid = 42;"

# Force release (emergency only)
psql -U publicpool -d publicpool -c "SELECT pg_advisory_unlock_all();"
```

---

## Upgrade Path

### 4-core/8GB → 8-core/16GB

1. Update hardware / VM spec
2. Edit `docker-compose-production.yaml`:
   - `postgres.deploy.resources`: 2 CPU → 3 CPU, 3G → 4G
   - `public-pool.deploy.replicas`: 2 → 5
   - `public-pool.deploy.resources.limits.cpus`: 1.5 → 1.0
   - PG `shared_buffers`: 2GB → 4GB
   - PG `max_connections`: 100 → 150
3. Update `.env`:
   - `INSTANCE_COUNT=5`
   - `DB_POOL_MAX=50`
4. `docker-compose up -d`

### 8-core/16GB → 16-core/32GB+

1. Consider moving PostgreSQL to a dedicated host or managed service
2. Run `public-pool` on the application server, PG on a separate DB server
3. Scale to 8-10 replicas:
   ```bash
   ./scripts/scale.sh 10 100
   ```
4. Add a TCP load balancer in front of Stratum port (3333) if Docker overlay network isn't sufficient

### Cloud-Native (Kubernetes / ECS)

- Use a `StatefulSet` or `Deployment` with `replicas: 5`
- Externalize PostgreSQL to RDS / Cloud SQL / AlloyDB
- Use a TCP LoadBalancer for port 3333 (Stratum)
- Use an HTTP LoadBalancer for port 3334 (API)
- Configure `PodDisruptionBudget` to ensure at least 1 leader-capable instance is always running
