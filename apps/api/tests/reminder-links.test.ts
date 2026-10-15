import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain ESM script of the reminder agent, no type declarations
import { reminderCardUrl } from '../../../scripts/reminder-links.mjs';

const LOCAL = 'http://127.0.0.1:4000';

describe('reminder agent card link', () => {
  it('uses the public card link from the API', () => {
    const reminder = { board_id: 'vs', card_id: 'c1', card_url: 'https://kanban.example/?board=vs&card=c1' };
    expect(reminderCardUrl(reminder, LOCAL)).toBe('https://kanban.example/?board=vs&card=c1');
  });

  it('falls back to the local app only without a public https link', () => {
    for (const card_url of [null, undefined, '', 'http://127.0.0.1:4000/?board=vs&card=c1']) {
      expect(reminderCardUrl({ board_id: 'vs', card_id: 'c 1', card_url }, LOCAL)).toBe(`${LOCAL}/?board=vs&card=c+1`);
    }
  });
});
