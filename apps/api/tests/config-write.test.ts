import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Real fs, with fsync/rename wrapped so a test can make one call fail midway.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: vi.fn((...args: Parameters<typeof actual.fsyncSync>) => actual.fsyncSync(...args)),
    renameSync: vi.fn((...args: Parameters<typeof actual.renameSync>) => actual.renameSync(...args)),
  };
});

const CONFIG = {
  vaultRoot: '/vault',
  defaultColumns: ['Backlog', 'Done'],
  calendarAccounts: [{ id: 'work', label: 'Work', provider: 'outlook', email: 'owner@example.com' }],
  boards: [{ id: 'b1', name: 'Board', file: 'Board.md', columns: ['Backlog', 'Done'], calendarAccount: 'work' }],
};

let dir: string;
let file: string;
let original: string;

function leftovers(): string[] {
  return readdirSync(dir).filter((name) => name !== 'config.boards.json');
}

describe('config writes', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kanban-config-'));
    file = path.join(dir, 'config.boards.json');
    original = JSON.stringify(CONFIG, null, 2) + '\n';
    writeFileSync(file, original, { mode: 0o600 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies a change, keeps the file owner-only, and leaves no temporary file', async () => {
    const { mutateConfig } = await import('../src/config.js');
    expect(mutateConfig((raw) => { raw.boards![0].columns = ['Inbox', 'Done']; return true; }, file)).toBe(true);

    expect(JSON.parse(readFileSync(file, 'utf-8')).boards[0].columns).toEqual(['Inbox', 'Done']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(leftovers()).toEqual([]);
  });

  it('writes nothing when the change has nothing to do', async () => {
    const { mutateConfig } = await import('../src/config.js');
    expect(mutateConfig(() => false, file)).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe(original);
  });

  it.each(['fsyncSync', 'renameSync'] as const)('keeps the previous config intact when %s fails midway', async (call) => {
    const fs = await import('node:fs');
    vi.mocked(fs[call]).mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); });
    const { mutateConfig } = await import('../src/config.js');

    expect(() => mutateConfig((raw) => { raw.boards![0].name = 'Renamed'; return true; }, file)).toThrow(/ENOSPC/);
    expect(readFileSync(file, 'utf-8')).toBe(original);
    expect(leftovers()).toEqual([]);
  });

  it('rejects a change the server could not boot with, and writes nothing', async () => {
    const { mutateConfig } = await import('../src/config.js');
    expect(() => mutateConfig((raw) => { raw.boards![0].calendarAccount = 'missing'; return true; }, file))
      .toThrow(/config change rejected: boards\.0\.calendarAccount/);
    expect(readFileSync(file, 'utf-8')).toBe(original);
  });

  it('refuses to replace a symbolic link', async () => {
    const real = path.join(dir, 'real.json');
    writeFileSync(real, original);
    rmSync(file);
    symlinkSync(real, file);
    const { writeFileAtomic } = await import('../src/config.js');

    expect(() => writeFileAtomic(file, '{}')).toThrow(/symbolic link/);
    expect(readFileSync(real, 'utf-8')).toBe(original);
    expect(leftovers().sort()).toEqual(['real.json']);
  });

  it('a second writer inside a running write is refused, not interleaved', async () => {
    const { mutateConfig } = await import('../src/config.js');
    expect(() => mutateConfig(() => {
      mutateConfig(() => true, file);
      return true;
    }, file)).toThrow(/Concurrent config write/);
    expect(readFileSync(file, 'utf-8')).toBe(original);
  });
});

describe('config location (KANBAN_CONFIG_PATH)', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kanban-config-'));
    file = path.join(dir, 'config.boards.json');
    original = JSON.stringify(CONFIG, null, 2) + '\n';
    writeFileSync(file, original, { mode: 0o600 });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    (await import('../src/config.js')).resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is the repository root when the variable is not set', async () => {
    vi.stubEnv('KANBAN_CONFIG_PATH', '');
    const { configFilePath, PROJECT_ROOT } = await import('../src/config.js');
    expect(configFilePath()).toBe(path.join(PROJECT_ROOT, 'config.boards.json'));
  });

  it('reads and changes the file the variable names, without a path argument', async () => {
    vi.stubEnv('KANBAN_CONFIG_PATH', file);
    const { configFilePath, loadConfig, mutateConfig, resetConfigCache } = await import('../src/config.js');
    resetConfigCache();

    expect(configFilePath()).toBe(file);
    expect(loadConfig().boards[0].name).toBe('Board');
    expect(mutateConfig((raw) => { raw.boards![0].name = 'Renamed'; return true; })).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8')).boards[0].name).toBe('Renamed');
    expect(leftovers()).toEqual([]);
  });

  it('resolves a relative path against the working directory', async () => {
    vi.stubEnv('KANBAN_CONFIG_PATH', 'conf/boards.json');
    const { configFilePath } = await import('../src/config.js');
    expect(configFilePath()).toBe(path.resolve('conf/boards.json'));
  });
});
