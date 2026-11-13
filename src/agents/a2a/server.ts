import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, AgentCard, type Task } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { agentCardHandler, restHandler } from "@a2a-js/sdk/server/express";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "../../config.js";
import { issueGrant, revokeGrant } from "../auth.js";
import { cancelTask, continueTask, delegate } from "../engine.js";
import { localSpecialists } from "../index.js";
import { getTask } from "../store.js";
import type { AgentTaskResult } from "../types.js";
import { newMessage, partsData, partsText, textPart, toWireArtifact, toWireState } from "./mapping.js";

/**
 * Aadi's A2A endpoint (A2A 1.0, HTTP+JSON, official SDK). Off unless
 * A2A_SERVER_ENABLED is set, bound to loopback only, and behind a bearer token.
 * A caller is another agent, never Vishnu: it can reach only the capabilities an
 * agent has marked remoteExposed (reads), and nothing it says is an approval.
 */
const HOST = "127.0.0.1";

/** "agent.capability" for every capability another agent may call. */
export function exposedSkills(): Array<{ id: string; agentId: string; capability: string; description: string; examples: string[] }> {
  return localSpecialists().flatMap((agent) =>
    agent.remoteCapabilities().map((capability) => ({
      id: `${agent.definition.id}.${capability.name}`,
      agentId: agent.definition.id,
      capability: capability.name,
      description: capability.description,
      examples: [...(capability.examples ?? [])],
    })),
  );
}

export function buildAgentCard(port: number): AgentCard {
  return {
    name: "Aadi",
    description:
      "Vishnu's personal assistant. Other agents can call the read-only skills listed here. Send a data part: { skill, input }.",
    supportedInterfaces: [
      { url: `http://${HOST}:${port}`, protocolBinding: "HTTP+JSON", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    provider: undefined,
    version: "1.0.0",
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: { description: "Shared bearer token.", scheme: "Bearer", bearerFormat: "opaque" },
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
      tags: [skill.agentId, "read-only"],
      examples: skill.examples,
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    })),
    signatures: [],
  };
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(header ?? "")?.[1] ?? "");
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

class AadiExecutor implements AgentExecutor {
  /** A2A task id -> Aadi's own task id, so a follow-up continues the same task. */
  private readonly localTaskIds = new Map<string, string>();

  private status(taskId: string, contextId: string, result: AgentTaskResult) {
    const text =
      result.state === "completed"
        ? ""
        : result.inputRequired?.question ?? result.error?.message ?? result.text ?? "";
    return AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: {
        state: toWireState(result.state),
        message: text ? newMessage({ role: "agent", parts: [textPart(text)], taskId, contextId }) : undefined,
        timestamp: new Date().toISOString(),
      },
      metadata: undefined,
    });
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;
    const snapshot: Task = {
      id: taskId,
      contextId,
      status: { state: toWireState("working"), message: undefined, timestamp: new Date().toISOString() },
      artifacts: requestContext.task?.artifacts ?? [],
      history: [...(requestContext.task?.history ?? []), userMessage],
      metadata: undefined,
    };
    eventBus.publish(AgentEvent.task(snapshot));

    // A remote caller gets a grant that says exactly what it is: another agent.
    const grant = issueGrant({ source: "remote_agent" });
    let result: AgentTaskResult;
    try {
      const data = partsData(userMessage.parts) ?? {};
      const known = this.localTaskIds.get(taskId);
      if (known && getTask(known)) {
        const input = data.input && typeof data.input === "object" ? (data.input as Record<string, unknown>) : {};
        const continued = await continueTask(known, { ...input, answer: partsText(userMessage.parts) }, grant);
        result = continued ?? {
          taskId: known,
          contextId,
          state: "failed",
          error: { code: "failed", message: "That task is not waiting for input.", retryable: false },
        };
      } else {
        const skillId = String(data.skill ?? "");
        const skill = exposedSkills().find((item) => item.id === skillId);
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
            input: data.input && typeof data.input === "object" ? (data.input as Record<string, unknown>) : {},
            origin: "a2a",
            grant,
            title: `A2A ${skill.id}`,
            maxAttempts: 1,
            deadlineMs: 60_000,
          });
          this.localTaskIds.set(taskId, result.taskId);
          if (this.localTaskIds.size > 500) {
            this.localTaskIds.delete(this.localTaskIds.keys().next().value!);
          }
        }
      }
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      console.error(`a2a server: task failed (${errorType}).`);
      result = {
        taskId,
        contextId,
        state: "failed",
        error: { code: "failed", message: "The task failed.", retryable: false },
      };
    } finally {
      revokeGrant(grant.ref);
    }

    if (result.state === "completed") {
      const artifacts = [
        ...(result.text ? [{ artifactId: "result", name: "result", kind: "text" as const, text: result.text }] : []),
        ...(result.output ? [{ artifactId: "output", name: "output", kind: "data" as const, data: result.output }] : []),
        ...(result.artifacts ?? []),
      ];
      artifacts.forEach((artifact, index) => {
        eventBus.publish(
          AgentEvent.artifactUpdate({
            taskId,
            contextId,
            artifact: toWireArtifact(artifact),
            append: false,
            lastChunk: index === artifacts.length - 1,
            metadata: undefined,
          }),
        );
      });
    }
    eventBus.publish(this.status(taskId, contextId, result));
    eventBus.finished();
    console.log(`a2a server: task=${taskId} state=${result.state}`);
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const local = this.localTaskIds.get(taskId);
    if (local) {
      await cancelTask(local, "Canceled by the calling agent.");
    }
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: local ? getTask(local)?.context_id ?? "" : "",
        status: { state: toWireState("canceled"), message: undefined, timestamp: new Date().toISOString() },
        metadata: undefined,
      }),
    );
    eventBus.finished();
  }
}

export interface A2aServer {
  port: number;
  close(): void;
}

/** Starts the endpoint when it is switched on. Returns undefined when it is off. */
export async function startA2aServer(options: { port?: number; token?: string; enabled?: boolean } = {}): Promise<A2aServer | undefined> {
  const enabled = options.enabled ?? config.a2aServerEnabled;
  const token = options.token ?? config.a2aServerToken;
  if (!enabled) {
    return undefined;
  }
  if (token.length < 24) {
    throw new Error("The A2A endpoint needs a token of at least 24 characters.");
  }
  const port = options.port ?? config.a2aServerPort;
  const card = buildAgentCard(port);
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new AadiExecutor());
  const app = express();
  app.disable("x-powered-by");
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!tokenMatches(request.headers.authorization, token)) {
      response.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
      return;
    }
    next();
  });
  // The SDK sends the card as given, so hand it the spec's JSON form (oneofs flattened).
  const wireCard = AgentCard.toJSON(card) as AgentCard;
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: async () => wireCard }));
  app.use(
    restHandler({
      requestHandler: handler,
      userBuilder: async () => ({ isAuthenticated: true, userName: "a2a-peer" }),
    }),
  );
  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(port, HOST, () => resolve(listening));
    listening.once("error", reject);
  });
  console.log(`A2A endpoint listening on ${HOST}:${port} (${card.skills.length} skill(s) open to other agents).`);
  return {
    port,
    close: () => {
      server.close();
    },
  };
}
