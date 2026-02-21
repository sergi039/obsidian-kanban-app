import type { Card, PriorityDef, CategoryDef } from '../types';
import { extractLinks } from '../lib/link-utils';

interface Props {
  card: Card;
  priorities: PriorityDef[];
  categories?: CategoryDef[];
  onClick: () => void;
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

export function KanbanCard({ card, priorities, categories = [], onClick }: Props) {
  const linkCount = card.links.length > 0 ? card.links.length : extractLinks(card.title).length;
  const displayTitle = cleanTitle(card.title, priorities);
  const priorityDef = card.priority ? priorities.find((p) => p.id === card.priority) : undefined;
  const showPriority = priorityDef && priorityDef.showOnCard !== false;

  // Resolve visible category badges
  const visibleCategories = card.labels
    .map((id) => categories.find((c) => c.id === id))
    .filter((c): c is CategoryDef => c != null && c.showOnCard);
  const shownCategories = visibleCategories.slice(0, MAX_VISIBLE_BADGES);
  const extraCount = visibleCategories.length - MAX_VISIBLE_BADGES;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-label={`${card.is_done ? 'Done: ' : ''}${displayTitle}${priorityDef ? `, ${priorityDef.label} priority` : ''}`}
      className={`group relative bg-board-card hover:bg-board-card-hover border border-board-border hover:border-board-border-hover rounded-lg px-3 py-2.5 cursor-pointer transition-all focus:outline-none ${
        card.is_done ? 'opacity-50' : ''
      }`}
      style={{ ['--tw-ring-color' as string]: 'var(--board-accent-ring)' }}
    >
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
      </div>
    </div>
  );
}
