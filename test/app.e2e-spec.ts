import { CACHE_MANAGER, CacheModule } from '@nestjs/cache-manager';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as request from 'supertest';
import { of } from 'rxjs';

import { AppController } from './../src/app.controller';
import { AddressSettingsService } from './../src/ORM/address-settings/address-settings.service';
import { BlocksService } from './../src/ORM/blocks/blocks.service';
import { ClientStatisticsService } from './../src/ORM/client-statistics/client-statistics.service';
import { ClientService } from './../src/ORM/client/client.service';
import { BitcoinRpcService } from './../src/services/bitcoin-rpc.service';

describe('AppController (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [AppController],
      providers: [
        {
          provide: ClientService,
          useValue: {
            getUserAgents: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: ClientStatisticsService,
          useValue: {
            getChartDataForSite: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: BlocksService,
          useValue: {
            getFoundBlocks: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: BitcoinRpcService,
          useValue: {
            newBlock$: of({ blocks: 1, difficulty: 1, chain: 'main', warnings: '' }),
          },
        },
        {
          provide: AddressSettingsService,
          useValue: {
            getHighScores: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/info (GET)', () => {
    return request(app.getHttpServer())
      .get('/info')
      .expect(200)
      .expect((response) => {
        expect(response.body.blockData).toEqual([]);
        expect(response.body.userAgents).toEqual([]);
        expect(response.body.highScores).toEqual([]);
        expect(typeof response.body.uptime).toBe('string');
      });
  });

  it('/network (GET)', () => {
    return request(app.getHttpServer())
      .get('/network')
      .expect(200)
      .expect({ blocks: 1, difficulty: 1, chain: 'main', warnings: '' });
  });
});
