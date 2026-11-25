import xtermHeadless from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import type { SerializeAddon } from '@xterm/addon-serialize';

import { HISTORY_LINES } from './protocol.ts';

export { HISTORY_LINES };
export const SEPARATOR = '\x1b[2m── session ended ──\x1b[0m';

export interface SavedHistory {
  history: string;
  frame: string[] | null;
  program?: string | null; // the full-screen program the frame belongs to
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export function createHeadless(cols: number, rows: number): { term: Terminal; serializer: SerializeAddon } {
  const term = new xtermHeadless.Terminal({ cols, rows, scrollback: HISTORY_LINES, allowProposedApi: true });
  const serializer = new serializeAddon.SerializeAddon();
  term.loadAddon(serializer);
  return { term, serializer };
}

export function captureHistory(term: Terminal, serializer: SerializeAddon, program: string | null = null): SavedHistory {
  const history = serializer.serialize({ scrollback: HISTORY_LINES, excludeAltBuffer: true, excludeModes: true });
  const buf = term.buffer.active;
  if (buf.type !== 'alternate') return { history, frame: null };
  const frame: string[] = [];
  for (let y = 0; y < term.rows; y++) frame.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
  while (frame.length > 0 && frame[frame.length - 1] === '') frame.pop();
  return { history, frame, program: program || null };
}

// TUIs leave most of the screen blank; keep the content, not the empty rows.
function compactFrame(rows: string[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const blank = row.trim() === '';
    if (blank && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(blank ? '' : row);
  }
  if (out[out.length - 1] === '') out.pop();
  return out;
}

export function restoredPrefix(saved: SavedHistory | null): string {
  if (!saved) return '\r\n' + SEPARATOR + '\r\n';
  // The frame is a still picture, not live output: dim it under a label.
  const label = saved.program ? `── ${saved.program}, last screen ──` : '── last screen ──';
  const frame = saved.frame
    ? `\r\n${DIM}${label}${RESET}` + compactFrame(saved.frame).map((row) => `\r\n${DIM}${row}${RESET}`).join('')
    : '';
  return saved.history + frame + '\r\n' + SEPARATOR + '\r\n';
}
