# chrome-devtools-mcp-wrapper

**Share one Chrome across all your AI coding sessions.**

A thin proxy wrapper around Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) that adds what the upstream server assumes away: multiple MCP clients are going to run at the same time, and they shouldn't each own a browser.

```
 omp ─┐
claude ├─ stdio ──▶ chrome-devtools-mcp-wrapper ── npx ──▶ chrome-devtools-mcp ──CDP──▶ Chrome (shared)
cursor ┘             lifecycle · filtering ·             (official, unmodified)
                     anti-detect · logging
```

## The problem

`chrome-devtools-mcp` is a single-client server: every MCP client that spawns it launches its **own** Chrome instance. Run three AI assistants (or three sessions of one) and you get three browsers competing for memory — each with a separate profile, separate login state, and no coordination on shutdown.

## What this adds

| Capability | What it does |
|---|---|
| **Chrome lifecycle & refcounting** | First client launches Chrome; later clients attach to the same instance via a PID-verified lock file. The browser shuts down only when the last client disconnects. Works across different MCP clients and across sessions. |
| **Anti-detect launch** | Hides automation flags (`AutomationControlled`, `navigator.webdriver`, infobars, …) plus a set of stability args distilled from a production crawler. Pages that treat headless/automated browsers differently see a normal browser. |
| **Tool filtering** | `--block-tools` / `--allow-only` to hide upstream tools from the model — useful when an agent keeps reaching for destructive tools. |
| **Custom tools** | `--init-script` loads your own JS that registers extra MCP tools alongside the upstream ones. |
| **Structured logging** | Per-session log files with size caps, rotation and rate limiting under `~/.cache/cdp-wrapper/logs/`. |

The upstream server itself runs **unmodified** — the wrapper spawns it via `npx chrome-devtools-mcp@latest`, wires its Chrome connection, and filters what passes through.

## Requirements

- Node ≥ 18
- Google Chrome (any recent stable; the wrapper locates it, including Playwright-managed installs)
- `npx` (bundled with npm) — the upstream server is fetched on first run

## Quickstart

```bash
git clone <repo-url> chrome-devtools-mcp-wrapper
cd chrome-devtools-mcp-wrapper
npm install

# smoke test: launches Chrome (or reuses a running one) and starts the proxy
npm start -- --profile=default
```

Register it with your MCP client instead of the plain server. For Claude-style `mcp.json`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "node",
      "args": [
        "/absolute/path/to/chrome-devtools-mcp-wrapper/index.mjs",
        "--profile=default"
      ]
    }
  }
}
```

For [OMP](https://github.com/can1357/oh-my-pi), put the same block in `~/.omp/agent/mcp.json` (user scope — applies to every project) or `<project>/.omp/mcp.json` (project scope).

See [.mcp.json.example](.mcp.json.example) for a config with tool filtering and debug logging enabled.

## CLI reference

```
node index.mjs [options] [-- upstream-args...]
```

| Flag | Effect |
|---|---|
| `--profile=<name>` | Named Chrome profile. All clients using the same name share one browser instance. Omitted → `shared-lite` (a single shared instance). |
| `--headless` / `--no-headless` | Headless (default) vs. visible browser window. |
| `--block-tools=t1,t2` | Hide the named upstream tools from clients. |
| `--allow-only=t1,t2` | Inverse: expose **only** these tools (wins over `--block-tools`). |
| `--init-script=<path>` | JS module exporting custom MCP tool definitions to register. |
| `--chrome-arg=<arg>` | Append a raw Chrome launch arg (repeatable). |
| `--no-chrome` | Don't manage a browser; connect to an existing one via `--browser-url`. |
| `--browser-url=<url>` | CDP endpoint of an externally managed Chrome (with `--no-chrome`). |
| `--debug` | Verbose wrapper logging (or `DEBUG=wrapper:*`). |
| `-- <args>` | Anything after `--` is passed through to the upstream server verbatim. |

### Profiles

A profile is a Chrome user-data directory plus a lock file. Clients that agree on a profile name share its browser; different profiles mean different browsers (useful to isolate work projects from personal ones, or headed from headless).

- `--profile=work` and `--profile=personal` → two independent Chrome instances
- no flag → `shared-lite`, one instance for everything
- profile state (lock files, user-data dirs) lives under `~/.cache/cdp-wrapper/`

## Upstream version policy

The wrapper launches the upstream server with `npx chrome-devtools-mcp@latest` and currently passes `--experimentalPageIdRouting` / `--experimentalStructuredContent`. This means:

- upstream fixes and features arrive automatically; no version pin to maintain
- **but** an upstream breaking change to those experimental flags can break the wrapper on a fresh `npx` fetch. If you need stability, change `upstreamArgs` in `index.mjs` to a pinned version (`chrome-devtools-mcp@1.8.0`).

## Logging

Each session writes `~/.cache/cdp-wrapper/logs/wrapper-YYYYMMDD-HHMMSS-<pid>.log` (path also printed to stderr at startup). Tunables via environment:

| Var | Default | Meaning |
|---|---|---|
| `LOG_DIR` | `~/.cache/cdp-wrapper/logs` | log directory |
| `LOG_MAX_BYTES` | 10485760 | rotate threshold per file |
| `LOG_MAX_FILES` | 5 | rotated files kept per session |
| `LOG_RATE_LIMIT_COUNT` / `LOG_RATE_LIMIT_WINDOW_MS` | 200 / 1000 | write-rate circuit breaker |
| `DEBUG` | — | `wrapper:*` for wrapper-only, `*` for everything |

## Notes & disclaimers

- The anti-detect layer exists to keep automation from being *needlessly* flagged while testing your own sites and apps. Using it against services you don't have permission to automate may violate their terms of service — that's on you.
- The wrapper is a transparent pass-through for MCP traffic; it does not inspect or alter tool results beyond dropping filtered tools.

## License

[MIT](LICENSE)
