import path from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createServer } from './server.js';
import { AgentMuxDatabase } from '../db/database.js';
import { FakeAdapter, createTempDir } from '../test/helpers.js';
import { ConversationManager } from '../runtime/manager.js';
import type { RuntimeAdapter } from '../runtime/adapter.js';
import type { BackendType } from '../types.js';

function buildServer() {
  const dir = createTempDir('agentmux-ws-');
  const db = new AgentMuxDatabase(path.join(dir, 'test.sqlite3'));
  const codex = new FakeAdapter('codex');
  const claude = new FakeAdapter('claude');
  const adapters = new Map<BackendType, RuntimeAdapter>([
    ['codex', codex],
    ['claude', claude],
  ]);
  const manager = new ConversationManager(db, adapters, () => undefined);
  const bundle = createServer(manager);
  return { ...bundle, manager, codex, claude };
}

describe('WebSocket API', () => {
  it('streams subscribed conversation events', async () => {
    const { server, manager } = buildServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server failed to bind');
    }

    const conversation = manager.createConversation({ backend: 'codex' });
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await once(socket, 'open');

    const messages: string[] = [];
    socket.on('message', (data) => messages.push(String(data)));

    socket.send(JSON.stringify({ type: 'subscribe_conversation', conversationId: conversation.id }));
    await manager.sendMessage(conversation.id, 'hello');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages.some((message) => message.includes('conversation.snapshot'))).toBe(true);
    expect(messages.some((message) => message.includes('message.assistant.final'))).toBe(true);

    socket.close();
    server.close();
  });

  it('handles interactive_response over websocket', async () => {
    const { server, manager, claude } = buildServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server failed to bind');
    }

    const conversation = manager.createConversation({ backend: 'claude' });
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await once(socket, 'open');

    socket.send(JSON.stringify({
      type: 'interactive_response',
      conversationId: conversation.id,
      payload: { decision: 'approve' },
    }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claude.responses).toEqual([{ conversationId: conversation.id, payload: { decision: 'approve' } }]);

    socket.close();
    server.close();
  });
});
