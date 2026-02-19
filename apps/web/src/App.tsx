import { useState, useEffect, useCallback } from 'react';
import { fetchBoards, fetchBoard, reloadSync, createCard, addColumn, renameColumn, deleteColumn, fetchFields } from './api/client';
import type { BoardSummary, BoardDetail, Field } from './types';
import { BoardSwitcher } from './components/BoardSwitcher';
import { Board } from './components/Board';
import { DndTest } from './components/DndTest';
import { TableView } from './components/TableView';
import { ViewSwitcher } from './components/ViewSwitcher';
import { Filters } from './components/Filters';
import { CardDetail } from './components/CardDetail';
import { useWebSocket } from './hooks/useWebSocket';
import { useTheme } from './hooks/useTheme';
import { ThemeToggle } from './components/ThemeToggle';
import { AutomationsPanel } from './components/AutomationsPanel';
import type { Card } from './types';

export default function App() {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [boardDetail, setBoardDetail] = useState<BoardDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [layout, setLayout] = useState<'board' | 'table'>('board');
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [boardFields, setBoardFields] = useState<Field[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [showAutomations, setShowAutomations] = useState(false);
  const [showDndTest, setShowDndTest] = useState(false);
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

  // Load active board detail + fields
  const loadBoard = useCallback(async () => {
    if (!activeBoardId) return;
    try {
      const [detail, fields] = await Promise.all([
        fetchBoard(activeBoardId),
        fetchFields(activeBoardId),
      ]);
      setBoardDetail(detail);
      setBoardFields(fields);
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

    // Parse query with same logic as backend: split by whitespace, respect quotes
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let qChar = '';
    for (const ch of filterQuery.trim()) {
      if (inQuote) {
        if (ch === qChar) inQuote = false;
        else current += ch;
      } else if (ch === '"' || ch === "'") {
        inQuote = true; qChar = ch;
      } else if (ch === ' ' || ch === '\t') {
        if (current) { parts.push(current); current = ''; }
      } else current += ch;
    }
    if (current) parts.push(current);

    const KNOWN = new Set(['status', 'priority', 'label', 'due', 'done', 'has', 'board']);

    return cards.filter((card) => {
      for (const part of parts) {
        const m = part.match(/^(-?)([a-zA-Z_]+):(.+)$/);
        if (m && KNOWN.has(m[2].toLowerCase())) {
          const neg = m[1] === '-';
          const qual = m[2].toLowerCase();
          const vals = m[3].split(',').map((v) => v.trim()).filter(Boolean);
          if (vals.length === 0) continue;

          let match = false;
          switch (qual) {
            case 'status':
              match = vals.some((v) => card.column_name.toLowerCase() === v.toLowerCase());
              break;
            case 'priority':
              if (vals.includes('none')) match = !card.priority;
              else match = vals.some((v) => card.priority === v.toLowerCase());
              break;
            case 'label':
              // Mirror backend: non-negated = OR (any label matches), negated = AND (all labels must NOT match)
              // Negation is applied by the outer `if (neg ? match : !match)` so:
              // - label:bug,feature → match if card has bug OR feature
              // - -label:bug,feature → match if card has NONE of bug, feature
              //   (outer negation flips: match=true means "has one" → neg+match → filtered out)
              match = vals.some((v) => card.labels.some((l) => l.toLowerCase() === v.toLowerCase()));
              break;
            case 'done':
              match = ['yes', 'true', '1'].includes(vals[0]?.toLowerCase()) ? card.is_done : !card.is_done;
              break;
            case 'has': {
              const hv = vals[0]?.toLowerCase();
              if (hv === 'description') match = !!card.description;
              else if (hv === 'priority') match = !!card.priority;
              else if (hv === 'labels' || hv === 'label') match = card.labels.length > 0;
              else if (hv === 'due' || hv === 'due_date') match = !!card.due_date;
              // has:comments not available client-side (no comment count on card)
              break;
            }
            case 'due': {
              const dv = vals[0]?.toLowerCase();
              if (dv === 'none') match = !card.due_date;
              else if (dv === 'any') match = !!card.due_date;
              else if (dv === 'overdue') {
                match = !!card.due_date && new Date(card.due_date) < new Date(new Date().toISOString().slice(0, 10));
              } else if (dv === 'today') {
                match = card.due_date === new Date().toISOString().slice(0, 10);
              } else if (dv === 'tomorrow') {
                const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
                match = card.due_date === tmr.toISOString().slice(0, 10);
              } else if (dv === 'this-week') {
                if (card.due_date) {
                  const d = new Date(card.due_date);
                  const now = new Date(new Date().toISOString().slice(0, 10));
                  const week = new Date(now); week.setDate(week.getDate() + 7);
                  match = d >= now && d <= week;
                }
              } else if (dv === 'this-month') {
                if (card.due_date) {
                  const d = new Date(card.due_date);
                  const now = new Date(new Date().toISOString().slice(0, 10));
                  const month = new Date(now); month.setDate(month.getDate() + 30);
                  match = d >= now && d <= month;
                }
              } else {
                match = card.due_date === dv;
              }
              break;
            }
            case 'board':
              match = vals.some((v) => card.board_id.toLowerCase() === v.toLowerCase());
              break;
          }
          if (neg ? match : !match) return false;
        } else {
          // Unknown qualifier or free text — search title
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
            <span className="flex items-center gap-1.5">
              <span className="text-purple-500">◆</span> Obsidian Kanban
            </span>
          </h1>
          <a
            href="/about"
            className="text-xs text-board-text-muted hover:text-board-text transition-colors"
            title="About this project"
          >
            ?
          </a>
          <BoardSwitcher
            boards={boards}
            activeBoardId={activeBoardId}
            onSelect={handleBoardChange}
          />
        </div>
        <div className="flex items-center gap-2">
          <Filters
            filterQuery={filterQuery}
            onFilterChange={setFilterQuery}
          />
          <ViewSwitcher layout={layout} onLayoutChange={setLayout} />
          <button
            onClick={() => setShowDndTest((v) => !v)}
            className="px-3 h-8 text-sm bg-yellow-100 dark:bg-yellow-900 hover:bg-yellow-200 border border-yellow-400 rounded-md text-yellow-800 dark:text-yellow-200 transition-colors"
            title="DnD Test"
          >
            🧪 Test
          </button>
          <button
            onClick={() => setShowAutomations(true)}
            className="px-3 h-8 text-sm bg-board-column hover:bg-board-card border border-board-border rounded-md text-board-text-muted hover:text-board-text transition-colors"
            title="Automations"
          >
            ⚡ Auto
          </button>
          <button
            onClick={handleReload}
            disabled={syncing}
            className="px-3 h-8 text-sm bg-board-column hover:bg-board-card border border-board-border rounded-md text-board-text-muted hover:text-board-text transition-colors disabled:opacity-50"
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
        {showDndTest ? (
          <DndTest />
        ) : boardDetail ? (
          layout === 'board' ? (
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
            <TableView
              cards={filterCards(boardDetail.columns.flatMap((col) => col.cards))}
              columns={boardDetail.columns.map((c) => c.name)}
              boardId={boardDetail.id}
              onCardClick={setSelectedCard}
              onCardAdd={handleCardAdd}
              onRefresh={loadBoard}
            />
          )
        ) : (
          <div className="text-board-text-muted text-center mt-20">Select a board</div>
        )}
      </main>

      {/* Card detail modal */}
      {selectedCard && (
        <CardDetail
          card={selectedCard}
          columns={boardDetail?.columns.map((c) => c.name) || []}
          fields={boardFields}
          onClose={() => setSelectedCard(null)}
          onUpdate={async () => {
            await loadBoard();
            const updatedBoards = await fetchBoards();
            setBoards(updatedBoards);
          }}
        />
      )}

      {/* Automations panel */}
      {showAutomations && activeBoardId && (
        <AutomationsPanel
          boardId={activeBoardId}
          columns={boardDetail?.columns.map((c) => c.name) || []}
          fields={boardFields}
          onClose={() => setShowAutomations(false)}
        />
      )}
    </div>
  );
}
