# Agent Guide for Public-Pool

This document contains essential context for AI coding agents working on the `public-pool` repository. The reader is assumed to know nothing about the project.

## Project Overview

`public-pool` is a **Bitcoin Stratum mining pool server** written in **TypeScript** using the **NestJS** framework. It exposes two network interfaces from a single Node.js process:

1. **Stratum TCP Server** (`STRATUM_PORT`, default `3333`) – Accepts raw TCP connections from ASIC miners and speaks the Stratum V1 protocol (subscription, authorization, job distribution, and share submission).
2. **HTTP REST API** (`API_PORT`, default `3334`) – Built on **Fastify** via `@nestjs/platform-fastify`. Provides pool statistics, miner info, block history, and hashrate charts.

The server connects to a local **Bitcoin Core** node over RPC (and optionally ZeroMQ) to fetch block templates, submit solved blocks, and monitor chain height.

### Key Dependencies

| Dependency | Purpose |
|---|---|
| `@nestjs/*` (v9) | Web framework, scheduling, configuration, caching, TypeORM integration |
| `fastify` (via `@nestjs/platform-fastify`) | HTTP server engine |
| `typeorm` + `sqlite3` | ORM and local SQLite database |
| `bitcoinjs-lib` | Bitcoin transaction/block serialization, address handling, Taproot |
| `zeromq` (v6 beta) | Optional ZMQ subscription to `rawblock` from Bitcoin Core |
| `rpc-bitcoin` | JSON-RPC client for Bitcoin Core (patched via `patch-package`) |
| `merkle-lib` | Merkle tree construction for block templates |
| `class-validator` / `class-transformer` | DTO validation for Stratum messages and HTTP inputs |
| `discord.js` / `node-telegram-bot-api` | Optional notification bots for block finds |

## Project Structure

```
public-pool/
├── src/
│   ├── main.ts                       # Bootstrap: Fastify app, global pipes, HTTPS, SIGTERM handling
│   ├── app.module.ts                 # Root NestJS module: ORM, cache, schedule, controllers, providers
│   ├── app.controller.ts             # Root REST controller (/api/info, /api/pool, /api/network, /api/info/chart)
│   ├── controllers/                  # Additional HTTP controllers
│   │   ├── address/                  # Address-specific settings & stats
│   │   ├── client/                   # Client (miner) lookup endpoints
│   │   └── external-share/           # External share submission endpoint
│   ├── models/                       # Domain models, Stratum message DTOs, enums, validators
│   │   ├── StratumV1Client.ts        # Core class handling a single miner TCP session
│   │   ├── MiningJob.ts              # Block-template job logic
│   │   ├── stratum-messages/         # Subscription, authorize, submit, error, etc.
│   │   ├── enums/                    # eRequestMethod, eResponseMethod, eStratumErrorCode
│   │   └── validators/               # Custom class-validator rules (e.g. BitcoinAddressValidator)
│   ├── ORM/                          # TypeORM entities, modules, and services
│   │   ├── client/                   # Connected miner sessions
│   │   ├── client-statistics/        # Hashrate / share statistics over time
│   │   ├── address-settings/         # Per-address best-difficulty and config
│   │   ├── blocks/                   # Mined blocks (found by pool)
│   │   ├── rpc-block/                # Cached block templates fetched from Bitcoin RPC
│   │   ├── external-shares/          # Shares submitted to external pools
│   │   ├── telegram-subscriptions/   # Telegram chat IDs for notifications
│   │   └── utils/                    # DateTimeTransformer, TrackedEntity base class
│   ├── services/                     # Business-logic services
│   │   ├── stratum-v1.service.ts     # TCP server bootstrap
│   │   ├── stratum-v1-jobs.service.ts# RxJS-based block-template job generation
│   │   ├── bitcoin-rpc.service.ts    # Bitcoin Core RPC + ZMQ interaction
│   │   ├── notification.service.ts   # Orchestrates Telegram/Discord notifications
│   │   ├── telegram.service.ts       # Telegram bot wrapper
│   │   ├── discord.service.ts        # Discord bot wrapper
│   │   ├── external-shares.service.ts# Submits high-difficulty shares to external APIs
│   │   ├── braiins.service.ts        # Braiins pool-specific integrations
│   │   ├── btc-pay.service.ts        # BTCPay integration
│   │   └── app.service.ts            # House-keeping intervals (cleanup dead clients, old stats/blocks)
│   └── utils/
│       └── difficulty.utils.ts       # Difficulty calculation helpers
├── test/                             # E2E tests (Jest)
│   ├── app.e2e-spec.ts
│   ├── jest-e2e.json
│   └── models/
│       └── MockRecording1.ts
├── patches/                          # patch-package patches
│   └── rpc-bitcoin+2.0.0.patch       # Fixes jsonrpc type (number -> string) for Bitcoin Core compatibility
├── secrets/                          # HTTPS key.pem / cert.pem (loaded when API_SECURE=true)
├── full-setup/                       # Docker Compose stacks for mainnet/testnet/regtest + Bitcoin Core configs
├── config/                           # Runtime config samples
├── Dockerfile                        # Multi-stage build (node:22.11.0-bookworm-slim)
├── docker-compose.yml                # Compose service for public-pool only
├── package.json
├── tsconfig.json / tsconfig.build.json
├── nest-cli.json
├── .eslintrc.js
├── .prettierrc
└── .env.example
```

## Build, Run, and Test Commands

All commands are standard npm scripts:

```bash
# Install dependencies & apply patches
npm install

# Development (watch mode)
npm run start:dev

# Production build
npm run build

# Production start (requires dist/ to exist)
npm run start:prod   # node dist/main

# Lint & format
npm run lint         # ESLint --fix
npm run format       # Prettier write src/**/*.ts test/**/*.ts

# Unit tests (Jest, rootDir: src)
npm run test
npm run test:watch
npm run test:cov

# E2E tests
npm run test:e2e     # jest --config ./test/jest-e2e.json
```

### Docker

```bash
# Build image
docker build -t public-pool .

# Run container (mount .env and DB volume)
docker container run --name public-pool --rm -p 3333:3333 -p 3334:3334 -v .env:/public-pool/.env public-pool

# Or use Docker Compose
docker compose build
docker compose up -d
```

The `Dockerfile` is a multi-stage build:
1. **Build stage** – installs `python3`, `build-essential`, `cmake`, runs `npm i && npm run build`.
2. **Final stage** – copies the full `/build` tree (including `node_modules` and `dist`) and runs `node dist/main`.

Exposed ports: `3333` (Stratum), `3334` (API), `8332` (Bitcoin RPC passthrough).

## Configuration / Environment Variables

Copy `.env.example` to `.env` and populate at minimum:

| Variable | Description |
|---|---|
| `BITCOIN_RPC_URL` | Bitcoin Core RPC host (e.g. `http://192.168.1.100`) |
| `BITCOIN_RPC_USER` / `BITCOIN_RPC_PASSWORD` | RPC credentials |
| `BITCOIN_RPC_PORT` | Default `8332` |
| `BITCOIN_RPC_TIMEOUT` | Default `10000` |
| `BITCOIN_RPC_COOKIEFILE` | Path to `.cookie` file (alternative to user/pass) |
| `BITCOIN_ZMQ_HOST` | Optional ZMQ `tcp://host:port` for rawblock (e.g. `tcp://192.168.1.100:3000`) |
| `API_PORT` | HTTP API port (default `3334`) |
| `STRATUM_PORT` | Stratum TCP port (default `3333`) |
| `NETWORK` | `mainnet`, `testnet`, or `regtest` |
| `API_SECURE` | Set `true` to enable HTTPS (reads `secrets/key.pem` and `secrets/cert.pem`) |
| `POOL_IDENTIFIER` | String included in external share submissions (default `"Public-Pool"`) |
| `DEV_FEE_ADDRESS` | Optional developer fee Bitcoin address |
| `TELEGRAM_BOT_TOKEN` | Optional Telegram bot token |
| `DISCORD_BOT_CLIENTID` / `DISCORD_BOT_GUILD_ID` / `DISCORD_BOT_CHANNEL_ID` | Optional Discord integration |

> **Important:** The application **exits immediately** on startup if `API_PORT` is not defined (`main.ts` checks this).

## Code Style Guidelines

- **Prettier** is enforced via ESLint (`plugin:prettier/recommended`).
- `.prettierrc` settings:
  - `singleQuote: true`
  - `trailingComma: "all"`
- **ESLint** (`@typescript-eslint/recommended`) is configured in `.eslintrc.js`.
- The following rules are explicitly **turned off**:
  - `@typescript-eslint/explicit-function-return-type`
  - `@typescript-eslint/explicit-module-boundary-types`
  - `@typescript-eslint/no-explicit-any`
  - `@typescript-eslint/interface-name-prefix`
- `tsconfig.json` has **strict checks disabled**: `strictNullChecks: false`, `noImplicitAny: false`, `strictBindCallApply: false`. Do not introduce stricter TS settings without explicit instruction.
- Use NestJS decorators (`@Injectable`, `@Controller`, `@Module`, etc.) consistently.
- Prefer `async/await` over raw promises in business logic.

## Architecture Notes

### Dual Server Model

- **HTTP API** is created via `NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(...))` and listens on `API_PORT`.
- **Stratum TCP** is a raw `net.Server` spawned inside `StratumV1Service.onModuleInit()` and listens on `STRATUM_PORT`. Each incoming socket instantiates a `StratumV1Client`.

### Database

- **SQLite** (`./DB/public-pool.sqlite`) with `synchronize: true` and **WAL mode** (`enableWAL: true`).
- `PRAGMA synchronous = off;` is executed at startup for performance.
- Entities use `WITHOUT ROWID` where appropriate (e.g. `ClientEntity`) and inherit from `TrackedEntity` (created/updated timestamps).

### Block Template Lifecycle

1. `BitcoinRpcService` polls `getmininginfo` every 500 ms (or listens to ZMQ `rawblock`).
2. On new height, it emits `newBlock$`.
3. `StratumV1JobsService` reacts via RxJS `combineLatest` with a 60-second interval, fetches `getblocktemplate`, builds a `bitcoinjs.Block`, computes the Merkle tree, and emits `newMiningJob$`.
4. `StratumV1Client` subscribers receive the job, serialize it, and send `mining.notify` to miners.
5. When a share meets network difficulty, `BitcoinRpcService.SUBMIT_BLOCK(hexdata)` is called.

### Multi-Process Awareness

The code checks `process.env.NODE_APP_INSTANCE` (used by PM2 cluster mode):
- Only instance `0` runs database cleanups (`deleteOldStatistics`, `killDeadClients`, `deleteOldBlocks`).
- `StratumV1Service` deletes all clients on init only for instance `0`.
- `BitcoinRpcService` uses `rpcBlockService.lockBlock()` so that only one cluster process fetches and stores a given block template.

### Patches

`patch-package` runs automatically on `postinstall`. The only current patch (`patches/rpc-bitcoin+2.0.0.patch`) changes the `jsonrpc` field from `1.0` (number) to `"1.0"` (string) to satisfy Bitcoin Core's strict JSON-RPC parser.

## Testing Instructions

- **Unit tests:** `npm run test` (Jest, `rootDir: src`, regex `.*\.spec\.ts$`).
- **Coverage:** `npm run test:cov` outputs to `./coverage`.
- **E2E tests:** `npm run test:e2e` uses `test/jest-e2e.json`.

> Note: Many core domain classes (e.g. `StratumV1Client`, `MiningJob`) contain direct socket I/O and Bitcoin RPC calls. Unit tests that exist (`.spec.ts` files) mock or exercise isolated logic; full integration tests require a running Bitcoin Core node and are not present in the standard test suite.

## Security Considerations

- **Do not commit `.env`** – it contains RPC credentials and bot tokens.
- **RPC cookie file path** can be used instead of plaintext user/password.
- **HTTPS** can be enabled via `API_SECURE=true` and placing PEM files in `secrets/`.
- The Stratum server accepts raw TCP from any source by default; firewall `STRATUM_PORT` appropriately.
- `DEV_FEE_ADDRESS` injects a 1.5 % pool fee into the coinbase payout of miners with > 50 TH/s hashrate. Low-hashrate miners (< 50 TH/s) are fee-exempt (`noFee`).
- SQLite runs with `synchronize: true`, which auto-creates/updates schema. In production, consider migration strategies if schema changes.

## CI / Deployment

GitHub Actions workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|---|---|---|
| `build-image-on-push.yml` | PRs, non-master pushes | Docker build test with cache (AMD64) |
| `update-image-on-push.yml` | `master` push | Multi-arch build & push to GHCR + DockerHub |
| `trivy-analysis.yml` | Push, PR, weekly cron | Vulnerability scan with Trivy, uploads SARIF |

Runtime deployment options:
- **Docker / Docker Compose** (recommended)
- **PM2:** `pm2 start dist/main.js`

## Useful Context for Agents

- When modifying Stratum protocol behavior, edit files in `src/models/stratum-messages/` **and** `src/models/StratumV1Client.ts`.
- When adding new database fields, create a TypeORM entity in `src/ORM/<feature>/`, register the module in `app.module.ts`, and add the corresponding service method.
- The project does **not** use a traditional `repository` layer pattern; database access is done directly via injected TypeORM `Service` classes that wrap `Repository<Entity>`.
- `bitcoinjs-lib` is initialized with `tiny-secp256k1` in `main.ts` for Taproot support.
