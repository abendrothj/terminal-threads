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
}

export function createHeadless(cols: number, rows: number): { term: Terminal; serializer: SerializeAddon } {
  const term = new xtermHeadless.Terminal({ cols, rows, scrollback: HISTORY_LINES, allowProposedApi: true });
  const serializer = new serializeAddon.SerializeAddon();
  term.loadAddon(serializer);
  return { term, serializer };
}

export function captureHistory(term: Terminal, serializer: SerializeAddon): SavedHistory {
  const history = serializer.serialize({ scrollback: HISTORY_LINES, excludeAltBuffer: true, excludeModes: true });
  const buf = term.buffer.active;
  if (buf.type !== 'alternate') return { history, frame: null };
  const frame: string[] = [];
  for (let y = 0; y < term.rows; y++) frame.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
  while (frame.length > 0 && frame[frame.length - 1] === '') frame.pop();
  return { history, frame };
}

export function restoredPrefix(saved: SavedHistory | null): string {
  if (!saved) return '\r\n' + SEPARATOR + '\r\n';
  const frame = saved.frame ? '\r\n' + saved.frame.join('\r\n') : '';
  return saved.history + frame + '\r\n' + SEPARATOR + '\r\n';
}
