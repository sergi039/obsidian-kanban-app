/**
 * The card link a reminder carries (email, Calendar event, macOS notification): the API's
 * `card_url` on the public address, which opens outside the local network; the local app
 * address only when the Kanban has no public address (`card_url` null) or it is not https.
 */
export function reminderCardUrl(reminder, appUrl) {
  if (typeof reminder.card_url === 'string' && reminder.card_url.startsWith('https://')) return reminder.card_url;
  const params = new URLSearchParams({
    board: String(reminder.board_id),
    card: String(reminder.card_id),
  });
  return `${appUrl}/?${params.toString()}`;
}
