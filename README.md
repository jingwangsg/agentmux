# AgentMux v2

> Persistent, server-managed Codex and Claude conversations with a polished local web UI.

AgentMux v2 turns short-lived CLI chats into durable, reconnectable workspaces. The server owns the conversation state, runtime coordination, and event history, while the web app gives you a clean chat interface for browsing, resuming, and steering long-running agent sessions.

If your browser disconnects, refreshes, or moves to another machine on the same network, the conversation record stays intact on the server. That makes AgentMux useful for real work instead of disposable demo chats.

---

## Why AgentMux exists

Typical local AI chat wrappers are tightly coupled to the browser tab or terminal session that launched them. AgentMux separates those concerns:

- **Persistent conversation host** — the server owns conversations, metadata, and event history
- **Local-first architecture** — data is stored on your machine in SQLite
- **Dual backend support** — works with both `codex` and `claude`
- **Reconnectable UI** — frontends can disconnect and reconnect without losing the thread record
- **Live event streaming** — REST for CRUD + WebSocket for realtime conversation updates
- **Human-in-the-loop flows** — approval, question, retry, resume, cancel, and rewind hooks are wired into the UI

This repo is already useful today, while still being honest about the remaining parity work.

## Highlights

### Persistent runtime host

The backend is a TypeScript server that manages conversations as first-class records instead of ephemeral browser state.

- Stores conversations and append-only event history in SQLite
- Tracks runtime state, config, resume handles, and conversation lineage
- Exposes a clean HTTP API plus a WebSocket stream for live updates
- Supports subagent and child-conversation metadata for branching workflows

### Web UI built for active sessions

The React/Vite frontend is more than a thin demo shell.

- Chat-style interface for `Codex` and `Claude`
- Sidebar conversation switching and creation
- Inline rename support
- Realtime connection status badge
- Runtime status banners and control actions
- Theme switching
- Markdown rendering with syntax highlighting
- Rewind actions on user messages
- Background subagent status panel

### Real CLI-backed integrations

AgentMux talks to real local CLIs rather than mocked browser-only backends.

- `codex` integration through the local app-server flow
- `claude` integration through the local CLI
- Adapter layer normalizes backend-specific events into a shared timeline model
- Interactive requests and approvals are surfaced to the UI

## Current status

### Working now

- Persistent conversation list stored in SQLite
- Durable event history per conversation
- Real local `codex` integration
- Real local `claude` integration
- REST API for conversation management
- WebSocket streaming for live updates
- Resume / retry / cancel control flow
- Rewind endpoint and UI trigger
- Server test suite with coverage
- Smoke and end-to-end scripts for live validation

### Still in progress

AgentMux is not yet full parity with the reversed VS Code extension behavior.

Known gaps include:

- Codex item-level live output parsing is still incomplete in places
- Claude rewind behavior is wired, but parity is still being validated end to end
- Some protocol semantics are intentionally simplified
- Web UI does not yet have its own automated test suite
- Runtime recovery still depends on backend-specific resume behavior
- A few advanced flows remain rougher than the core chat loop

That said, the core architecture is already solid: conversations persist, events stream live, and the system is structured for iterative improvement rather than rewrite churn.

## Architecture at a glance

```text
packages/server
  ├─ Express HTTP API
  ├─ WebSocket event server
  ├─ Conversation manager
  ├─ Codex / Claude runtime adapters
  └─ SQLite persistence

packages/web
  ├─ React + Vite UI
  ├─ REST client
  ├─ Reconnecting WebSocket client
  ├─ Timeline normalization
  └─ Chat + subagent interface
```

### Server responsibilities

The server is the heart of the system.

- Creates and stores conversations
- Persists append-only events
- Starts, resumes, and controls backend runtimes
- Forwards live runtime events to subscribed clients
- Handles interactive responses from the UI
- Maintains parent/child conversation metadata for branching flows

### Frontend responsibilities

The web app focuses on operator experience.

- Lists and opens conversations
- Loads historical event timelines
- Subscribes to live updates over WebSocket
- Renders backend-specific events into readable chat artifacts
- Sends new messages, control actions, config updates, and rewind requests
- Surfaces background agent activity in a compact subagent panel

## Prerequisites

You should have the relevant CLIs installed and authenticated on the same machine that runs the AgentMux server.

Examples:

- `codex`
- `claude`

Quick verification:

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

### Start server and web UI together

```bash
npm run dev
```

### Start only the server

```bash
npm run dev -w @agentmux/server
```

### Start only the web app

```bash
npm run dev -w @agentmux/web
```

## Default addresses

- Server: `http://localhost:3001`
- Web: `http://localhost:5173`
- WebSocket: `ws://localhost:3001/ws`

## Environment variables

### Server

- `HOST` — bind host, default `0.0.0.0`
- `PORT` — bind port, default `3001`

### Claude

- `CLAUDE_CODE_EXECUTABLE` — override the `claude` binary path

### Codex

- `CODEX_APP_SERVER_EXECUTABLE` — override the `codex` binary path
- `CODEX_APP_SERVER_SUBCOMMAND` — override the subcommand, default `app-server`

## Typical workflow

1. Start the server and UI.
2. Open the web app in your browser.
3. Create a new `Codex` or `Claude` conversation.
4. Send a prompt from the composer.
5. Use `Resume`, `Retry`, or `Cancel` as needed.
6. Use rewind on a prior user message to branch or restart from an earlier point.
7. Reconnect later and continue from the persisted conversation history.

## Validation

### Server tests

```bash
npm run test -w @agentmux/server
```

### Full workspace build

```bash
npm run build
```

### Smoke test

```bash
npm run smoke
```

### End-to-end scripts

```bash
npm run e2e
```

## Repository layout

- `packages/server` — persistent runtime host, HTTP API, WebSocket API, SQLite persistence
- `packages/web` — React/Vite user interface
- `scripts` — smoke tests and end-to-end helpers

## Important caveats

- The top-level automated `test` script currently covers the server package only
- Web automation exists in `scripts/e2e`, but the web app does not yet have a dedicated test suite
- Some live validation scripts assume the app is already running on the default local ports
- Current browser automation helpers are tuned to a specific local environment and may need adjustment on another machine

## Why this release is interesting

AgentMux v2 is already demonstrating the right shape for a serious local agent workstation:

- persistent state instead of fragile tab state
- real backend runtimes instead of toy chat mocks
- reconnectable web UI instead of one-shot terminal coupling
- structured event history instead of plain transcript dumps
- an architecture that can grow toward deeper backend parity

If you want a local-first foundation for durable Codex and Claude sessions, this repo is already a strong base.

## Next milestones

- Improve Codex item-level output normalization
- Expand Claude parity validation for rewind and control flows
- Add automated tests for the web UI
- Harden live smoke and E2E coverage across environments
- Continue closing protocol gaps with the reversed extensions
