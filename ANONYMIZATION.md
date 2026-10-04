# Anonymization & provenance

## What this repository is

A **synthetic, illustrative** portfolio. Every excerpt was written for this
repository to demonstrate an engineering pattern. None of it is copied from a
client, employer, or production system, and none of it can be traced back to
one.

## Rules I held myself to

1. **Patterns, not artifacts.** The *idea* (an invariant, a protocol, an
   algorithm) is real and mine. The *code* is a fresh implementation in a
   neutral domain.
2. **Rename everything.** Product names, people, brands, domains, table names,
   enum values, routes, and entity names were replaced with generic analogues
   (`Account`, `LedgerEntry`, `Order`, `Subscription`, `Resource`, `Report`,
   `Job`).
3. **Restructure the surface.** Class names, file layout, comments, and
   variable names differ from any source. Similar intent, not similar text.
4. **No real configuration.** No `.env` files, connection strings, API keys,
   OAuth clients, service-account files, webhook secrets, or bucket names. Any
   configuration shown is a placeholder.
5. **No personal data.** No real customers, users, phone numbers, addresses, or
   media. Seed and sample data is invented.
6. **No business identity.** No client product, market, pricing, or roadmap is
   identifiable from what is shown here.

## A note on secrets

If you are reviewing a private codebase of mine and find credentials committed
to it, that is a mistake, not a feature. Secrets belong in a secret manager and
should be rotated the moment they leak. This repository is checked to contain
none.

## License

The prose and code in this repository are provided for evaluation purposes.
`[Add a license here — e.g. MIT for the code, or "All rights reserved".]`
