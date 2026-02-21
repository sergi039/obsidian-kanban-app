import { useState, useRef, useEffect } from 'react';

export type BoardSortField = 'position' | 'priority' | 'category' | 'due_date' | 'title' | 'updated_at';

interface Props {
  value: BoardSortField;
  onChange: (field: BoardSortField) => void;
}

const SORT_OPTIONS: { field: BoardSortField; label: string; icon: string }[] = [
  { field: 'position', label: 'Manual order', icon: '✋' },
  { field: 'priority', label: 'Priority', icon: '🔺' },
  { field: 'category', label: 'Category', icon: '🏷' },
  { field: 'due_date', label: 'Due date', icon: '📅' },
  { field: 'title', label: 'Title', icon: 'Aa' },
  { field: 'updated_at', label: 'Last updated', icon: '🕐' },
];

export function BoardSort({ value, onChange }: Props) {
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

  const active = SORT_OPTIONS.find(o => o.field === value);
  const isActive = value !== 'position';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`px-3 h-8 text-sm border rounded-md transition-colors flex items-center gap-1.5 ${
          isActive
            ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
            : 'bg-board-column hover:bg-board-card border-board-border text-board-text-muted hover:text-board-text'
        }`}
        title="Sort cards"
      >
        ↕ {isActive ? active?.label : 'Sort'}
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 bg-board-card border border-board-border rounded-lg shadow-lg py-1 min-w-[180px] z-50">
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.field}
              onClick={() => {
                onChange(opt.field === value ? 'position' : opt.field);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                opt.field === value
                  ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                  : 'text-board-text hover:bg-board-column'
              }`}
            >
              <span className="w-5 text-center text-xs">{opt.icon}</span>
              <span className="flex-1">{opt.label}</span>
              {opt.field === value && <span className="text-blue-500">✓</span>}
            </button>
          ))}
          {isActive && (
            <div className="border-t border-board-border mt-1 pt-1 px-3 py-1.5">
              <span className="text-[11px] text-amber-500">Drag & drop paused</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
