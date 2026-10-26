// Fakes for tests and evals: no real Telegram client, Gmail account or model.
import type { Api } from "grammy";
import type { gmail_v1 } from "googleapis";
import type { CompleteParams, CompleteResult, ToolCall } from "../src/llm.ts";

let messageCounter = 1000;

/** One increasing id sequence for Vishnu's messages and Aadi's cards, like a
 *  real Telegram chat. */
export function nextMessageId(): number {
  messageCounter += 1;
  return messageCounter;
}

export interface TelegramLog {
  sent: string[];
  edited: string[];
}

export function fakeTelegramApi(log: TelegramLog): Api {
  return {
    sendMessage: async (_chatId: unknown, text: string) => {
      log.sent.push(text);
      return {
        message_id: nextMessageId(),
        date: 0,
        chat: { id: 1, type: "private", first_name: "Vishnu" },
        text,
      };
    },
    editMessageText: async (_chatId: unknown, _messageId: unknown, text: string) => {
      log.edited.push(text);
      return true;
    },
  } as unknown as Api;
}

export interface GmailLog {
  sent: string[];
  created: string[];
}

export const TEST_SIGNATURE_HTML =
  '<div dir="ltr">Vishnu Rajan<br>GTM, Epicode &amp; Partners</div>';

export function fakeGmail(log: GmailLog): gmail_v1.Gmail {
  return {
    users: {
      drafts: {
        send: async ({ requestBody }: { requestBody: { id: string } }) => {
          log.sent.push(requestBody.id);
          return { data: { id: `sent-${requestBody.id}` } };
        },
        get: async ({ id }: { id: string }) => ({
          data: {
            id,
            message: {
              payload: { headers: [{ name: "To", value: "Priya <priya@acme.com>" }] },
            },
          },
        }),
        delete: async () => ({ data: {} }),
        create: async ({
          requestBody,
        }: {
          requestBody: { message: { raw: string } };
        }) => {
          log.created.push(
            Buffer.from(requestBody.message.raw, "base64url").toString("utf8"),
          );
          const n = log.created.length;
          return { data: { id: `draft-${n}`, message: { threadId: `thread-${n}` } } };
        },
      },
      settings: {
        sendAs: {
          list: async () => ({
            data: {
              sendAs: [
                { sendAsEmail: "vishnu@epicode.example", isDefault: true, signature: TEST_SIGNATURE_HTML },
              ],
            },
          }),
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
}

export function modelReply(step: {
  text?: string;
  tools?: Array<{ name: string; input?: unknown }>;
}): CompleteResult {
  const toolCalls: ToolCall[] = (step.tools ?? []).map((tool, index) => ({
    id: `call-${nextMessageId()}-${index}`,
    name: tool.name,
    input: tool.input ?? {},
    execution: "client",
  }));
  return {
    textParts: step.text ? [step.text] : [],
    toolCalls,
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
  };
}

export type ScriptedStep = {
  text?: string;
  tools?: Array<{ name: string; input?: unknown }>;
};

/** A stand-in chat model. `decide` plays the first step from Vishnu's message;
 *  later steps reply with the tool results verbatim. Calls without tools
 *  (memory extraction, summaries) get `background()`. */
export function scriptedModel(
  decide: (userText: string) => ScriptedStep,
  background: () => string = () => '{"facts":[]}',
): {
  fake: (params: CompleteParams) => Promise<CompleteResult>;
  chatCalls: () => number;
} {
  let chat = 0;
  const fake = async (params: CompleteParams): Promise<CompleteResult> => {
    if (params.tools.length === 0) {
      return modelReply({ text: background() });
    }
    chat += 1;
    const last = params.messages.at(-1);
    if (last?.role === "tool") {
      const results: string[] = [];
      for (let i = params.messages.length - 1; i >= 0; i -= 1) {
        const message = params.messages[i]!;
        if (message.role !== "tool") {
          break;
        }
        results.unshift(message.content);
      }
      return modelReply({ text: results.join("\n") });
    }
    const text = last?.role === "user" && typeof last.content === "string" ? last.content : "";
    return modelReply(decide(text));
  };
  return { fake, chatCalls: () => chat };
}
