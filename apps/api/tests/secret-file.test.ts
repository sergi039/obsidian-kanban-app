import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPrivateDirectory, macAclProblem, posixAclProblem, writeSecretFileAtomic } from '../src/secret-file.js';

const noAcl = { aclOf: () => [] as string[] };
let root: string;
let dir: string;

describe('assertPrivateDirectory', () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'kanban-secret-')));
    dir = path.join(root, 'tokens');
    mkdirSync(dir, { mode: 0o700 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts an owner-only directory without foreign ACL entries', () => {
    expect(() => assertPrivateDirectory(dir, noAcl)).not.toThrow();
  });

  it('refuses a directory that group or others can write', () => {
    chmodSync(dir, 0o770);
    expect(() => assertPrivateDirectory(dir, noAcl)).toThrow(`${dir} is writable by group or others`);
  });

  it('refuses a path that goes through a symbolic link', () => {
    const link = path.join(root, 'link');
    symlinkSync(dir, link);
    expect(() => assertPrivateDirectory(link, noAcl)).toThrow(/symbolic link/);
  });

  it('refuses a directory owned by another user', () => {
    expect(() => assertPrivateDirectory(dir, { ...noAcl, uid: 424242 })).toThrow(/belongs to another user/);
  });

  it('refuses when the ACL cannot be read (fails closed)', () => {
    expect(() => assertPrivateDirectory(dir, { aclOf: () => { throw new Error('ls failed'); } })).toThrow(/cannot read the ACL/);
  });

  it('refuses an ACL that lets another user add or delete entries, naming the path', () => {
    const aclOf = (target: string) => (target === root ? [' 0: user:mallory allow list,add_file,search,delete_child'] : []);
    expect(() => assertPrivateDirectory(dir, { platform: 'darwin', username: 'owner', aclOf })).toThrow(`${root}: ACL lets user mallory change entries`);
  });

  it('writes a secret owner-only, and writes nothing into an unsafe directory', () => {
    const target = path.join(dir, 'token.json');
    writeSecretFileAtomic(target, '{"refresh_token":"r"}\n', noAcl);
    expect(readFileSync(target, 'utf-8')).toBe('{"refresh_token":"r"}\n');
    expect(statSync(target).mode & 0o777).toBe(0o600);

    chmodSync(dir, 0o777);
    const other = path.join(dir, 'other.json');
    expect(() => writeSecretFileAtomic(other, '{}', noAcl)).toThrow(/writable by group or others/);
    expect(existsSync(other)).toBe(false);
    expect(readdirSync(dir)).toEqual(['token.json']);
    chmodSync(dir, 0o700);
  });
});

describe('macAclProblem', () => {
  it.each([
    [['  0: group:everyone deny delete'], false, null],
    [['  0: user:owner allow list,add_file,delete_child'], true, null],
    [['  0: group:staff allow list,search,readattr'], false, null],
    [['  0: group:staff allow list,search'], true, 'ACL grants group staff access (list,search)'],
    [['  0: user:mallory inherited allow read,file_inherit'], true, 'ACL grants user mallory access (read,file_inherit)'],
    [['  0: user:mallory allow writeattr'], false, 'ACL lets user mallory change entries (writeattr)'],
    [['  0: ABCDEFAB-0000-0000-0000-000000000000 allow read'], false, 'unreadable ACL entry "0: ABCDEFAB-0000-0000-0000-000000000000 allow read"'],
  ])('%j (secret dir: %s)', (lines, isDir, expected) => {
    expect(macAclProblem(lines, 'owner', isDir)).toBe(expected);
  });
});

describe('posixAclProblem', () => {
  it.each([
    [['user::rwx', 'group::r-x', 'other::r-x'], null],
    [['user::rwx', 'user:mallory:rwx', 'mask::rwx', 'group::r-x', 'other::---'], 'ACL entry "user:mallory:rwx" grants write'],
    [['user::rwx', 'group::---', 'other::---', 'default:user::rwx'], 'default ACL "default:user::rwx"'],
    [['user::rwx', 'group:dev:r--', 'mask::r--', 'other::---'], null],
  ])('%j', (lines, expected) => {
    expect(posixAclProblem(lines)).toBe(expected);
  });
});
