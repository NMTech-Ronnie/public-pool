import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';

import { StratumV1Client } from '../models/StratumV1Client';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { WorkerStats } from '../utils/worker-stats';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { NotificationService } from './notification.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';
import { ExternalSharesService } from './external-shares.service';


@Injectable()
export class StratumV1Service implements OnModuleInit {

  constructor(
    private readonly bitcoinRpcService: BitcoinRpcService,
    private readonly clientService: ClientService,
    private readonly clientStatisticsService: ClientStatisticsService,
    private readonly notificationService: NotificationService,
    private readonly blocksService: BlocksService,
    private readonly configService: ConfigService,
    private readonly stratumV1JobsService: StratumV1JobsService,
    private readonly addressSettingsService: AddressSettingsService,
    private readonly externalSharesService: ExternalSharesService
  ) {

  }

  async onModuleInit(): Promise<void> {

      if (process.env.NODE_APP_INSTANCE == '0') {
        await this.clientService.deleteAll();
      }
      setTimeout(() => {
        this.startSocketServer();
      }, 1000 * 10)

  }

  private startSocketServer() {
    const stats = WorkerStats.getInstance();
    stats.start();

    const server = net.createServer({ keepAlive: true }, (socket: net.Socket) => {

      //5 min
      socket.setTimeout(1000 * 60 * 5);
      socket.setNoDelay(true);

      stats.onConnect();

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
        this.externalSharesService
      );


      socket.on('close', async (hadError: boolean) => {
        stats.onDisconnect();
        if (client.extraNonceAndSessionId != null) {
          // Handle socket disconnection
          await client.destroy();
        }
      });

      socket.on('timeout', () => {
        stats.onTimeout();
        socket.end();
        socket.destroy();
      });

      socket.on('error', async (error: Error) => { });

    });

    const port = parseInt(process.env.STRATUM_PORT, 10);
    // Use SO_REUSEPORT so multiple cluster workers can listen on the same port
    server.listen({ port, host: '0.0.0.0', reusePort: true }, () => {
      console.log(`[Worker ${process.env.NODE_APP_INSTANCE}] Stratum server is listening on port ${port}`);
    });

  }

}