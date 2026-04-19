import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class LeaderElectionService implements OnModuleInit, OnModuleDestroy {
    private readonly LEADER_LOCK_ID = 4242;
    private isLeader = false;
    private leaderCheckInterval: NodeJS.Timer;

    constructor(private readonly dataSource: DataSource) {}

    async onModuleInit() {
        await this.tryAcquireLeadership();

        // Periodically try to become leader (in case current leader crashes)
        this.leaderCheckInterval = setInterval(async () => {
            if (!this.isLeader) {
                await this.tryAcquireLeadership();
            }
        }, 10000);
    }

    onModuleDestroy() {
        if (this.leaderCheckInterval) {
            clearInterval(this.leaderCheckInterval);
        }
        if (this.isLeader) {
            this.dataSource
                .query('SELECT pg_advisory_unlock($1)', [this.LEADER_LOCK_ID])
                .catch(() => {});
        }
    }

    private async tryAcquireLeadership() {
        try {
            const result = await this.dataSource.query(
                'SELECT pg_try_advisory_lock($1)',
                [this.LEADER_LOCK_ID],
            );
            const acquired = result[0]?.pg_try_advisory_lock === true;
            if (acquired && !this.isLeader) {
                this.isLeader = true;
                console.log('This instance is the LEADER');
            }
        } catch (e) {
            console.error('Leader election error:', e.message);
        }
    }

    public getIsLeader(): boolean {
        return this.isLeader;
    }
}
