import type { HostMsg } from './protocol.ts';

export const BATCH_MS = 8;
export const HIGH_WATER = 200_000;
export const LOW_WATER = 20_000;

export interface SyncTarget {
  post(msg: HostMsg): void;
  snapshot(id: string): Promise<{ seq: number; data: string }>;
  pause(id: string): void;
  resume(id: string): void;
}

// Keeps the webview's copy of the selected thread in step with the host: snapshot first, then
// sequenced, batched, flow-controlled output.
export class ViewSync {
  private readonly target: SyncTarget;
  private current: string | null = null;
  private detached = false;
  private gen = 0;
  private syncing = false;
  private held: { seq: number; data: string }[] = [];
  private batch = '';
  private batchSeq = 0;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private unacked = 0;
  private paused = false;

  constructor(target: SyncTarget) {
    this.target = target;
  }

  get selected(): string | null {
    return this.current;
  }

  async select(id: string): Promise<void> {
    this.resetFlow();
    this.current = id;
    this.syncing = true;
    // Only the latest select may finish: an older one (even for the same id) is stale.
    const gen = ++this.gen;
    const snap = await this.target.snapshot(id);
    if (gen !== this.gen || this.detached) return;
    this.post({ type: 'snapshot', id, seq: snap.seq, data: snap.data });
    this.syncing = false;
    for (const h of this.held) if (h.seq > snap.seq) this.queue(h.seq, h.data);
    this.held = [];
  }

  clear(): void {
    this.resetFlow();
    this.current = null;
    this.gen++;
  }

  data(id: string, seq: number, data: string): void {
    if (id !== this.current || this.detached) return;
    if (this.syncing) this.held.push({ seq, data });
    else this.queue(seq, data);
  }

  ack(id: string, chars: number): void {
    if (id !== this.current) return;
    this.unacked = Math.max(0, this.unacked - chars);
    if (this.paused && this.unacked < LOW_WATER) {
      this.paused = false;
      this.target.resume(id);
    }
  }

  // No webview means no acks; drop flow state so the thread never stays paused. Reattaching
  // goes through select(), which resends a snapshot.
  detach(): void {
    this.resetFlow();
    this.detached = true;
    this.syncing = false;
    this.gen++;
  }

  attach(): void {
    this.detached = false;
  }

  private post(msg: HostMsg): void {
    if (!this.detached) this.target.post(msg);
  }

  private queue(seq: number, data: string): void {
    this.batch += data;
    this.batchSeq = seq;
    this.batchTimer ??= setTimeout(() => this.flush(), BATCH_MS);
  }

  private flush(): void {
    this.batchTimer = null;
    const id = this.current;
    if (!id || !this.batch) return;
    const data = this.batch;
    this.batch = '';
    this.unacked += data.length;
    this.post({ type: 'data', id, seq: this.batchSeq, data });
    if (!this.paused && this.unacked > HIGH_WATER) {
      this.paused = true;
      this.target.pause(id);
    }
  }

  private resetFlow(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.batch = '';
    this.held = [];
    this.unacked = 0;
    if (this.paused && this.current) this.target.resume(this.current);
    this.paused = false;
  }
}
