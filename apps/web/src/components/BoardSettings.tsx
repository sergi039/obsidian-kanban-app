import { useEffect, useMemo, useRef, useState } from 'react';
import type { PriorityDef, CategoryDef } from '../types';

const PRIORITY_EMOJIS = [
  '🔺', '⏫', '🟦', '⬇️', '⭐', '🔥', '⚡', '🚨',
  '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚪', '⚫',
  '💎', '🎯', '🏷️', '📌', '🔔', '💡', '🛑', '✅',
];

function EmojiPicker({ value, onChange }: { value: string; onChange: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-sm bg-board-bg border border-board-border rounded px-2 py-1 text-center hover:bg-board-column cursor-pointer"
        title="Choose icon"
      >
        {value}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-board-bg border border-board-border rounded-lg shadow-xl p-2 grid grid-cols-8 gap-1 w-[240px]">
          {PRIORITY_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => { onChange(emoji); setOpen(false); }}
              className={`w-7 h-7 text-sm rounded hover:bg-board-column flex items-center justify-center ${emoji === value ? 'bg-blue-100 ring-1 ring-blue-400' : ''}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  open: boolean;
  boardName: string;
  columns: string[];
  priorities: PriorityDef[];
  categories: CategoryDef[];
  onClose: () => void;
  onSavePriorities: (priorities: PriorityDef[]) => Promise<void>;
  onSaveCategories: (categories: CategoryDef[]) => Promise<void>;
}

function slugify(input: string, fallback = 'item'): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function uniqueId(base: string, existing: Set<string>): string {
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

const CATEGORY_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4', '#f97316'];

export function BoardSettingsModal({ open, boardName, columns, priorities, categories, onClose, onSavePriorities, onSaveCategories }: Props) {
  const [priDraft, setPriDraft] = useState<PriorityDef[]>([]);
  const [catDraft, setCatDraft] = useState<CategoryDef[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPriDraft(priorities.map((p) => ({ ...p })));
    setCatDraft(categories.map((c) => ({ ...c })));
    setError(null);
  }, [open, priorities, categories]);

  const usedPriIds = useMemo(() => new Set(priDraft.map((p) => p.id)), [priDraft]);
  const usedCatIds = useMemo(() => new Set(catDraft.map((c) => c.id)), [catDraft]);

  if (!open) return null;

  // --- Priority helpers ---
  const updatePriority = (index: number, patch: Partial<PriorityDef>) => {
    setPriDraft((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  const addPriority = () => {
    const base = slugify('New priority', 'priority');
    const id = uniqueId(base, usedPriIds);
    setPriDraft((prev) => [...prev, { id, label: 'New priority', emoji: '⭐', color: '#6b7280' }]);
  };

  const removePriority = (index: number) => {
    setPriDraft((prev) => prev.filter((_, i) => i !== index));
  };

  const movePriority = (index: number, direction: -1 | 1) => {
    setPriDraft((prev) => {
      const next = index + direction;
      if (next < 0 || next >= prev.length) return prev;
      const arr = [...prev];
      const [item] = arr.splice(index, 1);
      arr.splice(next, 0, item);
      return arr;
    });
  };

  // --- Category helpers ---
  const updateCategory = (index: number, patch: Partial<CategoryDef>) => {
    setCatDraft((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const addCategory = () => {
    const base = slugify('New category', 'category');
    const id = uniqueId(base, usedCatIds);
    const color = CATEGORY_COLORS[catDraft.length % CATEGORY_COLORS.length];
    setCatDraft((prev) => [...prev, { id, label: 'New category', color, showOnCard: true }]);
  };

  const removeCategory = (index: number) => {
    setCatDraft((prev) => prev.filter((_, i) => i !== index));
  };

  const moveCategory = (index: number, direction: -1 | 1) => {
    setCatDraft((prev) => {
      const next = index + direction;
      if (next < 0 || next >= prev.length) return prev;
      const arr = [...prev];
      const [item] = arr.splice(index, 1);
      arr.splice(next, 0, item);
      return arr;
    });
  };

  // --- Save ---
  const handleSave = async () => {
    // Validate priorities
    const cleanedPri = priDraft.map((p) => ({
      ...p,
      label: p.label.trim(),
      emoji: p.emoji.trim(),
      color: normalizeColor(p.color),
    }));

    if (cleanedPri.some((p) => p.label.length === 0)) {
      setError('Priority label cannot be empty.');
      return;
    }
    if (cleanedPri.some((p) => p.emoji.length === 0)) {
      setError('Priority emoji cannot be empty.');
      return;
    }
    if (new Set(cleanedPri.map((p) => p.id)).size !== cleanedPri.length) {
      setError('Priority IDs must be unique.');
      return;
    }

    // Validate categories
    const cleanedCat = catDraft.map((c) => ({
      ...c,
      label: c.label.trim(),
      color: normalizeColor(c.color),
    }));

    if (cleanedCat.some((c) => c.label.length === 0)) {
      setError('Category label cannot be empty.');
      return;
    }
    if (new Set(cleanedCat.map((c) => c.id)).size !== cleanedCat.length) {
      setError('Category IDs must be unique.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // Check what changed and save only what's needed
      const priChanged = JSON.stringify(cleanedPri) !== JSON.stringify(priorities);
      const catChanged = JSON.stringify(cleanedCat) !== JSON.stringify(categories);
      if (priChanged) await onSavePriorities(cleanedPri);
      if (catChanged) await onSaveCategories(cleanedCat);
      if (!priChanged && !catChanged) onClose();
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
          {/* Columns (read-only) */}
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

          {/* Priorities */}
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
            {priDraft.length === 0 ? (
              <div className="text-xs text-board-text-muted bg-board-column border border-board-border rounded-md p-3">
                No priorities configured. Cards can still use "none".
              </div>
            ) : (
              <div className="space-y-2">
                {priDraft.map((priority, i) => (
                  <div key={priority.id} className="grid grid-cols-[28px_90px_1fr_120px_120px_auto] gap-2 items-center bg-board-column border border-board-border rounded-md p-2">
                    <div className="text-xs text-board-text-muted text-center">{i + 1}</div>
                    <EmojiPicker
                      value={priority.emoji}
                      onChange={(emoji) => updatePriority(i, { emoji })}
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
                        disabled={i === priDraft.length - 1}
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

          {/* Categories */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-board-text">Categories</h3>
              <button
                onClick={addCategory}
                className="px-2.5 py-1.5 text-xs rounded-md border border-board-border text-board-text-muted hover:text-board-text hover:bg-board-column"
                type="button"
              >
                + Add category
              </button>
            </div>
            {catDraft.length === 0 ? (
              <div className="text-xs text-board-text-muted bg-board-column border border-board-border rounded-md p-3">
                No categories defined. Add categories to label and organize your cards.
              </div>
            ) : (
              <div className="space-y-2">
                {catDraft.map((cat, i) => (
                  <div key={cat.id} className="grid grid-cols-[28px_1fr_120px_50px_120px_auto] gap-2 items-center bg-board-column border border-board-border rounded-md p-2">
                    <div className="text-xs text-board-text-muted text-center">{i + 1}</div>
                    <input
                      value={cat.label}
                      onChange={(e) => {
                        const newLabel = e.target.value;
                        const newId = slugify(newLabel, 'category');
                        // Auto-generate id from label if it was previously auto-generated
                        const prevAutoId = slugify(catDraft[i].label, 'category');
                        const shouldAutoId = cat.id === prevAutoId || cat.id === uniqueId(prevAutoId, new Set(catDraft.filter((_, j) => j !== i).map((c) => c.id)));
                        const patch: Partial<CategoryDef> = { label: newLabel };
                        if (shouldAutoId) {
                          patch.id = uniqueId(newId, new Set(catDraft.filter((_, j) => j !== i).map((c) => c.id)));
                        }
                        updateCategory(i, patch);
                      }}
                      className="w-full text-sm bg-board-bg border border-board-border rounded px-2 py-1 text-board-text"
                      placeholder="Category label"
                    />
                    <div className="flex items-center gap-1.5">
                      <input
                        type="color"
                        value={normalizeColor(cat.color)}
                        onChange={(e) => updateCategory(i, { color: e.target.value })}
                        className="w-7 h-7 rounded border border-board-border cursor-pointer bg-transparent p-0"
                        title="Pick color"
                      />
                      <input
                        value={cat.color}
                        onChange={(e) => updateCategory(i, { color: e.target.value })}
                        className="w-full text-xs bg-board-bg border border-board-border rounded px-1.5 py-1 font-mono text-board-text"
                        placeholder="#3b82f6"
                      />
                    </div>
                    <label className="flex items-center gap-1 cursor-pointer" title="Show on card">
                      <input
                        type="checkbox"
                        checked={cat.showOnCard}
                        onChange={(e) => updateCategory(i, { showOnCard: e.target.checked })}
                        className="rounded border-board-border"
                      />
                      <span className="text-[10px] text-board-text-muted">Card</span>
                    </label>
                    <div className="text-[11px] text-board-text-muted font-mono px-2 py-1 bg-board-bg border border-board-border rounded truncate" title={cat.id}>
                      {cat.id}
                    </div>
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => moveCategory(i, -1)}
                        disabled={i === 0}
                        className="w-7 h-7 text-xs rounded border border-board-border text-board-text-muted disabled:opacity-40"
                        title="Move up"
                        type="button"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveCategory(i, 1)}
                        disabled={i === catDraft.length - 1}
                        className="w-7 h-7 text-xs rounded border border-board-border text-board-text-muted disabled:opacity-40"
                        title="Move down"
                        type="button"
                      >
                        ↓
                      </button>
                      <button
                        onClick={() => removeCategory(i)}
                        className="w-7 h-7 text-xs rounded border border-red-300 text-red-500 hover:bg-red-50"
                        title="Delete category"
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
            {saving ? 'Saving...' : 'Save settings'}
          </button>
        </div>
      </div>
    </div>
  );
}
