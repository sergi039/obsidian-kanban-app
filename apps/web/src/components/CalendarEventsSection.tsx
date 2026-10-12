import { useEffect, useRef, useState } from 'react';
import { patchCard } from '../api/client';
import type { CalendarEvent, Card } from '../types';
import { normalizeUrl } from '../lib/link-utils';
import { localDateTimeInputToIso } from '../lib/reminder-utils';
import { useCalendarSettings } from '../lib/calendar-context';
import {
  calendarHomeUrl,
  cardDeepLink,
  compatibleAccounts,
  eventLabel,
  eventOpenUrl,
  isPastEvent,
  newEventId,
  newEventUrl,
  resolveAccount,
  sortEvents,
  suggestAccount,
} from '../lib/calendar-utils';

interface Props {
  card: Card;
  /** Card title without priority emojis/links, used for new events. */
  title: string;
  /** Current due date (YYYY-MM-DD) — new events default to that day. */
  dueDate: string | null;
  onSaved: () => Promise<void>;
}

const inputClass =
  'text-xs bg-board-column border border-board-border rounded-md px-2 py-1.5 text-board-text focus:outline-none placeholder:text-board-text-muted/50';

export function CalendarEventsSection({ card, title, dueDate, onSaved }: Props) {
  const { accounts, defaultAccountId } = useCalendarSettings();
  const [events, setEvents] = useState<CalendarEvent[]>(card.calendar_events ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newUrl, setNewUrl] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [newStart, setNewStart] = useState('');
  const [newAccountId, setNewAccountId] = useState('');
  const [createAccountId, setCreateAccountId] = useState(defaultAccountId ?? '');

  // Saves replace the whole list, so only one may run at a time; a ref closes the
  // window between two clicks before the `saving` state re-renders.
  const savingRef = useRef(false);

  // Follow server state (board reload, other tabs), but never while a save is in
  // flight: the PATCH response is authoritative for this card until it lands.
  useEffect(() => {
    if (!savingRef.current) setEvents(card.calendar_events ?? []);
  }, [card.calendar_events]);

  const save = async (next: CalendarEvent[]): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    const previous = events;
    setSaving(true);
    setError(null);
    setEvents(next);
    try {
      const updated = await patchCard(card.id, { calendar_events: next });
      setEvents(updated.calendar_events);
    } catch (err) {
      setEvents(previous);
      setError(err instanceof Error ? err.message : 'Could not save calendar events');
      savingRef.current = false;
      setSaving(false);
      return false;
    }
    try {
      await onSaved();
    } catch (err) {
      // The events are saved; only the board refresh failed. Keep the saved list.
      setError(`Saved, but the board did not refresh: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    return true;
  };

  const normalizedNewUrl = newUrl.trim() ? normalizeUrl(newUrl) : '';
  const newUrlAccounts = normalizedNewUrl ? compatibleAccounts(normalizedNewUrl, accounts) : [];

  const handleUrlChange = (value: string) => {
    setNewUrl(value);
    const url = value.trim() ? normalizeUrl(value) : '';
    setNewAccountId(url ? suggestAccount(url, accounts, defaultAccountId)?.id ?? '' : '');
  };

  const resetForm = () => {
    setNewUrl('');
    setNewTitle('');
    setNewStart('');
    setAllDay(false);
    setNewAccountId('');
  };

  const handleAdd = async () => {
    if (!normalizedNewUrl) return;
    let parsed: URL;
    try {
      parsed = new URL(normalizedNewUrl);
    } catch {
      setError('That does not look like a link');
      return;
    }
    if (parsed.protocol !== 'https:') {
      setError('Only https links can be attached');
      return;
    }
    let start: string | null = null;
    if (newStart) {
      start = allDay ? newStart : localDateTimeInputToIso(newStart);
      if (!start) {
        setError('Invalid date');
        return;
      }
    }
    const event: CalendarEvent = {
      id: newEventId(),
      url: normalizedNewUrl,
      title: newTitle.trim(),
      start,
      account: newAccountId || null,
    };
    if (await save([...events, event])) resetForm();
  };

  const createAccount = accounts.find((account) => account.id === createAccountId)
    ?? accounts.find((account) => account.id === defaultAccountId)
    ?? accounts[0]
    ?? null;
  const sorted = sortEvents(events);

  return (
    <div>
      <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
        📆 Calendar {events.length > 0 && `(${events.length})`}
      </h3>

      {sorted.length > 0 && (
        <div className="space-y-0.5 mb-2">
          {sorted.map((event) => {
            const account = resolveAccount(event, accounts, defaultAccountId);
            const past = isPastEvent(event);
            const label = eventLabel(event);
            return (
              <div key={event.id} className="group/event flex items-center gap-2 py-1 px-2 rounded hover:bg-board-column transition-colors">
                <a
                  href={eventOpenUrl(event, account)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex items-center gap-2 text-sm hover:underline flex-1 min-w-0 ${past ? 'opacity-60' : ''}`}
                  style={{ color: 'var(--board-accent)' }}
                >
                  <span className="flex-shrink-0">📆 {label}</span>
                  {event.title && label !== event.title && (
                    <span className="truncate text-board-text">{event.title}</span>
                  )}
                  <span className="text-board-text-muted text-[10px] ml-auto flex-shrink-0">↗</span>
                </a>
                {account && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-board-column text-board-text-muted flex-shrink-0">
                    {account.label}
                  </span>
                )}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => save(events.filter((item) => item.id !== event.id))}
                  className="text-board-text-muted hover:text-red-400 text-xs opacity-0 group-hover/event:opacity-100 focus:opacity-100 transition-opacity px-1 flex-shrink-0 disabled:opacity-30"
                  title="Remove event link"
                  aria-label={`Remove event link: ${event.title || label}`}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newUrl}
            onChange={(e) => handleUrlChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAdd();
              }
            }}
            placeholder="Paste a Google or Outlook event link…"
            aria-label="Calendar event link"
            disabled={saving}
            className="flex-1 text-sm text-board-text bg-board-column border border-board-border rounded-md px-2.5 py-1.5 focus:outline-none placeholder:text-board-text-muted/50"
          />
          {newUrl.trim() && (
            <button
              type="button"
              disabled={saving}
              onClick={handleAdd}
              className="px-3 py-1.5 text-xs font-medium text-white rounded-md transition-colors disabled:opacity-50"
              style={{ backgroundColor: 'var(--board-accent)' }}
            >
              {saving ? 'Saving…' : 'Add'}
            </button>
          )}
        </div>

        {newUrl.trim() && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Title (optional)"
              aria-label="Event title"
              disabled={saving}
              className={`${inputClass} flex-1 min-w-[140px]`}
            />
            <input
              type={allDay ? 'date' : 'datetime-local'}
              value={newStart}
              onChange={(e) => setNewStart(e.target.value)}
              aria-label="Event start"
              disabled={saving}
              className={inputClass}
            />
            <label className="flex items-center gap-1 text-[11px] text-board-text-muted">
              <input
                type="checkbox"
                checked={allDay}
                disabled={saving}
                onChange={(e) => {
                  setAllDay(e.target.checked);
                  setNewStart('');
                }}
              />
              All day
            </label>
            {newUrlAccounts.length > 0 && (
              <select
                value={newAccountId}
                onChange={(e) => setNewAccountId(e.target.value)}
                aria-label="Calendar account"
                disabled={saving}
                className={inputClass}
              >
                <option value="">No account</option>
                {newUrlAccounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.label}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {accounts.length > 0 && createAccount && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-board-text-muted">
            {accounts.length > 1 ? (
              <select
                value={createAccount.id}
                onChange={(e) => setCreateAccountId(e.target.value)}
                aria-label="Calendar for new events"
                className="text-[11px] bg-board-column border border-board-border rounded px-1.5 py-0.5 text-board-text focus:outline-none"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.label}</option>
                ))}
              </select>
            ) : (
              <span>{createAccount.label}</span>
            )}
            <a
              href={newEventUrl(createAccount, {
                title,
                details: `Kanban: ${cardDeepLink(window.location.origin, card.board_id, card.id)}`,
                date: dueDate,
              })}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              style={{ color: 'var(--board-accent)' }}
              title="Opens a prefilled event in this calendar; paste its link here after saving"
            >
              ＋ New event ↗
            </a>
            <a
              href={calendarHomeUrl(createAccount)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              style={{ color: 'var(--board-accent)' }}
            >
              Open calendar ↗
            </a>
          </div>
        )}

        {error && <div className="text-[11px] text-red-400" role="alert">{error}</div>}
      </div>
    </div>
  );
}
