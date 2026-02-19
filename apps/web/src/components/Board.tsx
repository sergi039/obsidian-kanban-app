import { useState, useRef, useEffect, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type CollisionDetection,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { moveCard, reorderColumns } from '../api/client';
import type { BoardDetail, Card, PriorityDef } from '../types';
import { Column } from './Column';
import { KanbanCard } from './Card';
import { AddColumnButton } from './ColumnManager';
import { BoardSettingsModal } from './BoardSettings';

interface Props {
  board: BoardDetail;
  filterCards: (cards: Card[]) => Card[];
  onCardMove: () => Promise<void>;
  onCardClick: (card: Card) => void;
  onCardAdd: (title: string, column: string) => Promise<void>;
  onColumnAdd: (name: string) => Promise<void>;
  onColumnRename: (oldName: string, newName: string) => Promise<void>;
  onColumnDelete: (name: string) => Promise<void>;
  onPrioritiesChange: (priorities: PriorityDef[]) => Promise<void>;
}

// ---- Collision detection: same as working test ----
const kanbanCollision: CollisionDetection = (args) => {
  const pw = pointerWithin(args);
  if (pw.length > 0) {
    const cards = pw.filter((c) => {
      const container = args.droppableContainers.find((dc) => dc.id === c.id);
      return container?.data?.current?.type === 'card';
    });
    if (cards.length > 0) {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) =>
          cards.some((cc) => cc.id === c.id),
        ),
      });
    }
    return pw;
  }
  return rectIntersection(args);
};

// Column sortable ID prefix
const COL_PREFIX = 'col:';
const DROP_PREFIX = 'drop:';
const toColId = (name: string) => `${COL_PREFIX}${name}`;
const fromColId = (id: string) => id.startsWith(COL_PREFIX) ? id.slice(COL_PREFIX.length) : null;
const fromDropId = (id: string) => id.startsWith(DROP_PREFIX) ? id.slice(DROP_PREFIX.length) : null;

export function Board({
  board,
  filterCards,
  onCardMove,
  onCardClick,
  onCardAdd,
  onColumnAdd,
  onColumnRename,
  onColumnDelete,
  onPrioritiesChange,
}: Props) {
  const [activeCard, setActiveCard] = useState<Card | null>(null);
  const [activeColName, setActiveColName] = useState<string | null>(null);
  const [localColumns, setLocalColumns] = useState<BoardDetail['columns'] | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const dragOriginRef = useRef<{ columnName: string } | null>(null);
  const priorities = Array.isArray(board.priorities) ? board.priorities : [];

  const columns = localColumns || board.columns;
  const columnSortableIds = columns.map((c) => toColId(c.name));

  const prevBoardRef = useRef(board);
  useEffect(() => {
    if (board !== prevBoardRef.current) {
      prevBoardRef.current = board;
      setLocalColumns(null);
    }
  }, [board]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // ---- Find which column contains a card or is the ID itself ----
  const findContainer = useCallback(
    (id: UniqueIdentifier): string | null => {
      const sid = String(id);
      // Is it a column sortable id?
      const colName = fromColId(sid);
      if (colName) return colName;
      // Is it a column drop zone?
      const dropName = fromDropId(sid);
      if (dropName) return dropName;
      // Is it a column name directly?
      if (columns.find((c) => c.name === sid)) return sid;
      // Find card's column
      for (const col of columns) {
        if (col.cards.find((c) => c.id === sid)) return col.name;
      }
      return null;
    },
    [columns],
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

  // ---- Drag Start ----
  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    const data = event.active.data.current;

    if (data?.type === 'column') {
      setActiveColName(data.columnName);
      return;
    }

    const card = findCard(id);
    if (card) {
      setActiveCard(card);
      const container = findContainer(id);
      if (container) dragOriginRef.current = { columnName: container };
    }
  };

  // ---- Drag Over: cross-column card moves (same pattern as test) ----
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    // Skip if dragging a column
    if (active.data.current?.type === 'column') return;

    const activeContainer = findContainer(active.id);
    const overContainer = findContainer(over.id);

    if (!activeContainer || !overContainer || activeContainer === overContainer) return;

    // Cross-column move
    setLocalColumns((prev) => {
      const current = prev || board.columns;
      const srcCol = current.find((c) => c.name === activeContainer);
      const dstCol = current.find((c) => c.name === overContainer);
      if (!srcCol || !dstCol) return current;

      const srcCards = [...srcCol.cards];
      const dstCards = [...dstCol.cards];
      const activeIndex = srcCards.findIndex((c) => c.id === String(active.id));
      if (activeIndex === -1) return current;

      // Determine insert position
      const overId = String(over.id);
      const overCardIndex = dstCards.findIndex((c) => c.id === overId);
      const insertIndex = overCardIndex >= 0 ? overCardIndex : dstCards.length;

      const [movedCard] = srcCards.splice(activeIndex, 1);
      const updatedCard = { ...movedCard, column_name: overContainer };
      dstCards.splice(insertIndex, 0, updatedCard);

      return current.map((col) => {
        if (col.name === activeContainer) return { ...col, cards: srcCards };
        if (col.name === overContainer) return { ...col, cards: dstCards };
        return col;
      });
    });
  };

  // ---- Drag End ----
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    const activeData = active.data.current;

    // ---- Column reorder ----
    if (activeData?.type === 'column') {
      setActiveColName(null);
      if (!over) return;
      const overData = over.data.current;
      if (overData?.type !== 'column') return;
      if (active.id === over.id) return;

      const currentCols = localColumns || board.columns;
      const oldIndex = currentCols.findIndex((c) => toColId(c.name) === String(active.id));
      const newIndex = currentCols.findIndex((c) => toColId(c.name) === String(over.id));
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

      const reordered = arrayMove(currentCols, oldIndex, newIndex);
      setLocalColumns(reordered);

      try {
        await reorderColumns(board.id, reordered.map((c) => c.name));
        await onCardMove();
      } catch {
        setLocalColumns(null);
      }
      return;
    }

    // ---- Card move ----
    const origin = dragOriginRef.current;
    setActiveCard(null);
    dragOriginRef.current = null;

    if (!over || !origin) { setLocalColumns(null); return; }

    const currentCols = localColumns || board.columns;

    // Find where the card IS NOW (after optimistic dragOver moves)
    const currentContainer = findContainer(active.id);
    if (!currentContainer) { setLocalColumns(null); return; }

    // Compare with ORIGINAL column to detect cross-column move
    const isCrossColumn = origin.columnName !== currentContainer;

    if (!isCrossColumn) {
      // Same column reorder
      const col = currentCols.find((c) => c.name === currentContainer);
      if (!col) { setLocalColumns(null); return; }

      const oldIndex = col.cards.findIndex((c) => c.id === String(active.id));
      const overId = String(over.id);
      const newIndex = fromDropId(overId) !== null || fromColId(overId) !== null
        ? col.cards.length - 1
        : col.cards.findIndex((c) => c.id === overId);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const reordered = currentCols.map((c) =>
          c.name !== currentContainer ? c : { ...c, cards: arrayMove(c.cards, oldIndex, newIndex) },
        );
        setLocalColumns(reordered);

        try {
          await moveCard(String(active.id), { column: currentContainer, position: newIndex });
          await onCardMove();
        } catch {
          setLocalColumns(null);
        }
      } else {
        setLocalColumns(null);
      }
      return;
    }

    // Cross-column move (card already moved optimistically in dragOver)
    const dstCol = currentCols.find((c) => c.name === currentContainer);
    const finalPosition = dstCol?.cards.findIndex((c) => c.id === String(active.id)) ?? 0;

    try {
      await moveCard(String(active.id), { column: currentContainer, position: Math.max(0, finalPosition) });
      await onCardMove();
    } catch {
      setLocalColumns(null);
    }
  };

  const handleDragCancel = () => {
    setActiveCard(null);
    setActiveColName(null);
    dragOriginRef.current = null;
    setLocalColumns(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={kanbanCollision}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex gap-4 h-full min-h-[calc(100vh-120px)]">
        <SortableContext items={columnSortableIds} strategy={horizontalListSortingStrategy}>
          {columns.map((col, i) => (
            <Column
              key={col.name}
              name={col.name}
              index={i}
              sortableId={toColId(col.name)}
              cards={filterCards(col.cards)}
              priorities={priorities}
              boardId={board.id}
              onCardClick={onCardClick}
              onCardAdd={onCardAdd}
              onColumnRename={onColumnRename}
              onColumnDelete={onColumnDelete}
            />
          ))}
        </SortableContext>
        <div className="shrink-0 flex flex-col gap-2">
          <AddColumnButton onAdd={onColumnAdd} />
          <button
            onClick={() => setShowSettings(true)}
            className="px-4 py-2 text-sm text-board-text-muted hover:text-board-text hover:bg-board-column rounded-lg transition-colors border border-board-border"
            type="button"
          >
            ⚙ Board settings
          </button>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <div className="rotate-2 opacity-80 w-80">
            <KanbanCard card={activeCard} priorities={priorities} onClick={() => {}} />
          </div>
        ) : null}
        {activeColName ? (
          <div className="opacity-70 w-80 min-w-[320px] bg-board-column rounded-lg border-2 border-dashed border-blue-400 p-6 text-center text-board-text font-medium shadow-lg">
            📋 {activeColName}
          </div>
        ) : null}
      </DragOverlay>
      <BoardSettingsModal
        open={showSettings}
        boardName={board.name}
        columns={board.columns.map((c) => c.name)}
        priorities={priorities}
        onClose={() => setShowSettings(false)}
        onSave={async (priorities) => {
          await onPrioritiesChange(priorities);
          setShowSettings(false);
        }}
      />
    </DndContext>
  );
}
