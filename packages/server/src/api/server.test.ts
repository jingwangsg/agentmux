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

  it('returns config options and updates conversation config', async () => {
    const app = buildApp();

    const optionsResponse = await request(app)
      .get('/api/backends/codex/config-options')
      .expect(200);

    expect(optionsResponse.body.backend).toBe('codex');
    expect(optionsResponse.body.candidates.model.length).toBeGreaterThan(0);
    expect(optionsResponse.body.candidates.mode.map((candidate: { value: string }) => candidate.value)).toEqual(
      expect.arrayContaining(['default', 'plan', 'auto-accept']),
    );

    const createResponse = await request(app)
      .post('/api/conversations')
      .send({ backend: 'codex' })
      .expect(201);

    const conversationId = createResponse.body.conversation.id;

    const updateResponse = await request(app)
      .patch(`/api/conversations/${conversationId}/config`)
      .send({ config: { model: 'gpt-5.4-mini', reasoningEffort: 'high', mode: 'plan' } })
      .expect(200);

    expect(updateResponse.body.conversation.config.model).toBe('gpt-5.4-mini');
    expect(updateResponse.body.conversation.config.reasoningEffort).toBe('high');
    expect(updateResponse.body.conversation.config.mode).toBe('plan');
  });
});


describe('Backend config option variants', () => {
  it('returns claude native mode candidates', async () => {
    const app = buildApp();

    const response = await request(app)
      .get('/api/backends/claude/config-options')
      .expect(200);

    expect(response.body.backend).toBe('claude');
    expect(response.body.defaults.reasoningEffort).toBeTruthy();
    expect(response.body.candidates.reasoningEffort.length).toBeGreaterThan(0);
    expect(response.body.candidates.mode.map((candidate: { value: string }) => candidate.value)).toEqual(
      expect.arrayContaining(['default', 'plan', 'acceptEdits', 'bypassPermissions']),
    );
  });
});
