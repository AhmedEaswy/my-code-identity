# Reading guide

This repository is meant to be skimmed in minutes and read in depth when a
particular question matters. Use the path that matches your role.

## If you have 5 minutes

Read [Case 01](../cases/01-invariant-enforcement/) top to bottom. It shows the
whole shape of how I work: the problem, the invariant, the code, the tradeoffs,
and the test.

## If you have 20 minutes

| Your focus | Read, in order |
|---|---|
| Backend / money | [01 Money integrity](../cases/01-invariant-enforcement/) → [02 Billing lifecycle](../cases/02-billing-lifecycle/) → [availability engine](../snippets/availability-engine/) |
| APIs / platform | [06 Type-safe APIs](../cases/06-type-safe-api/) → [03 Agent interface](../cases/03-agent-interface/) → [realtime gateway](../snippets/realtime-gateway/) |
| Frontend / product | [04 Declarative admin](../cases/04-declarative-admin/) → [05 Reporting engine](../cases/05-reporting-engine/) → [dashboard components](../snippets/dashboard-component-system/) |
| Learning / product | [08 Entitlement routing](../cases/08-transient-entitlement-routing/) → [09 Course progression](../cases/09-course-progression-certificates/) |
| Mobile | [07 Offline-first mobile](../cases/07-offline-first-mobile/) → [auto-backup system](../snippets/auto-backup-system/) |
| Platform / infra | [realtime gateway](../snippets/realtime-gateway/) → [storage router](../snippets/storage-router/) → [rate limiter](../snippets/lua-rate-limiter/) |

## If you want to see range

The capability [skills matrix](../SKILLS.md) maps each skill to where it is
shown. The [capability index](../README.md#capability-index) lists everything
at a glance.

## How to read a case

Every case follows the same shape so you always know where to look:

1. **The problem** — context and stakes, in a neutral domain.
2. **The approach** — the design, usually with a diagram.
3. **The interesting part** — the code, with a note on what is non-obvious.
4. **Tradeoffs** — what I gave up and the alternatives I rejected.
5. **Testing** — the excerpt that proves the behaviour.
6. **What this demonstrates** — the skill, stated plainly.

## How to read a snippet

Snippets are one idea each: the non-obvious mechanism, the key excerpt, why it
is hard, and what it proves. They are shorter than cases and independent of one
another.

## Questions to hold while reading

- Does the invariant hold under failure, retries, and concurrency?
- Is the failure mode loud and specific, or silent?
- Would this scale, and what would break first?
- Is the abstraction earning its place?

If any answer is unsatisfying, that is exactly the conversation I want to have.
