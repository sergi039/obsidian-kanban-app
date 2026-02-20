import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Card, PriorityDef, CategoryDef } from '../types';
import { KanbanCard } from './Card';

interface Props {
  card: Card;
  priorities: PriorityDef[];
  categories?: CategoryDef[];
  onClick: () => void;
}

export function DraggableCard({ card, priorities, categories, onClick }: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: card.id,
    data: { type: 'card', card },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
    touchAction: 'none',
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <KanbanCard card={card} priorities={priorities} categories={categories} onClick={onClick} />
    </div>
  );
}
