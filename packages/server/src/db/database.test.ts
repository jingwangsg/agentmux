import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentMuxDatabase } from './database.js';
import { createTempDir } from '../test/helpers.js';

describe('AgentMuxDatabase', () => {
  it('creates, updates, and lists conversations', () => {
    const dir = createTempDir('agentmux-db-');
    const db = new AgentMuxDatabase(path.join(dir, 'test.sqlite3'));

    db.createConversation({
      id: 'c1',
      backend: 'codex',
      title: 'Test',
      runtimeState: 'idle',
      cwd: null,
      config: {},
      resumeHandle: { backend: 'codex' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastRuntimeStartedAt: null,
      lastRuntimeStoppedAt: null,
    });

    const conversation = db.getConversation('c1');
    expect(conversation?.title).toBe('Test');

    db.updateConversation({
      ...conversation!,
      title: 'Updated',
      runtimeState: 'running',
      updatedAt: '2026-01-01T00:01:00.000Z',
      lastRuntimeStartedAt: '2026-01-01T00:01:00.000Z',
    });

    const listed = db.listConversations();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe('Updated');
    expect(listed[0]?.runtimeState).toBe('running');
  });

  it('stores and returns ordered events', () => {
    const dir = createTempDir('agentmux-db-');
    const db = new AgentMuxDatabase(path.join(dir, 'test.sqlite3'));

    db.createConversation({
      id: 'c1',
      backend: 'claude',
      title: 'Test',
      runtimeState: 'idle',
      cwd: null,
      config: {},
      resumeHandle: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastRuntimeStartedAt: null,
      lastRuntimeStoppedAt: null,
    });

    db.appendEvent({ id: 'e1', conversationId: 'c1', type: 'message.user', payload: { content: 'a' }, createdAt: '2026-01-01T00:00:01.000Z' });
    db.appendEvent({ id: 'e2', conversationId: 'c1', type: 'message.assistant.final', payload: { content: 'b' }, createdAt: '2026-01-01T00:00:02.000Z' });

    const events = db.listEvents('c1');
    expect(events.map((event) => event.id)).toEqual(['e1', 'e2']);

    const cursorEvents = db.listEvents('c1', '2026-01-01T00:00:01.500Z');
    expect(cursorEvents.map((event) => event.id)).toEqual(['e2']);
  });
});
