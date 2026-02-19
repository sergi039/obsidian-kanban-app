import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { reconcileBoard } from './reconciler.js';
import { broadcast } from './ws.js';
import type { AppConfig, BoardConfig } from './config.js';

let watcher: FSWatcher | null = null;

/**
 * Reference-counted suppression to handle overlapping write-backs.
 * Pending file changes during suppression are queued and replayed.
 */
let suppressCount = 0;
let pendingChanges = new Set<string>();

export function suppressWatcher(): void {
  suppressCount++;
}

// Store active config for replay (set by startWatcher)
let activeConfig: AppConfig | null = null;

export function unsuppressWatcher(config?: AppConfig): void {
  suppressCount = Math.max(0, suppressCount - 1);

  const replayConfig = config || activeConfig;
  if (suppressCount === 0 && pendingChanges.size > 0 && replayConfig) {
    // Replay pending changes
    const pending = new Set(pendingChanges);
    pendingChanges.clear();
    setTimeout(() => {
      for (const filePath of pending) {
        const board = fileToBoardMapGlobal.get(filePath);
        if (board && replayConfig) {
          try {
            const result = reconcileBoard(board, replayConfig.vaultRoot);
            console.log(
              `[watcher] Replayed ${board.name}: +${result.added} ~${result.updated} -${result.removed}`,
            );
            broadcast({
              type: 'board-updated',
              boardId: board.id,
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            console.error(`[watcher] Replay error ${board.name}:`, err);
          }
        }
      }
    }, 500);
  }
}

// Global map for replay access
const fileToBoardMapGlobal = new Map<string, BoardConfig>();

export function startWatcher(config: AppConfig): FSWatcher {
  activeConfig = config;
  const filePaths: string[] = [];

  for (const board of config.boards) {
    const abs = path.join(config.vaultRoot, board.file);
    fileToBoardMapGlobal.set(abs, board);
    filePaths.push(abs);
  }

  watcher = watch(filePaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
  });

  watcher.on('change', (filePath) => {
    if (suppressCount > 0) {
      console.log(`[watcher] Queued change during suppression: ${filePath}`);
      pendingChanges.add(filePath);
      return;
    }

    const board = fileToBoardMapGlobal.get(filePath);
    if (!board) return;

    try {
      const result = reconcileBoard(board, config.vaultRoot);
      console.log(
        `[watcher] Reconciled ${board.name}: +${result.added} ~${result.updated} -${result.removed}`,
      );

      broadcast({
        type: 'board-updated',
        boardId: board.id,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[watcher] Error reconciling ${board.name}:`, err);
    }
  });

  console.log(`[watcher] Watching ${filePaths.length} files`);
  return watcher;
}

export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

/**
 * Rebind watcher to reflect changes in board config (board created/deleted).
 * Stops old watcher, clears stale mappings, starts fresh.
 */
export function rebindWatcher(config: AppConfig): void {
  stopWatcher();
  fileToBoardMapGlobal.clear();
  pendingChanges.clear();
  startWatcher(config);
}
