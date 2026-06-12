import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';

export const CONFIG_BACKUP_PREFIX = 'config.boards.backup-';
export const CONFIG_BACKUP_SUFFIX = '.json';
export const DEFAULT_BACKUPS_TO_KEEP = 3;
export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

/** List config backup filenames in backupDir, newest first. */
export function listConfigBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => f.startsWith(CONFIG_BACKUP_PREFIX) && f.endsWith(CONFIG_BACKUP_SUFFIX))
    .sort()
    .reverse();
}

/** Absolute path of the most recent config backup, or null if none exist. */
export function findLatestConfigBackup(backupDir: string): string | null {
  const [latest] = listConfigBackups(backupDir);
  return latest ? path.join(backupDir, latest) : null;
}

/**
 * Copy the config file into backupDir as config.boards.backup-<ts>.json,
 * pruning to the `keep` most recent backups.
 *
 * Skips the copy when the latest backup already has identical content —
 * otherwise a restart loop would rotate out every older (possibly the only
 * good) backup within seconds.
 *
 * Returns the created backup path, or null if nothing was written.
 */
export function backupConfigFile(
  configPath: string,
  backupDir: string,
  keep = DEFAULT_BACKUPS_TO_KEEP,
): string | null {
  if (!existsSync(configPath)) return null;
  const content = readFileSync(configPath, 'utf-8');

  const latest = findLatestConfigBackup(backupDir);
  if (latest && readFileSync(latest, 'utf-8') === content) return null;

  mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(backupDir, `${CONFIG_BACKUP_PREFIX}${ts}${CONFIG_BACKUP_SUFFIX}`);
  copyFileSync(configPath, backupPath);

  for (const old of listConfigBackups(backupDir).slice(keep)) {
    unlinkSync(path.join(backupDir, old));
  }
  return backupPath;
}

/**
 * Human-readable fatal message for a missing config file, pointing at the
 * latest backup (if any) and the checked-in example config.
 */
export function buildMissingConfigMessage(opts: {
  configPath: string;
  backupDir: string;
  examplePath: string;
}): string {
  const lines = [`[boot] FATAL: config file not found: ${opts.configPath}`];
  const latest = findLatestConfigBackup(opts.backupDir);
  if (latest) {
    lines.push(`[boot] Restore it from the latest backup:`);
    lines.push(`[boot]   cp "${latest}" "${opts.configPath}"`);
  } else {
    lines.push(`[boot] No config backups found in ${opts.backupDir}.`);
  }
  lines.push(`[boot] Or start from the template (then edit vaultRoot and boards):`);
  lines.push(`[boot]   cp "${opts.examplePath}" "${opts.configPath}"`);
  return lines.join('\n');
}

/**
 * Rotate an oversized log file in place: copy its content to `<file>.1` and
 * truncate the original to zero bytes.
 *
 * Truncation (not rename) is required because launchd keeps the
 * StandardOutPath/StandardErrorPath file descriptors open in append mode —
 * after a rename the process would keep writing to the moved inode and the
 * log path would stay empty until the next restart.
 *
 * Returns true if the file was rotated.
 */
export function rotateLogIfOversized(logPath: string, maxBytes = DEFAULT_MAX_LOG_BYTES): boolean {
  if (!existsSync(logPath)) return false;
  if (statSync(logPath).size <= maxBytes) return false;
  copyFileSync(logPath, `${logPath}.1`);
  truncateSync(logPath, 0);
  return true;
}
