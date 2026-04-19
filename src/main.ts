import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as bitcoinjs from 'bitcoinjs-lib';
import { useContainer } from 'class-validator';
import { readFileSync } from 'fs';
import * as ecc from 'tiny-secp256k1';

import { AppModule } from './app.module';

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
    }),
  );

  app.enableShutdownHooks();
  app.enableCors();
  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  //Taproot
  bitcoinjs.initEccLib(ecc);

  // Create PostgreSQL sequences for global unique ID generation
  const dataSource = app.get('DataSource');
  if (dataSource) {
    try {
      await dataSource.query("CREATE SEQUENCE IF NOT EXISTS job_id_seq START 1");
      await dataSource.query("CREATE SEQUENCE IF NOT EXISTS job_template_id_seq START 1");
    } catch (e) {
      console.error('Failed to create sequences:', e.message);
    }
  }

  await app.listen(process.env.API_PORT, '0.0.0.0', (err, address) => {
    console.log(`API listening on ${address}`);
  });

  const gracefulShutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down gracefully...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

}

bootstrap();
