import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { moveCard } from '../api/client';
import type { BoardDetail, Card } from '../types';
import { Column } from './Column';
import { KanbanCard } from './Card';

interface Props {
  board: BoardDetail;
  filterCards: (cards: Card[]) => Card[];
  onCardMove: () => Promise<void>;
  onCardClick: (card: Card) => void;
}

export function Board({ board, filterCards, onCardMove, onCardClick }: Props) {
  const [activeCard, setActiveCard] = useState<Card | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
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
    const overId = String(over.id);
    const card = findCard(cardId);
    if (!card) return;

    // Determine target column — over.id could be a column name or a card id
    let targetColName: string | undefined;
    let targetPosition = 0;

    const targetColumn = board.columns.find((col) => col.name === overId);
    if (targetColumn) {
      // Dropped on column itself (empty area)
      targetColName = overId;
      targetPosition = filterCards(targetColumn.cards).length;
    } else {
      // Dropped on a card — find which column the target card belongs to
      for (const col of board.columns) {
        const idx = col.cards.findIndex((c) => c.id === overId);
        if (idx !== -1) {
          targetColName = col.name;
          // Position = index of the card we dropped onto
          const filteredCards = filterCards(col.cards);
          const filteredIdx = filteredCards.findIndex((c) => c.id === overId);
          targetPosition = filteredIdx !== -1 ? filteredIdx : idx;
          break;
        }
      }
    }

    if (!targetColName) return;

    // Skip if no actual change
    if (card.column_name === targetColName && card.position === targetPosition) return;

    try {
      await moveCard(cardId, { column: targetColName, position: targetPosition });
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
