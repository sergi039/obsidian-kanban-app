import { useState, useEffect, useCallback } from 'react';
import { fetchBoards, fetchBoard, reloadSync } from './api/client';
import type { BoardSummary, BoardDetail } from './types';
import { BoardSwitcher } from './components/BoardSwitcher';
import { Board } from './components/Board';
import { Filters } from './components/Filters';
import { CardDetail } from './components/CardDetail';
import { useWebSocket } from './hooks/useWebSocket';
import type { Card } from './types';

export default function App() {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [boardDetail, setBoardDetail] = useState<BoardDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchText, setSearchText] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<string>('');
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);

  // Load boards list
  useEffect(() => {
    fetchBoards().then((data) => {
      setBoards(data);
      if (data.length > 0 && !activeBoardId) {
        setActiveBoardId(data[0].id);
      }
      setLoading(false);
    });
  }, []);

  // Load active board detail
  const loadBoard = useCallback(async () => {
    if (!activeBoardId) return;
    const detail = await fetchBoard(activeBoardId);
    setBoardDetail(detail);
  }, [activeBoardId]);

  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

  // WebSocket: auto-refresh when files change
  const handleWsUpdate = useCallback(
    (boardId?: string) => {
      // Refresh active board if it matches or no specific board
      if (!boardId || boardId === activeBoardId) {
        loadBoard();
      }
      // Always refresh board list counts
      fetchBoards().then(setBoards);
    },
    [activeBoardId, loadBoard],
  );
  useWebSocket(handleWsUpdate);

  const handleBoardChange = (boardId: string) => {
    setActiveBoardId(boardId);
    setSearchText('');
    setPriorityFilter('');
  };

  const handleReload = async () => {
    await reloadSync();
    await loadBoard();
    const updatedBoards = await fetchBoards();
    setBoards(updatedBoards);
  };

  const filterCards = (cards: Card[]) => {
    return cards.filter((card) => {
      if (searchText && !card.title.toLowerCase().includes(searchText.toLowerCase())) {
        return false;
      }
      if (priorityFilter && card.priority !== priorityFilter) {
        return false;
      }
      return true;
    });
  };

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
            searchText={searchText}
            onSearchChange={setSearchText}
            priorityFilter={priorityFilter}
            onPriorityChange={setPriorityFilter}
          />
          <button
            onClick={handleReload}
            className="px-3 py-1.5 text-sm bg-board-column hover:bg-board-card border border-board-border rounded-md text-board-text-muted hover:text-board-text transition-colors"
            title="Reload from files"
          >
            ↻ Sync
          </button>
        </div>
      </header>

      {/* Board */}
      <main className="flex-1 overflow-x-auto p-6">
        {boardDetail ? (
          <Board
            board={boardDetail}
            filterCards={filterCards}
            onCardMove={loadBoard}
            onCardClick={setSelectedCard}
          />
        ) : (
          <div className="text-board-text-muted text-center mt-20">Select a board</div>
        )}
      </main>

      {/* Card detail drawer */}
      {selectedCard && (
        <CardDetail card={selectedCard} onClose={() => setSelectedCard(null)} />
      )}
    </div>
  );
}
