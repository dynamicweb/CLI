---
title: DynamicWeb CLI
_description: Automate and manage DynamicWeb 10 solutions from the command line.
uid: cli
---

# DynamicWeb CLI

The DynamicWeb CLI is a command-line tool for automating and managing DynamicWeb 10 solutions. It connects to the [Management API](xref:dw10-webapis#management-api) to run queries and commands, move files in and out of a solution, install add-ins, export databases, and pull Swift releases.

The CLI is designed to be composable. Every API-driven command supports structured JSON output, and authentication can be fully configured through environment variables and flags -- no interactive prompts required. This makes the CLI equally useful for one-off tasks at a developer's terminal and for scripted steps in a CI/CD pipeline.

If you need to do something once, interactively, the DynamicWeb backend UI is usually faster. If you need to do it repeatedly, across environments, or as part of a build -- that is what the CLI is for.

## Installation

The CLI requires **Node.js 20.12.0 or later**.

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

Commands that talk to the Management API -- `env`, `login`, `files`, `query`, and `command` -- support `--output json`. This returns a structured envelope instead of human-readable console output:

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

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `boolean` | `true` if the operation succeeded |
| `command` | `string` | Which CLI command ran |
| `operation` | `string` | The specific operation within that command |
| `status` | `number` | HTTP-style status code |
| `data` | `array` | The result payload |
| `errors` | `array` | Error objects with `message` and `details` if the operation failed |
| `meta` | `object` | Command-specific metadata (query name, file counts, etc.) |

When `--output json` is active, all human-readable output to stdout is suppressed. Only the JSON envelope is written to stdout, which makes it safe to pipe.

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
  "status": 404,
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

The CLI exits with code `1` on any error, so you can use standard shell exit-code checks alongside JSON parsing.

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
dw env production
dw config --env.production.host your-solution.example.com
dw config --env.production.protocol https
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

### env

Create, select, or inspect saved environments.

```sh
dw env dev                        # switch to (or create) the "dev" environment
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
  "status": 200,
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

# Copy a directory within the environment
dw files /Templates/Designs/MyDesign --copy /Templates/Designs/MyDesign-backup

# Copy a file to another directory
dw files /Templates/config.json --copy /Templates/Backups

# Move a directory
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

The `--copy` and `--move` flags operate on files and directories within the environment. Both accept a destination path as their value. These work with both files and directories -- the server handles detection.

The `--overwrite` flag can be combined with `--move` to overwrite existing files at the destination.

```sh
# Back up a design before deploying a new version
dw files /Templates/Designs/MyDesign --copy /Templates/Designs/MyDesign-backup \
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

```sh
dw files /Templates/Designs/OldDesign --delete --output json
```

```json
{
  "ok": true,
  "command": "files",
  "operation": "delete",
  "status": 200,
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
dw files /Templates/Designs/MyDesign --copy /Templates/Designs/MyDesign-backup --output json
```

```json
{
  "ok": true,
  "command": "files",
  "operation": "copy",
  "status": 200,
  "data": [
    {
      "type": "copy",
      "sourcePath": "/Templates/Designs/MyDesign",
      "destination": "/Templates/Designs/MyDesign-backup"
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
  "status": 200,
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

### command

Run Management API commands with a JSON payload.

```sh
dw command <command> --json '<payload>' [options]
dw command <command> --json ./payload.json [options]
```

The `--json` flag accepts either an inline JSON string or a path to a `.json` file.

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

> [!NOTE]
> `dw command --list` is reserved for command metadata but is not fully implemented yet.

### install

Upload and install a `.dll` or `.nupkg` add-in into the current environment.

```sh
dw install <filePath> [--queue]
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
dw swift . --tag v1.25.1 --force       # download a specific version
dw swift . --nightly --force           # download the latest nightly build
```

### config

Write values directly into `~/.dwc` using dot-notation paths.

```sh
dw config --env.dev.host localhost:6001
dw config --env.production.protocol https
```

This is useful for scripting config updates without editing the JSON file manually.

## Troubleshooting

### Git Bash path conversion

Git Bash on Windows automatically converts paths that look like Unix paths, which can interfere with file operations. If you see unexpected path-conversion behavior, disable it for the session:

```sh
export MSYS_NO_PATHCONV=1
dw files -iro ./ ./TestFolder --host <host> --apiKey <apiKey>
```

Alternatively, prefix paths with `./` or use PowerShell or CMD instead of Git Bash.
