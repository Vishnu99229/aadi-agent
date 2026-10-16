export class SendNotApprovedError extends Error {
  constructor() {
    super("Send is only allowed after an approval button tap.");
    this.name = "SendNotApprovedError";
  }
}

const SEND_CALLBACK = /^approval:send:(\d+)$/;

export function parseSendApprovalCallback(
  data: string | undefined,
): number | undefined {
  const match = SEND_CALLBACK.exec(data ?? "");
  if (!match) {
    return undefined;
  }
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function allowSendDraft(params: {
  callbackData: string | undefined;
  actionId: number;
  actionStatus: string;
}): void {
  const approvedId = parseSendApprovalCallback(params.callbackData);
  if (
    approvedId !== params.actionId ||
    params.actionStatus !== "pending"
  ) {
    throw new SendNotApprovedError();
  }
}
