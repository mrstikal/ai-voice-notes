# Quality report

Measured locally on 2026-10-28/29. Only rows with a real command and output are
filled; unrun checks are marked explicitly. A high score on 20 distinctive
fixture queries is not a general quality threshold.

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
