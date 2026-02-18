import { useDroppable } from '@dnd-kit/core';
import type { Card } from '../types';
import { DraggableCard } from './DraggableCard';
import { AddCard } from './AddCard';

interface Props {
  name: string;
  cards: Card[];
  boardId: string;
  onCardClick: (card: Card) => void;
  onCardAdd: (title: string, column: string) => Promise<void>;
}

const COLUMN_COLORS: Record<string, string> = {
  Backlog: 'bg-gray-400 dark:bg-gray-500',
  'In Progress': 'bg-blue-500',
  Blocked: 'bg-red-500',
  Done: 'bg-green-500',
};

export function Column({ name, cards, boardId, onCardClick, onCardAdd }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: name });

  return (
    <div
      ref={setNodeRef}
      className="flex flex-col w-80 min-w-[320px] shrink-0 rounded-lg transition-colors"
      style={isOver ? { backgroundColor: 'var(--board-drop-highlight)' } : undefined}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-2.5 mb-2">
        <span className={`w-2.5 h-2.5 rounded-full ${COLUMN_COLORS[name] || 'bg-gray-400'}`} />
        <h3 className="text-sm font-medium text-board-text">{name}</h3>
        <span className="text-xs text-board-text-muted bg-board-column px-1.5 py-0.5 rounded-full">
          {cards.length}
        </span>
      </div>

      {/* Cards list */}
      <div className="flex flex-col gap-2 px-1 pb-2 flex-1 min-h-[100px]">
        {cards.map((card) => (
          <DraggableCard key={card.id} card={card} onClick={() => onCardClick(card)} />
        ))}
        {cards.length === 0 && !isOver && (
          <div
            className="text-xs text-board-text-muted text-center py-8 border border-dashed rounded-lg"
            style={{ borderColor: 'var(--board-border)', opacity: 0.5 }}
          >
            No items
          </div>
        )}
      </div>

      {/* Add card button */}
      <div className="px-1 pb-3">
        <AddCard
          boardId={boardId}
          columnName={name}
          onAdd={(title) => onCardAdd(title, name)}
        />
      </div>
    </div>
  );
}
