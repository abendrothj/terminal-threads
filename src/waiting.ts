export const LONG_BURST_MS = 10_000;
export const QUIET_MS = 3_000;

// Heuristic: can't tell "waiting for input" from "finished"; it only flags long work that stopped.
export class WaitingTracker {
  private burstStart: number | null = null;
  private lastOutput: number | null = null;
  private watched = false;
  private marked = false;

  get waiting(): boolean {
    return this.marked;
  }

  output(now: number): void {
    if (this.burstStart === null || this.lastOutput === null || now - this.lastOutput >= QUIET_MS) this.burstStart = now;
    this.lastOutput = now;
  }

  setWatched(watched: boolean): void {
    this.watched = watched;
    if (watched) this.marked = false;
  }

  tick(now: number): boolean {
    if (this.burstStart === null || this.lastOutput === null || now - this.lastOutput < QUIET_MS) return false;
    const long = this.lastOutput - this.burstStart >= LONG_BURST_MS;
    this.burstStart = null;
    if (!long || this.watched || this.marked) return false;
    this.marked = true;
    return true;
  }
}
