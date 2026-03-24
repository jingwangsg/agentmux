import path from 'node:path';
import request from 'supertest';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createServer } from './server.js';
import { AgentMuxDatabase } from '../db/database.js';
import { FakeAdapter, createTempDir } from '../test/helpers.js';
import { ConversationManager } from '../runtime/manager.js';
import type { RuntimeAdapter } from '../runtime/adapter.js';
import type { BackendType } from '../types.js';

function buildBundle() {
  const dir = createTempDir('agentmux-api-error-');
  const db = new AgentMuxDatabase(path.join(dir, 'test.sqlite3'));
  const adapters = new Map<BackendType, RuntimeAdapter>([
    ['codex', new FakeAdapter('codex')],
    ['claude', new FakeAdapter('claude')],
  ]);
  const manager = new ConversationManager(db, adapters, () => undefined);
  return createServer(manager);
}

describe('HTTP and WS error handling', () => {
  it('returns 404 for missing conversations', async () => {
    const { app } = buildBundle();

    await request(app).get('/api/conversations/missing').expect(404);
    await request(app).get('/api/conversations/missing/events').expect(404);
  });

  it('returns 400 for invalid message payload', async () => {
    const { app } = buildBundle();
    const createResponse = await request(app)
      .post('/api/conversations')
      .send({ backend: 'codex' })
      .expect(201);

    await request(app)
      .post(`/api/conversations/${createResponse.body.conversation.id}/messages`)
      .send({ content: '' })
      .expect(400);
  });

  it('emits websocket error on invalid payload', async () => {
    const bundle = buildBundle();
    await new Promise<void>((resolve) => bundle.server.listen(0, '127.0.0.1', () => resolve()));
    const address = bundle.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server failed to bind');
    }

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await once(socket, 'open');

    const messages: string[] = [];
    socket.on('message', (data) => messages.push(String(data)));

    socket.send('not-json');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages.some((message) => message.includes('\"type\":\"error\"'))).toBe(true);

    socket.close();
    bundle.server.close();
  });
});
