import { useDraggable } from '@dnd-kit/core';
import type { Card } from '../types';
import { KanbanCard } from './Card';

interface Props {
  card: Card;
  onClick: () => void;
}

export function DraggableCard({ card, onClick }: Props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ opacity: isDragging ? 0.3 : 1, touchAction: 'none' }}
    >
      <KanbanCard card={card} onClick={onClick} />
    </div>
  );
}
