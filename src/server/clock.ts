import { runDue } from './hold-flow';
import { liveHoldDeps } from './live';

const MINUTE = 60_000;
let started = false;

// The web service never sleeps on a paid plan, so a timer in it is enough. Repeating a run
// is harmless, because every money call has a request ID and every save checks the state.
export function startClock() {
  if (started) return;
  started = true;
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    runDue(liveHoldDeps())
      .catch((error: unknown) => console.error('Hold clock failed', error instanceof Error ? error.message : 'unknown error'))
      .finally(() => {
        running = false;
      });
  }, MINUTE).unref();
}
