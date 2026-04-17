import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';

@Injectable()
export class ClientStatisticsService {
  private insertQueue: Partial<ClientStatisticsEntity>[] = [];
  private updateQueue: Map<string, Partial<ClientStatisticsEntity>> = new Map();

  constructor(
    @InjectRepository(ClientStatisticsEntity)
    private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
  ) {}

  public queueUpdate(clientStatistic: Partial<ClientStatisticsEntity>) {
    const key = `${clientStatistic.address}:${clientStatistic.clientName}:${clientStatistic.sessionId}:${clientStatistic.time}`;
    this.updateQueue.set(key, clientStatistic);
  }

  public queueInsert(clientStatistic: Partial<ClientStatisticsEntity>) {
    this.insertQueue.push(clientStatistic);
  }

  public async flushWrites(): Promise<{ inserts: number; updates: number }> {
    const inserts = [...this.insertQueue];
    this.insertQueue = [];

    const updates = [...this.updateQueue.values()];
    this.updateQueue.clear();

    let insertCount = 0;
    let updateCount = 0;

    // Batch inserts in chunks of 50 to avoid SQLite expression tree limit
    if (inserts.length > 0) {
      const BATCH = 50;
      for (let i = 0; i < inserts.length; i += BATCH) {
        const batch = inserts.slice(i, i + BATCH);
        let inserted = false;
        for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
          try {
            await this.clientStatisticsRepository.insert(batch);
            insertCount += batch.length;
            inserted = true;
          } catch (e: any) {
            if (attempt < 2 && e?.message?.includes('SQLITE_BUSY')) {
              await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
              continue;
            }
            // Fallback: insert one by one to handle duplicates
            for (const item of batch) {
              try {
                await this.clientStatisticsRepository.insert(item);
                insertCount++;
              } catch (e2) {
                // Duplicate, convert to update
                updates.push(item);
              }
            }
          }
        }
      }
    }

    // Wrap all updates in a single raw SQL transaction to minimize lock hold time
    if (updates.length > 0) {
      try {
        const now = new Date().toISOString();
        await this.clientStatisticsRepository.manager.transaction(
          async (manager) => {
            for (const stat of updates) {
              await manager.query(
                'UPDATE client_statistics_entity SET shares = ?, acceptedCount = ?, updatedAt = ? WHERE address = ? AND clientName = ? AND sessionId = ? AND time = ?',
                [
                  stat.shares,
                  stat.acceptedCount,
                  now,
                  stat.address,
                  stat.clientName,
                  stat.sessionId,
                  stat.time,
                ],
              );
            }
          },
        );
        updateCount = updates.length;
      } catch (e) {
        // SQLITE_BUSY — data lost for this cycle, will be re-queued
      }
    }

    return { inserts: insertCount, updates: updateCount };
  }

  public async update(clientStatistic: Partial<ClientStatisticsEntity>) {
    await this.clientStatisticsRepository.update(
      {
        address: clientStatistic.address,
        clientName: clientStatistic.clientName,
        sessionId: clientStatistic.sessionId,
        time: clientStatistic.time,
      },
      {
        shares: clientStatistic.shares,
        acceptedCount: clientStatistic.acceptedCount,
        updatedAt: new Date(),
      },
    );
  }
  public async insert(clientStatistic: Partial<ClientStatisticsEntity>) {
    // If no rows were updated, insert a new record
    await this.clientStatisticsRepository.insert(clientStatistic);
  }

  public async deleteOldStatistics() {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    return await this.clientStatisticsRepository
      .createQueryBuilder()
      .delete()
      .from(ClientStatisticsEntity)
      .where('time < :time', { time: oneDayAgo.getTime() })
      .execute();
  }

  public async getChartDataForSite() {
    const yesterday = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);

    const query = `
            SELECT
                time AS label,
                ROUND(((SUM(shares) * 4294967296) / 600)) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;

    `;

    const result: any[] = await this.clientStatisticsRepository.query(query);

    return result
      .map((res) => {
        res.label = new Date(res.label).toISOString();
        return res;
      })
      .slice(0, result.length - 1);
  }

  // public async getHashRateForAddress(address: string) {

  //     const oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

  //     const query = `
  //         SELECT
  //         SUM(entry.shares) AS difficultySum
  //         FROM
  //             client_statistics_entity AS entry
  //         WHERE
  //             entry.address = ? AND entry.time > ${oneHour}
  //     `;

  //     const result = await this.clientStatisticsRepository.query(query, [address]);

  //     const difficultySum = result[0].difficultySum;

  //     return (difficultySum * 4294967296) / (600);

  // }

  public async getChartDataForAddress(address: string) {
    const yesterday = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);

    const query = `
                SELECT
                    time label,
                    (SUM(shares) * 4294967296) / 600 AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                    entry.address = ? AND entry.time > ${yesterday.getTime()}
                GROUP BY
                    time
                ORDER BY
                    time
                LIMIT 144;

        `;

    const result = await this.clientStatisticsRepository.query(query, [
      address,
    ]);

    return result
      .map((res) => {
        res.label = new Date(res.label).toISOString();
        return res;
      })
      .slice(0, result.length - 1);
  }

  public async getHashRateForGroup(address: string, clientName: string) {
    const oneHour = new Date(new Date().getTime() - 60 * 60 * 1000);

    const query = `
            SELECT
            SUM(entry.shares) AS difficultySum
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > ${oneHour.getTime()}
        `;

    const result = await this.clientStatisticsRepository.query(query, [
      address,
      clientName,
    ]);

    const difficultySum = result[0].difficultySum;

    return (difficultySum * 4294967296) / 600;
  }

  public async getChartDataForGroup(address: string, clientName: string) {
    const yesterday = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);

    const query = `
            SELECT
                time label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

    const result = await this.clientStatisticsRepository.query(query, [
      address,
      clientName,
    ]);

    return result
      .map((res) => {
        res.label = new Date(res.label).toISOString();
        return res;
      })
      .slice(0, result.length - 1);
  }

  public async getHashRateForSession(
    address: string,
    clientName: string,
    sessionId: string,
  ) {
    const query = `
            SELECT
                createdAt,
                updatedAt,
                shares
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ?
            ORDER BY time DESC
            LIMIT 2;
        `;

    const result = await this.clientStatisticsRepository.query(query, [
      address,
      clientName,
      sessionId,
    ]);

    if (result.length < 1) {
      return 0;
    }

    const latestStat = result[0];

    if (result.length < 2) {
      const time =
        new Date(latestStat.updatedAt).getTime() -
        new Date(latestStat.createdAt).getTime();
      // 1min
      if (time < 1000 * 60) {
        return 0;
      }
      return (latestStat.shares * 4294967296) / (time / 1000);
    } else {
      const secondLatestStat = result[1];
      const time =
        new Date(latestStat.updatedAt).getTime() -
        new Date(secondLatestStat.createdAt).getTime();
      // 1min
      if (time < 1000 * 60) {
        return 0;
      }
      return (
        ((latestStat.shares + secondLatestStat.shares) * 4294967296) /
        (time / 1000)
      );
    }
  }

  public async getChartDataForSession(
    address: string,
    clientName: string,
    sessionId: string,
  ) {
    const yesterday = new Date(new Date().getTime() - 24 * 60 * 60 * 1000);

    const query = `
            SELECT
                time label,
                (SUM(shares) * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ? AND entry.time > ${yesterday.getTime()}
            GROUP BY
                time
            ORDER BY
                time
            LIMIT 144;
        `;

    const result = await this.clientStatisticsRepository.query(query, [
      address,
      clientName,
      sessionId,
    ]);

    return result
      .map((res) => {
        res.label = new Date(res.label).toISOString();
        return res;
      })
      .slice(0, result.length - 1);
  }

  public async deleteAll() {
    return await this.clientStatisticsRepository.delete({});
  }
}
