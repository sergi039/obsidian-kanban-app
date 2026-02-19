import type { BoardSummary } from '../types';

interface Props {
  boards: BoardSummary[];
  activeBoardId: string | null;
  onSelect: (id: string) => void;
}

export function BoardSwitcher({ boards, activeBoardId, onSelect }: Props) {
  return (
    <nav className="flex gap-1">
      {boards.map((board) => {
        const isActive = board.id === activeBoardId;
        return (
          <button
            key={board.id}
            onClick={() => onSelect(board.id)}
            className={`px-3 h-8 text-sm rounded-md transition-colors border ${
              isActive
                ? 'text-board-accent border-board-accent font-medium'
                : 'text-board-text-muted hover:text-board-text hover:bg-board-column border-transparent'
            }`}
            style={isActive ? { backgroundColor: 'var(--board-accent-subtle)' } : undefined}
          >
            {board.name}
            <span className="ml-1.5 text-xs opacity-60">{board.totalCards}</span>
          </button>
        );
      })}
    </nav>
  );
}
