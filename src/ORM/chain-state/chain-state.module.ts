import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ChainStateEntity } from './chain-state.entity';
import { ChainStateService } from './chain-state.service';

@Module({
    imports: [TypeOrmModule.forFeature([ChainStateEntity])],
    providers: [ChainStateService],
    exports: [ChainStateService],
})
export class ChainStateModule {}
