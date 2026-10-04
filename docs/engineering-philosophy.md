# How I think about software

These are the principles the cases in this repository have in common. They are
what I would want a reviewer to infer even without reading the code.

## 1. Model the invariant; make the illegal state impossible to persist

The most expensive bugs are not crashes — they are *silently wrong data*. A
ledger that is off by a cent, a subscription that bills twice, a status field
that contradicts the rows around it. My default move is to find the invariant
("cash equals customer balances plus vendor balances plus the platform's") and
enforce it at the boundary where writes happen, not in a report a day later.

> See [Case 01](../cases/01-invariant-enforcement/): the transaction refuses to
> commit unless the four sides balance, and the exception rolls the rows *and*
> the balances back together.

## 2. Independent verification beats confidence

An application that writes correct data is not the same as one that can *prove*
it still holds. I like to pair an enforcement mechanism with a separate audit
that reads the real datastore and checks the same invariants from the outside.
Enforcement stops new faults; the audit catches the old ones and the ones that
slipped through an exemption.

> See [Case 01](../cases/01-invariant-enforcement/), and the
> nightly reconciliation it replaces.

## 3. The contract is the source of truth

Types are documentation that a machine can check. Where I can, one schema
drives the API, the database, and the client — and a CI gate fails the build
when they drift apart. "It compiled" should mean "the edges agree."

> See [Case 06](../cases/06-type-safe-api/): a compiler-API script diffs the
> front end's validation schemas against the backend's OpenAPI document.

## 4. Concurrency is a design input, not an afterthought

Locks have an order. Webhooks arrive twice. Clients double-submit. A handler
that ignores this is a data-corruption generator with a friendly interface. I
write the lock ordering down, make operations idempotent, and treat
`afterCommit` as the moment side effects are allowed to fire.

> See [Case 02](../cases/02-billing-lifecycle/) and the checkout idempotency in
> [Case 01](../cases/01-invariant-enforcement/).

## 5. Fail loud, fail specific, fail once

A silent failure is worse than a crash. Errors name the thing that broke, the
amount involved, and the row. A programming fault (a money path is
unbalanced) must not masquerade as a user-facing validation error (the user
typed something wrong) — they are different audiences and different classes.

> See the `UnbalancedLedgerException` design note in
> [Case 01](../cases/01-invariant-enforcement/).

## 6. Internationalisation is layout *and* data

RTL is not a CSS flip. Signs, currency units, pluralisation, dates, and bidi
isolation all need to be right in the *data*, or the UI renders garbage. I
treat locale as a first-class concern down to the formatting functions.

> See [Case 05](../cases/05-reporting-engine/): money and time formatting with
> bidi isolates and locale-aware plurals.

## 7. Write the abstraction when the second use appears

I do not build frameworks for their own sake. But when the second and third
screen needs the same shape, I extract it — a resource definition, a report
registry, a storage interface — so the fourth one is configuration instead of
code.

> See [Case 04](../cases/04-declarative-admin/), [05](../cases/05-reporting-engine/),
> and the [dashboard components](../snippets/dashboard-component-system/).

## 8. Performance is a correctness property users feel

Layout thrashing, long tasks blocking input, N+1 queries inside a loop, an
unbounded cache — these are bugs even when the output is right. I batch reads,
yield to the main thread, bound caches, and let the reviewer see the reasoning
in comments.

> See the batching and LRU notes in
> [dashboard-component-system](../snippets/dashboard-component-system/).

## 9. Tests should describe behaviour, not mirror code

A test that restates the implementation protects nothing. I aim tests at the
invariant and the edge — the unbalanced event, the replay, the back-to-back
schedule, the oversell — so a broken path fails the test that names the
behaviour.

> Every case ends with a test excerpt, because the proof is the point.
