import { randomUUID } from "node:crypto";
import { Role, TaskState as WireState, type Artifact as WireArtifact, type Message, type Part, type Task } from "@a2a-js/sdk";
import type { Artifact, TaskState } from "../types.js";

/**
 * Translation between Aadi's task contracts and the A2A 1.0 wire types from the
 * official SDK. Nothing here invents a protocol shape: the types are the SDK's.
 */
const TO_WIRE: Record<TaskState, WireState> = {
  submitted: WireState.TASK_STATE_SUBMITTED,
  working: WireState.TASK_STATE_WORKING,
  "input-required": WireState.TASK_STATE_INPUT_REQUIRED,
  "auth-required": WireState.TASK_STATE_AUTH_REQUIRED,
  completed: WireState.TASK_STATE_COMPLETED,
  failed: WireState.TASK_STATE_FAILED,
  canceled: WireState.TASK_STATE_CANCELED,
  rejected: WireState.TASK_STATE_REJECTED,
};

export function toWireState(state: TaskState): WireState {
  return TO_WIRE[state];
}

export function fromWireState(state: WireState | undefined): TaskState {
  for (const [name, wire] of Object.entries(TO_WIRE) as Array<[TaskState, WireState]>) {
    if (wire === state) {
      return name;
    }
  }
  // An unknown state from a remote agent is treated as a failure, never as success.
  return "failed";
}

export function textPart(text: string): Part {
  return { content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

export function dataPart(value: unknown): Part {
  return { content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" };
}

export function newMessage(input: {
  role: "user" | "agent";
  parts: Part[];
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}): Message {
  return {
    messageId: randomUUID(),
    role: input.role === "user" ? Role.ROLE_USER : Role.ROLE_AGENT,
    parts: input.parts,
    taskId: input.taskId ?? "",
    contextId: input.contextId ?? "",
    metadata: input.metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function partsText(parts: readonly Part[] | undefined): string {
  return (parts ?? [])
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .filter(Boolean)
    .join("\n");
}

export function partsData(parts: readonly Part[] | undefined): Record<string, unknown> | undefined {
  for (const part of parts ?? []) {
    if (part.content?.$case === "data" && part.content.value && typeof part.content.value === "object") {
      return part.content.value as Record<string, unknown>;
    }
  }
  return undefined;
}

export function toWireArtifact(artifact: Artifact): WireArtifact {
  return {
    artifactId: artifact.artifactId,
    name: artifact.name,
    description: "",
    parts: [artifact.kind === "text" ? textPart(artifact.text ?? "") : dataPart(artifact.data ?? {})],
    metadata: undefined,
    extensions: [],
  };
}

export function fromWireArtifacts(artifacts: readonly WireArtifact[] | undefined): Artifact[] {
  return (artifacts ?? []).map((artifact) => {
    const data = partsData(artifact.parts);
    return data
      ? { artifactId: artifact.artifactId, name: artifact.name, kind: "data" as const, data }
      : { artifactId: artifact.artifactId, name: artifact.name, kind: "text" as const, text: partsText(artifact.parts) };
  });
}

/** What a finished or paused remote task said, as text and data. */
export function readTask(task: Task): {
  state: TaskState;
  text: string;
  data?: Record<string, unknown>;
  artifacts: Artifact[];
} {
  const artifacts = fromWireArtifacts(task.artifacts);
  const statusText = partsText(task.status?.message?.parts);
  const artifactText = artifacts
    .filter((artifact) => artifact.kind === "text")
    .map((artifact) => artifact.text ?? "")
    .filter(Boolean)
    .join("\n");
  const data =
    artifacts.find((artifact) => artifact.kind === "data")?.data ?? partsData(task.status?.message?.parts);
  return {
    state: fromWireState(task.status?.state),
    text: artifactText || statusText,
    data,
    artifacts,
  };
}
