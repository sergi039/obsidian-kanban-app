import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Card } from '../types';
import { SortableCard } from './SortableCard';

interface Props {
  name: string;
  cards: Card[];
  onCardClick: (card: Card) => void;
}

const COLUMN_COLORS: Record<string, string> = {
  Backlog: 'bg-gray-400 dark:bg-gray-500',
  'In Progress': 'bg-blue-500',
  Blocked: 'bg-red-500',
  Done: 'bg-green-500',
};

export function Column({ name, cards, onCardClick }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: name });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col w-80 min-w-[320px] shrink-0 rounded-lg transition-colors ${
        isOver ? 'bg-board-accent/5' : ''
      }`}
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
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2 px-1 pb-4 flex-1 min-h-[100px]">
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} onClick={() => onCardClick(card)} />
          ))}
          {cards.length === 0 && (
            <div className="text-xs text-board-text-muted/40 text-center py-8 border border-dashed border-board-border/50 rounded-lg">
              Drop here
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}
