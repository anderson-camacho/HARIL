# Store and runtime invariants: test index

Each invariant of the store and the runtime maps to the tests that check it. Titles carry the id as a `[INV-nn]`
prefix, so `vitest -t "INV-01"` runs one invariant. Paths are relative to the repository root.

| ID | Invariant | Tests | Status |
|---|---|---|---|
| INV-01 | One claim winner across processes, CLI admin writes included | `integrations/state-sqlite/tests/concurrency.test.ts` "[INV-01] eight claimers and one admin writer"; `task-run.test.ts` "[INV-01] is atomic across connections" | Covered (multi-process) |
| INV-02 | Independent tasks run concurrently under the budget | none | Deferred: the MVP runtime is sequential by design (`apps/haril/src/runtime/run-loop.ts`, M1-D6); concurrent executors are M4 |
| INV-03 | The budget is never overdrawn under concurrency | `concurrency.test.ts` "[INV-03] six processes reserving against one budget" | Covered (multi-process) |
| INV-04 | A task is not claimed before its dependencies complete | `task-run.test.ts` "[INV-04] ..."; `promote-chain.test.ts` "[INV-04] ..." | Covered |
| INV-05 | No cycles in a plan | `queue-apply.test.ts` "[INV-05] re-validates a plan with a cycle" | Covered |
| INV-06 | A runtime restart loses no task and runs none twice | `apps/haril/tests/crash/crash-points.test.ts` "[INV-06] ..." (CP1, CP3); `runtime-reconcile.test.ts` "[INV-06] ..." | Covered (real `kill -9`) |
| INV-07 | Fencing: a stale worker cannot confirm results | `runtime-lease.test.ts` "[INV-07] fences ..."; `queue-apply.test.ts` "[INV-07] is fenced ..."; `task-run.test.ts` "[INV-07] refuses ..."; `concurrency.test.ts` "[INV-15] ..." (stale epoch) | Covered |
| INV-08 | Idempotency: a repeated command adds no rows and no events | `store.contract.test.ts` "[INV-08] ..."; `budgets.test.ts` "[INV-08] ..." | Covered |
| INV-09 | Durability under `kill -9` | `durability.test.ts` "[INV-09] kill -9 during committed writes ..." | Covered |
| INV-10 | Every state change has its event in the same transaction | `store.contract.test.ts` "[INV-10] appends events ..."; `events-metrics.test.ts` "[INV-10] is recomputable ..." | Covered |
| INV-11 | Consistent backup under writes | `backup.test.ts` "[INV-11] ..." | Covered |
| INV-12 | Atomic, concurrent-safe, non-destructive migrations | `store.file.test.ts` "[INV-12] ..."; `crash-points.test.ts` "[INV-12] ..." (CP8); `open-busy.test.ts` | Covered |
| INV-13 | Forbidden data locations are refused before any file is created | `location.test.ts` "[INV-13] ..." | Covered |
| INV-14 | The WAL stays bounded with a long reader | `durability.test.ts` "[INV-14] ..." | Covered |
| INV-15 | A clock jump or suspension causes no double claim | `concurrency.test.ts` "[INV-15] a runtime whose clock is ten minutes fast ..."; `runtime-reconcile.test.ts` "[INV-15] takes over an expired lease ..." | Covered; the expiry check decides before the pid check, so a fast clock takes over a live holder and fencing stops the stale one |
| INV-16 | SQLite version gate | `gates.test.ts` "[INV-16] sqlite gate ..."; `store.file.test.ts` "[INV-16] ..." | Covered |
| INV-17 | Coexistence with Engram | none | Deferred to M4 (needs Engram) |
| INV-18 | The event loop is not blocked for more than 100 ms (p99) | `apps/haril/tests/event-loop.test.ts` "[INV-18] ..." | Covered (MC-D5); measured p99 about 18 to 20 ms with 60 simulated tasks |
| INV-19 | Node versions out of range abort at store open | `node-range.test.ts` "[INV-19] ...", `gates.test.ts` | Covered: 23.x, 22.x, 20.x, 25.x and 26.0 to 26.7 are refused before any file is created. Kept deviation: a 24.x below the range (24.19.x, the team host) opens with a warning (M1-D1, MC-D6). |
| INV-20 | Pi resumes a session on Windows | none | Deferred to M2 (needs Pi) |

Not an invariant but covered in the same suite: a busy open waits for a short lock, and an open that must migrate retries
with a bounded backoff (`open-busy.test.ts`; ARCH 8.4, ST-01).
