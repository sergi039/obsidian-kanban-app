import { readFileSync, writeFileSync as writeFsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

export const PriorityDefSchema = z.object({
  id: z.string().min(1),
  emoji: z.string().min(1),
  label: z.string().min(1),
  color: z.string().min(1),
});

export const CategoryDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be #RRGGBB'),
  showOnCard: z.boolean(),
});

const BoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  file: z.string(),
  columns: z.array(z.string()),
  archived: z.boolean().optional(),
  doneColumns: z.array(z.string()).optional(),
  priorities: z.array(PriorityDefSchema).optional(),
  categories: z.array(CategoryDefSchema).optional(),
});

const ConfigSchema = z.object({
  vaultRoot: z.string(),
  boards: z.array(BoardSchema),
  defaultColumns: z.array(z.string()),
});

export type BoardConfig = z.infer<typeof BoardSchema>;
export type AppConfig = z.infer<typeof ConfigSchema>;
export type PriorityDef = z.infer<typeof PriorityDefSchema>;
export type CategoryDef = z.infer<typeof CategoryDefSchema>;

export const DEFAULT_PRIORITIES: PriorityDef[] = [
  { id: 'urgent', emoji: '🔺', label: 'Urgent', color: '#ef4444' },
  { id: 'high', emoji: '⏫', label: 'High', color: '#f59e0b' },
];

let cached: AppConfig | null = null;

/**
 * Simple synchronous config write guard.
 * Prevents re-entrant writes to config.boards.json.
 */
let configWriteLock = false;

function withConfigWrite<T>(fn: () => T): T {
  if (configWriteLock) {
    throw new Error('Concurrent config write detected — retry');
  }
  configWriteLock = true;
  try {
    return fn();
  } finally {
    configWriteLock = false;
  }
}

export function loadConfig(configPath?: string): AppConfig {
  if (cached) return cached;
  const p = configPath || path.join(PROJECT_ROOT, 'config.boards.json');
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  const config = ConfigSchema.parse(raw);

  // Allow env override for Docker/container deployments
  if (process.env.VAULT_ROOT) {
    config.vaultRoot = process.env.VAULT_ROOT;
  }

  cached = config;
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}

/** Update a board's columns in config file and reset cache */
export function updateBoardColumns(boardId: string, columns: string[]): boolean {
  return withConfigWrite(() => {
    resetConfigCache();
    const p = path.join(PROJECT_ROOT, 'config.boards.json');
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const board = raw.boards?.find((b: { id: string }) => b.id === boardId);
    if (!board) return false;
    board.columns = columns;
    writeFsSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    resetConfigCache();
    return true;
  });
}

/** Add a new board to config file */
export function addBoardToConfig(board: {
  id: string;
  name: string;
  file: string;
  columns: string[];
  priorities?: PriorityDef[];
}): boolean {
  return withConfigWrite(() => {
    resetConfigCache();
    const p = path.join(PROJECT_ROOT, 'config.boards.json');
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    if (raw.boards?.find((b: { id: string }) => b.id === board.id)) return false; // already exists
    raw.boards.push(board);
    writeFsSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    resetConfigCache();
    return true;
  });
}

/** Update a board's properties in config file */
export function updateBoardInConfig(
  boardId: string,
  patch: Partial<{ name: string; archived: boolean; priorities: PriorityDef[]; categories: CategoryDef[] }>,
): boolean {
  return withConfigWrite(() => {
    resetConfigCache();
    const p = path.join(PROJECT_ROOT, 'config.boards.json');
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const board = raw.boards?.find((b: { id: string }) => b.id === boardId);
    if (!board) return false;
    if (patch.name !== undefined) board.name = patch.name;
    if (patch.archived !== undefined) board.archived = patch.archived;
    if (patch.priorities !== undefined) board.priorities = patch.priorities;
    if (patch.categories !== undefined) board.categories = patch.categories;
    writeFsSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    resetConfigCache();
    return true;
  });
}

/** Delete a board from config (does NOT delete .md file) */
export function deleteBoardFromConfig(boardId: string): boolean {
  return withConfigWrite(() => {
    resetConfigCache();
    const p = path.join(PROJECT_ROOT, 'config.boards.json');
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const idx = raw.boards?.findIndex((b: { id: string }) => b.id === boardId);
    if (idx === undefined || idx === -1) return false;
    raw.boards.splice(idx, 1);
    writeFsSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    resetConfigCache();
    return true;
  });
}

/** Update a board's priorities in config file and reset cache */
export function updateBoardPriorities(boardId: string, priorities: PriorityDef[]): boolean {
  return withConfigWrite(() => {
    resetConfigCache();
    const p = path.join(PROJECT_ROOT, 'config.boards.json');
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const board = raw.boards?.find((b: { id: string }) => b.id === boardId);
    if (!board) return false;
    board.priorities = priorities;
    writeFsSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
    resetConfigCache();
    return true;
  });
}
