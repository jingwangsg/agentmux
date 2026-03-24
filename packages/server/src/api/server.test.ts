import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import { AgentMuxDatabase } from '../db/database.js';
import { FakeAdapter, createTempDir } from '../test/helpers.js';
import { ConversationManager } from '../runtime/manager.js';
import type { RuntimeAdapter } from '../runtime/adapter.js';
import type { BackendType } from '../types.js';

function buildApp() {
  const dir = createTempDir('agentmux-api-');
  const db = new AgentMuxDatabase(path.join(dir, 'test.sqlite3'));
  const adapters = new Map<BackendType, RuntimeAdapter>([
    ['codex', new FakeAdapter('codex')],
    ['claude', new FakeAdapter('claude')],
  ]);
  const manager = new ConversationManager(db, adapters, () => undefined);
  return createServer(manager).app;
}

describe('HTTP API', () => {
  it('creates and lists conversations', async () => {
    const app = buildApp();

    const createResponse = await request(app)
      .post('/api/conversations')
      .send({ backend: 'codex' })
      .expect(201);

    expect(createResponse.body.conversation.backend).toBe('codex');

    const listResponse = await request(app)
      .get('/api/conversations')
      .expect(200);

    expect(listResponse.body.conversations).toHaveLength(1);
  });

  it('accepts messages and returns events', async () => {
    const app = buildApp();
    const createResponse = await request(app)
      .post('/api/conversations')
      .send({ backend: 'claude' })
      .expect(201);

    const conversationId = createResponse.body.conversation.id;

    await request(app)
      .post(`/api/conversations/${conversationId}/messages`)
      .send({ content: 'ping' })
      .expect(202);

    const eventsResponse = await request(app)
      .get(`/api/conversations/${conversationId}/events`)
      .expect(200);

    const eventTypes = eventsResponse.body.events.map((event: { type: string }) => event.type);
    expect(eventTypes).toContain('message.user');
    expect(eventTypes).toContain('message.assistant.final');
  });

  it('accepts rewind requests', async () => {
    const app = buildApp();
    const createResponse = await request(app)
      .post('/api/conversations')
      .send({ backend: 'codex' })
      .expect(201);

    const conversationId = createResponse.body.conversation.id;

    await request(app)
      .post(`/api/conversations/${conversationId}/rewind`)
      .send({ message: 'edited prompt' })
      .expect(202);
  });
});
