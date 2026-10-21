# DynamicWeb CLI

A CLI for managing DynamicWeb 10 solutions — environments, authentication, queries, commands, files, add-ins, databases, and Swift releases.

| Tool | Best for |
|------|----------|
| **DW CLI** (this repo) | Automation, CI/CD pipelines, scripting, headless environments |
| **[DW Desktop](https://github.com/dynamicweb/dw-desktop)** | Day-to-day developer workflows with a GUI |

This branch targets the `2.0` preview.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`

## Install

Install the preview from npm:

```sh
npm install -g @dynamicweb/cli@preview
dw --help
```

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

The `2.0` preview is a substantial overhaul focused on automation and modern authentication.

- Automation-first command output: `env`, `login`, `files`, `folders`, `query`, `command`, `install`, `database`, and `swift` now support `--output json` so scripts and pipelines can consume structured results instead of plain console logs.
- OAuth client credentials support: the CLI can now authenticate with OAuth 2.0 `client_credentials`, which makes headless and CI/CD usage much easier.
- Better environment handling: protocol, host, and auth details are stored more cleanly in `~/.dwc`, while one-off runs can still override host and credentials directly.
- Improved file workflows: file import, export, recursive sync, raw archive export, progress reporting, and source-type override flags make file operations more predictable.
- Clearer error reporting: every command exits with code `1` on failure. In JSON mode the failure is in the envelope's `errors` array; otherwise it is printed to stderr. Successful runs write nothing to stderr, so scripts that treat stderr output as failure work as expected.

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
- `--oauth`: use OAuth client credentials authentication (shorthand for `--auth oauth`)
- `--auth`: override authentication mode with `user` or `oauth`
- `--clientId`: pass an OAuth client ID directly
- `--clientSecret`: pass an OAuth client secret directly
- `--clientIdEnv`: read the OAuth client ID from an environment variable
- `--clientSecretEnv`: read the OAuth client secret from an environment variable
- `--transfer`: how `files`, `folders` and `install` move files — `auto` (default), `filetransfer` or `legacy`

## File Transfer

On solutions that include the File Transfer API (`/Admin/Api/FileTransfer`), `files`, `folders` and `install` use it automatically: uploads go in checksum-verified chunks and are swapped in atomically, exports are streamed file by file, and transient failures are retried safely. Older solutions keep using the original endpoints. Commands, options and JSON output are the same either way; `meta.transfer` in the JSON output says which was used.

Force one or the other with `--transfer filetransfer|legacy`, the `DW_TRANSFER` environment variable, or a saved setting (`dw config --env.dev.transfer legacy`). A forced `filetransfer` fails instead of falling back when the solution does not provide the API. `--raw` exports (keep the zip) only exist in the legacy transfer.

With the File Transfer API, `dw files` can also sync and deploy:

```sh
dw files diff ./dist Templates/Designs/MyDesign                 # what differs, changes nothing
dw files sync ./dist Templates/Designs/MyDesign --delete        # upload only changes, remove what dist lacks
dw files deploy ./dist Templates/Designs/MyDesign --keep-backup # swap in the new version in one step
dw files rollback Templates/Designs/MyDesign                    # put the previous version back
dw files stat Templates/Designs/MyDesign/app.js --checksum
dw files usage Templates/Designs
```

`--fail-on-remote-change` (on `sync`, `deploy` and `--import`) stops before changing anything if files were edited on the server since the last sync. `--changed-only` skips unchanged files on `--import`/`--export`, and `--verify` checks exported files against their SHA-256 on the server. What the CLI knows about synced files is kept in `~/.dwc` under `transferState`. See [cliv2-documentation.md](cliv2-documentation.md#sync-deploy-and-inspect) for details.

## JSON Output for Automation

Commands that support `--output json` return a machine-readable envelope with `ok`, `status`, `data`, `errors`, and `meta` fields. `status` is `0` on success; on failure it is the HTTP status code returned by the DynamicWeb API, or `1` when the failure happened in the CLI. The process exit code is `1` on any failure. Interactive prompts are never shown in JSON mode.

Examples:

```sh
dw env --list --output json
dw login --oauth --output json
dw query FileByName --name DefaultMail.html --output json
```

Representative output:

```json
{
  "ok": true,
  "command": "env",
  "operation": "list",
  "status": 0,
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
dw env dev --host https://dev.example.com   # create or update without prompting
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
  "status": 0,
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
  "status": 0,
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

List, export, import, delete, copy, and move files and directories in the DynamicWeb file archive.

Useful flags:

- `-l`, `--list`: list directories
- `-f`, `--includeFiles`: include files in listings
- `-e`, `--export`: export from the environment to disk
- `-i`, `--import`: import from disk to the environment
- `-d`, `--delete`: delete a file or directory
- `--empty`: used with `--delete`, empties a directory instead of removing it
- `--copy <dest>`: copy a file or directory to a destination path
- `--move <dest>`: move a file or directory to a destination path
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
dw files /Templates/OldDesign --delete
dw files /Templates/MyDesign --copy /Templates/MyDesign-backup
dw files /Templates/OldName --move /Templates/Archive
```

### `dw folders <folderPath>`

Create, rename, move, delete, copy, and export directories. Where `dw files` detects file vs. directory from the path extension, `dw folders` always treats the path as a directory — no ambiguity.

Useful flags:

- `-c`, `--create`: create the directory at `<folderPath>`
- `--rename <newName>`: rename the directory to a new name (keeps it in the same parent)
- `-m`, `--move <dest>`: move the directory to the given destination path
- `-d`, `--delete`: delete the directory
- `--empty`: used with `--delete`, empties the directory instead of removing it
- `--copy <dest>`: copy the directory to the given destination path
- `-e`, `--export`: export the directory to disk
- `-o`, `--outPath`: local destination for `--export` (defaults to `.`)
- `--raw`: keep exported archives zipped instead of extracting

Examples:

```sh
dw folders /Files/NewFolder --create
dw folders /Files/OldName --rename NewName
dw folders /Files/MyFolder --move /Files/Archive
dw folders /Files/MyFolder --delete
dw folders /Files/MyFolder --delete --empty
dw folders /Files/MyFolder --copy /Files/MyFolder-backup
dw folders /Files/MyFolder --export --outPath ./local
```

Example JSON output:

```json
{
  "ok": true,
  "command": "files",
  "operation": "import",
  "status": 0,
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
  "status": 0,
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
  "status": 0,
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
  "status": 0,
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
dw database ./backups --export --output json
```

### `dw swift [outPath]`

Download the latest Swift release, a specific tag, or the nightly build.

```sh
dw swift -l
dw swift . --tag v2.3.0 --force
dw swift . --nightly --force
dw swift -l --output json
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

For longer-lived runners, configure a saved environment once without any prompts:

```sh
dw env production --host https://your-solution.example.com
dw login --oauth --output json
```

## QA Smoke Testing

This repository now includes a reusable QA harness in [qa/README.md](qa/README.md). It runs the CLI against a real DynamicWeb solution using OAuth client credentials, keeps its own isolated `HOME`, and can exercise both:

- saved-environment developer flow
- ephemeral CI/CD-style flow with `--host --auth oauth`

The harness currently excludes `database` and `swift`.

## Using Git Bash

Git Bash can rewrite relative paths in a way that interferes with CLI file operations. If you see the path-conversion warning, disable it for the session before running file commands:

```sh
export MSYS_NO_PATHCONV=1
dw files -iro ./ ./TestFolder --host <host> --apiKey <apiKey>
```

If you do not want to change that setting, prefer `./`-prefixed paths or use PowerShell or CMD instead.
