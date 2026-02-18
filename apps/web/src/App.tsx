import { useState, useEffect, useCallback } from 'react';
import { fetchBoards, fetchBoard, reloadSync, createCard, addColumn, renameColumn, deleteColumn } from './api/client';
import type { BoardSummary, BoardDetail } from './types';
import { BoardSwitcher } from './components/BoardSwitcher';
import { Board } from './components/Board';
import { Filters } from './components/Filters';
import { CardDetail } from './components/CardDetail';
import { useWebSocket } from './hooks/useWebSocket';
import { useTheme } from './hooks/useTheme';
import { ThemeToggle } from './components/ThemeToggle';
import type { Card } from './types';

export default function App() {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [boardDetail, setBoardDetail] = useState<BoardDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { theme, cycleTheme } = useTheme();

  // Load boards list
  useEffect(() => {
    fetchBoards()
      .then((data) => {
        setBoards(data);
        if (data.length > 0 && !activeBoardId) {
          setActiveBoardId(data[0].id);
        }
        setError(null);
      })
      .catch((err) => {
        console.error('Failed to fetch boards:', err);
        setError('Failed to load boards. Is the API running?');
      })
      .finally(() => setLoading(false));
  }, []);

  // Load active board detail
  const loadBoard = useCallback(async () => {
    if (!activeBoardId) return;
    try {
      const detail = await fetchBoard(activeBoardId);
      setBoardDetail(detail);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch board:', err);
      setError(`Failed to load board "${activeBoardId}".`);
    }
  }, [activeBoardId]);

  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

  // WebSocket: auto-refresh when files change
  const handleWsUpdate = useCallback(
    (boardId?: string) => {
      if (!boardId || boardId === activeBoardId) {
        loadBoard();
      }
      fetchBoards().then(setBoards).catch(() => {});
    },
    [activeBoardId, loadBoard],
  );
  useWebSocket(handleWsUpdate);

  const handleBoardChange = (boardId: string) => {
    setActiveBoardId(boardId);
    setFilterQuery('');
  };

  const handleReload = async () => {
    setSyncing(true);
    try {
      await reloadSync();
      await loadBoard();
      const updatedBoards = await fetchBoards();
      setBoards(updatedBoards);
      setError(null);
    } catch (err) {
      console.error('Sync failed:', err);
      setError('Sync failed. Check server logs.');
    } finally {
      setSyncing(false);
    }
  };

  const handleCardMove = async () => {
    try {
      await loadBoard();
    } catch {
      // loadBoard already handles errors
    }
  };

  const handleCardAdd = async (title: string, column: string) => {
    if (!activeBoardId) return;
    await createCard(activeBoardId, title, column);
    await loadBoard();
    const updatedBoards = await fetchBoards();
    setBoards(updatedBoards);
  };

  const handleColumnAdd = async (name: string) => {
    if (!activeBoardId) return;
    await addColumn(activeBoardId, name);
    await loadBoard();
  };

  const handleColumnRename = async (oldName: string, newName: string) => {
    if (!activeBoardId) return;
    await renameColumn(activeBoardId, oldName, newName);
    await loadBoard();
  };

  const handleColumnDelete = async (name: string) => {
    if (!activeBoardId) return;
    if (!confirm(`Delete column "${name}"? Cards will be moved to another column.`)) return;
    await deleteColumn(activeBoardId, name);
    await loadBoard();
  };

  const filterCards = useCallback((cards: Card[]) => {
    if (!filterQuery.trim()) return cards;

    return cards.filter((card) => {
      const parts = filterQuery.trim().split(/\s+/);
      for (const part of parts) {
        const m = part.match(/^(-?)([a-zA-Z_]+):(.+)$/);
        if (m) {
          const neg = m[1] === '-';
          const qual = m[2].toLowerCase();
          const vals = m[3].split(',');

          let match = false;
          switch (qual) {
            case 'status':
              match = vals.some((v) => card.column_name.toLowerCase() === v.toLowerCase());
              break;
            case 'priority':
              if (vals.includes('none')) match = !card.priority;
              else match = vals.some((v) => card.priority === v);
              break;
            case 'label':
              match = vals.some((v) => card.labels.some((l) => l.toLowerCase().includes(v.toLowerCase())));
              break;
            case 'done':
              match = ['yes', 'true', '1'].includes(vals[0]) ? card.is_done : !card.is_done;
              break;
            case 'has':
              if (vals[0] === 'description') match = !!card.description;
              else if (vals[0] === 'priority') match = !!card.priority;
              else if (vals[0] === 'labels') match = card.labels.length > 0;
              else if (vals[0] === 'due' || vals[0] === 'due_date') match = !!card.due_date;
              break;
            case 'due':
              if (vals[0] === 'none') match = !card.due_date;
              else if (vals[0] === 'any') match = !!card.due_date;
              else match = card.due_date === vals[0];
              break;
          }
          if (neg ? match : !match) return false;
        } else {
          // Free text search
          if (!card.title.toLowerCase().includes(part.toLowerCase())) return false;
        }
      }
      return true;
    });
  }, [filterQuery]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-board-bg">
        <div className="text-board-text-muted text-lg">Loading boards…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-board-bg flex flex-col">
      {/* Header */}
      <header className="border-b border-board-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-board-text flex items-center gap-2">
            📋 Kanban
          </h1>
          <BoardSwitcher
            boards={boards}
            activeBoardId={activeBoardId}
            onSelect={handleBoardChange}
          />
        </div>
        <div className="flex items-center gap-3">
          <Filters
            filterQuery={filterQuery}
            onFilterChange={setFilterQuery}
          />
          <button
            onClick={handleReload}
            disabled={syncing}
            className="px-3 py-1.5 text-sm bg-board-column hover:bg-board-card border border-board-border rounded-md text-board-text-muted hover:text-board-text transition-colors disabled:opacity-50"
            title="Reload from files"
          >
            {syncing ? '⏳ Syncing…' : '↻ Sync'}
          </button>
          <ThemeToggle theme={theme} onCycle={cycleTheme} />
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="bg-red-100 dark:bg-red-900/30 border-b border-red-300 dark:border-red-700/50 px-6 py-2 text-sm text-red-700 dark:text-red-400">
          ⚠️ {error}
          <button
            onClick={() => setError(null)}
            className="ml-3 text-red-500 hover:text-red-300"
          >
            ✕
          </button>
        </div>
      )}

      {/* Board */}
      <main className="flex-1 overflow-x-auto p-6">
        {boardDetail ? (
          <Board
            board={boardDetail}
            filterCards={filterCards}
            onCardMove={handleCardMove}
            onCardClick={setSelectedCard}
            onCardAdd={handleCardAdd}
            onColumnAdd={handleColumnAdd}
            onColumnRename={handleColumnRename}
            onColumnDelete={handleColumnDelete}
          />
        ) : (
          <div className="text-board-text-muted text-center mt-20">Select a board</div>
        )}
      </main>

      {/* Card detail modal */}
      {selectedCard && (
        <CardDetail
          card={selectedCard}
          columns={boardDetail?.columns.map((c) => c.name) || []}
          onClose={() => setSelectedCard(null)}
          onUpdate={async () => {
            await loadBoard();
            const updatedBoards = await fetchBoards();
            setBoards(updatedBoards);
          }}
        />
      )}
    </div>
  );
}
