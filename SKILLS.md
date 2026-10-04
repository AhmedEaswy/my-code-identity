# Skills matrix

A map from *capability* to the work that proves it. Every row links to the case
or snippet where that skill is exercised, and to the language it is shown in.
This is the fastest answer to *"can they do X in Y?"*

## Languages & frameworks

| Area | Technology | Where it is shown |
|---|---|---|
| Backend | PHP 8.3+, Laravel 12/13, Filament, Livewire, Eloquent | [01](cases/01-invariant-enforcement/), [02](cases/02-billing-lifecycle/), [availability](snippets/availability-engine/), [import](snippets/bulk-import/), [conversation](snippets/conversation-flow/) |
| Backend | TypeScript, Node, Bun, Hono, oRPC, Drizzle | [03](cases/03-agent-interface/), [06](cases/06-type-safe-api/), [realtime](snippets/realtime-gateway/), [storage](snippets/storage-router/), [rate-limit](snippets/lua-rate-limiter/) |
| Frontend | Svelte 5 (runes), SvelteKit, TanStack | [04](cases/04-declarative-admin/) |
| Frontend | Vue 3, Nuxt, Pinia, ECharts | [05](cases/05-reporting-engine/), [dashboard](snippets/dashboard-component-system/) |
| Frontend | React, TanStack Router/Query/Start | [03](cases/03-agent-interface/), [06](cases/06-type-safe-api/) |
| Mobile | Dart, Flutter, Riverpod, Drift (SQLite) | [07](cases/07-offline-first-mobile/), [backup](snippets/auto-backup-system/) |

## Capabilities

### Correctness & data integrity
| Skill | Evidence |
|---|---|
| Transactional invariants enforced at commit time | [01 Money integrity](cases/01-invariant-enforcement/) |
| Independent audit / reconciliation against the real datastore | [01 Money integrity](cases/01-invariant-enforcement/) |
| Idempotency under concurrency (`lockForUpdate`, unique keys) | [02 Billing lifecycle](cases/02-billing-lifecycle/) |
| Defensive migrations and safe schema evolution | [07 Offline-first mobile](cases/07-offline-first-mobile/) |

### Money & billing
| Skill | Evidence |
|---|---|
| Double-entry ledger modelling, holds, settlement | [01](cases/01-invariant-enforcement/) |
| Proration, upgrades/downgrades, grace periods | [02 Billing lifecycle](cases/02-billing-lifecycle/) |
| Payment webhooks: signature verification, replay handling | [02 Billing lifecycle](cases/02-billing-lifecycle/), [conversation-flow](snippets/conversation-flow/) |

### API & contracts
| Skill | Evidence |
|---|---|
| End-to-end type safety (one schema → API → DB → client) | [06 Type-safe APIs](cases/06-type-safe-api/) |
| CI contract-drift detection | [06 Type-safe APIs](cases/06-type-safe-api/) |
| Machine-readable APIs for AI agents (tool servers, discovery) | [03 Agent interface](cases/03-agent-interface/) |
| Fluent, composable query building | [06 Type-safe APIs](cases/06-type-safe-api/) |

### Frontend engineering
| Skill | Evidence |
|---|---|
| Declarative, config-driven UI generation | [04 Declarative admin](cases/04-declarative-admin/) |
| Server-state + URL state synchronisation | [04 Declarative admin](cases/04-declarative-admin/) |
| Registry-driven, extensible dashboards | [05](cases/05-reporting-engine/), [dashboard](snippets/dashboard-component-system/) |
| Charts as pure, testable functions | [05 Reporting engine](cases/05-reporting-engine/) |

### Internationalisation & accessibility
| Skill | Evidence |
|---|---|
| RTL/LTR correctness in layout *and* data formatting | [05 Reporting engine](cases/05-reporting-engine/) |
| Bidi isolation, pluralisation, locale-aware money | [05 Reporting engine](cases/05-reporting-engine/) |
| Arabic text normalisation for search | [07 Offline-first mobile](cases/07-offline-first-mobile/) |

### Distributed systems & resilience
| Skill | Evidence |
|---|---|
| Realtime reconnect protocols, sequence gaps | [realtime-gateway](snippets/realtime-gateway/) |
| Rate limiting with atomic Redis scripts + fallback | [lua-rate-limiter](snippets/lua-rate-limiter/) |
| Multi-provider storage with failover/replication | [storage-router](snippets/storage-router/) |
| Background jobs, cancellation, and recovery | [auto-backup-system](snippets/auto-backup-system/) |

### Domain modelling
| Skill | Evidence |
|---|---|
| Scheduling / availability as an algorithm | [availability-engine](snippets/availability-engine/) |
| Geospatial aggregation | [map-clusterer](snippets/map-clusterer/) |
| State machines for real-world conversations | [conversation-flow](snippets/conversation-flow/) |
| Bulk data ingestion with real-world messiness | [bulk-import](snippets/bulk-import/) |

### Engineering practice
| Skill | Evidence |
|---|---|
| Tests written around invariants, not implementation | [01](cases/01-invariant-enforcement/#testing), [02](cases/02-billing-lifecycle/#testing) |
| Custom tooling to encode team conventions | [04 Declarative admin](cases/04-declarative-admin/) |
| Performance: layout batching, long-task yielding, caching | [dashboard-component-system](snippets/dashboard-component-system/) |
