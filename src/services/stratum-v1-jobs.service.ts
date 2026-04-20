import { Injectable } from '@nestjs/common';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';
import { combineLatest, delay, filter, from, interval, map, Observable, shareReplay, startWith, switchMap, tap } from 'rxjs';

import { MiningJob } from '../models/MiningJob';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { JobIdService } from './job-id.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';

export interface IJobTemplate {

    block: bitcoinjs.Block;
    merkle_branch: string[];
    blockData: {
        id: string,
        creation: number,
        coinbasevalue: number;
        networkDifficulty: number;
        height: number;
        clearJobs: boolean;
    };
}

@Injectable()
export class StratumV1JobsService {

    private lastIntervalCount: number;
    private skipNext: boolean = false;
    public newMiningJob$: Observable<IJobTemplate>;

    public jobs: { [jobId: string]: MiningJob } = {};

    public blocks: { [id: number]: IJobTemplate } = {};

    // Configurable cache TTL to adapt to memory constraints (default 2 min, was 5 min)
    private readonly JOB_TTL_MS = parseInt(process.env.JOB_CACHE_TTL_MS || '120000');

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly jobIdService: JobIdService,
        private readonly rpcBlockService: RpcBlockService,
    ) {

        this.newMiningJob$ = combineLatest([this.bitcoinRpcService.newBlock$, interval(60000).pipe(delay(0), startWith(-1))]).pipe(
            switchMap(([miningInfo, interval]) => {
                return from(this.bitcoinRpcService.getBlockTemplate(miningInfo.blocks)).pipe(map((blockTemplate) => {
                    return {
                        blockTemplate,
                        interval
                    }
                }))
            }),
            map(({ blockTemplate, interval }) => {

                let clearJobs = false;
                if (this.lastIntervalCount === interval) {
                    clearJobs = true;
                    this.skipNext = true;
                }

                if (this.skipNext == true && clearJobs == false) {
                    this.skipNext = false;
                    return null;
                }

                this.lastIntervalCount = interval;

                const currentTime = Math.floor(new Date().getTime() / 1000);
                return {
                    version: blockTemplate.version,
                    bits: parseInt(blockTemplate.bits, 16),
                    prevHash: this.convertToLittleEndian(blockTemplate.previousblockhash),
                    transactions: blockTemplate.transactions.map(t => bitcoinjs.Transaction.fromHex(t.data)),
                    coinbasevalue: blockTemplate.coinbasevalue,
                    timestamp: blockTemplate.mintime > currentTime ? blockTemplate.mintime : currentTime,
                    networkDifficulty: this.calculateNetworkDifficulty(parseInt(blockTemplate.bits, 16)),
                    clearJobs,
                    height: blockTemplate.height
                };
            }),
            filter(next => next != null),
            switchMap(async ({ version, bits, prevHash, transactions, timestamp, coinbasevalue, networkDifficulty, clearJobs, height }) => {
                const block = new bitcoinjs.Block();

                //create an empty coinbase tx
                const tempCoinbaseTx = new bitcoinjs.Transaction();
                tempCoinbaseTx.version = 2;
                tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
                tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
                transactions.unshift(tempCoinbaseTx);

                const transactionBuffers = transactions.map(tx => tx.getHash(false));

                const merkleTree = merkle(transactionBuffers, bitcoinjs.crypto.hash256);
                const merkleBranches: Buffer[] = merkleProof(merkleTree, transactionBuffers[0]).filter(h => h != null);
                block.merkleRoot = merkleBranches.pop();

                // remove the first (coinbase) and last (root) element from the branch
                const merkle_branch = merkleBranches.slice(1, merkleBranches.length).map(b => b.toString('hex'))

                block.prevHash = prevHash;
                block.version = version;
                block.bits = bits;
                block.timestamp = timestamp;

                block.transactions = transactions;
                block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(transactions, true);

                const id = await this.jobIdService.getNextTemplateId();
                return {
                    block,
                    merkle_branch,
                    blockData: {
                        id,
                        creation: new Date().getTime(),
                        coinbasevalue,
                        networkDifficulty,
                        height,
                        clearJobs
                    }
                }
            }),
            tap((data) => {
                if (data.blockData.clearJobs) {
                    this.blocks = {};
                    this.jobs = {};
                }else{
                    const now = new Date().getTime();
                    // Delete old templates (configurable TTL)
                    for(const templateId in this.blocks){
                        if(now - this.blocks[templateId].blockData.creation  > this.JOB_TTL_MS){
                            delete this.blocks[templateId];
                        }
                    }
                    // Delete old jobs (configurable TTL)
                    for (const jobId in this.jobs) {
                        if(now - this.jobs[jobId].creation > this.JOB_TTL_MS){
                            delete this.jobs[jobId];
                        }
                    }
                }
                this.blocks[data.blockData.id] = data;

                // Store fully-processed template for workers to reuse (skips redundant Merkle tree computation)
                this.rpcBlockService.saveProcessedTemplate(data.blockData.height, JSON.stringify(data))
                    .catch(e => console.error('Failed to save processed template:', e));
            }),
            shareReplay({ refCount: true, bufferSize: 1 })
        )
    }

    private calculateNetworkDifficulty(nBits: number) {
        const mantissa: number = nBits & 0x007fffff;       // Extract the mantissa from nBits
        const exponent: number = (nBits >> 24) & 0xff;       // Extract the exponent from nBits

        const target: number = mantissa * Math.pow(256, (exponent - 3));   // Calculate the target value

        const maxTarget = Math.pow(2, 208) * 65535; // Easiest target (max_target)
        const difficulty: number = maxTarget / target;    // Calculate the difficulty

        return difficulty;
    }

    private convertToLittleEndian(hash: string): Buffer {
        const bytes = Buffer.from(hash, 'hex');
        Array.prototype.reverse.call(bytes);
        return bytes;
    }

    public getJobTemplateById(jobTemplateId: string): IJobTemplate | null {
        return this.blocks[jobTemplateId];
    }

    public async addJob(job: MiningJob) {
        this.jobs[job.jobId] = job;
    }

    public getJobById(jobId: string) {
        return this.jobs[jobId];
    }

    public async getNextTemplateId(): Promise<string> {
        return this.jobIdService.getNextTemplateId();
    }

    public async getNextId(): Promise<string> {
        return this.jobIdService.getNextJobId();
    }


}
