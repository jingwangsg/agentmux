import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { TimelineItem } from '../timeline/shared';
import type { StoredEvent as ConversationEvent } from '../lib/types';
import type { BackendType } from '../lib/types';

type ActionKind = 'approve' | 'deny';

interface RewindOptions {
  userMessageId: string;
  message?: string;
  fork?: boolean;
  rewindCode?: boolean;
}

interface MessageBubbleProps {
  item: TimelineItem;
  backend?: BackendType;
  onRewind?: (options: RewindOptions) => void;
  onCopy?: (text: string) => void;
  onAction?: (kind: ActionKind, event?: ConversationEvent) => void;
}

function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
      {text}
    </ReactMarkdown>
  );
}

function UserMessage({ item, backend, onRewind, onCopy }: MessageBubbleProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDropdown]);

  const handleCopy = () => {
    if (item.body) onCopy?.(item.body);
  };

  const handleEdit = () => {
    setEditText(item.body ?? '');
    setEditing(true);
  };

  const handleEditSubmit = () => {
    if (editText.trim()) {
      onRewind?.({ userMessageId: item.id, message: editText.trim() });
    }
    setEditing(false);
  };

  const handleEditCancel = () => {
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="msg msg-user">
        <div className="msg-edit-box">
          <textarea
            className="msg-edit-textarea"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSubmit(); }
              if (e.key === 'Escape') handleEditCancel();
            }}
            autoFocus
            rows={3}
          />
          <div className="msg-edit-actions">
            <button className="msg-edit-cancel" onClick={handleEditCancel}>Cancel</button>
            <button className="msg-edit-send" onClick={handleEditSubmit} disabled={!editText.trim()}>Send</button>
          </div>
        </div>
      </div>
    );
  }

  const isClaude = backend === 'claude';

  return (
    <div className="msg msg-user">
      <div className="msg-bubble-user">
        <MarkdownBody text={item.body ?? ''} />
        {item.canRewind ? (
          <div className="msg-hover-actions">
            {/* Rewind / Fork */}
            <div className="msg-hover-btn-wrap" ref={dropdownRef}>
              <button
                className="msg-hover-btn"
                title={isClaude ? 'Rewind options' : 'Rewind to here'}
                onClick={() => {
                  if (isClaude) {
                    setShowDropdown(!showDropdown);
                  } else {
                    onRewind?.({ userMessageId: item.id });
                  }
                }}
              >&#8634;</button>
              {showDropdown && isClaude ? (
                <div className="rewind-dropdown">
                  <button onClick={() => { onRewind?.({ userMessageId: item.id, fork: true, rewindCode: false }); setShowDropdown(false); }}>
                    Fork conversation from here
                  </button>
                  <button onClick={() => { onRewind?.({ userMessageId: item.id, fork: false, rewindCode: true }); setShowDropdown(false); }}>
                    Rewind code to here
                  </button>
                  <button onClick={() => { onRewind?.({ userMessageId: item.id, fork: true, rewindCode: true }); setShowDropdown(false); }}>
                    Fork conversation and rewind code
                  </button>
                </div>
              ) : null}
            </div>
            {/* Copy */}
            <button className="msg-hover-btn" title="Copy" onClick={handleCopy}>&#9112;</button>
            {/* Edit */}
            <button className="msg-hover-btn" title="Edit and resend" onClick={handleEdit}>&#9998;</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function MessageBubble({ item, backend, onRewind, onCopy, onAction }: MessageBubbleProps) {
  if (item.kind === 'user') {
    return <UserMessage item={item} backend={backend} onRewind={onRewind} onCopy={onCopy} onAction={onAction} />;
  }

  if (item.kind === 'assistant') {
    return (
      <div className="msg msg-assistant">
        <div className="msg-prose">
          <MarkdownBody text={item.body ?? ''} />
        </div>
      </div>
    );
  }

  if (item.kind === 'tool') {
    return (
      <details className="tool-section" open={!item.collapsed}>
        <summary>{item.title}{item.body ? `: ${item.body.slice(0, 80)}` : ''}</summary>
        {item.details ? <pre className="tool-section-body">{item.details}</pre> : null}
      </details>
    );
  }

  if (item.kind === 'plan') {
    return (
      <details className="tool-section plan-section" open={!item.collapsed}>
        <summary>Thinking</summary>
        <div className="tool-section-body msg-prose">
          <MarkdownBody text={item.body ?? ''} />
        </div>
      </details>
    );
  }

  if (item.kind === 'request') {
    return (
      <div className="msg msg-request">
        <div className="msg-request-label">{item.title}</div>
        {item.body ? <div className="msg-request-body">{item.body}</div> : null}
        {item.details ? (
          <details className="msg-request-details">
            <summary>Details</summary>
            <pre>{item.details}</pre>
          </details>
        ) : null}
        {item.actions?.length ? (
          <div className="msg-request-actions">
            {item.actions.map((action) => (
              <button key={action.key} className={`msg-action-btn ${action.kind}`} onClick={() => onAction?.(action.kind, item.event)}>
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (item.kind === 'error') {
    return (
      <div className="msg msg-error">
        <span className="msg-error-icon">!</span>
        <span>{item.body}</span>
      </div>
    );
  }

  if (item.kind === 'status') {
    return <div className="msg msg-status">{item.body}</div>;
  }

  return null;
}
