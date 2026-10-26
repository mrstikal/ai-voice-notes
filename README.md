# AI Voice Notes

Local, single-user Czech voice-notes proof of concept. The UI, voice commands,
and user-facing errors are Czech; code and documentation are English.

This repository currently implements **P01-P09**: the workspace, database
container, and Czech shell; the Markdown codec and exact text limits; the
Drizzle schema, migrations, and isolated database tests; the local HTTP guard;
the versioned notes CRUD API; the paginated notes and Trash UI; the optional
transaction-safe demo-note seed CLI; the Markdown-first source/visual editor;
and the debounced autosave with conflict recovery. Exports, dictation, and AI
features arrive in later phases. No AI key or paid provider request is needed
to run the implemented phases.

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
| `APP_ALLOW_FORWARDED_LOOPBACK` | Accept a different loopback Host/Origin port from a local port forwarder | `0` |
| `DATABASE_URL` | Development PostgreSQL URL | compose `db` service |
| `TEST_DATABASE_URL` | Isolated test PostgreSQL URL | compose `db-test` service |
| `AI_TEST_MODE` | Test-only switch; leave empty normally | empty |
| `ELEVENLABS_API_KEY` | Server-side ElevenLabs key; empty until an authorized live check | empty |
| `ELEVENLABS_API_BASE_URL` | ElevenLabs API endpoint; test mode requires a loopback mock | `https://api.elevenlabs.io` |
| `NOTE_MAX_CHARACTERS` | Maximum visible note characters | `20000` |
| `MEETING_MAX_MINUTES` | Maximum meeting length | `15` |
| `AI_REQUEST_BUDGET_USD` | Local estimated AI admission budget | `2.00` |

When `AI_TEST_MODE=1`, startup requires `DATABASE_URL` (and, when set,
`TEST_DATABASE_URL`) to name a database ending with `_test`, a loopback
`ELEVENLABS_API_BASE_URL` with an explicit port, and exact dummy provider keys
for any configured credential (`test-only-elevenlabs`,
`test-only-openrouter`, `test-only-openai`, `test-only-gemini`). Real keys are
rejected before a provider client is constructed.

`APP_ORIGIN` is validated at startup. Only `127.0.0.1`, `localhost`, or `::1`
with an explicit port is accepted; paths, credentials, and other hosts are
rejected with a Czech error. Set `APP_ALLOW_FORWARDED_LOOPBACK=1` only when a
local IDE or remote port forwarder rewrites the port (for example VS Code
forwarding `3000` to `53508`); forwarded Host and Origin must still be loopback
and use the same port.

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

`pnpm test` runs unit and API tests; when both database URLs are present, the
isolated database suite also runs. Test files run serially so the two DB suites
cannot truncate each other. `pnpm db:migrate` applies committed migrations
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
| `pnpm test` | Vitest unit/API tests; the DB suite also runs when both URLs are present |
| `pnpm test:db` | Migrate the isolated `_test` database and run `tests/db` |
| `pnpm test:e2e` | Build and run the offline Playwright notes/Trash flow |
| `pnpm db:seed` | Explicitly replace the `demo-v1:*` demo notes in the dev database |
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

## Notes API

The versioned CRUD API uses the P04 Host/Origin and bounded-body guard:

| Route | Behavior |
|---|---|
| `GET /api/notes?page=N` | Ten active notes per page, ordered by creation time then ID; deleted notes excluded |
| `POST /api/notes` | Create from `{title, contentMd}`; returns 201 |
| `GET /api/notes/:id` | Read one active note; deleted or missing notes return 404 |
| `PATCH /api/notes/:id` | Update `{title, contentMd, expectedVersion}`; optional `draft: true` skips the named revision; stale versions return 409 with `latestVersion` |
| `PATCH /api/notes/:id/title` | Voice-title update `{title, expectedVersion}`; changes only the title and creates a server-derived `voice` revision |
| `DELETE /api/notes/:id` | Soft-delete `{expectedVersion}`; no hard-delete route exists |
| `POST /api/notes/:id/restore` | Restore from Trash with `{expectedVersion}` |

Server code derives `content_plain` and grapheme counts, creates initial,
manual, voice, and restore revision snapshots, and never accepts
client-supplied derived fields, seed keys, timestamps, or revision reasons.
Mutation bodies use the 1 MiB note ceiling.

## Editor and autosave

The note detail page edits canonical Markdown in a source textarea and in a
Markdown-first visual editor. Both modes share one content state, so the
grapheme counter, the limit check, and the save flow behave identically.

Typing is autosaved after ~800 ms of inactivity as a versioned draft PATCH
(`draft: true`). Draft saves update `notes.version` but create no named
revision, so the history does not grow per keystroke; the explicit **Uložit**
button creates one named `manual` revision (a checkpoint). Writes for one note
are serialized: at most one request is in flight, and the explicit save takes
over a pending debounced draft instead of racing it. Content that exceeds the
limit or cannot be serialized is never sent.

An unsaved draft is kept per browser tab in `sessionStorage` under
`note-draft:{noteId}:{baseVersion}` and offered for recovery after a reload.
The stored draft is deleted only after the server acknowledges a save. Leaving
the page with unsaved changes warns first.

A stale write (HTTP 409) pauses autosaving and shows the local text next to the
current server text with copy and reload actions. Nothing is merged or
overwritten automatically: the user compares, copies, or reloads and decides.

## Seeding demo notes

`pnpm db:seed` is an optional, explicit CLI for the development database. It
never runs during `dev`, startup, build, install, or migrations. The command
warns before it hard-deletes only notes whose `seed_key` starts with `demo-v1:`,
inserts the 20 current Czech fixtures and their initial revisions in one
transaction under a PostgreSQL advisory lock, and leaves user notes and other
seed namespaces untouched. Dates are randomized per invocation; D01 is always
dated within the current UTC day and the others fall within the last 30 days.
An edited or soft-deleted demo note is replaced on the next run.

Test mode uses only the guarded `_test` database; it never falls back to the
development target. `pnpm test:db` runs the seed tests, including repeatability,
revision timestamps, rollback on injected failure, and a check that missing or
invalid `TEST_DATABASE_URL` does not mutate the development database. No seed of
the development database, no audio, and no AI call is part of the test suite.

## End-to-end tests

Install the Playwright Chromium browser once:

```bash
pnpm exec playwright install chromium
```

Then run:

```bash
pnpm test:e2e
```

The command builds Next.js, starts `scripts/test-server.ts` on
`127.0.0.1:3100`, asserts the guarded `_test` targets, migrates and truncates
only the isolated test database, and runs the offline notes/Trash, editor, and
autosave flows (including the two-tab conflict case). No seed or provider key
is used.

## HTTP boundary

API mutations are guarded by the configured loopback `Host` and an exact
`Origin`, require `application/json`, and are read with per-route streaming byte
ceilings: 1 MiB for note edits, 16 KiB for token/tool routes, and 3 MiB for
reviewed meeting saves. Raw meeting audio will use a separate 25 MiB stream cap.
A body over its ceiling receives an explicit Czech 413 without truncation.
Costly routes can attach a Zod schema and an in-memory rate limiter; rejected
requests never call the route handler. GET/HEAD routes never mutate or bill.

## Troubleshooting

- **Health returns 503:** run `docker compose ps` and `docker compose up -d db`,
  then check that `DATABASE_URL` in `.env.local` matches the compose service.
- **Node version error:** run `nvm use` in the repository root.
- **Port already in use:** change `APP_ORIGIN` to another loopback port; the
  `dev` and `start` scripts use its host and port.
