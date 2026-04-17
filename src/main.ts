// Increase libuv thread pool BEFORE any I/O modules load.
// Default is 4 threads — with 4 workers each doing SQLite busy-waits,
// all threads get exhausted, freezing the event loop.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as bitcoinjs from 'bitcoinjs-lib';
import { useContainer } from 'class-validator';
import { readFileSync } from 'fs';
import * as ecc from 'tiny-secp256k1';
import * as cluster from 'node:cluster';
import * as os from 'node:os';

import { AppModule } from './app.module';

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

interface IWorkerSnapshotState extends IWorkerSnapshot {
  updatedAt: number;
}

async function bootstrap() {
  if (process.env.API_PORT == null) {
    console.error(
      'It appears your environment is not configured, create and populate an .env file.',
    );
    return;
  }

  let options = {};
  const secure = process.env.API_SECURE?.toLowerCase() == 'true';
  if (secure) {
    const currentDirectory = process.cwd();
    options = {
      https: {
        key: readFileSync(`${currentDirectory}/secrets/key.pem`),
        cert: readFileSync(`${currentDirectory}/secrets/cert.pem`),
      },
    };
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(options),
  );
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      //forbidNonWhitelisted: true,
      //forbidUnknownValues: true
    }),
  );

  process.on('SIGINT', () => {
    console.log(`Stopping services`);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log(`Stopping services`);
    process.exit(0);
  });

  app.enableCors();
  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  //Taproot
  bitcoinjs.initEccLib(ecc);

  await app.listen(process.env.API_PORT, '0.0.0.0', (err, address) => {
    console.log(`API listening on ${address}`);
  });
}

// Cluster support: use all CPU cores for connection handling.
// Set CLUSTER_WORKERS env var to control worker count (default: number of CPU cores).
// Set to 1 to disable clustering (single process mode).
// If NODE_APP_INSTANCE is already set (e.g., PM2 cluster), skip built-in clustering.
const numWorkers =
  parseInt(process.env.CLUSTER_WORKERS || '0') || os.cpus().length;
const alreadyClustered = process.env.NODE_APP_INSTANCE != null;

if (numWorkers > 1 && !alreadyClustered && (cluster as any).isPrimary) {
  console.log(
    `Primary process ${process.pid} starting ${numWorkers} workers...`,
  );
  const workerSnapshots = new Map<number, IWorkerSnapshotState>();

  const aggregateTimer = setInterval(() => {
    if (workerSnapshots.size === 0) {
      return;
    }

    let activeClients = 0;
    let subscribedClients = 0;
    let authorizedClients = 0;
    let workingClients = 0;
    let connections = 0;
    let disconnections = 0;
    let subscriptions = 0;
    let authorizations = 0;
    let stratumInitialized = 0;
    let sharesAccepted = 0;
    let sharesRejected = 0;
    let socketErrors = 0;
    let difficultyErrors = 0;
    let flushErrors = 0;
    let streamErrors = 0;
    let blocksFound = 0;

    for (const snapshot of workerSnapshots.values()) {
      activeClients += snapshot.activeClients;
      subscribedClients += snapshot.subscribedClients;
      authorizedClients += snapshot.authorizedClients;
      workingClients += snapshot.workingClients;
      connections += snapshot.connections;
      disconnections += snapshot.disconnections;
      subscriptions += snapshot.subscriptions;
      authorizations += snapshot.authorizations;
      stratumInitialized += snapshot.stratumInitialized;
      sharesAccepted += snapshot.sharesAccepted;
      sharesRejected += snapshot.sharesRejected;
      socketErrors += snapshot.socketErrors;
      difficultyErrors += snapshot.difficultyErrors;
      flushErrors += snapshot.flushErrors;
      streamErrors += snapshot.streamErrors;
      blocksFound += snapshot.blocksFound;
    }

    console.log(
      `[Primary] workers=${workerSnapshots.size}/${numWorkers}` +
        ` active=${activeClients} subscribed=${subscribedClients} authorized=${authorizedClients} working=${workingClients}` +
        ` conn=+${connections} disc=+${disconnections}` +
        ` sub=+${subscriptions} auth=+${authorizations} init=+${stratumInitialized}` +
        ` accepted=+${sharesAccepted} rejected=+${sharesRejected}` +
        ` sockErr=+${socketErrors} diffErr=+${difficultyErrors} flushErr=+${flushErrors} streamErr=+${streamErrors}` +
        ` blocks=+${blocksFound}`,
    );
  }, 30000);
  aggregateTimer.unref();

  for (let i = 0; i < numWorkers; i++) {
    (cluster as any).fork({ NODE_APP_INSTANCE: i.toString() });
  }
  (cluster as any).on('message', (worker, message) => {
    if (message?.type !== 'worker-stats' || message.payload == null) {
      return;
    }

    workerSnapshots.set(worker.id, {
      ...(message.payload as IWorkerSnapshot),
      updatedAt: Date.now(),
    });
  });
  (cluster as any).on('exit', (worker, code, signal) => {
    console.log(
      `Worker ${worker.process.pid} died (code: ${code}, signal: ${signal}). Restarting...`,
    );
    workerSnapshots.delete(worker.id);
    const instanceId = worker.process.env?.NODE_APP_INSTANCE || '0';
    (cluster as any).fork({ NODE_APP_INSTANCE: instanceId });
  });
} else {
  if (!process.env.NODE_APP_INSTANCE) {
    process.env.NODE_APP_INSTANCE = '0';
  }
  // Prevent uncaught errors from crashing worker processes
  process.on('uncaughtException', (err) => {
    console.error(`[Worker ${process.env.NODE_APP_INSTANCE}] Uncaught exception:`, err.message);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`[Worker ${process.env.NODE_APP_INSTANCE}] Unhandled rejection:`, reason);
  });
  bootstrap();
}
