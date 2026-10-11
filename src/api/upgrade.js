const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const { LEVEL_NAMES, getMultiplierForLevel, getUpgradeCostForLevel } = require("../lib/gameLogic");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not configured" });
    return;
  }

  const initData = req.headers["x-telegram-init-data"];
  const tgUser = validateInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!tgUser) {
    res.status(401).json({ error: "Invalid session - reopen app from Telegram" });
    return;
  }

  try {
    const db = await getDb();
    const users = db.collection("users");
    let user = await findOrCreateUser(users, tgUser);

    if (user && user.isBanned) {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    const currentLevel = Math.max(1, Math.min(10, user.minerLevel || 1));
    if (currentLevel >= 10) {
      res.status(400).json({ error: "Your miner is already at the maximum level (Level 10 Transcendent)!" });
      return;
    }

    const cost = getUpgradeCostForLevel(currentLevel);
    if (!cost) {
      res.status(400).json({ error: "Upgrade cost not defined" });
      return;
    }

    // Atomically verify balance and current level, deduct cost, and increment level
    // This prevents race condition duplicate upgrades or balance overdrafts
    const upgradeRes = await users.findOneAndUpdate(
      {
        _id: user._id,
        balance: { $gte: cost },
        minerLevel: currentLevel
      },
      {
        $inc: { balance: -cost, minerLevel: 1 },
        $set: { lastActiveAt: new Date() }
      },
      { returnDocument: "after" }
    );

    const updatedUser = upgradeRes && (upgradeRes.value || upgradeRes);
    if (!updatedUser) {
      const freshUser = await users.findOne({ _id: user._id });
      const freshBal = Number(freshUser ? freshUser.balance : 0);
      res.status(400).json({
        error: `Insufficient balance or level already updated! Cost: ${cost.toLocaleString()} Coins. Current balance: ${freshBal.toLocaleString()} Coins.`
      });
      return;
    }

    const newLevel = updatedUser.minerLevel;
    const newBal = Number(updatedUser.balance || 0);
    const newMultiplier = getMultiplierForLevel(newLevel);
    const newName = LEVEL_NAMES[newLevel - 1] || "Miner";

    res.status(200).json({
      ok: true,
      minerLevel: newLevel,
      level: newLevel,
      balance: newBal,
      multiplier: newMultiplier,
      levelName: newName,
      message: `🎉 Upgraded to Level ${newLevel} ${newName}! Reward multiplier is now ${newMultiplier}x.`
    });
  } catch (err) {
    console.error("upgrade.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
