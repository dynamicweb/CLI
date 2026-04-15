# QA Smoke Harness

This folder contains a smoke-test harness for running the CLI against a real DynamicWeb solution.

It is designed to cover both:

- developer-style usage with a saved environment and `dw login --oauth`
- CI/CD-style usage with `--host --auth oauth`

The harness currently excludes `database` and `swift`.

## What It Covers

- config seeding in an isolated home directory
- `dw env --list`
- `dw env <environment>`
- `dw login --oauth --output json`
- base `dw` output after saved OAuth login
- `dw files` list, import, export, copy, move, and delete
- configured `dw query` smoke checks
- configured `dw command` smoke checks
- optional `dw install` if you provide a real `.dll` or `.nupkg`

## Safety Model

- The runner sets its own temporary `HOME`, so it does not touch the engineer's real `~/.dwc`.
- File tests use a unique remote folder under `remoteRoot/<runId>/...`.
- The runner attempts remote cleanup automatically unless you pass `--keep-remote`.

## Quick Start

Set the required credentials:

```sh
export DW_BASE_URL=https://your-solution.example.com
export DW_CLIENT_ID=your-client-id
export DW_CLIENT_SECRET=your-client-secret
```

Run with defaults:

```sh
npm run qa:smoke
```

Run with a custom profile:

```sh
npm run qa:smoke -- --profile qa/profile.json
```

Run only one mode:

```sh
npm run qa:smoke -- --mode saved-env
npm run qa:smoke -- --mode ephemeral
```

Artifacts are written to `qa/artifacts/<runId>/`.

## Configuration

The runner works without a profile if these environment variables are present:

- `DW_BASE_URL`
- `DW_CLIENT_ID`
- `DW_CLIENT_SECRET`

Defaults:

- `environmentName`: `qa-smoke`
- `clientIdEnv`: `DW_CLIENT_ID`
- `clientSecretEnv`: `DW_CLIENT_SECRET`
- `remoteRoot`: `QA/CLI`
- `commandTimeoutMs`: `120000`
- `queries`: `[]`
- `commands`: `[]`
- `install.enabled`: `false`

If `qa/profile.json` exists, it is loaded automatically. You can also pass `--profile <path>`.

To get started, copy the template and customize it:

```sh
cp qa/profile.example.json qa/profile.json
```

See [profile.example.json](profile.example.json) for the full list of supported fields.

## Profile Example

```json
{
  "environmentName": "qa-smoke",
  "baseUrl": "https://your-solution.example.com",
  "clientIdEnv": "DW_CLIENT_ID",
  "clientSecretEnv": "DW_CLIENT_SECRET",
  "remoteRoot": "QA/CLI",
  "commandTimeoutMs": 120000,
  "queries": [
    {
      "name": "YourReadOnlyQuery",
      "params": {
        "id": "123"
      }
    }
  ],
  "commands": [
    {
      "name": "YourSafeCommand",
      "body": {
        "model": {
          "id": "123"
        }
      }
    }
  ],
  "install": {
    "enabled": false,
    "filePath": "qa/fixtures/addins/YourAddin.nupkg",
    "queue": true
  }
}
```

## CI Example

The same command works in CI as long as the secret store exposes the required variables:

```sh
npm ci
npm run qa:smoke -- --mode all --profile qa/profile.json
```

To shorten or extend the per-command timeout in CI:

```sh
npm run qa:smoke -- --timeoutMs 180000
```

## Notes

- Prefer read-only queries and commands unless you have a dedicated QA tenant and fixture data.
- `dw command --list` is not included because the command is not implemented in the CLI yet.
- `dw install` is optional because it needs a real package and changes the target solution.
