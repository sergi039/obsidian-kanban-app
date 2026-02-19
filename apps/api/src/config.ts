import { readFileSync, writeFileSync as writeFsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const BoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  file: z.string(),
  columns: z.array(z.string()),
  archived: z.boolean().optional(),
});

const ConfigSchema = z.object({
  vaultRoot: z.string(),
  boards: z.array(BoardSchema),
  defaultColumns: z.array(z.string()),
});

export type BoardConfig = z.infer<typeof BoardSchema>;
export type AppConfig = z.infer<typeof ConfigSchema>;

let cached: AppConfig | null = null;

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
  resetConfigCache();
  const p = path.join(PROJECT_ROOT, 'config.boards.json');
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  const board = raw.boards?.find((b: { id: string }) => b.id === boardId);
  if (!board) return false;
  board.columns = columns;
  writeFsSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  resetConfigCache();
  return true;
}

/** Add a new board to config file */
export function addBoardToConfig(board: { id: string; name: string; file: string; columns: string[] }): boolean {
  resetConfigCache();
  const p = path.join(PROJECT_ROOT, 'config.boards.json');
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  if (raw.boards?.find((b: { id: string }) => b.id === board.id)) return false; // already exists
  raw.boards.push(board);
  writeFsSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  resetConfigCache();
  return true;
}

/** Update a board's properties in config file */
export function updateBoardInConfig(boardId: string, patch: Partial<{ name: string; archived: boolean }>): boolean {
  resetConfigCache();
  const p = path.join(PROJECT_ROOT, 'config.boards.json');
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  const board = raw.boards?.find((b: { id: string }) => b.id === boardId);
  if (!board) return false;
  if (patch.name !== undefined) board.name = patch.name;
  if (patch.archived !== undefined) board.archived = patch.archived;
  writeFsSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  resetConfigCache();
  return true;
}

/** Delete a board from config (does NOT delete .md file) */
export function deleteBoardFromConfig(boardId: string): boolean {
  resetConfigCache();
  const p = path.join(PROJECT_ROOT, 'config.boards.json');
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  const idx = raw.boards?.findIndex((b: { id: string }) => b.id === boardId);
  if (idx === undefined || idx === -1) return false;
  raw.boards.splice(idx, 1);
  writeFsSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  resetConfigCache();
  return true;
}
