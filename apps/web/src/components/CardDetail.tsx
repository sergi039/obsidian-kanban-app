import { useEffect, useRef, useState, useCallback } from 'react';
import { patchCard, fetchComments, addComment, updateComment, deleteComment, fetchFieldValues, setFieldValue } from '../api/client';
import type { Card, Comment, FieldValue, Field, PatchCardRequest, PriorityDef } from '../types';

interface Props {
  card: Card;
  columns: string[];
  priorities: PriorityDef[];
  fields: Field[];
  onClose: () => void;
  onUpdate: () => Promise<void>;
}

const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)\]]+/g;

function safeHostname(raw: string): string {
  try { return new URL(raw).hostname; } catch { return raw; }
}

function extractLinks(title: string): { text: string; url: string }[] {
  const links: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  const mdRe = new RegExp(MD_LINK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(title)) !== null) {
    if (!seen.has(m[2])) { links.push({ text: m[1] || m[2], url: m[2] }); seen.add(m[2]); }
  }
  const bareRe = new RegExp(BARE_URL_RE.source, 'g');
  while ((m = bareRe.exec(title)) !== null) {
    if (!seen.has(m[0])) { links.push({ text: safeHostname(m[0]), url: m[0] }); seen.add(m[0]); }
  }
  return links;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanTitle(t: string, priorities: PriorityDef[]): string {
  let value = t.replace(/\[([^\]]*)\]\([^)]+\)/g, '$1').replace(/https?:\/\/[^\s)\]]+/g, '');
  for (const p of priorities) {
    value = value.replace(new RegExp(`\\s*${escapeRegExp(p.emoji)}\\s*`, 'g'), ' ');
  }
  return value.replace(/\s+/g, ' ').trim();
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z')).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

function authorInitial(author: string): string {
  return (author[0] || '?').toUpperCase();
}

const AUTHOR_COLORS: Record<string, string> = {
  user: 'bg-blue-500',
  system: 'bg-gray-500',
  bot: 'bg-green-500',
};

function authorColor(author: string): string {
  return AUTHOR_COLORS[author] || 'bg-purple-500';
}

/** Debounced + safe custom field input (prevents request storms & race conditions) */
function CustomFieldInput({ field, value, cardId, onSaved, onLocalChange }: {
  field: Field;
  value: string;
  cardId: string;
  onSaved: () => Promise<void>;
  onLocalChange: (val: string) => void;
}) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef(0); // monotonic counter to discard stale responses

  const saveValue = useCallback(async (v: string | null) => {
    const seq = ++latestRef.current;
    try {
      await setFieldValue(field.id, cardId, v);
      if (seq === latestRef.current) {
        await onSaved();
      }
    } catch (err) {
      console.error(`Failed to save field ${field.name}:`, err);
    }
  }, [field.id, field.name, cardId, onSaved]);

  const debouncedSave = useCallback((v: string | null, delayMs = 500) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => saveValue(v), delayMs);
  }, [saveValue]);

  // Cleanup on unmount
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  if (field.type === 'SINGLE_SELECT') {
    return (
      <div>
        <label className="text-[11px] text-board-text-muted block mb-0.5">{field.name}</label>
        <select
          value={value}
          onChange={(e) => {
            const v = e.target.value || null;
            onLocalChange(e.target.value);
            saveValue(v);
          }}
          className="w-full text-sm bg-board-column border border-board-border rounded-md px-2 py-1 text-board-text focus:outline-none cursor-pointer"
        >
          <option value="">—</option>
          {field.options.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.name}</option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === 'DATE') {
    return (
      <div>
        <label className="text-[11px] text-board-text-muted block mb-0.5">{field.name}</label>
        <input
          type="date"
          value={value}
          onChange={(e) => {
            const v = e.target.value || null;
            onLocalChange(e.target.value);
            saveValue(v);
          }}
          className="w-full text-sm bg-board-column border border-board-border rounded-md px-2 py-1 text-board-text focus:outline-none"
        />
      </div>
    );
  }

  if (field.type === 'NUMBER') {
    return (
      <div>
        <label className="text-[11px] text-board-text-muted block mb-0.5">{field.name}</label>
        <input
          type="number"
          value={value}
          onChange={(e) => {
            onLocalChange(e.target.value);
            debouncedSave(e.target.value || null, 600);
          }}
          onBlur={(e) => {
            // Flush any pending debounce immediately on blur
            if (debounceRef.current) clearTimeout(debounceRef.current);
            saveValue(e.target.value || null);
          }}
          className="w-full text-sm bg-board-column border border-board-border rounded-md px-2 py-1 text-board-text focus:outline-none"
        />
      </div>
    );
  }

  // TEXT / ITERATION — save on blur
  return (
    <div>
      <label className="text-[11px] text-board-text-muted block mb-0.5">{field.name}</label>
      <input
        type="text"
        value={value}
        placeholder="Empty"
        onChange={(e) => onLocalChange(e.target.value)}
        onBlur={(e) => saveValue(e.target.value || null)}
        className="w-full text-sm bg-board-column border border-board-border rounded-md px-2 py-1 text-board-text focus:outline-none placeholder:text-board-text-muted/40"
      />
    </div>
  );
}

export function CardDetail({ card, columns, priorities, fields, onClose, onUpdate }: Props) {
  const links = extractLinks(card.title);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Editable fields
  const [priority, setPriority] = useState<string>(card.priority || '');
  const [dueDate, setDueDate] = useState(card.due_date || '');
  const [columnName, setColumnName] = useState(card.column_name);
  const [saving, setSaving] = useState(false);

  // Description
  const [description, setDescription] = useState(card.description || '');
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(card.description || '');
  const descRef = useRef<HTMLTextAreaElement>(null);

  // Custom field values
  const [fieldValues, setFieldValues] = useState<FieldValue[]>([]);

  // Comments
  const [comments, setComments] = useState<Comment[]>([]);
  const [loadingComments, setLoadingComments] = useState(true);
  const [newComment, setNewComment] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentDraft, setEditCommentDraft] = useState('');
  const commentInputRef = useRef<HTMLTextAreaElement>(null);

  // Focus trap + Escape
  useEffect(() => {
    closeRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingDesc) { setEditingDesc(false); setDescDraft(description); return; }
        if (editingCommentId) { setEditingCommentId(null); return; }
        onClose();
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, editingDesc, editingCommentId, description]);

  // Load comments + field values
  useEffect(() => {
    setLoadingComments(true);
    fetchComments(card.id)
      .then(setComments)
      .catch((err) => console.error('Failed to load comments:', err))
      .finally(() => setLoadingComments(false));

    fetchFieldValues(card.id)
      .then(setFieldValues)
      .catch((err) => console.error('Failed to load field values:', err));
  }, [card.id]);

  // Auto-resize description textarea
  useEffect(() => {
    if (editingDesc && descRef.current) {
      descRef.current.focus();
      descRef.current.style.height = 'auto';
      descRef.current.style.height = descRef.current.scrollHeight + 'px';
    }
  }, [editingDesc]);

  const saveField = useCallback(async (patch: PatchCardRequest) => {
    setSaving(true);
    try {
      await patchCard(card.id, patch);
      await onUpdate();
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving(false);
    }
  }, [card.id, onUpdate]);

  const handlePriorityChange = (val: string) => {
    setPriority(val);
    saveField({ priority: val || null });
  };

  const handleDueDateChange = (val: string) => {
    setDueDate(val);
    saveField({ due_date: val || null });
  };

  const handleColumnChange = (val: string) => {
    setColumnName(val);
    saveField({ column_name: val });
  };

  // Description handlers
  const handleDescSave = async () => {
    setEditingDesc(false);
    if (descDraft === description) return;
    setDescription(descDraft);
    await saveField({ description: descDraft });
  };

  const handleDescCancel = () => {
    setEditingDesc(false);
    setDescDraft(description);
  };

  const handleDescKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleDescSave();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDescCancel();
    }
  };

  // Comment handlers
  const handleAddComment = async () => {
    const text = newComment.trim();
    if (!text) return;
    setSubmittingComment(true);
    try {
      const comment = await addComment(card.id, text);
      setComments((prev) => [...prev, comment]);
      setNewComment('');
      await onUpdate();
    } catch (err) {
      console.error('Failed to add comment:', err);
    } finally {
      setSubmittingComment(false);
    }
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleAddComment();
    }
  };

  const handleEditComment = (comment: Comment) => {
    setEditingCommentId(comment.id);
    setEditCommentDraft(comment.text);
  };

  const handleSaveEditComment = async (commentId: string) => {
    const text = editCommentDraft.trim();
    if (!text) return;
    try {
      const updated = await updateComment(card.id, commentId, text);
      setComments((prev) => prev.map((c) => (c.id === commentId ? updated : c)));
      setEditingCommentId(null);
    } catch (err) {
      console.error('Failed to update comment:', err);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      await deleteComment(card.id, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      await onUpdate();
    } catch (err) {
      console.error('Failed to delete comment:', err);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40 flex items-start justify-center pt-[5vh] pb-[5vh] overflow-y-auto" onClick={onClose}>
        {/* Modal */}
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Card: ${cleanTitle(card.title, priorities)}`}
          onClick={(e) => e.stopPropagation()}
          className="bg-board-bg border border-board-border rounded-xl shadow-2xl w-full max-w-3xl my-auto"
        >
          {/* Header */}
          <div className="flex items-start justify-between p-6 pb-0">
            <div className="flex-1 pr-4">
              <h2 className="text-xl font-semibold text-board-text leading-snug">
                {cleanTitle(card.title, priorities)}
              </h2>
              <p className="text-xs text-board-text-muted mt-1">
                {card.board_id} · Line {card.line_number}
              </p>
            </div>
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close"
              className="text-board-text-muted hover:text-board-text text-xl leading-none p-2 rounded-lg hover:bg-board-column focus:outline-none"
            >
              ✕
            </button>
          </div>

          <div className="p-6 grid grid-cols-[1fr_200px] gap-6">
            {/* Main content */}
            <div className="space-y-5 min-w-0">
              {/* Description */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider flex items-center gap-1.5">
                    📝 Description
                  </h3>
                  {!editingDesc && description && (
                    <button
                      onClick={() => { setDescDraft(description); setEditingDesc(true); }}
                      className="text-[11px] text-board-text-muted hover:text-board-text transition-colors"
                    >
                      Edit
                    </button>
                  )}
                </div>
                {editingDesc ? (
                  <div>
                    <textarea
                      ref={descRef}
                      value={descDraft}
                      onChange={(e) => {
                        setDescDraft(e.target.value);
                        e.target.style.height = 'auto';
                        e.target.style.height = e.target.scrollHeight + 'px';
                      }}
                      onKeyDown={handleDescKeyDown}
                      placeholder="Add a description…"
                      className="w-full text-sm text-board-text bg-board-column border border-board-border rounded-lg p-3 focus:outline-none resize-none min-h-[80px]"
                      style={{ ['--tw-ring-color' as string]: 'var(--board-accent-ring)' }}
                    />
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={handleDescSave}
                        className="px-3 py-1 text-xs font-medium text-white rounded-md transition-colors"
                        style={{ backgroundColor: 'var(--board-accent)' }}
                      >
                        Save
                      </button>
                      <button
                        onClick={handleDescCancel}
                        className="px-3 py-1 text-xs text-board-text-muted hover:text-board-text transition-colors"
                      >
                        Cancel
                      </button>
                      <span className="text-[10px] text-board-text-muted ml-auto">⌘+Enter to save</span>
                    </div>
                  </div>
                ) : description ? (
                  <div
                    onClick={() => { setDescDraft(description); setEditingDesc(true); }}
                    className="text-sm text-board-text bg-board-column rounded-lg p-3 cursor-text hover:bg-board-card-hover transition-colors whitespace-pre-wrap break-words"
                  >
                    {description}
                  </div>
                ) : (
                  <div
                    onClick={() => { setDescDraft(''); setEditingDesc(true); }}
                    className="text-sm text-board-text-muted bg-board-column rounded-lg p-3 cursor-text hover:bg-board-card-hover transition-colors italic"
                  >
                    Add a description…
                  </div>
                )}
              </div>

              {/* Links */}
              {links.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    🔗 Links
                  </h3>
                  <div className="space-y-1.5">
                    {links.map((link, i) => (
                      <a
                        key={i}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm hover:underline px-2 py-1 rounded hover:bg-board-column transition-colors"
                        style={{ color: 'var(--board-accent)' }}
                      >
                        🔗 <span className="truncate">{link.text}</span>
                        <span className="text-board-text-muted text-[10px] ml-auto">↗</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Sub-items */}
              {card.sub_items.length > 0 && (
                <div>
                  <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    ☰ Sub-items ({card.sub_items.length})
                  </h3>
                  <ul className="space-y-1">
                    {card.sub_items.map((item, i) => (
                      <li key={i} className="text-sm text-board-text pl-3 border-l-2 border-board-border py-0.5">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Comments */}
              <div>
                <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  💬 Comments {comments.length > 0 && `(${comments.length})`}
                </h3>

                {/* Comment list */}
                {loadingComments ? (
                  <div className="text-xs text-board-text-muted animate-pulse py-2">Loading comments…</div>
                ) : comments.length > 0 ? (
                  <div className="space-y-3 mb-4">
                    {comments.map((comment) => (
                      <div key={comment.id} className="group/comment flex gap-3">
                        {/* Avatar */}
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-medium flex-shrink-0 mt-0.5 ${authorColor(comment.author)}`}>
                          {authorInitial(comment.author)}
                        </div>
                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-xs font-medium text-board-text">{comment.author}</span>
                            <span className="text-[10px] text-board-text-muted">{timeAgo(comment.created_at)}</span>
                            {comment.updated_at !== comment.created_at && (
                              <span className="text-[10px] text-board-text-muted italic">(edited)</span>
                            )}
                            {/* Actions */}
                            <div className="ml-auto opacity-0 group-hover/comment:opacity-100 transition-opacity flex items-center gap-1">
                              <button
                                onClick={() => handleEditComment(comment)}
                                className="text-[10px] text-board-text-muted hover:text-board-text px-1"
                                title="Edit"
                              >
                                ✏️
                              </button>
                              <button
                                onClick={() => handleDeleteComment(comment.id)}
                                className="text-[10px] text-board-text-muted hover:text-red-400 px-1"
                                title="Delete"
                              >
                                🗑️
                              </button>
                            </div>
                          </div>
                          {editingCommentId === comment.id ? (
                            <div>
                              <textarea
                                autoFocus
                                value={editCommentDraft}
                                onChange={(e) => setEditCommentDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                    e.preventDefault();
                                    handleSaveEditComment(comment.id);
                                  }
                                  if (e.key === 'Escape') {
                                    setEditingCommentId(null);
                                  }
                                }}
                                className="w-full text-sm text-board-text bg-board-column border border-board-border rounded-md p-2 focus:outline-none resize-none min-h-[48px]"
                              />
                              <div className="flex items-center gap-2 mt-1">
                                <button
                                  onClick={() => handleSaveEditComment(comment.id)}
                                  className="px-2 py-0.5 text-[11px] font-medium text-white rounded transition-colors"
                                  style={{ backgroundColor: 'var(--board-accent)' }}
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditingCommentId(null)}
                                  className="px-2 py-0.5 text-[11px] text-board-text-muted hover:text-board-text"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="text-sm text-board-text whitespace-pre-wrap break-words">
                              {comment.text}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {/* Add comment */}
                <div className="flex gap-3">
                  <div className="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-medium flex-shrink-0 mt-0.5">
                    U
                  </div>
                  <div className="flex-1">
                    <textarea
                      ref={commentInputRef}
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      onKeyDown={handleCommentKeyDown}
                      placeholder="Write a comment…"
                      rows={1}
                      onFocus={(e) => { e.target.rows = 3; }}
                      onBlur={(e) => { if (!newComment.trim()) e.target.rows = 1; }}
                      className="w-full text-sm text-board-text bg-board-column border border-board-border rounded-lg p-2.5 focus:outline-none resize-none placeholder:text-board-text-muted/60 transition-all"
                      style={{ ['--tw-ring-color' as string]: 'var(--board-accent-ring)' }}
                    />
                    {newComment.trim() && (
                      <div className="flex items-center gap-2 mt-1.5">
                        <button
                          onClick={handleAddComment}
                          disabled={submittingComment}
                          className="px-3 py-1 text-xs font-medium text-white rounded-md transition-colors disabled:opacity-50"
                          style={{ backgroundColor: 'var(--board-accent)' }}
                        >
                          {submittingComment ? 'Sending…' : 'Comment'}
                        </button>
                        <span className="text-[10px] text-board-text-muted">⌘+Enter</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Source */}
              <div>
                <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-2">Source</h3>
                <pre className="text-xs bg-board-column rounded-lg p-3 overflow-x-auto text-board-text-muted whitespace-pre-wrap break-all">
                  {card.raw_line}
                </pre>
              </div>
            </div>

            {/* Sidebar — editable fields */}
            <div className="space-y-4">
              {/* Status */}
              <div>
                <label className="text-xs font-medium text-board-text-muted uppercase tracking-wider block mb-1">Status</label>
                <select
                  value={columnName}
                  onChange={(e) => handleColumnChange(e.target.value)}
                  className="w-full text-sm bg-board-column border border-board-border rounded-md px-2 py-1.5 text-board-text focus:outline-none cursor-pointer"
                  style={{ ['--tw-ring-color' as string]: 'var(--board-accent-ring)' }}
                >
                  {columns.map((col) => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>

              {/* Priority */}
              <div>
                <label className="text-xs font-medium text-board-text-muted uppercase tracking-wider block mb-1">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => handlePriorityChange(e.target.value)}
                  className="w-full text-sm bg-board-column border border-board-border rounded-md px-2 py-1.5 text-board-text focus:outline-none cursor-pointer"
                >
                  <option value="">None</option>
                  {priorities.map((p) => (
                    <option key={p.id} value={p.id}>{p.emoji} {p.label}</option>
                  ))}
                </select>
              </div>

              {/* Due date */}
              <div>
                <label className="text-xs font-medium text-board-text-muted uppercase tracking-wider block mb-1">Due date</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => handleDueDateChange(e.target.value)}
                  className="w-full text-sm bg-board-column border border-board-border rounded-md px-2 py-1.5 text-board-text focus:outline-none"
                />
              </div>

              {/* Labels */}
              {card.labels.length > 0 && (
                <div>
                  <label className="text-xs font-medium text-board-text-muted uppercase tracking-wider block mb-1">Labels</label>
                  <div className="flex flex-wrap gap-1">
                    {card.labels.map((label, i) => (
                      <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-board-column text-board-text border border-board-border">
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Custom fields */}
              {fields.length > 0 && (
                <div>
                  <label className="text-xs font-medium text-board-text-muted uppercase tracking-wider block mb-2">Custom Fields</label>
                  <div className="space-y-2">
                    {fields.map((field) => (
                        <CustomFieldInput
                          key={field.id}
                          field={field}
                          value={fieldValues.find((v) => v.field_id === field.id)?.value ?? ''}
                          cardId={card.id}
                          onSaved={async () => {
                            const updated = await fetchFieldValues(card.id);
                            setFieldValues(updated);
                            await onUpdate();
                          }}
                          onLocalChange={(val) => {
                            setFieldValues((prev) =>
                              prev.map((fv2) => fv2.field_id === field.id ? { ...fv2, value: val } : fv2)
                                .concat(prev.some((fv2) => fv2.field_id === field.id) ? [] : [{
                                  field_id: field.id,
                                  field_name: field.name,
                                  field_type: field.type,
                                  options: field.options,
                                  value: val,
                                }])
                            );
                          }}
                        />
                      ))}
                  </div>
                </div>
              )}

              {/* Done badge */}
              {card.is_done && (
                <div className="flex items-center gap-1.5 text-green-500 text-sm">
                  ✓ Completed
                </div>
              )}

              {/* Metadata */}
              <div className="pt-3 border-t border-board-border space-y-1 text-[11px] text-board-text-muted">
                <div>ID: <span className="font-mono">{card.id}</span></div>
                <div>Created: {new Date(card.created_at).toLocaleString()}</div>
                <div>Updated: {new Date(card.updated_at).toLocaleString()}</div>
              </div>

              {saving && (
                <div className="text-xs animate-pulse" style={{ color: 'var(--board-accent)' }}>Saving…</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
