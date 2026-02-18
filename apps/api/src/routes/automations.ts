import { Hono } from 'hono';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { getRules, getRule, createRule, updateRule, deleteRule, fireEvent } from '../automations.js';

const automations = new Hono();

const TriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('card.moved'),
    from_column: z.string().optional(),
    to_column: z.string().optional(),
    board_id: z.string().optional(),
  }),
  z.object({
    type: z.literal('card.created'),
    column: z.string().optional(),
    board_id: z.string().optional(),
  }),
]);

const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set_field'),
    field_id: z.string().min(1),
    value: z.string().nullable(),
  }),
  z.object({
    type: z.literal('add_comment'),
    text: z.string().min(1),
    author: z.string().optional(),
  }),
  z.object({
    type: z.literal('set_due_date'),
    days_from_now: z.number().int().min(0),
  }),
]);

const CreateAutomationSchema = z.object({
  board_id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  trigger: TriggerSchema,
  actions: z.array(ActionSchema).min(1),
});

const UpdateAutomationSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  trigger: TriggerSchema.optional(),
  actions: z.array(ActionSchema).min(1).optional(),
});

// GET /api/automations?board_id= — list rules for a board
automations.get('/', (c) => {
  const boardId = c.req.query('board_id');
  if (!boardId) return c.json({ error: 'board_id required' }, 400);

  return c.json(getRules(boardId));
});

// GET /api/automations/:id — get a single rule
automations.get('/:id', (c) => {
  const rule = getRule(c.req.param('id'));
  if (!rule) return c.json({ error: 'Automation not found' }, 404);
  return c.json(rule);
});

// POST /api/automations — create a rule
automations.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = CreateAutomationSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  // Verify board exists
  const config = loadConfig();
  const board = config.boards.find((b) => b.id === parsed.data.board_id);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const rule = createRule({
    board_id: parsed.data.board_id,
    name: parsed.data.name,
    trigger: parsed.data.trigger,
    actions: parsed.data.actions,
    enabled: parsed.data.enabled,
  });

  return c.json(rule, 201);
});

// PATCH /api/automations/:id — update a rule
automations.patch('/:id', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = UpdateAutomationSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const updated = updateRule(c.req.param('id'), parsed.data);
  if (!updated) return c.json({ error: 'Automation not found' }, 404);

  return c.json(updated);
});

// DELETE /api/automations/:id — delete a rule
automations.delete('/:id', (c) => {
  const deleted = deleteRule(c.req.param('id'));
  if (!deleted) return c.json({ error: 'Automation not found' }, 404);
  return c.json({ ok: true });
});

// POST /api/automations/test — dry-run test an event against rules
automations.post('/test', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  const EventSchema = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('card.moved'),
      cardId: z.string(),
      boardId: z.string(),
      fromColumn: z.string(),
      toColumn: z.string(),
    }),
    z.object({
      type: z.literal('card.created'),
      cardId: z.string(),
      boardId: z.string(),
      column: z.string(),
      title: z.string(),
    }),
  ]);

  const parsed = EventSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid event', details: parsed.error.flatten() }, 400);

  const result = fireEvent(parsed.data, { dryRun: true });
  return c.json(result);
});

export default automations;
