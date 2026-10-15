/**
 * Writing a secret (an OAuth refresh token) to disk.
 *
 * writeFileAtomic already makes the replacement atomic and owner-only from the first
 * byte. A secret also needs a directory nobody else can touch: a user who can add or
 * remove entries in the directory (through mode bits or an ACL) can swap the
 * temporary file before the rename, and an inherited ACL can hand the new file to
 * someone else. assertPrivateDirectory refuses such a directory, naming the path,
 * before anything is written. Config files keep writeFileAtomic alone.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './config.js';

/** macOS ACL rights that let a principal add, remove or rewrite entries or attributes. */
const MAC_WRITE_RIGHTS = new Set([
  'write', 'append', 'add_file', 'add_subdirectory', 'delete', 'delete_child',
  'writeattr', 'writeextattr', 'writesecurity', 'chown',
]);
const MAC_ACE_RE = /^\s*\d+: (user|group):(\S+) (?:inherited )?(allow|deny) (\S+)$/;

export interface PrivateDirectoryDeps {
  platform?: NodeJS.Platform;
  uid?: number;
  username?: string;
  /** ACL lines of one path: `ls -led` output on macOS, `getfacl` output elsewhere. */
  aclOf?: (target: string) => string[];
}

function ancestorsOf(dir: string): string[] {
  const chain = [dir];
  for (let current = dir; path.dirname(current) !== current; current = path.dirname(current)) {
    chain.push(path.dirname(current));
  }
  return chain;
}

function macAcl(target: string): string[] {
  return execFileSync('/bin/ls', ['-led', target], { encoding: 'utf-8' }).split('\n').slice(1).filter((line) => line.trim());
}

function posixAcl(target: string): string[] {
  return execFileSync('getfacl', ['--absolute-names', '--omit-header', target], { encoding: 'utf-8' })
    .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

/** Why a macOS ACL makes `target` unsafe, or null. `isDir` = the secret's own directory. */
export function macAclProblem(lines: string[], username: string, isDir: boolean): string | null {
  for (const line of lines) {
    const ace = MAC_ACE_RE.exec(line);
    if (!ace) return `unreadable ACL entry "${line.trim()}"`;
    const [, kind, name, verdict, rights] = ace;
    if (verdict !== 'allow' || (kind === 'user' && name === username)) continue;
    const granted = rights.split(',');
    if (isDir) return `ACL grants ${kind} ${name} access (${rights})`;
    if (granted.some((right) => MAC_WRITE_RIGHTS.has(right))) return `ACL lets ${kind} ${name} change entries (${rights})`;
  }
  return null;
}

/** Why a POSIX ACL (getfacl output) makes `target` unsafe, or null. */
export function posixAclProblem(lines: string[]): string | null {
  for (const line of lines) {
    if (line.startsWith('default:')) return `default ACL "${line}"`;
    const [tag, qualifier, perms = ''] = line.split(':');
    const named = (tag === 'user' || tag === 'group') && qualifier !== '';
    if ((named || tag === 'mask' || tag === 'other') && perms.includes('w')) return `ACL entry "${line}" grants write`;
  }
  return null;
}

/**
 * Refuse a directory whose entries anyone but the owner (or root) could add, remove
 * or read through: a symlink in the path, a group/other write bit or a foreign owner on
 * the directory or any ancestor, or an ACL that grants such access. Throws naming the path.
 */
export function assertPrivateDirectory(dir: string, deps: PrivateDirectoryDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  const username = deps.username ?? os.userInfo().username;
  const aclOf = deps.aclOf ?? (platform === 'darwin' ? macAcl : posixAcl);

  const resolved = realpathSync(dir);
  if (resolved !== dir) throw new Error(`${dir} goes through a symbolic link (${resolved}); refusing to keep a secret there`);

  for (const target of ancestorsOf(dir)) {
    const stat = statSync(target);
    if (stat.uid !== uid && stat.uid !== 0) throw new Error(`${target} belongs to another user; refusing to keep a secret under it`);
    if (stat.mode & 0o022) throw new Error(`${target} is writable by group or others; refusing to keep a secret under it`);
    let lines: string[];
    try {
      lines = aclOf(target);
    } catch (err) {
      throw new Error(`cannot read the ACL of ${target} (${err instanceof Error ? err.message : String(err)}); refusing to keep a secret under it`);
    }
    const problem = platform === 'darwin' ? macAclProblem(lines, username, target === dir) : posixAclProblem(lines);
    if (problem) throw new Error(`${target}: ${problem}; refusing to keep a secret under it`);
  }
}

/** writeFileAtomic for a secret: the directory is checked first, the file is owner-only. */
export function writeSecretFileAtomic(target: string, content: string, deps: PrivateDirectoryDeps = {}): void {
  assertPrivateDirectory(path.dirname(target), deps);
  writeFileAtomic(target, content);
}
