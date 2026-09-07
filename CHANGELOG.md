# Changelog

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
