/**
 * Discord notification mirror.
 * Sends plain-text versions of Telegram alerts to a Discord channel via bot API.
 */

const TOKEN      = process.env.DISCORD_BOT_TOKEN || null;
const CHANNEL_ID = process.env.DISCORD_NOTIFY_CHANNEL_ID || null;
const BASE       = "https://discord.com/api/v10";

function stripHtml(html) {
  return html
    .replace(/<b>(.*?)<\/b>/g, "**$1**")
    .replace(/<code>(.*?)<\/code>/g, "`$1`")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export async function discordSend(text) {
  if (!TOKEN || !CHANNEL_ID) return;
  try {
    await fetch(`${BASE}/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bot ${TOKEN}`,
      },
      body: JSON.stringify({ content: String(text).slice(0, 2000) }),
    });
  } catch { /* non-blocking — Telegram is primary */ }
}

export async function discordSendHtml(html) {
  await discordSend(stripHtml(html));
}
