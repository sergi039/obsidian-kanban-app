import { useState } from 'react';
import type { EmailThread } from '../types';
import { useCalendarSettings } from '../lib/calendar-context';
import { openInWindow } from '../lib/calendar-utils';
import {
  describeFollowUp,
  gmailSearch,
  groupByMailbox,
  mailboxLabel,
  providerName,
  threadStatus,
  type Mailbox,
  type ThreadStatus,
} from '../lib/email-threads';
import { Icon, type IconName } from './Icon';

interface Props {
  threads: EmailThread[];
}

/** Keep clicks, drags and Enter on these controls from opening or dragging the card. */
const isolate = {
  onClick: (e: React.SyntheticEvent) => e.stopPropagation(),
  onPointerDown: (e: React.SyntheticEvent) => e.stopPropagation(),
  onKeyDown: (e: React.SyntheticEvent) => e.stopPropagation(),
};

const STATUS_ICON: Record<ThreadStatus, { icon: IconName; className: string } | null> = {
  error: { icon: 'alert', className: 'text-red-500' },
  overdue: { icon: 'alarm', className: '' },
  waiting: { icon: 'clock', className: '' },
  answered: { icon: 'check', className: 'text-green-500' },
  linked: null,
};

function badgeClass(mailbox: Mailbox): string {
  if (mailbox.status === 'overdue') return 'bg-amber-500/15 text-amber-500';
  return mailbox.provider === 'gmail' ? 'bg-red-500/10 text-red-500' : 'bg-blue-500/15 text-blue-500';
}

function StatusIcon({ status, size = 11 }: { status: ThreadStatus; size?: number }) {
  const spec = STATUS_ICON[status];
  if (!spec) return null;
  return <Icon name={spec.icon} size={size} strokeWidth={2.5} className={spec.className} />;
}

/**
 * Card-face mail badges: one per mailbox the card follows a thread in. One thread opens
 * in the mailbox's web client; several expand into the list, with a Gmail search for them.
 */
export function EmailThreadsChip({ threads }: Props) {
  const { accounts } = useCalendarSettings();
  const [expanded, setExpanded] = useState<string | null>(null);
  if (threads.length === 0) return null;
  const now = new Date();
  const mailboxes = groupByMailbox(threads, now);
  const open = mailboxes.find((mailbox) => mailbox.key === expanded) ?? null;

  return (
    <>
      {mailboxes.map((mailbox) => {
        const label = mailboxLabel(mailbox.account, accounts);
        const where = `${providerName(mailbox.provider)} · ${mailbox.account}`;
        const className = `text-[11px] px-1.5 py-0.5 rounded inline-flex items-center gap-1 whitespace-nowrap hover:underline ${badgeClass(mailbox)}`;
        if (mailbox.threads.length === 1) {
          const [thread] = mailbox.threads;
          const state = describeFollowUp(thread, now);
          return (
            <a
              key={mailbox.key}
              href={thread.url}
              target="_blank"
              rel="noopener noreferrer"
              {...isolate}
              onClick={(e) => {
                e.stopPropagation();
                openInWindow(e, thread.url);
              }}
              title={`${where}${thread.subject ? ` · ${thread.subject}` : ''}\n${state}`}
              aria-label={`Open the email in ${providerName(mailbox.provider)} (${label}): ${thread.subject ?? 'thread'}. ${state}`}
              className={className}
            >
              <Icon name="mail" size={12} />
              {label}
              <StatusIcon status={mailbox.status} />
            </a>
          );
        }
        const isOpen = expanded === mailbox.key;
        return (
          <button
            key={mailbox.key}
            type="button"
            {...isolate}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(isOpen ? null : mailbox.key);
            }}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Hide' : 'Show'} ${mailbox.threads.length} email threads in ${providerName(mailbox.provider)} (${label})`}
            title={`${where} · ${mailbox.threads.length} threads`}
            className={className}
          >
            <Icon name="mail" size={12} />
            {label} ×{mailbox.threads.length}
            <StatusIcon status={mailbox.status} />
          </button>
        );
      })}
      {open && (
        <ul className="basis-full space-y-0.5" aria-label={`Email threads in ${open.account}`}>
          {open.threads.map((thread) => {
            const status = threadStatus(thread, now);
            return (
              <li key={thread.id}>
                <a
                  href={thread.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  {...isolate}
                  onClick={(e) => {
                    e.stopPropagation();
                    openInWindow(e, thread.url);
                  }}
                  title={describeFollowUp(thread, now)}
                  className="flex items-center gap-1 text-[11px] rounded px-1 py-0.5 hover:bg-board-column text-board-text"
                >
                  {STATUS_ICON[status] ? <StatusIcon status={status} /> : <Icon name="mail" size={11} className="text-board-text-muted" />}
                  <span className="truncate">{thread.subject || 'Email thread'}</span>
                  <Icon name="external-link" size={11} className="ml-auto flex-shrink-0 text-board-text-muted" />
                </a>
              </li>
            );
          })}
          {open.provider === 'gmail' && (() => {
            const search = gmailSearch(open.account, open.threads);
            if (!search) return null;
            return (
              <li>
                <a
                  href={search.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  {...isolate}
                  onClick={(e) => {
                    e.stopPropagation();
                    openInWindow(e, search.url);
                  }}
                  title={search.exact ? 'Finds exactly these emails' : 'Searches by subject: other mail with the same subject shows up too'}
                  className="flex items-center gap-1 text-[11px] rounded px-1 py-0.5 hover:bg-board-column text-board-text-muted"
                >
                  <Icon name="search" size={11} />
                  {search.exact ? 'Find these emails in Gmail' : 'Search Gmail by subject'}
                </a>
              </li>
            );
          })()}
        </ul>
      )}
    </>
  );
}
