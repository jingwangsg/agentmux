import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentMuxDatabase } from '../db/database.js';
import { FakeAdapter, createTempDir } from '../test/helpers.js';
import { ConversationManager } from './manager.js';
import type { RuntimeAdapter } from './adapter.js';
import type { BackendType, StoredEvent } from '../types.js';

function setup() {
  const dir = createTempDir('agentmux-manager-');
  const db = new AgentMuxDatabase(path.join(dir, 'test.sqlite3'));
  const codex = new FakeAdapter('codex');
  const claude = new FakeAdapter('claude');
  const seen: StoredEvent[] = [];
  const adapters = new Map<BackendType, RuntimeAdapter>([
    ['codex', codex],
    ['claude', claude],
  ]);
  const manager = new ConversationManager(db, adapters, (event) => seen.push(event));
  return { manager, codex, claude, seen };
}

describe('ConversationManager', () => {
  it('creates a conversation and persists the creation event', () => {
    const { manager, seen } = setup();
    const conversation = manager.createConversation({ backend: 'codex' });

    expect(conversation.backend).toBe('codex');
    expect(manager.listConversations()).toHaveLength(1);
    expect(seen.some((event) => event.type === 'conversation.created')).toBe(true);
  });

  it('sends a message through adapter and persists events', async () => {
    const { manager, codex } = setup();
    const conversation = manager.createConversation({ backend: 'codex' });

    await manager.sendMessage(conversation.id, 'hello');

    expect(codex.resumed).toContain(conversation.id);
    expect(codex.sentMessages).toEqual([{ conversationId: conversation.id, content: 'hello' }]);

    const events = manager.getEvents(conversation.id);
    expect(events.map((event) => event.type)).toContain('message.user');
    expect(events.map((event) => event.type)).toContain('message.assistant.final');
  });

  it('handles cancellation and interactive response', async () => {
    const { manager, claude } = setup();
    const conversation = manager.createConversation({ backend: 'claude' });

    await manager.control(conversation.id, { action: 'cancel' });
    expect(claude.cancelled).toContain(conversation.id);

    await manager.respond(conversation.id, { decision: 'approve' });
    expect(claude.responses).toEqual([{ conversationId: conversation.id, payload: { decision: 'approve' } }]);
  });

  it('delegates rewind to adapter and records the request', async () => {
    const { manager, codex } = setup();
    const conversation = manager.createConversation({ backend: 'codex' });

    await manager.rewind(conversation.id, { message: 'edited prompt' });

    expect(codex.rewinds).toEqual([{ conversationId: conversation.id, payload: { message: 'edited prompt' } }]);
    expect(manager.getEvents(conversation.id).some((event) => event.type === 'conversation.updated')).toBe(true);
  });


  it('throws on unsupported interactive response backend implementation', async () => {
    const { manager } = setup();
    const conversation = manager.createConversation({ backend: 'claude' });

    const internal = manager as unknown as { adapters: Map<string, unknown> };
    const original = internal.adapters.get('claude');
    internal.adapters.set('claude', {
      backend: 'claude',
      sendMessage: async () => undefined,
      resume: async () => undefined,
      cancel: async () => undefined,
    });

    await expect(manager.respond(conversation.id, { decision: 'approve' })).rejects.toThrow(/Interactive responses are not supported/);
    internal.adapters.set('claude', original);
  });

  it('throws on unsupported rewind backend implementation', async () => {
    const { manager } = setup();
    const conversation = manager.createConversation({ backend: 'codex' });

    const internal = manager as unknown as { adapters: Map<string, unknown> };
    const original = internal.adapters.get('codex');
    internal.adapters.set('codex', {
      backend: 'codex',
      sendMessage: async () => undefined,
      resume: async () => undefined,
      cancel: async () => undefined,
    });

    await expect(manager.rewind(conversation.id, { message: 'x' })).rejects.toThrow(/Rewind is not supported/);
    internal.adapters.set('codex', original);
  });
});
