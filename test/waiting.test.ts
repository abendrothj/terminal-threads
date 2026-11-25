import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaitingTracker } from '../src/waiting.ts';

function burst(t: WaitingTracker, from: number, to: number, step: number): void {
  for (let now = from; now <= to; now += step) t.output(now);
}

test('long unwatched burst marks once', () => {
  const t = new WaitingTracker();
  burst(t, 0, 12_000, 1000);
  assert.equal(t.tick(14_000), false);
  assert.equal(t.tick(15_000), true);
  assert.equal(t.waiting, true);
  assert.equal(t.tick(16_000), false);
});

test('short burst never marks', () => {
  const t = new WaitingTracker();
  t.output(0);
  t.output(500);
  assert.equal(t.tick(10_000), false);
  assert.equal(t.waiting, false);
});

test("burst finishing while watched doesn't mark", () => {
  const t = new WaitingTracker();
  t.setWatched(true);
  burst(t, 0, 12_000, 1000);
  assert.equal(t.tick(15_000), false);
  assert.equal(t.waiting, false);
});

test('watching clears the mark', () => {
  const t = new WaitingTracker();
  burst(t, 0, 12_000, 1000);
  t.tick(15_000);
  t.setWatched(true);
  assert.equal(t.waiting, false);
});

test('gaps under QUIET_MS keep one burst', () => {
  const t = new WaitingTracker();
  burst(t, 0, 12_000, 2000);
  assert.equal(t.tick(15_000), true);
});
