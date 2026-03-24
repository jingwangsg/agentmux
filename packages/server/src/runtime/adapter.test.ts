import { describe, expect, it } from 'vitest';
import type { RuntimeAdapter, RuntimeEventSink } from './adapter.js';
import type { ConversationRecord } from '../types.js';

function createMinimalSink(): RuntimeEventSink {
  return {
    emitDelta: () => undefined,
    emitFinal: () => undefined,
    emitState: () => undefined,
    emitInteractiveRequest: () => undefined,
    emitToolCall: () => undefined,
    emitToolOutput: () => undefined,
    emitToolResult: () => undefined,
    emitPlanMessage: () => undefined,
    emitCodexItem: () => undefined,
    emitCodexRequest: () => undefined,
    emitClaudeStep: () => undefined,
    emitApprovalRequest: () => undefined,
    emitError: () => undefined,
    emitResumeHandle: () => undefined,
    emitTitleUpdate: () => undefined,
    emitTokenUsage: () => undefined,
  };
}

describe('adapter contracts', () => {
  it('supports a minimal runtime sink shape', () => {
    const sink = createMinimalSink();
    expect(typeof sink.emitFinal).toBe('function');
    expect(typeof sink.emitResumeHandle).toBe('function');
    expect(typeof sink.emitTitleUpdate).toBe('function');
    expect(typeof sink.emitTokenUsage).toBe('function');
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

    await adapter.resume(conversation, createMinimalSink());
    expect(adapter.backend).toBe('codex');
  });
});
