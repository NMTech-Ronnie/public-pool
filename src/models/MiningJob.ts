import { AddressType, getAddressInfo } from 'bitcoin-address-validation';
import * as bitcoinjs from 'bitcoinjs-lib';

import { IJobTemplate } from '../services/stratum-v1-jobs.service';
import { eResponseMethod } from './enums/eResponseMethod';
import { IMiningNotify } from './stratum-messages/IMiningNotify';
import { ConfigService } from '@nestjs/config';

const MAX_BLOCK_WEIGHT = 4000000;
const MAX_SCRIPT_SIZE = 100;

interface AddressObject {
    address: string;
    percent: number;
}

/**
 * SharedMiningJob: a pre-built coinbase template shared by all miners
 * with the same payout set. Only ONE is created per (payoutSet, jobTemplate) pair.
 * Individual miners just get a per-miner jobId and write the shared cached notify payload
 * with their extraNonce substituted in at write time.
 */
export class SharedMiningJob {

    public readonly coinbaseTransaction: bitcoinjs.Transaction;
    public readonly coinbasePart1: string;
    public readonly coinbasePart2: string;
    public readonly jobTemplateId: string;
    public readonly creation: number;

    /** Pre-serialized notify payload with placeholders for jobId and clearJobs */
    private cachedNotifyPrefix: string;   // up to and including `"params":[`
    private cachedNotifyMiddle: string;   // between jobId and clearJobs
    private cachedNotifySuffix: string;   // after clearJobs through `]}\n`

    constructor(
        configService: ConfigService,
        private network: bitcoinjs.networks.Network,
        payoutInformation: AddressObject[],
        public readonly jobTemplate: IJobTemplate
    ) {
        this.creation = Date.now();
        this.jobTemplateId = jobTemplate.blockData.id;

        this.coinbaseTransaction = this.createCoinbaseTransaction(payoutInformation, jobTemplate.blockData.coinbasevalue);

        const segwitMagicBits = Buffer.from('aa21a9ed', 'hex');

        let poolIdentifier = configService.get('POOL_IDENTIFIER') || 'Public-Pool';
        let extra = Buffer.from(poolIdentifier);

        const blockHeightEncoded = bitcoinjs.script.number.encode(jobTemplate.blockData.height);
        const blockHeightLengthByte = Buffer.from([blockHeightEncoded.length]);
        const padding = Buffer.alloc(8 + (3 - blockHeightEncoded.length), 0);

        let script = Buffer.concat([blockHeightLengthByte, blockHeightEncoded, extra, padding]);
        if (script.length > MAX_SCRIPT_SIZE) {
            console.warn('Pool identifier is too long, removing the pool identifier');
            script = Buffer.concat([blockHeightLengthByte, blockHeightEncoded, padding]);
        }

        this.coinbaseTransaction.ins[0].script = script;
        this.coinbaseTransaction.addOutput(
            bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.concat([segwitMagicBits, jobTemplate.block.witnessCommit])]),
            0
        );

        if ((this.coinbaseTransaction.weight() + jobTemplate.block.weight()) > MAX_BLOCK_WEIGHT) {
            console.warn('Block weight exceeds the maximum allowed weight, removing the pool identifier');
            script = Buffer.concat([blockHeightLengthByte, blockHeightEncoded, padding]);
            this.coinbaseTransaction.ins[0].script = script;
        }

        //@ts-ignore
        const serializedCoinbaseTx = this.coinbaseTransaction.__toBuffer().toString('hex');
        const inputScript = this.coinbaseTransaction.ins[0].script.toString('hex');
        const partOneIndex = serializedCoinbaseTx.indexOf(inputScript) + inputScript.length;

        this.coinbasePart1 = serializedCoinbaseTx.slice(0, partOneIndex - 16);
        this.coinbasePart2 = serializedCoinbaseTx.slice(partOneIndex);

        // Pre-compute the notify payload template (jobId will be spliced in per miner)
        this.buildCachedNotify();
    }

    private buildCachedNotify() {
        const jt = this.jobTemplate;
        // Use unique placeholders for jobId and clearJobs so we can splice both in per call.
        const notify: IMiningNotify = {
            id: null,
            method: eResponseMethod.MINING_NOTIFY,
            params: [
                '__JOB_ID__',
                this.swapEndianWords(jt.block.prevHash).toString('hex'),
                this.coinbasePart1,
                this.coinbasePart2,
                jt.merkle_branch,
                jt.block.version.toString(16),
                jt.block.bits.toString(16),
                jt.block.timestamp.toString(16),
                // boolean placeholder — JSON.stringify keeps it as the literal string here
                ('__CLEAR__' as unknown) as boolean
            ]
        };
        const full = JSON.stringify(notify);
        const jobIdToken = '"__JOB_ID__"';
        const clearToken = '"__CLEAR__"';
        const i1 = full.indexOf(jobIdToken);
        const i2 = full.indexOf(clearToken);
        this.cachedNotifyPrefix = full.substring(0, i1);
        this.cachedNotifyMiddle = full.substring(i1 + jobIdToken.length, i2);
        this.cachedNotifySuffix = full.substring(i2 + clearToken.length);
    }

    /**
     * Get the per-miner notify string. jobId and clearJobs are spliced in per call,
     * so callers can drive a `clearJobs:true` notify without invalidating the cache.
     */
    public getNotifyPayload(jobId: string, clearJobs: boolean): string {
        return this.cachedNotifyPrefix
            + '"' + jobId + '"'
            + this.cachedNotifyMiddle
            + (clearJobs ? 'true' : 'false')
            + this.cachedNotifySuffix
            + '\n';
    }

    /**
     * Validate a share by building only the 80-byte block header.
     * No Object.assign, no transaction cloning.
     * Returns { headerBuffer, merkleRoot } for difficulty check.
     */
    public buildHeaderBuffer(
        jobTemplate: IJobTemplate,
        versionMask: number,
        nonce: number,
        extraNonce: string,
        extraNonce2: string,
        timestamp: number
    ): Buffer {
        // 1. Rebuild coinbase hash with the submitted extraNonces
        const nonceScript = this.coinbaseTransaction.ins[0].script.toString('hex');
        const updatedScript = nonceScript.substring(0, nonceScript.length - 16) + extraNonce + extraNonce2;
        const scriptBuf = Buffer.from(updatedScript, 'hex');

        // Clone ONLY the coinbase tx input script, compute its txid
        // We create a minimal copy of the coinbase tx for hashing
        const cbClone = this.coinbaseTransaction.clone();
        cbClone.ins[0].script = scriptBuf;
        const coinbaseHash = cbClone.getHash(false);

        // 2. Compute merkle root from coinbase hash + merkle branches
        const merkleRoot = this.calculateMerkleRootHash(coinbaseHash, jobTemplate.merkle_branch);

        // 3. Build 80-byte header: version(4) + prevHash(32) + merkleRoot(32) + timestamp(4) + bits(4) + nonce(4)
        const header = Buffer.allocUnsafe(80);
        let version = jobTemplate.block.version;
        if (versionMask !== undefined && versionMask !== 0) {
            version = version ^ versionMask;
        }
        header.writeInt32LE(version, 0);
        jobTemplate.block.prevHash.copy(header, 4);
        merkleRoot.copy(header, 36);
        header.writeUInt32LE(timestamp, 68);
        header.writeUInt32LE(jobTemplate.block.bits, 72);
        header.writeUInt32LE(nonce, 76);

        return header;
    }

    /**
     * Full block reconstruction — only called when a block is actually found (rare).
     */
    public buildFullBlock(
        jobTemplate: IJobTemplate,
        versionMask: number,
        nonce: number,
        extraNonce: string,
        extraNonce2: string,
        timestamp: number
    ): bitcoinjs.Block {
        const testBlock = Object.assign(new bitcoinjs.Block(), jobTemplate.block);
        testBlock.transactions = jobTemplate.block.transactions.map(tx => {
            return Object.assign(new bitcoinjs.Transaction(), tx);
        });

        testBlock.transactions[0] = this.coinbaseTransaction.clone();
        testBlock.nonce = nonce;

        if (versionMask !== undefined && versionMask !== 0) {
            testBlock.version = testBlock.version ^ versionMask;
        }

        const nonceScript = testBlock.transactions[0].ins[0].script.toString('hex');
        testBlock.transactions[0].ins[0].script = Buffer.from(
            `${nonceScript.substring(0, nonceScript.length - 16)}${extraNonce}${extraNonce2}`,
            'hex'
        );

        testBlock.merkleRoot = this.calculateMerkleRootHash(
            testBlock.transactions[0].getHash(false),
            jobTemplate.merkle_branch
        );
        testBlock.timestamp = timestamp;

        return testBlock;
    }

    private calculateMerkleRootHash(newRoot: Buffer, merkleBranches: string[]): Buffer {
        const bothMerkles = Buffer.alloc(64);
        bothMerkles.set(newRoot);

        for (let i = 0; i < merkleBranches.length; i++) {
            bothMerkles.set(Buffer.from(merkleBranches[i], 'hex'), 32);
            newRoot = bitcoinjs.crypto.hash256(bothMerkles);
            bothMerkles.set(newRoot);
        }

        return bothMerkles.subarray(0, 32);
    }

    private createCoinbaseTransaction(addresses: AddressObject[], reward: number): bitcoinjs.Transaction {
        const coinbaseTransaction = new bitcoinjs.Transaction();
        coinbaseTransaction.version = 2;
        coinbaseTransaction.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);

        let rewardBalance = reward;
        addresses.forEach(recipientAddress => {
            const amount = Math.floor((recipientAddress.percent / 100) * reward);
            rewardBalance -= amount;
            coinbaseTransaction.addOutput(this.getPaymentScript(recipientAddress.address), amount);
        });
        coinbaseTransaction.outs[0].value += rewardBalance;

        const segwitWitnessReservedValue = Buffer.alloc(32, 0);
        coinbaseTransaction.ins[0].witness = [segwitWitnessReservedValue];

        return coinbaseTransaction;
    }

    private getPaymentScript(address: string): Buffer {
        const addressInfo = getAddressInfo(address);
        switch (addressInfo.type) {
            case AddressType.p2wpkh:
                return bitcoinjs.payments.p2wpkh({ address, network: this.network }).output;
            case AddressType.p2pkh:
                return bitcoinjs.payments.p2pkh({ address, network: this.network }).output;
            case AddressType.p2sh:
                return bitcoinjs.payments.p2sh({ address, network: this.network }).output;
            case AddressType.p2tr:
                return bitcoinjs.payments.p2tr({ address, network: this.network }).output;
            case AddressType.p2wsh:
                return bitcoinjs.payments.p2wsh({ address, network: this.network }).output;
            default:
                return Buffer.alloc(0);
        }
    }

    private swapEndianWords(buffer: Buffer): Buffer {
        const swappedBuffer = Buffer.alloc(buffer.length);
        for (let i = 0; i < buffer.length; i += 4) {
            swappedBuffer[i] = buffer[i + 3];
            swappedBuffer[i + 1] = buffer[i + 2];
            swappedBuffer[i + 2] = buffer[i + 1];
            swappedBuffer[i + 3] = buffer[i];
        }
        return swappedBuffer;
    }
}


/**
 * Lightweight per-miner job reference. Holds a direct pointer to the SharedMiningJob
 * so share validation needs no map lookup.
 */
export class MinerJobRef {
    public readonly creation: number;
    constructor(
        public readonly jobId: string,
        public readonly sharedJob: SharedMiningJob,
    ) {
        this.creation = Date.now();
    }
}
