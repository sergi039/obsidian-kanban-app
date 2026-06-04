import { dismissReminder, snoozeReminder } from '../api/client';
import type { Card, Reminder } from '../types';
import { activeReminders, formatReminderTime, isDueReminder, reminderEffectiveAt } from '../lib/reminder-utils';

interface Props {
  reminders: Reminder[];
  cards: Card[];
  onClose: () => void;
  onOpenCard: (card: Card) => void;
  onRefresh: () => Promise<void>;
}

export function RemindersPanel({ reminders, cards, onClose, onOpenCard, onRefresh }: Props) {
  const active = activeReminders(reminders);
  const cardsById = new Map(cards.map((card) => [card.id, card]));

  const snooze = async (reminderId: string, minutes: number) => {
    await snoozeReminder(reminderId, { minutes });
    await onRefresh();
  };

  const dismiss = async (reminderId: string) => {
    await dismissReminder(reminderId);
    await onRefresh();
  };

  return (
    <div className="fixed inset-0 z-30" onClick={onClose}>
      <div
        className="absolute right-6 top-16 w-[360px] max-w-[calc(100vw-2rem)] bg-board-bg border border-board-border rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-board-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-board-text">Reminders</h2>
            <p className="text-xs text-board-text-muted">{active.length} active</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-board-text-muted hover:text-board-text rounded-md px-2 py-1"
            aria-label="Close reminders"
          >
            ✕
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-2">
          {active.length === 0 ? (
            <div className="text-sm text-board-text-muted py-8 text-center">No active reminders</div>
          ) : (
            <div className="space-y-1">
              {active.map((reminder) => {
                const card = cardsById.get(reminder.card_id);
                const due = isDueReminder(reminder);
                return (
                  <div key={reminder.id} className="p-3 rounded-md hover:bg-board-column transition-colors border border-transparent hover:border-board-border">
                    <button
                      type="button"
                      onClick={() => {
                        if (card) {
                          onOpenCard(card);
                          onClose();
                        }
                      }}
                      className="block w-full text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`text-[11px] px-1.5 py-0.5 rounded ${due ? 'bg-amber-500/15 text-amber-500' : 'bg-board-card text-board-text-muted'}`}>
                          {formatReminderTime(reminder)}
                        </span>
                        <span className="text-[11px] text-board-text-muted">{reminder.kind}</span>
                      </div>
                      <div className="text-sm text-board-text mt-1 line-clamp-2">
                        {card?.title || reminder.card_title || reminder.card_id}
                      </div>
                      {reminder.message && (
                        <div className="text-xs text-board-text-muted mt-1 line-clamp-2">{reminder.message}</div>
                      )}
                      <div className="text-[10px] text-board-text-muted mt-1">
                        {new Date(reminderEffectiveAt(reminder)).toLocaleString()}
                      </div>
                    </button>

                    <div className="flex items-center gap-2 mt-2">
                      <button
                        type="button"
                        onClick={() => snooze(reminder.id, 60)}
                        className="text-[11px] px-2 py-1 rounded bg-board-card hover:bg-board-card-hover text-board-text-muted hover:text-board-text"
                      >
                        Snooze 1h
                      </button>
                      <button
                        type="button"
                        onClick={() => snooze(reminder.id, 24 * 60)}
                        className="text-[11px] px-2 py-1 rounded bg-board-card hover:bg-board-card-hover text-board-text-muted hover:text-board-text"
                      >
                        Tomorrow
                      </button>
                      <button
                        type="button"
                        onClick={() => dismiss(reminder.id)}
                        className="text-[11px] px-2 py-1 rounded text-board-text-muted hover:text-red-400 ml-auto"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
