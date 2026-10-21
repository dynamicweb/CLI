# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Setup

Pure ESM JavaScript (`"type": "module"`), no build step. Node.js `^20.19.0 || >=22.12.0` required.

`npm install -g .` makes `dw` available globally from source.

Tests run with `npm test` (`node --test`). There is also a QA smoke harness: `npm run qa:smoke`.

No linter is configured.

## Conventions

### File transfer

`files`, `folders` and `install` call `resolveTransfer()` ([bin/transfer/index.js](bin/transfer/index.js))
and branch per operation: `transfer.client` is the File Transfer API client
([bin/transfer/filetransfer.js](bin/transfer/filetransfer.js)), or `null` for the legacy code that stays in
the command files. Both must keep the same semantics and JSON output shapes — scripts must not be able
to tell them apart except via `meta.transfer`. Notably `--copy`/`--move <dest>` mean "into `dest`".
Verify behaviour changes against both: `DW_TRANSFER=legacy` and `DW_TRANSFER=filetransfer`.

The File-Transfer-only features (`dw files diff/sync/deploy/rollback/stat/usage` in
[bin/commands/files-subcommands.js](bin/commands/files-subcommands.js), `--changed-only`,
`--fail-on-remote-change`, `--verify`) are built on the plan in [bin/transfer/sync.js](bin/transfer/sync.js)
and the transfer state in [bin/transfer/state.js](bin/transfer/state.js), which lives in `~/.dwc` under
`transferState`. Tests that touch the state must point `HOME`/`USERPROFILE` at a temp folder before
importing CLI modules (see [test/sync.test.js](test/sync.test.js)); [test/helpers/fake-filetransfer.js](test/helpers/fake-filetransfer.js)
is an in-memory File Transfer API for tests.

### Output envelope

Every command handler builds its output object with `createOutput()` from [bin/output.js](bin/output.js)
and follows the same try/catch/finally shape: `output.fail(err)` and `process.exitCode = 1` on error,
`output.finish()` in `finally`. `finish()` prints the JSON envelope in JSON mode and the errors to
stderr otherwise, so throw `createCommandError()` rather than logging and returning, and never call
`process.exit()`. A successful run must write nothing to stderr — some callers treat stderr as failure.

Tests live in `test/`, not `bin/` (everything under `bin/` is published to npm).

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
