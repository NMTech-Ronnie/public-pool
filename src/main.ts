import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as bitcoinjs from 'bitcoinjs-lib';
import { useContainer } from 'class-validator';
import { readFileSync } from 'fs';
import * as ecc from 'tiny-secp256k1';

import { AppModule } from './app.module';

const NUM_WORKERS = parseInt(process.env.CLUSTER_WORKERS || '0', 10) || Math.max(availableParallelism() - 1, 1);

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} starting ${NUM_WORKERS} workers`);

  for (let i = 0; i < NUM_WORKERS; i++) {
    cluster.fork({ NODE_APP_INSTANCE: String(i) });
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} exited (code=${code}, signal=${signal}). Restarting...`);
    const instanceId = (worker as any).process.env?.NODE_APP_INSTANCE ?? '0';
    cluster.fork({ NODE_APP_INSTANCE: instanceId });
  });

} else {
  // Each worker gets its instance id via env
  process.env.NODE_APP_INSTANCE = process.env.NODE_APP_INSTANCE ?? '0';
  bootstrap();
}

async function bootstrap() {

  if (process.env.API_PORT == null) {
    console.error('It appears your environment is not configured, create and populate an .env file.');
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
      }
    };
  }

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(options));
  app.setGlobalPrefix('api')
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      //forbidNonWhitelisted: true,
      //forbidUnknownValues: true
    }),
  );

  process.on('SIGINT', () => {
    console.log(`[Worker ${process.env.NODE_APP_INSTANCE}] Stopping services`);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log(`[Worker ${process.env.NODE_APP_INSTANCE}] Stopping services`);
    process.exit(0);
  });

  app.enableCors();
  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  //Taproot
  bitcoinjs.initEccLib(ecc);

  const port = parseInt(process.env.API_PORT, 10);
  await app.listen(port, '0.0.0.0');
  console.log(`[Worker ${process.env.NODE_APP_INSTANCE}] API listening on 0.0.0.0:${port}`);

}
