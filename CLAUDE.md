# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@dynamicweb/cli` is a Node.js CLI (`dw`) for managing DynamicWeb 10 CMS solutions. It handles authentication, file archive operations, Admin API queries/commands, add-in installation, database exports, and Swift release downloads. The binary is registered as `dw`.

## Development Setup

```bash
npm install
npm install -g .   # Makes 'dw' available globally from source
dw --help
```

No build step — pure ESM JavaScript (`"type": "module"`), Node.js >=20.12.0 required.

No test framework or linting is configured yet.

## Code Architecture

### Entry Point

[bin/index.js](bin/index.js) bootstraps yargs with global options and registers all commands. `setupConfig()` runs at startup to initialize `~/.dwc`.

### Command Structure

All commands live in [bin/commands/](bin/commands/). Each exports a `*Command()` function returning a yargs command object with `command`, `describe`, `builder`, and `handler` properties.

Every command handler follows the same pattern:

```js
handler: async (argv) => {
    const output = createXxxOutput(argv);   // local output envelope
    try {
        let env = await setupEnv(argv, output);   // from env.js
        let user = await setupUser(argv, env);    // from login.js
        // ... API calls with node-fetch
    } catch (err) {
        output.fail(err);
        process.exitCode = 1;
    } finally {
        output.finish();   // prints JSON if --output json
    }
}
```

### Key Shared Modules

- **[bin/commands/env.js](bin/commands/env.js)** — `setupEnv()`, `getAgent()` (keep-alive HTTP/HTTPS agents), `createCommandError()`, `isJsonOutput()`, `interactiveEnv()`
- **[bin/commands/login.js](bin/commands/login.js)** — `setupUser()`, OAuth token fetch, interactive login, API key creation
- **[bin/commands/config.js](bin/commands/config.js)** — `getConfig()`, `updateConfig()`, `setupConfig()` — manages `~/.dwc` JSON file
- **[bin/utils.js](bin/utils.js)** — `createThrottledStatusUpdater()` (500ms throttle), `formatBytes()`, `formatElapsed()`
- **[bin/downloader.js](bin/downloader.js)** — streams HTTP responses with a progress callback
- **[bin/extractor.js](bin/extractor.js)** — ZIP extraction with progress callback

### Output Envelope

Each command creates a local output object (see `createEnvOutput` in [bin/commands/env.js:256](bin/commands/env.js#L256) as the canonical example):

```js
{ ok, command, operation, status, data: [], errors: [], meta: {} }
```

- `output.addData(entry)` — push to `data[]`
- `output.log(...args)` — console.log only when not in JSON mode
- `output.fail(err)` — sets `ok: false`, pushes to `errors[]`
- `output.finish()` — prints `JSON.stringify(response)` if `--output json`

### Authentication

`shouldUseOAuth()` in [bin/commands/login.js](bin/commands/login.js) decides auth mode from flags, env config, or CLI args. Both paths converge to `user.apiKey` for API calls.

- **User auth**: interactive login → creates a DW API key stored in `~/.dwc`
- **OAuth**: fetches access token from `/Admin/OAuth/token`; token not cached between commands

### Config File (`~/.dwc`)

```json
{
  "env": {
    "<name>": {
      "host": "localhost:6001",
      "protocol": "https",
      "users": { "<username>": { "apiKey": "prefix.key" } },
      "auth": { "type": "oauth_client_credentials", "clientIdEnv": "...", "clientSecretEnv": "..." },
      "current": { "user": "...", "authType": "user|oauth_client_credentials" }
    }
  },
  "current": { "env": "<name>" }
}
```

### Global CLI Flags

All commands inherit: `--verbose/-v`, `--host`, `--protocol`, `--apiKey`, `--auth user|oauth`, `--clientId`, `--clientSecret`, `--clientIdEnv`, `--clientSecretEnv`, `--output json`.

When `--output json` is set, interactive prompts are skipped and the structured envelope is printed to stdout. All other logging must go through `output.log()` (not `console.log()` directly) so it is suppressed in JSON mode.

### HTTPS Agent

The HTTPS agent in [bin/commands/env.js:13](bin/commands/env.js#L13) sets `rejectUnauthorized: false` intentionally to support self-signed certificates in dev environments.

### Git Bash Warning

On Windows Git Bash (`MSYSTEM` env var set), the CLI warns about path conversion unless `MSYS_NO_PATHCONV=1`.
