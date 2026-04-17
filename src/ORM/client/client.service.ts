import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
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
    { sessionId: string; bestDifficulty: number }
  > = new Map();

  constructor(
    @InjectRepository(ClientEntity)
    private clientRepository: Repository<ClientEntity>,
  ) {}

  @Interval(1000 * 5)
  public async insertClients() {
    const queueCopy = [...this.insertQueue];
    this.insertQueue = [];

    if (queueCopy.length === 0) return;

    const results = await this.clientRepository.insert(
      queueCopy.map((c) => c.partialClient),
    );

    queueCopy.forEach((c, index) => {
      c.result.next(results.generatedMaps[index]);
    });
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

    // Batch heartbeats in a single transaction
    if (heartbeats.length > 0) {
      try {
        await this.clientRepository.manager.transaction(async (manager) => {
          for (const hb of heartbeats) {
            await manager.update(
              ClientEntity,
              {
                address: hb.address,
                clientName: hb.clientName,
                sessionId: hb.sessionId,
              },
              {
                hashRate: hb.hashRate,
                deletedAt: null,
                updatedAt: hb.updatedAt,
              },
            );
          }
        });
        heartbeatCount = heartbeats.length;
      } catch (e) {
        // Fallback: individual writes
        for (const hb of heartbeats) {
          try {
            await this.clientRepository.update(
              {
                address: hb.address,
                clientName: hb.clientName,
                sessionId: hb.sessionId,
              },
              {
                hashRate: hb.hashRate,
                deletedAt: null,
                updatedAt: hb.updatedAt,
              },
            );
            heartbeatCount++;
          } catch (e2) {}
        }
      }
    }

    // Batch bestDifficulty updates in a single transaction
    if (bestDiffs.length > 0) {
      try {
        await this.clientRepository.manager.transaction(async (manager) => {
          for (const bd of bestDiffs) {
            await manager.update(
              ClientEntity,
              { sessionId: bd.sessionId },
              { bestDifficulty: bd.bestDifficulty },
            );
          }
        });
        bestDiffCount = bestDiffs.length;
      } catch (e) {
        for (const bd of bestDiffs) {
          try {
            await this.clientRepository.update(
              { sessionId: bd.sessionId },
              { bestDifficulty: bd.bestDifficulty },
            );
            bestDiffCount++;
          } catch (e2) {}
        }
      }
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

  public queueBestDifficulty(sessionId: string, bestDifficulty: number) {
    const existing = this.bestDifficultyQueue.get(sessionId);
    if (!existing || bestDifficulty > existing.bestDifficulty) {
      this.bestDifficultyQueue.set(sessionId, { sessionId, bestDifficulty });
    }
  }

  public async killDeadClients() {
    const fiveMinutes = new Date(
      new Date().getTime() - 5 * 60 * 1000,
    ).toISOString();

    return await this.clientRepository
      .createQueryBuilder()
      .update(ClientEntity)
      .set({ deletedAt: () => "DATETIME('now')" })
      .where('deletedAt IS NULL AND updatedAt < DATETIME(:fiveMinutes)', {
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
      .groupBy('client.userAgent')
      .orderBy('count', 'DESC')
      .getRawMany();
    return result;
  }
}
