// forge lifecycle for the github-core-clone-01 entry: bind an ephemeral port, hand that port to the
// trial env, then poll the env until the suite's export is written, and leave with 0.
//
//   1. the env's origin arrives in MAKEFUN_ENV_URL (http://store:8080 inside the trial pod). No env
//      means nothing to register with, so we exit 1 instead of serving into the void.
//   2. the forge server comes from createApp(); listen(0) lets the kernel pick the port. Port 8080
//      belongs to the env, so it is never ours to bind.
//   3. the port goes to the env by POST $MAKEFUN_ENV_URL/register {"port": N}. The env reads the
//      address our request came from, pairs it with N, and dials that pair from then on. The first
//      register sticks; a 409 only means some earlier one won and we go on waiting.
//   4. GET $MAKEFUN_ENV_URL/done answers {"done": false} at once while the suite runs and
//      {"done": true} once its export is on disk. We poll with a short exponential backoff and never
//      hold a request open; the process does not exit before a done:true.
//   5. done: close the listener and exit 0. The harness stops the env, whose export is the scorer's input.
//
// This file only drives that lifecycle; every scored route lives in ./app.ts and its modules.

import { createApp } from './app.ts';

/** The env origin this trial hands us; blank means there is no env and nothing to do. */
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is unset: no env to register with, exiting\n');
  process.exit(1);
}

/** One register or done call may take this long before we give up on that attempt. */
const CALL_TIMEOUT_MS = 30_000;
/** Backoff between attempts: it starts here and doubles, capped at BACKOFF_MAX_MS. */
const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait to insert after `attempt` failures: exponential, never past BACKOFF_MAX_MS. */
function backoff(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Deliver our port to the env and wait for it to take it. A 200 is the happy answer and a 409 means
 * an earlier register already stuck (fine: we simply go on to the done poll). A 400 or a 405 is the
 * env saying our request shape is wrong, which no retry repairs, so that ends the process; any other
 * status, and any transport error, is retried, because the env may still be booting.
 */
async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused with HTTP ')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

/** Ask GET /done over and over until the body says {"done": true}; return only then. */
async function pollUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // No answer yet, or this poll timed out: the suite is still running, so poll again.
    }
    await sleep(backoff(attempt));
  }
}

/** The whole life of the process: bind, register, wait for done, exit 0. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the forge did not obtain an ephemeral TCP port');
  }
  process.stdout.write(`[forge] serving on port ${address.port}\n`);

  await registerPort(address.port);
  process.stdout.write('[forge] registered with the env; polling for done\n');

  await pollUntilDone();
  server.close();
  process.stdout.write('[forge] trial complete\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
