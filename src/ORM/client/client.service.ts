import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { ObjectLiteral, Repository } from 'typeorm';

import { ClientEntity } from './client.entity';

@Injectable()
export class ClientService {
  public insertQueue: {
    result: BehaviorSubject<ObjectLiteral | null>;
    partialClient: Partial<ClientEntity>;
  }[] = [];

  // Batched write queues for heartbeat and bestDifficulty
  private heartbeatQueue: Map<
    string,
    {
      address: string;
      clientName: string;
      sessionId: string;
      hashRate: number;
      updatedAt: Date;
    }
  > = new Map();
  private bestDifficultyQueue: Map<
    string,
    { address: string; clientName: string; sessionId: string; bestDifficulty: number }
  > = new Map();

  constructor(
    @InjectRepository(ClientEntity)
    private clientRepository: Repository<ClientEntity>,
  ) {}

  // Called from stratum-v1.service centralized timer (staggered per worker)
  public async insertClients() {
    const queueCopy = [...this.insertQueue];
    this.insertQueue = [];

    if (queueCopy.length === 0) return;

    // Batch inserts in chunks of 50 to avoid SQLite's
    // "Expression tree is too large (maximum depth 1000)" error
    const BATCH = 50;
    for (let i = 0; i < queueCopy.length; i += BATCH) {
      const batch = queueCopy.slice(i, i + BATCH);
      let success = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const results = await this.clientRepository.insert(
            batch.map((c) => c.partialClient),
          );
          batch.forEach((c, index) => {
            c.result.next(results.generatedMaps[index]);
          });
          success = true;
          break;
        } catch (e: any) {
          if (attempt < 2 && e?.message?.includes('SQLITE_BUSY')) {
            await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
            continue;
          }
          // On final failure, resolve with null so callers don't hang
          // (BehaviorSubject(null) already returned null to callers immediately,
          // so this is just cleanup)
          batch.forEach((c) => c.result.next(null));
          console.error(`insertClients batch failed (${batch.length} items):`, e?.message);
          break;
        }
      }
    }
  }

  public async flushWrites(): Promise<{
    heartbeats: number;
    bestDiffs: number;
  }> {
    const heartbeats = [...this.heartbeatQueue.values()];
    this.heartbeatQueue.clear();

    const bestDiffs = [...this.bestDifficultyQueue.values()];
    this.bestDifficultyQueue.clear();

    let heartbeatCount = 0;
    let bestDiffCount = 0;

    // Use raw SQL in chunked transactions to reduce write-lock hold time.
    // A single transaction with hundreds of UPDATEs holds EXCLUSIVE lock too long,
    // causing SQLITE_BUSY for other workers. Chunks of 50 limit lock to ~50ms each.
    const CHUNK = 50;

    if (heartbeats.length > 0) {
      try {
        const now = new Date().toISOString();
        for (let i = 0; i < heartbeats.length; i += CHUNK) {
          const chunk = heartbeats.slice(i, i + CHUNK);
          await this.clientRepository.manager.transaction(async (manager) => {
            for (const hb of chunk) {
              await manager.query(
                'UPDATE client_entity SET hashRate = ?, updatedAt = ? WHERE address = ? AND clientName = ? AND sessionId = ? AND deletedAt IS NULL',
                [hb.hashRate, now, hb.address, hb.clientName, hb.sessionId],
              );
            }
          });
        }
        heartbeatCount = heartbeats.length;
      } catch (e) {
        // SQLITE_BUSY or other error — data is lost for this cycle.
        // Clients will re-queue heartbeats next flush cycle.
      }
    }

    if (bestDiffs.length > 0) {
      try {
        for (let i = 0; i < bestDiffs.length; i += CHUNK) {
          const chunk = bestDiffs.slice(i, i + CHUNK);
          await this.clientRepository.manager.transaction(async (manager) => {
            for (const bd of chunk) {
              await manager.query(
                'UPDATE client_entity SET bestDifficulty = ? WHERE address = ? AND clientName = ? AND sessionId = ?',
                [bd.bestDifficulty, bd.address, bd.clientName, bd.sessionId],
              );
            }
          });
        }
        bestDiffCount = bestDiffs.length;
      } catch (e) {}
    }

    return { heartbeats: heartbeatCount, bestDiffs: bestDiffCount };
  }

  public queueHeartbeat(
    address: string,
    clientName: string,
    sessionId: string,
    hashRate: number,
    updatedAt: Date,
  ) {
    this.heartbeatQueue.set(sessionId, {
      address,
      clientName,
      sessionId,
      hashRate,
      updatedAt,
    });
  }

  /**
   * Remove a session from all pending write queues.
   * Must be called BEFORE softDelete to prevent flushWrites from resurrecting
   * a destroyed session via the `deletedAt = NULL` in the heartbeat UPDATE.
   */
  public removeFromQueues(sessionId: string) {
    this.heartbeatQueue.delete(sessionId);
    this.bestDifficultyQueue.delete(sessionId);
  }

  public queueBestDifficulty(
    address: string,
    clientName: string,
    sessionId: string,
    bestDifficulty: number,
  ) {
    const existing = this.bestDifficultyQueue.get(sessionId);
    if (!existing || bestDifficulty > existing.bestDifficulty) {
      this.bestDifficultyQueue.set(sessionId, {
        address,
        clientName,
        sessionId,
        bestDifficulty,
      });
    }
  }

  public async killDeadClients() {
    const fiveMinutes = new Date(
      new Date().getTime() - 5 * 60 * 1000,
    ).toISOString();

    return await this.clientRepository
      .createQueryBuilder()
      .update(ClientEntity)
      .set({ deletedAt: () => "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" })
      .where('deletedAt IS NULL AND updatedAt < :fiveMinutes', {
        fiveMinutes,
      })
      .execute();
  }

  public async heartbeat(
    address: string,
    clientName: string,
    sessionId: string,
    hashRate: number,
    updatedAt: Date,
  ) {
    return await this.clientRepository.update(
      { address, clientName, sessionId },
      { hashRate, deletedAt: null, updatedAt },
    );
  }

  // public async save(client: Partial<ClientEntity>) {
  //     return await this.clientRepository.save(client);
  // }

  public async insert(
    partialClient: Partial<ClientEntity>,
  ): Promise<ClientEntity> {
    const result = new BehaviorSubject(null);

    this.insertQueue.push({ result, partialClient });

    //  const insertResult = await this.clientRepository.insert(partialClient);

    const generatedMap = await firstValueFrom(result);

    const client = {
      ...partialClient,
      ...generatedMap,
    };

    return client as ClientEntity;
  }

  public async delete(sessionId: string) {
    return await this.clientRepository.softDelete({ sessionId });
  }

  public async deleteOldClients() {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    return await this.clientRepository
      .createQueryBuilder()
      .delete()
      .from(ClientEntity)
      .where('deletedAt < :deletedAt', { deletedAt: oneDayAgo })
      .execute();
  }

  public async updateBestDifficulty(sessionId: string, bestDifficulty: number) {
    return await this.clientRepository.update(
      { sessionId },
      { bestDifficulty },
    );
  }
  public async connectedClientCount(): Promise<number> {
    return await this.clientRepository.count();
  }

  public async getByAddress(address: string): Promise<ClientEntity[]> {
    return await this.clientRepository.find({
      where: {
        address,
      },
    });
  }

  public async getByName(
    address: string,
    clientName: string,
  ): Promise<ClientEntity[]> {
    return await this.clientRepository.find({
      where: {
        address,
        clientName,
      },
    });
  }

  public async getBySessionId(
    address: string,
    clientName: string,
    sessionId: string,
  ): Promise<ClientEntity> {
    return await this.clientRepository.findOne({
      where: {
        address,
        clientName,
        sessionId,
      },
    });
  }

  public async deleteAll() {
    return await this.clientRepository.softDelete({});
  }

  public async getUserAgents() {
    const result = await this.clientRepository
      .createQueryBuilder('client')
      .select('client.userAgent as userAgent')
      .addSelect('COUNT(client.userAgent)', 'count')
      .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
      .addSelect('SUM(client.hashRate)', 'totalHashRate')
      .where('client.deletedAt IS NULL')
      .groupBy('client.userAgent')
      .orderBy('count', 'DESC')
      .getRawMany();
    return result;
  }
}
