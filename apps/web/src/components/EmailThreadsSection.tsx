import { useState } from 'react';
import type { Card, EmailThread } from '../types';
import {
  ApiError,
  detachEmailThread,
  dismissReminder,
  followUpEmailThread,
  snoozeReminder,
  type FollowUpMode,
} from '../api/client';
import { useCalendarSettings } from '../lib/calendar-context';
import { openInWindow } from '../lib/calendar-utils';
import {
  describeFollowUp,
  gmailSearch,
  groupByMailbox,
  isActiveFollowUp,
  mailboxLabel,
  providerName,
  threadStatus,
} from '../lib/email-threads';
import { Icon } from './Icon';

interface Props {
  card: Card;
  /** Reload the card and its reminders after a change. */
  onChanged: () => Promise<void>;
}

const FOLLOW_UP_DAYS = [1, 2, 3, 5, 7, 14];
const DEFAULT_FOLLOW_UP_DAYS = 3;
const SNOOZE_MINUTES = 24 * 60;

const STATUS_TONE = {
  error: 'text-red-500',
  overdue: 'text-amber-500',
  waiting: 'text-board-text-muted',
  answered: 'text-green-500',
  linked: 'text-board-text-muted',
} as const;

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { error?: string };
      if (body.error) return body.error;
    } catch {
      // not JSON: fall through to the status line
    }
    return `Request failed (${err.status})`;
  }
  return err instanceof Error ? err.message : String(err);
}

function ThreadRow({ card, thread, onChanged }: { card: Card; thread: EmailThread; onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<FollowUpMode>(thread.follow_up?.mode ?? 'await_reply');
  const [days, setDays] = useState(thread.follow_up?.days ?? DEFAULT_FOLLOW_UP_DAYS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = threadStatus(thread);
  const followUp = thread.follow_up;
  const active = isActiveFollowUp(followUp);
  const followable = !active;
  const stoppable = active || followUp?.status === 'fired';

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const startFollowUp = () => run(async () => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { reminder } = await followUpEmailThread(card.id, thread.id, { days, mode, timezone });
    return reminder ? null : 'The answer is already in this thread: nothing to follow up.';
  });
  const snooze = () => run(async () => {
    await snoozeReminder(followUp!.reminder_id, { minutes: SNOOZE_MINUTES });
    return null;
  });
  const stop = () => run(async () => {
    await dismissReminder(followUp!.reminder_id);
    return null;
  });
  const detach = () => {
    if (!window.confirm('Stop following this email thread on the card? Its follow-up stops too.')) return;
    void run(async () => {
      await detachEmailThread(card.id, thread.id);
      return null;
    });
  };

  return (
    <li className="py-1.5 px-2 rounded hover:bg-board-column/60">
      <a
        href={thread.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => openInWindow(e, thread.url)}
        className="flex items-center gap-2 text-sm hover:underline"
        style={{ color: 'var(--board-accent)' }}
      >
        <Icon name="mail" size={13} />
        <span className="truncate text-board-text">{thread.subject || 'Email thread'}</span>
        {thread.origin && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-board-column text-board-text-muted flex-shrink-0" title="The card was made from this email">
            origin
          </span>
        )}
        <Icon name="external-link" size={11} className="ml-auto flex-shrink-0 text-board-text-muted" />
      </a>
      {thread.from && <div className="text-[11px] text-board-text-muted pl-5 truncate">From {thread.from}</div>}
      <div className={`text-[11px] pl-5 ${STATUS_TONE[status]}`}>{describeFollowUp(thread)}</div>

      <div className="flex items-center gap-1.5 flex-wrap pl-5 mt-1">
        {followable && (
          <>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as FollowUpMode)}
              disabled={busy}
              aria-label="What to wait for"
              className="text-[11px] bg-board-column border border-board-border rounded px-1 py-0.5 text-board-text"
            >
              <option value="await_reply">Remind if they don't answer</option>
              <option value="owe_reply">Remind me to answer</option>
            </select>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              disabled={busy}
              aria-label="Days to wait"
              className="text-[11px] bg-board-column border border-board-border rounded px-1 py-0.5 text-board-text"
            >
              {FOLLOW_UP_DAYS.map((value) => (
                <option key={value} value={value}>{value === 1 ? 'in 1 day' : `in ${value} days`}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={startFollowUp}
              disabled={busy}
              className="text-[11px] px-2 py-0.5 rounded text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--board-accent)' }}
            >
              {followUp ? 'Follow up again' : 'Follow up'}
            </button>
          </>
        )}
        {active && (
          <button
            type="button"
            onClick={snooze}
            disabled={busy}
            className="text-[11px] px-2 py-0.5 rounded bg-board-column text-board-text hover:bg-board-border disabled:opacity-50"
          >
            Snooze 1 day
          </button>
        )}
        {stoppable && (
          <button
            type="button"
            onClick={stop}
            disabled={busy}
            className="text-[11px] px-2 py-0.5 rounded bg-board-column text-board-text hover:bg-board-border disabled:opacity-50"
          >
            Stop following up
          </button>
        )}
        {!thread.origin && (
          <button
            type="button"
            onClick={detach}
            disabled={busy}
            className="text-[11px] px-2 py-0.5 rounded text-board-text-muted hover:text-red-500 disabled:opacity-50 ml-auto"
            title="Stop following this thread on the card"
          >
            Detach
          </button>
        )}
      </div>
      {notice && <div className="text-[11px] text-board-text-muted pl-5 mt-1">{notice}</div>}
      {error && <div role="alert" className="text-[11px] text-red-500 pl-5 mt-1">{error}</div>}
    </li>
  );
}

/**
 * The email threads the card follows, per mailbox: open a thread, follow it up (remind
 * if they don't answer, or remind me to answer), snooze or stop that, detach a thread.
 * Threads are attached by an agent (kanban_attach_email) or come with a card made from an email.
 */
export function EmailThreadsSection({ card, onChanged }: Props) {
  const { accounts } = useCalendarSettings();
  const threads = card.email_threads ?? [];
  if (threads.length === 0) return null;
  const mailboxes = groupByMailbox(threads);

  return (
    <div>
      <h3 className="text-xs font-medium text-board-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <Icon name="mail" size={13} /> Mail ({threads.length})
      </h3>
      <div className="space-y-2">
        {mailboxes.map((mailbox) => {
          const search = mailbox.provider === 'gmail' && mailbox.threads.length > 1 ? gmailSearch(mailbox.account, mailbox.threads) : null;
          return (
            <section key={mailbox.key} aria-label={`${providerName(mailbox.provider)} ${mailbox.account}`}>
              <div className="flex items-center gap-1.5 text-[11px] text-board-text-muted mb-0.5">
                <span className="px-1.5 py-0.5 rounded bg-board-column">{mailboxLabel(mailbox.account, accounts)}</span>
                <span className="truncate">{providerName(mailbox.provider)} · {mailbox.account}</span>
                {search && (
                  <a
                    href={search.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => openInWindow(e, search.url)}
                    className="ml-auto inline-flex items-center gap-1 hover:underline flex-shrink-0"
                    title={search.exact ? 'Finds exactly these emails' : 'Searches by subject: other mail with the same subject shows up too'}
                  >
                    <Icon name="search" size={11} /> {search.exact ? 'Find in Gmail' : 'Search Gmail by subject'}
                  </a>
                )}
              </div>
              <ul className="space-y-0.5">
                {mailbox.threads.map((thread) => (
                  <ThreadRow key={`${thread.id}:${thread.follow_up?.reminder_id ?? ''}:${thread.follow_up?.status ?? ''}`} card={card} thread={thread} onChanged={onChanged} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
