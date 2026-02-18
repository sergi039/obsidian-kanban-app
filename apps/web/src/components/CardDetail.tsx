import type { Card } from '../types';

interface Props {
  card: Card;
  onClose: () => void;
}

const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)\]]+/g;

function extractLinks(title: string): { text: string; url: string }[] {
  const links: { text: string; url: string }[] = [];
  const seen = new Set<string>();

  const mdRe = new RegExp(MD_LINK_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(title)) !== null) {
    if (!seen.has(m[2])) {
      links.push({ text: m[1] || m[2], url: m[2] });
      seen.add(m[2]);
    }
  }

  const bareRe = new RegExp(BARE_URL_RE.source, 'g');
  while ((m = bareRe.exec(title)) !== null) {
    if (!seen.has(m[0])) {
      links.push({ text: new URL(m[0]).hostname, url: m[0] });
      seen.add(m[0]);
    }
  }
  return links;
}

export function CardDetail({ card, onClose }: Props) {
  const links = extractLinks(card.title);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 w-[480px] max-w-full bg-board-bg border-l border-board-border z-50 overflow-y-auto">
        <div className="p-6">
          {/* Header */}
          <div className="flex items-start justify-between mb-6">
            <div className="flex-1 pr-4">
              <h2 className="text-lg font-semibold text-board-text leading-snug">
                {card.title.replace(/\[([^\]]*)\]\([^)]+\)/g, '$1').replace(/https?:\/\/[^\s)\]]+/g, '').replace(/[⏫🔺]/g, '').trim()}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="text-board-text-muted hover:text-board-text text-xl leading-none px-2 py-1 rounded hover:bg-board-column"
            >
              ✕
            </button>
          </div>

          {/* Status badges */}
          <div className="flex items-center gap-2 mb-6 flex-wrap">
            <span className="text-xs px-2 py-1 rounded bg-board-column text-board-text-muted">
              {card.column_name}
            </span>
            {card.is_done && (
              <span className="text-xs px-2 py-1 rounded bg-green-900/30 text-green-400">
                ✓ Done
              </span>
            )}
            {card.priority && (
              <span
                className={`text-xs px-2 py-1 rounded ${
                  card.priority === 'urgent'
                    ? 'bg-priority-urgent/15 text-priority-urgent'
                    : 'bg-priority-high/15 text-priority-high'
                }`}
              >
                {card.priority === 'urgent' ? '🔺 Urgent' : '⏫ High'}
              </span>
            )}
            {card.due_date && (
              <span className="text-xs px-2 py-1 rounded bg-board-column text-board-text-muted">
                📅 {card.due_date}
              </span>
            )}
          </div>

          {/* Links */}
          {links.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-2">
                Links
              </h3>
              <div className="space-y-1.5">
                {links.map((link, i) => (
                  <a
                    key={i}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm text-board-accent hover:underline truncate"
                  >
                    🔗 {link.text}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Sub-items */}
          {card.sub_items.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-2">
                Sub-items
              </h3>
              <ul className="space-y-1">
                {card.sub_items.map((item, i) => (
                  <li key={i} className="text-sm text-board-text pl-2 border-l-2 border-board-border">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Raw markdown */}
          <div className="mb-6">
            <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-2">
              Source
            </h3>
            <pre className="text-xs bg-board-column rounded-md p-3 overflow-x-auto text-board-text-muted whitespace-pre-wrap break-all">
              {card.raw_line}
            </pre>
          </div>

          {/* Metadata */}
          <div className="text-xs text-board-text-muted/60 space-y-1">
            <div>ID: {card.id}</div>
            <div>Line: {card.line_number}</div>
            <div>Board: {card.board_id}</div>
            <div>Updated: {card.updated_at}</div>
          </div>
        </div>
      </div>
    </>
  );
}
