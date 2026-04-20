import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import { ChainStateService } from '../ORM/chain-state/chain-state.service';
import { LeaderElectionService } from './leader-election.service';
import { PgNotifyService } from './pg-notify.service';
import * as zmq from 'zeromq';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import * as fs from 'node:fs';

@Injectable()
export class BitcoinRpcService implements OnModuleInit, OnModuleDestroy {

    private blockHeight = 0;
    private client: RPCClient;
    private _newBlock$: BehaviorSubject<IMiningInfo> = new BehaviorSubject(undefined);
    public newBlock$ = this._newBlock$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    // Template ready promise for waitForBlock() — resolves when NOTIFY arrives
    private templateReadyResolvers = new Map<number, (value: IBlockTemplate) => void>();

    // Notification handlers for cleanup
    private newBlockHandler: (payload: string) => void;
    private templateReadyHandler: (payload: string) => void;
    private leaderPollInterval: NodeJS.Timeout;
    private workerPollInterval: NodeJS.Timeout;

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService,
        private readonly chainStateService: ChainStateService,
        private readonly leaderElectionService: LeaderElectionService,
        private readonly pgNotifyService: PgNotifyService,
    ) {
    }

    // Configurable polling intervals for resource-constrained environments
    private readonly LEADER_POLL_MS = parseInt(process.env.BITCOIN_POLL_MS || '500');
    private readonly WORKER_POLL_MS = parseInt(process.env.WORKER_POLL_MS || '5000');

    async onModuleInit() {
        const url = this.configService.get('BITCOIN_RPC_URL');
        let user = this.configService.get('BITCOIN_RPC_USER');
        let pass = this.configService.get('BITCOIN_RPC_PASSWORD');
        const port = parseInt(this.configService.get('BITCOIN_RPC_PORT'));
        const timeout = parseInt(this.configService.get('BITCOIN_RPC_TIMEOUT'));

        const cookiefile = this.configService.get('BITCOIN_RPC_COOKIEFILE')

        if (cookiefile != undefined && cookiefile != '') {
            const cookie = fs.readFileSync(cookiefile).toString().split(':')

            user = cookie[0]
            pass = cookie[1]
        }

        this.client = new RPCClient({ url, port, timeout, user, pass });

        this.client.getrpcinfo().then((res) => {
            console.log('Bitcoin RPC connected');
        }, () => {
            console.error('Could not reach RPC host');
        });

        if (this.leaderElectionService.getIsLeader()) {
            if (this.configService.get('BITCOIN_ZMQ_HOST')) {
                console.log('Using ZMQ');
                const sock = new zmq.Subscriber;


                sock.connectTimeout = 1000;
                sock.events.on('connect', () => {
                    console.log('ZMQ Connected');
                });
                sock.events.on('connect:retry', () => {
                    console.log('ZMQ Unable to connect, Retrying');
                });

                sock.connect(this.configService.get('BITCOIN_ZMQ_HOST'));
                sock.subscribe('rawblock');
                // Don't await this, otherwise it will block the rest of the program
                this.listenForNewBlocks(sock);
                await this.pollMiningInfo();

            } else {
                this.leaderPollInterval = setInterval(this.pollMiningInfo.bind(this), this.LEADER_POLL_MS);
            }
        } else {
            // Workers primarily use LISTEN/NOTIFY. Keep slow polling fallback for resilience.
            try {
                await this.pgNotifyService.whenReady();

                this.newBlockHandler = (payload: string) => {
                    const height = parseInt(payload, 10);
                    if (!Number.isNaN(height)) {
                        this.handleNewBlockNotification(height).catch((e) => {
                            console.error('Error handling new_block notification:', e.message);
                        });
                    }
                };
                this.templateReadyHandler = (payload: string) => {
                    const height = parseInt(payload, 10);
                    if (!Number.isNaN(height)) {
                        this.handleTemplateReadyNotification(height).catch((e) => {
                            console.error('Error handling template_ready notification:', e.message);
                        });
                    }
                };

                await this.pgNotifyService.listen('new_block', this.newBlockHandler);
                await this.pgNotifyService.listen('template_ready', this.templateReadyHandler);

                console.log('Worker registered LISTEN channels: new_block, template_ready');
            } catch (e: any) {
                console.error('Worker LISTEN registration failed, falling back to polling:', e?.message ?? String(e));
            }

            // Ensure workers can produce jobs even if a NOTIFY is missed.
            await this.pollChainState();
            this.workerPollInterval = setInterval(this.pollChainState.bind(this), this.WORKER_POLL_MS);
        }
    }

    onModuleDestroy() {
        if (this.leaderPollInterval) {
            clearInterval(this.leaderPollInterval);
        }
        if (this.workerPollInterval) {
            clearInterval(this.workerPollInterval);
        }
        if (this.newBlockHandler) {
            this.pgNotifyService.unlisten('new_block', this.newBlockHandler).catch(() => {});
        }
        if (this.templateReadyHandler) {
            this.pgNotifyService.unlisten('template_ready', this.templateReadyHandler).catch(() => {});
        }
    }

    private async handleNewBlockNotification(height: number) {
        if (height > this.blockHeight) {
            console.log('Worker received new_block NOTIFY:', height);
            const miningInfo = await this.getMiningInfo();
            if (miningInfo != null) {
                this._newBlock$.next(miningInfo);
                this.blockHeight = Math.max(this.blockHeight, height);
            }
        }
    }

    private async handleTemplateReadyNotification(height: number) {
        console.log('Worker received template_ready NOTIFY:', height);
        const resolver = this.templateReadyResolvers.get(height);
        if (resolver) {
            // Try processed template first (fast path — skips Merkle tree recomputation)
            const processed = await this.rpcBlockService.getProcessedTemplate(height);
            if (processed) {
                try {
                    const template = this.parseTemplate(processed);
                    resolver(template);
                    this.templateReadyResolvers.delete(height);
                    return;
                } catch (e: any) {
                    console.error('Failed to parse processed template:', e?.message ?? String(e));
                }
            }
            // Fallback: fetch raw template data from Bitcoin RPC response
            const block = await this.rpcBlockService.getBlock(height);
            if (block?.data) {
                try {
                    const template = this.parseTemplate(block.data);
                    resolver(template);
                } catch (e: any) {
                    console.error('Failed to parse raw template:', e?.message ?? String(e));
                }
            }
            this.templateReadyResolvers.delete(height);
        }
    }

    private async listenForNewBlocks(sock: zmq.Subscriber) {
        for await (const [topic, msg] of sock) {
            console.log("New Block");
            await this.pollMiningInfo();
        }
    }

    private async pollChainState() {
        // Fallback polling if LISTEN/NOTIFY is unavailable (should not happen normally)
        const height = await this.chainStateService.getHeight();
        if (height != null && height > this.blockHeight) {
            console.log("Worker detected block height change via chain_state:", height);
            const miningInfo = await this.getMiningInfo();
            if (miningInfo != null) {
                this._newBlock$.next(miningInfo);
                this.blockHeight = height;
            }
        }
    }

    public async pollMiningInfo() {
        const miningInfo = await this.getMiningInfo();
        if (miningInfo != null && miningInfo.blocks > this.blockHeight) {
            console.log("block height change");
            this._newBlock$.next(miningInfo);
            this.blockHeight = miningInfo.blocks;
            await this.chainStateService.updateHeight(miningInfo.blocks);
        }
    }

    private async waitForBlock(blockHeight: number): Promise<IBlockTemplate> {
        const available = await this.getStoredTemplate(blockHeight);
        if (available) {
            return available;
        }

        // Wait for template_ready NOTIFY. Re-check DB after handler registration to close race window.
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.templateReadyResolvers.delete(blockHeight);
                reject(new Error(`Timeout waiting for template_ready at height ${blockHeight}`));
            }, 30000); // 30s timeout

            this.templateReadyResolvers.set(blockHeight, (template) => {
                clearTimeout(timeout);
                resolve(template);
            });

            this.getStoredTemplate(blockHeight)
                .then((template) => {
                    if (template) {
                        const resolver = this.templateReadyResolvers.get(blockHeight);
                        if (resolver) {
                            resolver(template);
                        }
                    }
                })
                .catch(() => {});
        });
    }

    public async getBlockTemplate(blockHeight: number): Promise<IBlockTemplate> {
        let result: IBlockTemplate;
        try {
            const block = await this.rpcBlockService.getBlock(blockHeight);

            // PERFORMANCE: If leader already stored processed template, use it directly
            if (block?.processedData) {
                return this.parseTemplate(block.processedData);
            }

            const completeBlock = block?.data != null;

            if (completeBlock) {
                return Promise.resolve(this.parseTemplate(block.data));
            }

            // Try to acquire lock using database unique constraint
            try {
                const processId = `proc-${process.pid}`;
                await this.rpcBlockService.lockBlock(blockHeight, processId);
            } catch (e) {
                // Another process has the lock, wait for it
                result = await this.waitForBlock(blockHeight);
                console.log(`getblocktemplate tx count: ${result.transactions.length}`);
                return result;
            }

            result = await this.loadBlockTemplate(blockHeight);
        } catch (e: any) {
            console.error('Error getblocktemplate:', e?.message ?? String(e));
            throw new Error('Error getblocktemplate');
        }
        console.log(`getblocktemplate tx count: ${result.transactions.length}`);
        return result;
    }

    private async loadBlockTemplate(blockHeight: number) {

        let blockTemplate: IBlockTemplate;
        while (blockTemplate == null) {
            blockTemplate = await this.client.getblocktemplate({
                template_request: {
                    rules: ['segwit'],
                    mode: 'template',
                    capabilities: ['serverlist', 'proposal']
                }
            });
        }


        await this.rpcBlockService.saveBlock(blockHeight, JSON.stringify(blockTemplate));

        return blockTemplate;
    }

    public async getMiningInfo(): Promise<IMiningInfo> {
        try {
            return await this.client.getmininginfo();
        } catch (e: any) {
            console.error('Error getmininginfo', e?.message ?? String(e));
            return null;
        }

    }

    public async SUBMIT_BLOCK(hexdata: string): Promise<string> {
        let response: string = 'unknown';
        try {
            response = await this.client.submitblock({
                hexdata
            });
            if (response == null) {
                response = 'SUCCESS!';
            }
            console.log(`BLOCK SUBMISSION RESPONSE: ${response}`);
            console.log(hexdata);
            console.log(JSON.stringify(response));
        } catch (e: any) {
            response = e?.message ?? String(e);
            console.log(`BLOCK SUBMISSION RESPONSE ERROR: ${response}`);
        }
        return response;

    }

    private parseTemplate(payload: string): IBlockTemplate {
        return JSON.parse(payload, (_key, value) => {
            if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
                return Buffer.from(value.data);
            }
            return value;
        }) as IBlockTemplate;
    }

    private async getStoredTemplate(blockHeight: number): Promise<IBlockTemplate | null> {
        const processed = await this.rpcBlockService.getProcessedTemplate(blockHeight);
        if (processed) {
            try {
                return this.parseTemplate(processed);
            } catch (e: any) {
                console.error('Failed to parse processed template:', e?.message ?? String(e));
            }
        }

        const block = await this.rpcBlockService.getBlock(blockHeight);
        if (block?.data) {
            try {
                return this.parseTemplate(block.data);
            } catch (e: any) {
                console.error('Failed to parse raw template:', e?.message ?? String(e));
            }
        }

        return null;
    }
}
