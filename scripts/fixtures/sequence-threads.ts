// Invented threads for sequence tests. No real people, companies or mail.
import type { gmail_v1 } from "googleapis";

export const FIXTURE_ME = "vishnu.rajan@epicode.in";

export interface FixtureMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  sentAt: number;
  sent: boolean;
  body: string;
  messageId: string;
  references?: string;
}

const DAY = 24 * 60 * 60 * 1000;

function pitchMessage(input: {
  id: string;
  to: string;
  subject: string;
  body: string;
  ageDays: number;
}): FixtureMessage {
  return {
    id: input.id,
    from: `Vishnu Rajan <${FIXTURE_ME}>`,
    to: input.to,
    subject: input.subject,
    sentAt: Date.now() - input.ageDays * DAY,
    sent: true,
    body: input.body,
    messageId: `<${input.id}@mail.example>`,
  };
}

export const DEMO_PITCH = {
  threadId: "fixture-demo",
  prospectEmail: "priya@acmefoods.example",
  prospectName: "Priya Shah",
  prospectCompany: "Acmefoods",
  subject: "IraVoice for Acme Foods support",
  build: (): FixtureMessage[] => [
    pitchMessage({
      id: "fixture-demo-1",
      to: "Priya Shah <priya@acmefoods.example>",
      subject: "IraVoice for Acme Foods support",
      ageDays: 3,
      body: "Hi Priya,\n\nI lead GTM at Epicode. We build IraVoice, a voice agent that answers inbound support calls in Hindi and English. Acme Foods takes a lot of order-status calls, so I thought it might be useful.\n\nWould you be open to a short demo next week?\n\nThanks,\nVishnu",
    }),
  ],
};

export const PARTNERSHIP_PITCH = {
  threadId: "fixture-partner",
  prospectEmail: "mira@callcloud.example",
  prospectName: "Mira Das",
  prospectCompany: "Callcloud",
  subject: "Epicode <> CallCloud - exploring a telephony and dialer partnership",
  build: (): FixtureMessage[] => [
    pitchMessage({
      id: "fixture-partner-1",
      to: "Mira Das <mira@callcloud.example>",
      subject: "Epicode <> CallCloud - exploring a telephony and dialer partnership",
      ageDays: 3,
      body: "Hi Mira,\n\nI work on partnerships at Epicode. We run an outbound dialer and voice agents for contact centres in India. I think there is a fit between our telephony and the CallCloud platform as a technology partnership.\n\nCould we find time for a call to explore it?\n\nThanks,\nVishnu",
    }),
  ],
};

export const MEETING_PITCH = {
  threadId: "fixture-meeting",
  prospectEmail: "omar@brightbank.example",
  prospectName: "Omar Ali",
  prospectCompany: "Brightbank",
  subject: "BotCompose at Bright Bank",
  build: (): FixtureMessage[] => [
    pitchMessage({
      id: "fixture-meeting-1",
      to: "Omar Ali <omar@brightbank.example>",
      subject: "BotCompose at Bright Bank",
      ageDays: 3,
      body: "Hi Omar,\n\nEpicode builds BotCompose, which lets a support team build a voice bot without writing code. I'd like to understand how Bright Bank handles support calls today.\n\nCould we meet for a few minutes next week?\n\nThanks,\nVishnu",
    }),
  ],
};

export function toGmailMessage(
  threadId: string,
  message: FixtureMessage,
): gmail_v1.Schema$Message {
  return {
    id: message.id,
    threadId,
    internalDate: String(message.sentAt),
    labelIds: message.sent ? ["SENT"] : ["INBOX"],
    snippet: message.body.slice(0, 120),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: message.from },
        { name: "To", value: message.to },
        { name: "Subject", value: message.subject },
        { name: "Message-ID", value: message.messageId },
        { name: "References", value: message.references ?? "" },
      ],
      body: { data: Buffer.from(message.body, "utf8").toString("base64url") },
    },
  };
}

export function fixtureGmail(
  threads: Map<string, FixtureMessage[]>,
  log: { created: string[]; sent: string[]; deleted: string[] },
): gmail_v1.Gmail {
  return {
    users: {
      getProfile: async () => ({ data: { emailAddress: FIXTURE_ME } }),
      settings: {
        sendAs: {
          list: async () => ({
            data: {
              sendAs: [
                {
                  sendAsEmail: FIXTURE_ME,
                  isDefault: true,
                  signature: "<div>Vishnu Rajan<br>GTM, Epicode</div>",
                },
              ],
            },
          }),
        },
      },
      threads: {
        get: async ({ id }: { id: string }) => ({
          data: {
            id,
            messages: (threads.get(id) ?? []).map((message) => toGmailMessage(id, message)),
          },
        }),
      },
      messages: {
        list: async () => ({ data: { messages: [] } }),
        send: async () => {
          log.sent.push("messages.send");
          return { data: { id: "fixture-never" } };
        },
      },
      drafts: {
        create: async ({
          requestBody,
        }: {
          requestBody: { message: { raw: string; threadId?: string } };
        }) => {
          log.created.push(Buffer.from(requestBody.message.raw, "base64url").toString("utf8"));
          return { data: { id: `fixture-draft-${log.created.length}` } };
        },
        send: async ({ requestBody }: { requestBody: { id: string } }) => {
          log.sent.push(requestBody.id);
          return { data: { id: `fixture-sent-${log.sent.length}` } };
        },
        delete: async ({ id }: { id: string }) => {
          log.deleted.push(id);
          return { data: {} };
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
}
