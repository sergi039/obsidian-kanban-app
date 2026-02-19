import type { Card, PriorityDef } from '../types';

interface Props {
  card: Card;
  priorities: PriorityDef[];
  onClick: () => void;
}

const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)\]]+/g;

function extractUrls(title: string): string[] {
  const urls: string[] = [];
  const mdRe = new RegExp(MD_LINK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(title)) !== null) {
    urls.push(m[2]);
  }
  const bareRe = new RegExp(BARE_URL_RE.source, 'g');
  while ((m = bareRe.exec(title)) !== null) {
    if (!urls.includes(m[0])) urls.push(m[0]);
  }
  return urls;
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
  cleaned = cleaned.replace(/\s+/g, ' ').replace(/^[-–]\s*/, '');
  return cleaned || title;
}

export function KanbanCard({ card, priorities, onClick }: Props) {
  const urls = extractUrls(card.title);
  const displayTitle = cleanTitle(card.title, priorities);
  const priorityDef = card.priority ? priorities.find((p) => p.id === card.priority) : undefined;

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
      {priorityDef && (
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

      {/* Meta row */}
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        {card.priority && (
          <span
            className="text-[11px] font-medium px-1.5 py-0.5 rounded"
            style={{ backgroundColor: `${priorityDef?.color ?? '#9ca3af'}26`, color: priorityDef?.color ?? '#9ca3af' }}
          >
            {priorityDef ? `${priorityDef.emoji} ${priorityDef.label}` : card.priority}
          </span>
        )}
        {urls.length > 0 && (
          <span className="text-[11px] text-board-text-muted flex items-center gap-0.5">
            🔗 {urls.length}
          </span>
        )}
        {card.sub_items.length > 0 && (
          <span className="text-[11px] text-board-text-muted flex items-center gap-0.5">
            ☰ {card.sub_items.length}
          </span>
        )}
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
