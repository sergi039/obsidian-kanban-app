import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createApi, KanbanApiError, type ApiOptions } from './api.js';

/**
 * The Kanban tools an agent (Claude Code, Codex) uses instead of curl: the same API
 * routes the «в канбан» rule calls, with the board server as the only writer.
 */

export interface KanbanServerOptions extends ApiOptions {
  /** Address card links open: the board's public address, or the API's own. */
  appUrl?: string;
  /** Time zone of follow-up reminders; this Mac's by default. */
  timeZone?: string;
}

export const SERVER_NAME = 'obsidian-kanban';
const SERVER_VERSION = '0.3.0';
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
const FOLLOW_UP_DAYS_MAX = 90;

const INSTRUCTIONS = `Obsidian Kanban: the user's task board. Every card is a line in a Markdown file of their Obsidian vault.
Use these tools when the user asks to add, change, move, close or find a task ("add to kanban", «в канбан: …»). Never edit a board file or call the board's HTTP API yourself.
- Board: from kanban_list_boards. One board: use it. Several, and the request does not say which: ask one short question naming them.
- Before creating, look for the same task with kanban_list_cards (search) and update that card instead of adding a second one.
- The description stands without the chat: what, why, the next step and the deadline in 2-6 lines.
- An email about a task the board already has (another thread, another mailbox): kanban_attach_email, not a second card.
- Reply with the card's card_url.`;

const Link = z.object({
  url: z.string().url().refine((url) => /^https?:\/\//i.test(url), 'Only http(s) links'),
  title: z.string().min(1).optional().describe('Link text; the URL when left out'),
});
type LinkInput = z.infer<typeof Link>;

const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date as YYYY-MM-DD')
  .refine((day) => new Date(`${day}T00:00:00Z`).toISOString().startsWith(day), 'Not a calendar date');

/** The email a task came from; the server derives the card's link and one-card-per-thread key from it. */
const Email = z.object({
  provider: z.enum(['gmail', 'outlook']),
  account: z.string().describe('Address of the mailbox the email is in'),
  message_id: z.string().describe('Gmail API message id, or Microsoft Graph message id'),
  thread_id: z.string().optional().describe('Gmail threadId or Graph conversationId: one card per thread'),
  internet_message_id: z.string().optional().describe('RFC 5322 Message-ID header'),
  subject: z.string().optional(),
  from: z.string().optional(),
  received_at: z.string().optional().describe('ISO 8601 date-time with offset'),
});

interface ApiCard {
  id: string;
  board_id: string;
  column_name: string;
  title: string;
  is_done: boolean;
  priority: string | null;
  due_date: string | null;
  description: string | null;
  links: Array<{ url: string; title: string }>;
  email_threads?: ApiEmailThread[];
  updated_at: string;
  _writeBackWarning?: string;
}

interface ApiEmailThread {
  id: string;
  provider: string;
  account: string;
  subject: string | null;
  origin: boolean;
  follow_up: { mode: string | null; state: string | null; status: string; trigger_at: string } | null;
}

function toLinks(links: LinkInput[]): Array<{ url: string; title: string }> {
  return links.map((link) => ({ url: link.url, title: link.title ?? link.url }));
}

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function createKanbanServer(options: KanbanServerOptions): McpServer {
  const api = createApi(options);
  const appUrl = (options.appUrl ?? options.apiUrl).replace(/\/+$/, '');
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const cardUrl = (boardId: string, cardId: string) =>
    `${appUrl}/?${new URLSearchParams({ board: boardId, card: cardId }).toString()}`;

  const shape = (card: ApiCard) => ({
    id: card.id,
    board_id: card.board_id,
    column: card.column_name,
    title: card.title,
    is_done: card.is_done,
    priority: card.priority,
    due_date: card.due_date,
    description: card.description ?? '',
    links: card.links,
    // The email threads the card follows; a follow-up names one by id when there are several.
    email_threads: (card.email_threads ?? []).map((thread) => ({
      id: thread.id,
      mailbox: thread.account,
      provider: thread.provider,
      subject: thread.subject,
      card_made_from_it: thread.origin,
      follow_up: thread.follow_up
        ? { mode: thread.follow_up.mode, state: thread.follow_up.state, status: thread.follow_up.status, trigger_at: thread.follow_up.trigger_at }
        : null,
    })),
    updated_at: card.updated_at,
    card_url: cardUrl(card.board_id, card.id),
    // The board saved the change but could not write it into the Markdown file.
    ...(card._writeBackWarning ? { write_back_warning: card._writeBackWarning } : {}),
  });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'kanban_list_boards',
    {
      title: 'List boards',
      description: 'Boards with their columns, priorities and card counts. Archived boards only when asked.',
      inputSchema: { include_archived: z.boolean().default(false) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ include_archived }) => json((await api('GET', `/boards${include_archived ? '?archived=true' : ''}`)).body),
  );

  server.registerTool(
    'kanban_list_cards',
    {
      title: 'Find cards',
      description:
        'Cards of one board, newest first within each column. Done cards are left out unless include_done is true '
        + 'or a column is named. `search` matches part of the title.',
      inputSchema: {
        board_id: z.string().min(1),
        search: z.string().min(1).optional(),
        column: z.string().min(1).optional(),
        include_done: z.boolean().default(false),
        limit: z.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ board_id, search, column, include_done, limit }) => {
      const query = new URLSearchParams();
      if (search) query.set('search', search);
      if (column) query.set('column', column);
      const qs = query.size > 0 ? `?${query.toString()}` : '';
      const cards = (await api('GET', `/boards/${encodeURIComponent(board_id)}/cards${qs}`)).body as ApiCard[];
      const matching = include_done || column ? cards : cards.filter((card) => !card.is_done);
      return json({
        board_id,
        total: matching.length,
        returned: Math.min(matching.length, limit),
        // A truncated list is not the whole board: narrow it with search or column.
        truncated: matching.length > limit,
        cards: matching.slice(0, limit).map(shape),
      });
    },
  );

  server.registerTool(
    'kanban_create_card',
    {
      title: 'Create a card',
      description:
        'Add a task at the top of a column (the board\'s first column by default). For a task from an email pass '
        + '`email` with the provider ids, never the email body: the card links to the email, and when the thread '
        + 'already has a card that card is returned with status "existing" and nothing is changed. '
        + 'An error saying the thread\'s card was deleted means the user deleted it: tell them.',
      inputSchema: {
        board_id: z.string().min(1),
        title: z.string().min(1).max(500),
        column: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        due_date: Day.optional(),
        links: z.array(Link).optional(),
        email: Email.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ board_id, title, column, description, due_date, links, email }) => {
      const created = await api('POST', '/cards', { board_id, title, column, email });
      const card = created.body as ApiCard;
      if (created.status === 200) {
        return json({
          status: 'existing',
          note: 'This email thread already has this card; nothing was changed. Add to it with kanban_update_card.',
          card: shape(card),
        });
      }

      const details = {
        ...(description ? { description } : {}),
        ...(due_date ? { due_date } : {}),
        // add_links keeps the link to the email the server put on the card.
        ...(links?.length ? { add_links: toLinks(links) } : {}),
      };
      if (Object.keys(details).length === 0) return json({ status: 'created', card: shape(card) });

      try {
        const updated = await api('PATCH', `/cards/${encodeURIComponent(card.id)}`, details);
        return json({ status: 'created', card: shape(updated.body as ApiCard) });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `The card ${card.id} was created (${cardUrl(card.board_id, card.id)}), but its details were not saved: ${reason}. `
            + `Do not create it again; call kanban_update_card with card_id "${card.id}".`,
        );
      }
    },
  );

  server.registerTool(
    'kanban_update_card',
    {
      title: 'Update a card',
      description:
        'Change a card\'s title, due date or priority, add a paragraph to its description, or add links; what the '
        + 'card already has stays. due_date or priority null clears it; priority ids come from kanban_list_boards. '
        + 'To rewrite the whole description use kanban_replace_description.',
      inputSchema: {
        card_id: z.string().min(1),
        title: z.string().min(1).max(500).optional(),
        append_description: z.string().min(1).optional(),
        due_date: Day.nullable().optional(),
        add_links: z.array(Link).min(1).optional(),
        priority: z.string().min(1).nullable().optional(),
      },
      // Nothing the card had is lost: Codex runs it without asking, unlike a replacement.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ card_id, add_links, ...fields }) => {
      const body: Record<string, unknown> = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      if (add_links) body.add_links = toLinks(add_links);
      if (Object.keys(body).length === 0) throw new Error('Nothing to change: name at least one field');
      return json(shape((await api('PATCH', `/cards/${encodeURIComponent(card_id)}`, body)).body as ApiCard));
    },
  );

  server.registerTool(
    'kanban_replace_description',
    {
      title: 'Rewrite a card description',
      description:
        'Replace the whole description of a card; the old text is lost. Only when the user asks to rewrite it: '
        + 'to add something use kanban_update_card with append_description.',
      inputSchema: { card_id: z.string().min(1), description: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ card_id, description }) =>
      json(shape((await api('PATCH', `/cards/${encodeURIComponent(card_id)}`, { description })).body as ApiCard)),
  );

  server.registerTool(
    'kanban_move_card',
    {
      title: 'Move or close a card',
      description:
        'Move a card to another column of its board. To close a task, move it to the board\'s done column '
        + '(e.g. "Done"); moving it out reopens it.',
      inputSchema: { card_id: z.string().min(1), column: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ card_id, column }) => {
      try {
        const moved = await api('PATCH', `/cards/${encodeURIComponent(card_id)}`, { column_name: column });
        return json(shape(moved.body as ApiCard));
      } catch (err) {
        // The API answers "No fields to update" when the card is already in that column.
        if (err instanceof KanbanApiError && err.status === 400 && err.message.includes('No fields to update')) {
          return json({ status: 'unchanged', note: `The card is already in "${column}"` });
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'kanban_add_comment',
    {
      title: 'Comment on a card',
      description: 'Add a comment to a card, e.g. progress or an answer that arrived.',
      inputSchema: { card_id: z.string().min(1), text: z.string().min(1).max(5000) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ card_id, text }) =>
      json((await api('POST', `/cards/${encodeURIComponent(card_id)}/comments`, { text, author: 'agent' })).body),
  );

  server.registerTool(
    'kanban_attach_email',
    {
      title: 'Attach an email to a card',
      description:
        'Follow one more email thread on an existing card, e.g. the same task in another mailbox. Pass the provider '
        + 'ids, never the email body. The board then shows a badge for that mailbox, the thread can be followed up, '
        + 'and capturing this thread later returns this card. A thread that already belongs to another card is refused '
        + 'with that card\'s id.',
      inputSchema: { card_id: z.string().min(1), email: Email },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ card_id, email }) => {
      const attached = await api('POST', `/cards/${encodeURIComponent(card_id)}/email-threads`, email);
      const body = attached.body as { email_thread_id: string; card: ApiCard };
      return json({
        status: attached.status === 201 ? 'attached' : 'already_attached',
        email_thread_id: body.email_thread_id,
        card: shape(body.card),
      });
    },
  );

  server.registerTool(
    'kanban_follow_up',
    {
      title: 'Follow up an email',
      description:
        'For a card with an email thread: remind `days` days after the last message of the side being waited on, '
        + 'unless that answer arrives first. mode await_reply waits for their answer ("remind me if they do not '
        + 'answer"), owe_reply for the user\'s own ("remind me to answer"). A card with several threads needs '
        + 'email_thread_id from its email_threads. reminder null in the result means the answer is already there.',
      inputSchema: {
        card_id: z.string().min(1),
        email_thread_id: z.string().min(1).optional().describe('Which of the card\'s email threads; needed when it has several'),
        days: z.number().int().min(1).max(FOLLOW_UP_DAYS_MAX),
        mode: z.enum(['await_reply', 'owe_reply']).default('await_reply'),
        timezone: z.string().min(1).optional().describe('IANA time zone; this Mac\'s by default'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ card_id, email_thread_id, days, mode, timezone }) =>
      json((await api('POST', '/reminders/follow-up', {
        card_id,
        ...(email_thread_id ? { email_thread_id } : {}),
        days,
        mode,
        timezone: timezone ?? timeZone,
      })).body),
  );

  return server;
}
