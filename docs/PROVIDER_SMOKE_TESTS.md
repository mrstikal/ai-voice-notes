# Provider Smoke Tests

Automated tests never call a real provider. This document records the
compatibility gates and any separately authorized live evidence. A live check
that has not been authorized or performed is reported as `live unverified`, not
as working provider compatibility.

## ElevenLabs Scribe v2 Realtime single-use token (P13)

| Item | Value |
|---|---|
| Installed package | `@elevenlabs/elevenlabs-js` 2.74.0 |
| Official documentation checked | 2026-10-26: <https://elevenlabs.io/docs/api-reference/tokens/create>, <https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/client-side-streaming> |
| SDK token type | `ElevenLabs.SingleUseTokenType.RealtimeScribe` (`realtime_scribe`) |
| Realtime model | `scribe_v2_realtime` |
| Server request | `POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe` with the server-side `xi-api-key`; no browser key |
| Response field observed in documentation | `{ "token": "sutkn_..." }`; documented validity 15 minutes, consumed on first use |
| Account entitlement | Verified for Scribe realtime on 2026-10-26: the single-use token endpoint returned 200 and a realtime session started. The same key is restricted and returned 401 for `voices_read` and `text_to_speech`, so those permissions are not claimed. |
| Live call authorized / performed | Yes / Yes (2026-10-26; token plus realtime session through the P13B diagnostic) |
| Cost and uncertainty | Token creation has no separately published charge. Published Scribe v2 Realtime audio pricing is $0.39/hour. The local P12 admission reserved $0.0195 for the bounded 180-second session and recorded the actual session charge as `unknown`, never as free. This is an app-side estimate, not a provider spending cap. |
| Status | Mock verified / live verified (token + realtime) |

### Local mock verification

`tests/api/scribe-token.test.ts` injects an ElevenLabs transport that returns
synthetic `sutkn_*` tokens and records every request. It verifies:

- exactly one `realtime_scribe` token per explicit POST and no token reuse,
- the 900-second expiry metadata and the 180-second session bound,
- the P12 reservation before the outbound request and the `unknown` settlement,
- missing key, missing Origin, wrong Host, invalid body, rapid-call rate limit,
- provider failure, authentication failure, malformed token and budget denial,
- no API key or token in the ledger payload or error response.

`tests/security/test-mode.test.ts` verifies that `AI_TEST_MODE=1` rejects a
non-`_test` database, public or non-loopback mock endpoints, and any non-dummy
provider key. It also verifies that a test transport can only be installed in
`NODE_ENV=test` and that an unmocked outbound call is blocked before a budget
reservation.

`scripts/test-server.ts` starts a loopback-only mock on `http://127.0.0.1:4010`
for the E2E harness. It answers only
`POST /v1/single-use-token/realtime_scribe`, requires the exact dummy
`xi-api-key`, and returns synthetic `sutkn_mock_*` tokens. It never forwards a
request to a public provider.

### Live smoke procedure (requires separate authorization)

1. Set `ELEVENLABS_API_KEY` in the gitignored `.env.local`; do not pass secrets
   in command-line arguments.
2. Start the local app and POST `{}` with the exact loopback `Origin` and
   `Content-Type: application/json` to `/api/elevenlabs/scribe-token`.
3. Use the returned token once in the P13B browser diagnostic. Do not log,
   store or reuse it; request a new token for every Start.
4. Record the date, observed request/response fields, account entitlement,
   duration, provider-reported usage/cost or `unknown`, and the result below.

Live evidence: see [Live evidence (2026-10-26)](#live-evidence-2026-10-26).

## ElevenLabs Scribe v2 Realtime browser diagnostic (P13B)

| Item | Value |
|---|---|
| Installed browser packages | `@elevenlabs/react` 1.20.0, with its `@elevenlabs/client` 1.31.0 dependency |
| Official documentation checked | 2026-10-26: <https://elevenlabs.io/docs/eleven-api/resources/libraries/scribe-stt/react-scribe>, <https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/client-side-streaming>, <https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies> |
| SDK hook | `useScribe` from `@elevenlabs/react` |
| Realtime model | `scribe_v2_realtime` |
| Czech language | `languageCode: "cs"`; the documentation accepts ISO-639-1 or ISO-639-3 codes and `cs` is the ISO-639-1 Czech code |
| Callback types observed in installed SDK | `onPartialTranscript: (data: { text: string }) => void`, `onCommittedTranscript: (data: { text: string }) => void` |
| Commit strategy | `CommitStrategy.VAD` with `vadSilenceThresholdSecs: 1.2`; documented range 0.3-3.0 s |
| Microphone lease | Exclusive same-origin Web Locks lock `ai-voice-notes:microphone`; Start is disabled with Czech guidance when Web Locks is unavailable |
| Session bound | 180 s from the start of the connection attempt; the timer is armed before the microphone/`session_started`, so a provider that never acknowledges is still stopped |
| Token lifecycle | One P13 `POST /api/elevenlabs/scribe-token` per user Start; no cached or reused token; lost connection requires a new Start |
| Account entitlement | Verified for `realtime_scribe` on 2026-10-26: token 200 and `session_started`. The same key lacks `voices_read` and `text_to_speech` permissions. |
| Live audio source | 180 s synthetic Czech WAV generated locally from a 37.68 s free gTTS sample looped five times, fed through Chromium fake audio capture. The remote-desktop `RDPSource` was silent (peak 38, RMS 1.99), so a physical microphone was not exercised. |
| Live call authorized / performed | Yes / Yes (2026-10-26; 180 s synthetic Czech audio) |
| Cost and uncertainty | One live Scribe session: the P12 row reserved $0.0195 and recorded the charge as `unknown`. The fixture used free gTTS, not ElevenLabs TTS. |
| Status | Mock verified / live verified with synthetic Czech audio; physical microphone unverified |

The pinned client normalizes a microphone `DOMException` into a plain `Error`
whose `name` is lost, so the diagnostic maps the surviving message text
(`Permission denied`, `Requested device not found`, `Could not start audio
source`) to the specific Czech guidance instead of relying on `error.name`.

### Local mock verification

`tests/voice/microphone.test.ts` verifies the exclusive lease, the busy second
tab, the 180-second timeout (including a provider that never emits
`session_started`), token-per-Start, lost-connection recovery, Stop/unmount
release, missing Web Locks, normalized permission/no-device/busy messages,
late-start cleanup after termination and the loopback token request.

`tests/voice/scribe-diagnostic.test.tsx` mocks `useScribe` and verifies that:

- the documented `cs`, VAD 1.2 s, model and microphone options are passed,
- each Start fetches a fresh token and each Stop releases the microphone,
- partial text is replaced in place and committed segments stay stable,
- partials and committed text are never written to storage or a note API,
- two rendered tabs cannot own the microphone simultaneously,
- a lost connection shows the Czech recovery message and requires a new user
  Start with a new token,
- SDK-normalized `Permission denied` text produces the specific Czech
  microphone-permission guidance,
- a provider-specific error callback produces its own Czech message,
- the raw provider detail is exposed only in a collapsed technical section,
- unmount releases the lease,
- Start stays disabled with Czech guidance when Web Locks are absent.

### Live smoke procedure (requires separate authorization)

1. Set `ELEVENLABS_API_KEY` in the gitignored `.env.local`; do not pass secrets
   in command-line arguments.
2. Open `/voice/diagnostic` in Chromium, approve microphone access and dictate
   2-3 minutes of Czech speech in one or more bounded sessions.
3. Confirm partial replacement, committed segments, the 180-second automatic
   stop, a fresh token on every Start, and that the lease is released after
   Stop. Check the usage ledger for an `unknown` charge.
4. Record the date, observed request/response fields, account entitlement,
   duration, provider-reported usage/cost or `unknown`, and the result below.

Live evidence: see [Live evidence (2026-10-26)](#live-evidence-2026-10-26).

## Title capture (P14)

| Item | Value |
|---|---|
| Provider path | ElevenLabs Scribe v2 Realtime through the P13 single-use token; title applied only through `PATCH /api/notes/:id/title` |
| Mock verification | `tests/voice/title.test.tsx` covers partial/abort, one confirmed `voice` title, cancel, permission/Web Locks guidance, lost connection, two-tab lease, unmount, stale note version, overlong title, dirty editor and late old-session callbacks |
| Live call authorized / performed | No / No (the P14 manual title smoke is opt-in and has not been run) |
| Status | Mock verified / live unverified for the title flow; the underlying P13B Scribe realtime path is live verified with synthetic Czech audio |

## Body dictation (P15)

| Item | Value |
|---|---|
| Provider path | ElevenLabs Scribe v2 Realtime through the P13 single-use token; committed segments append to the P09 Markdown draft, partials stay in an overlay only |
| Mock verification | `tests/voice/body.test.ts` covers the transcript queue/insertion helpers; `e2e/dictation-mock.spec.ts` covers partial replacement without a DB write, duplicate provider id ignored, identical legitimate commits retained, cursor and end insertion, Stop flush, empty acknowledgement without a false warning, missing acknowledgement warning, late callback rejection, refresh persistence and provider errors preserving manual edits |
| Live call authorized / performed | No / No (P15 uses a mocked WebSocket; the underlying P13B Scribe realtime path is live verified with synthetic Czech audio) |
| Status | Mock verified / live unverified for body dictation integration |

## OpenRouter speech / ElevenLabs Eleven v4 Turbo (P18)

| Item | Value |
|---|---|
| Provider path | `POST https://openrouter.ai/api/v1/audio/speech` through the server-only `OpenRouterClient`; the API key never reaches the browser |
| Official documentation checked | 2026-10-27: <https://openrouter.ai/docs/guides/overview/multimodal/tts>, <https://openrouter.ai/docs/api/api-reference/tts/create-speech>, <https://openrouter.ai/elevenlabs/eleven-v4-turbo>, <https://openrouter.ai/api/v1/models?output_modalities=speech> |
| Pinned model | `elevenlabs/eleven-v4-turbo`; the route rejects a client-supplied `model` field |
| Voices | `sarah` and `george` from the published `supported_voices` list; both returned HTTP 200 with valid audio in the 2026-10-27 live check; no invented or substituted IDs |
| Response format | `response_format: "mp3"` is sent explicitly because the documented default is raw PCM; no `speed` field is sent |
| Request bound | At most 3,500 UTF-16 code units per request, below the model's published 10,000-character cap; the 60 s request deadline covers both response headers and body streaming. The P18 unit-test handler uses 5 requests/60 s; the production P19 read-aloud route raises the shared billable route to 30 requests/60 s for sequential chunk playback. |
| Response validation | `Content-Type` must be `audio/mpeg`; the body is capped at 8 MiB and checked for an MP3 header before it is returned. JSON error bodies are never treated as audio. |
| P12 admission | Operation `openrouter_tts`, provider `openrouter`, model `elevenlabs/eleven-v4-turbo`; each request reserves at most $0.14 before the outbound call. Provider-reported cost is not returned, so the ledger records `unknown`, never free. |
| Pricing checked | 2026-10-27 models API reported `pricing.prompt = 0.00004` for `elevenlabs/eleven-v4-turbo`; 3,500 input units x $0.00004 = $0.14 app-side upper estimate, not a provider spending cap. |
| Account entitlement | Both `sarah` and `george` returned HTTP 200 with valid audio on 2026-10-27; no entitlement error. The existing ElevenLabs key's missing `text_to_speech` permission does not apply to this OpenRouter path. |
| Live call authorized / performed | Yes / Yes (2026-10-27; one Czech sentence in each voice, two requests) |
| Status | Mock verified / live verified for both voices on 2026-10-27; technical audio validation and human listening both confirmed Sarah and George are OK |

### Local mock verification

`tests/api/tts.test.ts` injects a mock OpenRouter transport and fake P12 usage
service. It verifies:

- exact outbound `model`, `input`, `voice`, and explicit `response_format: "mp3"`
  fields for both `sarah` and `george`, with no `speed`,
- the endpoint, bearer key handling on the server, `Accept: audio/mpeg`, and the
  P12 reservation before the provider call,
- rejection of an invalid voice and of a voice marked unavailable for the
  account before any reservation or outbound request,
- the 3,500 UTF-16 code-unit bound at the boundary and one unit above it,
- JSON error bodies, 401, 429, header-phase timeout, stalling-body timeout,
  wrong content type, byte cap, invalid MP3 bytes, missing key, unmocked
  provider call, budget denial, and the route rate limit,
- no provider message, API key, or dictated text in the error response or the
  P12 usage payload,
- route guards for missing Origin, wrong Host, non-POST methods, and extra
  fields such as a client-supplied model,
- the provider status marks both voices `live unverified` until an explicit
  live check; a disabled voice is `unavailable` and keeps two-voice acceptance
  unverified.

### Live smoke procedure (requires separate authorization)

1. Set `OPENROUTER_API_KEY` in the gitignored `.env.local`; do not pass secrets
   in command-line arguments.
2. Start the local app and send one short Czech sentence to `POST /api/tts`
   with `voice: "sarah"`; save the returned MP3 and listen to it. Repeat with
   `voice: "george"`. The P18 adapter has no player UI; P19B adds the explicit
   read-aloud flow.
3. Confirm the request used `elevenlabs/eleven-v4-turbo`,
   `response_format: "mp3"`, no `speed`, and the 3,500-code-unit bound. Confirm
   the response is `audio/mpeg` and the ledger row is `unknown` with the
   reserved $0.14.
4. If either voice is unavailable to the account, add its ID to
   `TTS_UNAVAILABLE_VOICES` in `src/lib/tts/provider.ts`, keep
   `TTS_LIVE_VERIFIED = false`, and keep two-voice acceptance
   `live unverified`. Never substitute an invented voice ID.
5. Only after both voices have been heard, set `TTS_LIVE_VERIFIED = true` and
   record the date, observed fields, entitlement, cost/unknown result, and the
   listening evidence below.

### Live evidence (2026-10-27)

- **Authorization:** the user explicitly requested the live OpenRouter TTS test
  on 2026-10-27.
- **Environment:** existing `pnpm dev` server at `http://127.0.0.1:3000` with
  the real gitignored `.env.local`, no `AI_TEST_MODE`; the development
  PostgreSQL database was reachable and the app-side budget row was
  `2.000000`.
- **Requests:** `POST /api/tts` with the exact loopback `Host` and `Origin` and
  `{"text":"Dobrý den, toto je krátká česká zkouška čtení nahlas.","voice":"sarah"}`,
  then the same text with `"george"`. The text was 53 UTF-16 code units, below
  the 3,500 bound.
- **Responses:** both returned `200 OK` with `Content-Type: audio/mpeg`,
  `X-TTS-Model: elevenlabs/eleven-v4-turbo`, the requested
  `X-TTS-Voice`, and generation IDs
  `gen-tts-1793105790-aNH2GGll4ipZDy5v9v6C` (Sarah) and
  `gen-tts-1793105796-ZRwo4zhC8kRGnEpKBctx` (George). Byte lengths were
  71,514 and 69,006.
- **Technical audio validation:** `file` identified both as ID3v2.4 MPEG ADTS
  layer III, 128 kbps, 44.1 kHz mono. MP3 frame parsing found 171/165 frames and
  4.467/4.310 seconds; headless Chromium Web Audio decoded them to 4.40/4.24
  seconds with peak 0.949/0.754, RMS 0.131/0.084 and non-zero sample ratios
  95.6%/90.3%, so neither file is silent. The SHA-256 prefixes differ, confirming
  distinct audio for the two voices.
- **Artifacts:** `/tmp/kilo/tts-live/sarah.mp3` and
  `/tmp/kilo/tts-live/george.mp3` (local test artifacts, not application data).
- **Ledger:** two `openrouter_tts` / `openrouter` /
  `elevenlabs/eleven-v4-turbo` rows, both status `unknown`, reserved
  `0.140000`, no reported cost. Provider usage contained only model, voice,
  inputCodeUnits, responseFormat, httpStatus, contentType, byteLength,
  generationId and chargeReason; no text, API key or audio. The two TTS
  reservations total `0.280000`; the ledger's total committed amount is
  `0.338500` including earlier operations, while the configured budget row
  remains `2.000000`.
- **Human listening:** the user listened to both artifacts on 2026-10-27 and
  confirmed that Sarah and George are OK. `TTS_LIVE_VERIFIED` is now `true`, so
  the settings page marks both voices available and the two-voice audio quality
  as live verified.
- **Agent limitation:** the automated agent verified decodable, non-silent audio
  and account entitlement, but the subjective quality confirmation above came
  from the user, not from the agent.

## P19 read-aloud cache

- The server cache lives under gitignored `.data/tts`, stores only validated
  MP3 bytes, and keeps a note-owner manifest. The content key covers text,
  model, voice and a settings hash; the cap is 200 MiB with LRU pruning that
  deletes only manifest-listed files.
- A successful note content edit triggers a best-effort purge of that note's
  cache ownership after the save; a purge failure cannot fail the note save.
- `POST /api/tts/cache` supports `clear`, `purge` by voice, `purge` by model and
  `purge` by note. P19B's persisted voice selector must call the voice purge
  when the choice changes. Until P19B, the Settings panel offers only the
  explicit manual clear.

## P20 experimental spoken Stop

- **Default:** off. The setting is per browser (`localStorage`, key
  `ai-voice-notes:stop-monitor-enabled`) and is enabled only by the explicit
  checkbox on `/settings` after the Czech cost/microphone disclosure.
- **Runtime:** while read-aloud playback is active, the player mounts the
  normal Scribe dictation hook in command-only mode. It uses the existing
  `ai-voice-notes:microphone` Web Lock and the same Scribe token/session
  controller as P13B. Playback always holds `ai-voice-notes:tts-playback`;
  with the monitor enabled it also holds `ai-voice-notes:microphone` in
  **shared** mode, and the monitor requests the same lock shared. Another tab's
  exclusive dictation is therefore refused even before the monitor connects,
  while playback continues if a dictation already owns the microphone (spoken
  Stop is then refused, button Stop still works). With the monitor disabled,
  playback takes the microphone lock exclusively as in P19B.
- **Command scope:** only a committed standalone `stop` (optional punctuation)
  calls the local player Stop. If a partial stabilizes on exactly `stop` for
  about 400 ms, the monitor requests a manual Scribe commit so the normal
  committed path can run; the partial itself never stops audio. Partials and
  all other committed text are ignored, never inserted into a note, and never
  persisted. The browser requests echo cancellation and noise suppression;
  headphones are recommended.
- **Cleanup:** the monitor stops on button Stop, spoken Stop, natural end,
  playback/provider failure, settings change, or page unmount. A busy
  microphone (another tab or mode) refuses the monitor but never blocks the
  physical button.
- **Aggregates:** only attempts, successes and the slowest delay from the end
  of speech to the committed command are stored under
  `ai-voice-notes:stop-monitor-stats`. No audio or transcript is stored.
  Reset is available in Settings.
- **Evidence:** deterministic tests are in
  `tests/voice/stop-monitor.test.ts` and
  `tests/settings/spoken-stop.test.tsx`. They use a mocked Scribe connection,
  mocked TTS echo/audio, a fake Web Locks manager, and no network/provider
  call. They cover TTS echo, standalone stop, note immutability, mic close,
  natural end, second-tab conflict, token failure, button Stop, settings and
  aggregate storage.

### Manual live procedure (user-verified 2026-10-27; formal aggregate not recorded)

This procedure opens the microphone and consumes one Scribe token per
playback start. It is not run automatically. The user verified the feature with
a Jabra headset and accepted P20 on 2026-10-27; the formal ten-trial aggregate
numbers were not recorded in this session.

1. Use a desktop Chromium/Edge, headphones and a physical microphone. On
   `/settings`, read the disclosure and explicitly enable the experimental
   spoken Stop.
2. Open a Czech note, load the read-aloud manifest/cost, consent to TTS, and
   start playback.
3. Confirm the player says it is listening, then say a standalone `stop` ten
   times across ten playback starts. Record the reported aggregate attempts,
   successes and slowest end-of-speech-to-command delay; do not record audio
   or transcripts.
4. On a separate trial, let playback end naturally and confirm the microphone
   indicator closes. Repeat with the button Stop and with another tab owning
   the microphone (spoken Stop refused, button still works).
5. Optional failure trial: deny microphone permission or block the token
   request; playback must continue and the button Stop must still stop audio.

Report the ten successes, the slowest end-of-speech-to-command delay and any
false positives/negatives.
Label the result experimental; it is not a guarantee. Acceptance was based on
the user's headset verification, not on a recorded ten-trial aggregate.

## P21 structured OpenRouter LLM

- **Frozen candidate:** `deepseek/deepseek-v4.1-flash-1017`, also the default
  `OPENROUTER_LLM_MODEL` and the only model the structured path accepts. A
  different env value blocks structured AI with a Czech configuration error
  instead of falling back to free text or another model. Changing it requires
  a fresh capability/account preflight and explicit user approval.
- **Free preflight evidence (2026-10-27):** `GET /api/v1/models` returned
  `200`; the candidate advertised `structured_outputs` and `response_format`,
  text output, context `1,048,576`, and top-provider max completion
  `393,216`. Base prices were `0.00000015` prompt / `0.0000006` completion USD
  per token; weekday overrides reach `0.0000003` / `0.0000012`, which are the
  frozen worst-case values. `GET /api/v1/key` returned `200`, not a free tier,
  with no configured spend limit. The free checks made no billable model
  request.
- **Enforced bounds:** input `12,000` UTF-16 code units, output `1,200` tokens
  (`max_completion_tokens`), timeout `20 s`, response body `64 KiB`, and a
  worst-case estimate of `$0.011187` per maximum request with a hard local
  cap of `$0.02`. The estimate includes the serialized 3,605-character schema
  and uses a conservative `2 × (request code units) + 256` upper-bound
  heuristic, not a tokenizer.
- **Strict contract:** `response_format` is `json_schema`, schema name
  `note_edit_proposal`, `strict: true`, `provider.require_parameters: true`.
  The provider schema is a closed root object with required `kind`,
  `operation` and `clarification`; `operation` is an `anyOf` of the P22
  operations, `clarification`/`operation` are null in the inactive branch.
  The server validates this wrapper, normalizes it to
  `{kind:"operation", operation}` or `{kind:"unclear", clarification}`, and
  revalidates the normalized union. Extra keys and unsafe actions are rejected
  even when the provider returns valid-looking JSON. There is no root `oneOf`
  or root `additionalProperties` ambiguity. The client never retries
  429/timeouts/denials.
- **Privacy/usage:** the reservation records only request kind, schema name,
  input code units, token bounds, model-profile date and HTTP metadata. Raw
  prompt, response, API key and transcript never enter logs or `ai_usage`.
  A success is marked `unknown` cost (no provider cost field is trusted as
  zero); settlement failure blocks acceptance.
- **Compatibility:** live **verified** for this candidate. One separately
  authorized short structured request on 2026-10-27 returned a valid
  `append_bounded_section` operation through the real OpenRouter path. P12
  budget before the request: remaining `0.646000 USD`, no active operations;
  after settlement the ledger showed `1.358170 USD` committed, 21 unknown
  operations and 0 active. The request reserved `0.011187 USD`; the actual
  provider charge remains `unknown`, never zero. No prompt/response was logged
  and no note was changed. P21 still only returns
  `{kind:"operation", operation}` or `{kind:"unclear", clarification}`.
- **Deterministic evidence:** `pnpm exec vitest run tests/ai/structured.test.ts`
  covers valid operation/unclear, extra keys, unsafe actions, malformed JSON,
  truncation, refusal, 429, timeout, 403 provider denial, budget denial,
  unknown-usage settlement failure, oversized input, cost cap and preflight
  capability failures, with no note mutation path.

## P26 spoken/typed AI edit interpretation

- **Entry points:** the explicit "Interpretovat příkaz" button in the AI panel.
  Typed text or one committed Scribe command fills the command field; a normal
  dictation event never calls OpenRouter. The panel sends only the command,
  note title and a selected snippet of at most 1,200 graphemes; the selected
  snippet is context, and P22 re-resolves the operation against the whole
  stored note before P23 shows the diff.
- **Disclosure:** the panel shows the frozen OpenRouter model, input bound and
  maximum estimated cost, and is disabled with a Czech reason when the key or
  model is unavailable. A normal note remains fully editable without a key.
- **Undo:** `vrať/vrátit/undo` variants (including polite forms and plural
  stems) are detected locally before the LLM; the UI opens the P25 undo
  preview and requires a second confirmation. No LLM operation can perform
  undo. This local path remains available even when the OpenRouter key/model is
  blocked; only LLM-dependent interpretation is disabled.
- **Validation:** P21 accepts only the strict operation/unclear union; P22
  resolves, P23 persists a pending diff and P24 applies it once after a
  nonce-bound confirmation. Prompt-injection text is JSON data and the system
  prompt says to ignore it; the UI still shows the exact diff.
- **Fixtures:** `tests/fixtures/czech-edits.ts` has 35 fixed commands covering
  sentence targets, replace/insert/delete, H1-H3, last sentence, tasks,
  paragraphs, append, Undo variants, prompt injection, off-topic/unclear and
  bad-model JSON. The automated suite is structural: it proves prompt bounds,
  grammar, anti-injection instructions, Undo routing and error paths, **not**
  live model interpretation quality.
- **Live model/voice smoke (performed 2026-10-27):** typed smoke used 13
  representative commands against the real frozen model. Batch 1 (8): replace
  resolved, insert resolved, delete unclear, heading resolved, last sentence
  unclear, task resolved, prompt injection unclear (expected), off-topic unclear
  (expected). Batch 2 (5): explicit delete `llm_truncated`, explicit last
  resolved, paragraph unclear, append resolved, task-uncheck resolved. Summary:
  7/13 commands produced a resolved operation; 3 valid commands were unclear;
  1 valid command hit the output-token cap; the 2 intentionally unsafe/unclear
  commands were correctly refused. The prompt was then tuned with explicit
  scoped `delete_sentence` and `replace_paragraph` rules and JSON examples; a
  targeted live retest resolved both commands (2/2), removing the observed
  delete/paragraph weakness.
- **Voice path:** a synthetic Czech command generated by ElevenLabs TTS was
  supplied to real Scribe via a fake microphone. The Scribe token/WebSocket
  path ran, the committed command (38 characters) filled the AI command field,
  and the real model produced a P23 preview for `replace_sentence`; the note
  content/version stayed unchanged. The first harness attempt read the wrong
  field too early; the corrected run is the evidence. This is synthetic speech,
  not a human headset trial, so a short human headset trial is still
  recommended.
- **Cost/evidence:** ledger before the model smoke: committed `1.362873 USD`,
  remaining `0.637127 USD`; after both model batches: committed `1.423901 USD`,
  remaining `0.576099 USD`; after the voice TTS/Scribe/model runs: committed
  `1.636477 USD`, 42 unknown operations, remaining `0.363523 USD`; after the
  tuned prompt retest: committed `1.646820 USD`, 44 unknown operations,
  remaining `0.353180 USD`. Prompt, response and audio were not logged;
  synthetic smoke notes and TTS cache were deleted/purged. No full ten-trial
  manual headset protocol was run.

## P36 OpenRouter embeddings

- **Frozen contract:** `POST /api/v1/embeddings` with
  `model: "openai/text-embedding-3-small"`, `dimensions: 1536`,
  `encoding_format: "float"` and a text/array `input`. A different
  `OPENROUTER_EMBEDDING_MODEL` blocks semantic indexing with a Czech reason;
  the database `vector(1536)` dimension is never changed silently.
- **Official documentation checked (2026-10-28):**
  <https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request>
  documents `input`, `model`, `dimensions` and `encoding_format`; the success
  response contains `data[].embedding` (float array or base64 string),
  `data[].index`, `model`, and `usage.prompt_tokens`/`total_tokens`/`cost`.
  <https://openrouter.ai/docs/api/reference/embeddings> shows the same
  OpenAI-compatible batch shape.
- **Catalog caveat:** `GET /api/v1/models` returned `200` with 425 entries on
  2026-10-28 but no `openai/text-embedding-3-small` entry, so catalog metadata
  could not confirm `dimensions` support. The adapter therefore validates the
  **actual** returned vectors (exactly 1,536 finite numbers each) rather than
  trusting catalog metadata.
- **Live evidence (authorized 2026-10-28):** one real embeddings call with two
  short Czech inputs returned two vectors of 1,536 finite values in 789 ms.
  The upstream response reported `model: "text-embedding-3-small"` (the short
  form of the requested `openai/text-embedding-3-small`); the adapter accepts
  that documented normalization only for the frozen model and stores the
  canonical requested ID. `usage.prompt_tokens` was 35 and the reported cost
  was `0.0000007 USD`. The P12 ledger row is `embedding_reindex` /
  `openrouter` / `openai/text-embedding-3-small`, status `settled`, reserved
  `0.000001`, reported `0.000001`, with HTTP metadata, dimensions, input count,
  token count and the returned model in `provider_usage`; no input text, key or
  vector was logged. A full note-level reindex was not run live.
- **Bounded reindex:** only the explicit `Reindexovat` action derives missing
  current-version chunks for pre-P35 notes and shows an estimate; a second
  explicit confirmation submits at most 3 notes / 20 chunks. A confirmed batch
  whose recomputed estimate exceeds the approved one is refused with
  `reindex_cost_changed`. The next batch needs another user action. Vectors are
  written as `ready` with the current note version and model only after
  re-reading the locked note version in a transaction. A failed or ambiguous
  provider request marks the affected chunks `error` (never retried
  automatically) and leaves P12 billing `unknown` when the provider cost cannot
  be established. An edit during the flight discards the stale batch.
- **Deterministic evidence:** `tests/search/embeddings.test.ts` covers the
  request contract, provider order, reported-cost settlement fallback, wrong
  length, non-finite/null values, missing vectors, wrong model, contract
  rejection, batch bounds and the blocked key state. `tests/db/reindex.test.ts`
  covers preparing a missing pre-P35 note, ready/model skip, failure plus
  manual retry, edit-during-flight, readable/searchable other notes, changed
  cost refusal, the 3-note/20-chunk cap and the no-approval path. Offline tests
  use an injected transport and make zero paid calls.

## P37 semantic query

- **Paid boundary:** `mode=semantic` is only available through a same-origin
  `POST /api/search` with explicit `confirmCost: true` and an approved maximum
  cost. GET with `mode=semantic`, page render, typing and refresh make no
  provider call; GET returns `400 semantic_requires_post`. Full-text search and
  its UI remain usable without a key.
- **Query contract:** the query is trimmed to at most 200 graphemes (and 2,000
  UTF-16 code units in the semantic route) before the P36 embedding adapter
  embeds it once. The P12 row uses operation `embedding_query` and request kind
  `embedding_query`; the query text is not stored, and no query vector is
  written to note tables.
- **Ranking:** exact pgvector cosine distance (`<=>`) over current-version,
  active notes with `status='ready'`, the configured/frozen model and a
  non-null embedding. `row_number()` picks the best chunk per note, then the
  outer query orders by distance and note ID, so ties are deterministic. The
  result shows a 240-grapheme excerpt and an incomplete-index notice when
  current pending/error notes exist. An empty ready index returns
  `409 semantic_index_empty` before any paid call, not a fake result.
- **Live smoke (authorized 2026-10-28, isolated test database):** two
  synthetic notes were created; the explicit reindex prepared and submitted
  two chunks/vectors (`embedding_reindex`, settled `0.000002 USD`). One
  confirmed query embedding (`embedding_query`, 17 prompt tokens, settled
  `0.000001 USD`) ranked the chemistry note first for the query
  `kyselina jablečná v laboratorním vzorku`; the unrelated administrative note
  was returned second by KNN. No note text, provider payload or vector was
  logged. Both synthetic notes/chunks were deleted in `finally`. This verifies
  the live query-embedding path and cosine ranking, not semantic answer
  quality; P38 owns the 20-query Hit@k/MRR evaluation.
- **Deterministic evidence:** `tests/search/semantic.test.ts` covers excerpt
  bounds/surrogates and pre-DB vector/page validation; `tests/db/semantic.test.ts`
  covers closest-note ranking, best-chunk aggregation, deleted/other-version/
  other-model exclusion, pending current chunks, deterministic pagination and
  no note-table writes. `tests/api/search-semantic.test.ts` covers the GET
  rejection, confirmation/approval gate, empty index, missing key plus usable
  full-text search, one embedding call, index composition and provider error
  mapping. `e2e/search-semantic-mock.spec.ts` proves no POST on load/typing,
  one confirmed mocked POST, the incomplete-index notice, the exact note link
  and the empty-index error.

## Live evidence (2026-10-26)

- **Authorization:** the user explicitly requested the live microphone/provider
  smoke on 2026-10-26.
- **Environment:** `pnpm start` with the real gitignored `.env.local`, no
  `AI_TEST_MODE`, and the development database migrated through `0001_budget`.
- **Browser:** headless Chromium (Playwright) with
  `--use-fake-device-for-media-stream`,
  `--use-file-for-fake-audio-capture` and microphone permission granted.
- **Audio source:** a 180 s Czech WAV built by looping a 37.68 s gTTS sample
  five times. The remote-desktop `RDPSource` was silent (peak 38, RMS 1.99), so
  a physical microphone was not exercised. No ElevenLabs TTS was used; the key
  returned 401 for `text_to_speech` and `voices_read`.
- **Token:** one `POST /api/elevenlabs/scribe-token` returned 200 with keys
  `expiresAt`, `expiresInSeconds`, `maxSessionSeconds`, `modelId` and `token`.
  The token had the `sutkn_` prefix and was 34 characters. The token itself was
  not logged, stored or recorded.
- **Realtime:** WebSocket messages included `session_started`, many
  `partial_transcript` events and four `committed_transcript` events. All probe
  phrases matched in the normalized committed text: nákupní seznam, mléko,
  chléb, jablka, kávu, schůzku and zasedací místnosti (1,410 normalized
  characters).
- **Bound and cleanup:** the UI showed the 180 s timeout at 193.6 s wall-clock
  including setup, Stop became disabled, Start became enabled,
  `sessionStorage`/`localStorage` stayed empty, and there were no console or
  page errors.
- **Ledger:** one row `elevenlabs_scribe_token` / `elevenlabs` /
  `scribe_v2_realtime` with status `unknown`, reserved `0.019500`, no reported
  cost, and provider usage containing only the token type, charge reason,
  session bound and token expiry metadata. Started and settled 2026-10-26
  19:06:07 UTC. The budget remained `2.000000`.
- **Limitation:** this verifies the token, realtime Scribe, Czech
  transcription, Web Locks/UI, timeout and ledger path with synthetic audio. It
  does not verify a physical microphone, the real permission-denied prompt or a
  human 2-3 minute dictation; those remain manual checks.

## P42 direct batch Scribe v2 transcription

- **Provider contract (verified against the current vendor docs and the pinned
  `@elevenlabs/elevenlabs-js` 2.74.0 types, without a paid call):** the direct
  batch endpoint is `POST /v1/speech-to-text` with `multipart/form-data`,
  `model_id=scribe_v2`, an optional `file`, `language_code`,
  `timestamps_granularity` and `diarize`. The synchronous response is a
  `SpeechToTextChunkResponseModel` with `text`, `language_code`,
  `audio_duration_secs` and `words[].speaker_id`; a successful response does not
  report a billed cost. The documented batch limits are 10 hours and 3 GB, so
  the app's 15-minute/25 MiB bound is below the provider limit. Account-level
  entitlement or quota rejection is still possible and is mapped to a Czech
  `elevenlabs_entitlement_denied` error.
- **Paid boundary:** `GET /api/meetings/transcribe` only returns the free cost
  offer (provider, model, language, minute/byte bounds, upper estimate from
  `0.22 USD/hour` and `MEETING_MAX_MINUTES`). `POST` requires exact Host,
  Origin, `application/octet-stream`, the current 25 MiB stream bound and an
  explicit `approveCostUsd` at or above the recomputed estimate; otherwise it
  returns `409 meeting_cost_not_approved` before reading the body. The
  approval ceiling is the larger of 1 USD and the displayed estimate, so a
  raised `MEETING_MAX_MINUTES` remains usable. P12 reserves the estimate before
  the outbound request. ElevenLabs does not report a cost, so a successful call
  is left `unknown` with only model, language, audio duration, diarization flag
  and a charge reason; no transcript text is stored in the usage ledger or
  logs. The UI discloses that ElevenLabs processes the uploaded recording under
  the provider's own retention policy; zero retention depends on the account.
  The app does not set `enable_logging` because zero retention is documented
  only for eligible enterprise accounts.
- **Validation and cleanup:** the re-upload is written to a new 0600 temp file
  under `.data/uploads`, re-inspected with P41B (`ffprobe` magic bytes,
  format/codec, duration), transcribed, and unlinked in `finally` on success and
  every failure. The browser keeps the original Blob; the server never retains
  meeting audio. The returned text is bounded to
  `MEETING_TRANSCRIPT_MAX_GRAPHEMES` (60,000) with no truncation. Speaker IDs
  and segments are derived only from real `speaker_id` values in the provider
  response; otherwise the UI shows `Rozlišení mluvčích není pro tento režim
  dostupné` and no invented labels. Speaker segments keep the provider spacing
  tokens, so a later P42B join does not merge words across speaker turns. All
  preview controls that would replace the recording (Start, file input, Cancel,
  Inspect) are locked while a paid transcription is in flight.
- **Live smoke (authorized and observed 2026-10-29, development DB):** the user
  explicitly authorized the paid check and supplied a 37.68 s Czech WAV
  (16 kHz mono PCM, 1,205,804 B). The real app ran on `pnpm start` with the
  gitignored `.env.local`, no `AI_TEST_MODE` and the real key. The UI showed
  no mock notice, inspected `37,7 s`, offered `0,055 USD`, transcribed through
  the real batch endpoint in 6.5 s and showed an editable 388-character Czech
  transcript with `diarize=true` data: one verified speaker, `speaker_0`, with
  the label editable to `Petra` and propagated to the segment. `Zahodit přepis`
  removed the preview. The text matched the supplied recording (greeting,
  Monday/autumn weather, shopping list, 10:00 meeting, closing sentence).
  `ai_usage` recorded one `elevenlabs_scribe_batch` / `elevenlabs` /
  `scribe_v2` row: status `unknown`, reserved `0.055000`, no reported cost,
  provider usage only `model`, `diarize`, `chargeReason`, `languageCode=ces`
  and `audioDurationSecs=37.68`; no transcript text. Zero notes were created
  and `.data/uploads` held no meeting temp file afterwards. The only console
  error was an unrelated `favicon.ico` 404. This confirms the provider accepts
  the `application/octet-stream` part with the `meeting-upload.wav` filename
  and returns the expected diarized shape; the actual per-second charge remains
  unknown because the provider reports no cost.
- **Deterministic evidence:** `tests/meetings/transcribe.test.ts` covers the
  documented contract/estimate, diarized and no-speaker parsing, malformed,
  empty and oversized output, missing key, entitlement, timeout, rate limit,
  provider failure, the free offer, approval refusals, real 1-second WAV
  re-inspection, a real 900-second WAV with a provider entitlement denial, a
  raised `MEETING_MAX_MINUTES` approval, temp-file deletion and zero note/usage
  side effects beyond the reservation. The loopback mock rejects a request whose
  multipart body lacks a non-empty `file` part with a `meeting-upload` filename,
  so the E2E proves the audio bytes reached the provider path. `e2e/meeting-inspect.spec.ts` uploads a validated WAV, confirms
  the cost, checks the mocked Czech transcript and speaker labels, edits a
  label, confirms zero notes and temp files, and dismisses the preview.

## P42B reviewed transcript and atomic note creation

- **No provider path:** `POST /api/meetings/save` is local-only. It uses the
  guarded P04 JSON route (exact Host/Origin, `application/json`, rate limit) and
  never resolves a provider key, calls ElevenLabs/OpenRouter, or writes P12
  usage. Saving remains available when no provider key is configured.
- **Body bound:** the route has its own **3 MiB streaming** cap
  (`MEETING_SAVE_MAX_BYTES`), separate from the 1 MiB note-edit cap in P04. The
  browser serializes the payload and computes its exact UTF-8 JSON byte length
  before POST; over the cap it makes **no** request and immediately offers
  `Stáhnout přepis (.txt)`. A forced direct POST over the cap returns
  `413 payload_too_large` before any DB work.
- **Content contract:** the server trims and canonicalizes the reviewed text,
  escapes Markdown so literal `#`, `**`, links, HTML-like text, entities and
  list markers are preserved as visible text, and revalidates every part through
  P02 `prepareNoteContent`/`countGraphemes`. Speaker labels are persisted only
  as the reviewed `**Label:** text` paragraphs, never as provider metadata.
- **Split and transaction:** one part up to the configured note limit (default
  20,000 visible graphemes) creates one note. A longer review is packed greedily
  at paragraph/segment boundaries into at most three parts, each at most the
  note limit, with titles `Název – část i/n`. If a single paragraph exceeds the
  limit or four or more parts would be required, the route returns
  `422 meeting_transcript_too_long` with details and never truncates; the UI
  offers the local download. Every note insert, its `initial` revision,
  search/chunk refresh and the `meeting_saves` row happen in **one** transaction;
  an injected failure after the first note rolls everything back.
- **Idempotency:** the browser assigns one UUID per reviewed preview. The server
  stores `meeting_saves(request_id PK, input_hash, note_ids, created_at)` where
  `input_hash` is SHA-256 of the normalized title plus canonical paragraphs, and
  inserts the row with `ON CONFLICT DO NOTHING` inside the same transaction. A
  retry with the same request id and hash returns the first note ids (HTTP 200,
  `duplicate: true`); reusing the id with different reviewed content returns
  `409 meeting_save_conflict`. Concurrent identical submits serialize to one
  note set. The save UI locks Start/file/Cancel/Inspect and its own controls
  while the request is in flight and disables editing/saving after success.
- **Offline determinism:** `tests/db/meeting-save.test.ts` covers literal
  Markdown preservation, one/two-part creation, numbered titles, initial
  revisions, duplicate/conflicting request ids, concurrent idempotency,
  rollback-on-error, too-long refusal, persistence through a fresh connection
  and the forced 3 MiB 413 path. `e2e/meeting-save-mock.spec.ts` saves a mocked
  diarized review into one note, asserts no additional `ai_usage` row, opens the
  saved note, proves dismissal creates nothing and probes the direct 3 MiB
  rejection. No live provider call is involved in P42B.
