import type { Card } from '../types';
import { useCalendarSettings } from '../lib/calendar-context';
import {
  cardDeepLink,
  eventLabel,
  eventOpenUrl,
  isPastEvent,
  newEventUrl,
  openInWindow,
  resolveAccount,
  sortEvents,
} from '../lib/calendar-utils';
import { Icon } from './Icon';

interface Props {
  card: Card;
  /** Card title without priority emojis/links, used for new events. */
  title: string;
  /** Current due date (YYYY-MM-DD) — new events default to that day. */
  dueDate: string | null;
}

/**
 * Events the server's calendar sync linked to this card (read-only), plus a "New event"
 * link into the board's calendar whose body carries the card link — once saved there,
 * the event shows up here on the next sync.
 */
export function CalendarEventsSection({ card, title, dueDate }: Props) {
  const { accounts, defaultAccountId, publicUrl } = useCalendarSettings();
  const events = sortEvents(card.calendar_events ?? []);
  const boardAccount = accounts.find((account) => account.id === defaultAccountId) ?? null;
  if (events.length === 0 && !boardAccount) return null;
  const createHref = boardAccount
    ? newEventUrl(boardAccount, {
      title,
      details: `Kanban: ${cardDeepLink(publicUrl ?? window.location.origin, card.board_id, card.id)}`,
      date: dueDate,
    })
    : null;

  return (
    <div>
      <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <Icon name="calendar-event" size={13} /> Calendar {events.length > 0 && `(${events.length})`}
      </h3>

      {events.length > 0 ? (
        <div className="space-y-0.5 mb-2">
          {events.map((event) => {
            const account = resolveAccount(event, accounts);
            const label = eventLabel(event);
            const href = eventOpenUrl(event, account);
            return (
              <a
                key={event.id}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => openInWindow(e, href)}
                className={`flex items-center gap-2 py-1 px-2 rounded text-sm hover:bg-board-column hover:underline transition-colors ${
                  isPastEvent(event) ? 'opacity-60' : ''
                }`}
                style={{ color: 'var(--board-accent)' }}
              >
                <Icon name="calendar-event" size={13} />
                <span className="flex-shrink-0">{label}</span>
                {event.title && label !== event.title && <span className="truncate text-board-text">{event.title}</span>}
                {account && (
                  <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-board-column text-board-text-muted flex-shrink-0">
                    {account.label}
                  </span>
                )}
                <Icon name="external-link" size={11} className={`text-board-text-muted ${account ? '' : 'ml-auto'}`} />
              </a>
            );
          })}
        </div>
      ) : (
        <div className="text-xs text-board-text-muted mb-2">No calendar events linked to this card.</div>
      )}

      {boardAccount && createHref && (
        <a
          href={createHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => openInWindow(e, createHref)}
          className="text-[11px] hover:underline inline-flex items-center gap-1"
          style={{ color: 'var(--board-accent)' }}
          title={`Creates an event in ${boardAccount.label}; it links back to this card automatically`}
        >
          <Icon name="plus" size={11} /> New event in {boardAccount.label}
          <Icon name="external-link" size={11} />
        </a>
      )}
    </div>
  );
}
