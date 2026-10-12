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
  showOnCard: z.boolean().optional().default(true),
});

export const CategoryDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be #RRGGBB'),
  showOnCard: z.boolean(),
});

/** Microsoft Graph app-only access; the env file holds M365_TENANT_ID / M365_CLIENT_ID / M365_CLIENT_SECRET. */
const GraphCredentialsSchema = z.object({
  type: z.literal('graph-app'),
  envFile: z.string().min(1),
});

/** Google OAuth: client id/secret from an env file, the owner's refresh token from an owner-only file. */
const GoogleCredentialsSchema = z.object({
  type: z.literal('google-oauth'),
  clientEnvFile: z.string().min(1),
  tokenFile: z.string().min(1),
});

/** A calendar the owner works in; emails and credential paths live only in the gitignored config. */
export const CalendarAccountSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'Calendar account id must be lowercase letters, digits or dashes'),
  label: z.string().trim().min(1).max(40),
  provider: z.enum(['google', 'outlook']),
  email: z.string().email(),
  /** How the server reads this calendar; absent = events cannot be synced for this account. */
  credentials: z.discriminatedUnion('type', [GraphCredentialsSchema, GoogleCredentialsSchema]).optional(),
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
  /** Default calendar account id for events and "new event" links on this board. */
  calendarAccount: z.string().optional(),
});

export const ConfigSchema = z.object({
  vaultRoot: z.string(),
  boards: z.array(BoardSchema),
  defaultColumns: z.array(z.string()),
  calendarAccounts: z.array(CalendarAccountSchema).optional(),
  /** Public base URL of this Kanban (card links written into calendar events). */
  publicUrl: z.string().url().optional(),
}).superRefine((config, ctx) => {
  const accountIds = new Set<string>();
  (config.calendarAccounts ?? []).forEach((account, i) => {
    if (accountIds.has(account.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['calendarAccounts'], message: `Duplicate calendar account id "${account.id}"` });
    }
    accountIds.add(account.id);
    const expected = account.provider === 'outlook' ? 'graph-app' : 'google-oauth';
    if (account.credentials && account.credentials.type !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['calendarAccounts', i, 'credentials'],
        message: `Calendar account "${account.id}" (${account.provider}) needs ${expected} credentials`,
      });
    }
  });
  config.boards.forEach((board, i) => {
    if (board.calendarAccount !== undefined && !accountIds.has(board.calendarAccount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boards', i, 'calendarAccount'],
        message: `Board "${board.id}" references unknown calendar account "${board.calendarAccount}"`,
      });
    }
  });
});

export type BoardConfig = z.infer<typeof BoardSchema>;
export type AppConfig = z.infer<typeof ConfigSchema>;
export type PriorityDef = z.infer<typeof PriorityDefSchema>;
export type CategoryDef = z.infer<typeof CategoryDefSchema>;
export type CalendarAccount = z.infer<typeof CalendarAccountSchema>;

export const DEFAULT_PRIORITIES: PriorityDef[] = [
  { id: 'urgent', emoji: '🔺', label: 'Urgent', color: '#ef4444', showOnCard: true },
  { id: 'high', emoji: '⏫', label: 'High', color: '#f59e0b', showOnCard: true },
  { id: 'normal', emoji: '🟦', label: 'Normal', color: '#3b82f6', showOnCard: true },
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
