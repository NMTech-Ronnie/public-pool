import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { ObjectLiteral, Repository } from 'typeorm';

import { ClientEntity } from './client.entity';



@Injectable()
export class ClientService implements OnModuleDestroy {


    public insertQueue: { result: BehaviorSubject<ObjectLiteral | null>, partialClient: Partial<ClientEntity> }[] = [];

    // Batch heartbeat queue — eliminates per-share synchronous DB UPDATE blocking
    private heartbeatQueue = new Map<string, { hashRate: number; updatedAt: Date }>();

    constructor(
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>
    ) {

    }

    @Interval(1000 * 5)
    public async insertClients() {
        if (this.insertQueue.length === 0) {
            return;
        }

        const queueCopy = [...this.insertQueue];
        this.insertQueue = [];

        const results = await this.clientRepository.insert(queueCopy.map(c => c.partialClient));

        queueCopy.forEach((c, index) => {
            c.result.next(results.generatedMaps[index]);
        });
    }

    /**
     * Queue a heartbeat update for batch flushing. Non-blocking — safe to call from stratum event loop.
     */
    public queueHeartbeat(address: string, clientName: string, sessionId: string, hashRate: number, updatedAt: Date) {
        const key = `${address}:${clientName}:${sessionId}`;
        this.heartbeatQueue.set(key, { hashRate, updatedAt });
    }

    /**
     * Flush all queued heartbeats to DB in a single batch every 30 seconds.
     * Uses a single UPDATE per batch with CASE expressions for efficiency.
     */
    @Interval(30000)
    public async flushHeartbeats() {
        if (this.heartbeatQueue.size === 0) return;

        const batch = Array.from(this.heartbeatQueue.entries());
        this.heartbeatQueue.clear();

        try {
            // Build bulk UPDATE using unnest for PostgreSQL
            const addresses: string[] = [];
            const clientNames: string[] = [];
            const sessionIds: string[] = [];
            const hashRates: number[] = [];
            const updatedAts: Date[] = [];

            batch.forEach(([key, data]) => {
                const [address, clientName, sessionId] = key.split(':');
                addresses.push(address);
                clientNames.push(clientName);
                sessionIds.push(sessionId);
                hashRates.push(data.hashRate);
                updatedAts.push(data.updatedAt);
            });

            await this.clientRepository.query(`
                UPDATE client_entity AS t
                SET "hashRate" = v."hashRate",
                    "updatedAt" = v."updatedAt",
                    "deletedAt" = NULL
                FROM (
                    SELECT unnest($1::varchar[]) as address,
                           unnest($2::varchar[]) as "clientName",
                           unnest($3::varchar[]) as "sessionId",
                           unnest($4::real[]) as "hashRate",
                           unnest($5::timestamptz[]) as "updatedAt"
                ) AS v(address, "clientName", "sessionId", "hashRate", "updatedAt")
                WHERE t.address = v.address
                  AND t."clientName" = v."clientName"
                  AND t."sessionId" = v."sessionId"
            `, [addresses, clientNames, sessionIds, hashRates, updatedAts]);
        } catch (e: any) {
            console.error('Batch heartbeat flush failed:', e?.message ?? String(e));
            // Re-queue failed items
            batch.forEach(([key, data]) => {
                this.heartbeatQueue.set(key, data);
            });
        }
    }

    async onModuleDestroy() {
        await this.flushHeartbeats();
    }

    public async killDeadClients() {
        var fiveMinutes = new Date(new Date().getTime() - (5 * 60 * 1000)).toISOString();

        return await this.clientRepository
            .createQueryBuilder()
            .update(ClientEntity)
            .set({ deletedAt: () => 'NOW()' })
            .where('"deletedAt" IS NULL AND "updatedAt" < :fiveMinutes::timestamptz', { fiveMinutes })
            .execute();
    }

    public async heartbeat(address: string, clientName: string, sessionId: string, hashRate: number, updatedAt: Date) {
        return await this.clientRepository.update({ address, clientName, sessionId }, { hashRate, deletedAt: null, updatedAt });
    }

    // public async save(client: Partial<ClientEntity>) {
    //     return await this.clientRepository.save(client);
    // }


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
            .where('deletedAt < :deletedAt', { deletedAt: oneDayAgo })
            .execute();

    }

    public async updateBestDifficulty(sessionId: string, bestDifficulty: number) {
        return await this.clientRepository.update({ sessionId }, { bestDifficulty });
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
