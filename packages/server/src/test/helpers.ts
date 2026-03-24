import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import type { RuntimeAdapter, RuntimeEventSink } from '../runtime/adapter.js';
import type { ConversationRecord } from '../types.js';

export function createTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export class FakeAdapter implements RuntimeAdapter {
  public readonly backend: 'codex' | 'claude';
  public sentMessages: Array<{ conversationId: string; content: string }> = [];
  public cancelled: string[] = [];
  public resumed: string[] = [];
  public responses: Array<{ conversationId: string; payload: Record<string, unknown> }> = [];
  public rewinds: Array<{ conversationId: string; payload: Record<string, unknown> }> = [];

  public constructor(backend: 'codex' | 'claude') {
    this.backend = backend;
  }

  public async sendMessage(conversation: ConversationRecord, content: string, sink: RuntimeEventSink): Promise<void> {
    this.sentMessages.push({ conversationId: conversation.id, content });
    sink.emitDelta(conversation.id, `delta:${content}`);
    sink.emitFinal(conversation.id, `final:${content}`);
    sink.emitState(conversation.id, 'completed');
  }

  public async resume(conversation: ConversationRecord, sink: RuntimeEventSink): Promise<void> {
    this.resumed.push(conversation.id);
    sink.emitState(conversation.id, 'idle', 'fake resumed');
  }

  public async cancel(conversationId: string): Promise<void> {
    this.cancelled.push(conversationId);
  }

  public async respond(conversationId: string, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void> {
    this.responses.push({ conversationId, payload });
    sink.emitState(conversationId, 'running', 'fake respond');
  }

  public async rewind(conversation: ConversationRecord, payload: Record<string, unknown>, sink: RuntimeEventSink): Promise<void> {
    this.rewinds.push({ conversationId: conversation.id, payload });
    sink.emitState(conversation.id, 'running', 'fake rewind');
    sink.emitFinal(conversation.id, 'rewind complete');
  }
}
