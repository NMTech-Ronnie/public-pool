import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ChainStateEntity } from './chain-state.entity';

@Injectable()
export class ChainStateService {
    constructor(
        @InjectRepository(ChainStateEntity)
        private chainStateRepository: Repository<ChainStateEntity>,
    ) {}

    public async updateHeight(height: number) {
        await this.chainStateRepository.save({ id: 1, height, updatedAt: new Date() });
    }

    public async getHeight(): Promise<number | null> {
        const state = await this.chainStateRepository.findOne({ where: { id: 1 } });
        return state?.height ?? null;
    }
}
