import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

/**
 * PostgreSQL LISTEN/NOTIFY service for real-time inter-process communication.
 * Replaces polling-based mechanisms (chain_state, rpc_block) with event-driven notifications.
 * 
 * Channels:
 * - 'new_block': Leader broadcasts new block height to all workers
 * - 'template_ready': Leader broadcasts when block template is fully processed
 */
@Injectable()
export class PgNotifyService implements OnModuleInit, OnModuleDestroy {
    private listenClient: Client;
    private handlers = new Map<string, Set<(payload: string) => void>>();
    private readyResolve: () => void;
    private readyPromise: Promise<void>;

    constructor(
        private readonly configService: ConfigService,
        private readonly dataSource: DataSource,
    ) {
        this.readyPromise = new Promise((resolve) => {
            this.readyResolve = resolve;
        });
    }

    async onModuleInit() {
        this.listenClient = new Client({
            host: this.configService.get('DB_HOST') || 'localhost',
            port: parseInt(this.configService.get('DB_PORT') || '5432', 10),
            user: this.configService.get('DB_USER') || 'publicpool',
            password: this.configService.get('DB_PASSWORD') || 'publicpool',
            database: this.configService.get('DB_NAME') || 'publicpool',
        });

        this.listenClient.on('notification', (msg) => {
            const handlers = this.handlers.get(msg.channel);
            if (handlers) {
                handlers.forEach((h) => {
                    try {
                        h(msg.payload);
                    } catch (e) {
                        console.error(`NOTIFY handler error on ${msg.channel}:`, e);
                    }
                });
            }
        });

        this.listenClient.on('error', (err) => {
            console.error('PgNotify LISTEN client error:', err.message);
        });

        await this.listenClient.connect();
        this.readyResolve();
        console.log('PgNotify LISTEN client connected');
    }

    async onModuleDestroy() {
        if (this.listenClient) {
            await this.listenClient.end().catch(() => {});
        }
    }

    whenReady(): Promise<void> {
        return this.readyPromise;
    }

    async listen(channel: string, handler: (payload: string) => void): Promise<void> {
        if (!this.handlers.has(channel)) {
            this.handlers.set(channel, new Set());
            await this.listenClient.query(`LISTEN ${channel}`);
        }
        this.handlers.get(channel).add(handler);
    }

    async unlisten(channel: string, handler: (payload: string) => void): Promise<void> {
        const handlers = this.handlers.get(channel);
        if (handlers) {
            handlers.delete(handler);
            if (handlers.size === 0) {
                await this.listenClient.query(`UNLISTEN ${channel}`);
                this.handlers.delete(channel);
            }
        }
    }

    async notify(channel: string, payload?: string): Promise<void> {
        // Use parameterized query to safely escape payload
        if (payload != null && payload.length > 0) {
            await this.dataSource.query('SELECT pg_notify($1, $2)', [channel, payload]);
        } else {
            await this.dataSource.query('SELECT pg_notify($1, NULL)', [channel]);
        }
    }
}
