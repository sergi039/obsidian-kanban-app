import type { Reminder } from '../types';

export type ReminderState = 'due' | 'overdue' | 'today' | 'upcoming' | 'inactive';

export function isActiveReminder(reminder: Reminder): boolean {
  return reminder.status === 'scheduled' || reminder.status === 'snoozed';
}

export function reminderEffectiveAt(reminder: Reminder): string {
  return reminder.status === 'snoozed' && reminder.snoozed_until
    ? reminder.snoozed_until
    : reminder.trigger_at;
}

export function sortReminders(reminders: Reminder[]): Reminder[] {
  return [...reminders].sort((a, b) => reminderEffectiveAt(a).localeCompare(reminderEffectiveAt(b)));
}

export function activeReminders(reminders: Reminder[]): Reminder[] {
  return sortReminders(reminders.filter(isActiveReminder));
}

export function nextActiveReminder(reminders: Reminder[]): Reminder | null {
  return activeReminders(reminders)[0] ?? null;
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function reminderState(reminder: Reminder, now = new Date()): ReminderState {
  if (!isActiveReminder(reminder)) return 'inactive';

  const effective = new Date(reminderEffectiveAt(reminder));
  if (Number.isNaN(effective.getTime())) return 'inactive';

  const today = dateKey(now);
  const reminderDay = dateKey(effective);
  if (effective.getTime() <= now.getTime()) {
    return reminderDay < today ? 'overdue' : 'due';
  }
  return reminderDay === today ? 'today' : 'upcoming';
}

export function isDueReminder(reminder: Reminder, now = new Date()): boolean {
  const state = reminderState(reminder, now);
  return state === 'due' || state === 'overdue';
}

export function formatReminderTime(reminder: Reminder, now = new Date()): string {
  const effective = new Date(reminderEffectiveAt(reminder));
  if (Number.isNaN(effective.getTime())) return 'Invalid time';

  const state = reminderState(reminder, now);
  if (state === 'overdue') {
    return `Overdue ${effective.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  }
  if (state === 'due') return 'Due now';

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const time = effective.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (dateKey(effective) === dateKey(now)) return `Today ${time}`;
  if (dateKey(effective) === dateKey(tomorrow)) return `Tomorrow ${time}`;
  return effective.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function toLocalDateTimeInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function localDateTimeInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
