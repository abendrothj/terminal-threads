import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { basename } from 'node:path';

const TITLE_PART_MAX = 25;

// A shell that ssh-ed elsewhere reports the remote host's folder; only local paths count.
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  const local = hostname().toLowerCase();
  return h === '' || h === 'localhost' || h === local || h === local.split('.')[0];
}

export function parseOsc7(data: string): string | null {
  try {
    const url = new URL(data);
    if (url.protocol !== 'file:' || !isLocalHost(url.hostname)) return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

export function parseLsofCwd(stdout: string): string | null {
  const line = stdout.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

export function shellCwd(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : parseLsofCwd(stdout));
    });
  });
}

const cut = (s: string) => (s.length > TITLE_PART_MAX ? s.slice(0, TITLE_PART_MAX - 1) + '…' : s);

export function formatTitle(folder: string | null, program: string): string {
  return folder ? `${cut(basename(folder) || folder)} — ${cut(program)}` : cut(program);
}
