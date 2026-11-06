import { closeOldDemoPulls, reconcile, releaseStrays, runDue } from './hold-flow';
import { liveHoldDeps } from './live';

const MINUTE = 60_000;
const RECONCILE_EVERY = 30;
let started = false;

// The web service never sleeps on a paid plan, so a timer in it is enough. Repeating a run
// is harmless, because every money call has a request ID and every save checks the state.
export function startClock() {
  if (started) return;
  started = true;
  let running = false;
  let ticks = 0;
  setInterval(() => {
    if (running) return;
    running = true;
    const reconciling = ++ticks % RECONCILE_EVERY === 0;
    runDue(liveHoldDeps())
      .then(() => releaseStrays(liveHoldDeps()))
      .then(() => closeOldDemoPulls(liveHoldDeps()))
      .then(() => (reconciling ? reconcile(liveHoldDeps()) : undefined))
      .catch((error: unknown) => console.error('Hold clock failed', error instanceof Error ? error.message : 'unknown error'))
      .finally(() => {
        running = false;
      });
  }, MINUTE).unref();
}
