import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { reconcileBoard } from './reconciler.js';
import type { AppConfig, BoardConfig } from './config.js';

let watcher: FSWatcher | null = null;

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
    const board = fileToBoardMap.get(filePath);
    if (!board) return;
    try {
      const result = reconcileBoard(board, config.vaultRoot);
      console.log(
        `[watcher] Reconciled ${board.name}: +${result.added} ~${result.updated} -${result.removed}`,
      );
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
