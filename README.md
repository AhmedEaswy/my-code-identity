# Code Identity

> A curated portfolio of the engineering patterns, decisions, and code style I
> work by — expressed as annotated, runnable-in-the-head excerpts across the
> stacks I use daily.

I build full-stack products: money-handling backends, type-safe APIs, admin
and analytics front ends, and offline-first mobile apps. This repository is my
answer to the request *"show us a code sample."* Instead of one unreadable dump
of a private product, it is a set of **self-contained case studies** — each one
a single hard problem, the reasoning behind my solution, the code, and the test
that proves it.

**Maintainer:** `[Ahmed Easwy]` · `[elesawy325@gmail.com]` · `[https://github.com/AhmedEaswy / https://www.linkedin.com/in/ahmed-eleaswy]`
<!-- TODO: replace the placeholder identity above before publishing. -->

---

## Read this first

- **Everything here is synthetic.** No client code, no proprietary business
  logic, and no production identifiers are reproduced. The patterns are real;
  the domain is a neutral analogue. See [`ANONYMIZATION.md`](ANONYMIZATION.md).
- **It is read-only by design.** The goal is to be read, not installed. Each
  case names the files worth your time.
- **No secrets.** This repo contains no keys, tokens, credentials, connection
  strings, or personal data. Samples use placeholder config only.

## The five-minute path

If you have five minutes, read these two and stop:

1. [**Case 01 — Money integrity**](cases/01-invariant-enforcement/) — a ledger
   that refuses to commit an unbalanced money movement, then independently
   audits the whole ledger against six invariants.
2. [**Case 06 — Type-safe APIs**](cases/06-type-safe-api/) — one schema drives
   the API, the database, the client types, and a CI check that fails when the
   front end drifts from the backend contract.

Everything else is here when you want depth: the [capability index](#capability-index)
below, the [skills matrix](SKILLS.md), and [how I think](docs/engineering-philosophy.md).

## How to navigate by role

| If you are… | Start with |
|---|---|
| Backend / platform | [01 Money integrity](cases/01-invariant-enforcement/) · [02 Billing lifecycle](cases/02-billing-lifecycle/) · [availability engine](snippets/availability-engine/) |
| Full-stack / API | [06 Type-safe APIs](cases/06-type-safe-api/) · [03 Agent interface](cases/03-agent-interface/) |
| Frontend | [04 Declarative admin](cases/04-declarative-admin/) · [05 Reporting engine](cases/05-reporting-engine/) · [dashboard components](snippets/dashboard-component-system/) |
| Product / learning | [08 Entitlement routing](cases/08-transient-entitlement-routing/) · [09 Course progression](cases/09-course-progression-certificates/) |
| Mobile | [07 Offline-first mobile](cases/07-offline-first-mobile/) · [auto-backup system](snippets/auto-backup-system/) |
| Distributed systems | [realtime gateway](snippets/realtime-gateway/) · [storage router](snippets/storage-router/) · [rate limiter](snippets/lua-rate-limiter/) |

A longer guide lives in [`docs/reading-guide.md`](docs/reading-guide.md).

## Capability index

### Cases — a problem, the reasoning, the code, the proof

| # | Case | The hard part | Stack |
|---|------|---------------|-------|
| 01 | [Money integrity](cases/01-invariant-enforcement/) | A ledger that cannot persist an unbalanced transaction, plus a verifier that reads the real ledger | PHP · Laravel |
| 02 | [Billing lifecycle](cases/02-billing-lifecycle/) | Proration, plan changes, grace periods, and an idempotent, signature-verified payment webhook | PHP · Laravel |
| 03 | [Agent interface](cases/03-agent-interface/) | Exposing an app to AI agents: a tool server, discovery documents, and content negotiation | TypeScript · Node |
| 04 | [Declarative admin](cases/04-declarative-admin/) | One resource declaration that generates list/form/show, filters, and URL-synced tables | Svelte 5 · TypeScript |
| 05 | [Reporting engine](cases/05-reporting-engine/) | Registry-driven reports with pure chart builders and correct bidirectional Arabic formatting | Vue 3 · Nuxt |
| 06 | [Type-safe APIs](cases/06-type-safe-api/) | One schema end-to-end, and a CI gate that fails on contract drift | Bun · TypeScript |
| 07 | [Offline-first mobile](cases/07-offline-first-mobile/) | Safe multi-step local migrations, analytic SQL, and hardware printing | Dart · Flutter |
| 08 | [Transient entitlement routing](cases/08-transient-entitlement-routing/) | Two axes — who is looking and when it is — decide what a live-session viewer may see, enforced once in routing | Vue 3 · Nuxt |
| 09 | [Course progression & certificates](cases/09-course-progression-certificates/) | Normalizing an evolving course API, gating progress through quizzes, and issuing a verifiable certificate | Vue 3 · Nuxt |

### Snippets — one deep idea each

| Snippet | The idea | Stack |
|---|---|---|
| [auto-backup-system](snippets/auto-backup-system/) | Cancellable background backup and a restore that swaps the DB safely | Dart · Flutter |
| [dashboard-component-system](snippets/dashboard-component-system/) | Registry-driven pages, a self-describing server table, cached report reads | Vue · Nuxt · TypeScript |
| [realtime-gateway](snippets/realtime-gateway/) | A reconnect protocol that never patches stale state | TypeScript · Node |
| [lua-rate-limiter](snippets/lua-rate-limiter/) | Atomic fixed-window limits with a transparent in-memory fallback | TypeScript · Redis |
| [storage-router](snippets/storage-router/) | Priority routing, replication, and failover across object stores | TypeScript · Node |
| [availability-engine](snippets/availability-engine/) | Turning messy schedules into bookable slots | PHP · Laravel |
| [map-clusterer](snippets/map-clusterer/) | Zoom-aware grid clustering with centroid merging | PHP |
| [bulk-import](snippets/bulk-import/) | A forgiving spreadsheet importer with dry-run and per-row transactions | PHP · Laravel |
| [conversation-flow](snippets/conversation-flow/) | A verified, replay-safe conversational state machine | PHP · Laravel |

## What this demonstrates

Breadth *and* depth. The same instincts show up in every case: **model the
invariant, make illegal states unrepresentable, prove it with a test, and make
the failure mode loud rather than silent.** Language and framework are the
surface — [read the philosophy](docs/engineering-philosophy.md) for the through-line.

## Goal

I am applying for roles where correctness under real-world pressure matters:
money, contracts, data integrity, and the boring-but-critical glue that keeps a
product trustworthy. If this repository raises a question, I would be glad to
walk through any case in more depth — `[elesawy325@gmail.com]`.

---

*This repository is illustrative. It is not affiliated with, and contains no
code from, any client or employer.*
