import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';

@Injectable()
export class AppService implements OnModuleInit {
  constructor(
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly clientService: ClientService,
    private readonly dataSource: DataSource,
    private readonly rpcBlockService: RpcBlockService,
  ) {}

  async onModuleInit() {
    // if (process.env.NODE_APP_INSTANCE == '0') {
    //     await this.dataSource.query(`VACUUM;`);
    // }

    //https://phiresky.github.io/blog/2020/sqlite-performance-tuning/
    // //500 MB DB cache
    // await this.dataSource.query(`PRAGMA cache_size = -500000;`);
    //Normal is still completely corruption safe in WAL mode, and means only WAL checkpoints have to wait for FSYNC.
    await this.dataSource.query(`PRAGMA synchronous = off;`);

    // Scale cache and mmap by worker count to stay within container memory limit.
    // With 4 workers inside an 8GB container:
    //   cache_size: 200MB × 4 = 800MB total
    //   mmap_size:  1024MB × 4 = 4GB total (leaves ~3.2 GB for heap overhead)
    const workers = parseInt(process.env.CLUSTER_WORKERS || '1') || 1;
    const cacheMB = Math.max(50, Math.floor(800 / workers)); // per-worker share of 800MB total
    const mmapMB = Math.max(128, Math.floor(4096 / workers)); // per-worker share of 4GB total
    await this.dataSource.query(`PRAGMA cache_size = -${cacheMB * 1000};`);
    await this.dataSource.query(`PRAGMA mmap_size = ${mmapMB * 1024 * 1024};`);

    // Store temp tables in memory
    await this.dataSource.query(`PRAGMA temp_store = MEMORY;`);
    // //6Gb
    // await this.dataSource.query(`PRAGMA mmap_size = 6000000000;`);

    if (
      process.env.NODE_APP_INSTANCE == null ||
      process.env.NODE_APP_INSTANCE == '0'
    ) {
      setInterval(async () => {
        try {
          await this.deleteOldStatistics();
        } catch (e: any) {
          console.error('deleteOldStatistics error:', e?.message);
        }
      }, 1000 * 60 * 60);

      setInterval(async () => {
        console.log('Killing dead clients');
        try {
          await this.clientService.killDeadClients();
        } catch (e: any) {
          console.error('killDeadClients error:', e?.message);
        }
      }, 1000 * 60 * 5);

      setInterval(async () => {
        console.log('Deleting Old Blocks');
        try {
          await this.rpcBlockService.deleteOldBlocks();
        } catch (e: any) {
          console.error('deleteOldBlocks error:', e?.message);
        }
      }, 1000 * 60 * 60 * 24);
    }
  }

  private async deleteOldStatistics() {
    console.log('Deleting statistics');

    const deletedStatistics =
      await this.clientStatisticsService.deleteOldStatistics();
    console.log(`Deleted ${deletedStatistics.affected} old statistics`);
    const deletedClients = await this.clientService.deleteOldClients();
    console.log(`Deleted ${deletedClients.affected} old clients`);
  }
}
