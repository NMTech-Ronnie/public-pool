import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';
import { combineLatest, delay, filter, from, interval, map, Observable, shareReplay, startWith, switchMap, tap } from 'rxjs';

import { SharedMiningJob, MinerJobRef } from '../models/MiningJob';
import { BitcoinRpcService } from './bitcoin-rpc.service';

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

    public latestJobId: number = 1;
    public latestJobTemplateId: number = 1;

    /** Per-miner job refs (lightweight) */
    public jobs: { [jobId: string]: MinerJobRef } = {};

    /**
     * Shared job templates. Cache key is `${minerAddress}|${noFee?'1':'0'}::${templateId}`.
     * This means N ASIC miners pointing to the same address share ONE SharedMiningJob
     * per template, which is the realistic sharing case.
     */
    public sharedJobs: { [key: string]: SharedMiningJob } = {};

    public blocks: { [id: number]: IJobTemplate } = {};

    /** Cached network and fee config */
    private network: bitcoinjs.networks.Network;
    private devFeeAddress: string | null;

    // offset the interval so that all the cluster processes don't try and refresh at the same time.
    private delay = process.env.NODE_APP_INSTANCE == null ? 0 : parseInt(process.env.NODE_APP_INSTANCE) * 5000;

    constructor(
        private readonly bitcoinRpcService: BitcoinRpcService,
        private readonly configService: ConfigService,
    ) {

        // Resolve network once
        const networkConfig = this.configService.get('NETWORK');
        if (networkConfig === 'mainnet') {
            this.network = bitcoinjs.networks.bitcoin;
        } else if (networkConfig === 'testnet') {
            this.network = bitcoinjs.networks.testnet;
        } else if (networkConfig === 'regtest') {
            this.network = bitcoinjs.networks.regtest;
        } else {
            this.network = bitcoinjs.networks.bitcoin;
        }

        this.devFeeAddress = this.configService.get('DEV_FEE_ADDRESS') || null;
        if (this.devFeeAddress && this.devFeeAddress.length < 1) {
            this.devFeeAddress = null;
        }

        this.newMiningJob$ = combineLatest([this.bitcoinRpcService.newBlock$, interval(60000).pipe(delay(this.delay), startWith(-1))]).pipe(
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
                    console.log('new block')
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
            map(({ version, bits, prevHash, transactions, timestamp, coinbasevalue, networkDifficulty, clearJobs, height }) => {
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

                const id = this.getNextTemplateId();
                this.latestJobTemplateId++;
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
                    this.sharedJobs = {};
                }else{
                    const now = new Date().getTime();
                    // H1 fix: shared jobs / templates live LONGER than per-miner refs,
                    // so a late-arriving share whose ref still exists can always resolve
                    // its template + sharedJob. Refs expire at 5 min, blocks/sharedJobs at 7 min.
                    const REF_TTL = 1000 * 60 * 5;
                    const TEMPLATE_TTL = 1000 * 60 * 7;
                    for (const templateId in this.blocks) {
                        if (now - this.blocks[templateId].blockData.creation > TEMPLATE_TTL) {
                            delete this.blocks[templateId];
                        }
                    }
                    for (const jobId in this.jobs) {
                        if (now - this.jobs[jobId].creation > REF_TTL) {
                            delete this.jobs[jobId];
                        }
                    }
                    for (const key in this.sharedJobs) {
                        if (now - this.sharedJobs[key].creation > TEMPLATE_TTL) {
                            delete this.sharedJobs[key];
                        }
                    }
                }
                this.blocks[data.blockData.id] = data;
            }),
            shareReplay({ refCount: true, bufferSize: 1 })
        )
    }

    /**
     * Get or create a SharedMiningJob for the given miner address + payout variant.
     * Cache key uses ONLY the miner address + noFee flag, so multiple ASICs from
     * the same wallet share the same cached coinbase + notify payload.
     */
    public getOrCreateSharedJob(
        minerAddress: string,
        noFee: boolean,
        jobTemplate: IJobTemplate
    ): SharedMiningJob {
        const cacheKey = `${minerAddress}|${noFee ? '1' : '0'}::${jobTemplate.blockData.id}`;

        let shared = this.sharedJobs[cacheKey];
        if (!shared) {
            const payoutInformation = (noFee || !this.devFeeAddress)
                ? [{ address: minerAddress, percent: 100 }]
                : [
                    { address: this.devFeeAddress, percent: 1.5 },
                    { address: minerAddress, percent: 98.5 }
                ];
            shared = new SharedMiningJob(
                this.configService,
                this.network,
                payoutInformation,
                jobTemplate
            );
            this.sharedJobs[cacheKey] = shared;
        }
        return shared;
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

    public addMinerJobRef(ref: MinerJobRef) {
        this.jobs[ref.jobId] = ref;
        this.latestJobId++;
    }

    public getJobById(jobId: string): MinerJobRef | undefined {
        return this.jobs[jobId];
    }

    public getNextTemplateId() {
        return this.latestJobTemplateId.toString(16);
    }
    public getNextId() {
        return this.latestJobId.toString(16);
    }


}
