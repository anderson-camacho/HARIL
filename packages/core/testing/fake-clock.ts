import type { Cancel, Clock, EpochMs } from "../src/ports/index.js";

interface Timer {
  readonly due: EpochMs;
  readonly seq: number;
  readonly run: () => void;
  cancelled: boolean;
}

// Virtual clock: time moves only through advance(), which fires due timers in order.
export class FakeClock implements Clock {
  private time = 0;
  private seq = 0;
  private timers: Timer[] = [];

  now(): EpochMs {
    return this.time;
  }

  schedule(delayMs: number, run: () => void): Cancel {
    const timer: Timer = { due: this.time + delayMs, seq: this.seq++, run, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const next = this.nextDue(target);
      if (next === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.time = next.due;
      next.run();
    }
    this.time = target;
  }

  private nextDue(target: EpochMs): Timer | undefined {
    let best: Timer | undefined;
    for (const timer of this.timers) {
      if (timer.cancelled || timer.due > target) continue;
      const earlier = best === undefined || timer.due < best.due;
      const sameTimeFirst = best !== undefined && timer.due === best.due && timer.seq < best.seq;
      if (earlier || sameTimeFirst) best = timer;
    }
    return best;
  }
}
