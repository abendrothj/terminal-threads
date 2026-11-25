import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { HISTORY_LINES, type HostMsg, type ViewMsg } from '../src/protocol.ts';
import type { ThreadInfo } from '../src/manager.ts';

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

const term = new Terminal({
  scrollback: HISTORY_LINES,
  fontFamily: css('--vscode-editor-font-family') ?? 'monospace',
  fontSize: parseInt(css('--vscode-editor-font-size') ?? '13', 10),
  theme: theme(),
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(termEl);
fit.fit();
new MutationObserver(() => { term.options.theme = theme(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
new ResizeObserver(() => fit.fit()).observe(termEl);

term.onData((data) => { if (selected) vscode.postMessage({ type: 'input', id: selected, data }); });
term.onResize(({ cols, rows }) => { if (selected) vscode.postMessage({ type: 'resize', id: selected, cols, rows }); });

function render(threads: ThreadInfo[]): void {
  // The list is rebuilt on every update; put keyboard focus back on the same control.
  const active = document.activeElement;
  const focusLi = active instanceof HTMLElement && list.contains(active) ? active.closest('li') : null;
  const focusId = focusLi?.dataset.id;
  const focusClass = active instanceof HTMLElement ? active.className : '';
  list.replaceChildren(...threads.map((t) => {
    const li = document.createElement('li');
    li.className = t.id === selected ? 'selected' : '';
    li.dataset.id = t.id;
    li.dataset.vscodeContext = JSON.stringify({ webviewSection: 'thread', threadId: t.id, preventDefaultContextMenuItems: true });
    const row = document.createElement('button');
    row.className = 'row';
    if (t.id === selected) row.setAttribute('aria-current', 'true');
    row.title = t.title;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.title;
    row.append(name);
    if (t.waiting) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'sr-only';
      label.textContent = ' (waiting)';
      row.append(dot, label);
    }
    row.addEventListener('click', () => vscode.postMessage({ type: 'select', id: t.id }));
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', `Close ${t.title}`);
    close.addEventListener('click', () => vscode.postMessage({ type: 'close', id: t.id }));
    li.append(row, close);
    return li;
  }));
  if (focusId) list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(focusId)}"] .${focusClass}`)?.focus();
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
