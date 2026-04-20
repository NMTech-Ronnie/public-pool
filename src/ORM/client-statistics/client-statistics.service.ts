import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';
import { WorkerStats } from '../../utils/worker-stats';


// Write-Behind queue key
interface StatKey {
    address: string;
    clientName: string;
    sessionId: string;
    time: number;
}

interface StatEntry extends StatKey {
    shares: number;
    acceptedCount: number;
    isNew: boolean; // true = needs INSERT, false = needs UPDATE
}

@Injectable()
export class ClientStatisticsService implements OnModuleDestroy {

    // Write-Behind: accumulate inserts/updates in memory, flush every 5 seconds
    private statsQueue: Map<string, StatEntry> = new Map();

    constructor(
        @InjectRepository(ClientStatisticsEntity)
        private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
    ) {

    }

    async onModuleDestroy() {
        await this.flushStatistics();
    }

    private statKey(address: string, clientName: string, sessionId: string, time: number): string {
        return `${address}|${clientName}|${sessionId}|${time}`;
    }

    /**
     * Write-Behind: enqueue a statistics upsert.
     * Called from StratumV1ClientStatistics.addShares().
     */
    public enqueueUpsert(stat: {
        address: string;
        clientName: string;
        sessionId: string;
        time: number;
        shares: number;
        acceptedCount: number;
        isNew: boolean;
    }) {
        const key = this.statKey(stat.address, stat.clientName, stat.sessionId, stat.time);
        this.statsQueue.set(key, {
            address: stat.address,
            clientName: stat.clientName,
            sessionId: stat.sessionId,
            time: stat.time,
            shares: stat.shares,
            acceptedCount: stat.acceptedCount,
            isNew: stat.isNew,
        });
    }

    /**
     * Batch flush: INSERT … ON CONFLICT DO UPDATE (PostgreSQL upsert)
     * Flushes every 5 seconds.
     */
    @Interval(1000 * 5)
    public async flushStatistics() {
        if (this.statsQueue.size === 0) return;

        const entries = Array.from(this.statsQueue.values());
        this.statsQueue.clear();

        try {
            // Use PostgreSQL INSERT ... ON CONFLICT ... DO UPDATE (upsert)
            // We need the composite unique index on (address, clientName, sessionId, time)
            // Since the entity uses PrimaryGeneratedColumn (id), we rely on the existing
            // composite index. We'll batch using raw SQL for best performance.

            const BATCH_SIZE = 500;
            for (let i = 0; i < entries.length; i += BATCH_SIZE) {
                const batch = entries.slice(i, i + BATCH_SIZE);
                const valuesClauses: string[] = [];
                const params: any[] = [];
                let idx = 1;

                for (const entry of batch) {
                    valuesClauses.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, NOW(), NOW())`);
                    params.push(
                        entry.address,
                        entry.clientName,
                        entry.sessionId,
                        entry.time,
                        entry.shares,
                        entry.acceptedCount,
                    );
                    idx += 6;
                }

                const sql = `
                    INSERT INTO client_statistics_entity ("address", "clientName", "sessionId", "time", "shares", "acceptedCount", "createdAt", "updatedAt")
                    VALUES ${valuesClauses.join(',')}
                    ON CONFLICT ("address", "clientName", "sessionId", "time")
                    DO UPDATE SET
                        "shares" = EXCLUDED."shares",
                        "acceptedCount" = EXCLUDED."acceptedCount",
                        "updatedAt" = NOW()
                `;

                await this.clientStatisticsRepository.query(sql, params);
            }
        } catch (e) {
            WorkerStats.getInstance().onStatsFlushError();
            console.error('flushStatistics error:', e.message);
        }
    }

    /** @deprecated Use enqueueUpsert() for Write-Behind. Kept for backward compatibility. */
    public async update(clientStatistic: Partial<ClientStatisticsEntity>) {
        this.enqueueUpsert({
            address: clientStatistic.address,
            clientName: clientStatistic.clientName,
            sessionId: clientStatistic.sessionId,
            time: clientStatistic.time,
            shares: clientStatistic.shares,
            acceptedCount: clientStatistic.acceptedCount,
            isNew: false,
        });
    }

    /** @deprecated Use enqueueUpsert() for Write-Behind. Kept for backward compatibility. */
    public async insert(clientStatistic: Partial<ClientStatisticsEntity>) {
        this.enqueueUpsert({
            address: clientStatistic.address,
            clientName: clientStatistic.clientName,
            sessionId: clientStatistic.sessionId,
            time: clientStatistic.time,
            shares: clientStatistic.shares,
            acceptedCount: clientStatistic.acceptedCount,
            isNew: true,
        });
    }

    public async deleteOldStatistics() {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        return await this.clientStatisticsRepository
            .createQueryBuilder()
            .delete()
            .from(ClientStatisticsEntity)
            .where('"time" < :time', { time: oneDayAgo.getTime() })
            .execute();
    }

    public async getChartDataForSite() {

        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                "time" AS label,
                ROUND(((SUM("shares") * 4294967296) / 600)) AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry."time" > $1
            GROUP BY
                "time"
            ORDER BY
                "time" DESC
            LIMIT 144
        `;

        const result: any[] = await this.clientStatisticsRepository.query(query, [yesterday.getTime()]);


        return result
            .reverse()
            .map(res => {
                return {
                    label: new Date(Number(res.label)).toISOString(),
                    data: Number(res.data ?? 0)
                };
            });

    }


    public async getChartDataForAddress(address: string) {

        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
                SELECT
                    "time" AS label,
                    (SUM("shares") * 4294967296) / 600 AS data
                FROM
                    client_statistics_entity AS entry
                WHERE
                    entry."address" = $1 AND entry."time" > $2
                GROUP BY
                    "time"
                ORDER BY
                    "time" DESC
                LIMIT 144
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, yesterday.getTime()]);

        return result
            .reverse()
            .map(res => {
                return {
                    label: new Date(Number(res.label)).toISOString(),
                    data: Number(res.data ?? 0)
                };
            });


    }


    public async getHashRateForGroup(address: string, clientName: string) {

        var oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

        const query = `
            SELECT
            SUM(entry."shares") AS "difficultySum"
            FROM
                client_statistics_entity AS entry
            WHERE
                entry."address" = $1 AND entry."clientName" = $2 AND entry."time" > $3
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, oneHour.getTime()]);


        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (600);

    }

    public async getChartDataForGroup(address: string, clientName: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                "time" AS label,
                (SUM("shares") * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry."address" = $1 AND entry."clientName" = $2 AND entry."time" > $3
            GROUP BY
                "time"
            ORDER BY
                "time" DESC
            LIMIT 144
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, yesterday.getTime()]);

        return result
            .reverse()
            .map(res => {
                return {
                    label: new Date(Number(res.label)).toISOString(),
                    data: Number(res.data ?? 0)
                };
            });


    }


    public async getHashRateForSession(address: string, clientName: string, sessionId: string) {

        const query = `
            SELECT
                "createdAt",
                "updatedAt",
                "shares"
            FROM
                client_statistics_entity AS entry
            WHERE
                entry."address" = $1 AND entry."clientName" = $2 AND entry."sessionId" = $3
            ORDER BY "time" DESC
            LIMIT 2
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        if (result.length < 1) {
            return 0;
        }

        const latestStat = result[0];

        if (result.length < 2) {
            const time = new Date(latestStat.updatedAt).getTime() - new Date(latestStat.createdAt).getTime();
            // 1min
            if (time < 1000 * 60) {
                return 0;
            }
            return (latestStat.shares * 4294967296) / (time / 1000);
        } else {
            const secondLatestStat = result[1];
            const time = new Date(latestStat.updatedAt).getTime() - new Date(secondLatestStat.createdAt).getTime();
            // 1min
            if (time < 1000 * 60) {
                return 0;
            }
            return ((latestStat.shares + secondLatestStat.shares) * 4294967296) / (time / 1000);
        }

    }

    public async getChartDataForSession(address: string, clientName: string, sessionId: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

        const query = `
            SELECT
                "time" AS label,
                (SUM("shares") * 4294967296) / 600 AS data
            FROM
                client_statistics_entity AS entry
            WHERE
                entry."address" = $1 AND entry."clientName" = $2 AND entry."sessionId" = $3 AND entry."time" > $4
            GROUP BY
                "time"
            ORDER BY
                "time" DESC
            LIMIT 144
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId, yesterday.getTime()]);

        return result
            .reverse()
            .map(res => {
                return {
                    label: new Date(Number(res.label)).toISOString(),
                    data: Number(res.data ?? 0)
                };
            });

    }

    public async deleteAll() {
        return await this.clientStatisticsRepository.delete({})
    }
}