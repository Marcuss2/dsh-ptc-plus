# ab-node-project-v1

A small, stable, zero-dependency Node.js project used as the ordinary-task
A/B benchmark fixture. It contains source modules, internal utilities,
documentation, test files, and JSON data files.

## Requirements

- Node.js 20 or newer.
- No third-party dependencies and no install step.
- Only Node.js built-ins and `node:test`.

## Commands

- Run the deterministic checks with `npm run check`.
- Run tests directly with `npm test`.

## Layout

- `src/` contains the public application-style modules.
- `internal/` contains implementation utilities.
- `test/` contains `node:test` files.
- `docs/` contains project notes.
- `data/` contains JSON fixtures used by the source modules.
