import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ChainStateEntity } from './chain-state.entity';
import { PgNotifyService } from '../../services/pg-notify.service';

@Injectable()
export class ChainStateService {
    constructor(
        @InjectRepository(ChainStateEntity)
        private chainStateRepository: Repository<ChainStateEntity>,
        private readonly pgNotifyService: PgNotifyService,
    ) {}

    public async updateHeight(height: number) {
        await this.chainStateRepository.save({ id: 1, height, updatedAt: new Date() });
        // Real-time broadcast to all workers — eliminates pollChainState() polling
        try {
            await this.pgNotifyService.notify('new_block', height.toString());
        } catch (e: any) {
            console.error('Failed to notify new_block:', e?.message ?? String(e));
        }
    }

    public async getHeight(): Promise<number | null> {
        const state = await this.chainStateRepository.findOne({ where: { id: 1 } });
        return state?.height ?? null;
    }
}
