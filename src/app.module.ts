import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

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
import { JobIdService } from './services/job-id.service';
import { LeaderElectionService } from './services/leader-election.service';
import { NotificationService } from './services/notification.service';
import { StratumV1JobsService } from './services/stratum-v1-jobs.service';
import { StratumV1Service } from './services/stratum-v1.service';
import { TelegramService } from './services/telegram.service';
import { ExternalSharesService } from './services/external-shares.service';
import { ChainStateModule } from './ORM/chain-state/chain-state.module';
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
    ChainStateModule,
]

@Module({
    imports: [
        ConfigModule.forRoot(),
        TypeOrmModule.forRoot({
            type: 'postgres',
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT, 10) || 5432,
            username: process.env.DB_USER || 'publicpool',
            password: process.env.DB_PASSWORD || 'publicpool',
            database: process.env.DB_NAME || 'publicpool',
            synchronize: true,
            autoLoadEntities: true,
            logging: false,
            extra: {
                // Dynamically calculate pool size based on instance count.
                // Default total pool max is 50; divide among processes.
                max: Math.max(5, Math.floor(parseInt(process.env.DB_POOL_MAX || '50') / Math.max(1, parseInt(process.env.INSTANCE_COUNT || '1')))),
            },
        }),
        ScheduleModule.forRoot(),
        HttpModule,
        ...ORMModules
    ],
    controllers: [
        AppController,
        ClientController,
        AddressController,
        ExternalShareController
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
        LeaderElectionService,
        JobIdService,
    ],
})
export class AppModule {
    constructor() {

    }
}
