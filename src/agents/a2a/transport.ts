/**
 * How an A2A task travels between Aadi and another agent.
 *
 * - HTTP+JSON request/response is the default and always works.
 * - When both sides stream, an interactive task uses HTTP+JSON with SSE, so
 *   progress arrives as it happens and a dropped stream can resubscribe.
 * - A genuinely long task uses a push notification (webhook) when the waiting
 *   side has a callback configured, so nobody holds a connection open or polls.
 * - Polling is the last resort, only when neither streaming nor push is there,
 *   and it backs off.
 *
 * gRPC is a named option for later. It is never chosen today; adding it means
 * a transport here and in the SDK client factory, nothing else.
 */
export type A2aTransport = "http+json" | "http+json+sse" | "http+json+push" | "grpc";

export interface TransportInput {
  /** The other agent's card says it streams. */
  peerStreaming: boolean;
  /** The other agent's card says it sends push notifications. */
  peerPush: boolean;
  /** This side streams too. */
  localStreaming: boolean;
  /** This side has a callback URL it can be reached on. */
  localPushCallback: boolean;
  /** Expected to run longer than an interactive wait. */
  longRunning: boolean;
  /** Reserved: both sides offer gRPC and want it. */
  grpcBoth?: boolean;
}

export interface TransportChoice {
  transport: A2aTransport;
  /** How to find out where a task stands after a lost connection. */
  reconcile: "resubscribe" | "push-then-get" | "get-with-backoff";
  reason: string;
}

export function chooseTransport(input: TransportInput): TransportChoice {
  if (input.longRunning && input.peerPush && input.localPushCallback) {
    return { transport: "http+json+push", reconcile: "push-then-get", reason: "long task, both sides support push" };
  }
  if (input.peerStreaming && input.localStreaming) {
    return { transport: "http+json+sse", reconcile: "resubscribe", reason: "both sides stream" };
  }
  return { transport: "http+json", reconcile: "get-with-backoff", reason: "default request/response" };
}

/** Polling, when nothing better is offered: 1s, 2s, 4s ... capped at 15s. */
export function pollDelayMs(attempt: number): number {
  return Math.min(15_000, 1_000 * 2 ** Math.max(0, attempt));
}
