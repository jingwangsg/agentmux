# AgentMux v2

AgentMux v2 is a persistent server + web UI for long-lived Codex and Claude Code conversations.

The server owns all conversations and runtime processes. Frontends can disconnect and reconnect without killing the underlying agent process. Conversation metadata and event history are persisted locally.

## Current status

### Working today

- Persistent conversation list stored in SQLite
- Chat-style web UI
- Real local `codex app-server` process integration
- Real local `claude` CLI process integration
- WebSocket event streaming from server to UI
- Interactive request / approval event plumbing
- Rewind endpoint and basic UI trigger
- Server test suite with coverage

### Still incomplete

This project is not yet full parity with the reversed VS Code extensions.

Known gaps include:

- Codex live output parsing is still incomplete for some item-level notifications
- Claude rewind flow is wired but not yet fully parity-validated end-to-end
- Web UI currently has no automated tests
- Live smoke tests are manual right now
- Some protocol semantics are still simplified compared with the original extensions

## Prerequisites

You should have both CLIs installed and already authenticated on the machine that runs the server.

Examples:

- `codex`
- `claude`

You can quickly verify:

```bash
codex --version
claude --version
```

## Install

From the repo root:

```bash
npm install
```

## Run

### Start both server and web UI

```bash
npm run dev
```

### Start server only

```bash
npm run dev -w @agentmux/server
```

### Start web only

```bash
npm run dev -w @agentmux/web
```

## Default addresses

- Server: `http://localhost:3001`
- Web: `http://localhost:5173`
- WebSocket: `ws://localhost:3001/ws`

## Environment variables

### Server

- `HOST` — server bind host, default `0.0.0.0`
- `PORT` — server port, default `3001`

### Claude

- `CLAUDE_CODE_EXECUTABLE` — override the `claude` binary path

### Codex

- `CODEX_APP_SERVER_EXECUTABLE` — override the `codex` binary path
- `CODEX_APP_SERVER_SUBCOMMAND` — override the subcommand, default `app-server`

## How to use

1. Start the server and web UI.
2. Open the web UI in your browser.
3. Create a new `Codex` or `Claude` conversation from the sidebar.
4. Send a message in the composer.
5. Use `Resume`, `Retry`, or `Cancel` from the header controls when needed.
6. Use `Rewind From Here` on the latest user message to trigger a rewind flow.

## Tests

### Server tests

```bash
npm run test -w @agentmux/server
```

Current server coverage is measured with Vitest coverage.

## Build

```bash
npm run build
```

Or package-by-package:

```bash
npm run build -w @agentmux/server
npm run build -w @agentmux/web
```

## Repository layout

- `packages/server` — persistent runtime host, HTTP API, WebSocket API, SQLite persistence
- `packages/web` — React/Vite web UI

## Important behavior

- The server owns runtime processes.
- Frontend disconnects do not kill the underlying agent runtime.
- Conversation metadata and event history persist across server restarts.
- Runtime processes themselves are currently resumed lazily and may need backend-specific recovery.

## Known limitations

- Codex currently still surfaces some raw notification payloads as deltas instead of fully structured message items.
- Claude and Codex rewind support are implemented, but semantic parity is still in progress.
- Live CLI integration works, but some advanced flows still need more protocol work.

## Recommended workflow

For development, keep one terminal running server tests and one terminal running the app:

```bash
npm run test -w @agentmux/server
npm run dev
```

If you are debugging real backend behavior, it is useful to test with a dedicated server port:

```bash
PORT=3210 npm run dev -w @agentmux/server
```

## Next milestones

- Improve live Codex item-level output parsing
- Add web UI automated tests
- Expand live smoke coverage for real `codex` and `claude`
- Continue closing parity gaps with the reversed extensions
