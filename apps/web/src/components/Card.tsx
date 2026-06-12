import type { Card, PriorityDef, CategoryDef, Reminder } from '../types';
import { extractLinks } from '../lib/link-utils';
import { formatReminderTime, isDueReminder, nextActiveReminder } from '../lib/reminder-utils';

interface Props {
  card: Card;
  priorities: PriorityDef[];
  categories?: CategoryDef[];
  reminders?: Reminder[];
  onClick: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanTitle(title: string, priorities: PriorityDef[]): string {
  let cleaned = title.replace(/\[([^\]]*)\]\([^)]+\)/g, '$1');
  cleaned = cleaned.replace(/https?:\/\/[^\s)\]]+/g, '').trim();
  for (const p of priorities) {
    cleaned = cleaned.replace(new RegExp(`\\s*${escapeRegExp(p.emoji)}\\s*`, 'g'), ' ');
  }
  cleaned = cleaned.trim();
  cleaned = cleaned.replace(/\s+/g, ' ').replace(/^[-\u2013]\s*/, '');
  return cleaned || title;
}

const MAX_VISIBLE_BADGES = 3;

export function KanbanCard({ card, priorities, categories = [], reminders = [], onClick, selected = false, onToggleSelect }: Props) {
  const linkCount = card.links.length > 0 ? card.links.length : extractLinks(card.title).length;
  const displayTitle = cleanTitle(card.title, priorities);
  const priorityDef = card.priority ? priorities.find((p) => p.id === card.priority) : undefined;
  const showPriority = priorityDef && priorityDef.showOnCard !== false;
  const nextReminder = nextActiveReminder(reminders);
  const reminderIsDue = nextReminder ? isDueReminder(nextReminder) : false;

  // Resolve visible category badges
  const visibleCategories = card.labels
    .map((id) => categories.find((c) => c.id === id))
    .filter((c): c is CategoryDef => c != null && c.showOnCard);
  const shownCategories = visibleCategories.slice(0, MAX_VISIBLE_BADGES);
  const extraCount = visibleCategories.length - MAX_VISIBLE_BADGES;

  const handleClick = (e: React.MouseEvent) => {
    if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
      e.preventDefault();
      onToggleSelect();
      return;
    }
    onClick();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && onToggleSelect) {
        onToggleSelect();
        return;
      }
      onClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={`${card.is_done ? 'Done: ' : ''}${displayTitle}${priorityDef ? `, ${priorityDef.label} priority` : ''}`}
      className={`group relative bg-board-card hover:bg-board-card-hover border rounded-lg px-3 py-2.5 cursor-pointer transition-all focus:outline-none ${
        card.is_done ? 'opacity-50' : ''
      } ${
        selected
          ? 'border-blue-500 ring-1 ring-blue-500/60'
          : 'border-board-border hover:border-board-border-hover'
      }`}
      style={{ ['--tw-ring-color' as string]: selected ? undefined : 'var(--board-accent-ring)' }}
    >
      {/* Selection checkbox (visible on hover or when selected) */}
      {onToggleSelect && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label={`Select card: ${displayTitle}`}
          className={`absolute right-2 top-2 h-4 w-4 cursor-pointer accent-blue-500 transition-opacity ${
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          }`}
        />
      )}
      {/* Priority left border */}
      {showPriority && (
        <div
          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full"
          style={{ backgroundColor: priorityDef.color }}
        />
      )}

      {/* Card ID badge (like GitHub #123) */}
      <span className="text-[10px] font-mono text-board-text-muted opacity-60 select-none">
        #{card.seq_id ?? card.id}
      </span>

      {/* Title */}
      <p
        className={`text-sm leading-snug mt-0.5 ${
          card.is_done ? 'line-through text-board-text-muted' : 'text-board-text'
        }`}
      >
        {displayTitle}
      </p>

      {/* Category badges */}
      {shownCategories.length > 0 && (
        <div className="flex items-center gap-1 mt-1.5 flex-wrap">
          {shownCategories.map((cat) => (
            <span
              key={cat.id}
              className="text-[10px] font-medium px-1.5 py-0.5 rounded max-w-[120px] truncate border"
              style={{ backgroundColor: `${cat.color}20`, color: cat.color, borderColor: `${cat.color}40` }}
              title={cat.label}
            >
              {cat.label}
            </span>
          ))}
          {extraCount > 0 && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-board-column text-board-text-muted">
              +{extraCount}
            </span>
          )}
        </div>
      )}

      {/* Meta row */}
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        {showPriority && (
          <span
            className="text-[11px] font-medium px-1.5 py-0.5 rounded"
            style={{ backgroundColor: `${priorityDef.color}26`, color: priorityDef.color }}
          >
            {priorityDef.emoji} {priorityDef.label}
          </span>
        )}
        {linkCount > 0 && (
          <span className="text-[11px] text-board-text-muted flex items-center gap-0.5">
            🔗 {linkCount}
          </span>
        )}
        {card.sub_items.length > 0 && (
          <span className="text-[11px] text-board-text-muted flex items-center gap-0.5">
            ☰ {card.sub_items.length}
          </span>
        )}
        {card.checklist.length > 0 && (() => {
          const done = card.checklist.filter((i) => i.done).length;
          const total = card.checklist.length;
          const allDone = done === total;
          return (
            <span className={`text-[11px] flex items-center gap-0.5 ${allDone ? 'text-green-500' : 'text-board-text-muted'}`}>
              ☑ {done}/{total}
            </span>
          );
        })()}
        {card.description && (
          <span className="text-[11px] text-board-text-muted flex items-center gap-0.5" title="Has description">
            📝
          </span>
        )}
        {card.due_date && (
          <span className="text-[11px] text-board-text-muted">📅 {card.due_date}</span>
        )}
        {nextReminder && (
          <span
            className={`text-[11px] px-1.5 py-0.5 rounded ${
              reminderIsDue
                ? 'bg-amber-500/15 text-amber-500'
                : 'bg-board-column text-board-text-muted'
            }`}
            title={nextReminder.message || 'Reminder'}
          >
            ⏰ {formatReminderTime(nextReminder)}
          </span>
        )}
      </div>
    </div>
  );
}
