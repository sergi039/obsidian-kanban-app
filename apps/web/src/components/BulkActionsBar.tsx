import { useState } from 'react';

interface Props {
  count: number;
  columns: string[];
  onMove: (column: string) => Promise<void>;
  onClear: () => void;
}

function isDoneLike(column: string): boolean {
  return ['done', 'complete', 'completed'].includes(column.toLowerCase());
}

/**
 * Floating bar shown while cards are selected.
 * Offers bulk move to any column (Done acts as "close all selected").
 */
export function BulkActionsBar({ count, columns, onMove, onClear }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMove = async (column: string) => {
    setBusy(true);
    setError(null);
    try {
      await onMove(column);
    } catch (err) {
      console.error('Bulk move failed:', err);
      setError('Bulk move failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="toolbar"
      aria-label="Bulk card actions"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2.5 rounded-xl border border-board-border bg-board-card shadow-2xl"
    >
      <span className="text-sm font-medium text-board-text whitespace-nowrap">
        {count} selected
      </span>
      <span className="text-sm text-board-text-muted whitespace-nowrap">Move to:</span>
      <div className="flex items-center gap-1.5 flex-wrap">
        {columns.map((column) =>
          isDoneLike(column) ? (
            <button
              key={column}
              type="button"
              disabled={busy}
              onClick={() => handleMove(column)}
              className="px-2.5 h-7 text-xs font-medium rounded-md border border-green-600/40 bg-green-500/10 text-green-500 hover:bg-green-500/20 transition-colors disabled:opacity-50"
              title={`Close ${count} card${count === 1 ? '' : 's'} (move to ${column})`}
            >
              ✓ {column}
            </button>
          ) : (
            <button
              key={column}
              type="button"
              disabled={busy}
              onClick={() => handleMove(column)}
              className="px-2.5 h-7 text-xs rounded-md border border-board-border bg-board-column hover:bg-board-card-hover text-board-text transition-colors disabled:opacity-50"
            >
              {column}
            </button>
          ),
        )}
      </div>
      {error && <span className="text-xs text-red-500">{error}</span>}
      <button
        type="button"
        disabled={busy}
        onClick={onClear}
        className="px-2.5 h-7 text-xs rounded-md text-board-text-muted hover:text-board-text hover:bg-board-column transition-colors disabled:opacity-50"
        title="Clear selection"
      >
        ✕ Clear
      </button>
    </div>
  );
}
