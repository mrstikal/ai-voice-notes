# AI Voice Notes

Voice models have taken a major leap forward recently, and that let me fulfill
an old dream. When my assistant used to painstakingly transcribe my notes from
a voice recorder, I wished there were something that could handle the entire
process in one package. Today, that really is possible!

**TODO:** Turn this demo into a real application. At the very least, it will be
useful to me.

I also used this project to experiment with more detailed planning and manually
approved steps. The goal is to help developers understand the application better
and avoid mistakes along the way.

## What this demo demonstrates

AI Voice Notes connects **spoken ideas, editable notes, and useful knowledge**
in one local, single-user application. It demonstrates how speech recognition,
structured AI assistance, search, speech synthesis, and a conversational voice
agent can work together while keeping the user in control of saved changes.

The main journey is simple: dictate a Czech note, review the transcript, turn
it into a clearer note with summaries and tasks, find it again, and listen to
it or discuss it with the assistant. A separate meeting workflow turns an
audio recording into a reviewed transcript and suggested meeting notes.

This is also a demo of the engineering around AI: explicit cost consent,
bounded inputs, validated model output, visible change previews, versioned
saves, and Undo. A model suggesting a change is not permission to apply it.

The **interface, voice commands, and user-facing errors are Czech**. Code and
documentation are English. Notes live in a local PostgreSQL database; optional
AI features send the relevant audio or text to external providers. Local does
not mean that the AI models run on your computer.

**No AI keys are needed** to write and organize notes, use full-text search,
restore history, or export Markdown and DOCX. The app has no authentication and
must stay on loopback, not be exposed as a public or shared service.

## Contents

- [Explore the application](#explore-the-application)
- [Technologies and AI models](#technologies-and-ai-models)
- [Run locally](#run-locally)
- [Configuration](#configuration)
- [Privacy and costs](#privacy-and-costs)
- [Data, limits, and backups](#data-limits-and-backups)
- [Development and testing](#development-and-testing)
- [Troubleshooting](#troubleshooting)

## Explore the application

### 1. Capture and edit a note

Open **Poznámky** (`/notes`), create a note, and use the **Obsah poznámky** tab
to write in the visual editor or edit the Markdown source. Both views use the
same content; Markdown is the stored source of truth, not a generated export.
This makes notes portable and lets you inspect what the editor actually saves.

Typing is autosaved after about 800 ms of inactivity. **Uložit** creates a named
history checkpoint instead of adding a revision for every keystroke. An
unacknowledged draft is also kept in the current tab's `sessionStorage` and can
be recovered after a reload. If another tab changes the same note, saving stops
and shows both versions rather than silently overwriting either one.

With an ElevenLabs key, you can dictate the title or body. Interim recognition
appears as a temporary preview; committed body text enters the editor's draft
and autosave flow. Title dictation prepares a title for explicit application.
Choose insertion at the cursor or at the end, and use Stop when finished.
Dictation sessions default to a three-minute limit.

Czech formatting commands such as `nový odstavec`, `nový řádek`, `nadpis`,
`tučně`, `konec tučně`, `začni úkoly`, `další úkol`, and `konec úkolů` turn
recognized speech into document structure. These commands are parsed locally,
not sent to a second language model for interpretation.

**What this demonstrates:** streaming speech recognition can feed an ordinary,
recoverable editor without making transient recognition results permanent.

### 2. Turn raw notes into something useful

The note's tabs separate focused actions instead of hiding them in one large
AI prompt:

| Tab | What it does | Why it is useful |
|---|---|---|
| **Vyčistit diktát** | Suggests cleanup of one selected plain-text paragraph, with checks that preserve numbers and supplied proper names | Removes verbal clutter while keeping the original available in history |
| **Shrnutí poznámky** | Generates an unsaved Czech summary of the note or a selected passage | Lets you review or listen to the gist before deciding whether to insert it |
| **Získat úkoly z pasáže** | Suggests editable tasks, flags existing duplicates, and lets you choose which to insert | Converts prose into a practical checklist without accepting every suggestion |
| **Kategorie a tagy** | Edits metadata manually or offers AI suggestions for review | Organizes notes without requiring AI for ordinary tagging |
| **AI úprava** | Interprets a typed or dictated instruction as a bounded editing operation | Demonstrates natural-language commands without granting unrestricted document access |
| **Stav úkolů hlasem** | Parses Czech task-state commands and prepares a change | Lets you manage a checklist by voice while retaining confirmation |
| **Ruční strukturovaný návrh úpravy** | Prepares the same kind of bounded change without an LLM | Makes the preview and approval mechanism usable independently of a model |
| **Historie** | Shows named revisions, diffs, Undo, and restoration previews | Makes reviewed changes traceable and recoverable |

AI content edits follow **request -> validate -> preview -> confirm -> save**.
If a target is ambiguous, choose the intended occurrence. A proposal is tied to
the saved note version and expires; a stale proposal cannot overwrite newer
text. Clicking **Potvrdit** applies it once and creates a revision. Rejecting
it leaves the note untouched. AI tag/category suggestions use a separate,
explicit metadata-save action rather than a body-text diff.

Generating a summary or task suggestion does not insert it automatically.
Save outstanding editor changes before using actions that depend on the saved
version. AI output can still be wrong: review meaning, names, numbers, and
tasks, not just the formatting of the diff.

**What this demonstrates:** the model proposes; deterministic application code
validates scope and version; the user authorizes the final write.

### 3. Listen, find, and ask

**Čtení nahlas** reads a saved note, selected passage, paragraph, tasks, or a
generated summary. Choose a voice, review the cost notice, and start playback.
Long text is divided into sections and synthesized one section at a time.
Pause/resume, previous/next, and Stop keep playback under your control. A local
audio cache avoids another synthesis request for an unchanged cached section.

An optional **spoken Stop** listens for a standalone Czech `stop` during
playback. It is off by default, uses a separate paid Scribe microphone session,
and is experimental. Use headphones and keep the on-screen Stop available.

Open **Vyhledávání** (`/search`) to compare three retrieval approaches:

| Mode | How it works | When to use it |
|---|---|---|
| **Textově** | Local PostgreSQL full-text search across titles, visible text, and tags; ignores case and diacritics | You remember the words, want a quoted phrase, or want provider-free search |
| **Významově** | Embeds the query and compares it with indexed note passages using vector similarity | You remember the idea but not the exact wording |
| **Kombinovaně** | Fuses keyword and semantic rankings using reciprocal rank fusion | You want to compare results that balance wording and meaning |

Full-text search uses word matching, not Czech stemming; related inflections
are not necessarily the same term. For phrase matching with a fixed word order,
enclose the whole query in quotation marks. Empty queries do not list every
note, and Trash is excluded.

For semantic or hybrid search, first use the index panel to estimate and
explicitly approve an embedding batch. Saving a note updates local search data
but **never sends it for embedding automatically**. Edited notes need fresh
vectors. Each paid search also requires confirmation; simply opening the page,
typing, or refreshing does not trigger a paid query.

The question-answering panel in **Významově** and **Kombinovaně** builds an
answer from retrieved note passages and links claims to their sources. It
requires a local textual anchor before calling a provider; without sufficient
evidence it refuses to answer. Ready embeddings can enrich retrieval, but
semantic-only matches do not bypass that textual gate. Citations help you check
an answer; they are not a guarantee that the claims are true.

**What this demonstrates:** speech output, keyword retrieval, embeddings,
hybrid ranking, and retrieval-augmented answers solve different parts of the
same knowledge workflow.

### 4. Convert a meeting into reviewed notes

Open **Zápis ze schůzky** (`/meetings`). The workflow deliberately separates
local preparation, paid transcription, and persistence:

1. **Record or choose audio.** Capture microphone audio in the browser or select
   an MP3, PCM WAV, or WebM-Opus file. Default limits are 15 minutes and 25 MiB.
2. **Inspect locally.** The server checks the actual container, codec, and
   duration with `ffprobe`. A filename or MIME label alone is not trusted. This
   step makes no AI request and creates no note.
3. **Approve transcription cost.** The file is revalidated and sent to direct
   ElevenLabs batch Scribe v2. Recording or inspecting alone never starts a
   paid transcription.
4. **Review the transcript.** Correct the editable preview and speaker labels.
   Labels appear only when the provider returns speaker information; they are
   not verified real-world identities. You can download the transcript as `.txt`.
5. **Save explicitly.** Reviewed text becomes one note or, when needed, up to
   three numbered notes split at paragraph boundaries. Oversized input is
   refused, not silently truncated. Repeated submission of the same save does
   not create duplicate notes.
6. **Request useful follow-ups.** For a saved meeting note, select the source
   passage and request a summary/decisions or tasks. Summary and decisions use
   two model requests; task extraction uses one. Each inserted section has its
   own diff and confirmation. Work with each part separately for split meetings.

**What this demonstrates:** batch transcription and speaker segmentation are
only the beginning; review, safe storage, and selective extraction turn a
recording into usable meeting notes without treating model output as fact.

### 5. Compare two ways to build a voice assistant

Open **Konverzační asistent** (`/voice-agent`) and choose the interaction mode.
Neither mode starts on page load, and neither lets a model approve its own
changes.

| | Gemini Live | **Řetězený režim** (chained mode) |
|---|---|---|
| Audio path | Browser microphone -> Gemini Live -> spoken response | ElevenLabs Scribe -> OpenRouter LLM -> ElevenLabs speech synthesis via OpenRouter |
| Interaction | Two-way Czech audio, selectable Gemini voices, transient captions, mute, push-to-talk, and barge-in | Typed commands or push-to-talk, one turn at a time, bounded intent interpretation, and a spoken reply |
| Note access | Local full-text search, then explicit selection of one result before deeper reading or editing | Bounded search and one selected note per turn |
| Changes | Preview-only task/edit tools; an on-screen click applies a proposal | The same reviewed proposal and history mechanism |
| Default session limit | 9 minutes | 10 minutes |
| Required keys | Gemini; OpenRouter additionally for an approved summary | ElevenLabs and OpenRouter; no Gemini key |

In Live mode, the server creates a short-lived, single-use token. The browser
then streams audio directly to Google over a constrained WebSocket; the
long-lived Gemini API key never reaches the browser. The seven tools are
`search_notes`, `get_note`, `read_note_section`, `summarize_note`, `add_todo`,
`propose_edit`, and `confirm_edit`. Search results include short previews, but
reading note content or preparing an edit requires your explicit note
selection. Initial note reads are bounded excerpts, not an unrestricted
library dump; section reads cover tasks, the last paragraph, or a marked passage.

`summarize_note` asks for an additional cost-confirmation click before using
OpenRouter. The generated summary is then sent to Gemini as conversation
context. Despite its name, `confirm_edit` only checks a pending proposal;
it cannot apply it. Only your **Potvrdit** click can save the change, and
**Historie** can undo it. Speaking over the assistant clears queued reply audio;
it does not grant approval to a pending change.

Chained mode exposes the separate speech-to-text (STT), language-model (LLM),
and text-to-speech (TTS) steps. Within a session, submit a typed command or hold
the push-to-talk button for a voice turn, then review the reply and any proposed
note change before continuing. This makes it easier to inspect intermediate
text and compare a modular pipeline with direct live audio. Session statistics
are in-memory observations and timing proxies, not a provider billing report
or a claim that one architecture is always faster.

**What this demonstrates:** conversational convenience can coexist with bounded
tools, explicit data selection, and a human approval boundary.

## Technologies and AI models

### Application stack

| Technology | Role and benefit in this demo |
|---|---|
| **Next.js 16, React 19, TypeScript 5.9** | Browser UI and server routes in one typed application; provider credentials and database writes stay behind server boundaries |
| **Tailwind CSS 4** | Shared styling for the Czech interface and its editor, playback, preview, and settings controls |
| **Tiptap 3, Markdown, unified/remark** | Visual editing over portable Markdown, with syntax-tree validation to prevent lossy conversion |
| **PostgreSQL 17, pgvector, GIN full-text index** | Notes, revisions, usage, keyword search, and 1536-dimensional vectors in one transactional database |
| **Drizzle ORM and SQL migrations** | Typed data access and reproducible schema changes; version checks protect against conflicting writes |
| **Zod** | Runtime validation of request bodies and structured model responses; TypeScript types alone cannot validate external data |
| **Web Audio, MediaRecorder, WebSocket, Web Locks** | Live PCM audio, meeting recording, streaming transport, and shared microphone coordination across tabs |
| **FFmpeg / ffprobe** | Local inspection of real audio formats and duration before a paid upload |
| **docx** | Local Word export from supported Markdown without a document-conversion service |
| **Vitest, Testing Library, Playwright** | Unit, component, database, and browser checks, with provider doubles for reproducible offline tests |
| **Docker Compose, Node.js, pnpm** | Repeatable local database setup and pinned runtime/package tooling |

### Model roles

| Model | Access path | Role and architectural benefit |
|---|---|---|
| **ElevenLabs Scribe v2 Realtime** (`scribe_v2_realtime`) | Direct ElevenLabs, using server-issued single-use tokens | Streams interim and committed Czech transcripts so dictation can appear while you speak |
| **ElevenLabs Scribe v2** (`scribe_v2`) | Direct ElevenLabs batch API | Transcribes complete meeting files with word timing and speaker segmentation when returned by the provider |
| **DeepSeek** (`deepseek/deepseek-v4.1-flash-1017`) | OpenRouter | Interprets bounded commands and generates cleanup, summaries, tasks, tags, decisions, and grounded claims; schema-constrained output can be validated before use |
| **ElevenLabs speech synthesis** (`elevenlabs/eleven-v4-turbo`) | OpenRouter, not the direct ElevenLabs TTS API | Produces MP3 for read-aloud and chained replies; read-aloud uses sectioning and local caching, while chained reply audio is transient |
| **OpenAI text-embedding-3-small** (`openai/text-embedding-3-small`) | OpenRouter, with 1536 output dimensions | Maps passages and queries into comparable vectors, enabling meaning-based retrieval rather than generating answers |
| **Google Gemini Live** (`gemini-3.8-live`) | Direct Google token API and browser WebSocket | Handles two-way live audio and tool requests in one conversational session, providing a contrast to the separate STT -> LLM -> TTS pipeline |

Read-aloud's voice selector includes `sarah` (the default), `george`, and other
presets; Gemini has its own voice selector (default `Aoede`). These are separate
voice systems. No direct OpenAI API key is required, including for embeddings
routed through OpenRouter.

The app pins these model contracts. An incompatible model, unavailable account
entitlement, invalid response, or wrong embedding dimension blocks the feature
with an explanation instead of silently selecting another model. The benefits
above describe how the models are used, not a comparative quality or latency
benchmark.

## Run locally

### Prerequisites

- Linux or WSL with Docker Engine and Docker Compose v2.
- [nvm](https://github.com/nvm-sh/nvm) and the Node.js version in `.nvmrc`
  (22.22.2; the package requires at least 22.19).
- pnpm 10.33.0, pinned in `package.json`.
- A Chromium-family browser with microphone permission and Web Locks for voice
  features. Browser recording additionally requires WebM-Opus support.
- Host FFmpeg for meeting inspection and transcription, including file uploads.

### First start

Run these commands from the repository root. The migration command creates the
schema in your development database; back up existing data before running it.

```bash
nvm install
nvm use
corepack enable
pnpm install
cp .env.example .env.local
docker compose up -d --wait db
pnpm db:migrate
pnpm dev
```

Open <http://127.0.0.1:3000>. Start with typed notes and full-text search; all
provider keys may remain empty. To try AI features, add only the needed keys to
`.env.local` and restart the server. The provider account must permit the exact
model and API used; having a key alone does not guarantee access.

Provider accounts and key management are available through
[ElevenLabs](https://elevenlabs.io/), [OpenRouter](https://openrouter.ai/), and
[Google AI Studio](https://aistudio.google.com/). You only need accounts for the
features you choose to use.

Optional: run `pnpm db:seed` to load 20 Czech sample notes for exploration.
It replaces only notes in the `demo-v1:*` namespace, including edited or
trashed demo notes, and leaves ordinary user notes alone. It never runs
automatically during installation, startup, build, or migration.

For a production build running locally:

```bash
pnpm build
pnpm start
```

Both `dev` and `start` bind to the loopback host and port in `APP_ORIGIN`.
`/status` shows database health; `/api/health` returns
`200 {"status":"ok"}` when PostgreSQL is reachable, or a Czech error with 503
when it is not. Health is not a provider-account compatibility check.

### FFmpeg for meetings

On Ubuntu / WSL:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
ffprobe -version
ffmpeg -version
```

Both executables must be on the server process's `PATH`. A static Linux build
in a user directory such as `~/.local/bin` is an alternative when package
installation is unavailable. Do not commit binaries. Meeting validation rejects
unsupported containers, including Matroska even if it contains Opus.

## Configuration

Use [`.env.example`](.env.example) as the complete configuration reference.
`.env.local` and `.env.test.local` are gitignored; never commit real keys.

| Variable | Purpose | Default |
|---|---|---|
| `APP_ORIGIN` | Loopback URL with an explicit port | `http://127.0.0.1:3000` |
| `APP_ALLOW_FORWARDED_LOOPBACK` | Allow a local port forwarder to rewrite the loopback Host/Origin port | `0` |
| `DATABASE_URL` | Development PostgreSQL connection | Local `db` service on port 5432 |
| `TEST_DATABASE_URL` | Separate test PostgreSQL connection | Local `db-test` service on port 5433 |
| `ELEVENLABS_API_KEY` | Direct realtime dictation and batch meeting transcription | Empty |
| `OPENROUTER_API_KEY` | Structured AI, speech synthesis, and embeddings | Empty |
| `GEMINI_API_KEY` | Direct Gemini Live conversation | Empty |
| `OPENROUTER_LLM_MODEL` | Pinned structured-output model | `deepseek/deepseek-v4.1-flash-1017` |
| `OPENROUTER_EMBEDDING_MODEL` | Pinned 1536-dimensional embedding model | `openai/text-embedding-3-small` |
| `GEMINI_LIVE_MODEL` | Pinned live-audio model | `gemini-3.8-live` |
| `NOTE_MAX_CHARACTERS` | Note-content limit, at most 20,000 graphemes | `20000` |
| `MEETING_MAX_MINUTES` | Meeting duration limit | `15` |
| `AI_REQUEST_BUDGET_USD` | Local estimated admission budget, not a provider spending cap | `2.00` |
| `AI_TEST_MODE` | Guarded test harness only; leave empty for normal use | Empty |

TTS is pinned in code; `OPENROUTER_TTS_MODEL` is reserved and does not override
it. Provider API base URLs should keep their normal defaults; loopback
overrides exist for the test harness, not for changing providers.

The example also lists operational limits for AI input/output, timeouts,
uploads, caches, search batches, and rate limiting. `NEXT_PUBLIC_*` values are
non-secret browser limits embedded at build time; change them before `pnpm dev`
or `pnpm build`, not after a production build. Raising a limit is not a fix for
an incompatible provider response.

`APP_ORIGIN` accepts only `127.0.0.1`, `localhost`, or `::1`, with an explicit
port and no path or credentials. Use `APP_ALLOW_FORWARDED_LOOPBACK=1` only for a
local IDE/port forwarder; forwarded Host and Origin must still be loopback and
use the same port. This is not a public-deployment option.

Compose reads `DB_HOST_PORT` and `TEST_DB_HOST_PORT` from **`.env`**, not
`.env.local`. If ports 5432/5433 are occupied, set replacements in a gitignored
`.env` and update the connection URLs in `.env.local` and `.env.test.local`.

## Privacy and costs

The core note editor, Markdown conversion, manual metadata, full-text search,
history, Trash, and exports make no AI-provider requests. Provider-dependent
actions disclose their inputs and costs in the UI. **Nastavení** (`/settings`)
contains voice, model, cache, privacy, and usage information; **Rozpočet**
(`/budget`) shows the local budget and usage ledger.

| Feature | Data sent outside your machine | Local persistence |
|---|---|---|
| Dictation | Microphone audio to direct ElevenLabs Scribe | Committed text through the note draft/save flow; no raw recording |
| Meeting transcription | Selected recording to direct ElevenLabs batch Scribe | Temporary upload file; reviewed text becomes notes only after Save |
| Read-aloud | Selected text to OpenRouter speech synthesis | Validated MP3 and technical metadata cached under `.data/tts` |
| Chained assistant | Microphone audio to ElevenLabs; commands, bounded note excerpts, and reply text to OpenRouter | Turn text and reply audio stay in memory; reply audio is not cached. Usage records and edit proposals can be stored locally; note changes require confirmation |
| AI cleanup, edits, summaries, tasks, tags, decisions | Relevant bounded text or command to OpenRouter | Unconfirmed edit proposals may be stored for review; accepted changes and revisions are saved; derived suggestions are not automatically inserted |
| Grounded answers | Question and retrieved bounded passages to OpenRouter | Technical usage metadata; no automatically created answer note |
| Semantic indexing/search | Note chunks or query text to OpenRouter embeddings | Note vectors and index state in PostgreSQL; query text/vectors are not saved as notes |
| Gemini Live | Microphone audio, requested search previews, explicitly selected note excerpts, tool results, and approved summaries to Google; summary generation also sends bounded source text to OpenRouter | Session audio, captions, search results, selections, and metrics stay in memory. Edit proposals may be stored locally; note changes require confirmation |

Long-lived keys stay server-side. Scribe and Gemini browser connections use
short-lived credentials, not those keys. Meeting uploads use private temporary
files under `.data/uploads` and are deleted after each request; audio is not
part of a saved note. Recordings and unsaved transcript previews live in browser
memory and are lost on navigation or reload. Save reviewed text or download the
transcript before leaving; the app is not an audio archive.

Google, ElevenLabs, and OpenRouter have their own processing and retention
policies, including any upstream providers used by OpenRouter. This app does
not promise provider-side zero retention. Obtain appropriate permission before
recording other people or sending sensitive information.

For operations covered by the usage ledger, the server reserves an estimate
before calling the provider. If an actual cost is not returned or cannot be
confirmed, the entry stays **Neznámá cena** (unknown cost), not zero. The local
budget survives restarts; resetting it requires confirmation and no active
reservation. **Gemini Live audio is not covered by this ledger or local budget.**
Chained mode records its component requests, but has no guaranteed total-session
price. A session timeout, displayed estimate, or local budget is not a hard
provider billing cap; manage provider-side limits separately.

Microphone use is coordinated across tabs and modes. Stop the current voice
activity before starting another. Read-aloud also coordinates with dictation;
the optional spoken-Stop monitor is the deliberate shared-lock exception.
Stopping or leaving a voice session releases its microphone and audio output;
reconnection requires another explicit start.

## Data, limits, and backups

### Markdown and recovery

Notes support H1-H3 headings, paragraphs, line breaks, bold/italic, bullet,
ordered and task lists, safe links, blockquotes, and inline/fenced code. Safe
links use `http:`, `https:`, `mailto:`, relative paths, or fragments.

Unsupported syntax, such as raw HTML, tables, images, H4-H6, reference links,
footnotes, strikethrough, or unsafe link destinations, puts the entire note in
**source-only** mode. The original source remains editable and exportable as
Markdown; visual and DOCX conversion are refused rather than silently losing
content or exposing unsafe links.

Default limits are 160 graphemes for a title and 20,000 for a note. A grapheme
is a user-perceived character, not a byte. Supported Markdown is counted as
visible text; source-only notes are counted from their raw source.
AI actions have smaller source bounds: summary and tag suggestions use up to
8,000 graphemes, task extraction 4,000, and cleanup one plain paragraph up to
2,000. Select a smaller passage when needed; input is not silently truncated to
fit. The complete adjustable limits are in `.env.example`.

Markdown export preserves the saved source; DOCX maps the supported structure
to a Word document. Save before exporting because exports use the persisted
version. Deleting a note moves it to **Koš** (`/notes/trash`); normal app routes
do not hard-delete it. Undo and restoration create new history entries rather
than erasing the audit trail. Draft autosaves are not individual named revisions.

### Database and backup

Development data persists in Docker's `db-data` volume across container
restarts. The test service uses its own `db-test-data` volume. Removing volumes
(for example with `docker compose down -v`) removes their data.

Committed migrations are in `drizzle/`. Apply them explicitly with
`pnpm db:migrate`, before starting an updated app or seeding. For a database
containing valuable notes, take and verify a backup first. Use a new filename
for each backup so you do not overwrite your last verified copy:

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U ai_voice_notes -d ai_voice_notes -Fc > backups/ai-voice-notes.dump
docker compose exec -T db pg_restore --list < backups/ai-voice-notes.dump >/dev/null
```

The dump contains database state, including revisions and proposal/usage
records, but not browser drafts, recordings, or cached MP3 files. Keep it
private. Listing checks that the archive is readable; a restore into a
disposable database is the stronger recovery test. Restore only into a
disposable or empty target after checking the destination. For the local
development database, the following command
**replaces database objects and data**; it is not an automatic rollback:

```bash
docker compose exec -T db pg_restore -U ai_voice_notes -d ai_voice_notes --clean --if-exists < backups/ai-voice-notes.dump
```

Stop the app before restoring. Clear audio through **Nastavení -> Vymazat
cache**, or remove the disposable `.data/tts` cache manually. Database backups
do not need this cache. Do not treat `.data/uploads` as an audio archive.

## Development and testing

| Command | Purpose |
|---|---|
| `pnpm dev` | Development server on the configured loopback origin |
| `pnpm build` / `pnpm start` | Build / run locally in production mode |
| `pnpm lint` / `pnpm typecheck` | ESLint / strict TypeScript checks |
| `pnpm test` | Vitest unit, component, API, and security tests; database suites also run when both database URLs are available |
| `pnpm test:db` | Migrate and test only the isolated test database |
| `pnpm test:e2e` | Build, then run Playwright against an isolated test server and mocked providers |
| `pnpm db:migrate` | Explicitly migrate the development database |
| `pnpm db:migrate:test` | Migrate the guarded test database |
| `pnpm db:seed` | Explicitly replace the 20 development demo notes |
| `pnpm eval:search` | Optional fixture-based retrieval evaluation; paid modes need prepared vectors and explicit cost approval |

### Isolated test setup

Start the separate test service:

```bash
docker compose --profile test up -d --wait db-test
```

Create `.env.test.local` with these two connection settings, adjusting ports
if necessary. Do not copy real provider credentials into it.

```dotenv
DATABASE_URL=postgresql://ai_voice_notes:ai_voice_notes@127.0.0.1:5432/ai_voice_notes
TEST_DATABASE_URL=postgresql://ai_voice_notes:ai_voice_notes@127.0.0.1:5433/ai_voice_notes_test
```

Test commands require distinct targets and database names, a loopback test
host, an explicit test port, and a test database name ending in `_test` before
destructive SQL. The browser harness migrates and clears **only the test
database**, uses ports 3100 and 4010, and supplies its own dummy keys and local
provider doubles. Do not store valuable data in the test database.

Install Playwright's browser once, then run the checks:

```bash
pnpm exec playwright install chromium
pnpm lint
pnpm typecheck
pnpm test
pnpm test:db
pnpm test:e2e
pnpm build
```

Meeting browser tests need host FFmpeg too. `AI_TEST_MODE=1` is a harness safety
switch, not a way to enable free AI in the normal app: it requires `_test`
database targets, explicit-port loopback ElevenLabs/Gemini mocks, and exact
dummy keys (`test-only-elevenlabs`, `test-only-openrouter`,
`test-only-gemini`) for configured credentials. Real keys are rejected.

Tests exercise dictation, reviewed AI changes, meeting save, search, exports,
conflict recovery, and the voice-agent selection/preview/reject/confirm/Undo
flow without public provider calls. They validate local behavior, not real
microphone accuracy, provider availability, audible quality, or live latency.

### Source map and further reading

| Path | Contents |
|---|---|
| `src/app/` | Pages and guarded API routes |
| `src/components/` | Note editor, AI review panels, search, meeting, playback, and voice UI |
| `src/lib/` | Note operations, provider adapters, search, storage, and safety boundaries |
| `scripts/` | Startup, migrations, seed, test harness, and search evaluation |
| `drizzle/` | SQL migrations |
| `tests/` / `e2e/` | Vitest and Playwright checks |

The read-only keyword API is `GET /api/search?q=...&mode=fulltext&page=1`;
semantic and hybrid searches use explicitly approved `POST /api/search`
requests, not paid GET requests. Note writes use an expected version and return
409 on conflict. Mutating routes validate loopback Host/Origin, content type,
and bounded request bodies; JSON is used except for raw meeting-audio uploads.

- [Implementation plan](AI_VOICE_NOTES_IMPLEMENTATION_PLAN.md): the detailed
  planning and manual-approval approach behind the project.
- [Provider checks](docs/PROVIDER_SMOKE_TESTS.md): account/model compatibility
  procedures for deliberate live checks, which can incur charges.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Database error or health 503 | Run `docker compose ps` and `docker compose up -d db`; check `DATABASE_URL`, port mappings, and whether the database is ready |
| Missing tables or migration warning | Back up existing data, then explicitly run `pnpm db:migrate`; startup does not create the schema |
| Node version error | Run `nvm use` in the repository root |
| App port already in use | Change `APP_ORIGIN` to another loopback port; `dev` and `start` use that address |
| Database ports already in use | Set host ports in Compose's `.env` and update both application/test connection files |
| Another server is using the database | Stop the other instance; the app deliberately permits only one running server per database |
| AI feature disabled | Check the required server-side key, exact pinned model, account access, budget, and the UI's explanation; restart after changing `.env.local` |
| Unknown cost or budget exhausted | Review **Rozpočet** and provider billing; restarting does not clear reservations or make uncertain charges free |
| Microphone unavailable | Use a supported browser, allow microphone access, and stop competing activity or another tab before retrying |
| Meeting inspection fails | Check `ffprobe -version`, `ffmpeg -version`, the server's `PATH`, real file format, duration, and size |
| Semantic search has no usable index | Prepare and approve an index batch; repeat for edited notes, then approve the query |
| Proposal expired or became stale | Save/reload the current note, then prepare a fresh preview; do not retry an old confirmation |
| Visual editor or DOCX unavailable | The Markdown contains unsupported syntax; keep source mode/Markdown export or simplify it explicitly |
| Browser tests cannot start | Check the `_test` database settings, FFmpeg, installed Chromium, and whether ports 3100/4010 are free |
