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
