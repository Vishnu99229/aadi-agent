// Live Telegram API check for Stage A (no inbound user message).
// Usage: tsx --env-file=.env scripts/live-telegram-turn.ts
import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatId = process.env.OWNER_TELEGRAM_ID?.trim();
if (!token || !chatId) {
  console.error("live-telegram-turn: TELEGRAM_BOT_TOKEN or OWNER_TELEGRAM_ID missing");
  process.exit(1);
}

const getMe = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const me = (await getMe.json()) as {
  ok?: boolean;
  result?: { username?: string; id?: number };
};
console.log(
  `getMe ok=${me.ok === true} bot_id=${me.result?.id ?? "none"} username=${me.result?.username ?? "none"}`,
);

const typing = await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: Number(chatId), action: "typing" }),
});
const typed = (await typing.json()) as { ok?: boolean };
console.log(`sendChatAction typing ok=${typed.ok === true}`);

if (me.ok !== true || typed.ok !== true) {
  process.exit(1);
}
