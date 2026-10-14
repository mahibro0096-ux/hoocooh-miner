const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const { MAX_TAP_ENERGY, ENERGY_RECHARGE_RATE_MS, calculateCurrentEnergy } = require("../lib/gameLogic");
const { checkVelocityLimit } = require("../lib/velocityLimiter");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not set in Vercel settings" });
    return;
  }

  const initData = req.headers["x-telegram-init-data"];
  const tgUser = validateInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!tgUser) {
    res.status(401).json({ error: "Invalid session - reopen app from Telegram" });
    return;
  }
  const telegramId = String(tgUser.id);

  // Velocity Check: Max 60 tap syncs per minute per user/IP
  if (!checkVelocityLimit(req, res, { endpoint: "tap", max: 60, windowMs: 60000, uid: telegramId })) {
    return;
  }

  try {
    const db = await getDb();
    const users = db.collection("users");
    const user = await findOrCreateUser(users, tgUser);

    if (user && user.isBanned) {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    const now = Date.now();
    const requestedTaps = Math.max(0, Math.floor(Number(req.body && req.body.taps) || 0));

    // Calculate live available energy
    const lastSync = user.lastEnergySyncAt || user.lastMineCollectedAt;
    const storedEnergy = (typeof user.energy === "number") ? user.energy : MAX_TAP_ENERGY;
    const elapsed = lastSync ? Math.max(0, now - Number(lastSync)) : 0;
    const recovered = lastSync ? Math.floor(elapsed / ENERGY_RECHARGE_RATE_MS) : 0;
    const availableEnergy = Math.min(MAX_TAP_ENERGY, Math.max(0, storedEnergy + recovered));

    if (requestedTaps <= 0) {
      res.status(200).json({
        ok: true,
        acceptedTaps: 0,
        balance: user.balance || 0,
        energy: availableEnergy,
        maxEnergy: MAX_TAP_ENERGY,
        lastEnergySyncAt: lastSync || now
      });
      return;
    }

    if (availableEnergy <= 0) {
      res.status(400).json({
        ok: false,
        error: "Energy empty! Please wait for energy to recharge.",
        balance: user.balance || 0,
        energy: 0,
        maxEnergy: MAX_TAP_ENERGY
      });
      return;
    }

    // Strict ceiling: User can never consume more than currently available energy
    const acceptedTaps = Math.min(requestedTaps, availableEnergy);
    const newEnergy = Math.max(0, availableEnergy - acceptedTaps);
    const remainderMs = lastSync ? (elapsed % ENERGY_RECHARGE_RATE_MS) : 0;
    const newLastSync = now - remainderMs;

    await users.updateOne(
      { _id: user._id },
      {
        $inc: {
          balance: acceptedTaps,
          totalMinedCoins: acceptedTaps
        },
        $set: {
          energy: newEnergy,
          lastEnergySyncAt: newLastSync,
          lastActiveAt: new Date()
        }
      }
    );

    const updatedUser = await users.findOne({ _id: user._id });
    const newBalance = Number(updatedUser ? updatedUser.balance : ((Number(user.balance) || 0) + acceptedTaps));

    res.status(200).json({
      ok: true,
      acceptedTaps: acceptedTaps,
      balance: newBalance,
      energy: newEnergy,
      maxEnergy: MAX_TAP_ENERGY,
      lastEnergySyncAt: newLastSync
    });
  } catch (err) {
    console.error("tap.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
