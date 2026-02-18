import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { reconcileBoard } from './reconciler.js';
import { broadcast } from './ws.js';
import type { AppConfig, BoardConfig } from './config.js';

let watcher: FSWatcher | null = null;
let writeBackInProgress = false;

/** Temporarily suppress watcher to avoid feedback loop during write-back */
export function suppressWatcher(): void {
  writeBackInProgress = true;
}

export function unsuppressWatcher(): void {
  // Delay unsuppression to let chokidar debounce settle
  setTimeout(() => {
    writeBackInProgress = false;
  }, 500);
}

export function startWatcher(config: AppConfig): FSWatcher {
  const fileToBoardMap = new Map<string, BoardConfig>();
  const filePaths: string[] = [];

  for (const board of config.boards) {
    const abs = path.join(config.vaultRoot, board.file);
    fileToBoardMap.set(abs, board);
    filePaths.push(abs);
  }

  watcher = watch(filePaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
  });

  watcher.on('change', (filePath) => {
    if (writeBackInProgress) {
      console.log(`[watcher] Suppressed: write-back in progress`);
      return;
    }

    const board = fileToBoardMap.get(filePath);
    if (!board) return;

    try {
      const result = reconcileBoard(board, config.vaultRoot);
      console.log(
        `[watcher] Reconciled ${board.name}: +${result.added} ~${result.updated} -${result.removed}`,
      );

      // Broadcast change to all WebSocket clients
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
