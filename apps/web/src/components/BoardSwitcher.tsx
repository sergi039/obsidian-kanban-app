import type { BoardSummary } from '../types';

interface Props {
  boards: BoardSummary[];
  activeBoardId: string | null;
  onSelect: (id: string) => void;
}

export function BoardSwitcher({ boards, activeBoardId, onSelect }: Props) {
  return (
    <nav className="flex gap-1">
      {boards.map((board) => (
        <button
          key={board.id}
          onClick={() => onSelect(board.id)}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            board.id === activeBoardId
              ? 'bg-board-accent/15 text-board-accent border border-board-accent/30'
              : 'text-board-text-muted hover:text-board-text hover:bg-board-column border border-transparent'
          }`}
        >
          {board.name}
          <span className="ml-1.5 text-xs opacity-60">{board.totalCards}</span>
        </button>
      ))}
    </nav>
  );
}
