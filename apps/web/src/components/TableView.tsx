import { useState, useMemo } from 'react';
import type { Card, PriorityDef } from '../types';
import { moveCard, patchCard } from '../api/client';

interface Props {
  cards: Card[];
  columns: string[];
  priorities: PriorityDef[];
  boardId: string;
  onCardClick: (card: Card) => void;
  onCardAdd: (title: string, column: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

type SortField = 'title' | 'column_name' | 'priority' | 'due_date' | 'is_done' | 'updated_at';
type SortDir = 'ASC' | 'DESC';

const ARCHIVE_PAGE_SIZE = 20;

function comparePriority(a: string | null, b: string | null, rank: Map<string, number>): number {
  const fallback = rank.size + 1;
  const av = a ? (rank.get(a) ?? fallback) : fallback + 1;
  const bv = b ? (rank.get(b) ?? fallback) : fallback + 1;
  return av - bv;
}

function daysSince(dateStr: string): number {
  const then = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z')).getTime();
  return Math.floor((Date.now() - then) / 86400000);
}

// Settings stored in localStorage per board
function loadSettings(boardId: string) {
  try {
    const raw = localStorage.getItem(`kanban:table:${boardId}`);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function saveSettings(boardId: string, settings: Record<string, unknown>) {
  localStorage.setItem(`kanban:table:${boardId}`, JSON.stringify(settings));
}

const KNOWN_COLORS: Record<string, string> = {
  'backlog': '#9ca3af', 'todo': '#9ca3af',
  'in progress': '#3b82f6', 'doing': '#3b82f6',
  'blocked': '#ef4444', 'on hold': '#f59e0b',
  'review': '#a855f7', 'testing': '#eab308',
  'done': '#22c55e', 'complete': '#22c55e',
  'live test': '#06b6d4',
};

export function TableView({ cards, columns, priorities, boardId, onCardClick, onCardAdd, onRefresh }: Props) {
  const [sortField, setSortField] = useState<SortField>('title');
  const [sortDir, setSortDir] = useState<SortDir>('ASC');
  const [newTitle, setNewTitle] = useState('');
  const [addingColumn, setAddingColumn] = useState('Backlog');

  // Done-hiding settings
  const stored = loadSettings(boardId);
  const [hideDoneDays, setHideDoneDays] = useState<number>(stored.hideDoneDays ?? 3);
  const [hideEnabled, setHideEnabled] = useState<boolean>(stored.hideEnabled ?? true);
  const [showSettings, setShowSettings] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [archivePage, setArchivePage] = useState(0);
  const priorityRank = useMemo(
    () => new Map(priorities.map((p, index) => [p.id, index])),
    [priorities],
  );

  const updateSetting = (key: string, value: unknown) => {
    const s = loadSettings(boardId);
    s[key] = value;
    saveSettings(boardId, s);
  };

  // Split cards: visible vs hidden (done > X days)
  const { visibleCards, hiddenCards } = useMemo(() => {
    if (!hideEnabled) return { visibleCards: cards, hiddenCards: [] as Card[] };
    const visible: Card[] = [];
    const hidden: Card[] = [];
    for (const card of cards) {
      if (card.is_done && daysSince(card.updated_at) >= hideDoneDays) {
        hidden.push(card);
      } else {
        visible.push(card);
      }
    }
    // Sort hidden by updated_at descending (most recently completed first)
    hidden.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return { visibleCards: visible, hiddenCards: hidden };
  }, [cards, hideEnabled, hideDoneDays]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortField(field);
      setSortDir('ASC');
    }
  };

  const handleStatusChange = async (card: Card, newColumn: string) => {
    if (newColumn === card.column_name) return;
    try {
      await moveCard(card.id, { column: newColumn, position: 0 });
      await onRefresh();
    } catch (err) {
      console.error('Move failed:', err);
    }
  };

  const handleToggleDone = async (card: Card) => {
    try {
      if (!card.is_done) {
        await moveCard(card.id, { column: 'Done', position: 0 });
      } else {
        await moveCard(card.id, { column: 'Backlog', position: 0 });
      }
      await onRefresh();
    } catch (err) {
      console.error('Toggle done failed:', err);
    }
  };

  const handlePriorityChange = async (card: Card, priority: string) => {
    const val = priority === 'none' ? null : priority;
    try {
      await patchCard(card.id, { priority: val });
      await onRefresh();
    } catch (err) {
      console.error('Priority change failed:', err);
    }
  };

  const handleDueDateChange = async (card: Card, date: string) => {
    try {
      await patchCard(card.id, { due_date: date || null });
      await onRefresh();
    } catch (err) {
      console.error('Due date change failed:', err);
    }
  };

  const handleAddCard = async () => {
    const title = newTitle.trim();
    if (!title) return;
    await onCardAdd(title, addingColumn);
    setNewTitle('');
  };

  const sorted = [...visibleCards].sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'title':
        cmp = a.title.localeCompare(b.title);
        break;
      case 'column_name':
        cmp = a.column_name.localeCompare(b.column_name);
        break;
      case 'priority':
        cmp = comparePriority(a.priority, b.priority, priorityRank);
        break;
      case 'due_date':
        cmp = (a.due_date || '9999').localeCompare(b.due_date || '9999');
        break;
      case 'is_done':
        cmp = Number(a.is_done) - Number(b.is_done);
        break;
      case 'updated_at':
        cmp = a.updated_at.localeCompare(b.updated_at);
        break;
    }
    return sortDir === 'DESC' ? -cmp : cmp;
  });

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="text-board-text-muted/30 ml-0.5">↕</span>;
    return <span className="ml-0.5">{sortDir === 'ASC' ? '↑' : '↓'}</span>;
  };

  // Archive pagination
  const archiveTotal = hiddenCards.length;
  const archivePages = Math.ceil(archiveTotal / ARCHIVE_PAGE_SIZE);
  const archiveSlice = hiddenCards.slice(
    archivePage * ARCHIVE_PAGE_SIZE,
    (archivePage + 1) * ARCHIVE_PAGE_SIZE,
  );

  const renderRow = (card: Card, dimmed = false) => (
    <tr
      key={card.id}
      role="row"
      className={`border-b border-board-border/50 hover:bg-board-column transition-colors group ${dimmed ? 'opacity-50' : ''}`}
    >
      {/* Done checkbox */}
      <td className="px-3 py-2.5 text-center">
        <input
          type="checkbox"
          checked={card.is_done}
          onChange={() => handleToggleDone(card)}
          className="w-4 h-4 rounded border-board-border cursor-pointer accent-green-500"
          title={card.is_done ? 'Mark as not done' : 'Mark as done'}
        />
      </td>
      {/* ID */}
      <td className="px-3 py-2.5">
        <span className="text-[10px] font-mono text-board-text-muted opacity-60">
          #{card.seq_id ?? card.id}
        </span>
      </td>
      {/* Title */}
      <td className="px-3 py-2.5 cursor-pointer" onClick={() => onCardClick(card)}>
        <div className="flex items-center gap-2">
          <span className={`text-board-text hover:text-blue-500 transition-colors ${card.is_done ? 'line-through opacity-60' : ''}`}>
            {card.title.length > 80 ? card.title.slice(0, 80) + '…' : card.title}
          </span>
          {card.labels.length > 0 && (
            <span className="flex gap-1">
              {card.labels.slice(0, 3).map((l, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-full bg-board-column text-board-text-muted border border-board-border">
                  {l}
                </span>
              ))}
            </span>
          )}
          {card.description && <span className="text-board-text-muted text-[10px]">📝</span>}
          {card.sub_items.length > 0 && <span className="text-board-text-muted text-[10px]">☰ {card.sub_items.length}</span>}
        </div>
      </td>
      {/* Status */}
      <td className="px-3 py-2.5">
        <select
          value={card.column_name}
          onChange={(e) => handleStatusChange(card, e.target.value)}
          className="text-xs bg-transparent border border-transparent hover:border-board-border rounded px-1.5 py-1 text-board-text cursor-pointer focus:outline-none focus:border-blue-500 transition-colors"
        >
          {columns.map((col) => (
            <option key={col} value={col}>{col}</option>
          ))}
        </select>
        <span className="inline-block w-2 h-2 rounded-full ml-1" style={{ backgroundColor: KNOWN_COLORS[card.column_name.toLowerCase()] || '#9ca3af' }} />
      </td>
      {/* Priority */}
      <td className="px-3 py-2.5">
        <select
          value={card.priority || 'none'}
          onChange={(e) => handlePriorityChange(card, e.target.value)}
          className="text-xs bg-transparent border border-transparent hover:border-board-border rounded px-1.5 py-1 text-board-text cursor-pointer focus:outline-none focus:border-blue-500 transition-colors"
        >
          <option value="none">— None</option>
          {priorities.map((p) => (
            <option key={p.id} value={p.id}>{p.emoji} {p.label}</option>
          ))}
        </select>
      </td>
      {/* Due — inline date picker */}
      <td className="px-3 py-2.5">
        <input
          type="date"
          value={card.due_date || ''}
          onChange={(e) => handleDueDateChange(card, e.target.value)}
          className="text-xs bg-transparent border border-transparent hover:border-board-border rounded px-1 py-0.5 text-board-text cursor-pointer focus:outline-none focus:border-blue-500 transition-colors w-28"
        />
      </td>
      {/* Updated */}
      <td className="px-3 py-2.5 text-xs text-board-text-muted">
        {new Date(card.updated_at).toLocaleDateString()}
      </td>
    </tr>
  );

  return (
    <div className="overflow-x-auto">
      {/* Toolbar: Add card + Done settings */}
      <div className="flex items-center gap-2 mb-4 px-1 flex-wrap">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAddCard(); }}
          placeholder="+ Add new task..."
          className="flex-1 min-w-[200px] px-3 py-2 text-sm bg-board-card border border-board-border rounded-md text-board-text placeholder:text-board-text-muted focus:outline-none focus:border-blue-500"
        />
        <select
          value={addingColumn}
          onChange={(e) => setAddingColumn(e.target.value)}
          className="px-2 py-2 text-sm bg-board-card border border-board-border rounded-md text-board-text"
        >
          {columns.map((col) => (
            <option key={col} value={col}>{col}</option>
          ))}
        </select>
        <button
          onClick={handleAddCard}
          disabled={!newTitle.trim()}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-md disabled:opacity-40 transition-colors"
        >
          Add
        </button>

        <div className="w-px h-6 bg-board-border mx-1" />

        {/* Done visibility settings */}
        <button
          onClick={() => setShowSettings((v) => !v)}
          className={`px-2.5 py-2 text-sm border rounded-md transition-colors ${
            showSettings
              ? 'bg-blue-100 dark:bg-blue-900/30 border-blue-400 text-blue-700 dark:text-blue-300'
              : 'bg-board-card border-board-border text-board-text-muted hover:text-board-text'
          }`}
          title="Done task visibility settings"
        >
          ⚙️
        </button>

        {/* Archive toggle */}
        {hiddenCards.length > 0 && (
          <button
            onClick={() => { setShowArchive((v) => !v); setArchivePage(0); }}
            className={`px-2.5 py-2 text-sm border rounded-md transition-colors flex items-center gap-1.5 ${
              showArchive
                ? 'bg-green-100 dark:bg-green-900/30 border-green-400 text-green-700 dark:text-green-300'
                : 'bg-board-card border-board-border text-board-text-muted hover:text-board-text'
            }`}
            title={`Show ${hiddenCards.length} hidden done tasks`}
          >
            📦 {hiddenCards.length}
          </button>
        )}
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="mb-4 px-3 py-3 bg-board-column rounded-lg border border-board-border flex items-center gap-4 flex-wrap text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={hideEnabled}
              onChange={(e) => {
                setHideEnabled(e.target.checked);
                updateSetting('hideEnabled', e.target.checked);
              }}
              className="accent-blue-500"
            />
            <span className="text-board-text">Auto-hide done tasks</span>
          </label>
          {hideEnabled && (
            <label className="flex items-center gap-2 text-board-text">
              after
              <input
                type="number"
                min={0}
                max={365}
                value={hideDoneDays}
                onChange={(e) => {
                  const v = Math.max(0, parseInt(e.target.value) || 0);
                  setHideDoneDays(v);
                  updateSetting('hideDoneDays', v);
                }}
                className="w-16 px-2 py-1 bg-board-card border border-board-border rounded text-center text-sm text-board-text focus:outline-none focus:border-blue-500"
              />
              days
            </label>
          )}
          <span className="text-xs text-board-text-muted">
            {hideEnabled
              ? hideDoneDays === 0
                ? '(hide immediately)'
                : `(hiding done tasks older than ${hideDoneDays}d)`
              : '(showing all tasks)'}
          </span>
        </div>
      )}

      {/* Main table */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-board-border text-left">
            <th className="px-3 py-2 text-xs font-medium text-board-text-muted uppercase tracking-wider w-12">✓</th>
            <th className="px-3 py-2 text-xs font-medium text-board-text-muted uppercase tracking-wider w-20">ID</th>
            {[
              { field: 'title' as SortField, label: 'Title', width: '' },
              { field: 'column_name' as SortField, label: 'Status', width: 'w-36' },
              { field: 'priority' as SortField, label: 'Priority', width: 'w-32' },
              { field: 'due_date' as SortField, label: 'Due', width: 'w-32' },
              { field: 'updated_at' as SortField, label: 'Updated', width: 'w-32' },
            ].map((col) => (
              <th
                key={col.field}
                role="columnheader"
                aria-sort={sortField === col.field ? (sortDir === 'ASC' ? 'ascending' : 'descending') : 'none'}
                tabIndex={0}
                className={`px-3 py-2 text-xs font-medium text-board-text-muted uppercase tracking-wider cursor-pointer hover:text-board-text transition-colors select-none ${col.width}`}
                onClick={() => handleSort(col.field)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort(col.field); } }}
              >
                <span className="flex items-center">
                  {col.label}
                  <SortIcon field={col.field} />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((card) => renderRow(card))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-board-text-muted text-sm">
                No cards match the current filter
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Archive: hidden done tasks */}
      {showArchive && hiddenCards.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center gap-3 mb-3">
            <h3 className="text-sm font-medium text-board-text-muted">
              📦 Completed ({archiveTotal} tasks)
            </h3>
            {archivePages > 1 && (
              <div className="flex items-center gap-1 text-xs">
                <button
                  disabled={archivePage === 0}
                  onClick={() => setArchivePage((p) => p - 1)}
                  className="px-2 py-0.5 rounded border border-board-border text-board-text-muted hover:text-board-text disabled:opacity-30 transition-colors"
                >
                  ◀
                </button>
                <span className="text-board-text-muted px-2">
                  {archivePage + 1} / {archivePages}
                </span>
                <button
                  disabled={archivePage >= archivePages - 1}
                  onClick={() => setArchivePage((p) => p + 1)}
                  className="px-2 py-0.5 rounded border border-board-border text-board-text-muted hover:text-board-text disabled:opacity-30 transition-colors"
                >
                  ▶
                </button>
              </div>
            )}
          </div>
          <table className="w-full text-sm opacity-70">
            <tbody>
              {archiveSlice.map((card) => renderRow(card, true))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
