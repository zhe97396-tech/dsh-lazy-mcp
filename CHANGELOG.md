# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-19

First public release.

### Added

- Lazy MCP gateway for DeepSeek Harness: MCP servers are connected on first use
  instead of at startup, and disconnected again after an idle window.
- Four lifecycle modes (`lazy`, `lazy-keep-alive`, `eager`, `keep-alive`) per
  server.
- Five model-facing tools: `mcp_servers`, `mcp_tools`, `mcp_call`,
  `mcp_resources`, `mcp_read_resource`.
- Tool and resource metadata cache, with optional invalidation on config change.
- Configuration import from existing setups (`configPaths`, inline `mcpServers`,
  and compatible Pi fields), plus per-server and per-tool overrides.
- Child-process environment scrubbing: `*KEY*` / `*TOKEN*` / `*SECRET*` /
  `*PASSWORD*` and `DSH_*` variables are stripped; secrets belong in a server's
  `env` / `headers` and are never cached or logged.
- Delivery-class reporting for failures (`not_sent`, `server_error`,
  `may_have_run`) so a failed call can be retried or not, deliberately.
- Status sidebar panel and an in-conversation chip, backed by the
  `/lazy-mcp/state` route (GET snapshot, POST idle timeout, DELETE default).
- `verify.mjs` self-check harness (76 checks) that drives the real plugin
  `apply()` with a stub Cordis context and a live MCP reference server.

### Changed

- Renamed the package from `@local/dsh-lazy-mcp` to `dsh-lazy-mcp` for public
  distribution. The module id, Loader row name, and naming manifest were updated
  in lockstep.
- The shipped default configuration now declares `servers: []` instead of
  carrying the author's local MCP servers. Add your own servers in the plugin
  configuration (see the README examples).

[0.4.0]: https://github.com/zhe97396-tech/dsh-lazy-mcp/releases/tag/v0.4.0
