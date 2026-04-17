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
  for (let i = 0; i < numWorkers; i++) {
    (cluster as any).fork({ NODE_APP_INSTANCE: i.toString() });
  }
  (cluster as any).on('exit', (worker, code, signal) => {
    console.log(
      `Worker ${worker.process.pid} died (code: ${code}, signal: ${signal}). Restarting...`,
    );
    const instanceId = worker.process.env?.NODE_APP_INSTANCE || '0';
    (cluster as any).fork({ NODE_APP_INSTANCE: instanceId });
  });
} else {
  if (!process.env.NODE_APP_INSTANCE) {
    process.env.NODE_APP_INSTANCE = '0';
  }
  bootstrap();
}
