/**
 * Client-side evaluation of the board filter query, for the cards already
 * loaded on the board. It follows the server filter engine
 * (apps/api/src/filter-engine.ts): a qualifier value the engine does not
 * know is ignored, never turned into "match nothing". `reminder:` exists
 * only here, because reminders live in the web state.
 */
import type { Card, Reminder } from '../types';
import { activeReminders, reminderState } from './reminder-utils';

const KNOWN_QUALIFIERS = new Set(['status', 'priority', 'label', 'due', 'done', 'has', 'board', 'reminder']);
const QUALIFIER_RE = /^(-?)([a-zA-Z_]+):(.+)$/;
const LITERAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Split by whitespace, keeping quoted strings together (same as the server). */
export function splitFilterQuery(query: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (const ch of query.trim()) {
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) { parts.push(current); current = ''; }
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** has:<value> — null when the value is unknown (the token is then ignored). */
function matchHas(card: Card, value: string, reminders: Reminder[]): boolean | null {
  switch (value) {
    case 'description': return !!card.description;
    case 'priority': return !!card.priority;
    case 'label':
    case 'labels': return card.labels.length > 0;
    case 'due':
    case 'due_date': return !!card.due_date;
    case 'comments': return (card.comment_count ?? 0) > 0;
    case 'reminder':
    case 'reminders': return activeReminders(reminders).length > 0;
    default: return null;
  }
}

/** due:<value> — null when the value is unknown (the token is then ignored). */
function matchDue(card: Card, value: string): boolean | null {
  const today = todayKey();
  switch (value) {
    case 'none': return !card.due_date;
    case 'any': return !!card.due_date;
    case 'overdue': return !!card.due_date && new Date(card.due_date) < new Date(today);
    case 'today': return card.due_date === today;
    case 'tomorrow': {
      const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
      return card.due_date === tmr.toISOString().slice(0, 10);
    }
    case 'this-week':
    case 'this-month': {
      if (!card.due_date) return false;
      const d = new Date(card.due_date);
      const now = new Date(today);
      const end = new Date(now); end.setDate(end.getDate() + (value === 'this-week' ? 7 : 30));
      return d >= now && d <= end;
    }
    default:
      return LITERAL_DATE_RE.test(value) ? card.due_date === value : null;
  }
}

function matchReminder(values: string[], reminders: Reminder[]): boolean {
  const active = activeReminders(reminders);
  const states = active.map((reminder) => reminderState(reminder));
  return values.some((v) => {
    const rv = v.toLowerCase();
    if (rv === 'any') return active.length > 0;
    if (rv === 'none') return active.length === 0;
    if (rv === 'due') return states.includes('due') || states.includes('overdue');
    if (rv === 'overdue') return states.includes('overdue');
    if (rv === 'today') return states.includes('today') || states.includes('due');
    if (rv === 'upcoming') return states.includes('upcoming');
    return false;
  });
}

/** Whether one qualifier token matches the card; null means "ignore this token". */
function matchQualifier(card: Card, qualifier: string, values: string[], reminders: Reminder[]): boolean | null {
  const first = values[0].toLowerCase();
  switch (qualifier) {
    case 'status':
      return values.some((v) => card.column_name.toLowerCase() === v.toLowerCase());
    case 'priority':
      if (values.includes('none')) return !card.priority;
      return values.some((v) => (card.priority || '').toLowerCase() === v.toLowerCase());
    case 'label':
      // Non-negated: any label matches (OR). Negated: the caller flips it, so the card has none of them.
      return values.some((v) => card.labels.some((l) => l.toLowerCase() === v.toLowerCase()));
    case 'done':
      return ['yes', 'true', '1'].includes(first) ? card.is_done : !card.is_done;
    case 'has':
      return matchHas(card, first, reminders);
    case 'due':
      return matchDue(card, first);
    case 'board':
      return values.some((v) => card.board_id.toLowerCase() === v.toLowerCase());
    case 'reminder':
      return matchReminder(values, reminders);
    default:
      return null;
  }
}

export function filterCards(
  cards: Card[],
  query: string,
  remindersByCard: Map<string, Reminder[]>,
): Card[] {
  if (!query.trim()) return cards;
  const parts = splitFilterQuery(query);

  return cards.filter((card) => {
    const reminders = remindersByCard.get(card.id) ?? [];
    for (const part of parts) {
      const m = part.match(QUALIFIER_RE);
      if (m && KNOWN_QUALIFIERS.has(m[2].toLowerCase())) {
        const values = m[3].split(',').map((v) => v.trim()).filter(Boolean);
        if (values.length === 0) continue;
        const match = matchQualifier(card, m[2].toLowerCase(), values, reminders);
        if (match === null) continue;
        const negated = m[1] === '-';
        if (negated ? match : !match) return false;
      } else if (!card.title.toLowerCase().includes(part.toLowerCase())) {
        // Unknown qualifier or free text searches the title.
        return false;
      }
    }
    return true;
  });
}
