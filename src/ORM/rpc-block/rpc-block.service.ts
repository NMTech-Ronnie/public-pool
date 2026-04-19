import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RpcBlockEntity } from './rpc-block.entity';

@Injectable()
export class RpcBlockService {
    constructor(
        @InjectRepository(RpcBlockEntity)
        private rpcBlockRepository: Repository<RpcBlockEntity>
    ) {

    }
    public getBlock(blockHeight: number) {
        return this.rpcBlockRepository.findOne({
            where: { blockHeight }
        });
    }

    public lockBlock(blockHeight: number, process: string) {
        return this.rpcBlockRepository.save({ blockHeight, data: null, lockedBy: process, lockedAt: new Date() });
    }

    public saveBlock(blockHeight: number, data: string) {
        return this.rpcBlockRepository.update(blockHeight, { data })
    }

    public async deleteOldBlocks() {
        const result = await this.rpcBlockRepository.createQueryBuilder('entity')
            .select('MAX(entity.blockHeight)', 'maxNumber')
            .getRawOne();

        const newestBlock = result ? result.maxNumber : null;

        if (newestBlock != null) {
            await this.rpcBlockRepository.createQueryBuilder()
                .delete()
                .where('"blockHeight" < :newestBlock', { newestBlock })
                .execute();
        }

        // Clean up stale locks (older than 60 seconds with no data)
        const timeout = new Date(Date.now() - 60 * 1000);
        await this.rpcBlockRepository.createQueryBuilder()
            .delete()
            .where('"lockedAt" < :timeout AND data IS NULL', { timeout })
            .execute();

        return;
    }
}