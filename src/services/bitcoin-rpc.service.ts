import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RPCClient } from 'rpc-bitcoin';
import { BehaviorSubject, filter, shareReplay } from 'rxjs';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';
import * as zmq from 'zeromq';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { IMiningInfo } from '../models/bitcoin-rpc/IMiningInfo';
import * as fs from 'node:fs';

@Injectable()
export class BitcoinRpcService implements OnModuleInit {
  private blockHeight = 0;
  private client: RPCClient;
  private _newBlock$: BehaviorSubject<IMiningInfo> = new BehaviorSubject(
    undefined,
  );
  // Cancellation token for waitForBlock — prevents leaked promise loops
  // when switchMap moves on to a new block/interval.
  private waitForBlockAborted = false;
  public newBlock$ = this._newBlock$.pipe(
    filter((block) => block != null),
    shareReplay({ refCount: true, bufferSize: 1 }),
  );

  constructor(
    private readonly configService: ConfigService,
    private rpcBlockService: RpcBlockService,
  ) {}

  async onModuleInit() {
    const url = this.configService.get('BITCOIN_RPC_URL');
    let user = this.configService.get('BITCOIN_RPC_USER');
    let pass = this.configService.get('BITCOIN_RPC_PASSWORD');
    const port = parseInt(this.configService.get('BITCOIN_RPC_PORT'));
    const timeout = parseInt(this.configService.get('BITCOIN_RPC_TIMEOUT'));

    const cookiefile = this.configService.get('BITCOIN_RPC_COOKIEFILE');

    if (cookiefile != undefined && cookiefile != '') {
      const cookie = fs.readFileSync(cookiefile).toString().split(':');

      user = cookie[0];
      pass = cookie[1];
    }

    this.client = new RPCClient({ url, port, timeout, user, pass });

    this.client.getrpcinfo().then(
      (res) => {
        console.log('Bitcoin RPC connected');
      },
      () => {
        console.error('Could not reach RPC host');
      },
    );

    if (this.configService.get('BITCOIN_ZMQ_HOST')) {
      console.log('Using ZMQ');
      const sock = new zmq.Subscriber();

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
      setInterval(this.pollMiningInfo.bind(this), 500);
    }
  }

  private async listenForNewBlocks(sock: zmq.Subscriber) {
    for await (const [topic, msg] of sock) {
      console.log('New Block');
      await this.pollMiningInfo();
    }
  }

  public async pollMiningInfo() {
    const miningInfo = await this.getMiningInfo();
    if (miningInfo != null && miningInfo.blocks > this.blockHeight) {
      console.log('block height change');
      this._newBlock$.next(miningInfo);
      this.blockHeight = miningInfo.blocks;
    }
  }

  private async waitForBlock(blockHeight: number): Promise<IBlockTemplate> {
    const MAX_WAIT_MS = 30_000; // 30s timeout
    const POLL_INTERVAL_MS = 1000; // 1s between polls (was 100ms)
    const start = Date.now();

    while (!this.waitForBlockAborted) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const block = await this.rpcBlockService.getBlock(blockHeight);
      if (block != null && block.data != null) {
        console.log(`waitForBlock resolved, block height ${blockHeight}`);
        return JSON.parse(block.data);
      }

      if (Date.now() - start > MAX_WAIT_MS) {
        throw new Error(`waitForBlock timed out after ${MAX_WAIT_MS}ms for height ${blockHeight}`);
      }
    }
    throw new Error(`waitForBlock aborted for height ${blockHeight}`);
  }

  public async getBlockTemplate(blockHeight: number): Promise<IBlockTemplate> {
    // Abort any lingering waitForBlock loops from previous calls
    this.waitForBlockAborted = true;
    await new Promise((r) => setImmediate(r));
    this.waitForBlockAborted = false;

    let result: IBlockTemplate;
    try {
      const block = await this.rpcBlockService.getBlock(blockHeight);
      const completeBlock = block?.data != null;

      // If the block has already been loaded, and the same instance is fetching the template again, we just need to refresh it.
      if (completeBlock && block.lockedBy == process.env.NODE_APP_INSTANCE) {
        result = await this.loadBlockTemplate(blockHeight);
      } else if (completeBlock) {
        return JSON.parse(block.data);
      } else if (!completeBlock) {
        if (process.env.NODE_APP_INSTANCE != null) {
          // There is a unique constraint on the block height so if another process tries to lock, it'll throw
          try {
            await this.rpcBlockService.lockBlock(
              blockHeight,
              process.env.NODE_APP_INSTANCE,
            );
            // Lock acquired — this worker loads the template
            result = await this.loadBlockTemplate(blockHeight);
          } catch (e) {
            // Another worker holds the lock — wait for it to save the template
            result = await this.waitForBlock(blockHeight);
          }
        } else {
          result = await this.loadBlockTemplate(blockHeight);
        }
      } else {
        //wait for block
        result = await this.waitForBlock(blockHeight);
      }
    } catch (e) {
      console.error('Error getblocktemplate:', e.message);
      throw new Error('Error getblocktemplate');
    }
    console.log(`getblocktemplate tx count: ${result.transactions.length}`);
    return result;
  }

  private async loadBlockTemplate(blockHeight: number) {
    let blockTemplate: IBlockTemplate;
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts && blockTemplate == null; attempt++) {
      try {
        blockTemplate = await this.client.getblocktemplate({
          template_request: {
            rules: ['segwit'],
            mode: 'template',
            capabilities: ['serverlist', 'proposal'],
          },
        });
      } catch (e) {
        console.error(`loadBlockTemplate attempt ${attempt + 1} failed:`, e?.message);
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    if (blockTemplate == null) {
      throw new Error(`loadBlockTemplate failed after ${maxAttempts} attempts for height ${blockHeight}`);
    }

    await this.rpcBlockService.saveBlock(
      blockHeight,
      JSON.stringify(blockTemplate),
    );

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
    let response = 'unknown';
    try {
      response = await this.client.submitblock({
        hexdata,
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
