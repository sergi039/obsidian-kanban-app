import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { moveCard } from '../api/client';
import type { BoardDetail, Card } from '../types';
import { Column } from './Column';
import { KanbanCard } from './Card';

interface Props {
  board: BoardDetail;
  filterCards: (cards: Card[]) => Card[];
  onCardMove: () => void;
  onCardClick: (card: Card) => void;
}

export function Board({ board, filterCards, onCardMove, onCardClick }: Props) {
  const [activeCard, setActiveCard] = useState<Card | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const card = findCard(String(event.active.id));
    if (card) setActiveCard(card);
  };

  const handleDragOver = (_event: DragOverEvent) => {
    // Visual feedback handled by dnd-kit
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveCard(null);
    const { active, over } = event;
    if (!over) return;

    const cardId = String(active.id);
    const targetColumnName = String(over.id);

    // Determine target column - over.id could be a card id or a column id
    const targetColumn = board.columns.find((col) => col.name === targetColumnName);
    const colName = targetColumn
      ? targetColumnName
      : board.columns.find((col) => col.cards.some((c) => c.id === targetColumnName))?.name;

    if (!colName) return;

    const card = findCard(cardId);
    if (!card || card.column_name === colName) return;

    try {
      await moveCard(cardId, { column: colName, position: 0 });
      onCardMove();
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
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 h-full min-h-[calc(100vh-120px)]">
        {board.columns.map((col) => (
          <Column
            key={col.name}
            name={col.name}
            cards={filterCards(col.cards)}
            onCardClick={onCardClick}
          />
        ))}
      </div>
      <DragOverlay>
        {activeCard ? (
          <div className="rotate-2 opacity-90">
            <KanbanCard card={activeCard} onClick={() => {}} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
