import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import nodePty from 'node-pty';
import type { IPty } from 'node-pty';
import type { Terminal } from '@xterm/headless';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { captureHistory, createHeadless, type SavedHistory } from './history.ts';
import { formatTitle, parseOsc7, programName, shellCwd } from './cwd.ts';
import { WaitingTracker } from './waiting.ts';

export interface ThreadOptions {
  id: string;
  cwd: string;
  shell: string;
  args: string[];
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
  prefix: string;
  cwdLookup?: (pid: number) => Promise<string | null>;
}

const EXITED = '\r\n\x1b[2m── shell exited, press Enter to restart ──\x1b[0m\r\n';
const LOOKUP_INTERVAL_MS = 1000;
const AFTER_ENTER_MS = 150;

export class Thread {
  readonly id: string;
  readonly waiting = new WaitingTracker();
  dirty = false;

  private readonly opts: ThreadOptions;
  private readonly term: Terminal;
  private readonly serializer: SerializeAddon;
  private readonly lookup: (pid: number) => Promise<string | null>;
  private readonly dataListeners: ((seq: number, data: string) => void)[] = [];
  private readonly titleListeners: ((title: string) => void)[] = [];
  private pty: IPty | null = null;
  private seq = 0;
  private disposed = false;

  // Title state. Refreshes are event-driven (output, Enter); at most one runs and one waits.
  private program = '';
  private shellName: string | null = null;
  private osc7Dir: string | null = null;
  private lookedUpDir: string | null = null;
  private lastLookup = -Infinity;
  private currentTitle = '';
  private refreshing = false;
  private refreshPending = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ThreadOptions) {
    this.id = opts.id;
    this.opts = opts;
    this.lookup = opts.cwdLookup ?? shellCwd;
    ({ term: this.term, serializer: this.serializer } = createHeadless(opts.cols, opts.rows));
    this.term.parser.registerOscHandler(7, (data) => {
      const dir = parseOsc7(data);
      if (dir) this.osc7Dir = dir;
      return true;
    });
    if (opts.prefix) this.term.write(opts.prefix);
    this.spawn(opts.cwd);
  }

  get lastDir(): string | null {
    return this.osc7Dir ?? this.lookedUpDir;
  }

  get title(): string {
    return this.currentTitle;
  }

  get fullScreen(): boolean {
    return this.term.buffer.active.type === 'alternate';
  }

  // A full-screen program draws on the alternate screen, so clearing there would leave the normal
  // scrollback (where the output to clear lives) untouched; refuse instead.
  clearHistory(): boolean {
    if (this.fullScreen) return false;
    this.term.clear();
    this.dirty = true;
    return true;
  }

  onData(l: (seq: number, data: string) => void): void {
    this.dataListeners.push(l);
  }

  onTitle(l: (title: string) => void): void {
    this.titleListeners.push(l);
  }

  write(input: string): void {
    if (!this.pty) {
      if (input.includes('\r') && !this.disposed) {
        const dir = this.lastDir;
        this.spawn(dir && existsSync(dir) ? dir : this.opts.cwd);
      }
      return;
    }
    this.pty.write(input);
    if (input.includes('\r')) this.scheduleRefresh(AFTER_ENTER_MS);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
    this.pty?.resize(cols, rows);
  }

  pause(): void {
    this.pty?.pause();
  }

  resume(): void {
    this.pty?.resume();
  }

  // The '' write's callback runs once every earlier chunk is parsed, so the buffer matches `seq`.
  snapshot(): Promise<{ seq: number; data: string }> {
    const seq = this.seq;
    return new Promise((resolve) => this.term.write('', () => resolve({ seq, data: this.serializer.serialize() })));
  }

  capture(): Promise<SavedHistory> {
    return new Promise((resolve) => this.term.write('', () => resolve(captureHistory(this.term, this.serializer))));
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const pty = this.pty;
    this.pty = null;
    pty?.kill();
    this.term.dispose();
  }

  private spawn(cwd: string): void {
    const { shell, args, env, cols, rows } = this.opts;
    const pty = nodePty.spawn(shell, args, { name: 'xterm-256color', cwd, env, cols: this.term.cols || cols, rows: this.term.rows || rows });
    this.pty = pty;
    pty.onData((data) => this.emit(data));
    pty.onExit(() => {
      if (this.pty !== pty) return;
      this.pty = null;
      if (!this.disposed) this.emit(EXITED);
    });
  }

  private emit(data: string): void {
    const seq = ++this.seq;
    this.term.write(data);
    this.dirty = true;
    this.waiting.output(Date.now());
    for (const l of this.dataListeners) l(seq, data);
    if (this.pty) this.requestRefresh();
  }

  private scheduleRefresh(delay: number): void {
    if (this.refreshTimer || this.disposed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.requestRefresh();
    }, delay);
  }

  private requestRefresh(): void {
    if (this.refreshing) {
      this.refreshPending = true;
      return;
    }
    this.refreshing = true;
    void this.refresh().finally(() => {
      this.refreshing = false;
      if (this.refreshPending && !this.disposed) {
        this.refreshPending = false;
        this.requestRefresh();
      }
    });
  }

  private async refresh(): Promise<void> {
    const pty = this.pty;
    if (!pty || this.disposed) return;
    this.program = programName(pty.process) ?? this.program;
    // macOS /bin/sh execs bash, so the shell's real name is the first one seen.
    this.shellName ??= this.program;
    const shellInFront = this.program === this.shellName || this.program === basename(this.opts.shell);
    if (shellInFront) {
      const wait = this.lastLookup + LOOKUP_INTERVAL_MS - Date.now();
      if (wait <= 0) {
        this.lastLookup = Date.now();
        const dir = await this.lookup(pty.pid);
        if (dir) this.lookedUpDir = dir;
      } else {
        this.scheduleRefresh(wait);
      }
    }
    const title = formatTitle(this.lastDir, this.program);
    if (title !== this.currentTitle && !this.disposed) {
      this.currentTitle = title;
      for (const l of this.titleListeners) l(title);
    }
  }
}
