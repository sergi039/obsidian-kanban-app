import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useSortable, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Card, PriorityDef, CategoryDef, Reminder } from '../types';
import { DraggableCard } from './DraggableCard';
import { AddCard } from './AddCard';
import { ColumnMenu } from './ColumnManager';
import { DONE_PAGE_SIZES, parseDonePageSize, type DonePageSize } from '../lib/done-page-size';
import { Icon } from './Icon';

interface Props {
  name: string;
  index: number;
  cards: Card[];
  priorities: PriorityDef[];
  categories?: CategoryDef[];
  remindersByCard?: Map<string, Reminder[]>;
  boardId: string;
  sortableId: string;
  isSorted?: boolean;
  /** Shown as a narrow strip (name + count) that still accepts dropped cards. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Cards shown before "Show more" (`auto` = all); the page-size picker appears only with a handler. */
  pageSize?: DonePageSize;
  onPageSizeChange?: (size: DonePageSize) => void;
  selectedCardIds?: Set<string>;
  onToggleSelect?: (cardId: string) => void;
  onToggleDone?: (card: Card) => Promise<void>;
  onCardClick: (card: Card) => void;
  onCardAdd: (title: string, column: string) => Promise<void>;
  onColumnRename: (oldName: string, newName: string) => Promise<void>;
  onColumnDelete: (name: string) => Promise<void>;
}

// Semantic colors for well-known column names
const KNOWN_COLORS: Record<string, string> = {
  'backlog': '#9ca3af',
  'todo': '#9ca3af',
  'in progress': '#3b82f6',
  'doing': '#3b82f6',
  'blocked': '#ef4444',
  'on hold': '#f59e0b',
  'review': '#a855f7',
  'testing': '#eab308',
  'done': '#22c55e',
  'complete': '#22c55e',
  'live test': '#06b6d4',
};

// Fallback palette for custom column names (cycles through)
const COLOR_PALETTE = [
  '#6366f1', '#ec4899', '#14b8a6', '#f97316', '#8b5cf6',
  '#06b6d4', '#84cc16', '#e11d48', '#0ea5e9', '#d946ef',
];

function getColumnColor(name: string, index: number): string {
  const known = KNOWN_COLORS[name.toLowerCase()];
  if (known) return known;
  return COLOR_PALETTE[index % COLOR_PALETTE.length];
}

export function Column({
  name,
  index,
  cards,
  priorities,
  categories,
  remindersByCard,
  boardId,
  sortableId,
  isSorted,
  collapsed = false,
  onToggleCollapse,
  pageSize = 'auto',
  onPageSizeChange,
  selectedCardIds,
  onToggleSelect,
  onToggleDone,
  onCardClick,
  onCardAdd,
  onColumnRename,
  onColumnDelete,
}: Props) {
  // "Show more" pages opened in this column; a new page size starts from one page.
  const [pages, setPages] = useState(1);
  const shownLimit = pageSize === 'auto' ? null : pageSize * pages;
  const visibleCards = shownLimit === null ? cards : cards.slice(0, shownLimit);
  const hiddenCount = cards.length - visibleCards.length;
  // With cards out of sight there is no "end of the list" to drop at, so a card
  // dropped on the column itself (not on a card) goes to the top.
  const dropAtTop = collapsed || hiddenCount > 0;

  // Column sortable (for reordering columns via drag)
  const {
    attributes: colAttrs,
    listeners: colListeners,
    setNodeRef: setColRef,
    transform: colTransform,
    transition: colTransition,
    isDragging: isColDragging,
  } = useSortable({
    id: sortableId,
    data: { type: 'column', columnName: name, dropAtTop },
  });

  // Card drop zone
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop:${name}`,
    data: { type: 'column-drop', columnName: name, dropAtTop },
  });

  const cardIds = visibleCards.map((c) => c.id);

  const colStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(colTransform),
    transition: colTransition,
    opacity: isColDragging ? 0.4 : 1,
  };

  const color = getColumnColor(name, index);
  const dropHighlight = isOver ? { backgroundColor: 'var(--board-drop-highlight)' } : undefined;

  if (collapsed) {
    return (
      <div ref={setColRef} style={colStyle} className="group/col flex flex-col w-11 shrink-0">
        {/* The whole strip expands on click, drags the column and accepts dropped cards */}
        <div
          ref={setDropRef}
          {...colAttrs}
          {...(isSorted ? {} : colListeners)}
          aria-label={`Expand column ${name}`}
          aria-expanded={false}
          title={`Expand ${name}`}
          onClick={onToggleCollapse}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleCollapse?.();
            }
          }}
          className={`flex flex-col items-center gap-2 py-2.5 flex-1 rounded-lg border border-board-border bg-board-column hover:bg-board-card-hover select-none transition-colors ${isSorted ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'}`}
          style={dropHighlight}
        >
          <Icon name="chevrons-right" size={14} className="text-board-text-muted" />
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-xs text-board-text-muted bg-board-bg px-1.5 py-0.5 rounded-full">
            {cards.length}
          </span>
          <h3 className="text-sm font-medium text-board-text whitespace-nowrap [writing-mode:vertical-rl]">{name}</h3>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={setColRef}
      style={colStyle}
      className="group/col flex flex-col w-80 min-w-[320px] shrink-0 rounded-lg transition-colors"
    >
      {/* Column header — drag handle for column reorder */}
      <div
        {...colAttrs}
        {...(isSorted ? {} : colListeners)}
        className={`flex items-center justify-center gap-2 px-3 py-2.5 mb-2 group relative select-none rounded-md hover:bg-board-column/50 transition-colors ${isSorted ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
      >
        {onToggleCollapse && (
          <div className="absolute left-3" onPointerDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={onToggleCollapse}
              className="text-board-text-muted hover:text-board-text transition-colors px-1 flex items-center"
              aria-label={`Collapse column ${name}`}
              aria-expanded
              title="Collapse column"
            >
              <Icon name="chevrons-left" size={14} />
            </button>
          </div>
        )}
        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
        <h3 className="text-sm font-medium text-board-text">{name}</h3>
        <span className="text-xs text-board-text-muted bg-board-column px-1.5 py-0.5 rounded-full">
          {cards.length}
        </span>
        <div className="absolute right-3" onPointerDown={(e) => e.stopPropagation()}>
          <ColumnMenu name={name} onRename={onColumnRename} onDelete={onColumnDelete} />
        </div>
      </div>

      {/* Add card — new cards land at the top of the column */}
      <div className="px-1 pb-2 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <AddCard boardId={boardId} columnName={name} onAdd={(title) => onCardAdd(title, name)} />
        </div>
        {onPageSizeChange && (
          <label
            className="shrink-0 flex items-center gap-1 py-2 text-xs text-board-text-muted"
            title="How many cards to show here; Auto shows them all, as tall as the screen"
          >
            Show
            <select
              value={String(pageSize)}
              onChange={(e) => {
                setPages(1);
                onPageSizeChange(parseDonePageSize(e.target.value));
              }}
              className="bg-transparent text-board-text-muted hover:text-board-text cursor-pointer focus:outline-none"
              aria-label={`Cards shown in ${name}`}
            >
              <option value="auto">Auto</option>
              {DONE_PAGE_SIZES.map((size) => (
                <option key={size} value={String(size)}>{size}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Cards list — scrolls inside the column, which is as tall as the board area */}
      <div
        ref={setDropRef}
        className="flex flex-col gap-2 px-1 pb-2 flex-1 min-h-[100px] overflow-y-auto rounded-lg transition-colors"
        style={dropHighlight}
      >
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {visibleCards.map((card) => (
            <DraggableCard
              key={card.id}
              card={card}
              priorities={priorities}
              categories={categories}
              reminders={remindersByCard?.get(card.id)}
              onClick={() => onCardClick(card)}
              selected={selectedCardIds?.has(card.id) ?? false}
              onToggleSelect={onToggleSelect ? () => onToggleSelect(card.id) : undefined}
              onToggleDone={onToggleDone ? () => onToggleDone(card) : undefined}
            />
          ))}
        </SortableContext>
        {typeof pageSize === 'number' && (hiddenCount > 0 || pages > 1) && (
          <div className="flex items-center justify-center gap-3 py-1 text-xs text-board-text-muted">
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setPages((p) => p + 1)}
                className="hover:text-board-text transition-colors"
              >
                Show {Math.min(pageSize, hiddenCount)} more · {hiddenCount} hidden
              </button>
            )}
            {pages > 1 && (
              <button type="button" onClick={() => setPages(1)} className="hover:text-board-text transition-colors">
                Show less
              </button>
            )}
          </div>
        )}
        {cards.length === 0 && !isOver && (
          <div
            className="text-xs text-board-text-muted text-center py-8 border border-dashed rounded-lg"
            style={{ borderColor: 'var(--board-border)', opacity: 0.5 }}
          >
            No items
          </div>
        )}
      </div>
    </div>
  );
}
