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
