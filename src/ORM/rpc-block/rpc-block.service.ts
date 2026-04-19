import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RpcBlockEntity } from './rpc-block.entity';

@Injectable()
export class RpcBlockService {
  constructor(
    @InjectRepository(RpcBlockEntity)
    private rpcBlockRepository: Repository<RpcBlockEntity>,
  ) {}

  private async retryOnBusy<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (e: any) {
        if (attempt < maxAttempts - 1 && e?.message?.includes('SQLITE_BUSY')) {
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
          continue;
        }
        throw e;
      }
    }
  }

  public getBlock(blockHeight: number) {
    return this.retryOnBusy(() =>
      this.rpcBlockRepository.findOne({
        where: { blockHeight },
      }),
    );
  }

  public lockBlock(blockHeight: number, process: string) {
    // Use insert() instead of save() so that a UNIQUE constraint violation
    // is thrown if another worker already locked this block height.
    // save() does an upsert (SELECT then INSERT/UPDATE) which silently
    // overwrites the lock, causing ALL workers to call loadBlockTemplate.
    return this.retryOnBusy(() =>
      this.rpcBlockRepository.insert({
        blockHeight,
        data: null,
        lockedBy: process,
      }),
    );
  }

  public saveBlock(blockHeight: number, data: string) {
    return this.retryOnBusy(() =>
      this.rpcBlockRepository.update(blockHeight, { data }),
    );
  }

  public async deleteOldBlocks() {
    const result = await this.rpcBlockRepository
      .createQueryBuilder('entity')
      .select('MAX(entity.blockHeight)', 'maxNumber')
      .getRawOne();

    const newestBlock = result ? result.maxNumber : null;

    await this.rpcBlockRepository
      .createQueryBuilder()
      .delete()
      .where('"blockHeight" < :newestBlock', { newestBlock })
      .execute();

    return;
  }
}
