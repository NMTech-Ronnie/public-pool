import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import { ChainStateService } from '../ORM/chain-state/chain-state.service';
import { LeaderElectionService } from './leader-election.service';
import * as zmq from 'zeromq';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import * as fs from 'node:fs';

@Injectable()
export class BitcoinRpcService implements OnModuleInit {

    private blockHeight = 0;
    private client: RPCClient;
    private _newBlock$: BehaviorSubject<IMiningInfo> = new BehaviorSubject(undefined);
    public newBlock$ = this._newBlock$.pipe(filter(block => block != null), shareReplay({ refCount: true, bufferSize: 1 }));

    constructor(
        private readonly configService: ConfigService,
        private rpcBlockService: RpcBlockService,
        private readonly chainStateService: ChainStateService,
        private readonly leaderElectionService: LeaderElectionService,
    ) {
    }

    // Configurable polling intervals for resource-constrained environments
    private readonly LEADER_POLL_MS = parseInt(process.env.BITCOIN_POLL_MS || '500');
    private readonly WORKER_POLL_MS = parseInt(process.env.WORKER_POLL_MS || '1000');

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
                setInterval(this.pollMiningInfo.bind(this), this.LEADER_POLL_MS);
            }
        } else {
            // Workers poll chain_state table to detect new blocks
            setInterval(this.pollChainState.bind(this), this.WORKER_POLL_MS);
        }
    }

    private async listenForNewBlocks(sock: zmq.Subscriber) {
        for await (const [topic, msg] of sock) {
            console.log("New Block");
            await this.pollMiningInfo();
        }
    }

    private async pollChainState() {
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
        while (true) {
            await new Promise(r => setTimeout(r, 100));

            const block = await this.rpcBlockService.getBlock(blockHeight);
            if (block != null && block.data != null) {
                console.log(`promise loop resolved, block height ${blockHeight}`);
                return Promise.resolve(JSON.parse(block.data));
            }
            console.log(`promise loop, block height ${blockHeight}`);
        }
    }

    public async getBlockTemplate(blockHeight: number): Promise<IBlockTemplate> {
        let result: IBlockTemplate;
        try {
            const block = await this.rpcBlockService.getBlock(blockHeight);
            const completeBlock = block?.data != null;

            if (completeBlock) {
                return Promise.resolve(JSON.parse(block.data));
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
        } catch (e) {
            console.error('Error getblocktemplate:', e.message);
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
        } catch (e) {
            console.error('Error getmininginfo', e.message);
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
        } catch (e) {
            response = e;
            console.log(`BLOCK SUBMISSION RESPONSE ERROR: ${e}`);
        }
        return response;

    }
}
