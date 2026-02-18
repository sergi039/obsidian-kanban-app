import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

// We test the line manipulation logic directly (no DB needed)
const TEMP_DIR = path.join(import.meta.dirname, '__temp_writeback__');
const TEST_FILE = path.join(TEMP_DIR, 'test-tasks.md');

const CHECKBOX_RE = /^(\s*- \[)([ xX])(\] .*)$/;

function setupTestFile(content: string) {
  mkdirSync(TEMP_DIR, { recursive: true });
  writeFileSync(TEST_FILE, content, 'utf-8');
}

function readTestFile(): string {
  return readFileSync(TEST_FILE, 'utf-8');
}

function toggleLine(lines: string[], lineIdx: number, isDone: boolean): boolean {
  const line = lines[lineIdx];
  const match = line.match(CHECKBOX_RE);
  if (!match) return false;
  lines[lineIdx] = `${match[1]}${isDone ? 'x' : ' '}${match[3]}`;
  return true;
}

describe('writeback', () => {
  afterEach(() => {
    try { rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
  });

  it('toggles [ ] to [x] in the file', () => {
    setupTestFile('# Tasks\n- [ ] Buy milk\n- [ ] Walk dog\n');

    const content = readTestFile();
    const lines = content.split('\n');

    expect(toggleLine(lines, 1, true)).toBe(true);
    writeFileSync(TEST_FILE, lines.join('\n'), 'utf-8');

    const updated = readTestFile();
    expect(updated).toContain('- [x] Buy milk');
    expect(updated).toContain('- [ ] Walk dog');
  });

  it('toggles [x] to [ ] in the file', () => {
    setupTestFile('# Tasks\n- [x] Done task\n- [ ] Open task\n');

    const content = readTestFile();
    const lines = content.split('\n');
    const line = lines[1]; // "- [x] Done task"

    const match = line.match(/^(\s*- \[)([ xX])(\] .*)$/);
    expect(match).toBeTruthy();
    expect(match![2]).toBe('x');

    lines[1] = `${match![1]} ${match![3]}`;
    writeFileSync(TEST_FILE, lines.join('\n'), 'utf-8');

    const updated = readTestFile();
    expect(updated).toContain('- [ ] Done task');
    expect(updated).toContain('- [ ] Open task');
  });

  it('preserves other lines when toggling', () => {
    const original = '# My Tasks\n\n- [ ] First\n- [x] Second\n- [ ] Third\n\n## Notes\nSome text\n';
    setupTestFile(original);

    const content = readTestFile();
    const lines = content.split('\n');

    // Toggle line 3 (index 2): "- [ ] First" → "- [x] First"
    const match = lines[2].match(/^(\s*- \[)([ xX])(\] .*)$/);
    expect(match).toBeTruthy();
    lines[2] = `${match![1]}x${match![3]}`;
    writeFileSync(TEST_FILE, lines.join('\n'), 'utf-8');

    const updated = readTestFile();
    expect(updated).toContain('- [x] First');
    expect(updated).toContain('- [x] Second');
    expect(updated).toContain('- [ ] Third');
    expect(updated).toContain('# My Tasks');
    expect(updated).toContain('## Notes');
    expect(updated).toContain('Some text');
  });

  it('handles indented checkboxes', () => {
    setupTestFile('- [ ] Parent\n  - [ ] Child\n');

    const content = readTestFile();
    const lines = content.split('\n');
    const match = lines[1].match(/^(\s*- \[)([ xX])(\] .*)$/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('  - [');

    lines[1] = `${match![1]}x${match![3]}`;
    writeFileSync(TEST_FILE, lines.join('\n'), 'utf-8');

    const updated = readTestFile();
    expect(updated).toContain('  - [x] Child');
    expect(updated).toContain('- [ ] Parent');
  });

  it('does not match non-checkbox lines', () => {
    const line = '## Not a checkbox';
    const match = line.match(/^(\s*- \[)([ xX])(\] .*)$/);
    expect(match).toBeNull();
  });

  it('matches uppercase X', () => {
    const line = '- [X] Done with uppercase';
    const match = line.match(/^(\s*- \[)([ xX])(\] .*)$/);
    expect(match).toBeTruthy();
    expect(match![2]).toBe('X');
  });
});

describe('watcher suppression', () => {
  it('suppress/unsuppress exports exist', async () => {
    const { suppressWatcher, unsuppressWatcher } = await import('../src/watcher.js');
    expect(typeof suppressWatcher).toBe('function');
    expect(typeof unsuppressWatcher).toBe('function');
  });
});

describe('ws broadcast', () => {
  it('broadcast is a function', async () => {
    const { broadcast } = await import('../src/ws.js');
    expect(typeof broadcast).toBe('function');
    // Should not throw when no server
    broadcast({ type: 'board-updated', boardId: 'test', timestamp: new Date().toISOString() });
  });
});
