import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Card } from '../types';
import { DraggableCard } from './DraggableCard';
import { AddCard } from './AddCard';
import { ColumnMenu } from './ColumnManager';

interface Props {
  name: string;
  cards: Card[];
  boardId: string;
  onCardClick: (card: Card) => void;
  onCardAdd: (title: string, column: string) => Promise<void>;
  onColumnRename: (oldName: string, newName: string) => Promise<void>;
  onColumnDelete: (name: string) => Promise<void>;
}

const COLUMN_COLORS: Record<string, string> = {
  Backlog: 'bg-gray-400 dark:bg-gray-500',
  'In Progress': 'bg-blue-500',
  Blocked: 'bg-red-500',
  Done: 'bg-green-500',
  Review: 'bg-purple-500',
  Testing: 'bg-yellow-500',
};

export function Column({ name, cards, boardId, onCardClick, onCardAdd, onColumnRename, onColumnDelete }: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${name}`,
    data: { type: 'column', columnName: name },
  });

  const cardIds = cards.map((c) => c.id);

  return (
    <div
      className="group/col flex flex-col w-80 min-w-[320px] shrink-0 rounded-lg transition-colors"
      style={isOver ? { backgroundColor: 'var(--board-drop-highlight)' } : undefined}
    >
      {/* Column header */}
      <div className="flex items-center justify-center gap-2 px-3 py-2.5 mb-2 group relative">
        <span className={`w-2.5 h-2.5 rounded-full ${COLUMN_COLORS[name] || 'bg-gray-400'}`} />
        <h3 className="text-sm font-medium text-board-text">{name}</h3>
        <span className="text-xs text-board-text-muted bg-board-column px-1.5 py-0.5 rounded-full">
          {cards.length}
        </span>
        <div className="absolute right-3">
          <ColumnMenu name={name} onRename={onColumnRename} onDelete={onColumnDelete} />
        </div>
      </div>

      {/* Cards list — sortable within column */}
      <div ref={setNodeRef} className="flex flex-col gap-2 px-1 pb-2 flex-1 min-h-[100px]">
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <DraggableCard key={card.id} card={card} onClick={() => onCardClick(card)} />
          ))}
        </SortableContext>
        {cards.length === 0 && !isOver && (
          <div
            className="text-xs text-board-text-muted text-center py-8 border border-dashed rounded-lg"
            style={{ borderColor: 'var(--board-border)', opacity: 0.5 }}
          >
            No items
          </div>
        )}
      </div>

      {/* Add card */}
      <div className="px-1 pb-3">
        <AddCard boardId={boardId} columnName={name} onAdd={(title) => onCardAdd(title, name)} />
      </div>
    </div>
  );
}
