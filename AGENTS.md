# Repository Guidelines

## Project Structure

- `index.js` is the public plugin entry point and Cordis bundle integration.
- `internal/` contains the runtime kernel, session journal, transport handling, and typed value helpers.
- `test/` contains focused contract tests and acceptance harnesses.
- `scripts/` contains repeatable acceptance and A/B trajectory runners.
- `docs/` contains design and operational notes; `README.md` and `README.zh.md` are the user-facing guides.
- `assets/` contains README screenshots and artwork. `artifacts/`, `coverage/`, and runtime output are generated, not source.

## Build, Test, and Development

Install locked dependencies with `npm ci`. Run the complete quality gate with:

```sh
npm run check
```

This performs syntax checks and coverage-enforced tests. Model-backed checks are opt-in and consume quota:

```sh
npm run test:expensive
npm run test:ab
```

## Installing the Plugin

After `npm run check`, create a local package with `npm pack`, then install it into the profile that runs DSH:

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-ptc-plus-0.1.0.tgz
dsh --profile <profile> --dump-config
```

For DSH Desktop, open **Open DSH Terminal** from the tray and omit `--profile`; that terminal targets the active profile. Use an absolute tarball path, run `dsh --dump-config`, then restart Desktop. On Windows, `scripts\install-dev.cmd <profile>` provides the development snapshot flow.

## Coding Style and Naming

Use modern ESM JavaScript, two-space indentation, the surrounding file's semicolon style, and descriptive `camelCase` names. Use `PascalCase` for classes and `UPPER_SNAKE_CASE` for constants. Preserve typed values. Comments should explain constraints or recovery behavior. There is no separate formatter or linter; `npm run check` is authoritative.

`Code Mode` is a DSH-internal code name. Use `PTC mode` in English and `PTC 模式` in Chinese for all visible names, technical terminology, documentation, UI text, package metadata, and repository metadata. Retain upstream identifiers such as `CodeRuntime` only where the implementation contract requires their exact spelling.

## Testing Guidelines

Tests use `node:test`; files end in `.test.js`. Add focused coverage for affected behavior, then run `npm run check`. Thresholds are 100% lines/functions and 95% branches. Keep real-model tests opt-in and avoid treating one hard-coded trajectory as proof of correctness.

## Commits and Pull Requests

Use imperative Conventional Commit subjects such as `feat: ...`, `fix: ...`, or `docs: ...`. PRs should describe user-visible behavior, affected DSH/runtime versions, permission assumptions, and verification results. Link relevant issues, include screenshots for documentation or UI changes, and identify model-backed tests or platform limitations.

## Security and Configuration

`danger-full-access` is the primary supported experience, but the worker is not a malicious-code sandbox. DSH owns authorization and native tool policy. Do not add a second permission system or commit credentials, local session logs, model outputs, or files under ignored `artifacts/`.
