# Implementation Progress

This file records only phases accepted by the user. A phase is added here after
its deterministic checks pass, the manual acceptance steps are reported, and the
user explicitly accepts it.

| Phase | State | Evidence | Deferred live check |
|---|---|---|---|
| P01 | Implemented / accepted | Accepted by the user on 2026-10-25. `pnpm lint`, `pnpm typecheck`, `pnpm test` (10/10), and `pnpm build` passed; `pnpm dev` and built `pnpm start` served the Czech shell with `/api/health` returning 200 with the database and 503 without it; Next listened only on `127.0.0.1:3000`; the named database volume survived a container restart. The decision reviewer found two Low issues (explicit port 80 and build coupling to `DATABASE_URL`), both fixed and re-verified. | None |
| P02 | Implemented / accepted | Accepted by the user on 2026-10-25. `pnpm exec vitest run tests/notes/markdown.test.ts` passed 21/21, `pnpm test` passed 31/31, and `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed. The codec preserves unsupported Markdown as source-only, exposes no clickable unsafe links, and enforces 160/20,000 grapheme limits. The decision reviewer found three Low issues (obfuscated link schemes, flat `content_plain`, limit source of truth); all were fixed and re-verified with no remaining material findings. | None |
| P03 | Implemented / accepted | Accepted by the user on 2026-10-25. `pnpm db:migrate:test` and `pnpm test:db` each passed twice on the isolated `_test` database; `pnpm test` passed 40 tests with 12 DB integration tests skipped without the harness; `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed. Guard tests cover distinct dev/test targets, `_test` naming, loopback host, explicit port, and query overrides. FK/unique/version/cascade/vector/AI-usage constraints and a restart persistence marker were verified. The decision reviewer found three Low issues (Node importability, `getDb` test contract, stale README) and one P02 `pnpm dev`/`pnpm start` regression; all were fixed and re-verified. | Dev migration `pnpm db:migrate` was run by the user on 2026-10-25; the dev schema has the five tables, all three extensions, and zero notes. |
| P04 | Implemented / accepted | Accepted by the user on 2026-10-25. `pnpm exec vitest run tests/security/http.test.ts` passed 26/26, `pnpm test` passed 66 tests with 12 DB integration tests skipped, and `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed. The guard covers exact loopback Host, exact mutation Origin, JSON content type, Zod validation, rate limiting, and streaming 1 MiB/16 KiB/3 MiB ceilings with Czech 413 responses. The decision reviewer found and the implementation fixed five Low issues (loopback invariant, `maxBytes` validation, production origin coverage, non-hermetic tests, empty explicit origin); final verification had no material findings. | None |

States follow the execution contract in
[`AI_VOICE_NOTES_IMPLEMENTATION_PLAN.md`](../AI_VOICE_NOTES_IMPLEMENTATION_PLAN.md):
`Implemented / accepted`, `Mock verified / live unverified`, and `Blocked`.
