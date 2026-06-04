import { Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getDb } from '../db.js';
import { broadcast } from '../ws.js';
import { safeJsonParse } from '../utils.js';

const reminders = new Hono();

const ReminderKindSchema = z.enum(['due', 'follow_up', 'custom']);
const ReminderChannelSchema = z.enum(['in_app', 'browser', 'macos', 'calendar', 'email']);
const ReminderStatusSchema = z.enum(['scheduled', 'snoozed', 'fired', 'dismissed']);

const TZ_AWARE_ISO_RE = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/;

const DateTimeSchema = z.string().min(1).refine(
  (value) => TZ_AWARE_ISO_RE.test(value) && !Number.isNaN(Date.parse(value)),
  { message: 'Invalid timezone-aware ISO datetime' },
).transform((value) => new Date(value).toISOString());

const NullableDateTimeSchema = z.union([DateTimeSchema, z.null()]);

const CreateReminderSchema = z.object({
  card_id: z.string().min(1),
  kind: ReminderKindSchema.default('custom'),
  channel: ReminderChannelSchema.default('in_app'),
  trigger_at: DateTimeSchema,
  timezone: z.string().min(1).default('UTC'),
  message: z.string().default(''),
  source: z.string().nullable().optional(),
  source_uid: z.string().nullable().optional(),
  source_url: z.string().url().nullable().optional(),
  source_meta: z.record(z.unknown()).default({}),
});

const UpdateReminderSchema = z.object({
  kind: ReminderKindSchema.optional(),
  channel: ReminderChannelSchema.optional(),
  status: ReminderStatusSchema.optional(),
  trigger_at: DateTimeSchema.optional(),
  timezone: z.string().min(1).optional(),
  message: z.string().optional(),
  snoozed_until: NullableDateTimeSchema.optional(),
  last_fired_at: NullableDateTimeSchema.optional(),
  dismissed_at: NullableDateTimeSchema.optional(),
  source: z.string().nullable().optional(),
  source_uid: z.string().nullable().optional(),
  source_url: z.string().url().nullable().optional(),
  source_meta: z.record(z.unknown()).optional(),
});

const SnoozeReminderSchema = z.object({
  until: DateTimeSchema.optional(),
  minutes: z.number().int().min(1).max(60 * 24 * 365).optional(),
}).refine((value) => value.until || value.minutes, {
  message: 'until or minutes required',
});

const TimestampSchema = z.object({
  at: DateTimeSchema.optional(),
});

function generateId(prefix: string): string {
  return createHash('sha256')
    .update(`${prefix}-${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 12);
}

function parseLimit(raw: string | undefined, fallback = 100): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 1), 500);
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatReminder(row: Record<string, unknown>) {
  return {
    ...row,
    source_meta: safeJsonParse<Record<string, unknown>>(row.source_meta as string, {}),
    card_is_done: row.card_is_done === undefined ? undefined : Boolean(row.card_is_done),
  };
}

function getReminder(id: string): Record<string, unknown> | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT
      reminders.*,
      cards.title AS card_title,
      cards.column_name AS card_column_name,
      cards.is_done AS card_is_done
    FROM reminders
    JOIN cards ON cards.id = reminders.card_id
    WHERE reminders.id = ?
  `).get(id) as Record<string, unknown> | undefined;
}

function emitReminderChanged(type: string, row: Record<string, unknown>): void {
  broadcast({
    type,
    reminderId: row.id,
    cardId: row.card_id,
    boardId: row.board_id,
    timestamp: new Date().toISOString(),
  });
}

async function safeParseJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

// GET /api/reminders/due?before=&board_id=&channel=&limit=
reminders.get('/due', (c) => {
  const beforeParsed = DateTimeSchema.safeParse(c.req.query('before') || nowIso());
  if (!beforeParsed.success) {
    return c.json({ error: 'Invalid before datetime', details: beforeParsed.error.flatten() }, 400);
  }

  const channel = c.req.query('channel');
  if (channel && !ReminderChannelSchema.safeParse(channel).success) {
    return c.json({ error: 'Invalid channel' }, 400);
  }

  const where = [
    "reminders.status IN ('scheduled', 'snoozed')",
    "CASE WHEN reminders.status = 'snoozed' THEN COALESCE(reminders.snoozed_until, reminders.trigger_at) ELSE reminders.trigger_at END <= ?",
  ];
  const params: unknown[] = [beforeParsed.data];

  const boardId = c.req.query('board_id');
  if (boardId) {
    where.push('reminders.board_id = ?');
    params.push(boardId);
  }
  if (channel) {
    where.push('reminders.channel = ?');
    params.push(channel);
  }

  params.push(parseLimit(c.req.query('limit')));

  const db = getDb();
  const rows = db.prepare(`
    SELECT
      reminders.*,
      cards.title AS card_title,
      cards.column_name AS card_column_name,
      cards.is_done AS card_is_done,
      CASE WHEN reminders.status = 'snoozed' THEN COALESCE(reminders.snoozed_until, reminders.trigger_at) ELSE reminders.trigger_at END AS effective_at
    FROM reminders
    JOIN cards ON cards.id = reminders.card_id
    WHERE ${where.join(' AND ')}
    ORDER BY effective_at ASC, reminders.created_at ASC
    LIMIT ?
  `).all(...params) as Array<Record<string, unknown>>;

  return c.json(rows.map(formatReminder));
});

// GET /api/reminders?board_id=&card_id=&status=&channel=&limit=
reminders.get('/', (c) => {
  const where: string[] = [];
  const params: unknown[] = [];

  const boardId = c.req.query('board_id');
  if (boardId) {
    where.push('reminders.board_id = ?');
    params.push(boardId);
  }

  const cardId = c.req.query('card_id');
  if (cardId) {
    where.push('reminders.card_id = ?');
    params.push(cardId);
  }

  const status = c.req.query('status');
  if (status) {
    if (!ReminderStatusSchema.safeParse(status).success) return c.json({ error: 'Invalid status' }, 400);
    where.push('reminders.status = ?');
    params.push(status);
  }

  const channel = c.req.query('channel');
  if (channel) {
    if (!ReminderChannelSchema.safeParse(channel).success) return c.json({ error: 'Invalid channel' }, 400);
    where.push('reminders.channel = ?');
    params.push(channel);
  }

  if (!boardId && !cardId) {
    if (!channel) return c.json({ error: 'board_id, card_id, or channel required' }, 400);
    if (channel !== 'calendar') {
      return c.json({ error: 'board_id or card_id required for channel listings except calendar handoff' }, 400);
    }
  }

  params.push(parseLimit(c.req.query('limit')));

  const db = getDb();
  const rows = db.prepare(`
    SELECT
      reminders.*,
      cards.title AS card_title,
      cards.column_name AS card_column_name,
      cards.is_done AS card_is_done
    FROM reminders
    JOIN cards ON cards.id = reminders.card_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY reminders.trigger_at ASC, reminders.created_at ASC
    LIMIT ?
  `).all(...params) as Array<Record<string, unknown>>;

  return c.json(rows.map(formatReminder));
});

// POST /api/reminders — create a reminder for an existing card
reminders.post('/', async (c) => {
  const body = await safeParseJson(c);
  if (body === null) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = CreateReminderSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const db = getDb();
  const card = db.prepare('SELECT id, board_id FROM cards WHERE id = ?').get(parsed.data.card_id) as
    | { id: string; board_id: string }
    | undefined;
  if (!card) return c.json({ error: 'Card not found' }, 404);

  const id = generateId('reminder');
  if (parsed.data.source && parsed.data.source_uid) {
    const existing = db.prepare(`
      SELECT
        reminders.*,
        cards.title AS card_title,
        cards.column_name AS card_column_name,
        cards.is_done AS card_is_done
      FROM reminders
      JOIN cards ON cards.id = reminders.card_id
      WHERE reminders.card_id = ? AND reminders.source = ? AND reminders.source_uid = ?
    `).get(card.id, parsed.data.source, parsed.data.source_uid) as Record<string, unknown> | undefined;

    if (existing) {
      return c.json(formatReminder(existing));
    }
  }

  db.prepare(`
    INSERT INTO reminders (
      id, card_id, board_id, kind, channel, status, trigger_at, timezone, message,
      source, source_uid, source_url, source_meta
    ) VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    card.id,
    card.board_id,
    parsed.data.kind,
    parsed.data.channel,
    parsed.data.trigger_at,
    parsed.data.timezone,
    parsed.data.message,
    parsed.data.source ?? null,
    parsed.data.source_uid ?? null,
    parsed.data.source_url ?? null,
    JSON.stringify(parsed.data.source_meta),
  );

  const reminder = getReminder(id)!;
  emitReminderChanged('reminder-created', reminder);
  return c.json(formatReminder(reminder), 201);
});

// GET /api/reminders/:id — get one reminder
reminders.get('/:id', (c) => {
  const reminder = getReminder(c.req.param('id'));
  if (!reminder) return c.json({ error: 'Reminder not found' }, 404);
  return c.json(formatReminder(reminder));
});

// PATCH /api/reminders/:id — update reminder metadata/state
reminders.patch('/:id', async (c) => {
  const body = await safeParseJson(c);
  if (body === null) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = UpdateReminderSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const existing = getReminder(c.req.param('id'));
  if (!existing) return c.json({ error: 'Reminder not found' }, 404);

  const fields = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const key of ['kind', 'channel', 'status', 'trigger_at', 'timezone', 'message', 'snoozed_until', 'last_fired_at', 'dismissed_at', 'source', 'source_uid', 'source_url'] as const) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (fields.source_meta !== undefined) {
    sets.push('source_meta = ?');
    params.push(JSON.stringify(fields.source_meta));
  }

  if (sets.length === 0) return c.json(formatReminder(existing));

  sets.push("updated_at = datetime('now')");
  params.push(c.req.param('id'));
  getDb().prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const updated = getReminder(c.req.param('id'))!;
  emitReminderChanged('reminder-updated', updated);
  return c.json(formatReminder(updated));
});

// POST /api/reminders/:id/snooze — postpone delivery
reminders.post('/:id/snooze', async (c) => {
  const body = await safeParseJson(c);
  if (body === null) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = SnoozeReminderSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const existing = getReminder(c.req.param('id'));
  if (!existing) return c.json({ error: 'Reminder not found' }, 404);

  const snoozedUntil = parsed.data.until ?? new Date(Date.now() + parsed.data.minutes! * 60_000).toISOString();
  getDb().prepare(`
    UPDATE reminders
    SET status = 'snoozed', snoozed_until = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(snoozedUntil, c.req.param('id'));

  const updated = getReminder(c.req.param('id'))!;
  emitReminderChanged('reminder-snoozed', updated);
  return c.json(formatReminder(updated));
});

// POST /api/reminders/:id/dismiss — stop showing this reminder
reminders.post('/:id/dismiss', async (c) => {
  const body = await safeParseJson(c);
  const parsed = TimestampSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const existing = getReminder(c.req.param('id'));
  if (!existing) return c.json({ error: 'Reminder not found' }, 404);

  getDb().prepare(`
    UPDATE reminders
    SET status = 'dismissed', dismissed_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(parsed.data.at ?? nowIso(), c.req.param('id'));

  const updated = getReminder(c.req.param('id'))!;
  emitReminderChanged('reminder-dismissed', updated);
  return c.json(formatReminder(updated));
});

// POST /api/reminders/:id/fire — mark delivery by a notification agent
reminders.post('/:id/fire', async (c) => {
  const body = await safeParseJson(c);
  const parsed = TimestampSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const existing = getReminder(c.req.param('id'));
  if (!existing) return c.json({ error: 'Reminder not found' }, 404);

  getDb().prepare(`
    UPDATE reminders
    SET status = 'fired', last_fired_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(parsed.data.at ?? nowIso(), c.req.param('id'));

  const updated = getReminder(c.req.param('id'))!;
  emitReminderChanged('reminder-fired', updated);
  return c.json(formatReminder(updated));
});

// DELETE /api/reminders/:id — remove a reminder
reminders.delete('/:id', (c) => {
  const existing = getReminder(c.req.param('id'));
  if (!existing) return c.json({ error: 'Reminder not found' }, 404);

  getDb().prepare('DELETE FROM reminders WHERE id = ?').run(c.req.param('id'));
  emitReminderChanged('reminder-deleted', existing);
  return c.json({ ok: true });
});

export default reminders;
