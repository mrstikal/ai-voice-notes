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
| Account entitlement | Unverified. No real key is configured and no live call was authorized. |
| Live call authorized / performed | No / No |
| Cost and uncertainty | Token creation has no separately published charge. Published Scribe v2 Realtime audio pricing is $0.39/hour. The local P12 admission reserves $0.0195 for the bounded 180-second session and records the actual session charge as `unknown` after minting, never as free. This is an app-side estimate, not a provider spending cap. |
| Status | Mock verified / live unverified |

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

No live smoke has been run for P13.
