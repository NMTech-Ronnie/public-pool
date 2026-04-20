import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { ObjectLiteral, Repository } from 'typeorm';

import { ClientEntity } from './client.entity';
import { WorkerStats } from '../../utils/worker-stats';


// --- Write-Behind queue types ---
interface HeartbeatEntry {
    address: string;
    clientName: string;
    sessionId: string;
    hashRate: number;
    updatedAt: Date;
}

interface BestDifficultyEntry {
    sessionId: string;
    bestDifficulty: number;
}


@Injectable()
export class ClientService implements OnModuleDestroy {


    public insertQueue: { result: BehaviorSubject<ObjectLiteral | null>, partialClient: Partial<ClientEntity> }[] = [];

    // Write-Behind queues
    private heartbeatQueue: Map<string, HeartbeatEntry> = new Map();
    private bestDifficultyQueue: Map<string, BestDifficultyEntry> = new Map();

    constructor(
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>
    ) {

    }

    async onModuleDestroy() {
        // Flush remaining queues on shutdown
        await this.flushHeartbeats();
        await this.flushBestDifficulty();
        await this.insertClients();
    }

    @Interval(1000 * 5)
    public async insertClients() {
        const queueCopy = [...this.insertQueue];
        this.insertQueue = [];

        if (queueCopy.length === 0) return;

        const results = await this.clientRepository.insert(queueCopy.map(c => c.partialClient));

        queueCopy.forEach((c, index) => {
            c.result.next(results.generatedMaps[index]);
        });
    }

    // --- Write-Behind: batch flush heartbeats every 5 seconds ---
    @Interval(1000 * 5)
    public async flushHeartbeats() {
        if (this.heartbeatQueue.size === 0) return;

        const entries = Array.from(this.heartbeatQueue.values());
        this.heartbeatQueue.clear();

        try {
            // Build a batch UPDATE using VALUES list (PostgreSQL syntax)
            // UPDATE client_entity SET "hashRate" = v.hr, "deletedAt" = NULL, "updatedAt" = v.ua
            // FROM (VALUES (...), (...)) AS v(sid, hr, ua)
            // WHERE client_entity."sessionId" = v.sid
            const valuesClauses: string[] = [];
            const params: any[] = [];
            let idx = 1;
            for (const entry of entries) {
                valuesClauses.push(`($${idx}, $${idx + 1}::double precision, $${idx + 2}::timestamp)`);
                params.push(entry.sessionId, entry.hashRate, entry.updatedAt.toISOString());
                idx += 3;
            }

            const sql = `
                UPDATE client_entity
                SET "hashRate" = v.hr,
                    "deletedAt" = NULL,
                    "updatedAt" = v.ua
                FROM (VALUES ${valuesClauses.join(',')}) AS v(sid, hr, ua)
                WHERE client_entity."sessionId" = v.sid
            `;

            await this.clientRepository.query(sql, params);
        } catch (e) {
            WorkerStats.getInstance().onHeartbeatFlushError();
            console.error('flushHeartbeats error:', e.message);
        }
    }

    // --- Write-Behind: batch flush bestDifficulty every 5 seconds ---
    @Interval(1000 * 5)
    public async flushBestDifficulty() {
        if (this.bestDifficultyQueue.size === 0) return;

        const entries = Array.from(this.bestDifficultyQueue.values());
        this.bestDifficultyQueue.clear();

        try {
            const valuesClauses: string[] = [];
            const params: any[] = [];
            let idx = 1;
            for (const entry of entries) {
                valuesClauses.push(`($${idx}, $${idx + 1}::double precision)`);
                params.push(entry.sessionId, entry.bestDifficulty);
                idx += 2;
            }

            const sql = `
                UPDATE client_entity
                SET "bestDifficulty" = v.bd
                FROM (VALUES ${valuesClauses.join(',')}) AS v(sid, bd)
                WHERE client_entity."sessionId" = v.sid
                  AND client_entity."bestDifficulty" < v.bd
            `;

            await this.clientRepository.query(sql, params);
        } catch (e) {
            console.error('flushBestDifficulty error:', e.message);
        }
    }


    public async killDeadClients() {
        var fiveMinutes = new Date(new Date().getTime() - (5 * 60 * 1000)).toISOString();

        return await this.clientRepository
            .createQueryBuilder()
            .update(ClientEntity)
            .set({ deletedAt: () => "NOW()" })
            .where('"deletedAt" IS NULL AND "updatedAt" < :fiveMinutes::timestamp', { fiveMinutes })
            .execute();
    }

    /**
     * Write-Behind: enqueue heartbeat instead of immediate DB write.
     * Keyed by sessionId so that only the latest heartbeat per session is kept.
     */
    public heartbeat(address: string, clientName: string, sessionId: string, hashRate: number, updatedAt: Date) {
        this.heartbeatQueue.set(sessionId, { address, clientName, sessionId, hashRate, updatedAt });
    }


    public async insert(partialClient: Partial<ClientEntity>): Promise<ClientEntity> {

        const result = new BehaviorSubject(null);

        this.insertQueue.push({ result, partialClient });


        //  const insertResult = await this.clientRepository.insert(partialClient);

        const generatedMap = await firstValueFrom(result);

        const client = {
            ...partialClient,
            ...generatedMap
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
            .where('"deletedAt" < :deletedAt', { deletedAt: oneDayAgo })
            .execute();

    }

    /**
     * Write-Behind: enqueue bestDifficulty update.
     * Per sessionId only the maximum value is kept in memory until flush.
     */
    public updateBestDifficulty(sessionId: string, bestDifficulty: number) {
        const existing = this.bestDifficultyQueue.get(sessionId);
        if (!existing || bestDifficulty > existing.bestDifficulty) {
            this.bestDifficultyQueue.set(sessionId, { sessionId, bestDifficulty });
        }
    }

    public async connectedClientCount(): Promise<number> {
        return await this.clientRepository.count();
    }

    public async getByAddress(address: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address
            }
        })
    }


    public async getByName(address: string, clientName: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address,
                clientName
            }
        })
    }

    public async getBySessionId(address: string, clientName: string, sessionId: string): Promise<ClientEntity> {
        return await this.clientRepository.findOne({
            where: {
                address,
                clientName,
                sessionId
            }
        })
    }

    public async deleteAll() {
        return await this.clientRepository.softDelete({})
    }

    public async getUserAgents() {
        const result = await this.clientRepository.createQueryBuilder('client')
            .select('client.userAgent as "userAgent"')
            .addSelect('COUNT(client.userAgent)', 'count')
            .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
            .addSelect('COALESCE(SUM(client.hashRate), 0)', 'totalHashRate')
            .where('client."deletedAt" IS NULL')
            .groupBy('client.userAgent')
            .orderBy('count', 'DESC')
            .getRawMany();
        return result;
    }

}