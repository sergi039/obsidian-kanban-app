import { useState } from 'react';
import type { CalendarEvent } from '../types';
import { useCalendarSettings } from '../lib/calendar-context';
import { eventLabel, eventOpenUrl, isPastEvent, resolveAccount, sortEvents } from '../lib/calendar-utils';

interface Props {
  events: CalendarEvent[];
}

/** Keep clicks, drags and Enter on these controls from opening or dragging the card. */
const isolate = {
  onClick: (e: React.SyntheticEvent) => e.stopPropagation(),
  onPointerDown: (e: React.SyntheticEvent) => e.stopPropagation(),
  onKeyDown: (e: React.SyntheticEvent) => e.stopPropagation(),
};

/**
 * Card-face calendar chip: the nearest event as a direct link, plus a "+N" toggle that
 * expands the full list inline (it wraps onto its own row of the meta flex row).
 */
export function CalendarEventsChip({ events }: Props) {
  const { accounts } = useCalendarSettings();
  const [expanded, setExpanded] = useState(false);
  if (events.length === 0) return null;

  const sorted = sortEvents(events);
  const next = sorted[0];
  const describe = (event: CalendarEvent) => {
    const account = resolveAccount(event, accounts);
    return {
      href: eventOpenUrl(event, account),
      label: eventLabel(event),
      title: event.title || 'Event',
      accountLabel: account?.label ?? 'Calendar',
      past: isPastEvent(event),
    };
  };
  const first = describe(next);

  return (
    <>
      <a
        href={first.href}
        target="_blank"
        rel="noopener noreferrer"
        {...isolate}
        title={`${first.accountLabel} · ${first.title}`}
        aria-label={`Open calendar event: ${first.title}, ${first.label}`}
        className={`text-[11px] px-1.5 py-0.5 rounded max-w-[160px] truncate hover:underline ${
          first.past ? 'bg-board-column text-board-text-muted' : 'bg-sky-500/15 text-sky-500'
        }`}
      >
        📆 {first.label}
      </a>
      {sorted.length > 1 && (
        <button
          type="button"
          {...isolate}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((value) => !value);
          }}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide calendar events' : `Show all ${sorted.length} calendar events`}
          title={expanded ? 'Hide events' : `${sorted.length} events`}
          className="text-[11px] px-1 py-0.5 rounded bg-board-column text-board-text-muted hover:text-board-text"
        >
          {expanded ? '−' : `+${sorted.length - 1}`}
        </button>
      )}
      {expanded && (
        <ul className="basis-full space-y-0.5" aria-label="Calendar events">
          {sorted.map((event) => {
            const item = describe(event);
            return (
              <li key={event.id}>
                <a
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  {...isolate}
                  title={`${item.accountLabel} · ${item.title}`}
                  className={`flex items-center gap-1 text-[11px] rounded px-1 py-0.5 hover:bg-board-column ${
                    item.past ? 'text-board-text-muted' : 'text-board-text'
                  }`}
                >
                  <span className="flex-shrink-0">📆 {item.label}</span>
                  {event.title && item.label !== event.title && <span className="truncate">· {event.title}</span>}
                  <span className="ml-auto flex-shrink-0 text-board-text-muted">↗</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
