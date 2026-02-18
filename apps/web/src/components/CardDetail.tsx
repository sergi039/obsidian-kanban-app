import { useEffect, useRef, useState, useCallback } from 'react';
import { patchCard } from '../api/client';
import type { Card } from '../types';

interface Props {
  card: Card;
  columns: string[];
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

function cleanTitle(t: string): string {
  return t.replace(/\[([^\]]*)\]\([^)]+\)/g, '$1').replace(/https?:\/\/[^\s)\]]+/g, '').replace(/[⏫🔺]/g, '').replace(/\s+/g, ' ').trim();
}

export function CardDetail({ card, columns, onClose, onUpdate }: Props) {
  const links = extractLinks(card.title);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Editable fields
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(cleanTitle(card.title));
  const [priority, setPriority] = useState<string>(card.priority || '');
  const [dueDate, setDueDate] = useState(card.due_date || '');
  const [columnName, setColumnName] = useState(card.column_name);
  const [saving, setSaving] = useState(false);

  // Focus trap + Escape
  useEffect(() => {
    closeRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
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
  }, [onClose]);

  const saveField = useCallback(async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      await patchCard(card.id, patch as any);
      await onUpdate();
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving(false);
    }
  }, [card.id, onUpdate]);

  const handleTitleSave = () => {
    setEditingTitle(false);
    // Title editing would need write-back to .md — for now just update display
    // Full title editing requires Phase 5 (line rewrite in source file)
  };

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

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40 flex items-center justify-center p-4" onClick={onClose}>
        {/* Modal */}
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Card: ${cleanTitle(card.title)}`}
          onClick={(e) => e.stopPropagation()}
          className="bg-board-bg border border-board-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto"
        >
          {/* Header */}
          <div className="flex items-start justify-between p-6 pb-0">
            <div className="flex-1 pr-4">
              {editingTitle ? (
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={handleTitleSave}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleTitleSave(); if (e.key === 'Escape') { setTitleDraft(cleanTitle(card.title)); setEditingTitle(false); } }}
                  className="w-full text-xl font-semibold text-board-text bg-transparent border-b-2 focus:outline-none pb-1"
                  style={{ borderColor: 'var(--board-accent)' }}
                />
              ) : (
                <h2
                  className="text-xl font-semibold text-board-text leading-snug cursor-text hover:underline decoration-board-text-muted/30"
                  onClick={() => setEditingTitle(true)}
                  title="Click to edit"
                >
                  {cleanTitle(card.title)}
                </h2>
              )}
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
            <div>
              {/* Links */}
              {links.length > 0 && (
                <div className="mb-5">
                  <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-2">Links</h3>
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
                <div className="mb-5">
                  <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-2">
                    Sub-items ({card.sub_items.length})
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
                  <option value="high">⏫ High</option>
                  <option value="urgent">🔺 Urgent</option>
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

              {/* Done badge */}
              {card.is_done && (
                <div className="flex items-center gap-1.5 text-green-500 text-sm">
                  ✓ Completed
                </div>
              )}

              {/* Metadata */}
              <div className="pt-3 border-t border-board-border space-y-1 text-[11px] text-board-text-muted">
                <div>ID: <span className="font-mono">{card.id}</span></div>
                <div>Updated: {new Date(card.updated_at).toLocaleString()}</div>
              </div>

              {saving && (
                <div className="text-xs text-board-accent animate-pulse">Saving…</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
