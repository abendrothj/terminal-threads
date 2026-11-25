import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

// Task 0 gate: a single terminal. Replaced by the thread list UI in Task 6.
const vscode = acquireVsCodeApi();
const term = new Terminal({ fontFamily: 'var(--vscode-editor-font-family), monospace' });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term')!);
fit.fit();
term.onData((data) => vscode.postMessage({ type: 'input', data }));
term.onResize(({ cols, rows }) => vscode.postMessage({ type: 'resize', cols, rows }));
new ResizeObserver(() => fit.fit()).observe(document.getElementById('term')!);
window.addEventListener('message', (e: MessageEvent<{ type: string; data: string }>) => {
  if (e.data.type === 'data') term.write(e.data.data);
});
vscode.postMessage({ type: 'ready', cols: term.cols, rows: term.rows });
