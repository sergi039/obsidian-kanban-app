import { useEffect, useRef } from 'react';
import type { Card } from '../types';

interface Props {
  card: Card;
  onClose: () => void;
}

const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)\]]+/g;

function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.hostname;
  } catch {
    return null;
  }
}

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
      const hostname = safeUrl(m[0]);
      links.push({ text: hostname || m[0], url: m[0] });
      seen.add(m[0]);
    }
  }
  return links;
}

export function CardDetail({ card, onClose }: Props) {
  const links = extractLinks(card.title);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus trap + Escape to close
  useEffect(() => {
    closeRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
      // Simple focus trap: Tab within drawer
      if (e.key === 'Tab' && drawerRef.current) {
        const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
          'button, a, input, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} aria-hidden="true" />

      {/* Drawer */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Card details: ${card.title}`}
        className="fixed right-0 top-0 bottom-0 w-[480px] max-w-full bg-board-bg border-l border-board-border z-50 overflow-y-auto"
      >
        <div className="p-6">
          {/* Header */}
          <div className="flex items-start justify-between mb-6">
            <div className="flex-1 pr-4">
              <h2 className="text-lg font-semibold text-board-text leading-snug">
                {card.title.replace(/\[([^\]]*)\]\([^)]+\)/g, '$1').replace(/https?:\/\/[^\s)\]]+/g, '').replace(/[⏫🔺]/g, '').trim()}
              </h2>
            </div>
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close card details"
              className="text-board-text-muted hover:text-board-text text-xl leading-none px-2 py-1 rounded hover:bg-board-column focus:outline-none focus:ring-2 focus:ring-board-accent/50"
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
