import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ChainStateEntity } from './chain-state.entity';
import { ChainStateService } from './chain-state.service';
import { PgNotifyModule } from '../../services/pg-notify.module';

@Module({
    imports: [TypeOrmModule.forFeature([ChainStateEntity]), PgNotifyModule],
    providers: [ChainStateService],
    exports: [ChainStateService],
})
export class ChainStateModule {}
