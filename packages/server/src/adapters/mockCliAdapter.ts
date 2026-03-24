import type { RuntimeAdapter, RuntimeEventSink } from '../runtime/adapter.js';
import type { BackendType, ConversationRecord } from '../types.js';

const sleep = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class MockCliAdapter implements RuntimeAdapter {
  public readonly backend: BackendType;
  private readonly cancelled = new Set<string>();

  public constructor(backend: BackendType) {
    this.backend = backend;
  }

  public async sendMessage(conversation: ConversationRecord, content: string, sink: RuntimeEventSink): Promise<void> {
    this.cancelled.delete(conversation.id);
    sink.emitState(conversation.id, 'running');

    const prefix = this.backend === 'codex' ? 'Codex' : 'Claude';
    const chunks = [
      `${prefix} accepted the request. `,
      `This is the server-hosted ${this.backend} bridge. `,
      `Conversation ${conversation.id.slice(0, 8)} is alive on the server. `,
      `User said: ${content}`,
    ];

    let full = '';
    for (const chunk of chunks) {
      if (this.cancelled.has(conversation.id)) {
        sink.emitState(conversation.id, 'stopped', 'Cancelled by user');
        return;
      }
      full += chunk;
      sink.emitDelta(conversation.id, chunk);
      await sleep(180);
    }

    sink.emitFinal(conversation.id, full);
    sink.emitState(conversation.id, 'completed');
  }

  public async resume(conversation: ConversationRecord, sink: RuntimeEventSink): Promise<void> {
    sink.emitState(conversation.id, 'starting', 'Resuming runtime');
    await sleep(250);
    sink.emitState(conversation.id, 'idle', 'Runtime resumed lazily');
  }

  public async cancel(conversationId: string): Promise<void> {
    this.cancelled.add(conversationId);
  }
}
