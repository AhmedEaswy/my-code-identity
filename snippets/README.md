# Snippets

One idea each. These are the mechanisms I reach for when a problem is small in
surface area but hard in substance: a protocol corner, an algorithm, a
concurrency trap. Each folder has a short README and the code that carries the
weight.

Start with any of them; they are independent. If you are not sure where to
begin, the [realtime gateway](realtime-gateway/) and the
[auto-backup system](auto-backup-system/) show the widest range.

| Snippet | The idea in one line | Stack |
|---|---|---|
| [auto-backup-system](auto-backup-system/) | Cancellable background backup, and a restore that verifies and swaps the database safely | Dart · Flutter |
| [dashboard-component-system](dashboard-component-system/) | Registry-driven pages, a self-describing server table, and cached report reads | Vue · Nuxt · TypeScript |
| [realtime-gateway](realtime-gateway/) | A reconnect protocol that detects dropped frames instead of patching stale state | TypeScript · Node |
| [lua-rate-limiter](lua-rate-limiter/) | Atomic fixed-window limits in one Redis round trip, with an in-memory fallback | TypeScript · Redis |
| [storage-router](storage-router/) | Priority routing, replication, and failover across object stores | TypeScript · Node |
| [availability-engine](availability-engine/) | Turning messy schedules into a correct, bookable slot grid | PHP · Laravel |
| [map-clusterer](map-clusterer/) | Zoom-aware grid clustering with centroid merging | PHP |
| [bulk-import](bulk-import/) | A forgiving spreadsheet importer with dry-run and per-row transactions | PHP · Laravel |
| [conversation-flow](conversation-flow/) | A verified, replay-safe conversational state machine | PHP · Laravel |

## How to read a snippet

1. **The problem** — the situation and why the naive answer fails.
2. **The mechanism** — the approach, usually with a diagram.
3. **The interesting part** — the code, and the non-obvious bit.
4. **Tradeoffs** — what it costs, and the alternatives.
5. **What this demonstrates** — the skill, stated plainly.

Back to the [main index](../README.md), the [skills matrix](../SKILLS.md), or
[how I think](../docs/engineering-philosophy.md).
