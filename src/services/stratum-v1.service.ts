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
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { ExternalSharesService } from './external-shares.service';

const FLUSH_INTERVAL_MS = 10_000; // Batch flush every 10s
const DIFFICULTY_CHECK_INTERVAL_MS = 60_000; // Check difficulty every 60s
const STATS_LOG_INTERVAL_MS = 30_000; // Log worker stats every 30s

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

    // 3. Worker statistics logging every 30s
    setInterval(() => {
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
      console.log(
        `[Worker ${this.workerId}] active=${this.clients.size}` +
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

  private startSocketServer() {
    const server = new Server(async (socket: Socket) => {
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

    server.maxConnections = 0; // unlimited
    server.listen(process.env.STRATUM_PORT, () => {
      console.log(
        `[Worker ${this.workerId}] Stratum server is listening on port ${process.env.STRATUM_PORT}`,
      );
    });
  }
}
