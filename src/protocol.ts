import type { ThreadInfo } from './manager.ts';

export type HostMsg =
  | { type: 'threads'; threads: ThreadInfo[]; selected: string | null }
  | { type: 'snapshot'; id: string; seq: number; data: string }
  | { type: 'data'; id: string; seq: number; data: string };

export type ViewMsg =
  | { type: 'ready'; cols: number; rows: number }
  | { type: 'select' | 'close'; id: string }
  | { type: 'create' }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'ack'; id: string; chars: number };

const str = (v: unknown): v is string => typeof v === 'string';
const pos = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const nonNeg = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

// The webview is our own code, but its messages still cross a process boundary: check every field.
export function parseViewMsg(raw: unknown): ViewMsg | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return pos(m.cols) && pos(m.rows) ? { type: 'ready', cols: m.cols, rows: m.rows } : null;
    case 'create':
      return { type: 'create' };
    case 'select':
    case 'close':
      return str(m.id) ? { type: m.type, id: m.id } : null;
    case 'input':
      return str(m.id) && str(m.data) ? { type: 'input', id: m.id, data: m.data } : null;
    case 'resize':
      return str(m.id) && pos(m.cols) && pos(m.rows) ? { type: 'resize', id: m.id, cols: m.cols, rows: m.rows } : null;
    case 'ack':
      return str(m.id) && nonNeg(m.chars) ? { type: 'ack', id: m.id, chars: m.chars } : null;
    default:
      return null;
  }
}
