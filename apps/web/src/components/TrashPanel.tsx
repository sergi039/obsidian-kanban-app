import { useEffect, useState } from 'react';
import { fetchTrash, restoreCard } from '../api/client';
import type { Card } from '../types';
import { Icon } from './Icon';

interface Props {
  boardId: string;
  /** Changes whenever the board reloads, so the list follows trash/restore from other tabs. */
  trashCount: number;
  onClose: () => void;
  onRestored: () => Promise<void>;
}

function formatDeletedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function TrashPanel({ boardId, trashCount, onClose, onRestored }: Props) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTrash(boardId)
      .then((list) => {
        if (!cancelled) setCards(list);
      })
      .catch((err) => {
        console.error('Failed to load trash:', err);
        if (!cancelled) setError('Failed to load trash.');
      });
    return () => {
      cancelled = true;
    };
  }, [boardId, trashCount]);

  const restore = async (cardId: string) => {
    setRestoringId(cardId);
    setError(null);
    try {
      await restoreCard(cardId);
      setCards((prev) => prev?.filter((card) => card.id !== cardId) ?? prev);
      await onRestored();
    } catch (err) {
      console.error('Restore failed:', err);
      setError('Restore failed. Try Sync, then retry.');
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-30" onClick={onClose}>
      <div
        className="absolute right-6 top-16 w-[360px] max-w-[calc(100vw-2rem)] bg-board-bg border border-board-border rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-board-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-board-text">Trash</h2>
            <p className="text-xs text-board-text-muted">
              {cards ? `${cards.length} card${cards.length === 1 ? '' : 's'}` : 'Loading…'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-board-text-muted hover:text-board-text rounded-md px-2 py-1 flex items-center"
            aria-label="Close trash"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        {error && <div className="px-4 py-2 text-xs text-red-500 border-b border-board-border">{error}</div>}

        <div className="max-h-[70vh] overflow-y-auto p-2">
          {cards && cards.length === 0 && (
            <div className="text-sm text-board-text-muted py-8 text-center">Trash is empty</div>
          )}
          {cards && cards.length > 0 && (
            <div className="space-y-1">
              {cards.map((card) => (
                <div
                  key={card.id}
                  className="p-3 rounded-md hover:bg-board-column transition-colors border border-transparent hover:border-board-border flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-board-text line-clamp-2">
                      {card.seq_id != null && <span className="text-board-text-muted">#{card.seq_id} </span>}
                      {card.title}
                    </div>
                    <div className="text-[11px] text-board-text-muted mt-1">
                      {card.column_name} · deleted {formatDeletedAt(card.deleted_at)}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={restoringId !== null}
                    onClick={() => restore(card.id)}
                    className="text-[11px] px-2 py-1 rounded bg-board-card hover:bg-board-card-hover text-board-text-muted hover:text-board-text whitespace-nowrap disabled:opacity-50 inline-flex items-center gap-1"
                  >
                    {restoringId === card.id ? 'Restoring…' : <><Icon name="restore" size={12} /> Restore</>}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
