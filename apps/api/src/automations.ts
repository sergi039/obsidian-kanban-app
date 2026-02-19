/**
 * Automations Lite — config-driven rules engine.
 *
 * Triggers: card.moved, card.created
 * Actions: set_field, add_comment, set_due_date
 *
 * Rules are stored in the `automations` table and evaluated on matching events.
 */

import { createHash } from 'node:crypto';
import { getDb } from './db.js';
import { broadcast } from './ws.js';
import { safeJsonParse } from './utils.js';

// --- Types ---

export type TriggerType = 'card.moved' | 'card.created';

export interface TriggerCardMoved {
  type: 'card.moved';
  from_column?: string;   // optional: only trigger when moved FROM this column
  to_column?: string;     // optional: only trigger when moved TO this column
  board_id?: string;      // optional: scope to a specific board
}

export interface TriggerCardCreated {
  type: 'card.created';
  column?: string;        // optional: only trigger when created in this column
  board_id?: string;      // optional: scope to a specific board
}

export type Trigger = TriggerCardMoved | TriggerCardCreated;

export interface ActionSetField {
  type: 'set_field';
  field_id: string;
  value: string | null;
}

export interface ActionAddComment {
  type: 'add_comment';
  text: string;           // supports {{column}}, {{title}}, {{date}} placeholders
  author?: string;        // defaults to 'automation'
}

export interface ActionSetDueDate {
  type: 'set_due_date';
  days_from_now: number;  // e.g. 7 = due in 7 days from trigger
}

export type Action = ActionSetField | ActionAddComment | ActionSetDueDate;

export interface AutomationRule {
  id: string;
  board_id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  actions: Action[];
  created_at: string;
  updated_at: string;
}

export interface CardMovedEvent {
  type: 'card.moved';
  cardId: string;
  boardId: string;
  fromColumn: string;
  toColumn: string;
}

export interface CardCreatedEvent {
  type: 'card.created';
  cardId: string;
  boardId: string;
  column: string;
  title: string;
}

export type AutomationEvent = CardMovedEvent | CardCreatedEvent;

// --- Helpers ---

function generateId(): string {
  return createHash('sha256')
    .update(`auto-${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 12);
}


function formatRule(row: Record<string, unknown>): AutomationRule {
  return {
    id: row.id as string,
    board_id: row.board_id as string,
    name: row.name as string,
    enabled: Boolean(row.enabled),
    trigger: safeJsonParse(row.trigger_json as string, { type: 'card.moved' as const }),
    actions: safeJsonParse(row.actions_json as string, []),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function expandPlaceholders(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => ctx[key] ?? `{{${key}}}`);
}

function addDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// --- Rule matching ---

function matchesTrigger(trigger: Trigger, event: AutomationEvent): boolean {
  if (trigger.type !== event.type) return false;

  if (event.type === 'card.moved' && trigger.type === 'card.moved') {
    const t = trigger as TriggerCardMoved;
    if (t.board_id && t.board_id !== event.boardId) return false;
    if (t.from_column && t.from_column !== event.fromColumn) return false;
    if (t.to_column && t.to_column !== event.toColumn) return false;
    return true;
  }

  if (event.type === 'card.created' && trigger.type === 'card.created') {
    const t = trigger as TriggerCardCreated;
    if (t.board_id && t.board_id !== event.boardId) return false;
    if (t.column && t.column !== event.column) return false;
    return true;
  }

  return false;
}

// --- Action execution ---

function executeActions(actions: Action[], cardId: string, boardId: string, ctx: Record<string, string>): { executed: number; errors: string[] } {
  const db = getDb();
  let executed = 0;
  const errors: string[] = [];

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'set_field': {
          // Verify field exists AND belongs to the same board as the card
          const field = db.prepare('SELECT id, board_id FROM fields WHERE id = ?').get(action.field_id) as { id: string; board_id: string } | undefined;
          if (!field) {
            errors.push(`Field ${action.field_id} not found`);
            break;
          }
          if (field.board_id !== boardId) {
            errors.push(`Field ${action.field_id} belongs to board "${field.board_id}", not "${boardId}"`);
            break;
          }
          if (action.value === null) {
            db.prepare('DELETE FROM field_values WHERE card_id = ? AND field_id = ?').run(cardId, action.field_id);
          } else {
            db.prepare('INSERT OR REPLACE INTO field_values (card_id, field_id, value) VALUES (?, ?, ?)')
              .run(cardId, action.field_id, action.value);
          }
          db.prepare("UPDATE cards SET updated_at = datetime('now') WHERE id = ?").run(cardId);
          executed++;
          break;
        }

        case 'add_comment': {
          const text = expandPlaceholders(action.text, ctx);
          const author = action.author || 'automation';
          const commentId = createHash('sha256')
            .update(`${cardId}|auto|${Date.now()}|${Math.random()}`)
            .digest('hex')
            .slice(0, 12);
          db.prepare('INSERT INTO comments (id, card_id, author, text) VALUES (?, ?, ?, ?)')
            .run(commentId, cardId, author, text);
          db.prepare("UPDATE cards SET updated_at = datetime('now') WHERE id = ?").run(cardId);
          executed++;
          break;
        }

        case 'set_due_date': {
          const dueDate = addDays(action.days_from_now);
          db.prepare("UPDATE cards SET due_date = ?, updated_at = datetime('now') WHERE id = ?")
            .run(dueDate, cardId);
          executed++;
          break;
        }

        default:
          errors.push(`Unknown action type: ${(action as Action).type}`);
      }
    } catch (err) {
      errors.push(`Action ${action.type} failed: ${err}`);
    }
  }

  return { executed, errors };
}

// --- Public API ---

/** Get all rules for a board */
export function getRules(boardId: string): AutomationRule[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM automations WHERE board_id = ? ORDER BY created_at ASC')
    .all(boardId) as Array<Record<string, unknown>>;
  return rows.map(formatRule);
}

/** Get a single rule by ID */
export function getRule(ruleId: string): AutomationRule | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(ruleId) as Record<string, unknown> | undefined;
  return row ? formatRule(row) : null;
}

/** Create a new automation rule */
export function createRule(data: {
  board_id: string;
  name: string;
  trigger: Trigger;
  actions: Action[];
  enabled?: boolean;
}): AutomationRule {
  const db = getDb();
  const id = generateId();
  db.prepare(`
    INSERT INTO automations (id, board_id, name, enabled, trigger_json, actions_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, data.board_id, data.name, data.enabled !== false ? 1 : 0,
    JSON.stringify(data.trigger), JSON.stringify(data.actions));
  return getRule(id)!;
}

/** Update an automation rule */
export function updateRule(ruleId: string, patch: {
  name?: string;
  enabled?: boolean;
  trigger?: Trigger;
  actions?: Action[];
}): AutomationRule | null {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM automations WHERE id = ?').get(ruleId);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
  if (patch.trigger !== undefined) { sets.push('trigger_json = ?'); params.push(JSON.stringify(patch.trigger)); }
  if (patch.actions !== undefined) { sets.push('actions_json = ?'); params.push(JSON.stringify(patch.actions)); }

  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    params.push(ruleId);
    db.prepare(`UPDATE automations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  return getRule(ruleId);
}

/** Delete an automation rule */
export function deleteRule(ruleId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM automations WHERE id = ?').run(ruleId);
  return result.changes > 0;
}

/** Execute all matching rules for an event. Called from card routes.
 *  Set dryRun=true to only evaluate matches without executing actions. */
export function fireEvent(event: AutomationEvent, options?: { dryRun?: boolean }): { rulesFired: number; totalActions: number; errors: string[]; matchedRules?: string[] } {
  const dryRun = options?.dryRun ?? false;
  const db = getDb();

  // Fetch enabled rules for the event's board
  const rows = db.prepare('SELECT * FROM automations WHERE board_id = ? AND enabled = 1')
    .all(event.boardId) as Array<Record<string, unknown>>;

  const rules = rows.map(formatRule);
  let rulesFired = 0;
  let totalActions = 0;
  const allErrors: string[] = [];

  // Build context for placeholder expansion
  const card = db.prepare('SELECT title, column_name FROM cards WHERE id = ?')
    .get(event.cardId) as { title: string; column_name: string } | undefined;

  const ctx: Record<string, string> = {
    title: card?.title ?? '',
    column: card?.column_name ?? '',
    date: new Date().toISOString().slice(0, 10),
    ...(event.type === 'card.moved' ? {
      from_column: event.fromColumn,
      to_column: event.toColumn,
    } : {}),
    ...(event.type === 'card.created' ? {
      column: event.column,
    } : {}),
  };

  const matchedRuleNames: string[] = [];

  for (const rule of rules) {
    if (!matchesTrigger(rule.trigger, event)) continue;

    rulesFired++;
    matchedRuleNames.push(rule.name);

    if (dryRun) {
      // Dry-run: count expected actions without executing
      totalActions += rule.actions.length;
      continue;
    }

    const result = executeActions(rule.actions, event.cardId, event.boardId, ctx);
    totalActions += result.executed;
    allErrors.push(...result.errors.map((e) => `[${rule.name}] ${e}`));

    // Log execution
    console.log(`[automation] Rule "${rule.name}" fired for card ${event.cardId}: ${result.executed} actions`);
    if (result.errors.length > 0) {
      console.warn(`[automation] Errors in "${rule.name}":`, result.errors);
    }
  }

  // Broadcast card update if any actions executed (never in dry-run)
  if (!dryRun && totalActions > 0) {
    broadcast({
      type: 'card-updated',
      cardId: event.cardId,
      boardId: event.boardId,
      timestamp: new Date().toISOString(),
    });
  }

  return { rulesFired, totalActions, errors: allErrors, ...(dryRun ? { matchedRules: matchedRuleNames } : {}) };
}
