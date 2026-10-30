import type { CalendarAccount, EmailFollowUp, EmailProvider, EmailThread } from '../types';

/**
 * What a mail badge shows for a thread: the state of its follow-up.
 * - error: the mailbox could not be read, so an answer would go unnoticed;
 * - overdue: the reminder time passed (or it fired) and no answer came;
 * - waiting: the follow-up waits for its answer;
 * - answered: the awaited answer arrived;
 * - linked: the card is tied to the thread, nothing is followed.
 */
export type ThreadStatus = 'error' | 'overdue' | 'waiting' | 'answered' | 'linked';

/** A mailbox badge takes its most pressing thread's status. */
const STATUS_RANK: Record<ThreadStatus, number> = { error: 4, overdue: 3, waiting: 2, answered: 1, linked: 0 };

/** Gmail drops a search URL longer than this from its address bar handling; the list stays the way in. */
const MAX_SEARCH_URL_LENGTH = 2000;

function followUpEffectiveAt(followUp: EmailFollowUp): string {
  return followUp.status === 'snoozed' && followUp.snoozed_until ? followUp.snoozed_until : followUp.trigger_at;
}

export function isActiveFollowUp(followUp: EmailFollowUp | null): boolean {
  return !!followUp && (followUp.status === 'scheduled' || followUp.status === 'snoozed');
}

export function threadStatus(thread: EmailThread, now = new Date()): ThreadStatus {
  const followUp = thread.follow_up;
  if (!followUp) return 'linked';
  if (followUp.status === 'dismissed') return followUp.state === 'answered' ? 'answered' : 'linked';
  if (followUp.state === 'unchecked' || followUp.error) return 'error';
  if (followUp.status === 'fired') return 'overdue';
  return new Date(followUpEffectiveAt(followUp)).getTime() <= now.getTime() ? 'overdue' : 'waiting';
}

export interface Mailbox {
  key: string;
  provider: EmailProvider;
  account: string;
  threads: EmailThread[];
  status: ThreadStatus;
}

/** The card's threads per mailbox, in the order the server sends them (the card's own email first). */
export function groupByMailbox(threads: EmailThread[], now = new Date()): Mailbox[] {
  const mailboxes = new Map<string, Mailbox>();
  for (const thread of threads) {
    const key = `${thread.provider}:${thread.account.toLowerCase()}`;
    const status = threadStatus(thread, now);
    const mailbox = mailboxes.get(key);
    if (!mailbox) {
      mailboxes.set(key, { key, provider: thread.provider, account: thread.account, threads: [thread], status });
    } else {
      mailbox.threads.push(thread);
      if (STATUS_RANK[status] > STATUS_RANK[mailbox.status]) mailbox.status = status;
    }
  }
  return [...mailboxes.values()];
}

/** The configured account's label for a mailbox (Work, Personal), else its domain. */
export function mailboxLabel(account: string, accounts: CalendarAccount[]): string {
  const configured = accounts.find((candidate) => candidate.email.toLowerCase() === account.toLowerCase());
  if (configured) return configured.label;
  return account.split('@')[1] ?? account;
}

export function providerName(provider: EmailProvider): string {
  return provider === 'gmail' ? 'Gmail' : 'Outlook';
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** One line on the thread's follow-up, for the badge tooltip and the card detail. */
export function describeFollowUp(thread: EmailThread, now = new Date()): string {
  const followUp = thread.follow_up;
  const status = threadStatus(thread, now);
  if (!followUp || status === 'linked') return 'Not followed up';
  if (status === 'answered') {
    const when = followUp.answered_at ? ` ${formatWhen(followUp.answered_at)}` : '';
    if (followUp.mode === 'owe_reply') return `You answered${when}`;
    return `Answered${when}${followUp.answered_by ? ` by ${followUp.answered_by}` : ''}`;
  }
  if (status === 'error') return `Can't read this mailbox: ${followUp.error ?? 'not checked yet'}`;
  const when = formatWhen(followUpEffectiveAt(followUp));
  if (followUp.mode === 'owe_reply') {
    return status === 'overdue' ? `You haven't answered · reminder ${when} passed` : `You owe an answer · reminder ${when}`;
  }
  return status === 'overdue' ? `No answer yet · reminder ${when} passed` : `Waiting for their answer · reminder ${when}`;
}

function messageIdTerm(id: string): string {
  return `rfc822msgid:${id.replace(/^<|>$/g, '')}`;
}

function subjectTerm(subject: string): string {
  // Gmail has no escape for a quote inside a quoted phrase.
  return `subject:"${subject.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

/**
 * A Gmail search for the mailbox's threads. Exact by Message-ID when every thread has
 * one, else by subject, which can also find other mail with the same words in its
 * subject. Null when there is nothing to search by or the URL would be too long.
 */
export function gmailSearch(account: string, threads: EmailThread[]): { url: string; exact: boolean } | null {
  const exact = threads.every((thread) => thread.internet_message_id);
  const terms = exact
    ? threads.map((thread) => messageIdTerm(thread.internet_message_id!))
    : threads.filter((thread) => thread.subject?.trim()).map((thread) => subjectTerm(thread.subject!));
  if (terms.length === 0) return null;
  const query = terms.length === 1 ? terms[0] : `{${terms.join(' ')}}`;
  // The same account path as the server's thread links (`emailSourceUrl`).
  const url = `https://mail.google.com/mail/u/${account.toLowerCase()}/#search/${encodeURIComponent(query)}`;
  return url.length > MAX_SEARCH_URL_LENGTH ? null : { url, exact };
}
