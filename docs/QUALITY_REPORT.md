# Quality report

Measured locally on 2026-10-28/30. Only rows with a real command and output are
filled; unrun checks are marked explicitly. A high score on 20 distinctive
fixture queries is not a general quality threshold.

## Stage 1-4 measured coverage

This table separates measured evidence from unverified capability. A mocked
latency is never entered as a real performance number.

| Stage | Measurement | Observed evidence | Status |
| --- | --- | --- | --- |
| 1 | Typed notes, editor, versioning, exports, offline full-text | 923 unit / 144 skipped, 160 DB, 70 Playwright after P54, including the four-stage offline flow and the mocked voice-agent flow; a separate no-key run on 127.0.0.1:3002 created a 40-character typed note, exported exact Markdown (HTTP 200) and found it with full-text search; no provider calls or usage rows | Offline verified, including no-key application run |
| 2 | Scribe dictation commit/command latency | 180 s synthetic Czech audio; four `committed_transcript` events, 1,410 normalized characters, 193.6 s wall-clock to the session bound. Commit/command latency was not instrumented; manual reconnect count was not recorded | Live verified with synthetic audio; latency/reconnects unverified |
| 2 | TTS first-audio and cache-hit time | Two live Czech requests (Sarah/George), 71,514/69,006 bytes, decoded 4.40/4.24 s; first-audio and cache-hit timings were not instrumented | Live audio verified; timing/cache unverified |
| 2 | Experimental spoken-Stop reliability | User headset acceptance on 2026-10-27; the formal ten-trial aggregate was not recorded | Experimental, user-verified; aggregate unverified |
| 3 | Voice command interpretation | 13/15 live commands passed; two targeted retests passed after prompt correction; no latency instrumented | Live partial; latency unverified |
| 3 | Embedding request | One live call returned two 1,536-float vectors in 789 ms | Live verified |
| 4 | Full-text/semantic/hybrid search | See the 20-query table below: Hit@1/3, MRR@5 and latency for text, semantic and hybrid | Live verified for the 20-query fixture |
| 4 | RAG grounded answers | Automated citation/version checks only; no live LLM answer; manual factual review required | Live unverified |
| 4 | Meeting diarization/transcript review | P42: 37.68 s Czech WAV, 388 characters, one real `speaker_0`, 6.5 s batch call; multi-speaker and 15-minute meetings unverified. P43: 215-character Czech note, live summary/decisions/tasks, one speaker-free source, 0.022702 USD reserved across two attempts | Live partial; multi-speaker/15-minute unverified |
| 4 | Privacy/recovery integration | `tests/security/privacy.test.ts` audits client/imported secret boundaries, HTML/log/temp/CSRF/filename rules; `e2e/four-stage.spec.ts` crosses all four stages and proves a simulated provider outage leaves content, version and revisions unchanged; no provider is called | Offline verified |
| 5 | Voice-agent approval safety and release gate | Mock E2E `e2e/voice-agent-mock.spec.ts` connects through the loopback Gemini token mock and a Playwright WebSocket double, selects one searched note, rejects one preview without a mutation, approves a second with exactly one `ai` revision, undoes it through P25, stops and reconnects; `tests/security/voice-agent-boundary.test.ts` checks the browser storage/log boundary across the voice-agent client components and the browser-shipped modules under `src/lib/voice-agent/`, the client-only import boundary, the pinned browser WebSocket host plus config-resolved token URL, the seven-tool cap and a Czech provider-outage error without the key; `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:db`, `pnpm test:e2e` and `pnpm build` pass offline | Offline verified; real speech/tool/barge-in remains `live unverified` |

### Estimated vs actual/unknown cost

| Operation | App estimate/approval | Provider-reported cost | Ledger status |
| --- | ---: | ---: | --- |
| Scribe realtime 180 s | 0.019500 | not reported | unknown |
| TTS two voices | 0.280000 | not reported | unknown |
| P36 fixture reindex | 0.000203 | 0.000163 | reported |
| 20 semantic/hybrid query embeddings | 0.001000 approval per run | 0.000020 | reported |
| P42 batch 37.68 s | 0.055000 | not reported | unknown |
| P43 summary + decisions + tasks, two attempts | 0.022702 reserved | not reported | unknown |

Stage 4 is accepted only for the observed text search, the 20-query
semantic/hybrid evaluation, single-speaker meeting transcription/review and the
P43 live summary/decisions/tasks path. RAG live answers, multi-speaker
diarization, 15-minute meetings, physical-microphone dictation, TTS
first-audio/cache timing and the ten-trial spoken-Stop aggregate remain
`live unverified`.

## Stage 4 - Search

Fixtures: 20 `demo-v1:*` notes from P07, prepared in the isolated `_test`
database with `NODE_ENV=test pnpm db:seed`. Queries: 20 literal Czech
query -> stable `seed_key` relationships in `tests/fixtures/czech-search.ts`,
covering all 20 fixture topics. Text and semantic modes filter rank positions
to `demo-v1:*` results after ranking; hybrid first fuses the full top-20 text
and top-20 semantic lists exactly like the shipped route and only then filters
the fused items to `demo-v1:*` for the metric. Unrelated user notes therefore
cannot shift a fixture's score, but they still occupy the component positions
used for fusion.

| Mode | Queries | Hit@1 | Hit@3 | MRR@5 | Latency avg | p50 | max | Provider |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Text (`pnpm eval:search --test-db`) | 20 | 0.950 | 0.950 | 0.950 | 2.5 ms | 1.5 ms | 11.0 ms | 0 calls |
| Semantic (`--mode=semantic --approve-cost=0.001`) | 20 | 1.000 | 1.000 | 1.000 | 578.2 ms | 569.1 ms | 677.0 ms | 20 query embeddings / 0.000020 USD reported |
| Hybrid (`--mode=hybrid --approve-cost=0.001`) | 20 | 1.000 | 1.000 | 1.000 | 603.1 ms | 592.5 ms | 717.4 ms | 20 query embeddings / 0.000020 USD reported |

The semantic/hybrid rows include the provider round trip. Text latency is local
DB latency only. The hybrid score uses reciprocal rank fusion of top-20 text
and top-20 semantic note ranks; it is not an independently measured "quality
threshold".

### Actual text miss

- `Q05 běžecký trénink` -> expected `demo-v1:D15`; returned no seed result in
  the top 5. The fixture title is `Plán běžeckého tréninku`; the `simple` text
  configuration does not stem `běžecký`/`běžeckého` or `trénink`/`tréninku`.
  The miss is recorded, not hidden by changing the query after the run.
  Semantic and hybrid both place `D15` first for this query.

### Paid evaluation setup and isolation

- Ready vectors were prepared by an explicit P36 reindex on the `_test` DB:
  7 approved batches, 70 chunks, reserved 0.000203 USD, reported 0.000163 USD.
  The evaluator itself never creates vectors, seeds notes or deletes notes; it
  refuses paid modes when no ready fixture vectors exist.
- `--mode=semantic|hybrid` requires a fresh `--approve-cost=USD` and refuses a
  lower approval. It forces the P12 usage connection to `TEST_DATABASE_URL` and
  the live provider transport, and refuses to run during a production build.
- An initial paid evaluator version recorded its 40 query-usage rows in the
  development P12 ledger (0.000040 USD) because it used `DATABASE_URL` for the
  shared usage client. The evaluator now rewrites that connection to the test
  DB before creating the embedding service; the re-run was verified with 40
  `embedding_query` rows in the test DB. The original dev rows were left in
  place because they represent real spend, not because the evaluator still uses
  that database.
- Text mode is offline and read-only: zero provider calls, no notes seeded or
  deleted by the evaluator. `NODE_ENV=test pnpm db:seed` is a separate explicit
  preparation step.

## Stage 4 - Grounded answers (P39)

- Automated checks only: the service accepts at most six claims, each with a
  text of at most 400 graphemes and 1-3 citations. Every citation must match a
  current-version, undeleted chunk retrieved for that question; the retrieved
  chunks are version/text-rechecked after the model responds. Free-form answer
  text, missing/foreign citations, excess claims/citations and truncated model
  output are rejected rather than repaired.
- Grounding requires a free lexical anchor in note **content** before any paid
  call: exact P34 full-text first, then an OR over the question's significant
  unaccented terms. The anchor uses the indexed `notes.search_vector` as a
  first pass and re-checks the content-only predicate on those candidates, so
  the note-content rule does not give up the GIN index. Terms of five or more letters use the first five letters
  as a prefix (`běžecký`/`běžeckého`, `trénink`/`tréninku`); shorter terms must
  match exactly, so a 3–4 letter term cannot open the paid path merely by
  prefixing an unrelated word. The selected chunk is ranked with the same
  prefix query, not with the exact query that already failed. Zero anchor
  returns the exact insufficient-evidence sentence with zero query-embedding
  and zero LLM requests, even when vectors are ready. Semantic-only evidence
  with no shared lexical content anchor is still not used for grounded
  answers; use the `Významově` search mode for that. This is an explicit
  text-anchored safety contract, not a full semantic recall claim.
- The model receives note text only as untrusted quoted JSON data with an
  explicit instruction not to follow commands inside it. The validator can
  reject invented links, but cannot prove that a claim is factually true.
- **Manual factual-quality review: not performed / required.** The API returns
  `manualFactualReview: "required"`; a valid citation is provenance, not a
  truth proof. No accuracy score is claimed here.
- No live LLM answer was run for P39. Tests use an injected LLM plus one
  fake-transport `llm_grounded_answer` request; no note text was written to
  `provider_usage` or logs. Provider cost remains `unknown` unless the provider
  reports it, and the UI must show that state.

## Stage 5 - Voice comparison metrics (P53)

- **Offline instrumentation only.** `src/lib/voice-agent/metrics.ts` records
  session start/end, turn start/finish, a **first-audio proxy** from the last
  input-transcription update (Gemini) or chained turn end, barge-in to
  **synchronous queue stop** (not audible speaker silence), a tool dispatch in
  Gemini versus the whole chained turn (LLM + tools), errors by code,
  selection counts (match/mismatch only when a caller knows the expectation;
  live UI shows "nevyhodnoceno") and proposal outcome. It stores no transcript,
  audio, note text, note ID, key or session secret; `AgentStatus` renders only
  aggregates from the in-memory page session.
- **Fixtures.** `tests/fixtures/voice-agent-scenarios.ts` defines the required
  scenarios: select one of two migration notes, summarize the selected note,
  read the last paragraph, propose/reject/approve a TODO and Undo, interrupt
  output and Stop. Fixture utterances are never included in metric output.
  The live UI does not know a scenario's expected note, so its match/mismatch
  counters remain "nevyhodnoceno"; the fixture unit tests exercise the
  match/mismatch path explicitly.
- **Usage.** Observations are tagged `reported`, `estimated` or `unknown` per
  provider. The UI reports the tag counts and only sums USD values that were
  actually reported or estimated; missing values remain unknown. No per-minute
  invoice is synthesized from missing token prices.
- **Evidence.** `tests/voice-agent/metrics.test.ts` validates mode-separated
  medians/ranges/sample sizes, failed turns, missing usage, sanitisation and
  fixture-text exclusion. This proves instrumentation shape only, not real
  latency or Czech voice quality.
- **Live comparison: unverified.** No ≥5 trials per mode were run on the same
  saved notes, and no authorized headphone/speaker session was observed. The
  Gemini Live vs chained comparison therefore has **no published benchmark
  numbers** and remains `live unverified`; the UI label must stay honest until
  separately approved credentials/cost and real trials are recorded.

## Stage 5 - Five-stage release gate (P54)

- **Exact offline gate:** `pnpm lint`, `pnpm typecheck`, `pnpm test` (923
  passed / 144 skipped), `pnpm test:db` (160/160), `pnpm test:e2e` (70/70) and
  `pnpm build`. The E2E command builds Next.js and runs
  `scripts/test-server.ts` against the isolated `_test` database with dummy
  keys only.
- **Mock E2E flow:** `e2e/voice-agent-mock.spec.ts` covers `connect -> select
  note -> preview edit -> reject -> approve -> undo -> stop`. The note is
  byte-unchanged and has one `initial` revision before the explicit
  `Potvrdit` click; the click produces exactly one `ai` revision; P25 Undo
  restores the exact previous Markdown and appends an `undo` revision. A
  second connect proves the microphone lease/Web Audio resources were released.
  Browser storage contains no transcript or note text. The Gemini token call
  goes to the loopback mock in `scripts/test-server.ts`; the Gemini Live
  WebSocket is mocked by `tests/helpers/webrtc-double.ts` (the plan's historical
  filename, now carrying the Gemini JSON protocol). All tool, proposal,
  confirmation and note routes are the real local implementations.
- **Not live evidence:** no Google, ElevenLabs or OpenRouter request is made by
  the gate. Real Gemini function-call continuation, Czech voice quality,
  barge-in latency and the formal comparison trials remain `live unverified`.
  Mocked timings are not reported as real performance.
