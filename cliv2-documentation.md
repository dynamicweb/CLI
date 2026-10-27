---
title: DynamicWeb CLI
_description: Automate and manage DynamicWeb 10 solutions from the command line.
uid: cli
---

# DynamicWeb CLI

The DynamicWeb CLI is a command-line tool for automating and managing DynamicWeb 10 solutions. It connects to the [Management API](xref:dw10-webapis#management-api) to run queries and commands, move files in and out of a solution, install add-ins, export databases, and pull Swift releases.

The CLI is designed to be composable. Every API-driven command supports structured JSON output, and authentication can be fully configured through environment variables and flags -- no interactive prompts required. This makes the CLI equally useful for one-off tasks at a developer's terminal and for scripted steps in a CI/CD pipeline.

If you need to do something once, interactively, the DynamicWeb backend UI is usually faster. If you need to do it repeatedly, across environments, or as part of a build -- that is what the CLI is for.

## What's new in v2

Version 2 is an automation-first overhaul. The headline changes:

- **OAuth client credentials** -- the CLI can now authenticate with an OAuth 2.0 client ID and secret, removing the need for an interactive login in CI/CD pipelines and service-account scenarios. See [Authentication](#authentication) for setup details.
- **Structured JSON output** -- every API-driven command (`env`, `login`, `files`, `folders`, `query`, `command`, `install`, `database`) and `swift` support `--output json`, returning a consistent envelope with `ok`, `status`, `data`, `errors`, and `meta` fields. Interactive prompts are suppressed in JSON mode so output is safe to pipe. See [Automation and JSON output](#automation-and-json-output).
- **File delete, copy, and move** -- the `files` command can now delete, copy, and move files and directories on the environment in addition to listing, exporting, and importing. See the [files command reference](#files).
- **Folder management** -- the new `folders` command creates, renames, moves, deletes, copies, and exports directories. It always treats the path as a directory, removing the file-extension ambiguity that `dw files` has. See the [folders command reference](#folders).
- **Consistent error model** -- every command exits with code `1` on failure and reports the error in the `errors` array (JSON mode) or on stderr. Successful runs write nothing to stderr. Scripts can rely on the exit code and the `errors` array for programmatic error handling.

### Migrating from v1

| v1 | v2 | Notes |
|----|-----|-------|
| `--json` (global output flag) | `--output json` | The global `--json` output flag still works but is deprecated. Note: `dw command --json` is a separate, active flag for passing a JSON payload to a command and is **not** deprecated. |
| `--iamstupid` | `--dangerouslyIncludeLogsAndCache` | `--iamstupid` still works but is deprecated |
| `--host` (required `--apiKey`) | `--host` (works with `--apiKey` or OAuth) | OAuth credentials are now accepted alongside `--host` |
| Errors printed to stdout | Errors in `errors` array (JSON) or thrown (non-JSON) | Scripts should check exit codes and/or `ok` field |

No changes are required for existing scripts that do not use `--json` or `--iamstupid`. Both deprecated flags continue to work and emit a warning.

## Installation

The CLI requires **Node.js 20.19.0 or later** (on Node.js 22, 22.12.0 or later).

Install from npm:

```sh
npm install -g @dynamicweb/cli
dw --help
```

To install from source (for contributors):

```sh
git clone https://github.com/dynamicweb/CLI.git
cd CLI
npm install
npm install -g .
```

## Authentication

The CLI supports two authentication modes. Which one you use depends on whether a human is present.

| Mode | Mechanism | Best for |
|------|-----------|----------|
| **User login** | Interactive prompt, API key stored in `~/.dwc` | Local development, exploration |
| **OAuth client credentials** | Client ID + secret via environment variables | CI/CD, service accounts, headless automation |

Both modes can be overridden on any command with `--apiKey` for direct, environmentless execution using a [manually generated API key](xref:settings-apikeys).

### Interactive user login

The default login flow creates a DynamicWeb API key for a backend user and stores it in `~/.dwc`.

```sh
dw env dev                   # create or switch to an environment
dw login                     # interactive prompt for username and password
dw login DemoUser            # switch to a previously saved user
```

The resulting `~/.dwc` config looks like this:

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

> [!WARNING]
> The interactive login prompt is not verified to work against all DynamicWeb authentication setups.
>
> If `dw login` does not work in your environment, [generate an API key manually](xref:settings-apikeys) and use `--apiKey <key>` with `--host` and `--protocol` instead.

### OAuth client credentials

For service accounts, automation, and any scenario where no human is available to enter a password, the CLI supports [OAuth 2.0 client credentials](xref:oauth). This section covers how to use OAuth with the CLI -- see the linked article for how to set up an OAuth client in DynamicWeb.

**Configure a saved environment for OAuth:**

```sh
export DW_CLIENT_ID=my-client-id
export DW_CLIENT_SECRET=my-client-secret

dw login --oauth
```

This stores the environment variable names (not the secrets themselves) in `~/.dwc`:

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

**Run a one-off command without saved config:**

```sh
dw query HealthCheck \
  --host your-solution.example.com \
  --auth oauth \
  --clientIdEnv DW_CLIENT_ID \
  --clientSecretEnv DW_CLIENT_SECRET
```

You can also pass credentials directly with `--clientId` and `--clientSecret`, but environment variable references (`--clientIdEnv` / `--clientSecretEnv`) are preferred because they keep secrets out of shell history and process lists.

### Authentication precedence

When multiple auth indicators are present, the CLI resolves them in this order:

1. `--apiKey` -- used directly, no environment required
2. OAuth -- if `--auth oauth`, `--clientId`/`--clientSecret`, `--clientIdEnv`/`--clientSecretEnv`, or the environment is configured for OAuth
3. Saved user -- from `~/.dwc`
4. Interactive prompt -- if nothing else is configured

Use `--auth user` to force user authentication even when an environment is configured for OAuth.

## Automation and JSON output

Every command except `config` supports `--output json`. This returns a structured envelope instead of human-readable console output:

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

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `boolean` | `true` if the operation succeeded |
| `command` | `string` | Which CLI command ran |
| `operation` | `string` | The specific operation within that command |
| `status` | `number` | `0` on success. On failure, the HTTP status code returned by the Management API, or `1` when the failure happened in the CLI |
| `data` | `array` | The result payload |
| `errors` | `array` | Error objects with `message` and `details` if the operation failed |
| `meta` | `object` | Command-specific metadata (query name, file counts, etc.) |

When `--output json` is active, all human-readable output to stdout is suppressed and interactive prompts are never shown -- a command that would need one fails instead. Only the JSON envelope is written to stdout, which makes it safe to pipe.

### Parsing output in scripts

Extract data with `jq` or any JSON parser:

```sh
# Check if a query succeeded
dw query HealthCheck --output json | jq '.ok'

# Get the list of configured environments
dw env --list --output json | jq -r '.data[0].environments[]'

# Count files processed during an import
dw files ./Files templates -i -r --output json | jq '.meta.filesProcessed'
```

### Error handling in JSON mode

When a command fails, `ok` is `false` and the `errors` array contains structured error information:

```json
{
  "ok": false,
  "command": "query",
  "operation": "run",
  "status": 1,
  "data": [],
  "errors": [
    {
      "message": "Query not found",
      "details": null
    }
  ],
  "meta": {}
}
```

The CLI exits with code `1` on any error, so you can use standard shell exit-code checks alongside JSON parsing. Outside JSON mode, the error message is written to stderr (add `--verbose` to include the API's error details). A successful run writes nothing to stderr, so runners configured to fail on stderr output -- such as PowerShell with `$ErrorActionPreference = 'Stop'` -- only stop on real failures.

## CI/CD

The recommended CI/CD setup combines OAuth client credentials, `--output json`, and `--host` overrides. This section gives you the patterns for both ephemeral and persistent runners.

### Secrets

Store your OAuth credentials in your pipeline's secret store:

- `DW_CLIENT_ID` -- the OAuth client ID
- `DW_CLIENT_SECRET` -- the OAuth client secret

These should never be hardcoded in scripts or committed to source control.

### Ephemeral runners (no saved config)

On runners that start fresh each time (most cloud CI), pass everything inline. No `~/.dwc` file needed:

```sh
#!/bin/sh
# Deploy templates and verify with a health check.
# DW_CLIENT_ID and DW_CLIENT_SECRET are set by the pipeline secret store.

TARGET_HOST="your-solution.example.com"
AUTH_FLAGS="--auth oauth --clientIdEnv DW_CLIENT_ID --clientSecretEnv DW_CLIENT_SECRET"

# Import templates
dw files ./Files/Templates /Templates -i -r \
  --host "$TARGET_HOST" $AUTH_FLAGS \
  --output json

# Verify the environment is healthy
RESULT=$(dw query HealthCheck \
  --host "$TARGET_HOST" $AUTH_FLAGS \
  --output json)

echo "$RESULT" | jq '.ok'
```

> [!TIP]
> In GitHub Actions, set `DW_CLIENT_ID` and `DW_CLIENT_SECRET` as repository secrets and reference them with `${{ secrets.DW_CLIENT_ID }}` in the `env` block of your step. In Azure Pipelines, add them as secret variables and they will be available as environment variables.

### Persistent runners (saved config)

On long-lived runners, configure the environment once:

```sh
# One-time setup
dw env production --host https://your-solution.example.com
export DW_CLIENT_ID=my-client-id
export DW_CLIENT_SECRET=my-client-secret
dw login --oauth
```

Then subsequent pipeline steps only need:

```sh
dw env production
dw query HealthCheck --output json
```

### Installing add-ins in pipelines

Use `dw install --queue` when deploying add-ins in automated pipelines. This defers activation until all files are in place, which avoids partial-load issues when multiple add-ins depend on each other:

```sh
dw install ./bin/Release/net10.0/MyAddin.dll \
  --queue \
  --host "$TARGET_HOST" $AUTH_FLAGS
```

See the [install command reference](#install) for the full explanation of immediate vs. queued installation.

## Command reference

### Global options

These options are available on all API-driven commands:

| Option | Description |
|--------|-------------|
| `-v`, `--verbose` | Enable verbose logging |
| `--host <host>` | Use a specific host instead of the saved environment |
| `--protocol <protocol>` | Protocol for `--host` (defaults to `https`) |
| `--apiKey <key>` | Use an API key directly, no saved environment needed |
| `--auth <mode>` | Override authentication mode: `user` or `oauth` |
| `--clientId <id>` | OAuth client ID (direct value) |
| `--clientSecret <secret>` | OAuth client secret (direct value) |
| `--clientIdEnv <var>` | Environment variable containing the OAuth client ID |
| `--clientSecretEnv <var>` | Environment variable containing the OAuth client secret |
| `--output json` | Return structured JSON instead of human-readable output |
| `--transfer <mode>` | How `files`, `folders` and `install` move files: `auto` (default), `filetransfer` or `legacy`. See [File transfer](#file-transfer) |

### env

Create, select, or inspect saved environments.

```sh
dw env dev                        # switch to (or create) the "dev" environment
dw env dev --host https://dev.example.com  # create or update "dev" without prompting
dw env                            # interactive setup for a new environment
dw env --list                     # list all configured environments
dw env production --users         # list saved users for "production"
```

**JSON output:**

```sh
dw env --list --output json
```

```json
{
  "ok": true,
  "command": "env",
  "operation": "list",
  "status": 0,
  "data": [
    {
      "environments": ["dev", "staging", "production"]
    }
  ],
  "errors": [],
  "meta": {}
}
```

### login

Log in interactively, configure OAuth, or switch between saved users.

```sh
dw login                          # interactive username/password prompt
dw login DemoUser                 # switch to a saved user
dw login --oauth                  # configure OAuth for the current environment
```

The interactive login requires a DynamicWeb user with backend access and administrator privileges. The CLI creates an API key named "DW CLI" and stores it in `~/.dwc`.

**JSON output:**

```sh
dw login --oauth --output json
```

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

### files

List, export, and import files from the DynamicWeb file archive.

```sh
dw files [dirPath] [outPath] [options]
```

**Key options:**

| Option | Description |
|--------|-------------|
| `-l`, `--list` | List directories (add `-f` to include files) |
| `-f`, `--includeFiles` | Include files in listings |
| `-e`, `--export` | Export from the environment to disk |
| `-i`, `--import` | Import from disk to the environment |
| `-d`, `--delete` | Delete a file or directory on the environment |
| `--empty` | Used with `--delete`, empties a directory instead of removing it |
| `--copy <dest>` | Copy a file or directory to the given destination path on the environment |
| `--move <dest>` | Move a file or directory to the given destination path on the environment |
| `-r`, `--recursive` | Recurse through subdirectories |
| `-o`, `--overwrite` | Allow overwriting existing files on import or move |
| `--createEmpty` | Create files even if the source file is empty |
| `--raw` | Keep exported archives zipped instead of extracting |
| `-af`, `--asFile` | Force the source path to be treated as a file |
| `-ad`, `--asDirectory` | Force the source path to be treated as a directory |
| `--dangerouslyIncludeLogsAndCache` | Include log and cache folders in export |
| `--changed-only` | With `--import`/`--export`, transfer only files whose content differs. Requires the [File Transfer API](#file-transfer) |
| `--fail-on-remote-change` | With `--import`, change nothing if a file to be replaced changed on the server since the last sync. Requires the File Transfer API |
| `--verify` | With `--export`, check every downloaded file against its SHA-256 on the server. Requires the File Transfer API |

`dw files` also has subcommands for syncing, deploying and inspecting -- see [Sync, deploy and inspect](#sync-deploy-and-inspect). Because of them, a remote directory literally named `diff`, `sync`, `deploy`, `rollback`, `stat` or `usage` must be written with a leading `/` or `./` (for example `dw files /stat -l`).

**Examples:**

```sh
# List the system folder structure recursively
dw files system -lr

# Export templates recursively, including files
dw files templates ./templates -fre

# Export a single file
dw files templates/Translations.xml ./templates -e

# Import files from disk, recursively with overwrite
dw files ./Files templates -iro

# Delete a file
dw files /Templates/Designs/old-bundle.js --delete

# Delete a directory
dw files /Templates/Designs/OldDesign --delete

# Empty a directory (remove contents, keep the directory)
dw files /Templates/Designs/MyDesign --delete --empty

# Copy a directory into a backup folder (creates /Templates/Backups/MyDesign)
dw files /Templates/Designs/MyDesign --copy /Templates/Backups

# Copy a file to another directory
dw files /Templates/config.json --copy /Templates/Backups

# Move a directory into an archive folder (creates /Templates/Designs/Archive/OldName)
dw files /Templates/Designs/OldName --move /Templates/Designs/Archive

# Move a file with overwrite
dw files /Templates/config.json --move /Templates/Backups --overwrite
```

#### Deleting files and directories

The `--delete` flag removes files and directories from the environment. The CLI uses the same path detection as other operations -- paths with a file extension are treated as files, paths without are treated as directories. Use `--asFile` or `--asDirectory` to override when needed.

When used interactively, the CLI prompts for confirmation before deleting. In JSON output mode (`--output json`), the confirmation is skipped to support scripted and CI/CD usage.

The `--empty` flag can be combined with `--delete` to remove the contents of a directory without removing the directory itself. This is useful for cleaning a deployment target before importing fresh files:

```sh
# Clean and redeploy
dw files /Templates/Designs/MyDesign --delete --empty \
  --host "$TARGET_HOST" $AUTH_FLAGS --output json

dw files ./dist /Templates/Designs/MyDesign -iro \
  --host "$TARGET_HOST" $AUTH_FLAGS --output json
```

#### Copying and moving files and directories

The `--copy` and `--move` flags operate on files and directories within the environment. The value is the **directory to copy or move into**: the item keeps its name, so `--copy /Templates/Backups` creates `/Templates/Backups/<name>`. To rename a directory, use `dw folders --rename`. These work with both files and directories -- the server handles detection.

The `--overwrite` flag can be combined with `--move` (and, with the File Transfer API, `--copy`) to overwrite existing files at the destination.

```sh
# Back up a design before deploying a new version (creates /Templates/Backups/MyDesign)
dw files /Templates/Designs/MyDesign --copy /Templates/Backups \
  --host "$TARGET_HOST" $AUTH_FLAGS --output json

# Reorganize files on the server
dw files /Templates/OldLocation/config.json --move /Templates/NewLocation --overwrite \
  --host "$TARGET_HOST" $AUTH_FLAGS --output json
```

#### Source type detection

The CLI infers whether a path is a file or directory based on whether it contains a file extension. This is usually correct, but some paths are ambiguous:

- A directory named `templates.v1` looks like a file
- A file without an extension looks like a directory

Use `--asFile` or `--asDirectory` to override the detection:

```sh
dw files templates/templates.v1 ./templates -e -ad    # it's a directory, not a file
dw files templates/Translations.xml ./templates -e -af # force file mode
```

> [!NOTE]
> `--asFile` and `--asDirectory` cannot be used together.

#### Deploying files between environments

A common workflow is exporting files from one environment and importing them to another:

```sh
# Export from development
dw env development
dw files templates ./templates -fre

# Import to staging
dw env staging
dw files ./templates /templates -iro
```

This pattern works for any part of the file tree -- templates, designs, integration files, or the entire file archive.

**JSON output:**

```sh
dw files ./Files templates -i -r --output json
```

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

```sh
dw files /Templates/Designs/OldDesign --delete --output json
```

```json
{
  "ok": true,
  "command": "files",
  "operation": "delete",
  "status": 0,
  "data": [
    {
      "type": "delete",
      "path": "/Templates/Designs/OldDesign",
      "mode": "directory"
    }
  ],
  "errors": [],
  "meta": {}
}
```

```sh
dw files /Templates/Designs/MyDesign --copy /Templates/Backups --output json
```

```json
{
  "ok": true,
  "command": "files",
  "operation": "copy",
  "status": 0,
  "data": [
    {
      "type": "copy",
      "sourcePath": "/Templates/Designs/MyDesign",
      "destination": "/Templates/Backups"
    }
  ],
  "errors": [],
  "meta": {}
}
```

```sh
dw files /Templates/config.json --move /Templates/Backups --output json
```

```json
{
  "ok": true,
  "command": "files",
  "operation": "move",
  "status": 0,
  "data": [
    {
      "type": "move",
      "sourcePath": "/Templates/config.json",
      "destination": "/Templates/Backups",
      "overwrite": false
    }
  ],
  "errors": [],
  "meta": {}
}
```

### folders

Create, rename, move, delete, copy, and export directories in the DynamicWeb file archive.

```sh
dw folders <folderPath> [options]
```

Unlike `dw files`, which infers whether a path refers to a file or a directory based on whether it has a file extension, `dw folders` always treats the path as a directory. This avoids ambiguity for paths like `templates.v1` or `my.theme`.

**Key options:**

| Option | Description |
|--------|-------------|
| `-c`, `--create` | Create the directory at `<folderPath>` |
| `--rename <newName>` | Rename the directory to a new name, keeping it in the same parent |
| `-m`, `--move <dest>` | Move the directory to the given destination path |
| `-d`, `--delete` | Delete the directory |
| `--empty` | Used with `--delete`, empties the directory instead of removing it |
| `--copy <dest>` | Copy the directory to the given destination path |
| `-e`, `--export` | Export the directory to disk |
| `-o`, `--outPath` | Local destination for `--export` (defaults to `.`) |
| `--raw` | Keep exported archives zipped instead of extracting |

**Examples:**

```sh
# Create a new directory
dw folders /Files/NewFolder --create

# Rename a directory
dw folders /Files/OldName --rename NewName

# Move a directory into another location
dw folders /Files/MyFolder --move /Files/Archive

# Delete a directory
dw folders /Files/MyFolder --delete

# Empty a directory (remove contents, keep the directory)
dw folders /Files/MyFolder --delete --empty

# Copy a directory
dw folders /Files/MyFolder --copy /Files/Backups   # creates /Files/Backups/MyFolder

# Export a directory to disk
dw folders /Files/MyFolder --export --outPath ./local
```

**Relationship to `dw files`:** `--delete`, `--copy`, and `--export` are routed through the same implementation as `dw files` and produce identical JSON output shapes. `--create`, `--rename`, and `--move` are directory-only operations with no `dw files` equivalent.

**JSON output:**

```sh
dw folders /Files/NewFolder --create --output json
```

```json
{
  "ok": true,
  "command": "folders",
  "operation": "create",
  "status": 0,
  "data": [
    {
      "type": "create",
      "path": "/Files/NewFolder"
    }
  ],
  "errors": [],
  "meta": {}
}
```

```sh
dw folders /Files/OldName --rename NewName --output json
```

```json
{
  "ok": true,
  "command": "folders",
  "operation": "rename",
  "status": 0,
  "data": [
    {
      "type": "rename",
      "path": "/Files/OldName",
      "newName": "NewName"
    }
  ],
  "errors": [],
  "meta": {}
}
```

```sh
dw folders /Files/MyFolder --move /Files/Archive --output json
```

```json
{
  "ok": true,
  "command": "folders",
  "operation": "move",
  "status": 0,
  "data": [
    {
      "type": "move",
      "sourcePath": "/Files/MyFolder",
      "destinationPath": "/Files/Archive"
    }
  ],
  "errors": [],
  "meta": {}
}
```

### query

Run Management API queries, inspect available parameters, or prompt for them interactively.

```sh
dw query <query> [--<param> <value> ...] [options]
```

**Key options:**

| Option | Description |
|--------|-------------|
| `-l`, `--list` | List the query's properties and their types |
| `-i`, `--interactive` | Prompt for each parameter interactively |
| `--<param> <value>` | Pass query parameters directly |

**Examples:**

```sh
# List properties for a query
dw query FileByName -l

# Run a query with parameters
dw query FileByName --name DefaultMail.html --directorypath /Templates/Forms/Mail

# Run interactively (prompts for each parameter)
dw query FileByName --interactive
```

**JSON output:**

```sh
dw query FileByName --name DefaultMail.html --output json
```

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

### command

Run Management API commands with a JSON payload.

```sh
dw command <command> --json '<payload>' [options]
dw command <command> --json ./payload.json [options]
```

The `--json` flag accepts either an inline JSON string or a path to a `.json` file.

> [!NOTE]
> The `--json` flag here is specific to the `command` subcommand and passes a payload to the Management API. It is **not** the same as the deprecated global `--json` output flag (replaced by `--output json`).

**Examples:**

```sh
# Copy a page using an inline JSON payload
dw command PageCopy --json '{ "model": { "SourcePageId": 1189, "DestinationParentPageId": 1129 } }'

# Move a page using a JSON file
dw command PageMove --json ./PageMove.json

# Delete a page with JSON output
dw command PageDelete --json '{ "id": "1383" }' --output json
```

**JSON output:**

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

> [!NOTE]
> `dw command --list` is reserved for command metadata but is not fully implemented yet.

### install

Upload and install a `.dll` or `.nupkg` add-in into the current environment.

```sh
dw install <filePath> [--queue] [--output json]
```

**Immediate installation (default):**

```sh
dw install ./bin/Release/net10.0/CustomProject.dll
```

The add-in is uploaded, installed, and activated immediately. This is the right choice for local development and iterative testing.

**Queued installation:**

```sh
dw install ./bin/Release/net10.0/CustomProject.dll --queue
```

The add-in is uploaded and installed but **not activated** until the next application recycle. Use `--queue` when:

- Installing multiple add-ins in sequence
- Deploying add-ins that depend on shared libraries or other add-ins
- Running in a CI/CD pipeline where you want all changes to take effect together
- Preparing an environment before a planned restart

Queued installation ensures all dependencies are in place before any add-in is activated, which avoids partial-load failures.

> [!NOTE]
> Some add-in types require an application restart regardless of installation mode. In hosted or cloud environments, queued installation is the preferred approach -- see [DynamicWeb Cloud](xref:hosting-dynamicweb-cloud) for guidance on restarts and deployment workflows.

### database

Export the current environment's database to a `.bacpac` file.

```sh
dw database ./backups --export
```

The database user needs `db_backupoperator` permissions. To grant them:

```sql
USE [yourDwDatabaseName]
GO
ALTER ROLE [db_backupoperator] ADD MEMBER [yourDwDbUserName]
GO
```

### swift

Download a Swift release from GitHub.

```sh
dw swift [outPath] [options]
```

| Option | Description |
|--------|-------------|
| `-l`, `--list` | List all available release versions |
| `-t`, `--tag <tag>` | Download a specific version tag |
| `-n`, `--nightly` | Download the latest commit (HEAD) instead of the latest release |
| `--force` | Overwrite the output directory if it is not empty |

**Examples:**

```sh
dw swift -l                            # list available versions
dw swift . --tag v2.3.0 --force        # download a specific version example
dw swift . --nightly --force           # download the latest nightly build
```

### config

Write values directly into `~/.dwc` using dot-notation paths.

> [!NOTE]
> `config` does not support `--output json`.

```sh
dw config --env.dev.host localhost:6001
dw config --env.production.protocol https
```

This is useful for scripting config updates without editing the JSON file manually.

## File transfer

`files`, `folders` and the upload step of `install` can move files in two ways:

| Mode | Uses | Available on |
|------|------|--------------|
| `filetransfer` | The File Transfer API (`/Admin/Api/FileTransfer`): uploads in checksum-verified chunks that are assembled and swapped in atomically, streamed per-file downloads, and automatic retries of transient failures that are safe to repeat | Solutions that include the File Transfer API |
| `legacy` | The original Management API endpoints: multipart uploads and zip-based exports | All DynamicWeb 10 solutions |

By default (`auto`) the CLI checks once per command whether the solution provides the File Transfer API and uses it when it does. The commands, options and JSON output are the same either way; the envelope's `meta.transfer` says which was used and `meta.transferSource` why.

Choose explicitly with, in order of precedence:

1. `--transfer auto|filetransfer|legacy` on the command
2. The `DW_TRANSFER` environment variable
3. A `transfer` setting on the saved environment: `dw config --env.production.transfer legacy`

An explicit `filetransfer` never falls back: if the solution does not provide the API the command fails, so a pipeline or test always runs what it asked for. An authentication failure during the check is reported as such, never treated as "not supported".

```sh
# Force each implementation, e.g. to compare them in a test
DW_TRANSFER=filetransfer dw files ./dist /Templates/Designs/MyDesign -iro --output json
DW_TRANSFER=legacy       dw files ./dist /Templates/Designs/MyDesign -iro --output json
```

Differences you may notice with `filetransfer`:

- `--raw` (keep the zip) only exists in the legacy transfer. Under `auto` it uses legacy for that command; with `--transfer filetransfer` it is an error.
- Exports are downloaded file by file instead of as a zip, so nothing is extracted locally. Log and cache folders are still left out unless `--dangerouslyIncludeLogsAndCache`.
- Whether a path is a file or a directory is asked from the server, so `--asFile`/`--asDirectory` are only needed to override it.
- Listing a directory that does not exist is an error (the legacy endpoint returns an empty listing).
- Copying onto an existing item is an error (or replaces a file with `--overwrite`); the legacy endpoint creates "Copy of ...". Copying or moving into a directory that does not exist creates it; the legacy endpoints fail.
- Interrupted downloads resume where they stopped, on the next attempt or the next run. The partial file is tied to the remote file's version, so a file that changed in between is downloaded whole rather than spliced.

## Sync, deploy and inspect

These `dw files` subcommands need the File Transfer API. On a solution without it, or with `--transfer legacy`, they fail with an error that says so. All support `--output json`.

| Command | What it does |
|---------|--------------|
| `dw files diff <localPath> <remotePath>` | Compares a local directory with a remote one. Changes nothing |
| `dw files sync <localPath> <remotePath>` | Makes the remote directory's contents match the local directory, uploading only what changed |
| `dw files deploy <localPath> <remotePath>` | Replaces the remote directory with the local one in a single switch-over |
| `dw files rollback <remotePath>` | Restores the version replaced by the last `deploy --keep-backup` |
| `dw files stat <path>` | Size, modification time and version (eTag) of a remote file or directory; `--checksum` adds the SHA-256 |
| `dw files usage [path]` | Total size and number of files and directories under a remote directory |

`<remotePath>` is the directory whose **contents** should match `<localPath>`: `dw files sync ./dist Templates/Designs/MyDesign` makes `MyDesign` contain exactly what `dist` contains. (This differs from `--copy`/`--move`, which copy or move *into* a directory.)

### How changes are detected

A file is unchanged when its size and SHA-256 match. Sizes are compared first; the server is only asked to hash files whose size is the same, and not even then if the CLI already knows the hash of that exact version (see [Transfer state](#transfer-state)).

`diff` lists each path as `+` new (only local), `~` changed, `-` remote only, or `!` a conflict, followed by a summary. Add `--show-unchanged` to list unchanged files too. The JSON output has the full list in `data[0].items` and the counts in `data[0].summary`:

```json
{ "new": 1, "changed": 2, "unchanged": 40, "remoteOnly": 1, "conflicts": 0, "directories": { "new": 0, "remoteOnly": 0 } }
```

### sync

```sh
dw files sync ./dist Templates/Designs/MyDesign                    # upload new and changed files
dw files sync ./dist Templates/Designs/MyDesign --delete           # ...and delete what dist does not have
dw files sync ./dist Templates/Designs/MyDesign --delete --dry-run # show what would change
```

Without `--delete`, remote files that do not exist locally are left alone. With it, they are deleted -- outside JSON mode the CLI asks first. Empty local directories are created remotely.

### deploy and rollback

```sh
dw files deploy ./dist Templates/Designs/MyDesign --keep-backup
dw files rollback Templates/Designs/MyDesign
```

`deploy` never edits the live directory file by file, so visitors never see a half-updated version:

1. The live directory is copied, on the server, to a staging directory beside it (`MyDesign.dwdeploy-<timestamp>`).
2. The staging copy is updated: new and changed files are uploaded and files not in `dist` are deleted.
3. The live directory is renamed to `MyDesign.dwbackup-<timestamp>` and the staging directory renamed into its place. These are two renames on the same disk, milliseconds apart; if the second fails, the first is undone.
4. The backup is deleted -- unless `--keep-backup`, in which case `dw files rollback` can put it back. One backup is kept per directory; the next deploy replaces it.

Outside JSON mode, `deploy` shows the number of new, changed and removed files and asks before starting; `rollback` asks too. `deploy --dry-run` shows the plan without changing anything.

If anything fails before step 3, the staging directory is removed and the live directory was never touched. Deploying to a directory that does not exist yet creates it. Deploying to the root of the file archive is not supported.

The staging and backup directories are briefly (or, with `--keep-backup`, until the next deploy) visible next to the live one -- for example as an extra design under `Templates/Designs`.

### Detecting changes made on the server

`sync`, `deploy` and `files --import` accept `--fail-on-remote-change`. It stops the command, before anything is changed, if a file it would overwrite or delete changed on the server since the CLI last synced that directory:

- **modified-remotely** -- the file's version (eTag) differs from the one the CLI recorded
- **added-remotely** -- the file was not there at the last sync

```sh
dw files deploy ./dist Templates/Designs/MyDesign --fail-on-remote-change --output json
# exit code 1, errors[0].details.code = "REMOTE_CHANGED", errors[0].details.conflicts lists the files
```

This protects against overwriting a hotfix someone made on the server. The first sync of a directory has nothing to compare with and sets the baseline. Changes the CLI makes with the legacy transfer are not recorded, so they count as remote changes. During the upload itself, `If-Match` makes the server refuse to replace a file that changed after the comparison.

`diff` shows these conflicts too (marked `!`), without the flag.

### Transfer state

What the CLI learns about remote files -- each file's version (eTag) and SHA-256, which directories were synced, and the backup of the last deploy -- is stored in `~/.dwc` under `transferState`, per host.

The versions `--fail-on-remote-change` compares against are only updated for files the CLI uploaded or confirmed to be identical to the local file. A file changed on the server that a command leaves alone -- not replaced because `--overwrite` was not given, or not deleted because `--delete` was not given -- keeps counting as a remote change until it is dealt with. Checksums fetched along the way (by `diff`, `stat --checksum` or `--verify`) are cached separately and never change that. It makes repeated diffs and syncs fast and enables `--fail-on-remote-change` and `rollback`. It is safe to delete: the next sync re-learns everything, and conflict detection starts over from a new baseline. On ephemeral CI runners the state starts empty on every run, so `--fail-on-remote-change` only protects within one run unless `~/.dwc` is cached between runs.

### Inspecting remote files

```sh
dw files stat Templates/Designs/MyDesign/dist/app.js --checksum
dw files usage Templates/Designs
```

`--checksum` hashes the file on the server; compare it with a local `sha256sum` to confirm a deployed file is exactly the one you built.

## Troubleshooting

### Git Bash path conversion

Git Bash on Windows automatically converts paths that look like Unix paths, which can interfere with file operations. If you see unexpected path-conversion behavior, disable it for the session:

```sh
export MSYS_NO_PATHCONV=1
dw files -iro ./ ./TestFolder --host <host> --apiKey <apiKey>
```

Alternatively, prefix paths with `./` or use PowerShell or CMD instead of Git Bash.
