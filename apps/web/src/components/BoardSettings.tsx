import { useEffect, useMemo, useState } from 'react';
import type { PriorityDef } from '../types';

interface Props {
  open: boolean;
  boardName: string;
  columns: string[];
  priorities: PriorityDef[];
  onClose: () => void;
  onSave: (priorities: PriorityDef[]) => Promise<void>;
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'priority';
}

function uniquePriorityId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  let idx = 2;
  while (existing.has(`${base}-${idx}`)) idx++;
  return `${base}-${idx}`;
}

function normalizeColor(input: string): string {
  const c = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  }
  return '#6b7280';
}

export function BoardSettingsModal({ open, boardName, columns, priorities, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<PriorityDef[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(priorities.map((p) => ({ ...p })));
    setError(null);
  }, [open, priorities]);

  const usedIds = useMemo(() => new Set(draft.map((p) => p.id)), [draft]);

  if (!open) return null;

  const updatePriority = (index: number, patch: Partial<PriorityDef>) => {
    setDraft((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  const addPriority = () => {
    const base = slugify('New priority');
    const id = uniquePriorityId(base, usedIds);
    setDraft((prev) => [
      ...prev,
      {
        id,
        label: 'New priority',
        emoji: '⭐',
        color: '#6b7280',
      },
    ]);
  };

  const removePriority = (index: number) => {
    setDraft((prev) => prev.filter((_, i) => i !== index));
  };

  const movePriority = (index: number, direction: -1 | 1) => {
    setDraft((prev) => {
      const next = index + direction;
      if (next < 0 || next >= prev.length) return prev;
      const arr = [...prev];
      const [item] = arr.splice(index, 1);
      arr.splice(next, 0, item);
      return arr;
    });
  };

  const handleSave = async () => {
    const cleaned = draft.map((p) => ({
      ...p,
      label: p.label.trim(),
      emoji: p.emoji.trim(),
      color: normalizeColor(p.color),
    }));

    if (cleaned.some((p) => p.label.length === 0)) {
      setError('Priority label cannot be empty.');
      return;
    }
    if (cleaned.some((p) => p.emoji.length === 0)) {
      setError('Priority emoji cannot be empty.');
      return;
    }
    if (new Set(cleaned.map((p) => p.id)).size !== cleaned.length) {
      setError('Priority IDs must be unique.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(cleaned);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-board-bg border border-board-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-board-border">
          <h2 className="text-lg font-semibold text-board-text">{boardName} · Board settings</h2>
          <button
            onClick={onClose}
            className="text-board-text-muted hover:text-board-text text-xl leading-none p-1 rounded-md hover:bg-board-column"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        <div className="p-6 space-y-6">
          <section>
            <h3 className="text-sm font-medium text-board-text mb-2">Columns</h3>
            <p className="text-xs text-board-text-muted mb-2">
              Columns are managed directly on the board (drag headers to reorder, menu to rename/delete).
            </p>
            <div className="flex flex-wrap gap-2">
              {columns.map((c) => (
                <span key={c} className="text-xs px-2 py-1 rounded-full bg-board-column border border-board-border text-board-text">
                  {c}
                </span>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-board-text">Priorities</h3>
              <button
                onClick={addPriority}
                className="px-2.5 py-1.5 text-xs rounded-md border border-board-border text-board-text-muted hover:text-board-text hover:bg-board-column"
                type="button"
              >
                + Add priority
              </button>
            </div>
            {draft.length === 0 ? (
              <div className="text-xs text-board-text-muted bg-board-column border border-board-border rounded-md p-3">
                No priorities configured. Cards can still use "none".
              </div>
            ) : (
              <div className="space-y-2">
                {draft.map((priority, i) => (
                  <div key={priority.id} className="grid grid-cols-[28px_90px_1fr_120px_120px_auto] gap-2 items-center bg-board-column border border-board-border rounded-md p-2">
                    <div className="text-xs text-board-text-muted text-center">{i + 1}</div>
                    <input
                      value={priority.emoji}
                      onChange={(e) => updatePriority(i, { emoji: e.target.value })}
                      className="w-full text-sm bg-board-bg border border-board-border rounded px-2 py-1 text-center"
                      placeholder="🔺"
                    />
                    <input
                      value={priority.label}
                      onChange={(e) => updatePriority(i, { label: e.target.value })}
                      className="w-full text-sm bg-board-bg border border-board-border rounded px-2 py-1 text-board-text"
                      placeholder="Priority label"
                    />
                    <input
                      value={priority.color}
                      onChange={(e) => updatePriority(i, { color: e.target.value })}
                      className="w-full text-sm bg-board-bg border border-board-border rounded px-2 py-1 font-mono text-board-text"
                      placeholder="#ef4444"
                    />
                    <div className="text-[11px] text-board-text-muted font-mono px-2 py-1 bg-board-bg border border-board-border rounded">
                      {priority.id}
                    </div>
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => movePriority(i, -1)}
                        disabled={i === 0}
                        className="w-7 h-7 text-xs rounded border border-board-border text-board-text-muted disabled:opacity-40"
                        title="Move up"
                        type="button"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => movePriority(i, 1)}
                        disabled={i === draft.length - 1}
                        className="w-7 h-7 text-xs rounded border border-board-border text-board-text-muted disabled:opacity-40"
                        title="Move down"
                        type="button"
                      >
                        ↓
                      </button>
                      <button
                        onClick={() => removePriority(i)}
                        className="w-7 h-7 text-xs rounded border border-red-300 text-red-500 hover:bg-red-50"
                        title="Delete priority"
                        type="button"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {error && (
            <div className="text-xs text-red-500 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-board-border flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-board-text-muted hover:text-board-text"
            type="button"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm text-white rounded-md disabled:opacity-50"
            style={{ backgroundColor: 'var(--board-accent)' }}
            type="button"
          >
            {saving ? 'Saving…' : 'Save priorities'}
          </button>
        </div>
      </div>
    </div>
  );
}
