import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  AgentCard,
  TaskState as WireState,
  type Artifact as WireArtifact,
  type Task,
  type TaskPushNotificationConfig,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultPushNotificationSender,
  DefaultRequestHandler,
  InMemoryPushNotificationStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type PushNotificationStore,
  type RequestContext,
  type ServerCallContext,
} from "@a2a-js/sdk/server";
import { agentCardHandler, restHandler } from "@a2a-js/sdk/server/express";
import express, { type NextFunction, type Request, type Response } from "express";
import { config, type A2aServerClient } from "../../config.js";
import { issueGrant, revokeGrant } from "../auth.js";
import { cancelTask, continueTask, delegate } from "../engine.js";
import { localSpecialists } from "../index.js";
import { getTask } from "../store.js";
import type { AgentTaskResult } from "../types.js";
import { logTaskEnd, logTaskStart, logTaskTraffic } from "./log.js";
import { receivePush } from "./push_receiver.js";
import { runWithPriority, withSlot } from "../../governor.js";
import { newMessage, partsData, partsText, textPart, toWireArtifact, toWireState } from "./mapping.js";
import { SYSTEM_SKILLS } from "./system_skills.js";
import {
  claimMessage,
  loadTaskSnapshot,
  localTaskFor,
  ownerOf,
  saveTaskSnapshot,
  setLocalTask,
  SqliteTaskStore,
  sweepServerTasks,
} from "./task_store.js";

/**
 * Aadi's A2A endpoint (A2A 1.0, HTTP+JSON with SSE, official SDK). Off unless
 * A2A_SERVER_ENABLED is set, bound to loopback only, and every route needs a
 * bearer credential. Each calling agent has its own credential, so the log and
 * the task store know which agent is which.
 *
 * A caller is another agent, never Vishnu: it can reach only the skills listed
 * on the card (reads with nothing private in them, and the system test skill),
 * nothing it says is an approval, and no grant of Vishnu's ever applies to it.
 *
 * Tasks are kept in SQLite and the executor saves every change itself, so a
 * caller whose stream dropped, or who comes back after a restart, can read or
 * resubscribe to the same task by id. A message id seen before is never run
 * again.
 */
const HOST = "127.0.0.1";
const SPECIALIST_DEADLINE_MS = 60_000;

export interface ExposedSkill {
  id: string;
  agentId: string;
  capability: string;
  description: string;
  examples: string[];
  system?: boolean;
}

/** "agent.capability" for every capability another agent may call, plus the system skills. */
export function exposedSkills(): ExposedSkill[] {
  const fromAgents = localSpecialists().flatMap((agent) =>
    agent.remoteCapabilities().map((capability) => ({
      id: `${agent.definition.id}.${capability.name}`,
      agentId: agent.definition.id,
      capability: capability.name,
      description: capability.description,
      examples: [...(capability.examples ?? [])],
    })),
  );
  const system = SYSTEM_SKILLS.map((skill) => ({
    id: skill.id,
    agentId: "system",
    capability: skill.id.split(".")[1]!,
    description: skill.description,
    examples: skill.examples,
    system: true,
  }));
  return [...fromAgents, ...system];
}

export interface CardOptions {
  /** The address callers use (a Tailscale or tunnel URL). Defaults to loopback. */
  publicUrl?: string;
  /** Push notifications are offered only when callback origins are allowlisted. */
  push?: boolean;
}

export function buildAgentCard(port: number, options: CardOptions = {}): AgentCard {
  const url = options.publicUrl?.replace(/\/+$/, "") || `http://${HOST}:${port}`;
  return {
    name: "Aadi",
    description:
      "Vishnu's personal assistant. Other agents can call the skills listed here. Send a data part { skill, input }, optionally with task: { goal, constraints, relevant_input, expected_output, correlation_id, deadline }.",
    supportedInterfaces: [{ url, protocolBinding: "HTTP+JSON", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: undefined,
    version: "1.1.0",
    capabilities: { streaming: true, pushNotifications: options.push === true, extensions: [], extendedAgentCard: false },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: { description: "One bearer credential per calling agent.", scheme: "Bearer", bearerFormat: "opaque" },
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: exposedSkills().map((skill) => ({
      id: skill.id,
      name: skill.id,
      description: skill.description,
      tags: skill.system ? ["system", "read-only", "test"] : [skill.agentId, "read-only"],
      examples: skill.examples,
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    })),
    signatures: [],
  };
}

/** Which client a bearer credential belongs to. Every comparison runs, in constant time. */
export function identifyClient(header: string | undefined, clients: readonly A2aServerClient[]): A2aServerClient | undefined {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? "")?.[1] ?? "");
  let match: A2aServerClient | undefined;
  for (const client of clients) {
    const wanted = Buffer.from(client.token);
    if (given.length === wanted.length && timingSafeEqual(given, wanted) && !match) {
      match = client;
    }
  }
  return match;
}

/** Set by the auth middleware and read by the executor, through the SDK's call context. */
interface Exchange {
  peerId: string;
  transport: string;
  taskIds: Set<string>;
}

class PeerUser {
  constructor(
    readonly userName: string,
    readonly exchange: Exchange,
  ) {}

  get isAuthenticated(): boolean {
    return true;
  }
}

function exchangeOf(context: ServerCallContext): Exchange | undefined {
  const user = context.user;
  return user instanceof PeerUser ? user.exchange : undefined;
}

/** Push callbacks only go to allowlisted origins, checked when set and when sent. */
class AllowlistedPushStore implements PushNotificationStore {
  private readonly inner = new InMemoryPushNotificationStore();

  constructor(private readonly origins: readonly string[]) {}

  private allowed(url: string): boolean {
    try {
      return this.origins.includes(new URL(url).origin);
    } catch {
      return false;
    }
  }

  async save(taskId: string, context: ServerCallContext, pushConfig: TaskPushNotificationConfig): Promise<void> {
    if (!this.allowed(pushConfig.url)) {
      throw new Error("Push notification URL is not on Aadi's allowlist.");
    }
    await this.inner.save(taskId, context, pushConfig);
  }

  async load(taskId: string, context: ServerCallContext): Promise<TaskPushNotificationConfig[]> {
    return (await this.inner.load(taskId, context)).filter((item) => this.allowed(item.url));
  }

  async delete(taskId: string, context: ServerCallContext, configId?: string): Promise<void> {
    await (this.inner as unknown as { delete(t: string, c: ServerCallContext, id?: string): Promise<void> }).delete(
      taskId,
      context,
      configId,
    );
  }
}

/** Keeps the latest snapshot of a task and saves it on every event. */
class TaskRecorder {
  private snapshot: Task;

  constructor(
    initial: Task,
    private readonly owner: string,
    private readonly bus: ExecutionEventBus,
  ) {
    this.snapshot = initial;
    this.save();
  }

  private save(): void {
    try {
      saveTaskSnapshot(this.snapshot, this.owner);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`a2a server: could not save task ${this.snapshot.id} (${errorType}).`);
    }
  }

  get task(): Task {
    return this.snapshot;
  }

  publishTask(task: Task): void {
    this.snapshot = task;
    this.save();
    this.bus.publish(AgentEvent.task(task));
  }

  status(state: WireState, message?: string, final = false): void {
    const status = {
      state,
      message: message
        ? newMessage({ role: "agent", parts: [textPart(message)], taskId: this.snapshot.id, contextId: this.snapshot.contextId })
        : undefined,
      timestamp: new Date().toISOString(),
    };
    this.snapshot = { ...this.snapshot, status };
    this.save();
    this.bus.publish(
      AgentEvent.statusUpdate({ taskId: this.snapshot.id, contextId: this.snapshot.contextId, status, metadata: undefined }),
    );
    if (final) {
      this.bus.finished();
    }
  }

  artifact(artifact: WireArtifact, lastChunk: boolean): void {
    const others = this.snapshot.artifacts.filter((item) => item.artifactId !== artifact.artifactId);
    this.snapshot = { ...this.snapshot, artifacts: [...others, artifact] };
    this.save();
    this.bus.publish(
      AgentEvent.artifactUpdate({
        taskId: this.snapshot.id,
        contextId: this.snapshot.contextId,
        artifact,
        append: false,
        lastChunk,
        metadata: undefined,
      }),
    );
  }
}

function resultArtifacts(result: AgentTaskResult): WireArtifact[] {
  return [
    ...(result.text ? [{ artifactId: "result", name: "result", kind: "text" as const, text: result.text }] : []),
    ...(result.output ? [{ artifactId: "output", name: "output", kind: "data" as const, data: result.output }] : []),
    ...(result.artifacts ?? []),
  ].map(toWireArtifact);
}

function isFinal(state: WireState | undefined): boolean {
  return (
    state === WireState.TASK_STATE_COMPLETED ||
    state === WireState.TASK_STATE_FAILED ||
    state === WireState.TASK_STATE_CANCELED ||
    state === WireState.TASK_STATE_REJECTED
  );
}

class AadiExecutor implements AgentExecutor {
  private readonly running = new Map<string, AbortController>();

  /** Another agent's request: its own place in the global scheduler, below Vishnu's turns. */
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    await runWithPriority("a2a", () => withSlot("a2a", () => this.run(requestContext, eventBus)));
  }

  private async run(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;
    const owner = ownerOf(requestContext.context);
    const exchange = exchangeOf(requestContext.context);
    exchange?.taskIds.add(taskId);
    const transport = exchange?.transport ?? "http+json";
    const recorder = new TaskRecorder(
      {
        id: taskId,
        contextId,
        status: { state: toWireState("submitted"), message: undefined, timestamp: new Date().toISOString() },
        artifacts: requestContext.task?.artifacts ?? [],
        history: [...(requestContext.task?.history ?? []), userMessage],
        metadata: undefined,
      },
      owner,
      eventBus,
    );
    // submitted, then working, then the result, then the final state.
    eventBus.publish(AgentEvent.task(recorder.task));
    recorder.status(WireState.TASK_STATE_WORKING);

    const data = partsData(userMessage.parts) ?? {};
    const skillId = String(data.skill ?? localTaskFor(taskId, owner).skill ?? "");
    logTaskStart({ direction: "inbound", peerId: owner, taskId, contextId, skill: skillId || undefined, transport });

    // The same message again (a retry after a lost connection): report the
    // first task's outcome; never run the work twice.
    const earlier = claimMessage(owner, userMessage.messageId, taskId);
    if (earlier) {
      const first = loadTaskSnapshot(earlier, owner);
      for (const artifact of first?.artifacts ?? []) {
        recorder.artifact(artifact, false);
      }
      recorder.artifact(toWireArtifact({ artifactId: "duplicate", name: "duplicate", kind: "data", data: { duplicate_of: earlier } }), true);
      const state = first?.status?.state ?? WireState.TASK_STATE_WORKING;
      recorder.status(
        isFinal(state) ? state : WireState.TASK_STATE_REJECTED,
        `This message was already received as task ${earlier}. Read that task instead of sending again.`,
        true,
      );
      logTaskEnd({ direction: "inbound", peerId: owner, taskId, state: "duplicate", success: true });
      console.log(`a2a server: peer=${owner} task=${taskId} duplicate_of=${earlier}`);
      return;
    }

    const controller = new AbortController();
    this.running.set(taskId, controller);
    // A remote caller gets a grant that says exactly what it is: another agent.
    const grant = issueGrant({ source: "remote_agent" });
    let result: AgentTaskResult;
    try {
      const input = data.input && typeof data.input === "object" ? (data.input as Record<string, unknown>) : {};
      const envelope = data.task && typeof data.task === "object" ? (data.task as Record<string, unknown>) : undefined;
      const known = localTaskFor(taskId, owner).localTaskId;
      const system = SYSTEM_SKILLS.find((skill) => skill.id === skillId);
      if (known && getTask(known)) {
        const continued = await continueTask(known, { ...input, answer: partsText(userMessage.parts) }, grant);
        result = continued ?? {
          taskId: known,
          contextId,
          state: "failed",
          error: { code: "failed", message: "That task is not waiting for input.", retryable: false },
        };
      } else if (system) {
        const produced = await system.run(
          { ...input, ...(envelope?.correlation_id ? { correlation_id: envelope.correlation_id } : {}) },
          (message) => recorder.status(WireState.TASK_STATE_WORKING, message),
          controller.signal,
        );
        result = { taskId, contextId, state: "completed", text: produced.text, output: produced.data };
      } else {
        const skill = exposedSkills().find((item) => item.id === skillId && !item.system);
        if (!skill) {
          result = {
            taskId,
            contextId,
            state: "rejected",
            error: {
              code: "not_authorized",
              message: `No skill "${skillId}" is open to other agents. Send a data part { skill, input } naming one from the agent card.`,
              retryable: false,
            },
          };
        } else {
          result = await delegate({
            agentId: skill.agentId,
            capability: skill.capability,
            input,
            origin: "a2a",
            grant,
            title: `A2A ${skill.id} (${owner})`,
            maxAttempts: 1,
            deadlineMs: SPECIALIST_DEADLINE_MS,
          });
          setLocalTask(taskId, owner, result.taskId, skill.id);
        }
      }
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`a2a server: task failed (${errorType}).`);
      result = controller.signal.aborted
        ? { taskId, contextId, state: "canceled" }
        : { taskId, contextId, state: "failed", error: { code: "failed", message: "The task failed.", retryable: false } };
    } finally {
      revokeGrant(grant.ref);
      this.running.delete(taskId);
    }

    if (result.state === "completed") {
      const artifacts = resultArtifacts(result);
      artifacts.forEach((artifact, index) => recorder.artifact(artifact, index === artifacts.length - 1));
    }
    const text =
      result.state === "completed" ? "" : result.inputRequired?.question ?? result.error?.message ?? result.text ?? "";
    recorder.status(toWireState(result.state), text || undefined, true);
    logTaskEnd({
      direction: "inbound",
      peerId: owner,
      taskId,
      state: result.state,
      success: result.state === "completed",
      error: result.error?.code,
    });
    console.log(`a2a server: peer=${owner} task=${taskId} skill=${skillId || "-"} transport=${transport} state=${result.state}`);
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.running.get(taskId)?.abort();
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: "",
        status: { state: toWireState("canceled"), message: undefined, timestamp: new Date().toISOString() },
        metadata: undefined,
      }),
    );
    eventBus.finished();
  }

  /** Cancels Aadi's own task behind an A2A task as well. */
  async cancelLocal(taskId: string, owner: string): Promise<void> {
    const local = localTaskFor(taskId, owner).localTaskId;
    if (local) {
      await cancelTask(local, "Canceled by the calling agent.");
    }
  }
}

export interface A2aServer {
  port: number;
  close(): void;
}

export interface A2aServerOptions {
  port?: number;
  /** One shared credential, kept for older setups and tests. Its client id is "default". */
  token?: string;
  clients?: readonly A2aServerClient[];
  enabled?: boolean;
  publicUrl?: string;
  pushAllowedOrigins?: readonly string[];
}

/** What kind of exchange a request is, from its path. */
function requestKind(path: string): { kind: string; taskId?: string; transport: string } {
  const task = /\/tasks\/([^/:]+)(?::(subscribe|cancel))?/.exec(path);
  if (/message:stream$/.test(path)) {
    return { kind: "stream", transport: "http+json+sse" };
  }
  if (/message:send$/.test(path)) {
    return { kind: "send", transport: "http+json" };
  }
  if (task?.[2] === "subscribe") {
    return { kind: "subscribe", taskId: decodeURIComponent(task[1]!), transport: "http+json+sse" };
  }
  if (task?.[2] === "cancel") {
    return { kind: "cancel", taskId: decodeURIComponent(task[1]!), transport: "http+json" };
  }
  if (task) {
    return { kind: path.includes("pushNotificationConfigs") ? "push-config" : "get", taskId: decodeURIComponent(task[1]!), transport: "http+json" };
  }
  return { kind: path.includes("agent-card") ? "card" : "other", transport: "http+json" };
}

/** Starts the endpoint when it is switched on. Returns undefined when it is off. */
export async function startA2aServer(options: A2aServerOptions = {}): Promise<A2aServer | undefined> {
  const enabled = options.enabled ?? config.a2aServerEnabled;
  if (!enabled) {
    return undefined;
  }
  const clients: A2aServerClient[] = [
    ...(options.clients ?? (options.token ? [] : config.a2aServerClients)),
    ...(options.token ? [{ id: "default", token: options.token }] : []),
  ];
  if (clients.length === 0 || clients.some((client) => client.token.length < 24)) {
    throw new Error("The A2A endpoint needs one or more client credentials of at least 24 characters.");
  }
  const port = options.port ?? config.a2aServerPort;
  const pushOrigins = options.pushAllowedOrigins ?? config.a2aPushAllowedOrigins;
  const card = buildAgentCard(port, { publicUrl: options.publicUrl ?? config.a2aPublicUrl, push: pushOrigins.length > 0 });
  const executor = new AadiExecutor();
  const pushStore = pushOrigins.length > 0 ? new AllowlistedPushStore(pushOrigins) : undefined;
  const handler = new DefaultRequestHandler(
    card,
    new SqliteTaskStore(),
    executor,
    undefined,
    pushStore,
    pushStore ? new DefaultPushNotificationSender(pushStore) : undefined,
  );
  sweepServerTasks();
  const app = express();
  app.disable("x-powered-by");
  // Push callbacks for Aadi's own long tasks elsewhere. The one-off secret in
  // the URL's waiter is the credential; the body is ignored ("look now" only).
  app.post("/push/:id", (request: Request, response: Response) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1];
    const token = request.get("x-a2a-notification-token") ?? bearer;
    const ok = receivePush(String(request.params.id ?? ""), token);
    request.resume();
    response.status(ok ? 204 : 401).end();
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const client = identifyClient(request.headers.authorization, clients);
    if (!client) {
      response.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
      return;
    }
    const kind = requestKind(request.path);
    const exchange: Exchange = { peerId: client.id, transport: kind.transport, taskIds: new Set(kind.taskId ? [kind.taskId] : []) };
    response.locals.exchange = exchange;
    // Bytes in from the declared length, bytes out as they are written.
    const bytesIn = Number(request.headers["content-length"] ?? 0) || 0;
    let bytesOut = 0;
    const write = response.write.bind(response) as (...args: unknown[]) => boolean;
    const end = response.end.bind(response) as (...args: unknown[]) => Response;
    const count = (chunk: unknown): void => {
      if (typeof chunk === "string") {
        bytesOut += Buffer.byteLength(chunk);
      } else if (chunk instanceof Uint8Array) {
        bytesOut += chunk.byteLength;
      }
    };
    (response as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
      count(args[0]);
      return write(...args);
    };
    (response as unknown as { end: (...args: unknown[]) => Response }).end = (...args: unknown[]) => {
      if (typeof args[0] !== "function") {
        count(args[0]);
      }
      return end(...args);
    };
    let finished = false;
    response.once("finish", () => {
      finished = true;
    });
    response.once("close", () => {
      const disconnect = !finished && (kind.kind === "stream" || kind.kind === "subscribe");
      for (const taskId of exchange.taskIds) {
        logTaskTraffic({
          direction: "inbound",
          peerId: client.id,
          taskId,
          bytesIn,
          bytesOut,
          disconnect,
          reconcile: kind.kind === "get" || kind.kind === "subscribe",
        });
      }
      if (disconnect) {
        console.log(`a2a server: peer=${client.id} stream closed early tasks=[${[...exchange.taskIds].join(",")}]`);
      }
    });
    if (kind.kind === "cancel" && kind.taskId) {
      void executor.cancelLocal(kind.taskId, client.id).catch(() => undefined);
    }
    next();
  });
  // The SDK sends the card as given, so hand it the spec's JSON form (oneofs flattened).
  const wireCard = AgentCard.toJSON(card) as AgentCard;
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: async () => wireCard }));
  app.use(
    restHandler({
      requestHandler: handler,
      userBuilder: async (request: Request) => {
        const exchange = (request.res?.locals.exchange as Exchange | undefined) ?? {
          peerId: "unknown",
          transport: "http+json",
          taskIds: new Set<string>(),
        };
        return new PeerUser(exchange.peerId, exchange);
      },
    }),
  );
  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(port, HOST, () => resolve(listening));
    listening.once("error", reject);
  });
  console.log(
    `A2A endpoint listening on ${HOST}:${port} (${card.skills.length} skill(s), ${clients.length} client credential(s), push ${pushStore ? "on" : "off"}).`,
  );
  return {
    port,
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}
