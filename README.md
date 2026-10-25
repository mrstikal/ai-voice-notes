# AI Voice Notes

Local, single-user Czech voice-notes proof of concept. The UI, voice commands,
and user-facing errors are Czech; code and documentation are English.

This repository currently implements **P01 - Workspace, database container, and
Czech shell**. Typed-note CRUD, exports, dictation, and AI features arrive in
later phases. No AI key or paid provider request is needed to run this phase.

## Prerequisites

- Linux or WSL with Docker Engine and Docker Compose v2
- [nvm](https://github.com/nvm-sh/nvm) and the Node.js version from `.nvmrc`
  (Node.js >= 22.19 is required)
- pnpm 10.33.0 (the pinned `packageManager` in `package.json`)

```bash
nvm install
nvm use
corepack enable
```

## Local setup

```bash
pnpm install
cp .env.example .env.local
docker compose up -d db
pnpm dev
```

Open <http://127.0.0.1:3000>. The health endpoint is
<http://127.0.0.1:3000/api/health>:

- `200 {"status":"ok"}` when PostgreSQL is reachable
- `503` with an actionable Czech message when it is not

`pnpm dev` and `pnpm start` bind Next.js to the loopback address from
`APP_ORIGIN` (default `127.0.0.1:3000`). The app is not reachable from another
host by default and has no authentication, so do not expose it to a network.

## Environment

Copy `.env.example` to `.env.local`. Both `.env.local` and `.env.test.local` are
gitignored. Provider keys stay empty until a later phase requires them and a
live check is separately authorized.

| Variable | Purpose | Default |
|---|---|---|
| `APP_ORIGIN` | Loopback origin with explicit port | `http://127.0.0.1:3000` |
| `DATABASE_URL` | Development PostgreSQL URL | compose `db` service |
| `TEST_DATABASE_URL` | Isolated test PostgreSQL URL | compose `db-test` service |
| `AI_TEST_MODE` | Test-only switch; leave empty normally | empty |
| `NOTE_MAX_CHARACTERS` | Maximum visible note characters | `20000` |
| `MEETING_MAX_MINUTES` | Maximum meeting length | `15` |
| `AI_REQUEST_BUDGET_USD` | Local estimated AI admission budget | `2.00` |

`APP_ORIGIN` is validated at startup. Only `127.0.0.1`, `localhost`, or `::1`
with an explicit port is accepted; paths, credentials, and other hosts are
rejected with a Czech error.

## Databases

The development database uses PostgreSQL 17 with pgvector and a persistent named
volume:

```bash
docker compose up -d db
```

Data survives container restarts because `/var/lib/postgresql/data` is mounted
on the `db-data` named volume. The host ports default to 5432 (development) and
5433 (test). Compose reads `DB_HOST_PORT` and `TEST_DB_HOST_PORT` from a local
`.env` file, so if those ports are already occupied, create a gitignored `.env`
with different host ports and update the URLs in `.env.local` accordingly.

The isolated test database runs on port 5433 with its own `db-test-data` volume
and the `test` Compose profile:

```bash
docker compose --profile test up -d db-test
```

Migrations and seeding are intentionally not implemented in P01; there are no
placeholder `db:migrate` or `db:seed` scripts.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start Next.js in development on the validated loopback origin |
| `pnpm build` | Production build |
| `pnpm start` | Start the production build on the validated loopback origin |
| `pnpm lint` | ESLint with Next.js core-web-vitals and TypeScript rules |
| `pnpm typecheck` | Strict TypeScript check without emitting files |
| `pnpm test` | Vitest unit tests |

## Troubleshooting

- **Health returns 503:** run `docker compose ps` and `docker compose up -d db`,
  then check that `DATABASE_URL` in `.env.local` matches the compose service.
- **Node version error:** run `nvm use` in the repository root.
- **Port already in use:** change `APP_ORIGIN` to another loopback port; the
  `dev` and `start` scripts use its host and port.
