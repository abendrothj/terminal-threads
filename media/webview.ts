import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { HISTORY_LINES, type HostMsg, type ViewMsg } from '../src/protocol.ts';
import type { ThreadInfo } from '../src/manager.ts';
import type { FontConfig } from '../src/font.ts';
import { cellBackground } from '../src/padding.ts';

declare function acquireVsCodeApi(): { postMessage(msg: ViewMsg): void };

const vscode = acquireVsCodeApi();
const list = document.getElementById('list')!;
const empty = document.getElementById('empty')!;
const termEl = document.getElementById('term')!;

let selected: string | null = null;
let snapSeq = Number.POSITIVE_INFINITY;

const css = (name: string) => getComputedStyle(document.body).getPropertyValue(name).trim() || undefined;
const ANSI = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'] as const;
function theme(): ITheme {
  const t: Record<string, string | undefined> = {
    background: css('--vscode-terminal-background') ?? css('--vscode-sideBar-background') ?? css('--vscode-editor-background'),
    foreground: css('--vscode-terminal-foreground') ?? css('--vscode-foreground'),
    cursor: css('--vscode-terminalCursor-foreground'),
    selectionBackground: css('--vscode-terminal-selectionBackground'),
  };
  for (const c of ANSI) {
    t[c.toLowerCase()] = css(`--vscode-terminal-ansi${c}`);
    t[`bright${c}`] = css(`--vscode-terminal-ansiBright${c}`);
  }
  return t as ITheme;
}

// The host puts the resolved terminal font in the page, so the first size reported is final.
const initialFont = JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="tt-font"]')?.content ?? 'null') as (FontConfig & { screenReader: boolean }) | null;
const term = new Terminal({
  scrollback: HISTORY_LINES,
  fontFamily: initialFont?.family ?? css('--vscode-editor-font-family') ?? 'monospace',
  fontSize: initialFont?.size ?? parseInt(css('--vscode-editor-font-size') ?? '13', 10),
  lineHeight: initialFont?.lineHeight ?? 1,
  screenReaderMode: initialFont?.screenReader ?? false,
  theme: theme(),
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(termEl);
// Electron 43.8.9 (VS Code 1.147) rejects canvas fonts with leading whitespace, which xterm's WebGL
// glyph atlas emits, so glyphs fall back to 10px (xtermjs/xterm.js#6297). Same shim as
// microsoft/vscode#348269, which only covers the workbench; remove once xterm.js #6312 ships.
for (const proto of [CanvasRenderingContext2D.prototype, globalThis.OffscreenCanvasRenderingContext2D?.prototype]) {
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'font');
  if (!proto || !desc?.set) continue;
  const set = desc.set;
  Object.defineProperty(proto, 'font', { ...desc, set(this: unknown, value: string) { set.call(this, typeof value === 'string' ? value.trimStart() : value); } });
}
// GPU rendering like VS Code's own terminal; xterm falls back to its DOM renderer when this is gone.
try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => webgl.dispose());
  term.loadAddon(webgl);
} catch (e) {
  console.warn('terminal-threads: WebGL unavailable, using the DOM renderer', e);
}
fit.fit();
// The grid rarely fills the view; give the leftover strips the bottom-right cell's background while a
// full-screen program is showing, the terminal background otherwise.
let padding = '';
function updatePadding(): void {
  const t = theme();
  const buf = term.buffer.active;
  const cell = buf.type === 'alternate' ? buf.getLine(buf.viewportY + term.rows - 1)?.getCell(term.cols - 1) : undefined;
  const ansi = ANSI.flatMap((c) => [t[c.toLowerCase() as keyof ITheme], t[`bright${c}` as keyof ITheme]]) as string[];
  const order = [0, 2, 4, 6, 8, 10, 12, 14, 1, 3, 5, 7, 9, 11, 13, 15].map((i) => ansi[i] ?? '');
  const color = cell ? cellBackground(cell, { ansi: order, background: t.background ?? '', foreground: t.foreground ?? '' }) : t.background ?? '';
  if (color === padding) return;
  padding = color;
  termEl.style.backgroundColor = color;
  // xterm 6 paints the theme background on its scrollable element (the scrollbar strip) too.
  for (const el of termEl.querySelectorAll<HTMLElement>('.xterm-scrollable-element, .xterm-viewport')) el.style.backgroundColor = color;
}
term.onRender(updatePadding);
new MutationObserver(() => { term.options.theme = theme(); padding = ''; updatePadding(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
new ResizeObserver(() => fit.fit()).observe(termEl);

term.onData((data) => { if (selected) vscode.postMessage({ type: 'input', id: selected, data }); });
term.onResize(({ cols, rows }) => { if (selected) vscode.postMessage({ type: 'resize', id: selected, cols, rows }); });

// One row element per thread, created once and updated in place: rebuilding the list on every
// update (titles change many times a second while a program runs) would cancel a drag in progress
// and drop keyboard focus.
const rows = new Map<string, HTMLLIElement>();

function createRow(id: string): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset.id = id;
  li.dataset.vscodeContext = JSON.stringify({ webviewSection: 'thread', threadId: id, preventDefaultContextMenuItems: true });
  const row = document.createElement('button');
  row.className = 'row';
  const name = document.createElement('span');
  name.className = 'name';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'sr-only';
  label.textContent = ' (waiting)';
  row.append(name, dot, label);
  row.addEventListener('click', () => vscode.postMessage({ type: 'select', id }));
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.addEventListener('click', () => vscode.postMessage({ type: 'close', id }));
  li.append(row, close);
  // Drag a row onto another to move it there.
  li.draggable = true;
  li.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/x-thread', id); li.classList.add('dragging'); });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  li.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('text/x-thread')) return;
    e.preventDefault();
    li.classList.add('drop-target');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    li.classList.remove('drop-target');
    const moved = e.dataTransfer?.getData('text/x-thread');
    const index = [...list.children].indexOf(li);
    if (moved && moved !== id) vscode.postMessage({ type: 'move', id: moved, index });
  });
  return li;
}

function render(threads: ThreadInfo[]): void {
  const ids = new Set(threads.map((t) => t.id));
  for (const [id, li] of rows) if (!ids.has(id)) { li.remove(); rows.delete(id); }
  threads.forEach((t, i) => {
    let li = rows.get(t.id);
    if (!li) rows.set(t.id, (li = createRow(t.id)));
    const isSelected = t.id === selected;
    li.classList.toggle('selected', isSelected);
    const row = li.querySelector<HTMLElement>('.row')!;
    if (isSelected) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
    row.title = t.title;
    li.querySelector('.name')!.textContent = t.title;
    li.querySelector<HTMLElement>('.dot')!.hidden = !t.waiting;
    li.querySelector<HTMLElement>('.sr-only')!.hidden = !t.waiting;
    li.querySelector('.close')!.setAttribute('aria-label', `Close ${t.title}`);
    // Only move a row when the order really changed; moving it mid-drag would cancel the drag.
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
  });
  empty.hidden = threads.length > 0;
  termEl.hidden = threads.length === 0;
}

window.addEventListener('message', (e: MessageEvent<HostMsg>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'threads':
      if (msg.selected !== selected) {
        selected = msg.selected;
        snapSeq = Number.POSITIVE_INFINITY;
        if (!selected) term.reset();
      }
      render(msg.threads);
      break;
    case 'snapshot':
      if (msg.id !== selected) return;
      term.reset();
      term.write(msg.data);
      snapSeq = msg.seq;
      fit.fit();
      term.focus();
      break;
    case 'font':
      term.options.fontFamily = msg.font.family;
      term.options.fontSize = msg.font.size;
      term.options.lineHeight = msg.font.lineHeight;
      term.options.screenReaderMode = msg.screenReader;
      fit.fit();
      break;
    case 'data': {
      const ack = () => vscode.postMessage({ type: 'ack', id: msg.id, chars: msg.data.length });
      if (msg.id === selected && msg.seq > snapSeq) term.write(msg.data, ack);
      else ack();
      break;
    }
  }
});

vscode.postMessage({ type: 'ready', cols: term.cols, rows: term.rows });
