import { useState, useRef, useEffect, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
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

/** Find which column a card belongs to */
function findColumnForCard(
  columns: BoardDetail['columns'],
  cardId: string,
): { colIndex: number; cardIndex: number } | null {
  for (let ci = 0; ci < columns.length; ci++) {
    const cardIdx = columns[ci].cards.findIndex((c) => c.id === cardId);
    if (cardIdx !== -1) return { colIndex: ci, cardIndex: cardIdx };
  }
  return null;
}

/** Parse a droppable ID to get column name */
function getColumnName(id: string): string | null {
  if (typeof id === 'string' && id.startsWith('column:')) {
    return id.slice(7);
  }
  return null;
}

export function Board({
  board,
  filterCards,
  onCardMove,
  onCardClick,
  onCardAdd,
  onColumnAdd,
  onColumnRename,
  onColumnDelete,
}: Props) {
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  // Optimistic local state — null means use board from props
  const [localColumns, setLocalColumns] = useState<BoardDetail['columns'] | null>(null);
  // Track the original column when drag starts (before optimistic moves)
  const dragOriginRef = useRef<{ columnName: string; position: number } | null>(null);

  const columns = localColumns || board.columns;

  // Reset local state when board prop changes (e.g. after server reload)
  const prevBoardRef = useRef(board);
  useEffect(() => {
    if (board !== prevBoardRef.current) {
      prevBoardRef.current = board;
      setLocalColumns(null);
    }
  }, [board]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const findCard = useCallback(
    (id: string): Card | undefined => {
      for (const col of columns) {
        const card = col.cards.find((c) => c.id === id);
        if (card) return card;
      }
      return undefined;
    },
    [columns],
  );

  const handleDragStart = (event: DragStartEvent) => {
    const card = findCard(String(event.active.id));
    if (card) {
      setActiveCard(card);
      // Remember where the card started
      const currentCols = localColumns || board.columns;
      const pos = findColumnForCard(currentCols, card.id);
      if (pos) {
        dragOriginRef.current = {
          columnName: currentCols[pos.colIndex].name,
          position: pos.cardIndex,
        };
      }
    }
  };

  // DragOver: move card between columns optimistically during drag
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    const currentCols = localColumns || board.columns;
    const activePos = findColumnForCard(currentCols, activeId);
    if (!activePos) return;

    // Target could be a column droppable or another card
    const targetColName = getColumnName(overId);
    let targetColIndex: number;
    let targetCardIndex: number;

    if (targetColName) {
      // Dropped on column container (empty area or bottom)
      targetColIndex = currentCols.findIndex((c) => c.name === targetColName);
      if (targetColIndex === -1) return;
      targetCardIndex = currentCols[targetColIndex].cards.length;
    } else {
      // Over another card
      const overPos = findColumnForCard(currentCols, overId);
      if (!overPos) return;
      targetColIndex = overPos.colIndex;
      targetCardIndex = overPos.cardIndex;
    }

    // If same column, don't do cross-column move here (handled in dragEnd)
    if (activePos.colIndex === targetColIndex) return;

    // Optimistic cross-column move
    const newCols = currentCols.map((col) => ({
      ...col,
      cards: [...col.cards],
    }));

    const [movedCard] = newCols[activePos.colIndex].cards.splice(activePos.cardIndex, 1);
    const updatedCard = { ...movedCard, column_name: newCols[targetColIndex].name };
    newCols[targetColIndex].cards.splice(targetCardIndex, 0, updatedCard);

    setLocalColumns(newCols);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    const origin = dragOriginRef.current;
    setActiveCard(null);
    dragOriginRef.current = null;

    if (!over || !origin) {
      setLocalColumns(null);
      return;
    }

    const activeId = String(active.id);
    const overId = String(over.id);

    const currentCols = localColumns || board.columns;
    const activePos = findColumnForCard(currentCols, activeId);
    if (!activePos) {
      setLocalColumns(null);
      return;
    }

    const currentColName = currentCols[activePos.colIndex].name;

    // Determine final target column and position
    const targetColName = getColumnName(overId);
    let finalColName: string;
    let finalPosition: number;

    if (targetColName) {
      // Dropped on column container (empty area or bottom of column)
      finalColName = targetColName;
      const targetCol = currentCols.find((c) => c.name === targetColName);
      if (!targetCol) { setLocalColumns(null); return; }
      // If card is already in this column (from dragOver), position is its current spot
      const cardInTarget = targetCol.cards.findIndex((c) => c.id === activeId);
      finalPosition = cardInTarget !== -1 ? cardInTarget : targetCol.cards.length;
    } else {
      // Dropped on a card
      const overPos = findColumnForCard(currentCols, overId);
      if (!overPos) { setLocalColumns(null); return; }
      finalColName = currentCols[overPos.colIndex].name;
      finalPosition = overPos.cardIndex;
    }

    // Check if this is actually a cross-column move (compare to ORIGINAL position, not current)
    const isCrossColumn = origin.columnName !== finalColName;

    if (!isCrossColumn) {
      // Same column reorder
      const colIndex = currentCols.findIndex((c) => c.name === finalColName);
      const col = currentCols[colIndex];
      if (!col) { setLocalColumns(null); return; }

      const oldIndex = col.cards.findIndex((c) => c.id === activeId);
      let newIndex: number;

      if (targetColName) {
        // Dropped on column container — move to end
        newIndex = col.cards.length - 1;
      } else {
        newIndex = col.cards.findIndex((c) => c.id === overId);
      }

      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
        setLocalColumns(null);
        return;
      }

      // Optimistic reorder
      const newCols = currentCols.map((c, i) => {
        if (i !== colIndex) return c;
        return { ...c, cards: arrayMove(c.cards, oldIndex, newIndex) };
      });
      setLocalColumns(newCols);

      try {
        await moveCard(activeId, { column: finalColName, position: newIndex });
        await onCardMove();
      } catch (err) {
        console.error('Move failed:', err);
        setLocalColumns(null);
      }
      return;
    }

    // Cross-column move (already moved optimistically in dragOver)
    try {
      await moveCard(activeId, { column: finalColName, position: finalPosition });
      await onCardMove();
    } catch (err) {
      console.error('Cross-column move failed:', err);
      setLocalColumns(null);
    }
  };

  const handleDragCancel = () => {
    setActiveCard(null);
    dragOriginRef.current = null;
    setLocalColumns(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex gap-4 h-full min-h-[calc(100vh-120px)]">
        {columns.map((col) => (
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
