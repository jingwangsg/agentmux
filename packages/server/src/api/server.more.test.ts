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
  const dir = createTempDir('agentmux-api-more-');
  const db = new AgentMuxDatabase(path.join(dir, 'test.sqlite3'));
  const adapters = new Map<BackendType, RuntimeAdapter>([
    ['codex', new FakeAdapter('codex')],
    ['claude', new FakeAdapter('claude')],
  ]);
  const manager = new ConversationManager(db, adapters, () => undefined);
  return createServer(manager).app;
}

describe('HTTP API more branches', () => {
  it('returns 400 for invalid control payload', async () => {
    const app = buildApp();
    const createResponse = await request(app)
      .post('/api/conversations')
      .send({ backend: 'codex' })
      .expect(201);

    await request(app)
      .post(`/api/conversations/${createResponse.body.conversation.id}/control`)
      .send({ action: 'invalid' })
      .expect(400);
  });

  it('returns 400 for invalid rewind payload', async () => {
    const app = buildApp();
    const createResponse = await request(app)
      .post('/api/conversations')
      .send({ backend: 'claude' })
      .expect(201);

    await request(app)
      .post(`/api/conversations/${createResponse.body.conversation.id}/rewind`)
      .send({ dryRun: 'nope' })
      .expect(400);
  });

  it('returns 400 for invalid conversation create payload', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/conversations')
      .send({ backend: 'unknown' })
      .expect(400);

    expect(response.body.error).toBeTruthy();
  });
});
