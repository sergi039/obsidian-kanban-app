import type Database from 'better-sqlite3';
import { safeJsonParse } from './utils.js';

export interface SetFieldValueSuccess {
  ok: true;
  cardId: string;
  fieldId: string;
  value: string | null;
}

export interface SetFieldValueFailure {
  ok: false;
  status: number;
  error: string;
}

export type SetFieldValueResult = SetFieldValueSuccess | SetFieldValueFailure;

function validateAndNormalizeValue(field: Record<string, unknown>, rawValue: string | null): SetFieldValueResult | { ok: true; value: string | null } {
  if (rawValue === null) return { ok: true, value: null };

  let value = rawValue;
  const type = field.type as string;

  if (type === 'NUMBER') {
    if (value.trim().length === 0 || !Number.isFinite(Number(value))) {
      return { ok: false, status: 400, error: 'Value must be a finite number' };
    }
  }

  if (type === 'DATE') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return { ok: false, status: 400, error: 'Value must be a date (YYYY-MM-DD)' };
    }
    const [y, m, d] = value.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
      return { ok: false, status: 400, error: 'Invalid calendar date' };
    }
  }

  if (type === 'ITERATION') {
    if (value.trim().length === 0) {
      return { ok: false, status: 400, error: 'Iteration value must be a non-empty string' };
    }
  }

  if (type === 'SINGLE_SELECT') {
    const options = safeJsonParse<Array<{ id: string; name: string }>>(field.options as string, []);
    const match = options.find((o) => o.id === value || o.name === value);
    if (!match) {
      return { ok: false, status: 400, error: `Value must be one of: ${options.map((o) => o.name).join(', ')}` };
    }
    value = match.id;
  }

  return { ok: true, value };
}

export function setCardFieldValue(
  db: Database.Database,
  fieldId: string,
  cardId: string,
  rawValue: string | null,
): SetFieldValueResult {
  const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(fieldId) as Record<string, unknown> | undefined;
  if (!field) return { ok: false, status: 404, error: 'Field not found' };

  const card = db.prepare('SELECT id, board_id FROM cards WHERE id = ?').get(cardId) as
    | { id: string; board_id: string }
    | undefined;
  if (!card) return { ok: false, status: 404, error: 'Card not found' };

  if (card.board_id !== field.board_id) {
    return { ok: false, status: 400, error: 'Field and card belong to different boards' };
  }

  const validated = validateAndNormalizeValue(field, rawValue);
  if (!validated.ok) return validated;

  const value = validated.value;
  if (value === null) {
    db.prepare('DELETE FROM field_values WHERE card_id = ? AND field_id = ?').run(cardId, fieldId);
  } else {
    db.prepare(
      'INSERT OR REPLACE INTO field_values (card_id, field_id, value) VALUES (?, ?, ?)',
    ).run(cardId, fieldId, value);
  }

  db.prepare("UPDATE cards SET updated_at = datetime('now') WHERE id = ?").run(cardId);

  return { ok: true, cardId, fieldId, value };
}
