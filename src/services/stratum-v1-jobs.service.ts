import { Injectable } from '@nestjs/common';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as merkle from 'merkle-lib';
import * as merkleProof from 'merkle-lib/proof';
import {
  catchError,
  combineLatest,
  delay,
  EMPTY,
  filter,
  from,
  interval,
  map,
  Observable,
  shareReplay,
  startWith,
  switchMap,
  tap,
} from 'rxjs';

import { MiningJob } from '../models/MiningJob';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { ConfigService } from '@nestjs/config';

export interface IJobTemplate {
  block: bitcoinjs.Block;
  merkle_branch: string[];
  blockData: {
    id: string;
    creation: number;
    coinbasevalue: number;
    networkDifficulty: number;
    height: number;
    clearJobs: boolean;
    blockWeight: number;
  };
}

export interface CachedJob {
  job: MiningJob;
  responseClean: string;
  responseClear: string;
}

@Injectable()
export class StratumV1JobsService {
  private lastIntervalCount: number;
  private skipNext = false;
  public newMiningJob$: Observable<IJobTemplate>;

  public latestJobId = 1;
  public latestJobTemplateId = 1;

  public jobs: { [jobId: string]: MiningJob } = {};

  public blocks: { [id: number]: IJobTemplate } = {};

  private cachedJobs: Map<string, CachedJob> = new Map();

  public latestStoredTemplateId: string = null;

  // offset the interval so that all the cluster processes don't try and refresh at the same time.
  private delay =
    process.env.NODE_APP_INSTANCE == null
      ? 0
      : parseInt(process.env.NODE_APP_INSTANCE) * 5000;

  constructor(
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly configService: ConfigService,
  ) {
    this.newMiningJob$ = combineLatest([
      this.bitcoinRpcService.newBlock$,
      interval(60000).pipe(delay(this.delay), startWith(-1)),
    ]).pipe(
      switchMap(([miningInfo, interval]) => {
        return from(
          this.bitcoinRpcService.getBlockTemplate(miningInfo.blocks),
        ).pipe(
          map((blockTemplate) => {
            return {
              blockTemplate,
              interval,
            };
          }),
          catchError((error) => {
            console.error(`[Jobs] getBlockTemplate failed: ${error.message}`);
            return EMPTY;
          }),
        );
      }),
      map(({ blockTemplate, interval }) => {
        let clearJobs = false;
        if (this.lastIntervalCount === interval) {
          clearJobs = true;
          this.skipNext = true;
          console.log('new block');
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
          transactions: blockTemplate.transactions.map((t) =>
            bitcoinjs.Transaction.fromHex(t.data),
          ),
          coinbasevalue: blockTemplate.coinbasevalue,
          timestamp:
            blockTemplate.mintime > currentTime
              ? blockTemplate.mintime
              : currentTime,
          networkDifficulty: this.calculateNetworkDifficulty(
            parseInt(blockTemplate.bits, 16),
          ),
          clearJobs,
          height: blockTemplate.height,
        };
      }),
      filter((next) => next != null),
      map(
        ({
          version,
          bits,
          prevHash,
          transactions,
          timestamp,
          coinbasevalue,
          networkDifficulty,
          clearJobs,
          height,
        }) => {
          const block = new bitcoinjs.Block();

          //create an empty coinbase tx
          const tempCoinbaseTx = new bitcoinjs.Transaction();
          tempCoinbaseTx.version = 2;
          tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
          tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
          transactions.unshift(tempCoinbaseTx);

          const transactionBuffers = transactions.map((tx) =>
            tx.getHash(false),
          );

          const merkleTree = merkle(
            transactionBuffers,
            bitcoinjs.crypto.hash256,
          );
          const merkleBranches: Buffer[] = merkleProof(
            merkleTree,
            transactionBuffers[0],
          ).filter((h) => h != null);
          block.merkleRoot = merkleBranches.pop();

          // remove the first (coinbase) and last (root) element from the branch
          const merkle_branch = merkleBranches
            .slice(1, merkleBranches.length)
            .map((b) => b.toString('hex'));

          block.prevHash = prevHash;
          block.version = version;
          block.bits = bits;
          block.timestamp = timestamp;

          block.transactions = transactions;
          block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(
            transactions,
            true,
          );

          // Pre-compute block weight before transactions may be stripped
          const blockWeight = block.weight();

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
              clearJobs,
              blockWeight,
            },
          };
        },
      ),
      tap((data) => {
        if (data.blockData.clearJobs) {
          this.blocks = {};
          this.jobs = {};
          this.cachedJobs.clear();
        } else {
          const now = new Date().getTime();
          // Delete old templates (5 minutes)
          for (const templateId in this.blocks) {
            if (
              now - this.blocks[templateId].blockData.creation >
              1000 * 60 * 5
            ) {
              delete this.blocks[templateId];
            }
          }
          // Delete old jobs (5 minutes)
          for (const jobId in this.jobs) {
            if (now - this.jobs[jobId].creation > 1000 * 60 * 5) {
              delete this.jobs[jobId];
            }
          }
          // Delete cached jobs for expired templates
          for (const key of this.cachedJobs.keys()) {
            const templateId = key.split('_')[0];
            if (!(templateId in this.blocks)) {
              this.cachedJobs.delete(key);
            }
          }
        }
        // Strip transactions from previous templates to save memory.
        // Each template holds ~3000 parsed Transaction objects (~12MB).
        // Only the latest template keeps transactions for the rare block-found case.
        for (const templateId in this.blocks) {
          const tpl = this.blocks[templateId];
          if (tpl.block.transactions && tpl.block.transactions.length > 1) {
            tpl.block.transactions = null;
          }
        }
        this.blocks[data.blockData.id] = data;
        this.latestStoredTemplateId = data.blockData.id;
      }),
      shareReplay({ refCount: true, bufferSize: 1 }),
    );
  }

  private calculateNetworkDifficulty(nBits: number) {
    const mantissa: number = nBits & 0x007fffff; // Extract the mantissa from nBits
    const exponent: number = (nBits >> 24) & 0xff; // Extract the exponent from nBits

    const target: number = mantissa * Math.pow(256, exponent - 3); // Calculate the target value

    const maxTarget = Math.pow(2, 208) * 65535; // Easiest target (max_target)
    const difficulty: number = maxTarget / target; // Calculate the difficulty

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

  public addJob(job: MiningJob) {
    this.jobs[job.jobId] = job;
    this.latestJobId++;
  }

  public getJobById(jobId: string) {
    return this.jobs[jobId];
  }

  public getNextTemplateId() {
    return this.latestJobTemplateId.toString(16);
  }
  public getNextId() {
    return this.latestJobId.toString(16);
  }

  public getOrCreateCachedJob(
    network: bitcoinjs.networks.Network,
    payoutInformation: { address: string; percent: number }[],
    jobTemplate: IJobTemplate,
    cacheKey: string,
  ): CachedJob {
    const fullKey = `${jobTemplate.blockData.id}_${cacheKey}`;

    let cached = this.cachedJobs.get(fullKey);
    if (!cached) {
      const job = new MiningJob(
        this.configService,
        network,
        this.getNextId(),
        payoutInformation,
        jobTemplate,
      );
      this.addJob(job);
      cached = {
        job,
        responseClean: job.responseWithClearJobs(jobTemplate, false),
        responseClear: job.responseWithClearJobs(jobTemplate, true),
      };
      this.cachedJobs.set(fullKey, cached);
    }
    return cached;
  }
}
