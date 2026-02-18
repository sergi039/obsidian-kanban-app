import { Hono } from 'hono';
import { getDb } from '../db.js';

const exportRoutes = new Hono();

interface CardRow {
  id: string;
  board_id: string;
  column_name: string;
  position: number;
  title: string;
  is_done: number;
  priority: string | null;
  labels: string;
  sub_items: string;
  due_date: string | null;
}

function cleanTitle(title: string): string {
  let cleaned = title.replace(/\[([^\]]*)\]\([^)]+\)/g, '$1');
  cleaned = cleaned.replace(/https?:\/\/[^\s)\]]+/g, '').trim();
  cleaned = cleaned.replace(/[⏫🔺]/g, '').trim();
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned;
}

function priorityEmoji(p: string | null): string {
  if (p === 'urgent') return '🔺';
  if (p === 'high') return '⏫';
  return '';
}

function formatMarkdown(boardName: string, columns: Map<string, CardRow[]>): string {
  const lines: string[] = [`# ${boardName}\n`];

  for (const [colName, cards] of columns) {
    lines.push(`## ${colName} (${cards.length})\n`);
    for (const card of cards) {
      const check = card.is_done ? '[x]' : '[ ]';
      const prio = priorityEmoji(card.priority);
      const title = cleanTitle(card.title);
      const due = card.due_date ? ` 📅 ${card.due_date}` : '';
      lines.push(`- ${check} ${prio}${prio ? ' ' : ''}${title}${due}`);

      const subItems = JSON.parse(card.sub_items || '[]') as string[];
      for (const sub of subItems) {
        lines.push(`  - ${sub}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatTelegram(boardName: string, columns: Map<string, CardRow[]>): string {
  const lines: string[] = [`📋 *${escapeTelegramMd(boardName)}*\n`];

  for (const [colName, cards] of columns) {
    lines.push(`\n*${escapeTelegramMd(colName)}* \\(${cards.length}\\)`);
    for (const card of cards) {
      const check = card.is_done ? '✅' : '⬜';
      const prio = priorityEmoji(card.priority);
      const title = escapeTelegramMd(cleanTitle(card.title));
      const due = card.due_date ? ` 📅 ${escapeTelegramMd(card.due_date)}` : '';
      lines.push(`${check} ${prio}${prio ? ' ' : ''}${title}${due}`);
    }
  }

  return lines.join('\n');
}

function escapeTelegramMd(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function formatWhatsApp(boardName: string, columns: Map<string, CardRow[]>): string {
  const lines: string[] = [`📋 *${boardName.toUpperCase()}*\n`];

  for (const [colName, cards] of columns) {
    lines.push(`\n*${colName.toUpperCase()}* (${cards.length})`);
    for (const card of cards) {
      const check = card.is_done ? '✅' : '⬜';
      const prio = priorityEmoji(card.priority);
      const title = cleanTitle(card.title);
      const due = card.due_date ? ` 📅 ${card.due_date}` : '';
      lines.push(`${check} ${prio}${prio ? ' ' : ''}• ${title}${due}`);
    }
  }

  return lines.join('\n');
}

// GET /api/export/:boardId?format=telegram|whatsapp|markdown
exportRoutes.get('/:boardId', (c) => {
  const boardId = c.req.param('boardId');
  const format = (c.req.query('format') || 'markdown').toLowerCase();

  if (!['markdown', 'telegram', 'whatsapp'].includes(format)) {
    return c.json({ error: 'Invalid format. Use: markdown, telegram, whatsapp' }, 400);
  }

  const db = getDb();

  // Get board name from cards
  const firstCard = db.prepare('SELECT board_id FROM cards WHERE board_id = ? LIMIT 1').get(boardId) as
    | { board_id: string }
    | undefined;

  if (!firstCard) {
    return c.json({ error: 'Board not found or empty' }, 404);
  }

  const cards = db.prepare('SELECT * FROM cards WHERE board_id = ? ORDER BY column_name, position').all(boardId) as CardRow[];

  // Group by column, preserve order
  const columns = new Map<string, CardRow[]>();
  for (const card of cards) {
    if (!columns.has(card.column_name)) {
      columns.set(card.column_name, []);
    }
    columns.get(card.column_name)!.push(card);
  }

  // Get board name from config or use ID
  const boardName = boardId.charAt(0).toUpperCase() + boardId.slice(1);

  let output: string;
  let contentType: string;

  switch (format) {
    case 'telegram':
      output = formatTelegram(boardName, columns);
      contentType = 'text/plain; charset=utf-8';
      break;
    case 'whatsapp':
      output = formatWhatsApp(boardName, columns);
      contentType = 'text/plain; charset=utf-8';
      break;
    default:
      output = formatMarkdown(boardName, columns);
      contentType = 'text/markdown; charset=utf-8';
  }

  return new Response(output, {
    headers: { 'Content-Type': contentType },
  });
});

export default exportRoutes;
