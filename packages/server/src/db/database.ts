import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ConversationRecord, EventType, StoredEvent } from '../types.js';

export class AgentMuxDatabase {
  private readonly db: Database.Database;

  public constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        title TEXT NOT NULL,
        runtime_state TEXT NOT NULL,
        cwd TEXT,
        config_json TEXT NOT NULL,
        resume_handle_json TEXT,
        parent_conversation_id TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        agent_nickname TEXT,
        agent_role TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_runtime_started_at TEXT,
        last_runtime_stopped_at TEXT
      );

      CREATE TABLE IF NOT EXISTS conversation_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id)
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation_id_created_at
      ON conversation_events(conversation_id, created_at, id);
    `);

    // Migration: add subagent columns if missing
    try {
      this.db.prepare('SELECT parent_conversation_id FROM conversations LIMIT 0').get();
    } catch {
      this.db.exec(`
        ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT;
        ALTER TABLE conversations ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE conversations ADD COLUMN agent_nickname TEXT;
        ALTER TABLE conversations ADD COLUMN agent_role TEXT;
      `);
    }
  }

  public listConversations(): ConversationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM conversations
      ORDER BY updated_at DESC, created_at DESC
    `).all() as Array<Record<string, string | number | null>>;

    return rows.map((row) => this.mapConversation(row));
  }

  public listChildConversations(parentId: string): ConversationRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM conversations
      WHERE parent_conversation_id = ?
      ORDER BY created_at ASC
    `).all(parentId) as Array<Record<string, string | number | null>>;

    return rows.map((row) => this.mapConversation(row));
  }

  public getConversation(id: string): ConversationRecord | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as Record<string, string | number | null> | undefined;
    return row ? this.mapConversation(row) : null;
  }

  public createConversation(conversation: ConversationRecord): void {
    this.db.prepare(`
      INSERT INTO conversations (
        id, backend, title, runtime_state, cwd, config_json, resume_handle_json,
        parent_conversation_id, depth, agent_nickname, agent_role,
        created_at, updated_at, last_runtime_started_at, last_runtime_stopped_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.id,
      conversation.backend,
      conversation.title,
      conversation.runtimeState,
      conversation.cwd,
      JSON.stringify(conversation.config),
      conversation.resumeHandle ? JSON.stringify(conversation.resumeHandle) : null,
      conversation.parentConversationId,
      conversation.depth,
      conversation.agentNickname,
      conversation.agentRole,
      conversation.createdAt,
      conversation.updatedAt,
      conversation.lastRuntimeStartedAt,
      conversation.lastRuntimeStoppedAt,
    );
  }

  public updateConversation(conversation: ConversationRecord): void {
    this.db.prepare(`
      UPDATE conversations SET
        title = ?,
        runtime_state = ?,
        cwd = ?,
        config_json = ?,
        resume_handle_json = ?,
        parent_conversation_id = ?,
        depth = ?,
        agent_nickname = ?,
        agent_role = ?,
        updated_at = ?,
        last_runtime_started_at = ?,
        last_runtime_stopped_at = ?
      WHERE id = ?
    `).run(
      conversation.title,
      conversation.runtimeState,
      conversation.cwd,
      JSON.stringify(conversation.config),
      conversation.resumeHandle ? JSON.stringify(conversation.resumeHandle) : null,
      conversation.parentConversationId,
      conversation.depth,
      conversation.agentNickname,
      conversation.agentRole,
      conversation.updatedAt,
      conversation.lastRuntimeStartedAt,
      conversation.lastRuntimeStoppedAt,
      conversation.id,
    );
  }

  public appendEvent(event: StoredEvent): void {
    this.db.prepare(`
      INSERT INTO conversation_events (id, conversation_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.conversationId,
      event.type,
      JSON.stringify(event.payload),
      event.createdAt,
    );
  }

  public listEvents(conversationId: string, cursor?: string): StoredEvent[] {
    const rows = cursor
      ? this.db.prepare(`
          SELECT * FROM conversation_events
          WHERE conversation_id = ? AND created_at > ?
          ORDER BY created_at ASC, id ASC
        `).all(conversationId, cursor)
      : this.db.prepare(`
          SELECT * FROM conversation_events
          WHERE conversation_id = ?
          ORDER BY created_at ASC, id ASC
        `).all(conversationId);

    return (rows as Array<Record<string, string>>).map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      type: row.type as EventType,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  private mapConversation(row: Record<string, string | number | null>): ConversationRecord {
    return {
      id: String(row.id ?? ''),
      backend: (String(row.backend ?? 'codex')) as ConversationRecord['backend'],
      title: String(row.title ?? ''),
      runtimeState: (String(row.runtime_state ?? 'idle')) as ConversationRecord['runtimeState'],
      cwd: row.cwd != null ? String(row.cwd) : null,
      config: JSON.parse(String(row.config_json ?? '{}')),
      resumeHandle: row.resume_handle_json ? JSON.parse(String(row.resume_handle_json)) : null,
      parentConversationId: row.parent_conversation_id != null ? String(row.parent_conversation_id) : null,
      depth: typeof row.depth === 'number' ? row.depth : 0,
      agentNickname: row.agent_nickname != null ? String(row.agent_nickname) : null,
      agentRole: row.agent_role != null ? String(row.agent_role) : null,
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      lastRuntimeStartedAt: row.last_runtime_started_at != null ? String(row.last_runtime_started_at) : null,
      lastRuntimeStoppedAt: row.last_runtime_stopped_at != null ? String(row.last_runtime_stopped_at) : null,
    };
  }
}
