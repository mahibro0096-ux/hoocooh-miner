const { validateInitData } = require("../lib/telegramAuth");

let cachedBotInfo = null;
async function getBotInfo(botToken) {
  if (cachedBotInfo) return cachedBotInfo;
  const botId = botToken.split(":")[0];
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await res.json();
    if (data.ok && data.result) {
      cachedBotInfo = { id: data.result.id, username: data.result.username || "HOOCOOH Bot" };
      return cachedBotInfo;
    }
  } catch(e) {}
  return { id: botId, username: "HOOCOOH Bot" };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not configured" });
    return;
  }

  const initData = req.headers["x-telegram-init-data"];
  const tgUser = validateInitData(initData, botToken);
  if (!tgUser) {
    res.status(401).json({ error: "Invalid session - reopen app from Telegram" });
    return;
  }

  let { channel } = req.body || {};
  if (!channel || typeof channel !== "string") {
    res.status(400).json({ error: "Please provide a valid channel or group username" });
    return;
  }

  channel = channel.trim();
  channel = channel.replace(/https?:\/\/t\.me\//i, "").replace(/^@/, "").trim();
  if (!channel) {
    res.status(400).json({ error: "Invalid username format" });
    return;
  }

  const chatId = "@" + channel;

  try {
    // 1. Get bot's own user ID and username from cache
    const botInfo = await getBotInfo(botToken);
    const botId = botInfo.id;
    const botUsername = botInfo.username;

    // 2. Check chat member status of bot in that channel/group
    const memberRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${botId}`
    );
    const memberData = await memberRes.json();

    if (!memberData.ok) {
      res.status(400).json({
        ok: false,
        verified: false,
        error: `Bot @${botUsername} is not in ${chatId}. Please add @${botUsername} as an Admin in your channel or group first!`
      });
      return;
    }

    const status = memberData.result && memberData.result.status;
    if (status === "administrator" || status === "creator") {
      res.status(200).json({
        ok: true,
        verified: true,
        channel: chatId,
        botUsername,
        status: status,
        message: `Verified! Bot @${botUsername} is confirmed as Admin in ${chatId}.`
      });
    } else {
      res.status(400).json({
        ok: false,
        verified: false,
        error: `Bot @${botUsername} is only a member in ${chatId}, not an Admin. Please promote @${botUsername} to Admin!`
      });
    }
  } catch (err) {
    console.error("verify-channel error:", err);
    res.status(500).json({ error: err.message || "Failed to verify channel admin status" });
  }
};
