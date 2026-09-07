# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Setup

Pure ESM JavaScript (`"type": "module"`), no build step. Node.js >=20.12.0 required.

`npm install -g .` makes `dw` available globally from source.

Tests run with `npm test` (`node --test`). There is also a QA smoke harness: `npm run qa:smoke`.

No linter is configured.

## Conventions

### Output envelope

Every command handler builds a local output object (`createXxxOutput(argv)`) and follows the same
try/catch/finally shape: `output.fail(err)` on error, `output.finish()` in `finally`.

All user-facing logging must go through `output.log()` rather than `console.log()` directly, so it is
suppressed when `--output json` is set. This is the easiest thing to get wrong — a stray `console.log`
corrupts the JSON envelope on stdout.

`--output json` is registered per command, not as a global flag. When it is set, interactive prompts
are skipped.

### Global CLI flags

All commands inherit: `--verbose/-v`, `--host`, `--protocol`, `--apiKey`, `--oauth`,
`--auth user|oauth`, `--clientId`, `--clientSecret`, `--clientIdEnv`, `--clientSecretEnv`.

## Gotchas

### Config file

Persistent config lives in `~/.dwc` (JSON), managed via `getConfig()` / `updateConfig()` /
`setupConfig()` in [bin/commands/config.js](bin/commands/config.js). `setupConfig()` runs at startup.

### Authentication

`shouldUseOAuth()` in [bin/commands/login.js](bin/commands/login.js) decides auth mode from flags, env
config, or CLI args. Both paths converge to `user.apiKey`.

OAuth access tokens are **not cached between commands** — every invocation fetches a fresh token from
`/Admin/OAuth/token`.

### HTTPS agent

The HTTPS agent in [bin/commands/env.js](bin/commands/env.js) sets `rejectUnauthorized: false`
intentionally, to support self-signed certificates in dev environments. Don't "fix" this.

### Git Bash on Windows

When `MSYSTEM` is set, the CLI warns about path conversion unless `MSYS_NO_PATHCONV=1`.
