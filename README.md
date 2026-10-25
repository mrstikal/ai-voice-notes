# AI Voice Notes

Local, single-user Czech voice-notes proof of concept. The UI, voice commands,
and user-facing errors are Czech; code and documentation are English.

This repository currently implements **P01-P03**: the workspace, database
container, and Czech shell; the Markdown codec and exact text limits; and the
Drizzle schema, migrations, and isolated database tests. Typed-note CRUD,
exports, dictation, and AI features arrive in later phases. No AI key or paid
provider request is needed to run the implemented phases.

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

### Migrations and test database

Committed SQL migrations live in `drizzle/`; `drizzle/0000_initial.sql` creates
the `vector`, `unaccent`, and `pg_trgm` extensions before the vector column and
then creates `notes`, `note_revisions`, `note_tags`, `note_chunks`, and
`ai_usage` with their checks, cascades, and indexes.

Create the gitignored `.env.test.local` with both targets for manual test CLI
use:

```bash
DATABASE_URL=postgresql://ai_voice_notes:ai_voice_notes@127.0.0.1:5432/ai_voice_notes
TEST_DATABASE_URL=postgresql://ai_voice_notes:ai_voice_notes@127.0.0.1:5433/ai_voice_notes_test
```

Adjust the ports when using the local host-port override. The test-database
guard requires both URLs, distinct targets, a database name ending in `_test`,
and a loopback test host before any destructive SQL.

```bash
pnpm db:migrate:test   # apply committed migrations to TEST_DATABASE_URL
pnpm test:db           # migrate the isolated test DB, then run tests/db
```

`pnpm test` runs unit tests and skips the isolated database suite unless the
test harness supplies both URLs. `pnpm db:migrate` applies committed migrations
to the development database; run it only after explicit authorization and, if
the development database contains data, after taking a backup. Migrations do not
seed data, and test commands never migrate the development database.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start Next.js in development on the validated loopback origin |
| `pnpm build` | Production build |
| `pnpm start` | Start the production build on the validated loopback origin |
| `pnpm lint` | ESLint with Next.js core-web-vitals and TypeScript rules |
| `pnpm typecheck` | Strict TypeScript check without emitting files |
| `pnpm test` | Vitest unit tests; isolated DB tests are skipped without the test harness |
| `pnpm test:db` | Migrate the isolated `_test` database and run `tests/db` |
| `pnpm db:migrate:test` | Apply committed migrations to the guarded test database |
| `pnpm db:migrate` | Apply committed migrations to the development database (explicit authorization required) |

## Markdown subset

Canonical note content is Markdown. The codec supports H1-H3, paragraphs, soft
and hard breaks, bold/italic, bullet/ordered/task lists, safe links,
blockquotes, and inline/fenced code. Safe link protocols are `http:`, `https:`,
and `mailto:`; relative paths and fragments are also allowed. Unsupported
constructs (raw HTML, tables, images, H4-H6, definitions, link references,
footnotes, strikethrough, thematic breaks) and unsafe destinations
(`javascript:`, `data:`, `file:`, protocol-relative URLs) make the whole note
source-only: the raw source is preserved verbatim, no clickable link is exposed,
and visual/DOCX conversion is refused. Limits are 160 graphemes for the title
and 20,000 visible graphemes for the content, counted with
`Intl.Segmenter("cs", { granularity: "grapheme" })`.
`content_plain` is a flat, block-separated projection for search and limits:
Markdown markers, list bullets/numbers, task checkbox state, and nesting
indentation are omitted; the parsed AST retains them for the editor and exports.
`NOTE_MAX_CHARACTERS` may lower the configured content limit but cannot exceed
20,000.

## Troubleshooting

- **Health returns 503:** run `docker compose ps` and `docker compose up -d db`,
  then check that `DATABASE_URL` in `.env.local` matches the compose service.
- **Node version error:** run `nvm use` in the repository root.
- **Port already in use:** change `APP_ORIGIN` to another loopback port; the
  `dev` and `start` scripts use its host and port.
