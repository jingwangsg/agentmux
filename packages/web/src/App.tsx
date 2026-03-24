import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  controlConversation,
  createConversation,
  createReconnectingSocket,
  getConfigOptions,
  listConversations,
  listEvents,
  renameConversation,
  rewindConversation,
  sendMessage,
  updateConversationConfig,
} from './lib/api';
import type {
  BackendType,
  ConfigCandidate,
  Conversation,
  ConversationConfig,
  ConversationConfigCandidates,
  StoredEvent as ConversationEvent,
} from './lib/types';
import { buildClaudeTimeline } from './timeline/claude';
import { buildCodexTimeline } from './timeline/codex';
import { deriveRuntimeBanner, type TimelineItem } from './timeline/shared';
import MessageBubble from './components/MessageBubble';
import SubagentsPanel from './components/SubagentsPanel';

type Theme = 'light' | 'dark' | 'dusk' | 'sand';
type WsState = 'connecting' | 'open' | 'closed';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'dusk', label: 'Dusk' },
  { value: 'sand', label: 'Sand' },
];

function getInitialTheme(): Theme {
  const stored = localStorage.getItem('agentmux-theme');
  if (stored && THEMES.some((t) => t.value === stored)) {
    return stored as Theme;
  }
  return 'dark';
}

function getCandidateLabel(candidates: ConfigCandidate[], value: string): string {
  const found = candidates.find((c) => c.value === value);
  if (found) return found.label;
  // Fallback: strip provider prefix, titleize
  const bare = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
  return bare.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildTimelineForBackend(backend: BackendType, events: ConversationEvent[]): TimelineItem[] {
  return backend === 'codex' ? buildCodexTimeline(events) : buildClaudeTimeline(events);
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [eventsByConversation, setEventsByConversation] = useState<Record<string, ConversationEvent[]>>({});
  const [optionsByBackend, setOptionsByBackend] = useState<Partial<Record<BackendType, ConversationConfigCandidates>>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);
  const [isUpdatingConfig, setIsUpdatingConfig] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [wsState, setWsState] = useState<WsState>('connecting');
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const [openSelector, setOpenSelector] = useState<'model' | 'reasoning' | 'mode' | null>(null);
  const connRef = useRef<ReturnType<typeof createReconnectingSocket> | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  activeIdRef.current = activeId;

  // Theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('agentmux-theme', theme);
  }, [theme]);

  // Load conversations
  useEffect(() => {
    void listConversations().then((data) => {
      setConversations(data);
      if (!activeId && data[0]) setActiveId(data[0].id);
    });
  }, [activeId]);

  // Load config options
  useEffect(() => {
    for (const backend of ['codex', 'claude'] as BackendType[]) {
      void getConfigOptions(backend).then((options) => {
        setOptionsByBackend((current) => ({ ...current, [backend]: options }));
      });
    }
  }, []);

  // WebSocket with auto-reconnect
  const handleWsMessage = useCallback((data: unknown) => {
    const msg = data as
      | { type: 'conversation.snapshot'; conversationId: string; payload: { events: ConversationEvent[] } }
      | { type: 'conversation.event'; conversationId: string; payload: ConversationEvent }
      | { type: 'server.ready' }
      | { type: 'error'; payload: { message: string } };

    if (msg.type === 'server.ready') {
      const currentActiveId = activeIdRef.current;
      if (currentActiveId) connRef.current?.send(JSON.stringify({ type: 'subscribe_conversation', conversationId: currentActiveId }));
      return;
    }
    if (msg.type === 'conversation.snapshot') {
      setEventsByConversation((current) => ({ ...current, [msg.conversationId]: msg.payload.events }));
      return;
    }
    if (msg.type === 'conversation.event') {
      setEventsByConversation((current) => ({
        ...current,
        [msg.conversationId]: [...(current[msg.conversationId] ?? []), msg.payload],
      }));
      void listConversations().then(setConversations);
      return;
    }
    if (msg.type === 'error') setComposerError(msg.payload.message);
  }, []);

  useEffect(() => {
    const conn = createReconnectingSocket(handleWsMessage, setWsState);
    connRef.current = conn;
    return () => { conn.close(); connRef.current = null; };
  }, [handleWsMessage]);

  useEffect(() => {
    if (!activeId) return;
    connRef.current?.send(JSON.stringify({ type: 'subscribe_conversation', conversationId: activeId }));
    return () => { connRef.current?.send(JSON.stringify({ type: 'unsubscribe_conversation', conversationId: activeId })); };
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    setIsLoadingEvents(true);
    void listEvents(activeId)
      .then((loadedEvents) => setEventsByConversation((current) => ({ ...current, [activeId]: loadedEvents })))
      .finally(() => setIsLoadingEvents(false));
  }, [activeId]);

  // Derived state
  const activeConversation = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [activeId, conversations]);
  const activeEvents = activeId ? eventsByConversation[activeId] ?? [] : [];
  const timeline = useMemo(() => (activeConversation ? buildTimelineForBackend(activeConversation.backend, activeEvents) : []), [activeConversation, activeEvents]);
  const visibleTimeline = useMemo(() => timeline.filter((item) => !item.hidden), [timeline]);
  const runtimeBanner = useMemo(() => deriveRuntimeBanner(activeEvents), [activeEvents]);
  const activeOptions = activeConversation ? (optionsByBackend[activeConversation.backend] ?? null) : null;

  const resolvedConfig = useMemo(() => {
    if (!activeConversation || !activeOptions) return { model: 'default', reasoningEffort: 'medium', mode: 'default' };
    return {
      model: typeof activeConversation.config.model === 'string' ? activeConversation.config.model : activeOptions.defaults.model,
      reasoningEffort: typeof activeConversation.config.reasoningEffort === 'string' ? activeConversation.config.reasoningEffort : activeOptions.defaults.reasoningEffort,
      mode: typeof activeConversation.config.mode === 'string' ? activeConversation.config.mode : activeOptions.defaults.mode,
    };
  }, [activeConversation, activeOptions]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleTimeline]);

  // Click-outside closes selector popovers
  useEffect(() => {
    if (!openSelector) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-selector-popover]')) setOpenSelector(null);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openSelector]);

  // Handlers
  async function handleCreateConversation(backend: BackendType) {
    const conversation = await createConversation(backend);
    const next = await listConversations();
    setConversations(next);
    setActiveId(conversation.id);
  }

  async function handleSend() {
    if (!activeId || !draft.trim()) return;
    const content = draft.trim();
    setDraft('');
    setComposerError(null);
    try {
      await sendMessage(activeId, content);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'Failed to send message');
      setDraft(content);
    }
  }

  async function handleControl(action: 'cancel' | 'resume' | 'retry') {
    if (!activeId) return;
    await controlConversation(activeId, action);
  }

  function handleRequestResponse(kind: 'approve' | 'deny', event?: ConversationEvent) {
    if (!activeId || !event) return;
    connRef.current?.send(JSON.stringify({
      type: 'interactive_response',
      conversationId: activeId,
      payload: { kind: 'approval', action: kind, requestId: event.payload.requestId, response: kind },
    }));
  }

  async function handleConfigChange(patch: Partial<ConversationConfig>) {
    if (!activeId) return;
    setIsUpdatingConfig(true);
    try {
      const updated = await updateConversationConfig(activeId, patch);
      setConversations((current) => current.map((c) => (c.id === updated.id ? updated : c)));
    } finally {
      setIsUpdatingConfig(false);
    }
  }

  async function handleRenameSubmit(conversationId: string) {
    const trimmed = editingTitleValue.trim();
    if (!trimmed) { setEditingTitleId(null); return; }
    try {
      const updated = await renameConversation(conversationId, trimmed);
      setConversations((current) => current.map((c) => (c.id === updated.id ? updated : c)));
    } catch { /* ignore */ }
    setEditingTitleId(null);
  }

  // ── Render ──
  return (
    <div className="app-shell">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="sidebar-header">
            <h2>AgentMux</h2>
            <span className={`connection-badge ${wsState}`}>{wsState}</span>
          </div>
          <div className="sidebar-actions">
            <button onClick={() => void handleCreateConversation('claude')}>+ Claude</button>
            <button onClick={() => void handleCreateConversation('codex')}>+ Codex</button>
          </div>
        </div>
        <div className="conversation-list">
          {conversations.filter((c) => !c.parentConversationId).map((c) => (
            <button
              key={c.id}
              className={`conversation-card ${c.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(c.id)}
              onDoubleClick={() => { setEditingTitleId(c.id); setEditingTitleValue(c.title); }}
            >
              {editingTitleId === c.id ? (
                <input
                  className="conversation-title-input"
                  value={editingTitleValue}
                  onChange={(e) => setEditingTitleValue(e.target.value)}
                  onBlur={() => void handleRenameSubmit(c.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleRenameSubmit(c.id); if (e.key === 'Escape') setEditingTitleId(null); }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <div className="conversation-card-title">{c.title}</div>
              )}
              <div className="conversation-card-meta">
                <span className={`backend-badge ${c.backend}`}>{c.backend}</span>
                {c.runtimeState !== 'idle' && c.runtimeState !== 'completed' ? <span className="state-badge">{c.runtimeState}</span> : null}
              </div>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="theme-picker">
            {THEMES.map((t) => (
              <button
                key={t.value}
                className={`theme-swatch ${t.value === theme ? 'active' : ''}`}
                data-theme-value={t.value}
                onClick={() => setTheme(t.value)}
                title={t.label}
              />
            ))}
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-panel">
        {!activeConversation ? (
          <div className="empty-state-shell">
            <div className="empty-state-card">
              <h1>AgentMux v2</h1>
              <p>Server-managed Claude and Codex conversations.</p>
              <div className="empty-state-actions">
                <button onClick={() => void handleCreateConversation('claude')}>New Claude Conversation</button>
                <button onClick={() => void handleCreateConversation('codex')}>New Codex Conversation</button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Header bar */}
            <header className="main-header">
              <div className="main-header-left">
                {activeConversation.parentConversationId ? (
                  <button className="back-to-parent" onClick={() => setActiveId(activeConversation.parentConversationId)}>← Parent</button>
                ) : null}
                <span className="main-header-title">{activeConversation.title}</span>
                <span className="main-header-meta">
                  {activeConversation.backend.toUpperCase()}
                  {activeConversation.agentRole ? ` · ${activeConversation.agentRole}` : ''}
                  {activeConversation.cwd ? ` · ${activeConversation.cwd}` : ''}
                </span>
              </div>
              <div className="control-row">
                {runtimeBanner ? <span className="runtime-pill">{runtimeBanner.content}</span> : null}
                <button disabled={!activeId} onClick={() => void handleControl('resume')}>Resume</button>
                <button disabled={!activeId} onClick={() => void handleControl('retry')}>Retry</button>
                <button disabled={!activeId} onClick={() => void handleControl('cancel')}>Cancel</button>
              </div>
            </header>

            {/* Messages */}
            <section className="messages">
              <div className="messages-inner">
                <SubagentsPanel
                  events={activeEvents}
                  onOpenChild={(threadId) => {
                    const child = conversations.find((c) => c.resumeHandle && (c.resumeHandle as Record<string, unknown>).threadId === threadId);
                    if (child) setActiveId(child.id);
                  }}
                />
                {isLoadingEvents ? <div className="messages-loading">Loading…</div> : null}
                {!isLoadingEvents && visibleTimeline.length === 0 ? (
                  <div className="messages-empty">Send the first message to start the conversation.</div>
                ) : null}
                {visibleTimeline.map((item) => (
                  <MessageBubble
                    key={item.id}
                    item={item}
                    backend={activeConversation?.backend}
                    onRewind={(opts) => void rewindConversation(activeId!, { ...opts, dryRun: false })}
                    onCopy={(text) => void navigator.clipboard.writeText(text)}
                    onAction={(kind, event) => handleRequestResponse(kind, event)}
                  />
                ))}
                <div ref={messagesEndRef} />
              </div>
            </section>

            {/* Composer */}
            <footer className="composer">
              <div className="composer-inner">
                <div className="composer-box">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onCompositionStart={() => setIsComposing(true)}
                    onCompositionEnd={() => setIsComposing(false)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        void handleControl('cancel');
                        return;
                      }
                      if (e.key === 'Tab' && e.shiftKey && activeOptions && !isUpdatingConfig) {
                        e.preventDefault();
                        const modes = activeOptions.candidates.mode;
                        const idx = modes.findIndex((c) => c.value === resolvedConfig.mode);
                        const next = modes[(idx + 1) % modes.length];
                        if (next) void handleConfigChange({ mode: next.value });
                        return;
                      }
                      if (e.key !== 'Enter' || e.shiftKey) return;
                      const ne = e.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
                      if (isComposing || ne.isComposing || ne.keyCode === 229) return;
                      e.preventDefault();
                      void handleSend();
                    }}
                    placeholder="Ask anything…"
                    rows={1}
                  />
                  <div className="composer-toolbar">
                    <div className="composer-selectors">
                      {activeOptions ? (
                        <>
                          <div className="pill-wrapper" data-selector-popover>
                            <button className="config-pill" onClick={() => setOpenSelector(openSelector === 'model' ? null : 'model')} disabled={isUpdatingConfig}>
                              {getCandidateLabel(activeOptions.candidates.model, resolvedConfig.model)}
                            </button>
                            {openSelector === 'model' ? (
                              <div className="selector-popover">
                                {activeOptions.candidates.model.map((c) => (
                                  <button key={c.value} className={`selector-option ${c.value === resolvedConfig.model ? 'active' : ''}`}
                                    onClick={() => { void handleConfigChange({ model: c.value }); setOpenSelector(null); }} disabled={c.disabled}>
                                    {c.label}{c.badge ? <span className="selector-badge">{c.badge}</span> : null}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="pill-wrapper" data-selector-popover>
                            <button className="config-pill" onClick={() => setOpenSelector(openSelector === 'reasoning' ? null : 'reasoning')} disabled={isUpdatingConfig}>
                              {getCandidateLabel(activeOptions.candidates.reasoningEffort, resolvedConfig.reasoningEffort)}
                            </button>
                            {openSelector === 'reasoning' ? (
                              <div className="selector-popover">
                                {activeOptions.candidates.reasoningEffort.map((c) => (
                                  <button key={c.value} className={`selector-option ${c.value === resolvedConfig.reasoningEffort ? 'active' : ''}`}
                                    onClick={() => { void handleConfigChange({ reasoningEffort: c.value }); setOpenSelector(null); }}>
                                    {c.label}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="pill-wrapper" data-selector-popover>
                            <button className={`config-pill ${resolvedConfig.mode === 'plan' ? 'mode-plan' : resolvedConfig.mode !== 'default' ? 'mode-auto' : ''}`} onClick={() => setOpenSelector(openSelector === 'mode' ? null : 'mode')} disabled={isUpdatingConfig}>
                              {getCandidateLabel(activeOptions.candidates.mode, resolvedConfig.mode)}
                            </button>
                            {openSelector === 'mode' ? (
                              <div className="selector-popover">
                                {activeOptions.candidates.mode.map((c) => (
                                  <button key={c.value} className={`selector-option ${c.value === resolvedConfig.mode ? 'active' : ''}`}
                                    onClick={() => { void handleConfigChange({ mode: c.value }); setOpenSelector(null); }}>
                                    {c.label}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </div>
                    <button className="send-button" disabled={!activeId || !draft.trim()} onClick={() => void handleSend()} aria-label="Send">&#8593;</button>
                  </div>
                </div>
                {composerError ? <div className="composer-error">{composerError}</div> : null}
              </div>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
