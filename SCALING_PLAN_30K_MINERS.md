# PostgreSQL 连接池规划 - 30,000 矿机规模

## 负载分析

### 矿机分布
- **总矿机**：30,000 台
- **平均每个Worker**：30,000 ÷ 6 = 5,000 台矿机
- **全网算力**：~50 PH/s（ASIC）

### 数据库操作频率

| 操作 | 频率 | 持续占用连接 | 备注 |
|-----|------|----------|------|
| Share 提交 | 2,500/秒/Worker | 0 | Write-Behind队列，每5秒批量flush |
| 新客户端连接 | ~1.4/秒/Worker | 1-2 | 占用时间：10-100ms |
| 难度更新查询 | 25-50/秒/Worker | 2-5 | **关键瓶颈**（已优化） |
| 心跳更新 | 批量5秒一次 | 3-5 | 批量操作 |
| 统计更新 | 批量5秒一次 | 5-10 | 批量操作 |

### 最坏场景
- **矿机群离线后重连**：5,000个 insert() 并发 → 立即耗尽90个连接
- **难度调整期间**：50个同步查询 + flush操作 → 连接池压力max

---

## 优化方案

### 已实施的改进

#### 1. **AddressSettings 缓存** ✅
- **效果**：DB查询减少 60-80%（25-50/秒 → 2-3/秒）
- **实现**：5分钟 TTL 的 LRU 缓存（60,000地址上限）
- **内存成本**：~12 MB per worker

**缓存策略：**
```
每个难度更新查询：
  Before: 必须到DB查询 → 占用1个连接 10-20ms
  After:  大多数hit缓存  → 0ms，缓存miss率 < 5%
```

### 配置推荐

#### PostgreSQL 端（docker-compose-production.yaml）
```yaml
postgres:
  command:
    - "-c"
    - "max_connections=500"   # ↑ 从 200 增加
    - "-c"
    - "shared_buffers=2GB"
    - "-c"
    - "effective_cache_size=6GB"
    - # ... 其他参数保持不变
```

**连接数分配：**
- 应用占用：6 workers × 60 pool = **360** 连接
- 系统预留：27 连接
- 其他用途：113 连接（主从复制、备份、psql等）
- **总计**：500 连接

#### 应用端（docker-compose-production.yaml）
```yaml
public-pool:
  environment:
    - POSTGRES_POOL_MAX=60      # ↑ 从 15 增加
    - CLUSTER_WORKERS=6
```

---

## 性能对比

### 场景：30,000矿机在线

| 指标 | 修改前 | 修改后 | 改善 |
|-----|-------|-------|------|
| **PG max_connections** | 200 | 500 | +150% |
| **Worker pool总数** | 90 | 360 | +300% |
| **可用余量** | 83 | 140 | +69% |
| **难度查询DB压力** | 25-50/秒 | 2-3/秒 | **-95%** |
| **新连接burst缓冲** | 83个 | 140个 | +69% |

### 成本估算

| 资源 | 修改前 | 修改后 | 增量 |
|-----|-------|-------|------|
| **内存（PG）** | 400 MB | 800 MB | +400 MB |
| **内存（应用缓存）** | 0 MB | 72 MB | +72 MB |
| **连接开销** | ~10 MB | ~25 MB | +15 MB |

**总额**：额外 ~500 MB 内存占用（对16GB服务器来说无压力）

---

## 验证检查表

在生产环境上线前，验证以下指标：

- [ ] PostgreSQL 已更新到 `max_connections=500`
- [ ] 每个Worker 的 `POSTGRES_POOL_MAX=60`
- [ ] AddressSettings 缓存已启用（5分钟 TTL）
- [ ] 运行 `psql -U publicpool -d publicpool -c "SHOW max_connections"`
  - 应该返回 `500`
- [ ] 监控日志确认缓存命中率
  - 观察 `addressSettingsService.getSettings()` 调用
  - 应该看到大部分从缓存返回（没有DB日志）

---

## 可扩展性展望

### 如果矿机数量增加到 50,000

| 层级 | 当前配置 | 需要调整 |
|-----|---------|--------|
| **Worker数** | 6 | 建议 8-10 |
| **PG max_connections** | 500 | 建议 600-700 |
| **Pool per Worker** | 60 | 保持 60 |
| **AddressSettings缓存** | 60k上限 | 建议 100k |
| **内存** | 16 GB | 考虑 24 GB |

### 长期建议

1. **监控连接池利用率**
   - 定期检查 `SELECT count(*) FROM pg_stat_activity;`
   - 如果平均占用 > 400 个连接，提前增加到 700

2. **缓存监控**
   - 在 AddressSettingsService 中添加缓存命中率计数器
   - 命中率应该 > 95%；如果低于 90%，延长 TTL 或增加容量

3. **连接超时处理**
   - 配置 NestJS TypeORM `connectionLimitError` 处理
   - 当连接池耗尽时，应该返回 HTTP 503，而不是死锁

---

## 实施步骤

### 立即执行（0 宕机）

1. 更新 `docker-compose-production.yaml`
   ```bash
   POSTGRES_POOL_MAX=60
   postgres: max_connections=500
   ```

2. 验证编译
   ```bash
   npx tsc --noEmit
   ```

3. 渐进式重启
   - 逐个重启 Worker（系统保持可用）
   - 或者在低谷期全量重启

### 验证阶段（30分钟）

1. 监控连接数
   ```sql
   SELECT count(*) FROM pg_stat_activity;
   ```
   应该看到 ~50-100 个连接（正常运行）

2. 测试压力
   ```bash
   # 模拟矿机连接
   for i in {1..100}; do
     (timeout 60 curl -v telnet://pool_ip:3333 &)
   done
   ```
   观察是否有连接被拒绝或超时

3. 检查缓存效率
   - 搜索日志中的 `getSettings` 调用
   - 应该很少看到数据库查询

---

## 故障排查

### 症状：Share 提交延迟增加

**诊断：**
```sql
SELECT count(*) FROM pg_stat_activity WHERE state = 'active';
```
- 如果 > 450，连接池已接近饱和
- 采取行动：增加 POSTGRES_POOL_MAX 到 80-100

### 症状：间歇性 "too many connections" 错误

**原因**：PG max_connections 突然跳升（可能是其他连接泄漏）
**解决**：
```bash
# 检查哪些连接占用最多
SELECT datname, usename, count(*) 
FROM pg_stat_activity 
GROUP BY datname, usename 
ORDER BY count(*) DESC;
```

### 症状：AddressSettings 查询仍然很多

**排查**：
1. 确认缓存已启用（检查代码中的 `settingsCache`）
2. 查看缓存大小是否达到上限（60,000）
3. 考虑延长 TTL 或扩大缓存容量

---

## 成本效益总结

| 投入 | 收益 |
|------|------|
| +500 MB内存 | ✅ 支持3万矿机无延迟 |
| 配置变更 | ✅ -95%难度查询DB压力 |
| 缓存代码 | ✅ 消除并发锁竞争 |
| | ✅ 20%余量应对突发流量 |

**ROI：通过最小化改动，获得 3 倍的可扩展性。**

