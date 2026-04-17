# Public-Pool

A NestJS and TypeScript Bitcoin Stratum mining pool server. It exposes a Stratum V1 TCP mining endpoint for miners and a REST API for pool statistics and worker monitoring.

## Technology Stack

- **Runtime**: Node.js 22.11.0 (Dockerfile targets `node:22.11.0-bookworm-slim`)
- **Framework**: NestJS 9.x with Fastify (`@nestjs/platform-fastify`)
- **Language**: TypeScript 5.x (target `ES2020`, module `commonjs`)
- **Database**: SQLite 3 via TypeORM (`sqlite3`)
  - Database file: `./DB/public-pool.sqlite`
  - WAL mode enabled (`enableWAL: true`)
  - Entities auto-synchronize (`synchronize: true`)
- **Bitcoin Libraries**: `bitcoinjs-lib`, `bitcoinjs-message`, `tiny-secp256k1`, `merkle-lib`
- **RPC**: `rpc-bitcoin` (patched via `patch-package`)
- **ZMQ**: `zeromq` for raw block notifications from Bitcoin Core
- **Caching**: `@nestjs/cache-manager`
- **Scheduling**: `@nestjs/schedule` for periodic tasks
- **Notifications**: Optional Telegram and Discord bots

## Project Structure

```
src/
├── main.ts                     # Application bootstrap (Fastify adapter, CORS, HTTPS optional)
├── app.module.ts               # Root NestJS module (TypeORM, Cache, Schedule, controllers, providers)
├── app.controller.ts           # Root HTTP controller
├── controllers/                # REST API controllers
│   ├── address/                # Address settings endpoint (Bitcoin message verification stub)
│   ├── client/                 # Worker/client info and chart data endpoints
│   └── external-share/         # External share submission controller
├── models/                     # Domain models, DTOs, enums, validators
│   ├── StratumV1Client.ts      # Core Stratum client connection handler
│   ├── MiningJob.ts            # Job construction and block serialization
│   ├── stratum-messages/       # Stratum protocol message DTOs
│   ├── bitcoin-rpc/            # RPC response interfaces
│   └── validators/             # Custom class-validator rules
├── ORM/                        # TypeORM entities, modules, and services
│   ├── client/                 # Connected miner sessions
│   ├── client-statistics/      # Hashrate/difficulty chart data
│   ├── address-settings/       # Per-address best difficulty and settings
│   ├── blocks/                 # Mined blocks history
│   ├── rpc-block/              # Cached block templates (coordination across cluster processes)
│   ├── external-shares/        # External share records
│   ├── telegram-subscriptions/ # Telegram notification subscriptions
│   └── utils/                  # DateTimeTransformer, TrackedEntity base class
├── services/                   # Business logic providers
│   ├── stratum-v1.service.ts   # TCP Stratum server lifecycle
│   ├── stratum-v1-jobs.service.ts  # Block template -> mining job pipeline
│   ├── bitcoin-rpc.service.ts  # Bitcoin Core RPC + ZMQ integration
│   ├── notification.service.ts # Orchestrates Telegram/Discord alerts
│   ├── telegram.service.ts     # Telegram bot integration
│   ├── discord.service.ts      # Discord bot integration
│   ├── external-shares.service.ts
│   ├── braiins.service.ts      # Braiins integration helper
│   ├── btc-pay.service.ts      # BTCPay integration helper
│   └── app.service.ts          # Generic app service
└── utils/
    └── difficulty.utils.ts     # Difficulty calculation helpers
```

## Build and Run Commands

Install dependencies:
```bash
npm install
```

Create an `.env` file from `.env.example` and configure it before running.

Development:
```bash
npm run start:dev      # Watch mode
npm run start          # Single run dev mode
npm run start:debug    # Debug + watch
```

Production build:
```bash
npm run build          # Outputs to ./dist
npm run start:prod     # Runs node dist/main
```

Lint and format:
```bash
npm run lint           # ESLint with auto-fix
npm run format         # Prettier formatting
```

## Testing Commands

Unit tests:
```bash
npm run test           # Jest, rootDir: src, pattern: *.spec.ts
npm run test:watch     # Jest in watch mode
npm run test:cov       # Coverage report to ./coverage
npm run test:debug     # Node inspector for Jest
```

End-to-end tests:
```bash
npm run test:e2e       # Jest with ./test/jest-e2e.json, pattern: *.e2e-spec.ts
```

## Runtime Architecture

The application starts two servers:

1. **Stratum TCP Server** (`StratumV1Service`)
   - Listens on `STRATUM_PORT` (default 3333)
   - Handles Stratum V1 protocol: `mining.subscribe`, `mining.configure`, `mining.authorize`, `mining.suggest_difficulty`, `mining.submit`
   - Each connection is managed by a `StratumV1Client` instance
   - Difficulty auto-adjustment runs every 60 seconds per client

2. **REST API Server** (`main.ts`)
   - Listens on `API_PORT` (default 3334)
   - Base path: `/api`
   - Optional HTTPS via `secrets/key.pem` and `secrets/cert.pem` when `API_SECURE=true`

**Bitcoin Core Integration** (`BitcoinRpcService`):
- Connects via JSON-RPC (`rpc-bitcoin`) using credentials from `.env` or a cookie file
- Optional ZMQ `rawblock` subscription for near-instant new-block detection
- Falls back to polling `getmininginfo` every 500ms if ZMQ is not configured
- Fetches `getblocktemplate`, caches templates in the `RpcBlock` table for multi-process coordination

**Job Pipeline** (`StratumV1JobsService`):
- Reacts to new blocks or a 60-second interval
- Builds `bitcoinjs.Block` templates with merkle branches and witness commitments
- Publishes new `IJobTemplate` objects via RxJS observable to all connected miners
- Old jobs/templates are purged after 5 minutes

## Environment Configuration

Key variables from `.env.example`:

- `BITCOIN_RPC_URL` / `BITCOIN_RPC_PORT` / `BITCOIN_RPC_USER` / `BITCOIN_RPC_PASSWORD`
- `BITCOIN_RPC_COOKIEFILE` — alternative to user/password
- `BITCOIN_RPC_TIMEOUT` — RPC timeout in ms
- `BITCOIN_ZMQ_HOST` — optional ZMQ rawblock endpoint (e.g., `tcp://host:3000`)
- `API_PORT` — REST API port (default 3334)
- `STRATUM_PORT` — Stratum TCP port (default 3333)
- `NETWORK` — `mainnet`, `testnet`, or `regtest`
- `DEV_FEE_ADDRESS` — optional developer fee address (1.5% fee applied to miners > 50 TH/s)
- `POOL_IDENTIFIER` — pool name used in external share submissions (default `Public-Pool`)
- `API_SECURE` — set `true` to enable HTTPS
- `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_CLIENTID`, `DISCORD_BOT_GUILD_ID`, `DISCORD_BOT_CHANNEL_ID` — optional notifications
- `EXTERNAL_SHARE_SUBMISSION_ENABLED` / `MINIMUM_DIFFICULTY` — optional external share API submission

## Code Style Guidelines

- **Formatter**: Prettier with `singleQuote: true` and `trailingComma: all`
- **Linter**: ESLint with `@typescript-eslint/recommended` and `prettier/recommended`
- Strict return types and module boundaries are **not** enforced (`explicit-function-return-type: off`, `no-explicit-any: off`)
- Decorator metadata is enabled in `tsconfig.json` for NestJS DI and `class-validator`
- Import style: mixed absolute package imports and relative path imports within `src/`

## Deployment

### Docker

Build:
```bash
docker build -t public-pool .
```

Run:
```bash
docker container run --name public-pool --rm -p 3333:3333 -p 3334:3334 -p 8332:8332 -v .env:/public-pool/.env public-pool
```

### Docker Compose

```bash
docker compose build
docker compose up -d
```

The compose file binds to `127.0.0.1` by default. To expose externally, remove the `127.0.0.1:` prefix from the port mappings.

### PM2

```bash
pm2 start dist/main.js
```

### Cluster / Multi-process Notes

- `NODE_APP_INSTANCE` is used to coordinate block template loading across cluster workers
- The `RpcBlock` table has a unique constraint on block height to prevent multiple processes from fetching the same template concurrently
- `onModuleInit` in `StratumV1Service` clears all client records when `NODE_APP_INSTANCE == '0'`

## CI/CD

GitHub Actions workflows (`.github/workflows/`):

- `build-image-on-push.yml` — Builds the Docker image on non-master pushes and PRs (amd64 only, no push)
- `update-image-on-push.yml` — Builds and pushes multi-arch images (`linux/amd64`, `linux/arm64`) to DockerHub and GitHub Container Registry on `master` pushes
- `trivy-analysis.yml` — Builds the image and scans it with Trivy for `CRITICAL` and `HIGH` severity vulnerabilities; uploads SARIF to GitHub Security tab

## Notable Dependencies and Patches

- `patches/rpc-bitcoin+2.0.0.patch`: Fixes the `jsonrpc` field type in `rpc-bitcoin` from `number` to `string` (`"1.0"` instead of `1.0`) to comply with strict Bitcoin Core JSON-RPC expectations. Applied automatically via `patch-package` on `npm install` (`postinstall` script).

## Security Considerations

- The Stratum server listens on `0.0.0.0` for the API and the configured host for the TCP server
- HTTPS support requires manually placing `secrets/key.pem` and `secrets/cert.pem`
- Bitcoin RPC credentials or a cookie file are required; never commit them
- When running in Docker, Bitcoin Core must allow RPC from the Docker network (`rpcallowip=172.16.0.0/12`)
- `synchronize: true` is enabled for TypeORM; review entity changes carefully in production to avoid accidental schema mutations
