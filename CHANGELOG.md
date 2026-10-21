# Changelog

## Unreleased

### Breaking changes

- **Node.js `^20.19.0 || >=22.12.0` required** -- needed by `yargs` 18 and `@inquirer/prompts` 8.7.
- **`status` is `0` on every successful `files` operation** -- `list`, `delete`, `copy` and `move` previously reported `200`. On failure `status` is still the API's HTTP status code, or `1` for CLI-side failures.
- **Commands with nothing to do now fail** -- `dw files <path>` or `dw folders <path>` without an operation, `dw database` without `--export`, and mistyped commands (`dw fiels`) exit with code `1` instead of silently succeeding.

### Fixes

- **Exports never write through links in the destination** -- like zip extraction, file-by-file exports and the downloaded zip itself refuse to write through an existing symlink or junction that leads outside the output folder. Links that stay inside it, and an output folder that is itself a link, still work.
- **Uploading an empty file no longer crashes** (`The value of "end" is out of range`) -- a regression from the `form-data` removal in this release.
- **Copy/move docs described the destination wrongly** -- `--copy`/`--move <dest>` always copy or move *into* the directory `dest`; the examples suggested `dest` became the new name.
- **`folders --create` and `folders --rename` work** -- both sent a payload `DirectorySave` rejects (`Command.Model cannot be null`), so they always failed. They now send the command's `Name` with the directory in its `Model`. Verified against a live solution.
- **Exporting into a folder that does not exist yet** created no folder and crashed the process (an unhandled stream error, so no JSON envelope either). The output folder is now created, and write failures during a download are reported as normal errors.
- **API error reasons are shown** -- outside JSON mode, the Management API's message (for example "A directory with the same name already exists") is printed under the error instead of only with `--verbose`.
- **No more `DeprecationWarning` on file upload (#50)** -- uploads used the `form-data` package, which made node-fetch print a warning to stderr on every upload. Callers that treat stderr output as failure (for example PowerShell with `$ErrorActionPreference = 'Stop'`) reported successful uploads as failed. Uploads now use a spec-compliant `FormData`, and `form-data` is no longer a dependency.
- **Errors are never silent** -- outside JSON mode, `files`, `folders`, `env`, `login`, `command` and `install` set exit code `1` but printed nothing. All commands now print `Error: <message>` to stderr (with API details under `--verbose`). `query` no longer prints a stack trace for ordinary errors.
- **`files --export` reports HTTP errors** -- a failed download (for example a wrong API key) exited with `0` without downloading anything.
- **`database` and `swift` report failures** -- `database` called `process.exit(1)` without a message on some failures and never checked the HTTP status; `swift` exited with `0` when the download or the GitHub release lookup failed.
- **`files --import -r` on a single file** crashed with `ENOTDIR`; it now uploads the file. A missing local path gives a clear error.
- **`folders --delete` asked for confirmation twice.**
- **`dw env --output json` without a name** opened an interactive prompt; it now fails with a hint.
- **`dw env <name>`** crashed when `~/.dwc` had environments but no current one.
- **`files --list` paths are URL-encoded**, so directory names containing spaces, `&` or `#` work.
- **Zip extraction cannot be redirected by links already in the destination** -- containment was only checked on the path string, so an existing symlink or junction in the output folder (or a dangling one) let an extracted entry be written outside it. Every write is now also checked against the real on-disk path, and symlinks created from the archive are removed and rejected if they resolve outside.
- **`--verbose` no longer corrupts `--output json`** -- OAuth/login failures and empty-folder exports printed diagnostics to stdout ahead of the JSON envelope. Diagnostics now go to stderr.
- **Zip extraction accepts file names that start with `..`** (such as `..hidden`) while still rejecting path traversal -- ported from `main`.
- **Download file names** from quoted or RFC 5987 (`filename*=`) `Content-Disposition` headers are parsed correctly, and never resolve outside the output directory.
- **`command --json`** reports invalid JSON or a missing payload file as a clear error.
- **`swift`** no longer disables TLS certificate validation for GitHub API calls.

### New features

- **File Transfer API support** -- on solutions that provide `/Admin/Api/FileTransfer`, `files`, `folders` and `install` upload in checksum-verified chunks that are assembled and swapped in atomically, export file by file without a zip, ask the server whether a path is a file or a directory, and retry transient failures safely (mutations carry an `Idempotency-Key`). Older solutions keep using the original endpoints; the CLI detects which applies once per command. Commands, options and JSON output are unchanged; `meta.transfer` and `meta.transferSource` report what was used.
- **`dw files diff`, `sync`, `deploy`, `rollback`, `stat`, `usage`** (File Transfer API) -- compare a local directory with a remote one by size and SHA-256; make the remote match it, uploading only changes and optionally deleting what local lacks (`--delete`, `--dry-run`); replace a remote directory through a staging copy and a two-rename switch-over, optionally keeping one backup for `rollback`; inspect a remote file's version and checksum, or a directory's size.
- **`--fail-on-remote-change`** on `sync`, `deploy` and `files --import` -- stops before changing anything if a file it would overwrite or delete was modified or added on the server since the last sync; uploads use `If-Match` so a change during the run is not overwritten either.
- **`--changed-only`** on `files --import`/`--export` transfers only files whose content differs; **`--verify`** on `--export` checks each downloaded file against its SHA-256 on the server.
- **Resumable downloads** (File Transfer API) -- an interrupted download continues where it stopped, within the run or on the next one, and never splices two versions of a file.
- **Transfer state in `~/.dwc`** (`transferState`, per host) -- the versions and hashes of synced files, the synced directories, and the last deploy's backup.
- **`--transfer auto|filetransfer|legacy`**, the `DW_TRANSFER` environment variable and a per-environment `transfer` setting choose the implementation explicitly. A forced `filetransfer` fails rather than falling back.
- **`dw env <name> --host <host>`** creates or updates an environment without prompting, for scripted setup of persistent runners.
- **`database` and `swift` support `--output json`.**
- **`folders` reuses the resolved authentication** when delegating to `files`, so OAuth fetches one token per command instead of two.

### Internal

- All commands share one output envelope implementation (`bin/output.js`).
- The QA smoke harness removes its run folder (`QA/CLI/<runId>`), not just the subfolders inside it.
- Tests moved out of `bin/` so they are no longer shipped in the npm package; the extractor tests from `main` were ported.
- Dependencies updated: `@inquirer/prompts` 8.7, `yargs` 18, `node-fetch` 3.3; `form-data` removed.

## 2.0.0-beta.0

### Breaking changes

- **Version bumped to 2.0.0** -- this release contains breaking changes to command output, option names, and authentication behavior.
- **`--json` flag replaced by `--output json`** -- the old `--json` flag is deprecated and will be removed in a future release. All commands now use `--output json` for structured output.
- **`--iamstupid` replaced by `--dangerouslyIncludeLogsAndCache`** -- the old flag is deprecated and will be removed in a future release.
- **Error handling changed** -- commands that previously printed an error and exited silently now throw structured errors. In JSON mode, errors are returned in the `errors` array with `ok: false`. The CLI exits with code `1` on any error.

### New features

- **OAuth client credentials authentication** -- the CLI now supports OAuth 2.0 client credentials for headless and CI/CD authentication. Use `dw login --oauth` to configure an environment, or pass `--auth oauth` with `--clientIdEnv`/`--clientSecretEnv` (or `--clientId`/`--clientSecret`) on any command.
- **Structured JSON output on all API commands** -- `env`, `login`, `files`, `query`, `command`, and `install` all support `--output json`, returning a consistent envelope with `ok`, `command`, `operation`, `status`, `data`, `errors`, and `meta` fields.
- **File delete operations** -- `dw files <path> --delete` removes files and directories from the environment. Combine with `--empty` to clear a directory without removing it.
- **File copy operations** -- `dw files <path> --copy <destination>` copies files and directories within the environment.
- **File move operations** -- `dw files <path> --move <destination>` moves files and directories within the environment. Combine with `--overwrite` to replace existing files at the destination.
- **Global OAuth flags** -- `--auth`, `--clientId`, `--clientSecret`, `--clientIdEnv`, and `--clientSecretEnv` are available as global options on all commands.
- **Authentication precedence** -- when multiple auth indicators are present, the CLI resolves them in order: `--apiKey` > OAuth > saved user > interactive prompt. Use `--auth user` to force user auth when an environment is configured for OAuth.
- **Base command shows auth type** -- `dw` with no arguments now displays the current authentication type (OAuth or user) alongside environment info.

### Improvements

- **Consistent error model** -- all commands use a shared `createCommandError` helper that produces errors with `message`, `status`, and `details`. In JSON mode these are serialized into the `errors` array.
- **Human output suppressed in JSON mode** -- when `--output json` is active, all `console.log` output is suppressed. Only the JSON envelope is written to stdout, making it safe to pipe.
- **Interactive prompts skipped in JSON mode** -- delete confirmations and other interactive prompts are skipped when `--output json` is set, enabling fully non-interactive scripted usage.
- **Better host override handling** -- `--host` now works with OAuth credentials, not just `--apiKey`.
- **Null-safe config access** -- environment and user lookups use optional chaining to avoid crashes on missing config keys.
