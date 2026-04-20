import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientStatisticsEntity } from './client-statistics.entity';

interface PendingStat {
    key: string;
    time: number;
    shares: number;
    acceptedCount: number;
    address: string;
    clientName: string;
    sessionId: string;
    createdAt: Date;
}

@Injectable()
export class ClientStatisticsService implements OnModuleDestroy {

    // In-memory queue for share statistics — eliminates synchronous DB blocking on stratum event loop
    private pendingUpdates = new Map<string, PendingStat>();

    constructor(
        @InjectRepository(ClientStatisticsEntity)
        private clientStatisticsRepository: Repository<ClientStatisticsEntity>,
    ) {

    }

    /**
     * Queue a share update for batch flushing. Call from stratum event loop — non-blocking.
     */
    public queueUpdate(stat: Partial<ClientStatisticsEntity>) {
        const key = `${stat.address}:${stat.clientName}:${stat.sessionId}:${stat.time}`;
        const existing = this.pendingUpdates.get(key);
        if (existing) {
            existing.shares += stat.shares || 0;
            existing.acceptedCount += stat.acceptedCount || 0;
        } else {
            this.pendingUpdates.set(key, {
                key,
                time: stat.time,
                shares: stat.shares || 0,
                acceptedCount: stat.acceptedCount || 0,
                address: stat.address,
                clientName: stat.clientName,
                sessionId: stat.sessionId,
                createdAt: new Date(),
            });
        }
    }

    /**
     * Flush all queued statistics to DB in a single batch every 5 seconds.
     * Uses INSERT ... ON CONFLICT (upsert) for atomicity.
     */
    @Interval(5000)
    public async flushUpdates() {
        if (this.pendingUpdates.size === 0) return;

        const batch = Array.from(this.pendingUpdates.values());
        this.pendingUpdates.clear();

        try {
            // Build VALUES clause for bulk upsert
            const values = batch.map((s, i) =>
                `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`
            ).join(', ');

            const params: any[] = [];
            batch.forEach(s => {
                params.push(s.address, s.clientName, s.sessionId, s.time, s.shares, s.acceptedCount, s.createdAt);
            });

            await this.clientStatisticsRepository.query(`
                INSERT INTO client_statistics_entity
                    (address, "clientName", "sessionId", time, shares, "acceptedCount", "createdAt")
                VALUES ${values}
                ON CONFLICT (address, "clientName", "sessionId", time)
                DO UPDATE SET
                    shares = client_statistics_entity.shares + EXCLUDED.shares,
                    "acceptedCount" = client_statistics_entity."acceptedCount" + EXCLUDED."acceptedCount",
                    "updatedAt" = NOW()
            `, params);
        } catch (e: any) {
            console.error('Batch flush client_statistics failed:', e?.message ?? String(e));
            // Re-queue failed items to avoid data loss
            batch.forEach(s => this.pendingUpdates.set(s.key, s));
        }
    }

    async onModuleDestroy() {
        await this.flushUpdates();
    }

    public async update(clientStatistic: Partial<ClientStatisticsEntity>) {
        await this.clientStatisticsRepository.update({
            address: clientStatistic.address,
            clientName: clientStatistic.clientName,
            sessionId: clientStatistic.sessionId,
            time: clientStatistic.time
        },
            {
                shares: clientStatistic.shares,
                acceptedCount: clientStatistic.acceptedCount,
                updatedAt: new Date()
            });
    }

    public async insert(clientStatistic: Partial<ClientStatisticsEntity>) {
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

        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

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


        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1)

    }


    public async getChartDataForAddress(address: string) {

        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

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

        const result = await this.clientStatisticsRepository.query(query, [address]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1);


    }


    public async getHashRateForGroup(address: string, clientName: string) {

        var oneHour = new Date(new Date().getTime() - (60 * 60 * 1000));

        const query = `
            SELECT
            SUM(entry.shares) AS difficultySum
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.time > ${oneHour.getTime()}
        `;

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);


        const difficultySum = result[0].difficultySum;

        return (difficultySum * 4294967296) / (600);

    }

    public async getChartDataForGroup(address: string, clientName: string) {
        var yesterday = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

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

        const result = await this.clientStatisticsRepository.query(query, [address, clientName]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1);


    }


    public async getHashRateForSession(address: string, clientName: string, sessionId: string) {

        const query = `
            SELECT
                "createdAt",
                "updatedAt",
                shares
            FROM
                client_statistics_entity AS entry
            WHERE
                entry.address = ? AND entry.clientName = ? AND entry.sessionId = ?
            ORDER BY time DESC
            LIMIT 2;
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

        const result = await this.clientStatisticsRepository.query(query, [address, clientName, sessionId]);

        return result.map(res => {
            res.label = new Date(res.label).toISOString();
            return res;
        }).slice(0, result.length - 1);

    }

    public async deleteAll() {
        return await this.clientStatisticsRepository.delete({})
    }
}
