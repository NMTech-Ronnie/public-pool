import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RpcBlockEntity } from './rpc-block.entity';
import { RpcBlockService } from './rpc-block.service';
import { PgNotifyModule } from '../../services/pg-notify.module';


@Global()
@Module({
    imports: [TypeOrmModule.forFeature([RpcBlockEntity]), PgNotifyModule],
    providers: [RpcBlockService],
    exports: [TypeOrmModule, RpcBlockService],
})
export class RpcBlocksModule { }
