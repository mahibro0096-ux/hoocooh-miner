const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const { dailyStatus, rewardForCycleDay } = require("../lib/gameLogic");
const { verifyActionToken, createActionToken } = require("../lib/actionSigner");
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
  const uid = String(tgUser.id);

  // Velocity Check: Max 5 daily check-in attempts per minute per user/IP
  if (!checkVelocityLimit(req, res, { endpoint: "checkin", max: 5, windowMs: 60000, uid: uid })) {
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

    const status = dailyStatus(user.lastCheckinAt);
    if (status === "waiting") {
      res.status(400).json({ error: "Already checked in today", status });
      return;
    }

    // 1. Puzzle Captcha Verification (Required after watching Monetag Ad)
    const { captchaToken } = req.body || {};
    if (!captchaToken) {
      res.status(400).json({ error: "Security puzzle verification required! Please solve the puzzle." });
      return;
    }

    const tokensCol = db.collection("captcha_tokens");
    // Atomically burn single-use captcha token (impossible for concurrent requests to both succeed)
    const burnTokenRes = await tokensCol.updateOne(
      {
        token: String(captchaToken),
        userId: { $in: [uid, Number(uid), tgUser.id] },
        used: false
      },
      { $set: { used: true, usedAt: Date.now() } }
    );

    if (!burnTokenRes || burnTokenRes.modifiedCount === 0) {
      res.status(400).json({ error: "Invalid, expired, or already used verification token. Please solve the puzzle again." });
      return;
    }

    // 2. Cryptographic Action Signing Verification
    const actionToken = (req.body && req.body.actionToken) || req.headers["x-action-token"] || req.headers["x-action-signature"] || req.headers["x-action-secret"];
    if (!verifyActionToken(uid, "checkin", actionToken)) {
      res.status(403).json({ error: "Security check failed: Invalid or missing action signature token." });
      return;
    }

    let dailyCycle = Number(user.dailyCycle) || 1;
    let dailyDayIndex = Number(user.dailyDayIndex) || 0;

    if (status === "broken") {
      dailyDayIndex = 0;
      dailyCycle = 1;
    } else if (user.lastCheckinAt) {
      dailyDayIndex += 1;
      if (dailyDayIndex > 6) {
        dailyDayIndex = 0;
        dailyCycle = Math.max(2, dailyCycle + 1);
      }
    }

    // Atomically claim daily checkin bonus (impossible for concurrent requests to both claim)
    const cutoff24h = now - (24 * 60 * 60 * 1000);
    const checkinRes = await users.findOneAndUpdate(
      {
        _id: user._id,
        $or: [
          { lastCheckinAt: { $exists: false } },
          { lastCheckinAt: null },
          { lastCheckinAt: { $lte: cutoff24h } }
        ]
      },
      {
        $inc: {
          balance: reward,
          totalDailyEarned: reward
        },
        $set: {
          dailyCycle,
          dailyDayIndex,
          lastCheckinAt: now,
          lastActiveAt: new Date()
        }
      },
      { returnDocument: "after" }
    );

    const updatedUser = checkinRes && (checkinRes.value || checkinRes);
    if (!updatedUser) {
      res.status(400).json({ error: "Already checked in today", status: "waiting" });
      return;
    }

    const finalBalance = Number(updatedUser.balance || 0);
    const finalTotal = Number(updatedUser.totalDailyEarned || 0);

    res.status(200).json({
      balance: finalBalance,
      dailyCycle,
      dailyDayIndex,
      lastCheckinAt: now,
      totalDailyEarned: finalTotal,
      reward,
      level: user.minerLevel || 1,
      newActionToken: createActionToken(uid, "checkin")
    });
  } catch (err) {
    console.error("checkin.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
