import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_BACKUP_PREFIX,
  backupConfigFile,
  buildMissingConfigMessage,
  findLatestConfigBackup,
  listConfigBackups,
  rotateLogIfOversized,
} from '../src/boot-resilience.js';

let dir: string;
let configPath: string;
let backupDir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'kanban-boot-'));
  configPath = path.join(dir, 'config.boards.json');
  backupDir = path.join(dir, 'data');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeBackup(ts: string, content: string): string {
  mkdirSync(backupDir, { recursive: true });
  const p = path.join(backupDir, `${CONFIG_BACKUP_PREFIX}${ts}.json`);
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('backupConfigFile', () => {
  it('copies the config into the backup dir and returns the backup path', () => {
    writeFileSync(configPath, '{"boards":[]}', 'utf-8');

    const backupPath = backupConfigFile(configPath, backupDir);

    expect(backupPath).not.toBeNull();
    expect(path.basename(backupPath!)).toMatch(/^config\.boards\.backup-.+\.json$/);
    expect(readFileSync(backupPath!, 'utf-8')).toBe('{"boards":[]}');
  });

  it('returns null when the config file is missing', () => {
    expect(backupConfigFile(configPath, backupDir)).toBeNull();
    expect(existsSync(backupDir)).toBe(false);
  });

  it('skips the backup when content matches the latest backup', () => {
    writeFileSync(configPath, '{"boards":[1]}', 'utf-8');
    writeBackup('2026-01-01T00-00-00', '{"boards":[1]}');

    expect(backupConfigFile(configPath, backupDir)).toBeNull();
    expect(listConfigBackups(backupDir)).toHaveLength(1);
  });

  it('prunes to the most recent backups, keeping the new one', () => {
    writeFileSync(configPath, '{"boards":[4]}', 'utf-8');
    writeBackup('2026-01-01T00-00-00', '{"boards":[1]}');
    writeBackup('2026-01-02T00-00-00', '{"boards":[2]}');
    writeBackup('2026-01-03T00-00-00', '{"boards":[3]}');

    const backupPath = backupConfigFile(configPath, backupDir, 3);

    const remaining = listConfigBackups(backupDir);
    expect(remaining).toHaveLength(3);
    expect(remaining[0]).toBe(path.basename(backupPath!));
    expect(remaining).not.toContain(`${CONFIG_BACKUP_PREFIX}2026-01-01T00-00-00.json`);
  });
});

describe('findLatestConfigBackup', () => {
  it('returns null when the backup dir does not exist', () => {
    expect(findLatestConfigBackup(backupDir)).toBeNull();
  });

  it('returns the newest backup by timestamp', () => {
    writeBackup('2026-01-01T00-00-00', 'a');
    const newest = writeBackup('2026-02-01T00-00-00', 'b');

    expect(findLatestConfigBackup(backupDir)).toBe(newest);
  });

  it('ignores unrelated files in the backup dir', () => {
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, 'kanban.backup-2026-01-01.db'), 'db', 'utf-8');

    expect(findLatestConfigBackup(backupDir)).toBeNull();
  });
});

describe('buildMissingConfigMessage', () => {
  const examplePath = '/repo/config.boards.example.json';

  it('names the latest backup and the example config', () => {
    const backup = writeBackup('2026-03-01T00-00-00', '{}');

    const msg = buildMissingConfigMessage({ configPath, backupDir, examplePath });

    expect(msg).toContain(`config file not found: ${configPath}`);
    expect(msg).toContain(backup);
    expect(msg).toContain(examplePath);
  });

  it('says no backups exist when the dir is empty', () => {
    const msg = buildMissingConfigMessage({ configPath, backupDir, examplePath });

    expect(msg).toContain(`No config backups found in ${backupDir}`);
    expect(msg).toContain(examplePath);
  });
});

describe('rotateLogIfOversized', () => {
  it('leaves small or missing logs untouched', () => {
    const logPath = path.join(dir, 'api.stderr.log');
    expect(rotateLogIfOversized(logPath, 100)).toBe(false);

    writeFileSync(logPath, 'short', 'utf-8');
    expect(rotateLogIfOversized(logPath, 100)).toBe(false);
    expect(readFileSync(logPath, 'utf-8')).toBe('short');
  });

  it('copies an oversized log to <file>.1 and truncates the original', () => {
    const logPath = path.join(dir, 'api.stderr.log');
    const content = 'x'.repeat(200);
    writeFileSync(logPath, content, 'utf-8');

    expect(rotateLogIfOversized(logPath, 100)).toBe(true);
    expect(statSync(logPath).size).toBe(0);
    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe(content);
  });
});
