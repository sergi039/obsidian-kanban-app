import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

let testDb: InstanceType<typeof Database>;
let vaultRoot: string;
const PUBLIC_URL = 'https://kanban.example';

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return { ...actual, getDb: () => testDb };
});

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadConfig: () => ({
      vaultRoot,
      boards: [{ id: 'b1', name: 'Cervantes', file: 'Tasks/Board.md', columns: ['Backlog', 'Done'] }],
      defaultColumns: ['Backlog', 'Done'],
      publicUrl: PUBLIC_URL,
    }),
  };
});

vi.mock('../src/ws.js', () => ({ broadcast: vi.fn() }));

const ctx = await import('../src/obsidian-context.js');

const DATE = '2026-10-12';
const NOW = new Date(2026, 9, 12, 12, 0, 0);

function writeNote(rel: string, content: string) {
  const abs = path.join(vaultRoot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function readNote(rel: string): string {
  return readFileSync(path.join(vaultRoot, rel), 'utf-8');
}

function seedCard(id: string, fields: Partial<Record<'title' | 'description' | 'links' | 'sub_items' | 'checklist', string>> & { is_done?: number; seq_id?: number } = {}) {
  testDb.prepare(`
    INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done, seq_id, description, links, sub_items, checklist)
    VALUES (?, 'b1', ?, 0, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    (fields.is_done ?? 1) ? 'Done' : 'Backlog',
    fields.title ?? `Task ${id}`,
    `- [x] ${fields.title ?? `Task ${id}`}`,
    fields.is_done ?? 1,
    fields.seq_id ?? 7,
    fields.description ?? '',
    fields.links ?? '[]',
    fields.sub_items ?? '[]',
    fields.checklist ?? '[]',
  );
}

function comments(cardId: string): Array<{ author: string; text: string }> {
  return testDb.prepare('SELECT author, text FROM comments WHERE card_id = ? ORDER BY rowid').all(cardId) as Array<{ author: string; text: string }>;
}

function obsidianLink(file: string, vault = 'Notes'): string {
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
}

describe('references a card makes', () => {
  it('reads obsidian:// links to this vault and [[wikilinks]], skipping embeds and other vaults', () => {
    const card = {
      title: 'Pay [[Andrey invoices|invoices]]',
      description: `See [[Property/Plan#Costs]] and ![[photo.png]]; also obsidian://open?path=${encodeURIComponent('/vault/Notes/Abs Note.md')}`,
      sub_items: JSON.stringify(['[[Sub note]]']),
      checklist: JSON.stringify([{ id: '1', title: 'check [[List note]]', done: false }]),
      links: JSON.stringify([
        { url: obsidianLink('Property/Cervantes 50/Андрей — счета 2026'), title: 'note' },
        { url: obsidianLink('_Attachments/Factura.pdf'), title: 'pdf' },
        { url: obsidianLink('Elsewhere', 'Other'), title: 'other vault' },
        { url: 'https://example.com/', title: 'web' },
      ]),
    };
    expect(ctx.noteTargetsInCard(card, '/vault/Notes').sort()).toEqual([
      'Abs Note.md',
      'Andrey invoices',
      'List note',
      'Property/Cervantes 50/Андрей — счета 2026',
      'Property/Plan',
      'Sub note',
      '_Attachments/Factura.pdf',
    ].sort());
  });
});

describe('resolving a target to a note', () => {
  const index = ctx.buildVaultIndex([
    'Property/Cervantes 50/Андрей — счета 2026.md',
    'Business/Plan.md',
    'Private/Plan.md',
    'Unique note.md',
    'Plan v1.2.md',
  ]);

  it('finds the exact path with or without .md, ignoring case and Unicode normalization', () => {
    expect(ctx.resolveNoteTarget('Property/Cervantes 50/Андрей — счета 2026', index)).toEqual({ note: 'Property/Cervantes 50/Андрей — счета 2026.md' });
    expect(ctx.resolveNoteTarget('property/cervantes 50/андрей — счета 2026.md'.normalize('NFD'), index)).toEqual({ note: 'Property/Cervantes 50/Андрей — счета 2026.md' });
  });

  it('resolves a bare name only when one note has it', () => {
    expect(ctx.resolveNoteTarget('Unique note', index)).toEqual({ note: 'Unique note.md' });
    expect(ctx.resolveNoteTarget('Plan', index)).toEqual({ problem: expect.stringContaining('неоднозначна') });
    expect(ctx.resolveNoteTarget('Private/Plan', index)).toEqual({ note: 'Private/Plan.md' });
    expect(ctx.resolveNoteTarget('Plan v1.2', index)).toEqual({ note: 'Plan v1.2.md' });
  });

  it('reports a missing note and ignores attachments', () => {
    expect(ctx.resolveNoteTarget('Gone note', index)).toEqual({ problem: 'заметка «Gone note» не найдена' });
    expect(ctx.resolveNoteTarget('_Attachments/Factura.pdf', index)).toBeNull();
  });
});

describe('writing the closing line', () => {
  const tail = '— [Cervantes #7](https://kanban.example/?board=b1&card=abc)';
  const line = `- 2026-10-12 ✅ Карточка закрыта: «Pay» ${tail}`;
  const entry = { line, tail };

  it('appends to an existing Канбан section, before the next heading', () => {
    const note = '# Note\n\n## Канбан\n- 2026-10-01 ✅ Карточка закрыта: «Old»\n\n## Другое\ntext\n';
    expect(ctx.withClosedLine(note, entry, NOW)).toBe(
      `# Note\n\n## Канбан\n- 2026-10-01 ✅ Карточка закрыта: «Old»\n${line}\n\n## Другое\ntext\n`,
    );
  });

  it('creates the section at the end and keeps the trailing newline', () => {
    expect(ctx.withClosedLine('# Note\nbody\n\n\n', entry, NOW)).toBe(`# Note\nbody\n\n## Канбан\n${line}\n`);
    expect(ctx.withClosedLine('# Note\nbody', entry, NOW)).toBe(`# Note\nbody\n\n## Канбан\n${line}`);
  });

  it('sets frontmatter updated: in its quote style, adds it when absent, never creates frontmatter', () => {
    const quoted = "---\ntitle: x\nupdated: '2026-10-10'\n---\nbody\n";
    expect(ctx.withClosedLine(quoted, entry, NOW)).toBe(`---\ntitle: x\nupdated: '2026-10-12'\n---\nbody\n\n## Канбан\n${line}\n`);
    expect(ctx.withClosedLine('---\nupdated: 2026-10-10\n---\nb\n', entry, NOW)).toContain('\nupdated: 2026-10-12\n');
    expect(ctx.withClosedLine('---\ntitle: x\n---\nb\n', entry, NOW)).toBe(`---\ntitle: x\nupdated: '2026-10-12'\n---\nb\n\n## Канбан\n${line}\n`);
    expect(ctx.withClosedLine('no frontmatter\n', entry, NOW)).toBe(`no frontmatter\n\n## Канбан\n${line}\n`);
  });

  it('never writes inside a code fence', () => {
    const fencedSection = '## Канбан\n```bash\n# deploy\n./run.sh\n```\n\n## Next\n';
    expect(ctx.withClosedLine(fencedSection, entry, NOW)).toBe(`## Канбан\n\`\`\`bash\n# deploy\n./run.sh\n\`\`\`\n${line}\n\n## Next\n`);
    const fencedHeading = '```md\n## Канбан\n```\n';
    expect(ctx.withClosedLine(fencedHeading, entry, NOW)).toBe(`\`\`\`md\n## Канбан\n\`\`\`\n\n## Канбан\n${line}\n`);
  });

  it('treats ```inline``` code at the start of a line as text, so the section is found on every close', () => {
    const note = '```npm ci``` — сначала\n\n## Канбан\n- 2026-10-01 ✅ old\n\n## Заметки\ntext\n';
    const tailB = '— [Cervantes #8](https://kanban.example/?board=b1&card=def)';
    const lineB = `- 2026-10-12 ✅ Карточка закрыта: «Other» ${tailB}`;
    const twice = ctx.withClosedLine(ctx.withClosedLine(note, entry, NOW)!, { line: lineB, tail: tailB }, NOW);
    expect(twice).toBe(`\`\`\`npm ci\`\`\` — сначала\n\n## Канбан\n- 2026-10-01 ✅ old\n${line}\n${lineB}\n\n## Заметки\ntext\n`);
  });

  it('a heading indented 4+ spaces is code, not the section', () => {
    expect(ctx.withClosedLine('    ## Канбан\n', entry, NOW)).toBe(`    ## Канбан\n\n## Канбан\n${line}\n`);
    expect(ctx.withClosedLine('   ## Канбан\n', entry, NOW)).toBe(`   ## Канбан\n${line}\n`);
  });

  it('keeps every existing line ending in a mixed LF/CRLF note', () => {
    expect(ctx.withClosedLine('a\nb\r\nc\n', entry, NOW)).toBe(`a\nb\r\nc\n\r\n## Канбан\r\n${line}\r\n`);
    expect(ctx.withClosedLine('## Канбан\r\n- old\nrest', entry, NOW)).toBe(`## Канбан\r\n- old\nrest\r\n${line}`);
    expect(ctx.withClosedLine("---\r\nupdated: '2026-10-10'\r\n---\nbody\n", entry, NOW))
      .toBe(`---\r\nupdated: '2026-10-12'\r\n---\nbody\n\r\n## Канбан\r\n${line}\r\n`);
  });

  it('changes nothing when the note already has the line, and keeps CRLF', () => {
    const once = ctx.withClosedLine('a\r\nb\r\n', entry, NOW)!;
    expect(once).toBe(`a\r\nb\r\n\r\n## Канбан\r\n${line}\r\n`);
    expect(ctx.withClosedLine(once, entry, NOW)).toBeNull();
  });

  it('builds the line with the card link and a shortened title', () => {
    const long = 'x'.repeat(200);
    const built = ctx.closedEntry({ id: 'abc', board_id: 'b1', seq_id: 7, title: `⚪  ${long}` }, 'Cervantes', DATE, PUBLIC_URL).line;
    expect(built).toMatch(/^- 2026-10-12 ✅ Карточка закрыта: «⚪ x+…» — \[Cervantes #7\]\(https:\/\/kanban\.example\/\?board=b1&card=abc\)$/);
    expect(built.length).toBeLessThan(220);
    const emoji = ctx.closedEntry({ id: 'abc', board_id: 'b1', seq_id: 7, title: '😀'.repeat(150) }, 'Cervantes', DATE, undefined).line;
    expect(emoji).not.toContain('\uFFFD');
    expect(emoji).toContain(`«${'😀'.repeat(119)}…»`);
    expect(ctx.closedEntry({ id: 'abc', board_id: 'b1', seq_id: null, title: 'T' }, 'Cervantes', DATE, undefined))
      .toEqual({ line: '- 2026-10-12 ✅ Карточка закрыта: «T» — Cervantes (abc)', tail: '— Cervantes (abc)' });
  });

  it('keeps one line per card: a later close replaces the earlier line, other cards stay', () => {
    const other = '- 2026-10-01 ✅ Карточка закрыта: «Other» — [Cervantes #8](https://kanban.example/?board=b1&card=def)';
    const note = `---\nupdated: '2026-10-01'\n---\n## Канбан\n- 2026-10-01 ✅ Карточка закрыта: «Pay (old title)» ${tail}\n${other}\n`;
    expect(ctx.withClosedLine(note, entry, NOW)).toBe(`---\nupdated: '2026-10-12'\n---\n## Канбан\n${line}\n${other}\n`);
  });

  it('without a public URL two cards with no number still get separate lines', () => {
    const a = ctx.closedEntry({ id: 'c1', board_id: 'b1', seq_id: null, title: 'A' }, 'Cervantes', '2026-10-01', undefined);
    const b = ctx.closedEntry({ id: 'c2', board_id: 'b1', seq_id: null, title: 'B' }, 'Cervantes', DATE, undefined);
    const note = `## Канбан\n${a.line}\n`;
    expect(ctx.withClosedLine(note, b, NOW)).toBe(`## Канбан\n${a.line}\n${b.line}\n`);
  });

  it('keeps the indent of a replaced line and folds older duplicates of the same card', () => {
    const old1 = `  - 2026-10-01 ✅ Карточка закрыта: «Pay» ${tail}`;
    const old2 = `- 2026-10-05 ✅ Карточка закрыта: «Pay» ${tail}`;
    const other = '- 2026-10-02 ✅ Карточка закрыта: «Other» — [Cervantes #8](https://kanban.example/?board=b1&card=def)';
    expect(ctx.withClosedLine(`## Канбан\n${old1}\n${other}\n${old2}\n`, entry, NOW)).toBe(`## Канбан\n  ${line}\n${other}\n`);
    expect(ctx.withClosedLine(`## Канбан\n${line}\n${old2}\n`, entry, NOW)).toBe(`## Канбан\n${line}\n`);
  });

  it('keeps quotes when a quoted updated: value contains #', () => {
    expect(ctx.withClosedLine('---\nupdated: "2026-10-10 #x" # note\n---\nb\n', entry, NOW)).toContain('\nupdated: "2026-10-12" # note\n');
  });

  it('keeps the time and the comment of a datetime updated:', () => {
    const note = '---\nupdated: 2026-10-10T09:00 # by hand\n---\nb\n';
    expect(ctx.withClosedLine(note, entry, NOW)).toContain(`\nupdated: ${ctx.localDateTime(NOW)} # by hand\n`);
    expect(ctx.localDateTime(NOW)).toMatch(/^2026-10-12T12:00:00[+-]\d{2}:\d{2}$/);
  });

  it('quotes the title: no live [[links]] or #tags', () => {
    const { line: quoted } = ctx.closedEntry({ id: 'abc', board_id: 'b1', seq_id: 7, title: '#urgent see [[Note]] and c# code' }, 'Cervantes', DATE, undefined);
    expect(quoted).toBe('- 2026-10-12 ✅ Карточка закрыта: «\\#urgent see \\[\\[Note]] and c# code» — Cervantes #7 (abc)');
  });
});

describe('closing a card updates its context notes', () => {
  beforeEach(async () => {
    vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-ctx-'));
    const { createTestDb } = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
    testDb = createTestDb();
    ctx.startObsidianContext();
  });

  afterEach(() => {
    ctx.stopObsidianContext();
    if (testDb.open) testDb.close();
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('updates linked notes and backlinking notes, leaves the rest alone, and comments on the card', async () => {
    const cardLink = `${PUBLIC_URL}/?board=b1&card=c1`;
    writeNote('Property/Андрей — счета.md', "---\ntitle: Андрей\nupdated: '2026-10-10'\n---\n# Андрей\n");
    writeNote('Notes/Backlink.md', `Карточка: ${cardLink}\n`);
    writeNote('Business/VS/Tasks VS_old-vault.md', '- [ ] Task c1 <!-- kb:id=c1 -->\n');
    writeNote('Notes/Other card.md', `${PUBLIC_URL}/?board=b1&card=zz\n`);
    writeNote('Notes/Wrong board.md', `${PUBLIC_URL}/?board=b2&card=c1\n`);
    writeNote('Tasks/Board.md', `- [x] Task c1 ${cardLink} <!-- kb:id=c1 -->\n`);
    writeNote('.trash/Old.md', `${cardLink}\n`);
    const untouched = ['Business/VS/Tasks VS_old-vault.md', 'Notes/Other card.md', 'Notes/Wrong board.md', 'Tasks/Board.md', '.trash/Old.md']
      .map((rel) => [rel, readNote(rel)] as const);

    seedCard('c1', {
      title: 'Оплатить счета',
      description: 'Детали в [[Missing note]] и [[Tasks/Board]]',
      links: JSON.stringify([{ url: obsidianLink('Property/Андрей — счета', path.basename(vaultRoot)), title: 'note' }]),
    });

    const outcomes = await ctx.updateContextForClosedCards(['c1'], NOW);

    const line = `- ${DATE} ✅ Карточка закрыта: «Оплатить счета» — [Cervantes #7](${cardLink})`;
    expect(readNote('Property/Андрей — счета.md')).toBe(`---\ntitle: Андрей\nupdated: '${DATE}'\n---\n# Андрей\n\n## Канбан\n${line}\n`);
    expect(readNote('Notes/Backlink.md')).toBe(`Карточка: ${cardLink}\n\n## Канбан\n${line}\n`);
    for (const [rel, before] of untouched) expect(readNote(rel)).toBe(before);

    expect(outcomes.get('c1')).toEqual({
      updated: ['Notes/Backlink.md', 'Property/Андрей — счета.md'],
      unchanged: [],
      problems: ['заметка «Missing note» не найдена'],
    });
    expect(comments('c1')).toEqual([{
      author: 'obsidian',
      text: 'Obsidian: контекст обновлён — Notes/Backlink.md, Property/Андрей — счета.md\nObsidian: заметка «Missing note» не найдена',
    }]);
  });

  it('is idempotent on the same day and silent for cards without context', async () => {
    writeNote('Note.md', 'body\n');
    seedCard('c1', { description: '[[Note]]' });
    seedCard('c2');

    ctx.notifyCardsClosed(['c1', 'c2']);
    await ctx.obsidianContextIdle();
    const after = readNote('Note.md');
    ctx.notifyCardsClosed(['c1']);
    await ctx.obsidianContextIdle();

    expect(readNote('Note.md')).toBe(after);
    expect(after.match(/Карточка закрыта/g)).toHaveLength(1);
    expect(comments('c1')).toHaveLength(1);
    expect(comments('c2')).toEqual([]);
  });

  it('skips cards that were reopened or trashed before the queue reached them', async () => {
    writeNote('Note.md', 'body\n');
    seedCard('open', { description: '[[Note]]', is_done: 0 });
    seedCard('gone', { description: '[[Note]]' });
    testDb.prepare("UPDATE cards SET deleted_at = datetime('now') WHERE id = 'gone'").run();

    const outcomes = await ctx.updateContextForClosedCards(['open', 'gone'], NOW);

    expect(outcomes.size).toBe(0);
    expect(readNote('Note.md')).toBe('body\n');
  });

  it('writes nothing after stop, even when stop lands during the vault scan and the DB closes', async () => {
    writeNote('Note.md', 'body\n');
    seedCard('c1', { description: '[[Note]]' });

    ctx.notifyCardsClosed(['c1']);
    ctx.stopObsidianContext();
    testDb.close();
    await ctx.obsidianContextIdle();

    expect(readNote('Note.md')).toBe('body\n');
  });

  it('a failing card does not stop the rest of the batch', async () => {
    writeNote('Note.md', 'body\n');
    seedCard('bad', { description: '[[Note]]' });
    seedCard('good', { description: '[[Note]]', title: 'Good' });
    testDb.exec(`CREATE TRIGGER no_bad_comments BEFORE INSERT ON comments WHEN NEW.card_id = 'bad'
      BEGIN SELECT RAISE(ABORT, 'comment rejected'); END`);

    const outcomes = await ctx.updateContextForClosedCards(['bad', 'good'], NOW);

    expect(outcomes.has('bad')).toBe(false);
    expect(outcomes.get('good')?.updated).toEqual(['Note.md']);
    expect(comments('good')).toHaveLength(1);
  });

  it('skips a folder that cannot be read and still finds the rest of the vault', async () => {
    writeNote('Note.md', 'body\n');
    writeNote('Locked/Inner.md', 'x\n');
    chmodSync(path.join(vaultRoot, 'Locked'), 0o000);
    try {
      expect(await ctx.listVaultNotes(vaultRoot)).toEqual(['Note.md']);
    } finally {
      chmodSync(path.join(vaultRoot, 'Locked'), 0o755);
    }
    await expect(ctx.listVaultNotes(path.join(vaultRoot, 'missing'))).rejects.toThrow();
  });

  it('a card link quoted in another card\'s closing line is not a backlink', async () => {
    const quotedLink = `${PUBLIC_URL}/?board=b1&card=c2`;
    writeNote('Note.md', `- 2026-10-01 ✅ Карточка закрыта: «see ${quotedLink} today» — [Cervantes #1](${PUBLIC_URL}/?board=b1&card=c1)\n`);
    const found = await ctx.findBacklinks(vaultRoot, ['Note.md'], [{ id: 'c1', board_id: 'b1' }, { id: 'c2', board_id: 'b1' }], new Set(['kanban.example']));
    expect(found.get('c1')).toEqual(new Set(['Note.md']));
    expect(found.has('c2')).toBe(false);
  });

  it('finds a backlink written as a Markdown link', async () => {
    writeNote('Note.md', `Задача: [карточка](${PUBLIC_URL}/?board=b1&card=c1), детали ниже\n`);
    const found = await ctx.findBacklinks(vaultRoot, ['Note.md'], [{ id: 'c1', board_id: 'b1' }], new Set(['kanban.example']));
    expect(found.get('c1')).toEqual(new Set(['Note.md']));
  });

  it('leaves a note that is not UTF-8 untouched and says so; a BOM survives', async () => {
    writeFileSync(path.join(vaultRoot, 'Latin.md'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    writeFileSync(path.join(vaultRoot, 'Bom.md'), '\uFEFFbody\n', 'utf-8');
    seedCard('c1', { description: '[[Latin]] [[Bom]]' });

    const outcome = (await ctx.updateContextForClosedCards(['c1'], NOW)).get('c1');

    expect(readFileSync(path.join(vaultRoot, 'Latin.md'))).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    expect(outcome?.problems).toEqual(['не удалось обновить «Latin.md»: файл не в UTF-8, не изменён']);
    expect(outcome?.updated).toEqual(['Bom.md']);
    expect(readFileSync(path.join(vaultRoot, 'Bom.md')).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('does not repeat the same problems comment when nothing was written', async () => {
    seedCard('c1', { description: '[[Missing]]' });

    await ctx.updateContextForClosedCards(['c1'], NOW);
    await ctx.updateContextForClosedCards(['c1'], NOW);

    expect(comments('c1')).toEqual([{ author: 'obsidian', text: 'Obsidian: заметка «Missing» не найдена' }]);
  });

  it('a later close moves the date in the same line instead of adding one', async () => {
    writeNote('Note.md', 'body\n');
    seedCard('c1', { description: '[[Note]]' });

    await ctx.updateContextForClosedCards(['c1'], NOW);
    await ctx.updateContextForClosedCards(['c1'], new Date(2026, 9, 14, 9, 0, 0));

    const note = readNote('Note.md');
    expect(note.match(/Карточка закрыта/g)).toHaveLength(1);
    expect(note).toContain('- 2026-10-14 ✅ Карточка закрыта: «Task c1»');
    expect(comments('c1')).toHaveLength(2);
  });

  it('does nothing until started', async () => {
    writeNote('Note.md', 'body\n');
    seedCard('c1', { description: '[[Note]]' });
    ctx.stopObsidianContext();

    ctx.notifyCardsClosed(['c1']);
    await ctx.obsidianContextIdle();

    expect(readNote('Note.md')).toBe('body\n');
  });
});
