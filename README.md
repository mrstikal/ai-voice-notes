# AI Voice Notes

Local, single-user Czech voice-notes proof of concept. The UI, voice commands,
and user-facing errors are Czech; code and documentation are English.

This repository implements **P01-P44** in four stages:

1. **Typed notes:** Czech CRUD, versioning/history, Markdown source/visual
   editor, autosave/conflict recovery, Trash, DOCX/Markdown export and an
   optional transaction-safe demo seed.
2. **Voice:** ElevenLabs Scribe v2 realtime dictation with an exclusive
   microphone lease, ElevenLabs/OpenRouter TTS with a validated local cache,
   read-aloud and the experimental spoken Stop.
3. **Approved AI:** bounded edits/proposals through P22-P24, cleanup,
   summaries, tasks/tags, voice command interpretation, grounded Ask, and
   P12 cost/usage admission. Every note mutation needs a visible diff and an
   explicit confirmation.
4. **Search and meetings:** offline Czech full-text search, optional semantic
   and hybrid search, direct batch Scribe v2 meeting transcription, reviewed
   meeting-note save and reviewed summary/decisions/tasks.

P44 adds the four-stage offline integration, privacy/recovery audit and this
quality report. The separate **P45+ OpenAI voice agent is not implemented**.
Typed notes, search and exports work with **no AI keys** and no provider
request; provider features are visibly disabled until a separately authorized
live check. `AI_TEST_MODE=1` is test-only and refuses real credentials.

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

## Meetings and FFmpeg

The meeting flow is inspect → paid batch transcription → editable preview →
explicit save → optional reviewed summary/decisions/tasks. A transcript is never
saved as a note implicitly, and AI suggestions are unsaved artifacts until a
visible P22-P24 diff is confirmed.

Meeting capture (`/meetings`) requires host FFmpeg executables on `PATH` from
P41B onward. The server uses `ffprobe` against its own private temp file to
verify the real container, audio codec and duration; a client filename or MIME
label is never trusted. Missing or broken FFmpeg returns a Czech error before a
file is accepted.

Ubuntu / WSL installation and detection:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
ffprobe -version
ffmpeg -version
```

If the host has no package privileges, a static Linux build may be unpacked and
its `ffmpeg`/`ffprobe` placed in a user `PATH` directory such as
`~/.local/bin`; verify both commands the same way. Do not commit binaries.

The accepted meeting inputs are MP3, WAV (PCM) and WebM-Opus. The direct
ElevenLabs batch Scribe v2 documentation (checked 2026-10-29) lists MP3, WAV,
WebM and Opus among supported audio formats; this app applies stricter local
limits of 15 minutes and 25 MiB and rejects Matroska/other containers even when
they contain Opus. Browser duration and size guards are UX only; `ffprobe`
metadata is authoritative. P41B makes no provider call.

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
| `OPENROUTER_API_KEY` | Server-side OpenRouter key for structured AI, TTS and embeddings; empty disables those features | empty |
| `OPENROUTER_LLM_MODEL` | P21 structured-output model; changing it requires a new preflight and approval | `deepseek/deepseek-v4.1-flash-1017` |
| `OPENROUTER_EMBEDDING_MODEL` | P36 embedding model; pinned to the 1536-dimension column | `openai/text-embedding-3-small` |
| `OPENAI_API_KEY` | Reserved for the not-yet-implemented P45+ realtime agent; empty | empty |
| `GEMINI_API_KEY` | Optional P55+ comparison; not required by the core | empty |
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

## Privacy, first-use notices and offline behavior

Typed note editing, Markdown conversion, full-text search, version history and
exports are local: no provider call is made and no key is required. Provider
features show Czech first-use notices on their page or in **Nastavení →
Soukromí a náklady**; the same disclosure is repeated at the point of a paid
action.

| Feature | What leaves the machine | What the app stores |
|---|---|---|
| Dictation | Microphone audio streamed to ElevenLabs Scribe v2 realtime | Transient partial/committed text in the note draft; no audio or provider transcript table |
| Meeting transcription | The selected meeting file uploaded once to ElevenLabs batch Scribe v2 | Temporary `0600` file under `.data/uploads`, unlinked after the request; only the reviewed note text is saved |
| Read aloud | The selected note text to OpenRouter TTS | Validated MP3 and technical metadata in the local `.data/tts` cache |
| AI edits/summary/tasks/Ask | The selected note text or bounded excerpt to OpenRouter | Note revisions after explicit confirmation; P12 usage metadata without prompts or note bodies |
| Semantic search | Note chunks or the query to OpenRouter embeddings | Vectors and technical index state in PostgreSQL |
| Voice agent (P45+) | Not implemented | Nothing |

ElevenLabs and OpenRouter process requests under their own retention policies;
zero retention depends on the account/plan. The app does not claim provider-side
zero retention and does not set provider logging flags it cannot verify. Keys
stay server-side, are never written to logs, browser bundles, URLs or the usage
ledger, and the local app has no authentication, so keep it on loopback.

Raw HTML, unsafe links, tables, images and other unsupported Markdown make a
note source-only: the source is preserved verbatim and visual/DOCX conversion is
refused. The experimental spoken Stop is off by default and is not a guarantee.
A simulated provider outage never deletes or rewrites a note.

**No silent model switch:** the structured LLM, TTS and embedding models are
pinned. A changed model, missing entitlement, wrong embedding dimension or
provider error disables the feature with a Czech reason; it never falls back to
an unapproved model or unstructured mutation. `AI_REQUEST_BUDGET_USD` is an
app-side estimated admission budget, not a provider spending cap. Check
`docs/QUALITY_REPORT.md` for measured vs `live unverified` capabilities and
`docs/PROVIDER_SMOKE_TESTS.md` for the exact compatibility gates.

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

### Search-index migration and backups

Migration `drizzle/0004_search.sql` adds `notes.search_vector`, backfills it
from the current title, visible body and tags, and creates the GIN index. It
does not rewrite Markdown. Before applying it to a database with valuable notes,
take and verify a backup:

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U ai_voice_notes -d ai_voice_notes -Fc > backups/ai-voice-notes-before-search.dump
pg_restore --list backups/ai-voice-notes-before-search.dump >/dev/null
```

Restore is deliberately manual into a disposable/empty target; there is no
automatic rollback:

```bash
docker compose exec -T db pg_restore -U ai_voice_notes -d ai_voice_notes --clean --if-exists < backups/ai-voice-notes-before-search.dump
```

Run `pnpm db:migrate` after the backup and before starting the updated app or
`pnpm db:seed`. `db:seed` checks the applied migration version and refuses with
a Czech migrate-first message before deleting any `demo-v1:*` rows. The same
backup covers meeting save mappings and usage rows. The test DB is separate and
is never restored into production automatically.

To clear the local TTS cache, use **Nastavení → Vymazat cache** (it also purges
targeted note entries through the existing cache contract). The cache is
gitignored `.data/tts`; deleting it manually is safe. Meeting uploads live in
`.data/uploads` and are removed after each request; no audio is part of a note
backup.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start Next.js in development on the validated loopback origin |
| `pnpm build` | Production build |
| `pnpm start` | Start the production build on the validated loopback origin |
| `pnpm lint` | ESLint with Next.js core-web-vitals and TypeScript rules |
| `pnpm typecheck` | Strict TypeScript check without emitting files |
| `pnpm test` | Vitest unit/API tests, including the `tests/security/privacy.test.ts` audit; the DB suite also runs when both URLs are present |
| `pnpm test:db` | Migrate the isolated `_test` database and run `tests/db` |
| `pnpm test:e2e` | Build and run the offline Playwright Stage 1-4, meeting, search and recovery flows against the isolated test DB |
| `pnpm eval:search` | Optional 20-query search evaluation; paid modes require a fresh cost approval and ready fixture vectors |
| `pnpm db:seed` | Explicitly replace the `demo-v1:*` demo notes in the dev database |
| `pnpm db:migrate:test` | Apply committed migrations to the guarded test database |
| `pnpm db:migrate` | Apply committed migrations to the development database (explicit authorization required) |

## Full-text search

`/search` provides read-only Czech search over active notes. Full-text mode is
offline; semantic/hybrid modes require an explicit paid approval and ready
embeddings. `GET /api/search?q=&mode=fulltext|semantic|hybrid&page=` trims
queries to 200 graphemes, and an empty query returns an explanatory empty state
rather than all notes. Stale, deleted or old-version results are filtered. Unquoted terms use `plainto_tsquery('simple', unaccent(...))`; a query
wrapped in `"..."`, `„...“`, or `“...”` uses
`phraseto_tsquery('simple', unaccent(...))` for exact word order. Results are
ranked by `ts_rank` with `id ASC` as a stable tie-break, ten per page, and
exclude soft-deleted notes. The API accepts `mode=fulltext` or an absent/empty
`mode`. Snippets are built in JavaScript: both the document and query are
case/diacritic folded (including the compatibility transliterations used by the
database `unaccent`), the original matched Czech substring is marked with
`[[[`/`]]]`, and `SearchResults` renders it as escaped React text plus a
`<mark>` element, never raw HTML.

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
only the isolated test database, and runs the offline Stage 1-4 flows:
typed notes/editor/autosave/Trash, mocked dictation and supporting AI, summary/
meeting proposals, full-text search, exports and a simulated provider outage.
The privacy audit is `tests/security/privacy.test.ts` and runs under `pnpm
test`, not under Playwright. Browser SDK/WebSocket doubles and loopback mocks
replace real providers; no seed, real key or public egress is used.

## HTTP boundary

API mutations are guarded by the configured loopback `Host` and an exact
`Origin`, require `application/json`, and are read with per-route streaming byte
ceilings: 1 MiB for note edits, 16 KiB for token/tool routes, and 3 MiB for
reviewed meeting saves. Raw meeting audio uses a separate 25 MiB stream cap.
A body over its ceiling receives an explicit Czech 413 without truncation.
Costly routes can attach a Zod schema and an in-memory rate limiter; rejected
requests never call the route handler. GET/HEAD routes never mutate or bill.

## Troubleshooting

- **Health returns 503:** run `docker compose ps` and `docker compose up -d db`,
  then check that `DATABASE_URL` in `.env.local` matches the compose service.
- **Node version error:** run `nvm use` in the repository root.
- **Port already in use:** change `APP_ORIGIN` to another loopback port; the
  `dev` and `start` scripts use its host and port.
