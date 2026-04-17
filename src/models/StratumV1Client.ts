import { ConfigService } from '@nestjs/config';
import * as bitcoinjs from 'bitcoinjs-lib';
import { plainToInstance } from 'class-transformer';
import { validate, ValidatorOptions } from 'class-validator';
import * as crypto from 'crypto';
import { Socket } from 'net';
// clearInterval import removed – per-client timers eliminated

import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientEntity } from '../ORM/client/client.entity';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { NotificationService } from '../services/notification.service';
import {
  IJobTemplate,
  StratumV1JobsService,
} from '../services/stratum-v1-jobs.service';
import { eRequestMethod } from './enums/eRequestMethod';
import { eResponseMethod } from './enums/eResponseMethod';
import { eStratumErrorCode } from './enums/eStratumErrorCode';
import { AuthorizationMessage } from './stratum-messages/AuthorizationMessage';
import { ConfigurationMessage } from './stratum-messages/ConfigurationMessage';
import { StratumErrorMessage } from './stratum-messages/StratumErrorMessage';
import { SubscriptionMessage } from './stratum-messages/SubscriptionMessage';
import { SuggestDifficulty } from './stratum-messages/SuggestDifficultyMessage';
import { StratumV1ClientStatistics } from './StratumV1ClientStatistics';
import { ExternalSharesService } from '../services/external-shares.service';
import { DifficultyUtils } from '../utils/difficulty.utils';

interface MiningSubmission {
  id: number | string;
  jobId: string;
  extraNonce2: string;
  ntime: string;
  nonce: string;
  versionMask: string;
}

// Per-worker counters (shared across all clients in a single process)
export class WorkerStats {
  public connections = 0;
  public disconnections = 0;
  public sharesAccepted = 0;
  public sharesRejected = 0;
  public subscriptions = 0;
  public authorizations = 0;
  public stratumInitialized = 0;
  public socketErrors = 0;
  public difficultyErrors = 0;
  public flushErrors = 0;
  public streamErrors = 0;
  public activeClients = 0;
  public blocksFound = 0;

  public reset() {
    this.connections = 0;
    this.disconnections = 0;
    this.sharesAccepted = 0;
    this.sharesRejected = 0;
    this.subscriptions = 0;
    this.authorizations = 0;
    this.stratumInitialized = 0;
    this.socketErrors = 0;
    this.difficultyErrors = 0;
    this.flushErrors = 0;
    this.streamErrors = 0;
    this.blocksFound = 0;
  }
}

export class StratumV1Client {
  private clientSubscription: SubscriptionMessage;
  private clientConfiguration: ConfigurationMessage;
  private clientAuthorization: AuthorizationMessage;
  private clientSuggestedDifficulty: SuggestDifficulty;

  public readonly createdAt = Date.now();

  private statistics: StratumV1ClientStatistics;
  private stratumInitialized = false;
  private usedSuggestedDifficulty = false;
  private sessionDifficulty = 16384;

  private entity: ClientEntity;
  private creatingEntity: Promise<void>;

  public extraNonceAndSessionId: string;
  public sessionStart: Date;
  public noFee: boolean;
  public hashRate = 0;

  private buffer = '';

  private miningSubmissionHashes = new Set<string>();
  private network: bitcoinjs.networks.Network;

  constructor(
    public readonly socket: Socket,
    private readonly stratumV1JobsService: StratumV1JobsService,
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly notificationService: NotificationService,
    private readonly blocksService: BlocksService,
    private readonly configService: ConfigService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly externalSharesService: ExternalSharesService,
    private readonly workerStats: WorkerStats,
  ) {
    // Pre-compute network config once
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

    this.socket.on('data', (data: Buffer) => {
      this.buffer += data.toString();

      // Prevent memory abuse from clients sending data without newlines
      if (this.buffer.length > 10240) {
        this.socket.end();
        this.socket.destroy();
        return;
      }

      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || ''; // Save the last part of the data (incomplete line) to the buffer

      lines
        .filter((m) => m.length > 0)
        .forEach(async (m) => {
          try {
            await this.handleMessage(m);
          } catch (e) {
            this.socket.end();
          }
        });
    });
  }

  public async destroy() {
    if (this.extraNonceAndSessionId) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.clientService.delete(this.extraNonceAndSessionId);
          break;
        } catch (e) {
          if (attempt < 2 && e?.driverError?.code === 'SQLITE_BUSY') {
            await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          }
          // Silently drop on final failure — client record will be cleaned up by killDeadClients
        }
      }
    }
  }

  private getRandomHexString() {
    const randomBytes = crypto.randomBytes(4); // 4 bytes = 32 bits
    const randomNumber = randomBytes.readUInt32BE(0); // Convert bytes to a 32-bit unsigned integer
    const hexString = randomNumber.toString(16).padStart(8, '0'); // Convert to hex and pad with zeros
    return hexString;
  }

  private async handleMessage(message: string) {
    //console.log(`Received from ${this.extraNonceAndSessionId}`, message);

    // Parse the message and check if it's the initial subscription message
    let parsedMessage = null;
    try {
      parsedMessage = JSON.parse(message);
    } catch (e) {
      //console.log("Invalid JSON");
      await this.socket.end();
      return;
    }

    switch (parsedMessage.method) {
      case eRequestMethod.SUBSCRIBE: {
        const subscriptionMessage = plainToInstance(
          SubscriptionMessage,
          parsedMessage,
        );

        const validatorOptions: ValidatorOptions = {
          whitelist: true,
          //forbidNonWhitelisted: true,
        };

        const errors = await validate(subscriptionMessage, validatorOptions);

        if (errors.length === 0) {
          if (this.sessionStart == null) {
            this.sessionStart = new Date();
            this.statistics = new StratumV1ClientStatistics(
              this.clientStatisticsService,
            );
            this.extraNonceAndSessionId = this.getRandomHexString();
          }

          this.clientSubscription = subscriptionMessage;
          this.workerStats.subscriptions++;
          const success = await this.write(
            JSON.stringify(
              this.clientSubscription.response(this.extraNonceAndSessionId),
            ) + '\n',
          );
          if (!success) {
            return;
          }
        } else {
          const err = new StratumErrorMessage(
            subscriptionMessage.id,
            eStratumErrorCode.OtherUnknown,
            'Subscription validation error',
            errors,
          ).response();
          const success = await this.write(err);
          if (!success) {
            return;
          }
        }

        break;
      }
      case eRequestMethod.CONFIGURE: {
        const configurationMessage = plainToInstance(
          ConfigurationMessage,
          parsedMessage,
        );

        const validatorOptions: ValidatorOptions = {
          whitelist: true,
          //forbidNonWhitelisted: true,
        };

        const errors = await validate(configurationMessage, validatorOptions);

        if (errors.length === 0) {
          this.clientConfiguration = configurationMessage;
          //const response = this.buildSubscriptionResponse(configurationMessage.id);
          const success = await this.write(
            JSON.stringify(this.clientConfiguration.response()) + '\n',
          );
          if (!success) {
            return;
          }
        } else {
          const err = new StratumErrorMessage(
            configurationMessage.id,
            eStratumErrorCode.OtherUnknown,
            'Configuration validation error',
            errors,
          ).response();
          const success = await this.write(err);
          if (!success) {
            return;
          }
        }

        break;
      }
      case eRequestMethod.AUTHORIZE: {
        const authorizationMessage = plainToInstance(
          AuthorizationMessage,
          parsedMessage,
        );

        const validatorOptions: ValidatorOptions = {
          whitelist: true,
          //forbidNonWhitelisted: true,
        };

        const errors = await validate(authorizationMessage, validatorOptions);

        if (errors.length === 0) {
          this.clientAuthorization = authorizationMessage;
          this.workerStats.authorizations++;
          const success = await this.write(
            JSON.stringify(this.clientAuthorization.response()) + '\n',
          );
          if (!success) {
            return;
          }
        } else {
          const err = new StratumErrorMessage(
            authorizationMessage.id,
            eStratumErrorCode.OtherUnknown,
            'Authorization validation error',
            errors,
          ).response();
          const success = await this.write(err);
          if (!success) {
            return;
          }
        }

        break;
      }
      case eRequestMethod.SUGGEST_DIFFICULTY: {
        if (this.usedSuggestedDifficulty == true) {
          return;
        }

        const suggestDifficultyMessage = plainToInstance(
          SuggestDifficulty,
          parsedMessage,
        );

        const validatorOptions: ValidatorOptions = {
          whitelist: true,
          //forbidNonWhitelisted: true,
        };

        const errors = await validate(
          suggestDifficultyMessage,
          validatorOptions,
        );

        if (errors.length === 0) {
          this.clientSuggestedDifficulty = suggestDifficultyMessage;
          this.sessionDifficulty = suggestDifficultyMessage.suggestedDifficulty;
          const success = await this.write(
            JSON.stringify(
              this.clientSuggestedDifficulty.response(this.sessionDifficulty),
            ) + '\n',
          );
          if (!success) {
            return;
          }
          this.usedSuggestedDifficulty = true;
        } else {
          const err = new StratumErrorMessage(
            suggestDifficultyMessage.id,
            eStratumErrorCode.OtherUnknown,
            'Suggest difficulty validation error',
            errors,
          ).response();
          const success = await this.write(err);
          if (!success) {
            return;
          }
        }
        break;
      }
      case eRequestMethod.SUBMIT: {
        if (!this.stratumInitialized) {
          this.socket.end();
          return;
        }

        // Fast manual validation - avoids class-transformer/class-validator overhead
        const params = parsedMessage.params;
        if (!Array.isArray(params) || params.length < 5) {
          const err = new StratumErrorMessage(
            parsedMessage.id,
            eStratumErrorCode.OtherUnknown,
            'Invalid submit parameters',
          ).response();
          this.write(err);
          return;
        }

        const submission: MiningSubmission = {
          id: parsedMessage.id,
          jobId: params[1],
          extraNonce2: params[2],
          ntime: params[3],
          nonce: params[4],
          versionMask: params[5] != null ? params[5] : '0',
        };

        const result = await this.handleMiningSubmission(submission);
        if (result) {
          this.write(
            JSON.stringify({
              id: parsedMessage.id,
              error: null,
              result: true,
            }) + '\n',
          );
        }
        break;
      }
      // default: {
      //     console.log("Invalid message");
      //     console.log(parsedMessage);
      //     await this.socket.end();
      //     return;
      // }
    }

    if (
      this.clientSubscription != null &&
      this.clientAuthorization != null &&
      this.stratumInitialized == false
    ) {
      await this.initStratum();
    }
  }

  private async initStratum() {
    this.stratumInitialized = true;
    this.workerStats.stratumInitialized++;

    switch (this.clientSubscription.userAgent) {
      case 'cpuminer': {
        this.sessionDifficulty = 0.1;
      }
    }

    if (this.clientSuggestedDifficulty == null) {
      //console.log(`Setting difficulty to ${this.sessionDifficulty}`)
      const setDifficulty = JSON.stringify(
        new SuggestDifficulty().response(this.sessionDifficulty),
      );
      const success = await this.write(setDifficulty + '\n');
      if (!success) {
        return;
      }
    }

    // Send the current mining job immediately (subsequent jobs distributed by service)
    const latestTemplateId = this.stratumV1JobsService.latestStoredTemplateId;
    if (latestTemplateId != null) {
      const jobTemplate =
        this.stratumV1JobsService.getJobTemplateById(latestTemplateId);
      if (jobTemplate != null) {
        try {
          this.sendNewMiningJob(jobTemplate);
        } catch (e) {
          this.workerStats.streamErrors++;
        }
      }
    }
  }

  public clearSubmissionHashes() {
    this.miningSubmissionHashes.clear();
  }

  public sendNewMiningJob(jobTemplate: IJobTemplate) {
    let payoutInformation;
    const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');
    //50Th/s
    this.noFee = false;
    if (this.entity) {
      this.hashRate = this.statistics.hashRate;
      this.noFee = this.hashRate != 0 && this.hashRate < 50000000000000;
    }
    let feeTierKey: string;
    if (this.noFee || devFeeAddress == null || devFeeAddress.length < 1) {
      payoutInformation = [
        { address: this.clientAuthorization.address, percent: 100 },
      ];
      feeTierKey = `${this.clientAuthorization.address}_nofee`;
    } else {
      payoutInformation = [
        { address: devFeeAddress, percent: 1.5 },
        { address: this.clientAuthorization.address, percent: 98.5 },
      ];
      feeTierKey = `${this.clientAuthorization.address}_fee`;
    }

    const cachedJob = this.stratumV1JobsService.getOrCreateCachedJob(
      this.network,
      payoutInformation,
      jobTemplate,
      feeTierKey,
    );

    const response = jobTemplate.blockData.clearJobs
      ? cachedJob.responseClear
      : cachedJob.responseClean;
    this.write(response);
  }

  private async handleMiningSubmission(submission: MiningSubmission) {
    if (this.entity == null) {
      if (this.creatingEntity == null) {
        this.creatingEntity = new Promise(async (resolve, reject) => {
          try {
            this.entity = await this.clientService.insert({
              sessionId: this.extraNonceAndSessionId,
              address: this.clientAuthorization.address,
              clientName: this.clientAuthorization.worker,
              userAgent: this.clientSubscription.userAgent,
              startTime: new Date(),
              bestDifficulty: 0,
            });
          } catch (e) {
            reject(e);
          }
          resolve();
        });
        await this.creatingEntity;
      } else {
        await this.creatingEntity;
      }
    }

    // Fast dedup via string key (avoids double-SHA256 hash)
    const submissionKey = `${submission.jobId}:${submission.nonce}:${submission.extraNonce2}:${submission.ntime}:${submission.versionMask}`;
    if (this.miningSubmissionHashes.has(submissionKey)) {
      const err = new StratumErrorMessage(
        submission.id,
        eStratumErrorCode.DuplicateShare,
        'Duplicate share',
      ).response();
      this.write(err);
      return false;
    } else {
      // Cap dedup set to prevent unbounded memory growth between blocks
      if (this.miningSubmissionHashes.size < 50000) {
        this.miningSubmissionHashes.add(submissionKey);
      }
    }

    const job = this.stratumV1JobsService.getJobById(submission.jobId);

    // a miner may submit a job that doesn't exist anymore if it was removed by a new block notification (or expired, 5 min)
    if (job == null) {
      const err = new StratumErrorMessage(
        submission.id,
        eStratumErrorCode.JobNotFound,
        'Job not found',
      ).response();
      this.write(err);
      return false;
    }
    const jobTemplate = this.stratumV1JobsService.getJobTemplateById(
      job.jobTemplateId,
    );

    // FAST PATH: compute only the 80-byte header for difficulty check
    // Avoids copying all block transactions (the old hot-path bottleneck)
    const versionMask = parseInt(submission.versionMask, 16);
    const nonce = parseInt(submission.nonce, 16);
    const ntime = parseInt(submission.ntime, 16);

    const header = job.computeHeaderBuffer(
      jobTemplate,
      versionMask,
      nonce,
      this.extraNonceAndSessionId,
      submission.extraNonce2,
      ntime,
    );
    const { submissionDifficulty } =
      DifficultyUtils.calculateDifficulty(header);

    if (submissionDifficulty >= this.sessionDifficulty) {
      if (submissionDifficulty >= jobTemplate.blockData.networkDifficulty) {
        console.log('!!! BLOCK FOUND !!!');
        this.workerStats.blocksFound++;
        // Full block reconstruction only for the extremely rare block-found case
        // If transactions were stripped from an old template, re-fetch them
        if (!jobTemplate.block.transactions || jobTemplate.block.transactions.length <= 1) {
          console.warn('Block found on stripped template, re-fetching transactions...');
          try {
            const rawTemplate = await this.bitcoinRpcService.getBlockTemplate(jobTemplate.blockData.height);
            const txs = rawTemplate.transactions.map(t => bitcoinjs.Transaction.fromHex(t.data));
            const tempCoinbaseTx = new bitcoinjs.Transaction();
            tempCoinbaseTx.version = 2;
            tempCoinbaseTx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
            tempCoinbaseTx.ins[0].witness = [Buffer.alloc(32, 0)];
            txs.unshift(tempCoinbaseTx);
            jobTemplate.block.transactions = txs;
          } catch (e: any) {
            console.error('CRITICAL: Failed to re-fetch transactions for block submission:', e?.message);
          }
        }
        const updatedJobBlock = job.copyAndUpdateBlock(
          jobTemplate,
          versionMask,
          nonce,
          this.extraNonceAndSessionId,
          submission.extraNonce2,
          ntime,
        );
        const blockHex = updatedJobBlock.toHex(false);
        const result = await this.bitcoinRpcService.SUBMIT_BLOCK(blockHex);
        await this.blocksService.save({
          height: jobTemplate.blockData.height,
          minerAddress: this.clientAuthorization.address,
          worker: this.clientAuthorization.worker,
          sessionId: this.extraNonceAndSessionId,
          blockData: blockHex,
        });

        await this.notificationService.notifySubscribersBlockFound(
          this.clientAuthorization.address,
          jobTemplate.blockData.height,
          updatedJobBlock,
          result,
        );
        //success
        if (result == null) {
          await this.addressSettingsService.resetBestDifficultyAndShares();
        }
      }

      // Pure in-memory accumulation — no DB writes
      this.statistics.addShares(this.entity, this.sessionDifficulty);
      this.workerStats.sharesAccepted++;

      // Queue heartbeat (batched flush every 10s)
      const now = new Date();
      if (
        this.entity.updatedAt == null ||
        now.getTime() - this.entity.updatedAt.getTime() > 1000 * 60
      ) {
        this.clientService.queueHeartbeat(
          this.entity.address,
          this.entity.clientName,
          this.entity.sessionId,
          this.hashRate,
          now,
        );
        this.entity.updatedAt = now;
      }

      if (submissionDifficulty > this.entity.bestDifficulty) {
        this.clientService.queueBestDifficulty(
          this.clientAuthorization.address,
          this.clientAuthorization.worker,
          this.extraNonceAndSessionId,
          submissionDifficulty,
        );
        this.entity.bestDifficulty = submissionDifficulty;
        if (
          submissionDifficulty >
          (
            await this.addressSettingsService.getSettings(
              this.clientAuthorization.address,
              true,
            )
          ).bestDifficulty
        ) {
          await this.addressSettingsService.updateBestDifficulty(
            this.clientAuthorization.address,
            submissionDifficulty,
            this.entity.userAgent,
          );
        }
      }

      const externalShareSubmissionEnabled: boolean =
        this.configService
          .get('EXTERNAL_SHARE_SUBMISSION_ENABLED')
          ?.toLowerCase() == 'true';
      const minimumDifficulty: number =
        parseFloat(this.configService.get('MINIMUM_DIFFICULTY')) ||
        1000000000000.0; // 1T
      if (
        externalShareSubmissionEnabled &&
        submissionDifficulty >= minimumDifficulty
      ) {
        // Submit share to API if enabled
        this.externalSharesService.submitShare({
          worker: this.clientAuthorization.worker,
          address: this.clientAuthorization.address,
          userAgent: this.clientSubscription.userAgent,
          header: header.toString('hex'),
          externalPoolName:
            this.configService.get('POOL_IDENTIFIER') || 'Public-Pool',
        });
      }
    } else {
      const err = new StratumErrorMessage(
        submission.id,
        eStratumErrorCode.LowDifficultyShare,
        'Difficulty too low',
      ).response();

      this.write(err);
      this.workerStats.sharesRejected++;
      return false;
    }

    return true;
  }

  /**
   * Flush in-memory statistics to the batched write queue.
   * Called by the centralized flush timer.
   */
  public flushStatistics() {
    if (this.entity != null) {
      this.statistics.flushCurrentSlot(this.entity);
    }
  }

  public async checkDifficulty() {
    if (this.statistics == null || this.clientAuthorization == null) {
      return;
    }
    const targetDiff = this.statistics.getSuggestedDifficulty(
      this.sessionDifficulty,
    );
    if (targetDiff == null) {
      return;
    }

    if (targetDiff != this.sessionDifficulty) {
      this.sessionDifficulty = targetDiff;

      const data =
        JSON.stringify({
          id: null,
          method: eResponseMethod.SET_DIFFICULTY,
          params: [targetDiff],
        }) + '\n';

      this.write(data);

      // Re-send current job with clearJobs=true to force miners to use new difficulty
      // Use cached job to avoid expensive MiningJob construction
      await this.resendCurrentJobWithClear();
    }
  }

  public hasSubscription(): boolean {
    return this.clientSubscription != null;
  }

  public hasAuthorization(): boolean {
    return this.clientAuthorization != null;
  }

  public isWorking(): boolean {
    return (
      this.stratumInitialized &&
      this.clientSubscription != null &&
      this.clientAuthorization != null
    );
  }

  private async resendCurrentJobWithClear() {
    let payoutInformation;
    const devFeeAddress = this.configService.get('DEV_FEE_ADDRESS');

    let feeTierKey: string;
    if (this.noFee || devFeeAddress == null || devFeeAddress.length < 1) {
      payoutInformation = [
        { address: this.clientAuthorization.address, percent: 100 },
      ];
      feeTierKey = `${this.clientAuthorization.address}_nofee`;
    } else {
      payoutInformation = [
        { address: devFeeAddress, percent: 1.5 },
        { address: this.clientAuthorization.address, percent: 98.5 },
      ];
      feeTierKey = `${this.clientAuthorization.address}_fee`;
    }

    const latestTemplateId = this.stratumV1JobsService.latestStoredTemplateId;
    const jobTemplate =
      this.stratumV1JobsService.getJobTemplateById(latestTemplateId);
    if (jobTemplate == null) return;

    const cachedJob = this.stratumV1JobsService.getOrCreateCachedJob(
      this.network,
      payoutInformation,
      jobTemplate,
      feeTierKey,
    );

    this.write(cachedJob.responseClear);
  }

  private write(message: string): boolean {
    try {
      if (!this.socket.destroyed && !this.socket.writableEnded) {
        // Backpressure: skip write if socket buffer exceeds 64KB
        if (this.socket.writableLength > 65536) {
          return true;
        }
        this.socket.write(message, (error) => {
          if (error) {
            this.destroy();
            if (!this.socket.destroyed) {
              this.socket.destroy();
            }
          }
        });
        return true;
      } else {
        this.destroy();
        if (!this.socket.destroyed) {
          this.socket.destroy();
        }
        return false;
      }
    } catch (error) {
      this.destroy();
      if (!this.socket.destroyed) {
        this.socket.destroy();
      }
      return false;
    }
  }
}
