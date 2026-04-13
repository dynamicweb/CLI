# DynamicWeb CLI

DynamicWeb CLI is the command-line interface for working with DynamicWeb 10 solutions. It helps you manage environments, authenticate against the admin API, run queries and commands, move files in and out of a solution, install add-ins, export databases, and pull Swift solutions.

This branch now targets `2.0.0-beta.0`.

## Requirements

- Node.js `>=20.12.0`

## Install

Install from npm:

```sh
npm install -g @dynamicweb/cli
dw --help
```

Install from source:

```sh
npm install
npm install -g .
```

## What Changed

The `2.0` beta is a substantial overhaul focused on automation and modern authentication.

- Automation-first command output: `env`, `login`, `files`, `query`, `command`, and `install` now support `--output json` so scripts and pipelines can consume structured results instead of plain console logs.
- OAuth client credentials support: the CLI can now authenticate with OAuth 2.0 `client_credentials`, which makes headless and CI/CD usage much easier.
- Better environment handling: protocol, host, and auth details are stored more cleanly in `~/.dwc`, while one-off runs can still override host and credentials directly.
- Improved file workflows: file import, export, recursive sync, raw archive export, progress reporting, and source-type override flags make file operations more predictable.
- Clearer error reporting: commands can now return structured failures in JSON mode, which is much easier to handle in automation.

## Quick Start

View all available commands:

```sh
dw --help
dw <command> --help
```

Set up an environment and log in with a user:

```sh
dw env dev
dw login
dw          # shows current environment, user, protocol, and host
```

Run a query:

```sh
dw query HealthCheck
```

## Authentication

### Interactive User Login

The default login flow uses a DynamicWeb user account. The CLI logs in, creates an API key, and stores it in `~/.dwc`.

```sh
dw login
dw login <saved-user>
dw env <environment>
```

A user-authenticated config typically looks like this:

```json
{
  "env": {
    "dev": {
      "host": "localhost:6001",
      "protocol": "https",
      "users": {
        "DemoUser": {
          "apiKey": "<keyPrefix>.<key>"
        }
      },
      "current": {
        "user": "DemoUser",
        "authType": "user"
      }
    }
  },
  "current": {
    "env": "dev"
  }
}
```

### OAuth Client Credentials

For service accounts, automation, and headless usage, the CLI also supports OAuth 2.0 `client_credentials`.

Configure an environment for OAuth:

```sh
export DW_CLIENT_ID=my-client-id
export DW_CLIENT_SECRET=my-client-secret

dw login --oauth
```

Run a one-off command with OAuth flags instead of saved config:

```sh
dw query HealthCheck \
  --host your-solution.example.com \
  --auth oauth \
  --clientIdEnv DW_CLIENT_ID \
  --clientSecretEnv DW_CLIENT_SECRET \
  --output json
```

An OAuth-enabled environment in `~/.dwc` looks like this:

```json
{
  "env": {
    "dev": {
      "host": "localhost:6001",
      "protocol": "https",
      "auth": {
        "type": "oauth_client_credentials",
        "clientIdEnv": "DW_CLIENT_ID",
        "clientSecretEnv": "DW_CLIENT_SECRET"
      },
      "current": {
        "authType": "oauth_client_credentials"
      }
    }
  },
  "current": {
    "env": "dev"
  }
}
```

## Global Options

Most API-driven commands support these global options:

- `-v`, `--verbose`: enable verbose logging
- `--host`: use a host directly instead of the saved environment
- `--protocol`: set the protocol used with `--host` and default to `https`
- `--apiKey`: use an API key for environmentless execution
- `--auth`: override authentication mode with `user` or `oauth`
- `--clientId`: pass an OAuth client ID directly
- `--clientSecret`: pass an OAuth client secret directly
- `--clientIdEnv`: read the OAuth client ID from an environment variable
- `--clientSecretEnv`: read the OAuth client secret from an environment variable

## JSON Output for Automation

Commands that support `--output json` return a machine-readable envelope with `ok`, `status`, `data`, `errors`, and `meta` fields.

Examples:

```sh
dw env --list --output json
dw login --output json
dw query FileByName --name DefaultMail.html --output json
```

Representative output:

```json
{
  "ok": true,
  "command": "env",
  "operation": "list",
  "status": 200,
  "data": [
    {
      "environments": ["dev", "staging"]
    }
  ],
  "errors": [],
  "meta": {}
}
```

## Commands

### `dw env [env]`

Create, select, or inspect saved environments.

```sh
dw env dev
dw env --list
dw env --users
dw env --list --output json
```

Example JSON output:

```json
{
  "ok": true,
  "command": "env",
  "operation": "select",
  "status": 200,
  "data": [
    {
      "environment": "dev",
      "current": "dev"
    }
  ],
  "errors": [],
  "meta": {}
}
```

### `dw login [user]`

Log in interactively, configure OAuth, or switch between saved users for the current environment.

```sh
dw login
dw login DemoUser
dw login --oauth
dw login --output json
```

Example JSON output:

```json
{
  "ok": true,
  "command": "login",
  "operation": "oauth-login",
  "status": 200,
  "data": [
    {
      "environment": "dev",
      "authType": "oauth_client_credentials",
      "clientIdEnv": "DW_CLIENT_ID",
      "clientSecretEnv": "DW_CLIENT_SECRET",
      "expires": "2026-04-13T14:22:31Z"
    }
  ],
  "errors": [],
  "meta": {}
}
```

### `dw files [dirPath] [outPath]`

List, export, and import files from the DynamicWeb file archive.

Useful flags:

- `-l`, `--list`: list directories
- `-f`, `--includeFiles`: include files in listings
- `-e`, `--export`: export from the environment to disk
- `-i`, `--import`: import from disk to the environment
- `-r`, `--recursive`: recurse through subdirectories
- `--raw`: keep downloaded archives zipped
- `--dangerouslyIncludeLogsAndCache`: include log and cache folders during export, which is risky and usually not recommended
- `-af`, `--asFile`: force the source path to be treated as a file
- `-ad`, `--asDirectory`: force the source path to be treated as a directory

Examples:

```sh
dw files templates ./templates -fre
dw files system -lr
dw files templates/Translations.xml ./templates -e
dw files templates/templates.v1 ./templates -e -ad
dw files ./Files templates -i -r --output json
```

Example JSON output:

```json
{
  "ok": true,
  "command": "files",
  "operation": "import",
  "status": 200,
  "data": [
    {
      "type": "upload",
      "destinationPath": "templates",
      "files": [
        "/workspace/Files/Templates/DefaultMail.html"
      ],
      "response": {
        "message": "Upload completed"
      }
    }
  ],
  "errors": [],
  "meta": {
    "filesProcessed": 1,
    "chunks": 1
  }
}
```

### `dw query [query]`

Run admin API queries, inspect available parameters, or prompt for them interactively.

```sh
dw query FileByName -l
dw query FileByName --name DefaultMail.html --directorypath /Templates/Forms/Mail
dw query FileByName --interactive
dw query FileByName --name DefaultMail.html --output json
```

Example JSON output:

```json
{
  "ok": true,
  "command": "query",
  "operation": "run",
  "status": 200,
  "data": [
    {
      "name": "DefaultMail.html",
      "path": "/Templates/Forms/Mail/DefaultMail.html"
    }
  ],
  "errors": [],
  "meta": {
    "query": "FileByName"
  }
}
```

### `dw command [command]`

Run admin API commands and pass a JSON payload either inline or by file path.

```sh
dw command PageCopy --json '{ "model": { "SourcePageId": 1189, "DestinationParentPageId": 1129 } }'
dw command PageMove --json ./PageMove.json
dw command PageDelete --json '{ "id": "1383" }' --output json
```

Example JSON output:

```json
{
  "ok": true,
  "command": "command",
  "operation": "run",
  "status": 200,
  "data": [
    {
      "success": true,
      "message": "Command executed"
    }
  ],
  "errors": [],
  "meta": {
    "commandName": "PageDelete"
  }
}
```

`dw command --list` is reserved for command metadata, but it is not fully implemented yet.

### `dw install [filePath]`

Upload and install a `.dll` or `.nupkg` add-in into the current environment.

```sh
dw install ./bin/Release/net10.0/CustomProject.dll
dw install ./bin/Release/net10.0/CustomProject.dll --queue --output json
```

Example JSON output:

```json
{
  "ok": true,
  "command": "install",
  "operation": "queue",
  "status": 200,
  "data": [
    {
      "type": "upload",
      "destinationPath": "System/AddIns/Local",
      "files": [
        "/workspace/bin/Release/net10.0/CustomProject.dll"
      ],
      "response": {
        "message": "Upload completed"
      }
    },
    {
      "type": "install",
      "filePath": "/workspace/bin/Release/net10.0/CustomProject.dll",
      "filename": "CustomProject.dll",
      "queued": true,
      "response": {
        "success": true,
        "message": "Addin installed"
      }
    }
  ],
  "errors": [],
  "meta": {
    "filePath": "./bin/Release/net10.0/CustomProject.dll",
    "filesProcessed": 1,
    "chunks": 1
  }
}
```

### `dw config`

Write values directly into `~/.dwc` when you want to script config updates.

```sh
dw config --env.dev.host localhost:6001
```

### `dw database [path] --export`

Export the current environment database to a `.bacpac` file.

```sh
dw database ./backups --export
```

### `dw swift [outPath]`

Download the latest Swift release, a specific tag, or the nightly build.

```sh
dw swift -l
dw swift . --tag v2.3.0 --force
dw swift . --nightly --force
```

## CI/CD

For CI/CD, prefer OAuth client credentials and JSON output.

- Store `DW_CLIENT_ID` and `DW_CLIENT_SECRET` in your pipeline secret store.
- Use `--host` together with `--auth oauth` for ephemeral runners.
- Add `--output json` when you want reliable parsing in scripts.

Example:

```sh
dw query HealthCheck \
  --host your-solution.example.com \
  --auth oauth \
  --clientIdEnv DW_CLIENT_ID \
  --clientSecretEnv DW_CLIENT_SECRET \
  --output json
```

For longer-lived runners, you can configure a saved environment once with `dw login --oauth`. Full CI/CD guidance will be expanded in the documentation.

## Using Git Bash

Git Bash can rewrite relative paths in a way that interferes with CLI file operations. If you see the path-conversion warning, disable it for the session before running file commands:

```sh
export MSYS_NO_PATHCONV=1
dw files -iro ./ ./TestFolder --host <host> --apiKey <apiKey>
```

If you do not want to change that setting, prefer `./`-prefixed paths or use PowerShell or CMD instead.
