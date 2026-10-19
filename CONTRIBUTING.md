# Contributing

Thanks for taking a look. This project is a DeepSeek Harness (DSH) plugin, so
the useful contributions are usually one of: a lifecycle bug, a configuration
shape that does not import correctly, a status-panel issue, or a documentation
fix.

## Reporting a bug

Please open an issue with:

- DSH version (`dsh --version`) and Node version (`node --version`)
- OS and shell
- the plugin configuration you used, **with secrets redacted** (the plugin
  removes `*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*` variables from the child
  environment, but issue reports are public)
- what you expected, what happened, and the plugin log lines if available

## Development setup

Requirements: Node.js 20 or newer, and pnpm 10.

```bash
pnpm install
pnpm run check   # syntax check of both halves
pnpm run lint    # repository consistency checks (package identity, manifest)
pnpm run verify  # starts a real MCP reference server through npx
```

`pnpm run verify` needs network access the first time because it spawns
`npx -y @modelcontextprotocol/server-everything`. It uses only the public
reference server and a temporary directory.

## Trying your build in a DSH profile

The plugin has a Host half (`index.js`) and a browser half (`client.js`), so a
JavaScript change needs a `dsh web` restart — unloading and re-enabling the
plugin is not enough.

```bash
# install directly from a checkout or a packed tarball
dsh plugin --profile web add ./dsh-lazy-mcp-0.4.0.tgz
# or install from GitHub
dsh plugin --profile web add github:zhe97396-tech/dsh-lazy-mcp
```

Then restart `dsh web`. See the README for configuration and the status panel.

## Repository layout

| Path | Role |
| --- | --- |
| `index.js` | Host half: config import, lifecycle, tools, `/lazy-mcp/state` route |
| `client.js` | Browser half: sidebar status panel and in-conversation chip |
| `cordis.patch.yml` | Default bundle configuration |
| `dsh-plugin.naming.json` | Declared names (tools, routes, Loader id) |
| `scripts/check-package.mjs` | Keeps the package identity in lockstep |
| `verify.mjs` | Self-check harness (76 checks) |
| `probe-*.mjs` | One-off capability/resource probes, not part of the plugin |

## Code guidelines

- Keep the runtime dependency surface at exactly `@modelcontextprotocol/client`.
  This plugin deliberately imports nothing from `@deepseek-ai/*`, so it works
  against a DSH profile without adding host packages.
- Never connect an MCP server during a read-only state query. The
  `/lazy-mcp/state` route must not trigger a connection.
- Preserve the delivery-class distinction (`not_sent` / `server_error` /
  `may_have_run`) when adding or changing failure paths.
- Never log, cache, or put secrets into metadata; secrets live only in the
  server's `env` / `headers`.
- Write comments and commit messages in English. UI status labels are currently
  Chinese; a localization PR is welcome but keep the status vocabulary in sync
  with the README.
- Update `CHANGELOG.md` for user-visible changes, and bump the version only in a
  release PR.

## Pull requests

Run the full gate before opening a PR:

```bash
pnpm run check && pnpm run lint && pnpm run verify
```

For changes that touch the package identity (`package.json#name`, `client.js`
module id, `cordis.patch.yml` row name, `dsh-plugin.naming.json`), update all
four together — `pnpm run lint` fails otherwise.

## Releasing

The market entry points at a version-free asset name so the install link keeps
working across releases:

```bash
pnpm pack                                        # dsh-lazy-mcp-<version>.tgz
cp dsh-lazy-mcp-<version>.tgz dsh-lazy-mcp.tgz
gh release upload v<version> dsh-lazy-mcp-<version>.tgz dsh-lazy-mcp.tgz
```

Always attach both names: the versioned tarball is the human-facing artifact,
and `dsh-lazy-mcp.tgz` is what
`releases/latest/download/dsh-lazy-mcp.tgz` resolves to.
