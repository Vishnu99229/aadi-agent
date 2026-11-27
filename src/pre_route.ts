import type { ClosedEmailContext } from "./db.js";

export type PreRouteResult =
  | { kind: "handled" | "clarification" | "refusal"; text: string }
  | {
      kind: "miss";
      note: string;
      scope?: "read_only" | "thread_draft";
      reference?: ClosedEmailContext;
      notice?: string;
    };

export function routeMiss(
  note: string,
  options: Omit<Extract<PreRouteResult, { kind: "miss" }>, "kind" | "note"> = {},
): Extract<PreRouteResult, { kind: "miss" }> {
  return { kind: "miss", note, ...options };
}
