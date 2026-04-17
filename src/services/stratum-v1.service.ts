import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'net';

import { StratumV1Client, WorkerStats } from '../models/StratumV1Client';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { NotificationService } from './notification.service';
import { IJobTemplate, StratumV1JobsService } from './stratum-v1-jobs.service';
import { ExternalSharesService } from './external-shares.service';

const FLUSH_INTERVAL_MS = 10_000; // Batch flush every 10s
const DIFFICULTY_CHECK_INTERVAL_MS = 60_000; // Check difficulty every 60s
const STATS_LOG_INTERVAL_MS = 30_000; // Log worker stats every 30s
const MAX_CLIENTS_PER_WORKER = 10_000;
const IDLE_HANDSHAKE_TIMEOUT_MS = 30_000; // Kick clients not authorized within 30s
const JOB_DISTRIBUTION_BATCH_SIZE = 100;

interface IWorkerSnapshot {
  workerId: string;
  activeClients: number;
  subscribedClients: number;
  authorizedClients: number;
  workingClients: number;
  connections: number;
  disconnections: number;
  sharesAccepted: number;
  sharesRejected: number;
  subscriptions: number;
  authorizations: number;
  stratumInitialized: number;
  socketErrors: number;
  difficultyErrors: number;
  flushErrors: number;
  streamErrors: number;
  blocksFound: number;
}

@Injectable()
export class StratumV1Service implements OnModuleInit {
  private readonly clients = new Set<StratumV1Client>();
  private readonly workerStats = new WorkerStats();
  private readonly workerId = process.env.NODE_APP_INSTANCE || '0';

  constructor(
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly notificationService: NotificationService,
    private readonly blocksService: BlocksService,
    private readonly configService: ConfigService,
    private readonly stratumV1JobsService: StratumV1JobsService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly externalSharesService: ExternalSharesService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_APP_INSTANCE == '0') {
      await this.clientService.deleteAll();
    }
    setTimeout(() => {
      this.startSocketServer();
      this.startCentralizedTimers();
      this.startCentralizedJobDistribution();
    }, 1000 * 10);
  }

  /**
   * Single set of timers per worker process, replacing N per-client setIntervals.
   */
  private startCentralizedTimers() {
    // 1. Difficulty check: iterate all clients every 60s
    setInterval(() => {
      for (const client of this.clients) {
        try {
          client.checkDifficulty();
        } catch (e) {
          this.workerStats.difficultyErrors++;
        }
      }
    }, DIFFICULTY_CHECK_INTERVAL_MS);

    // 2. Batch DB flush: flush all queued writes every 10s
    setInterval(async () => {
      try {
        // First, flush each client's in-memory statistics to the queue
        for (const client of this.clients) {
          try {
            client.flushStatistics();
          } catch (_) {
            /* client may have been destroyed */
          }
        }
        // Then batch-write all queued data to SQLite
        await this.clientStatisticsService.flushWrites();
        await this.clientService.flushWrites();
      } catch (e) {
        this.workerStats.flushErrors++;
        console.error(`[Worker ${this.workerId}] Flush error:`, e.message);
      }
    }, FLUSH_INTERVAL_MS);

    // 3. Worker statistics logging every 30s + idle connection cleanup
    setInterval(() => {
      // Kick idle connections that haven't completed handshake
      const now = Date.now();
      const idleClients: StratumV1Client[] = [];
      for (const client of this.clients) {
        if (
          !client.isWorking() &&
          now - client.createdAt > IDLE_HANDSHAKE_TIMEOUT_MS
        ) {
          idleClients.push(client);
        }
      }
      for (const client of idleClients) {
        try {
          client.socket.end();
          client.socket.destroy();
        } catch (_) {}
      }
      if (idleClients.length > 0) {
        console.log(
          `[Worker ${this.workerId}] Kicked ${idleClients.length} idle connections (handshake timeout)`,
        );
      }

      let subscribedClients = 0;
      let authorizedClients = 0;
      let workingClients = 0;
      for (const client of this.clients) {
        if (client.hasSubscription()) {
          subscribedClients++;
        }
        if (client.hasAuthorization()) {
          authorizedClients++;
        }
        if (client.isWorking()) {
          workingClients++;
        }
      }

      this.workerStats.activeClients = this.clients.size;
      const mem = process.memoryUsage();
      console.log(
        `[Worker ${this.workerId}] active=${this.clients.size}` +
          ` heap=${Math.round(mem.heapUsed / 1048576)}/${Math.round(mem.heapTotal / 1048576)}MB rss=${Math.round(mem.rss / 1048576)}MB` +
          ` subscribed=${subscribedClients} authorized=${authorizedClients} working=${workingClients}` +
          ` conn=+${this.workerStats.connections} disc=+${this.workerStats.disconnections}` +
          ` sub=+${this.workerStats.subscriptions} auth=+${this.workerStats.authorizations} init=+${this.workerStats.stratumInitialized}` +
          ` accepted=+${this.workerStats.sharesAccepted} rejected=+${this.workerStats.sharesRejected}` +
          ` sockErr=+${this.workerStats.socketErrors} diffErr=+${this.workerStats.difficultyErrors}` +
          ` flushErr=+${this.workerStats.flushErrors} streamErr=+${this.workerStats.streamErrors}` +
          ` blocks=+${this.workerStats.blocksFound}`,
      );

      const snapshot: IWorkerSnapshot = {
        workerId: this.workerId,
        activeClients: this.clients.size,
        subscribedClients,
        authorizedClients,
        workingClients,
        connections: this.workerStats.connections,
        disconnections: this.workerStats.disconnections,
        sharesAccepted: this.workerStats.sharesAccepted,
        sharesRejected: this.workerStats.sharesRejected,
        subscriptions: this.workerStats.subscriptions,
        authorizations: this.workerStats.authorizations,
        stratumInitialized: this.workerStats.stratumInitialized,
        socketErrors: this.workerStats.socketErrors,
        difficultyErrors: this.workerStats.difficultyErrors,
        flushErrors: this.workerStats.flushErrors,
        streamErrors: this.workerStats.streamErrors,
        blocksFound: this.workerStats.blocksFound,
      };

      if (typeof process.send === 'function') {
        process.send({
          type: 'worker-stats',
          payload: snapshot,
        });
      }

      this.workerStats.reset();
    }, STATS_LOG_INTERVAL_MS);
  }

  /**
   * Subscribe to newMiningJob$ once per worker and distribute to all clients in batches.
   * This replaces per-client RxJS subscriptions to avoid event loop starvation.
   */
  private startCentralizedJobDistribution() {
    this.stratumV1JobsService.newMiningJob$.subscribe((jobTemplate) => {
      this.distributeJobToClients(jobTemplate);
    });
  }

  private async distributeJobToClients(jobTemplate: IJobTemplate) {
    const clientArray = [...this.clients];
    let distributed = 0;
    let errors = 0;

    for (let i = 0; i < clientArray.length; i += JOB_DISTRIBUTION_BATCH_SIZE) {
      const end = Math.min(
        i + JOB_DISTRIBUTION_BATCH_SIZE,
        clientArray.length,
      );
      for (let j = i; j < end; j++) {
        const client = clientArray[j];
        if (!client.isWorking()) continue;
        try {
          if (jobTemplate.blockData.clearJobs) {
            client.clearSubmissionHashes();
          }
          client.sendNewMiningJob(jobTemplate);
          distributed++;
        } catch (e) {
          errors++;
        }
      }
      // Yield to event loop between batches to avoid starvation
      if (end < clientArray.length) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }

    console.log(
      `[Worker ${this.workerId}] Job h=${jobTemplate.blockData.height} distributed to ${distributed}/${clientArray.length} clients` +
        (errors > 0 ? ` (${errors} errors)` : '') +
        ` clearJobs=${jobTemplate.blockData.clearJobs}`,
    );
  }

  private startSocketServer() {
    const server = new Server(async (socket: Socket) => {
      // Reject if at capacity
      if (this.clients.size >= MAX_CLIENTS_PER_WORKER) {
        socket.end();
        socket.destroy();
        return;
      }

      //5 min
      socket.setTimeout(1000 * 60 * 5);

      // Disable Nagle's algorithm for low-latency stratum communication
      socket.setNoDelay(true);

      // Reduce socket buffer overhead for stratum protocol (small messages)
      socket.setKeepAlive(true, 30000);

      const client = new StratumV1Client(
        socket,
        this.stratumV1JobsService,
        this.bitcoinRpcService,
        this.clientService,
        this.clientStatisticsService,
        this.notificationService,
        this.blocksService,
        this.configService,
        this.addressSettingsService,
        this.externalSharesService,
        this.workerStats,
      );

      this.clients.add(client);
      this.workerStats.connections++;

      socket.on('close', async (_hadError: boolean) => {
        this.clients.delete(client);
        this.workerStats.disconnections++;
        if (client.extraNonceAndSessionId != null) {
          // Flush this client's stats before destroying
          try {
            client.flushStatistics();
          } catch (_) {}
          await client.destroy();
        }
      });

      socket.on('timeout', () => {
        socket.end();
        socket.destroy();
      });

      socket.on('error', async (_error: Error) => {
        this.workerStats.socketErrors++;
      });
    });

    server.listen(process.env.STRATUM_PORT, () => {
      console.log(
        `[Worker ${this.workerId}] Stratum server is listening on port ${process.env.STRATUM_PORT}`,
      );
    });
  }
}
