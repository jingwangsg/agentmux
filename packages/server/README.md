# AgentMux Server

> A local-first backend for multi-agent conversations, real-time streaming, and resumable AI runtime sessions.

AgentMux Server is the backend service for AgentMux v2. It exposes a clean HTTP API and a live WebSocket stream for managing conversations powered by multiple CLI-backed AI runtimes.

This package is designed to sit between a UI client and backend runtimes such as Codex CLI and Claude CLI, while persisting conversation state and event history to SQLite.

## Highlights

- **Multi-backend runtime orchestration** for `codex` and `claude`
- **Real-time event streaming** over WebSocket
- **Local SQLite persistence** with append-only conversation events
- **Resumable runtime sessions** with stored resume handles and lifecycle state
- **Subagent-ready data model** with parent/child conversation hierarchy
- **Strict TypeScript + Zod validation** across transport boundaries

## What It Does

AgentMux Server provides four core capabilities:

1. **Conversation management**  
   Create, list, inspect, update, and organize conversations.

2. **Runtime control**  
   Send messages, cancel active runs, retry, resume sessions, and rewind supported conversations.

3. **Live streaming**  
   Subscribe over WebSocket to receive snapshots and incremental events as runs progress.

4. **Durable history**  
   Persist conversation metadata and event logs locally for replay, UI hydration, and recovery.

## Architecture

The server is organized into a few focused layers:

- **API layer** — Express routes plus a WebSocket server for request/response and live subscriptions
- **Runtime manager** — coordinates conversation lifecycle, adapter selection, event persistence, and broadcasting
- **Adapters** — backend-specific bridges for Codex CLI, Claude CLI, and test/dev mocks
- **Database** — SQLite storage for conversations and append-only event history
- **Shared types** — strongly typed runtime states, events, requests, and conversation records

### Runtime Flow

```text
Client UI
  ├─ HTTP: create conversation / send message / control run
  └─ WS: subscribe to conversation events

AgentMux Server
  ├─ API server
  ├─ ConversationManager
  ├─ RuntimeAdapter (Codex / Claude / Mock)
  └─ SQLite database

Backend CLI Runtime
  └─ streams events back into the manager
```

## Key Features

### Multi-backend support

The runtime abstraction allows AgentMux to present a consistent server API while adapting to backend-specific runtime behavior.

- **Codex CLI adapter** handles protocol-heavy runtime integration, request/response flows, title updates, and token usage events
- **Claude CLI adapter** maps Claude-style streaming and interactive flows into the shared event model
- **Mock adapter** provides a deterministic in-memory runtime for development and tests

### Real-time WebSocket updates

Clients connect to `/ws` and can subscribe to specific conversations.

On subscription, the server sends:

- `server.ready`
- `conversation.snapshot`
- ongoing `conversation.event` messages as new events arrive

The WebSocket layer also supports live actions such as sending messages, runtime control, and interactive responses.

### Durable event history

Conversation state is stored in SQLite, with event history appended separately for replayable timelines.

This design makes it easy to:

- rebuild UI state from stored events
- reconnect clients and replay missed updates
- recover runtime context after restarts
- support parent/child conversation relationships for subagents

## API Overview

### REST endpoints

- `GET /health`
- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/conversations/:id`
- `PATCH /api/conversations/:id`
- `PATCH /api/conversations/:id/config`
- `GET /api/conversations/:id/children`
- `GET /api/conversations/:id/events`
- `POST /api/conversations/:id/messages`
- `POST /api/conversations/:id/rewind`
- `POST /api/conversations/:id/control`
- `GET /api/backends/:backend/config-options`

### WebSocket endpoint

- `WS /ws`

Supported client message types include:

- `subscribe_conversation`
- `unsubscribe_conversation`
- `send_message`
- `control`
- `interactive_response`

## Data Model

The server tracks rich conversation metadata including:

- backend type
- runtime state
- working directory
- backend config
- resume handle
- lifecycle timestamps
- parent conversation linkage
- subagent nickname and role

Event history includes conversation creation, message flow, run lifecycle updates, tool events, approval requests, backend-specific runtime signals, token usage, and subagent lifecycle events.

## Getting Started

### Prerequisites

- Node.js with ESM support
- npm or a compatible package manager
- Codex CLI and/or Claude CLI available in your environment if you want real runtime execution

### Install

```bash
npm install
```

### Run in development

```bash
npm run dev
```

The server starts on:

- `HOST=0.0.0.0` by default
- `PORT=3001` by default

SQLite data is stored under `data/agentmux.sqlite3` relative to the package output layout.

### Build

```bash
npm run build
```

### Start production build

```bash
npm run start
```

## Configuration Notes

Backend-specific configuration is normalized centrally before runtime execution.

Current backend families:

- `codex`
- `claude`

The server also exposes backend config candidates so a client can build backend-aware configuration UIs without hardcoding options.

## Testing

This package includes focused test coverage for:

- REST API behavior
- WebSocket subscription and streaming flows
- runtime manager orchestration
- adapter integration behavior
- database persistence
- error handling paths

Run the full test suite with coverage:

```bash
npm test
```

## Why This Release Matters

This release establishes the core server foundation for AgentMux v2:

- a stable multi-runtime control plane
- a durable event-sourced conversation backend
- a real-time streaming interface for interactive clients
- a storage model that already anticipates nested subagent workflows

It is small, pragmatic, and ready to power higher-level UX on top.

## Tech Stack

- TypeScript
- Express
- WebSocket (`ws`)
- SQLite via `better-sqlite3`
- Zod
- Vitest

## Project Status

This package is currently configured as a private package for repository use, making it a strong fit for GitHub releases and internal distribution while the interface continues to evolve.

---

Built for local-first, runtime-aware, multi-agent workflows.
