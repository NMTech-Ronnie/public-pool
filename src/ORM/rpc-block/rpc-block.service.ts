import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RpcBlockEntity } from './rpc-block.entity';
import { PgNotifyService } from '../../services/pg-notify.service';

@Injectable()
export class RpcBlockService {
    constructor(
        @InjectRepository(RpcBlockEntity)
        private rpcBlockRepository: Repository<RpcBlockEntity>,
        private readonly pgNotifyService: PgNotifyService,
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

    public async saveBlock(blockHeight: number, data: string) {
        await this.rpcBlockRepository.update(blockHeight, { data });
        // Notify workers that raw template data is available — eliminates waitForBlock() polling
        try {
            await this.pgNotifyService.notify('template_ready', blockHeight.toString());
        } catch (e: any) {
            console.error('Failed to notify template_ready:', e?.message ?? String(e));
        }
    }

    /**
     * Leader calls this after fully processing the block template (Merkle tree, coinbase, job IDs).
     * Stores the serialized processed template so workers can read it directly without recomputing.
     */
    public async saveProcessedTemplate(blockHeight: number, processedData: string) {
        await this.rpcBlockRepository.update(blockHeight, { processedData });
        // Notify all workers that the processed template is ready — eliminates waitForBlock() polling
        try {
            await this.pgNotifyService.notify('template_ready', blockHeight.toString());
        } catch (e: any) {
            console.error('Failed to notify template_ready:', e?.message ?? String(e));
        }
    }

    public async getProcessedTemplate(blockHeight: number): Promise<string | null> {
        const block = await this.rpcBlockRepository.findOne({
            where: { blockHeight },
            select: ['processedData']
        });
        return block?.processedData ?? null;
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
