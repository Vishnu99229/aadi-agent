import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Push notifications for Aadi's own long tasks at a remote agent. Aadi gives
 * the agent a callback URL with a one-off secret in it; when the agent posts
 * there, the task's waiter wakes and Aadi reads the task's status once. The
 * notification itself is never trusted as the result: it only says "look now".
 */
interface Waiter {
  remoteTaskId: string;
  secret: Buffer;
  wake: () => void;
  woken: boolean;
}

const waiters = new Map<string, Waiter>();
const MAX_WAITERS = 200;

export interface PushExpectation {
  url: string;
  token: string;
  /** Resolves true when a notification arrived, false when the time ran out. */
  wait(ms: number, signal: AbortSignal): Promise<boolean>;
  done(): void;
}

export function expectPush(callbackBase: string, remoteTaskId = ""): PushExpectation {
  const id = randomBytes(12).toString("hex");
  const token = randomBytes(24).toString("hex");
  let wake: () => void = () => undefined;
  let pending = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const waiter: Waiter = {
    remoteTaskId,
    secret: Buffer.from(token),
    woken: false,
    wake: () => {
      waiter.woken = true;
      wake();
    },
  };
  if (waiters.size >= MAX_WAITERS) {
    waiters.delete(waiters.keys().next().value!);
  }
  waiters.set(id, waiter);
  return {
    url: `${callbackBase.replace(/\/+$/, "")}/push/${id}`,
    token,
    wait: (ms, signal) =>
      new Promise<boolean>((resolve) => {
        if (waiter.woken) {
          waiter.woken = false;
          pending = new Promise<void>((next) => {
            wake = next;
          });
          resolve(true);
          return;
        }
        const timer = setTimeout(() => resolve(false), ms);
        const abort = () => {
          clearTimeout(timer);
          resolve(false);
        };
        signal.addEventListener("abort", abort, { once: true });
        void pending.then(() => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          waiter.woken = false;
          pending = new Promise<void>((next) => {
            wake = next;
          });
          resolve(true);
        });
      }),
    done: () => {
      waiters.delete(id);
    },
  };
}

let received = 0;

/** The server's /push/:id route. True when the id and secret match a waiter. */
export function receivePush(id: string, presented: string | undefined): boolean {
  const waiter = waiters.get(id);
  if (!waiter || !presented) {
    return false;
  }
  const given = Buffer.from(presented);
  if (given.length !== waiter.secret.length || !timingSafeEqual(given, waiter.secret)) {
    return false;
  }
  received += 1;
  waiter.wake();
  return true;
}

/** How many genuine notifications have arrived (for /health and tests). */
export function pushesReceived(): number {
  return received;
}
