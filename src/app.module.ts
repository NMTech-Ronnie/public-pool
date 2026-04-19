import { HttpModule } from '@nestjs/axios';
import { CacheModule } from '@nestjs/cache-manager';
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AppController } from './app.controller';
import { AddressController } from './controllers/address/address.controller';
import { ClientController } from './controllers/client/client.controller';
import { BitcoinAddressValidator } from './models/validators/bitcoin-address.validator';
import { AddressSettingsModule } from './ORM/address-settings/address-settings.module';
import { BlocksModule } from './ORM/blocks/blocks.module';
import { ClientStatisticsModule } from './ORM/client-statistics/client-statistics.module';
import { ClientModule } from './ORM/client/client.module';
import { RpcBlocksModule } from './ORM/rpc-block/rpc-block.module';
import { TelegramSubscriptionsModule } from './ORM/telegram-subscriptions/telegram-subscriptions.module';
import { AppService } from './services/app.service';
import { BitcoinRpcService } from './services/bitcoin-rpc.service';
import { BraiinsService } from './services/braiins.service';
import { BTCPayService } from './services/btc-pay.service';
import { DiscordService } from './services/discord.service';
import { NotificationService } from './services/notification.service';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { StratumV1Service } from './services/stratum-v1.service';
import { TelegramService } from './services/telegram.service';
import { ExternalSharesService } from './services/external-shares.service';
import { ExternalShareController } from './controllers/external-share/external-share.controller';
import { ExternalSharesModule } from './ORM/external-shares/external-shares.module';

const ORMModules = [
  ClientStatisticsModule,
  ClientModule,
  AddressSettingsModule,
  TelegramSubscriptionsModule,
  BlocksModule,
  RpcBlocksModule,
  ExternalSharesModule,
];

@Module({
  imports: [
    ConfigModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: './DB/public-pool.sqlite',
      synchronize: true,
      autoLoadEntities: true,
      logging: false,
      enableWAL: true,
      // busyTimeout in TypeORM config is unreliable for sqlite3 driver.
      // PRAGMAs are set explicitly via afterConnect subscriber below.
    } as any),
    CacheModule.register(),
    ScheduleModule.forRoot(),
    HttpModule,
    ...ORMModules,
  ],
  controllers: [
    AppController,
    ClientController,
    AddressController,
    ExternalShareController,
  ],
  providers: [
    DiscordService,
    AppService,
    StratumV1Service,
    TelegramService,
    BitcoinRpcService,
    NotificationService,
    BitcoinAddressValidator,
    StratumV1JobsService,
    BTCPayService,
    BraiinsService,
    ExternalSharesService,
  ],
})
export class AppModule implements OnModuleInit {
  constructor(private dataSource: DataSource) {}

  async onModuleInit() {
    // TypeORM's busyTimeout config is unreliable for the sqlite3 driver.
    // Set critical PRAGMAs explicitly on the raw connection.
    const runner = this.dataSource.createQueryRunner();
    try {
      // busy_timeout: wait up to 15s for the write lock instead of failing immediately.
      // This is essential with 4 cluster workers sharing one SQLite file.
      await runner.query('PRAGMA busy_timeout = 15000');
      // synchronous=NORMAL is safe for WAL mode and dramatically reduces
      // lock hold time (no fsync on every commit, only on checkpoint).
      // Default is FULL which fsyncs every commit — huge contention multiplier.
      await runner.query('PRAGMA synchronous = NORMAL');

      // Verify
      const bt = await runner.query('PRAGMA busy_timeout');
      const sync = await runner.query('PRAGMA synchronous');
      console.log(`[SQLite] busy_timeout=${bt[0]?.timeout}, synchronous=${sync[0]?.synchronous} (1=NORMAL)`);
    } finally {
      await runner.release();
    }
  }
}
