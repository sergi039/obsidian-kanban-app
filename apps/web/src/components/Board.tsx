import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { moveCard } from '../api/client';
import type { BoardDetail, Card } from '../types';
import { Column } from './Column';
import { KanbanCard } from './Card';
import { AddColumnButton } from './ColumnManager';

interface Props {
  board: BoardDetail;
  filterCards: (cards: Card[]) => Card[];
  onCardMove: () => Promise<void>;
  onCardClick: (card: Card) => void;
  onCardAdd: (title: string, column: string) => Promise<void>;
  onColumnAdd: (name: string) => Promise<void>;
  onColumnRename: (oldName: string, newName: string) => Promise<void>;
  onColumnDelete: (name: string) => Promise<void>;
}

export function Board({ board, filterCards, onCardMove, onCardClick, onCardAdd, onColumnAdd, onColumnRename, onColumnDelete }: Props) {
  const [activeCard, setActiveCard] = useState<Card | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const card = findCard(String(event.active.id));
    if (card) setActiveCard(card);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveCard(null);
    const { active, over } = event;
    if (!over) return;

    const cardId = String(active.id);
    const card = findCard(cardId);
    if (!card) return;

    const targetColName = String(over.id);
    if (card.column_name === targetColName) return;

    try {
      await moveCard(cardId, { column: targetColName, position: 0 });
      await onCardMove();
    } catch (err) {
      console.error('Move failed:', err);
    }
  };

  const findCard = (id: string): Card | undefined => {
    for (const col of board.columns) {
      const card = col.cards.find((c) => c.id === id);
      if (card) return card;
    }
    return undefined;
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 h-full min-h-[calc(100vh-120px)]">
        {board.columns.map((col) => (
          <Column
            key={col.name}
            name={col.name}
            cards={filterCards(col.cards)}
            boardId={board.id}
            onCardClick={onCardClick}
            onCardAdd={onCardAdd}
            onColumnRename={onColumnRename}
            onColumnDelete={onColumnDelete}
          />
        ))}
        <AddColumnButton onAdd={onColumnAdd} />
      </div>
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <div className="rotate-2 opacity-80 w-80">
            <KanbanCard card={activeCard} onClick={() => {}} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
