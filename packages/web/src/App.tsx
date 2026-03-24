import { useEffect, useMemo, useRef, useState } from 'react';
import {
  controlConversation,
  createConversation,
  createSocket,
  getConfigOptions,
  listConversations,
  listEvents,
  rewindConversation,
  sendInteractiveResponse,
  sendMessage,
  updateConversationConfig,
} from './lib/api';
import type {
  BackendType,
  ConfigCandidate,
  Conversation,
  ConversationConfig,
  ConversationConfigCandidates,
  ConversationEvent,
} from './lib/types';

type Theme = 'light' | 'dark' | 'dusk' | 'sand';
type UiMessageRole = 'user' | 'assistant' | 'status' | 'error' | 'tool' | 'request';
type SelectorKey = 'model' | 'reasoning' | 'mode' | null;

type UiMessage = {
  id: string;
  role: UiMessageRole;
  content: string;
  details?: string;
  event?: ConversationEvent;
  canRewind?: boolean;
};

type RuntimeBanner = {
  content: string;
  details?: string;
} | null;

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
  return 'light';
}

function ThemePicker({ current, onChange }: { current: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="theme-picker">
      <span className="theme-picker-label">Theme</span>
      {THEMES.map((t) => (
        <button
          key={t.value}
          className={`theme-swatch ${t.value === current ? 'active' : ''}`}
          data-theme-value={t.value}
          onClick={() => onChange(t.value)}
          title={t.label}
          aria-label={`Switch to ${t.label} theme`}
        />
      ))}
    </div>
  );
}


function tryParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function getCandidateLabel(candidates: ConfigCandidate[], value: string): string {
  return candidates.find((candidate) => candidate.value === value)?.label ?? value;
}

function summarizeToolPayload(payload: Record<string, unknown>): { content: string; details?: string } {
  const directMessage = typeof payload.message === 'string' ? payload.message.trim() : '';
  const directStatus = typeof payload.status === 'string' ? payload.status.trim() : '';
  const directOutput = typeof payload.output === 'string' ? payload.output.trim() : '';
  const rawText = directMessage || directStatus || directOutput;
  const parsed = rawText ? tryParseJsonObject(rawText) : null;

  if (parsed) {
    const nestedMessage = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    const nestedStatus = typeof parsed.status === 'string' ? parsed.status.trim() : '';
    const nestedOutput = typeof parsed.output === 'string' ? parsed.output.trim() : '';
    const nestedContent = nestedMessage || nestedStatus || nestedOutput;
    if (nestedContent) {
      return { content: nestedContent, details: JSON.stringify(payload, null, 2) };
    }
  }

  if (rawText) {
    return { content: rawText, details: JSON.stringify(payload, null, 2) };
  }

  return { content: 'Tool progress update', details: JSON.stringify(payload, null, 2) };
}

function summarizeRuntimeState(payload: Record<string, unknown>): string | null {
  const state = typeof payload.state === 'string' ? payload.state : '';
  const detail = typeof payload.detail === 'string' ? payload.detail : '';
  if (!state) {
    return null;
  }
  if (state === 'running') {
    return detail ? `Running — ${detail}` : 'Running';
  }
  if (state === 'waiting_input') {
    return detail ? `Waiting for input — ${detail}` : 'Waiting for input';
  }
  if (state === 'completed') {
    return 'Completed';
  }
  if (state === 'stopped') {
    return detail ? `Stopped — ${detail}` : 'Stopped';
  }
  if (state === 'idle') {
    return detail ? `Ready — ${detail}` : 'Ready';
  }
  if (state === 'error' || state === 'resume_failed') {
    return detail ? `Error — ${detail}` : 'Error';
  }
  return `${state}${detail ? ` — ${detail}` : ''}`;
}

function summarizeEvent(event: ConversationEvent): { role: UiMessageRole; content: string; details?: string } | null {

  if (event.type === 'tool.call') {
    const toolName = typeof event.payload.name === 'string'
      ? event.payload.name
      : typeof event.payload.toolName === 'string'
        ? event.payload.toolName
        : 'Tool';
    return {
      role: 'tool',
      content: `${toolName} started`,
      details: JSON.stringify(event.payload, null, 2),
    };
  }

  if (event.type === 'tool.output') {
    const summary = summarizeToolPayload(event.payload);
    return {
      role: 'tool',
      content: summary.content,
      details: summary.details,
    };
  }

  if (event.type === 'interactive.request' || event.type === 'approval.request') {
    const title = typeof event.payload.message === 'string'
      ? event.payload.message
      : typeof event.payload.requestId === 'string'
        ? `Action required — ${event.payload.requestId}`
        : 'Action required';
    return {
      role: 'request',
      content: title,
      details: JSON.stringify(event.payload, null, 2),
    };
  }

  if (event.type === 'error') {
    const rawMessage = String(event.payload.message ?? 'Unknown error');
    const parsed = tryParseJsonObject(rawMessage);
    const normalizedMessage = parsed && typeof parsed.message === 'string' ? parsed.message : rawMessage;
    return {
      role: 'error',
      content: normalizedMessage,
      details: JSON.stringify(event.payload, null, 2),
    };
  }

  return null;
}

function deriveMessages(events: ConversationEvent[]): UiMessage[] {
  const messages: UiMessage[] = [];
  let liveAssistant = '';
  let lastUserMessageId: string | null = null;

  for (const event of events) {
    if (event.type === 'message.user') {
      messages.push({ id: event.id, role: 'user', content: String(event.payload.content ?? ''), event });
      lastUserMessageId = event.id;
      continue;
    }

    if (event.type === 'message.assistant.delta') {
      liveAssistant += String(event.payload.content ?? '');
      continue;
    }

    if (event.type === 'message.assistant.final') {
      const finalContent = String(event.payload.content ?? '').trim();
      const bufferedContent = liveAssistant.trim();
      const content = finalContent || bufferedContent;
      if (content) {
        const previous = messages[messages.length - 1];
        if (!(previous?.role === 'assistant' && previous.content.trim() === content)) {
          messages.push({ id: event.id, role: 'assistant', content, event });
        }
      }
      liveAssistant = '';
      continue;
    }

    const summary = summarizeEvent(event);
    if (summary) {
      messages.push({ id: event.id, event, ...summary });
    }
  }

  if (liveAssistant.trim()) {
    messages.push({ id: 'live-assistant', role: 'assistant', content: liveAssistant.trim() });
  }

  return messages.map((message) => ({
    ...message,
    canRewind: message.role === 'user' && message.id === lastUserMessageId,
  }));
}


function deriveRuntimeBanner(events: ConversationEvent[]): RuntimeBanner {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'runtime.state') {
      continue;
    }
    const summary = summarizeRuntimeState(event.payload);
    if (!summary) {
      return null;
    }
    return {
      content: summary,
      details: JSON.stringify(event.payload, null, 2),
    };
  }

  return null;
}

function EmptyState({ onCreate }: { onCreate: (backend: BackendType) => void }) {
  return (
    <div className="empty-state-shell">
      <div className="empty-state-card">
        <div className="empty-state-badge">AgentMux</div>
        <h3>No conversations yet</h3>
        <p>
          Create a Codex or Claude conversation to start. The server keeps conversations and agent runtimes alive
          independently from the browser UI.
        </p>
        <div className="empty-state-actions">
          <button onClick={() => onCreate('codex')}>New Codex</button>
          <button className="secondary" onClick={() => onCreate('claude')}>New Claude</button>
        </div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="empty-state-shell">
      <div className="empty-state-card loading-card">
        <div className="empty-state-badge">AgentMux</div>
        <h3>Loading conversations…</h3>
      </div>
    </div>
  );
}

function SelectorPopover({
  title,
  triggerLabel,
  currentValue,
  candidates,
  isOpen,
  onToggle,
  onClose,
  onSelect,
  disabled,
}: {
  title: string;
  triggerLabel: string;
  currentValue: string;
  candidates: ConfigCandidate[];
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onSelect: (value: string) => void;
  disabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  return (
    <div className="selector-root" ref={rootRef}>
      <button
        type="button"
        className={`selector-trigger ${isOpen ? 'open' : ''}`}
        onClick={onToggle}
        disabled={disabled}
      >
        <span className="selector-trigger-label">{triggerLabel}</span>
        <span className="selector-trigger-value">{getCandidateLabel(candidates, currentValue)}</span>
        <span className="selector-trigger-caret">▾</span>
      </button>
      {isOpen ? (
        <div className="selector-popover" role="dialog" aria-label={title}>
          <div className="selector-popover-title">{title}</div>
          <div className="selector-option-list">
            {candidates.map((candidate) => {
              const isSelected = candidate.value === currentValue;
              return (
                <button
                  key={candidate.value}
                  type="button"
                  className={`selector-option-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    onSelect(candidate.value);
                    onClose();
                  }}
                  disabled={candidate.disabled}
                >
                  <div className="selector-option-main">
                    <div className="selector-option-header">
                      <span className="selector-option-label">{candidate.label}</span>
                      <div className="selector-option-meta">
                        {candidate.badge ? <span className="selector-option-badge">{candidate.badge}</span> : null}
                        {isSelected ? <span className="selector-option-check">✓</span> : null}
                      </div>
                    </div>
                    {candidate.description ? (
                      <div className="selector-option-description">{candidate.description}</div>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [isLoadingEvents, setIsLoadingEvents] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [configOptions, setConfigOptions] = useState<Record<BackendType, ConversationConfigCandidates | null>>({ codex: null, claude: null });
  const [isUpdatingConfig, setIsUpdatingConfig] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [openSelector, setOpenSelector] = useState<SelectorKey>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeIdRef = useRef<string | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? null,
    [conversations, activeId],
  );
  const messages = useMemo(() => deriveMessages(events), [events]);
  const runtimeBanner = useMemo(() => deriveRuntimeBanner(events), [events]);
  const showEmptyState = !isLoadingConversations && conversations.length === 0;
  const activeConfig = activeConversation?.config ?? {};
  const activeOptions = activeConversation ? configOptions[activeConversation.backend] : null;
  const resolvedConfig = {
    model: typeof activeConfig.model === 'string' ? activeConfig.model : activeOptions?.defaults.model ?? '',
    reasoningEffort:
      typeof activeConfig.reasoningEffort === 'string' ? activeConfig.reasoningEffort : activeOptions?.defaults.reasoningEffort ?? '',
    mode: typeof activeConfig.mode === 'string' ? activeConfig.mode : activeOptions?.defaults.mode ?? '',
  };
  const showReasoningSelector = Boolean(activeOptions?.defaults.reasoningEffort || activeOptions?.candidates.reasoningEffort.length);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('agentmux-theme', theme);
  }, [theme]);

  useEffect(() => {
    void (async () => {
      try {
        setIsLoadingConversations(true);
        const data = await listConversations();
        setConversations(data);
        setActiveId((current) => current ?? data[0]?.id ?? null);
      } finally {
        setIsLoadingConversations(false);
      }
    })();
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;

    socket.onopen = () => {
      if (activeIdRef.current) {
        socket.send(JSON.stringify({ type: 'subscribe_conversation', conversationId: activeIdRef.current }));
      }
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as {
        type: string;
        conversationId?: string;
        payload?: { events?: ConversationEvent[] } | ConversationEvent;
      };

      if (message.type === 'conversation.snapshot' && message.conversationId === activeIdRef.current) {
        const snapshot = message.payload as { events?: ConversationEvent[] } | undefined;
        setEvents(snapshot?.events ?? []);
      }

      if (message.type === 'conversation.event' && message.conversationId === activeIdRef.current) {
        const eventPayload = message.payload as ConversationEvent;
        setEvents((current) => [...current, eventPayload]);
      }
    };

    return () => {
      socket.close();
    };
  }, []);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeId) {
      return;
    }
    socket.send(JSON.stringify({ type: 'subscribe_conversation', conversationId: activeId }));
    return () => {
      socket.send(JSON.stringify({ type: 'unsubscribe_conversation', conversationId: activeId }));
    };
  }, [activeId]);

  useEffect(() => {
    if (!activeId) {
      setEvents([]);
      return;
    }

    void (async () => {
      setIsLoadingEvents(true);
      try {
        setEvents(await listEvents(activeId));
      } finally {
        setIsLoadingEvents(false);
      }
    })();
  }, [activeId]);

  useEffect(() => {
    const backend = activeConversation?.backend;
    if (!backend || configOptions[backend]) {
      return;
    }
    void (async () => {
      const options = await getConfigOptions(backend);
      setConfigOptions((current) => ({ ...current, [backend]: options }));
    })();
  }, [activeConversation, configOptions]);

  async function handleCreate(backend: BackendType) {
    const conversation = await createConversation(backend);
    setConversations((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    setSidebarOpen(false);
  }

  async function handleSend() {
    if (!activeId || !draft.trim()) {
      return;
    }
    const content = draft.trim();
    setDraft('');
    setComposerError(null);
    await sendMessage(activeId, content);
  }

  async function handleControl(action: 'cancel' | 'resume' | 'retry') {
    if (!activeId) {
      return;
    }
    await controlConversation(activeId, action);
  }

  async function handleRewind(message: UiMessage) {
    if (!activeId || !message.canRewind) {
      return;
    }
    await rewindConversation(activeId, { userMessageId: message.id, dryRun: false });
  }

  function handleRequestResponse(kind: 'approval', action: 'approve' | 'deny', event?: ConversationEvent) {
    if (!socketRef.current || !activeId || !event) {
      return;
    }
    sendInteractiveResponse(socketRef.current, activeId, { kind, action, ...event.payload });
  }

  async function handleConfigChange(nextPatch: Partial<ConversationConfig>) {
    if (!activeConversation) {
      return;
    }
    setIsUpdatingConfig(true);
    setComposerError(null);
    try {
      const updated = await updateConversationConfig(activeConversation.id, nextPatch);
      setConversations((current) => current.map((conversation) => (conversation.id === updated.id ? updated : conversation)));
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : 'Failed to update config');
    } finally {
      setIsUpdatingConfig(false);
    }
  }

  return (
    <div className={`app-shell ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>AgentMux</h1>
          <button className="sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">×</button>
        </div>

        <div className="sidebar-actions">
          <button onClick={() => void handleCreate('codex')}>New Codex</button>
          <button className="secondary" onClick={() => void handleCreate('claude')}>New Claude</button>
        </div>

        <div className="conversation-list">
          {isLoadingConversations ? (
            <div className="sidebar-loading">Loading conversations…</div>
          ) : conversations.length === 0 ? (
            <div className="sidebar-empty">No conversations yet.</div>
          ) : (
            conversations.map((conversation) => (
              <button
                key={conversation.id}
                className={`conversation-item ${conversation.id === activeId ? 'active' : ''}`}
                onClick={() => { setActiveId(conversation.id); setSidebarOpen(false); }}
              >
                <div className="conversation-title-row">
                  <span className={`backend-pill ${conversation.backend}`}>{conversation.backend}</span>
                  <span className={`state-pill ${conversation.runtimeState}`}>{conversation.runtimeState}</span>
                </div>
                <strong>{conversation.title}</strong>
                <small>{new Date(conversation.updatedAt).toLocaleString()}</small>
              </button>
            ))
          )}
        </div>
        <ThemePicker current={theme} onChange={setTheme} />
      </aside>

      <main className="chat-pane">
        {isLoadingConversations ? (
          <LoadingState />
        ) : showEmptyState ? (
          <EmptyState onCreate={(backend) => void handleCreate(backend)} />
        ) : (
          <>
            <header className="chat-header">
              <button className="sidebar-toggle" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 5h14M3 10h14M3 15h14" />
                </svg>
              </button>
              <div>
                <h2>{activeConversation?.title ?? 'No conversation selected'}</h2>
                <p>{activeConversation ? `${activeConversation.backend} · ${activeConversation.runtimeState}` : 'Create a conversation to begin'}</p>
              </div>
              <div className="control-row">
                <button disabled={!activeId} onClick={() => void handleControl('resume')}>Resume</button>
                <button disabled={!activeId} onClick={() => void handleControl('retry')}>Retry</button>
                <button disabled={!activeId} onClick={() => void handleControl('cancel')}>Cancel</button>
              </div>
            </header>

            <section className="messages">
              {runtimeBanner ? (
                <div className="runtime-banner">
                  <div className="runtime-banner-label">Status</div>
                  <div className="runtime-banner-content">{runtimeBanner.content}</div>
                  {runtimeBanner.details ? (
                    <details className="message-details">
                      <summary>Raw details</summary>
                      <pre>{runtimeBanner.details}</pre>
                    </details>
                  ) : null}
                </div>
              ) : null}
              {isLoadingEvents ? <div className="messages-loading">Loading messages…</div> : null}
              {!isLoadingEvents && messages.length === 0 ? (
                <div className="messages-empty">No messages yet. Send the first message to this conversation.</div>
              ) : null}
              {messages.map((message) => (
                <article key={message.id} className={`message-card ${message.role}`}>
                  <div className="message-role">{message.role}</div>
                  <div className="message-content">{message.content}</div>
                  {message.details ? (
                    <details className="message-details">
                      <summary>Raw details</summary>
                      <pre>{message.details}</pre>
                    </details>
                  ) : null}
                  {message.canRewind ? (
                    <div className="message-actions">
                      <button onClick={() => void handleRewind(message)}>Rewind From Here</button>
                    </div>
                  ) : null}
                  {message.role === 'request' ? (
                    <div className="message-actions">
                      <button onClick={() => handleRequestResponse('approval', 'approve', message.event)}>Approve</button>
                      <button onClick={() => handleRequestResponse('approval', 'deny', message.event)}>Deny</button>
                    </div>
                  ) : null}
                </article>
              ))}
            </section>

            <footer className="composer">
              {activeOptions ? (
                <div className="composer-statusline">
                  <SelectorPopover
                    title="Choose model"
                    triggerLabel="Model"
                    currentValue={resolvedConfig.model}
                    candidates={activeOptions.candidates.model}
                    isOpen={openSelector === 'model'}
                    onToggle={() => setOpenSelector((current) => (current === 'model' ? null : 'model'))}
                    onClose={() => setOpenSelector(null)}
                    onSelect={(value) => void handleConfigChange({ model: value })}
                    disabled={isUpdatingConfig}
                  />
                  {showReasoningSelector ? (
                    <SelectorPopover
                      title="Choose reasoning"
                      triggerLabel="Reasoning"
                      currentValue={resolvedConfig.reasoningEffort}
                      candidates={activeOptions.candidates.reasoningEffort}
                      isOpen={openSelector === 'reasoning'}
                      onToggle={() => setOpenSelector((current) => (current === 'reasoning' ? null : 'reasoning'))}
                      onClose={() => setOpenSelector(null)}
                      onSelect={(value) => void handleConfigChange({ reasoningEffort: value })}
                      disabled={isUpdatingConfig}
                    />
                  ) : null}
                  <SelectorPopover
                    title="Choose mode"
                    triggerLabel="Mode"
                    currentValue={resolvedConfig.mode}
                    candidates={activeOptions.candidates.mode}
                    isOpen={openSelector === 'mode'}
                    onToggle={() => setOpenSelector((current) => (current === 'mode' ? null : 'mode'))}
                    onClose={() => setOpenSelector(null)}
                    onSelect={(value) => void handleConfigChange({ mode: value })}
                    disabled={isUpdatingConfig}
                  />
                </div>
              ) : null}
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onCompositionStart={() => setIsComposing(true)}
                onCompositionEnd={() => setIsComposing(false)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey) {
                    return;
                  }
                  const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
                  if (isComposing || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
                    return;
                  }
                  event.preventDefault();
                  void handleSend();
                }}
                placeholder="Message the server-managed agent… Enter to send, Shift+Enter for newline"
              />
              <div className="composer-actions-row">
                <div className="composer-hint">Enter sends · Shift+Enter adds a newline</div>
                <button disabled={!activeId || !draft.trim()} onClick={() => void handleSend()}>Send</button>
              </div>
              {composerError ? <div className="composer-error">{composerError}</div> : null}
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
