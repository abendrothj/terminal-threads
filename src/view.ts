import * as vscode from 'vscode';
import { homedir, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ThreadManager } from './manager.ts';
import { ThreadStore } from './store.ts';
import { parseViewMsg, type HostMsg, type ViewMsg } from './protocol.ts';
import { ViewSync } from './sync.ts';
import { FONT_KEYS, resolveFont } from './font.ts';
import { historyKey, KEY_NAME } from './key.ts';

export const VIEW_ID = 'terminalThreads.view';
const SAVE_KEY = 'terminalThreads.saveHistory';
// userInfo() throws for a uid with no passwd entry (possible in Remote containers).
const loginShell = () => {
  try {
    return userInfo().shell;
  } catch {
    return null;
  }
};
const saveSetting = () => vscode.workspace.getConfiguration().get<boolean>(SAVE_KEY, true);
// Machine-scoped in the manifest, so a workspace's .vscode/settings.json can't turn encryption off.
const ENCRYPT_KEY = 'terminalThreads.historyEncryption';
const encryptSetting = () => vscode.workspace.getConfiguration().get<string>(ENCRYPT_KEY, 'on') !== 'off';
export class ThreadsViewProvider implements vscode.WebviewViewProvider {
  private readonly context: vscode.ExtensionContext;
  private manager: ThreadManager | null = null;
  private ready: Promise<void> | null = null;
  private view: vscode.WebviewView | null = null;
  // Thread to show when the webview first reports ready (set by init, before any webview sync).
  private initial: string | null = null;
  private sizeKnown: () => void = () => {};
  private readonly viewSized = new Promise<void>((resolve) => { this.sizeKnown = resolve; });
  private size = { cols: 80, rows: 24 };
  private readonly attached = new Set<string>();
  private readonly sync = new ViewSync({
    post: (msg) => this.post(msg),
    snapshot: (id) => this.manager!.get(id)!.snapshot(),
    pause: (id) => this.manager?.get(id)?.pause(),
    resume: (id) => this.manager?.get(id)?.resume(),
  });

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState(() => this.updateWatched()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (FONT_KEYS.some((k) => e.affectsConfiguration(k))) this.postFont();
        if (e.affectsConfiguration(SAVE_KEY)) void this.manager?.setSaveHistory(saveSetting());
        if (e.affectsConfiguration(ENCRYPT_KEY)) this.manager?.setEncryption(encryptSetting());
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.sync.attach();
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((raw) => {
      const msg = parseViewMsg(raw);
      if (!msg) return;
      // The first size report unblocks init(), so shells start at the view's real size.
      if (msg.type === 'ready') {
        this.size = { cols: msg.cols, rows: msg.rows };
        this.sizeKnown();
      }
      void this.handle(msg).catch((e) => console.error('terminal-threads:', e));
    });
    view.onDidChangeVisibility(() => this.updateWatched());
    view.onDidDispose(() => {
      this.view = null;
      this.sync.detach();
      this.updateWatched();
    });
    this.ready ??= this.init();
  }

  async newThread(): Promise<void> {
    // Always show the view: from the palette it may be hidden, or not created yet (this starts init()).
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
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

  // Right-click → Clear History. Refused while a full-screen program owns the screen.
  async clearThreadHistory(id: unknown): Promise<void> {
    await this.ready;
    const m = this.manager;
    if (!m || typeof id !== 'string' || !m.get(id)) return;
    if (!(await m.clearHistory(id))) {
      void vscode.window.showInformationMessage('Exit the full-screen program first, then clear its history.');
      return;
    }
    if (this.sync.selected === id) await this.select(id);
  }

  dispose(): Promise<void> {
    return this.manager?.dispose() ?? Promise.resolve();
  }

  private async init(): Promise<void> {
    // Spawning before the view reports its size starts shells at 80x24; the resize that follows
    // makes some prompts redraw on a new line.
    await this.viewSized;
    const storage = this.context.storageUri ?? this.context.globalStorageUri;
    const secrets = this.context.secrets;
    const found = await historyKey(secrets);
    // The key is still read with encryption off, so existing encrypted history can be converted.
    if (!found && encryptSetting()) {
      void vscode.window.showWarningMessage("Terminal Threads couldn't use VS Code's secret storage, so thread history won't be saved this session.");
    }
    const store = new ThreadStore(storage.fsPath, found?.key ?? null, encryptSetting());
    await store.secure().catch((e) => console.warn('terminal-threads: could not tighten storage permissions', e));
    // VS Code drops a secret it can't decrypt, so a lost key looks like a first run; say so once.
    if (found?.created && (await store.hasEncryptedHistory())) {
      void vscode.window.showWarningMessage("Terminal Threads' saved history was encrypted with a key VS Code here no longer has (another computer, or a reset keychain), so it can't be read. It was moved aside, and those threads start empty.");
    }
    // Two windows can create the first key at once; the one that ends up stored wins everywhere.
    this.context.subscriptions.push(secrets.onDidChange(async (e) => {
      if (e.key !== KEY_NAME || !found) return;
      const stored = Buffer.from((await secrets.get(KEY_NAME)) ?? '', 'base64');
      if (stored.length === 32 && !stored.equals(found.key)) {
        found.key = stored;
        this.manager?.rekey(stored);
      }
    }));
    const m = new ThreadManager({
      store,
      defaultDir: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir(),
      shell: process.env.SHELL || loginShell() || '/bin/sh',
      args: ['-l'],
      env: process.env,
      cols: this.size.cols,
      rows: this.size.rows,
      saveHistory: saveSetting(),
      keyAvailable: found !== null,
      encrypt: encryptSetting(),
    });
    this.manager = m;
    m.onChange(() => this.postThreads());
    m.onWaiting((id) => void this.notifyWaiting(id));
    await m.restore();
    m.start();
    if (m.list().length === 0) await m.create();
    this.initial = m.list()[0]?.id ?? null;
  }

  private async handle(msg: ViewMsg): Promise<void> {
    await this.ready;
    const m = this.manager;
    if (!m) return;
    if ('id' in msg && !m.get(msg.id)) return;
    switch (msg.type) {
      case 'ready':
        this.size = { cols: msg.cols, rows: msg.rows };
        this.postFont();
        const id = this.sync.selected ?? this.initial;
        if (id && m.get(id)) await this.select(id);
        else this.postThreads();
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
        if (msg.id === this.sync.selected) m.get(msg.id)!.resize(msg.cols, msg.rows);
        break;
      case 'ack':
        this.sync.ack(msg.id, msg.chars);
        break;
    }
  }

  private async select(id: string): Promise<void> {
    const t = this.manager?.get(id);
    if (!t) return;
    if (!this.attached.has(id)) {
      this.attached.add(id);
      t.onData((seq, data) => this.sync.data(id, seq, data));
    }
    t.resize(this.size.cols, this.size.rows);
    const synced = this.sync.select(id);
    this.updateWatched();
    this.postThreads();
    await synced;
  }

  private async close(id: string): Promise<void> {
    const m = this.manager!;
    const ids = m.list().map((t) => t.id);
    const i = ids.indexOf(id);
    const wasSelected = this.sync.selected === id;
    if (wasSelected) this.sync.clear();
    this.attached.delete(id);
    await m.close(id);
    const next = ids[i + 1] ?? ids[i - 1];
    if (wasSelected && next) await this.select(next);
    else this.postThreads();
  }

  private updateWatched(): void {
    const watched = this.view?.visible && vscode.window.state.focused ? this.sync.selected : null;
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

  private font() {
    const config = vscode.workspace.getConfiguration();
    return resolveFont((key) => config.get(key));
  }

  private postFont(): void {
    this.post({ type: 'font', font: this.font() });
  }

  private postThreads(): void {
    if (this.manager) this.post({ type: 'threads', threads: this.manager.list(), selected: this.sync.selected });
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
<meta name="tt-font" content="${JSON.stringify(this.font()).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">
<link rel="stylesheet" href="${src('xterm.css')}">
<link rel="stylesheet" href="${src('webview.css')}">
</head><body>
<ul id="list" aria-label="Terminal threads"></ul>
<p id="empty" hidden>No threads. Use + to start one.</p>
<div id="term"></div>
<script nonce="${nonce}" src="${src('webview.js')}"></script>
</body></html>`;
  }
}
