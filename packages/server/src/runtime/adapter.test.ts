import { describe, expect, it } from 'vitest';
import type { RuntimeAdapter, RuntimeEventSink } from './adapter.js';
import type { ConversationRecord } from '../types.js';

describe('adapter contracts', () => {
  it('supports a minimal runtime sink shape', () => {
    const sink: RuntimeEventSink = {
      emitDelta: () => undefined,
      emitFinal: () => undefined,
      emitState: () => undefined,
      emitInteractiveRequest: () => undefined,
      emitToolCall: () => undefined,
      emitToolOutput: () => undefined,
      emitApprovalRequest: () => undefined,
      emitError: () => undefined,
    };
    expect(typeof sink.emitFinal).toBe('function');
  });

  it('supports a minimal runtime adapter shape', async () => {
    const conversation: ConversationRecord = {
      id: 'c1',
      backend: 'codex',
      title: 'Test',
      runtimeState: 'idle',
      cwd: null,
      config: {},
      resumeHandle: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastRuntimeStartedAt: null,
      lastRuntimeStoppedAt: null,
    };

    const adapter: RuntimeAdapter = {
      backend: 'codex',
      sendMessage: async () => undefined,
      resume: async () => undefined,
      cancel: async () => undefined,
      respond: async () => undefined,
      rewind: async () => undefined,
    };

    await adapter.resume(conversation, {
      emitDelta: () => undefined,
      emitFinal: () => undefined,
      emitState: () => undefined,
      emitInteractiveRequest: () => undefined,
      emitToolCall: () => undefined,
      emitToolOutput: () => undefined,
      emitApprovalRequest: () => undefined,
      emitError: () => undefined,
    });

    expect(adapter.backend).toBe('codex');
  });
});
