# Public Pool Scaling Guide

This guide covers how to scale Public Pool from a single instance up to 50,000+ concurrent miners.

## Architecture Overview

Public Pool uses a **Leader-Worker** multi-process architecture:

- **Leader**: One process elected via PostgreSQL Advisory Lock. Handles ZMQ/RPC polling, block template generation, and global notifications.
- **Workers**: Additional processes that share the mining load. They receive real-time block notifications via PostgreSQL `LISTEN/NOTIFY` (no polling).
- **PostgreSQL**: Shared database with connection pooling. Leader stores fully-processed block templates so workers can skip redundant Merkle tree computation.
- **Traefik TCP Load Balancer**: Distributes incoming Stratum TCP connections across all pool instances.

**Why multiple instances?** Node.js runs on a single event loop. When handling thousands of concurrent Stratum TCP connections + share validation + merkle tree computation, a single process will hit CPU saturation on one core. Running multiple instances distributes load across physical CPU cores.

---

## Performance Optimizations (v2 Architecture)

The current codebase includes several high-impact optimizations:

| Optimization | Before | After | Impact |
|-------------|--------|-------|--------|
| **Block Notification** | Worker polls `chain_state` every 1000ms | `LISTEN/NOTIFY` real-time | Zero latency, zero DB polling |
| **Template Acquisition** | `waitForBlock()` polls DB every 100ms | `LISTEN/NOTIFY` triggered | Eliminates 40-90 QPS polling storm |
| **Share Statistics** | Synchronous `await` INSERT/UPDATE per share | Memory queue + 5s batch flush | Stratum event loop never blocks |
| **Heartbeat Updates** | Synchronous UPDATE every 60s per client | Memory queue + 30s batch flush | Eliminates per-client DB round-trips |
| **Template Sharing** | Each instance recomputes Merkle tree | Leader stores processed template | Workers skip CPU-heavy computation |
| **Connection Distribution** | Single instance, single core | Traefik TCP load balancer | Scales across all CPU cores |

---

## Quick Reference by Hardware

### 8-core / 16GB RAM (Production baseline)

The `docker-compose-production.yaml` is pre-tuned for this profile.

| Service | Replicas | CPU Limit | Memory Limit | Notes |
|---------|----------|-----------|--------------|-------|
| `postgres` | 1 | 3.0 cores | 4 GB | shared_buffers=4GB, max_connections=150 |
| `public-pool` | **7** | 0.8 core each | 1.5 GB each | 7 instances overcome single-core bottleneck |
| `bitcoind` | 1 | ~1 core | ~2 GB | External bitcoind strongly recommended |
| `traefik` | 1 | ~0.5 core | 256 MB | TCP + HTTP load balancer |

**DB Pool**: `DB_POOL_MAX=50` ÷ `INSTANCE_COUNT=7` = **~7 connections per instance**

**Expected capacity**: ~8,000–12,000 concurrent miners

### 4-core / 8GB RAM (Entry-level)

| Service | Replicas | CPU Limit | Memory Limit | Notes |
|---------|----------|-----------|--------------|-------|
| `postgres` | 1 | 2.0 cores | 3 GB | shared_buffers=2GB, max_connections=100 |
| `public-pool` | 2 | 1.5 cores each | 1.5 GB each | Leader + 1 Worker |
| `bitcoind` | 1 | ~1 core | ~1.5 GB | Run on same host or external |

**DB Pool**: `DB_POOL_MAX=20` ÷ `INSTANCE_COUNT=2` = **10 connections per instance**

**Expected capacity**: ~2,000–3,000 concurrent miners

### 16-core / 32GB RAM (High-performance)

| Service | Replicas | CPU Limit | Memory Limit | Notes |
|---------|----------|-----------|--------------|-------|
| `postgres` | 1 | 4.0 cores | 6 GB | Consider dedicated DB host |
| `public-pool` | 10–12 | 0.8 core each | 1.5 GB each | Maximize core utilization |
| `bitcoind` | 1 | ~2 cores | ~4 GB | External bitcoind mandatory |

**DB Pool**: `DB_POOL_MAX=80`–`120`

**Expected capacity**: ~20,000–30,000 concurrent miners

### 32-core / 64GB+ RAM (Enterprise)

| Service | Replicas | CPU Limit | Memory Limit | Notes |
|---------|----------|-----------|--------------|-------|
| `postgres` | dedicated | — | — | Managed PostgreSQL (RDS, Cloud SQL) |
| `public-pool` | 16–20 | 1.0 core each | 1.5 GB each | Multiple Docker hosts or K8s |
| `bitcoind` | dedicated | — | — | Separate host or hosted node |

**DB Pool**: `DB_POOL_MAX=150`–`200`

**Expected capacity**: ~40,000–60,000+ concurrent miners

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

### 16-core / 32GB Profile

```
max_connections = 200
shared_buffers = 8GB
effective_cache_size = 24GB
work_mem = 64MB
maintenance_work_mem = 2GB
max_worker_processes = 16
max_parallel_workers_per_gather = 8
max_parallel_workers = 16
max_parallel_maintenance_workers = 8
wal_buffers = 64MB
min_wal_size = 4GB
max_wal_size = 16GB
```

---

## Dynamic Connection Pool

The DB connection pool is auto-calculated per instance:

```
pool_max_per_instance = max(5, floor(DB_POOL_MAX / INSTANCE_COUNT))
```

Example:
- `DB_POOL_MAX=50`, `INSTANCE_COUNT=7` → 7 connections per instance
- `DB_POOL_MAX=100`, `INSTANCE_COUNT=10` → 10 connections per instance
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
# Linux/macOS — scale to 10 instances with 100 total DB connections
./scripts/scale.sh 10 100

# Windows PowerShell
.\scripts\scale.ps1 10 100
```

For Docker Compose with Traefik load balancing:

```bash
# Scale public-pool service (Traefik auto-discovers new instances)
docker-compose -f docker-compose-production.yaml up -d --scale public-pool=10

# Verify all instances are registered
docker-compose logs traefik | grep -i "stratum"
```

### 3. Docker Swarm (Production Recommended)

For true high availability and seamless scaling:

```bash
# Initialize swarm
docker swarm init

# Deploy stack
docker stack deploy -c docker-compose-production.yaml public-pool

# Scale service
docker service scale public-pool_public-pool=12
```

---

## Scaling Thresholds

| Miner Count | Hardware | Replicas | DB_POOL_MAX | Notes |
|-------------|----------|----------|-------------|-------|
| < 2,000 | 4c/8G | 2 | 20 | Entry-level, single host |
| 2,000 – 8,000 | 8c/16G | 5–7 | 50 | **Production sweet spot** |
| 8,000 – 15,000 | 16c/32G | 10–12 | 100 | External PG + bitcoind |
| 15,000 – 30,000 | 16c+/32G+ | 12–16 | 120 | Dedicated DB host |
| 30,000 – 50,000 | 32c/64G+ | 16–20 | 150–200 | Multi-host or K8s |
| 50,000+ | Cloud/K8s | 20+ | 200+ | Managed DB, CDN, LB |

---

## Environment Variables for Scaling

| Variable | Default | Description |
|----------|---------|-------------|
| `INSTANCE_COUNT` | 7 | Number of pool instances (used to divide DB pool) |
| `DB_POOL_MAX` | 50 | Total max DB connections across all instances |
| `JOB_CACHE_TTL_MS` | 120000 | Job cache TTL in ms (lower = less memory) |
| `BITCOIN_POLL_MS` | 500 | Leader block polling interval |
| `WORKER_POLL_MS` | 1000 | Legacy worker poll interval (deprecated, now uses LISTEN/NOTIFY) |

---

## Monitoring

### Quick Monitor (Linux/macOS)

```bash
# Auto-refresh every 5 seconds
watch -n 5 ./scripts/monitor.sh
```

### Key Metrics by Hardware

| Metric | 4-core Target | 8-core Target | 16-core Target | 32-core Target |
|--------|---------------|---------------|----------------|----------------|
| CPU Load (loadavg) | < 3.5 | < 7.0 | < 14.0 | < 28.0 |
| Free Memory | > 500MB | > 1GB | > 2GB | > 4GB |
| DB Connections | < 100 | < 150 | < 200 | < 300 |
| Pool Instances | 1–2 | 5–7 | 10–12 | 16–20 |
| Share Queue Size | < 1000 | < 5000 | < 10000 | < 20000 |

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

### Share Queue Backpressure

```bash
# Check if share statistics are backing up (should be near 0)
docker logs public-pool 2>&1 | grep -i "flush\|batch"
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
5. Flushes pending share statistics queue to DB

---

## Troubleshooting

### High Memory Usage

```bash
# 1. Reduce cache TTL (trade memory for DB load)
export JOB_CACHE_TTL_MS=60000

# 2. Reduce replicas if over-provisioned
./scripts/scale.sh 5 50

# 3. Check for leaks: memory should plateau after warm-up
docker stats --no-stream
```

### CPU Saturation on One Core (Single-Core Bottleneck)

**Symptom**: One CPU core at 100%, others idle. High share reject rate.

**Solution**: Increase `INSTANCE_COUNT` so load spreads across more cores:

```bash
# From 2 to 7 instances on 8-core machine
./scripts/scale.sh 7 50
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
psql -U publicpool -d publicpool -c "SELECT pid, granted FROM pg_locks WHERE locktype = 'advisory' AND objid = 4242;"

# Force release (emergency only)
psql -U publicpool -d publicpool -c "SELECT pg_advisory_unlock_all();"
```

### Share Queue Overflow

If miners submit shares faster than the batch flush can write:

```bash
# Check queue size in logs
docker logs public-pool 2>&1 | grep "Batch flush"

# Reduce flush interval (default 5s) — edit ClientStatisticsService
# Or scale up DB: dedicated PostgreSQL host, faster disks (NVMe SSD)
```

---

## Upgrade Path

### 4-core/8GB → 8-core/16GB

1. Update hardware / VM spec
2. Edit `docker-compose-production.yaml`:
   - `postgres.deploy.resources`: 2 CPU → 3 CPU, 3G → 4G
   - `public-pool.deploy.replicas`: 2 → 7
   - `public-pool.deploy.resources.limits.cpus`: 1.5 → 0.8
   - PG `shared_buffers`: 2GB → 4GB
   - PG `max_connections`: 100 → 150
3. Update `.env`:
   - `INSTANCE_COUNT=7`
   - `DB_POOL_MAX=50`
4. `docker-compose up -d`

### 8-core/16GB → 16-core/32GB

1. Consider moving PostgreSQL to a dedicated host or managed service
2. Run `public-pool` on the application server, PG on a separate DB server
3. Scale to 10-12 replicas:
   ```bash
   ./scripts/scale.sh 12 100
   ```
4. Add a TCP load balancer in front of Stratum port if not using Traefik

### 16-core/32GB → 32-core/64GB+ (30,000–50,000 miners)

1. **Dedicated PostgreSQL**: Use managed PostgreSQL (RDS, Cloud SQL, AlloyDB) or a dedicated 8-core/16GB PG host
2. **External bitcoind**: Run bitcoind on a separate host with NVMe SSD
3. **Multiple application hosts**: Run 8-10 pool instances per 8-core host, with a central load balancer
4. **Kubernetes**: Deploy with HPA (Horizontal Pod Autoscaler) based on CPU/memory metrics
5. **CDN**: Use CloudFlare or similar for API and UI static assets

### Cloud-Native (Kubernetes)

- Use a `Deployment` with `replicas: 10`
- Externalize PostgreSQL to managed service
- Use a TCP LoadBalancer for port 3333 (Stratum)
- Use an HTTP Ingress for port 3334 (API)
- Configure `PodDisruptionBudget` to ensure at least 1 leader-capable instance is always running
- Use `HorizontalPodAutoscaler` to auto-scale based on CPU/memory
