// Drives a real VS Code with this extension in development mode, in a throwaway profile.
// VSCODE_PATH points at an installed VS Code executable; otherwise a pinned build is downloaded.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import playwright from 'playwright-core';
import type { ElectronApplication, Frame, Page } from 'playwright-core';
import testElectron from '@vscode/test-electron';

export const EXT = resolve(import.meta.dirname, '..');
const VSCODE_VERSION = '1.147.0';
const BASE_SETTINGS = {
  'workbench.startupEditor': 'none',
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'extensions.autoUpdate': false,
  // Screen-reader mode gives the terminal a text DOM, so tests can read it even under WebGL.
  'editor.accessibilitySupport': 'on',
  'window.menuStyle': 'custom',
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

let executable: string | undefined;
async function vscodeExecutable(): Promise<string> {
  executable ??= process.env.VSCODE_PATH || (await testElectron.downloadAndUnzipVSCode(VSCODE_VERSION));
  return executable;
}

export interface VS {
  app: ElectronApplication;
  page: Page;
  profile: string;
  folder: string;
  restart(): Promise<void>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

export interface LaunchOptions {
  settings?: Record<string, unknown>;
  workspaceSettings?: Record<string, unknown>;
  // Remote runs: open this vscode-remote:// folder, without the local dev extension, after
  // installing these marketplace extensions (e.g. Remote-SSH) into the profile.
  folderUri?: string;
  extensions?: string[];
}

export function writeUserSettings(profile: string, settings: Record<string, unknown>): void {
  writeFileSync(join(profile, 'user', 'User', 'settings.json'), JSON.stringify({ ...BASE_SETTINGS, ...settings }));
}

export async function launchVSCode(opts: LaunchOptions = {}): Promise<VS> {
  const profile = mkdtempSync(join(tmpdir(), 'tt-e2e-'));
  mkdirSync(join(profile, 'user', 'User'), { recursive: true });
  writeUserSettings(profile, opts.settings ?? {});
  const folder = join(profile, 'ws');
  mkdirSync(join(folder, '.vscode'), { recursive: true });
  if (opts.workspaceSettings) writeFileSync(join(folder, '.vscode', 'settings.json'), JSON.stringify(opts.workspaceSettings));
  const exe = await vscodeExecutable();
  if (opts.extensions?.length) {
    const [cli, ...cliArgs] = testElectron.resolveCliArgsFromVSCodeExecutablePath(exe);
    for (const id of opts.extensions) {
      execFileSync(cli!, [...cliArgs, `--user-data-dir=${join(profile, 'user')}`, `--extensions-dir=${join(profile, 'ext')}`, '--install-extension', id], { stdio: 'pipe' });
    }
  }

  const vs = {} as VS;
  const start = async () => {
    const args = [
      `--user-data-dir=${join(profile, 'user')}`, `--extensions-dir=${join(profile, 'ext')}`,
      '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window',
      ...(opts.folderUri ? [] : [`--extensionDevelopmentPath=${EXT}`]),
      // CI Linux has no OS keyring; VS Code's basic store lets history saving be tested there.
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu-sandbox', ...(process.env.TT_E2E_DEFAULT_STORE ? [] : ['--password-store=basic'])] : []),
      ...(process.env.TT_E2E_ARGS ? process.env.TT_E2E_ARGS.split(' ') : []),
      opts.folderUri ? `--folder-uri=${opts.folderUri}` : folder,
    ];
    vs.app = await playwright._electron.launch({ executablePath: exe, args, timeout: 120_000 });
    vs.page = await vs.app.firstWindow();
    await vs.page.waitForSelector('.monaco-workbench', { timeout: 120_000 });
  };
  try {
    await start();
  } catch (e) {
    rmSync(profile, { recursive: true, force: true });
    throw e;
  }
  Object.assign(vs, {
    profile,
    folder,
    restart: async () => { await vs.app.close(); await start(); },
    close: () => vs.app.close(),
    dispose: async () => {
      await vs.app.close().catch(() => {});
      if (process.env.TT_E2E_LOGS) dumpLogs(profile);
      rmSync(profile, { recursive: true, force: true });
    },
  });
  return vs;
}

export async function palette(page: Page, command: string): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
  const input = await page.waitForSelector('.quick-input-widget:not([style*="display: none"]) input', { timeout: 15_000 });
  await input.focus();
  await input.fill('>' + command);
  let typed = Date.now();
  // Press Enter only once the highlighted entry is the command asked for.
  await waitFor(async () => {
    const focused = await page.$eval('.quick-input-list .monaco-list-row.focused .label-name', (e) => e.textContent ?? '').catch(() => '');
    if (focused.replace(/\s+/g, ' ').includes(command.split(': ').at(-1)!)) return true;
    // Under load the palette can miss the typed text and keep listing every command: type it again.
    if (Date.now() - typed > 2000) {
      await input.fill('');
      await input.fill('>' + command);
      typed = Date.now();
    }
    return false;
  }, 15_000, `palette entry "${command}"`)
    .catch(async (e) => {
      const rows = await page.$$eval('.quick-input-list .monaco-list-row', (r) => r.slice(0, 6).map((x) => `${x.classList.contains('focused') ? '>' : ' '}${x.querySelector('.label-name')?.textContent}`));
      throw new Error(`${(e as Error).message}; palette shows ${JSON.stringify(rows)}`);
    });
  await page.keyboard.press('Enter');
  await sleep(300);
}

// The thread view's inner webview frame (the one with our #list).
export async function viewFrame(page: Page, ms = 60_000): Promise<Frame> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const f of page.frames()) {
      if (f.url().startsWith('vscode-webview://') && (await f.$('#list').catch(() => null))) return f;
    }
    await sleep(250);
  }
  throw new Error('thread view frame not found');
}

// Shows the view if it isn't already open (after a restart it usually is), then waits for a thread.
// Avoids the palette when it can: its Enter can land in a thread that takes focus.
export async function openThreads(page: Page): Promise<Frame> {
  const open = await viewFrame(page, 5_000).catch(() => null);
  if (!open) await palette(page, 'Terminal Threads: Focus on Threads View');
  const frame = open ?? (await viewFrame(page));
  await waitFor(async () => (await threads(frame)).length > 0, 30_000, 'first thread');
  return frame;
}

// Webviews are drawn in an overlay, not inside the sidebar's DOM; compare positions instead.
export async function inSecondarySidebar(page: Page, frame: Frame): Promise<boolean> {
  const bar = await (await page.$('.part.auxiliarybar'))?.boundingBox();
  const view = await (await frame.frameElement()).boundingBox();
  if (!bar || !view || bar.width === 0) return false;
  return view.x >= bar.x - 1 && view.x + view.width <= bar.x + bar.width + 1;
}

export const threads = (frame: Frame) => frame.$$eval('#list li', (lis) => lis.map((li) => ({
  title: li.querySelector('.name')?.textContent ?? '',
  selected: li.classList.contains('selected'),
  waiting: !(li.querySelector('.dot') as HTMLElement | null)?.hidden,
})));

export async function typeIn(page: Page, frame: Frame, text: string): Promise<void> {
  await frame.click('#term .xterm');
  await page.keyboard.type(text, { delay: 5 });
}

// Terminal text from xterm's screen-reader rows (needs editor.accessibilitySupport: on).
export const screenText = (frame: Frame) =>
  frame.$$eval('#term .xterm-accessibility-tree > div', (rows) => rows.map((r) => r.textContent ?? '').join('\n'));

export function storeDir(profile: string): string | null {
  const ws = join(profile, 'user', 'User', 'workspaceStorage');
  for (const d of existsSync(ws) ? readdirSync(ws) : []) {
    const s = join(ws, d, 'local.terminal-threads');
    if (existsSync(s)) return s;
  }
  return null;
}

export function historyFiles(profile: string): string[] {
  const s = storeDir(profile);
  const t = s && join(s, 'threads');
  return t && existsSync(t) ? readdirSync(t).filter((f) => f.endsWith('.json')).map((f) => join(t, f)) : [];
}

// TT_E2E_LOGS=1 prints the extension-host and main logs of each run (for CI failures).
function dumpLogs(profile: string): void {
  const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
  for (const f of walk(join(profile, 'user', 'logs')).filter((f) => /(exthost|main|renderer)\.log$/.test(f))) {
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => /terminal-threads|secret|keyring|password|safeStorage|encryption|libsecret|node-pty|pty\.node/i.test(l) && !/AgentHost/.test(l));
    if (lines.length) console.log(`--- ${f.split('/logs/')[1]}\n${lines.slice(-25).join('\n')}`);
  }
}

// Right-click a thread row and pick a menu item by keyboard (Linux's custom menu ignores synthetic
// clicks on items). Separators are skipped by the arrow keys, so they're left out of the count.
export async function threadMenu(page: Page, frame: Frame, rowSelector: string, item: string): Promise<void> {
  await frame.click(rowSelector, { button: 'right' });
  await page.waitForSelector('.context-view .monaco-menu .action-label', { timeout: 10_000 });
  const labels = await page.$$eval('.context-view .monaco-menu .action-item:not(.disabled) .action-label:not(.separator)', (e) => e.map((x) => x.textContent?.trim()));
  const index = labels.indexOf(item);
  if (index < 0) throw new Error(`menu has no "${item}": ${JSON.stringify(labels)}`);
  for (let i = 0; i <= index; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

// Waits for an autosave that happened after `since` (ms epoch): a history file at least that new.
export async function savedAfter(profile: string, since: number, ms = 20_000): Promise<void> {
  await waitFor(() => historyFiles(profile).some((f) => statSync(f).mtimeMs > since), ms, 'autosave after the output');
}
