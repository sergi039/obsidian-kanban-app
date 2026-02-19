import { useState, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  pointerWithin,
  rectIntersection,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type CollisionDetection,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// ---- Sortable Item ----
function SortableItem({ id }: { id: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, data: { type: 'card' } });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    touchAction: 'none',
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="p-3 mb-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded shadow cursor-grab active:cursor-grabbing text-black dark:text-white select-none text-sm"
    >
      📦 {id}
    </div>
  );
}

// ---- Droppable Column ----
function DroppableColumn({ id, title, items }: { id: string; title: string; items: string[] }) {
  const { setNodeRef, isOver } = useDroppable({ id, data: { type: 'column' } });
  return (
    <div className="w-56 shrink-0">
      <h3 className="text-sm font-bold mb-2 text-board-text">{title} ({items.length})</h3>
      <div
        ref={setNodeRef}
        className="min-h-[120px] p-2 rounded-lg border-2 transition-colors"
        style={{
          borderColor: isOver ? '#3b82f6' : 'transparent',
          backgroundColor: isOver ? 'rgba(59,130,246,0.1)' : 'rgba(128,128,128,0.05)',
        }}
      >
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          {items.map((item) => (
            <SortableItem key={item} id={item} />
          ))}
        </SortableContext>
        {items.length === 0 && !isOver && (
          <div className="text-xs text-gray-400 text-center py-6">empty</div>
        )}
      </div>
    </div>
  );
}

// ---- Custom Collision Detection ----
const multiContainerCollision: CollisionDetection = (args) => {
  // First: check what's under the pointer
  const pw = pointerWithin(args);
  if (pw.length > 0) {
    // Prefer cards over containers (for precise placement)
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

// ---- Main Test Component ----
export function DndTest() {
  const [columns, setColumns] = useState<Record<string, string[]>>({
    todo: ['Task-1', 'Task-2', 'Task-3'],
    doing: ['Task-4', 'Task-5'],
    done: ['Task-6'],
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const addLog = (msg: string) => {
    console.log('[DndTest]', msg);
    setLog((prev) => [...prev.slice(-15), msg]);
  };

  const findContainer = useCallback(
    (id: UniqueIdentifier): string | null => {
      // Is it a column id?
      if (columns[id as string]) return id as string;
      // Find which column has this item
      for (const [col, items] of Object.entries(columns)) {
        if (items.includes(String(id))) return col;
      }
      return null;
    },
    [columns],
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    addLog(`dragStart: ${event.active.id}`);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeContainer = findContainer(active.id);
    const overContainer = findContainer(over.id);

    addLog(`dragOver: active=${active.id} (in ${activeContainer}), over=${over.id} (in ${overContainer})`);

    if (!activeContainer || !overContainer || activeContainer === overContainer) return;

    // Cross-container move
    setColumns((prev) => {
      const activeItems = [...prev[activeContainer]];
      const overItems = [...prev[overContainer]];
      const activeIndex = activeItems.indexOf(String(active.id));
      const overIndex = over.id === overContainer
        ? overItems.length // dropped on container = append
        : overItems.indexOf(String(over.id));

      activeItems.splice(activeIndex, 1);
      overItems.splice(overIndex >= 0 ? overIndex : overItems.length, 0, String(active.id));

      addLog(`CROSS-MOVE: ${active.id} from ${activeContainer}[${activeIndex}] → ${overContainer}[${overIndex}]`);

      return { ...prev, [activeContainer]: activeItems, [overContainer]: overItems };
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) { addLog('dragEnd: no target'); return; }

    const activeContainer = findContainer(active.id);
    const overContainer = findContainer(over.id);

    addLog(`dragEnd: active=${active.id} (${activeContainer}), over=${over.id} (${overContainer})`);

    if (!activeContainer || !overContainer) return;

    // Same container reorder
    if (activeContainer === overContainer) {
      const items = columns[activeContainer];
      const oldIndex = items.indexOf(String(active.id));
      const newIndex = over.id === overContainer ? items.length - 1 : items.indexOf(String(over.id));
      if (oldIndex !== newIndex && oldIndex !== -1 && newIndex !== -1) {
        setColumns((prev) => ({
          ...prev,
          [activeContainer]: arrayMove(prev[activeContainer], oldIndex, newIndex),
        }));
        addLog(`REORDER: ${activeContainer} ${oldIndex} → ${newIndex}`);
      }
    }
  };

  return (
    <div className="p-6">
      <h2 className="text-lg font-bold mb-2 text-board-text">🧪 Multi-Container DnD Test</h2>
      <p className="text-sm text-board-text-muted mb-4">
        Drag items between columns. If this works, we copy the exact pattern to the Board.
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={multiContainerCollision}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => { setActiveId(null); addLog('dragCancel'); }}
      >
        <div className="flex gap-4 mb-4">
          <DroppableColumn id="todo" title="📋 To Do" items={columns.todo} />
          <DroppableColumn id="doing" title="🔨 Doing" items={columns.doing} />
          <DroppableColumn id="done" title="✅ Done" items={columns.done} />
        </div>
        <DragOverlay>
          {activeId ? (
            <div className="p-3 bg-blue-100 dark:bg-blue-900 border-2 border-blue-400 rounded shadow-lg text-sm rotate-2 opacity-80 w-52">
              📦 {activeId}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono text-board-text-muted max-h-48 overflow-auto">
        <div className="font-bold mb-1">Event log:</div>
        {log.length === 0 && <div>No events yet — try dragging between columns</div>}
        {log.map((l, i) => (
          <div key={i} className={l.includes('CROSS-MOVE') || l.includes('REORDER') ? 'text-green-500 font-bold' : ''}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}
