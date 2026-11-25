import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ThreadManager } from './manager.ts';
import { ThreadStore } from './store.ts';
import { parseViewMsg, type HostMsg, type ViewMsg } from './protocol.ts';

export const VIEW_ID = 'terminalThreads.view';
const BATCH_MS = 8;
const HIGH_WATER = 200_000;
const LOW_WATER = 20_000;

export class ThreadsViewProvider implements vscode.WebviewViewProvider {
  private readonly context: vscode.ExtensionContext;
  private manager: ThreadManager | null = null;
  private ready: Promise<void> | null = null;
  private view: vscode.WebviewView | null = null;
  private selected: string | null = null;
  private size = { cols: 80, rows: 24 };
  private readonly attached = new Set<string>();
  // Sync state for the selected thread: output is held while its snapshot is in flight.
  private syncing = false;
  private held: { seq: number; data: string }[] = [];
  private batch = '';
  private batchSeq = 0;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private unacked = 0;
  private paused = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    context.subscriptions.push(vscode.window.onDidChangeWindowState(() => this.updateWatched()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((raw) => {
      const msg = parseViewMsg(raw);
      if (msg) void this.handle(msg).catch((e) => console.error('terminal-threads:', e));
    });
    view.onDidChangeVisibility(() => this.updateWatched());
    view.onDidDispose(() => {
      this.view = null;
      this.updateWatched();
    });
    this.ready ??= this.init();
  }

  async newThread(): Promise<void> {
    await this.ready;
    if (!this.manager) return;
    await this.select(await this.manager.create());
  }

  // Called from the thread row's right-click menu; `id` comes from its data-vscode-context.
  async renameThread(id: unknown): Promise<void> {
    await this.ready;
    const m = this.manager;
    if (!m || typeof id !== 'string' || !m.get(id)) return;
    const current = m.list().find((t) => t.id === id)?.title ?? '';
    const name = await vscode.window.showInputBox({ value: current, prompt: 'Rename thread (empty restores the live title)' });
    if (name !== undefined) await m.rename(id, name);
  }

  dispose(): Promise<void> {
    return this.manager?.dispose() ?? Promise.resolve();
  }

  private async init(): Promise<void> {
    const storage = this.context.storageUri ?? this.context.globalStorageUri;
    const m = new ThreadManager({
      store: new ThreadStore(storage.fsPath),
      defaultDir: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir(),
      shell: process.env.SHELL ?? '/bin/zsh',
      args: ['-l'],
      env: process.env,
      cols: this.size.cols,
      rows: this.size.rows,
    });
    this.manager = m;
    m.onChange(() => this.postThreads());
    m.onWaiting((id) => void this.notifyWaiting(id));
    await m.restore();
    m.start();
    if (m.list().length === 0) await m.create();
    this.selected = m.list()[0]?.id ?? null;
  }

  private async handle(msg: ViewMsg): Promise<void> {
    await this.ready;
    const m = this.manager;
    if (!m) return;
    if ('id' in msg && !m.get(msg.id)) return;
    switch (msg.type) {
      case 'ready':
        this.size = { cols: msg.cols, rows: msg.rows };
        this.postThreads();
        if (this.selected) await this.select(this.selected);
        break;
      case 'create':
        await this.newThread();
        break;
      case 'select':
        await this.select(msg.id);
        break;
      case 'close':
        await this.close(msg.id);
        break;
      case 'input':
        m.get(msg.id)!.write(msg.data);
        break;
      case 'resize':
        this.size = { cols: msg.cols, rows: msg.rows };
        if (msg.id === this.selected) m.get(msg.id)!.resize(msg.cols, msg.rows);
        break;
      case 'ack':
        if (msg.id === this.selected) this.ack(msg.chars);
        break;
    }
  }

  private async select(id: string): Promise<void> {
    const m = this.manager;
    const t = m?.get(id);
    if (!m || !t) return;
    this.resetFlow();
    this.selected = id;
    this.updateWatched();
    this.postThreads();
    if (!this.attached.has(id)) {
      this.attached.add(id);
      t.onData((seq, data) => this.onThreadData(id, seq, data));
    }
    t.resize(this.size.cols, this.size.rows);
    this.syncing = true;
    const snap = await t.snapshot();
    if (this.selected !== id) return;
    this.post({ type: 'snapshot', id, seq: snap.seq, data: snap.data });
    this.syncing = false;
    for (const h of this.held) if (h.seq > snap.seq) this.queueData(h.seq, h.data);
    this.held = [];
  }

  private async close(id: string): Promise<void> {
    const m = this.manager!;
    const ids = m.list().map((t) => t.id);
    const i = ids.indexOf(id);
    this.attached.delete(id);
    await m.close(id);
    if (this.selected === id) {
      const next = ids[i + 1] ?? ids[i - 1];
      this.selected = null;
      this.resetFlow();
      if (next && next !== id) await this.select(next);
      else this.postThreads();
    }
  }

  private onThreadData(id: string, seq: number, data: string): void {
    if (id !== this.selected) return;
    if (this.syncing) this.held.push({ seq, data });
    else this.queueData(seq, data);
  }

  private queueData(seq: number, data: string): void {
    this.batch += data;
    this.batchSeq = seq;
    this.batchTimer ??= setTimeout(() => this.flush(), BATCH_MS);
  }

  private flush(): void {
    this.batchTimer = null;
    if (!this.selected || !this.batch) return;
    const data = this.batch;
    this.batch = '';
    this.unacked += data.length;
    this.post({ type: 'data', id: this.selected, seq: this.batchSeq, data });
    if (!this.paused && this.unacked > HIGH_WATER) {
      this.paused = true;
      this.manager?.get(this.selected)?.pause();
    }
  }

  private ack(chars: number): void {
    this.unacked = Math.max(0, this.unacked - chars);
    if (this.paused && this.unacked < LOW_WATER && this.selected) {
      this.paused = false;
      this.manager?.get(this.selected)?.resume();
    }
  }

  private resetFlow(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.batch = '';
    this.held = [];
    this.unacked = 0;
    if (this.paused && this.selected) this.manager?.get(this.selected)?.resume();
    this.paused = false;
  }

  private updateWatched(): void {
    const watched = this.view?.visible && vscode.window.state.focused ? this.selected : null;
    this.manager?.setWatched(watched);
  }

  private async notifyWaiting(id: string): Promise<void> {
    if (this.view?.visible && vscode.window.state.focused) return;
    const title = this.manager?.list().find((t) => t.id === id)?.title ?? 'thread';
    const choice = await vscode.window.showInformationMessage(`Terminal thread "${title}" is waiting`, 'Show');
    if (choice !== 'Show') return;
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.select(id);
  }

  private postThreads(): void {
    if (this.manager) this.post({ type: 'threads', threads: this.manager.list(), selected: this.selected });
  }

  private post(msg: HostMsg): void {
    void this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const src = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, f));
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`;
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${src('xterm.css')}">
<link rel="stylesheet" href="${src('webview.css')}">
</head><body>
<ul id="list" role="listbox" aria-label="Terminal threads"></ul>
<p id="empty" hidden>No threads. Use + to start one.</p>
<div id="term"></div>
<script nonce="${nonce}" src="${src('webview.js')}"></script>
</body></html>`;
  }
}
