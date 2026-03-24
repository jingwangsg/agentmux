import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeCliAdapter } from './adapters/claudeCliAdapter.js';
import { CodexCliAdapter } from './adapters/codexCliAdapter.js';
import { createServer } from './api/server.js';
import { AgentMuxDatabase } from './db/database.js';
import { ConversationManager } from './runtime/manager.js';
import type { RuntimeAdapter } from './runtime/adapter.js';
import type { BackendType, StoredEvent } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../data/agentmux.sqlite3');
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';

const database = new AgentMuxDatabase(dbPath);
const adapters = new Map<BackendType, RuntimeAdapter>([
  ['codex', new CodexCliAdapter()],
  ['claude', new ClaudeCliAdapter()],
]);

let broadcast: (event: StoredEvent) => void = (_event) => {};
const conversationManager = new ConversationManager(database, adapters, (event) => broadcast(event));
const serverBundle = createServer(conversationManager);
broadcast = serverBundle.broadcastEvent;

serverBundle.server.listen(port, host, () => {
  console.log(`AgentMux v2 server listening on http://${host}:${port}`);
});
