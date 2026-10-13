const { getDb } = require("../lib/mongodb");
const { ObjectId } = require("mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { dispatchTonPayout } = require("../lib/tonAutoPay");
const { purgeExpiredBannedUsers } = require("../lib/userHelper");
const { startOrContinueBroadcast, processBroadcastQueue } = require("../lib/broadcastQueue");

const crypto = require("crypto");

const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || "hoocooh_admin_2026";

async function getAdminTelegramIds(db) {
  const ids = new Set();
  if (process.env.ADMIN_TELEGRAM_ID) {
    process.env.ADMIN_TELEGRAM_ID.split(",").forEach(id => {
      const trimmed = id.trim();
      if (trimmed) ids.add(trimmed);
    });
  }
  try {
    if (db) {
      const setting = await db.collection("settings").findOne({ key: "bot_settings" });
      if (setting && setting.adminTelegramId) {
        String(setting.adminTelegramId).split(",").forEach(id => {
          const trimmed = id.trim();
          if (trimmed) ids.add(trimmed);
        });
      }
      const adminDocs = await db.collection("admins").find({}).toArray();
      adminDocs.forEach(doc => {
        if (doc.telegramId) ids.add(String(doc.telegramId).trim());
      });
    }
  } catch (e) {
    console.error("Error reading admin IDs from DB:", e);
  }
  return ids;
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function checkAdminAuth(req) {
  const headerKey = req.headers["x-admin-key"];
  const bodyKey = req.body && req.body.adminKey;
  const queryKey = req.query && req.query.adminKey;
  const key = headerKey || bodyKey || queryKey;
  if (!key) return false;

  const provided = Buffer.from(String(key).trim());
  const expected = Buffer.from(String(ADMIN_SECRET).trim());
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

async function sendTelegramMsg(botToken, chatId, text, options = {}) {
  if (!botToken || !chatId) return false;
  try {
    const payload = {
      chat_id: String(chatId),
      parse_mode: "HTML",
      disable_web_page_preview: false
    };

    let url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    if (options.photoUrl) {
      url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
      payload.photo = options.photoUrl;
      payload.caption = text;
    } else {
      payload.text = text;
    }

    if (options.reply_markup) {
      payload.reply_markup = options.reply_markup;
    } else if (options.buttonText && options.buttonUrl) {
      payload.reply_markup = {
        inline_keyboard: [
          [{ text: options.buttonText, url: options.buttonUrl }]
        ]
      };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    return data.ok;
  } catch (e) {
    return false;
  }
}

function calculateFraudRiskScore(u) {
  if (!u) return 0;
  if (u.isBanned) return 100;

  let score = 0;

  // 1a. Ghost Claim / Fake Ad Bypass Exploit (Instant 90%-100% High Risk)
  if (u.isFakeAdBypasser || u.securityFlag === "RED_FLAG_FAKE_AD_BYPASS" || u.permanentWarning) {
    score += 90;
  }

  // 1b. Critical hacker / automated script tampering (Instantly high risk)
  if (u.isHighRiskHacker) {
    score += 85;
  }

  // 2. Severe security flag (e.g. ad skip exploit or headless tamper)
  const secFlag = String(u.securityFlag || "");
  if (secFlag.includes("RED_FLAG") || secFlag.includes("HIGH RISK") || secFlag.includes("EXPLOIT")) {
    score += 45;
  }

  // 3. Negative coin balance penalty (penalized exploit attempt)
  if (Number(u.balance || 0) < 0) {
    score += 50;
  }

  // 4. Multi-account detection
  if (u.isSuspendedMultipleAccount) {
    score += 45;
  }
  const devStrikes = Number(u.deviceViolationsCount || 0);
  if (devStrikes >= 2) {
    score += 40;
  } else if (devStrikes === 1) {
    score += 20;
  }

  // 5. Ad skip exploit strikes (< 9s video skip attempts)
  const adSkipStrikes = Number(u.adSkipUnder9sStrikes || 0);
  if (adSkipStrikes >= 2) {
    score += 35;
  } else if (adSkipStrikes === 1) {
    score += 20;
  }

  // 6. Rapid spin under 5s strikes
  const spinStrikes = Number(u.spinUnder5sStrikes || 0);
  if (spinStrikes >= 5) {
    score += 30;
  } else if (spinStrikes >= 3) {
    score += 15;
  }

  // 7. General suspicious flag or reason
  if (u.isSuspicious) {
    score += 25;
  }
  const susReason = String(u.suspiciousReason || "").toLowerCase();
  if (susReason.includes("tamper") || susReason.includes("bot") || susReason.includes("hack") || susReason.includes("exploit") || susReason.includes("script")) {
    score += 30;
  }

  return Math.min(100, Math.max(0, score));
}

module.exports = async (req, res) => {
  // CORS / Options preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-key");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  // ========================================================
  // Telegram WebApp Auto-Authentication (Via initData)
  // Allows the owner to open /admin.html inside Telegram without entering password!
  // Strictly rejects unauthorized Telegram users!
  // ========================================================
  if (req.method === "POST" && req.body && req.body.action === "auth_init_data") {
    const { initData } = req.body;
    if (!initData) {
      res.status(400).json({ ok: false, error: "Missing Telegram initData" });
      return;
    }
    if (!botToken) {
      res.status(500).json({ ok: false, error: "TELEGRAM_BOT_TOKEN is not configured in Vercel" });
      return;
    }

    const tgUser = validateInitData(initData, botToken);
    if (!tgUser || !tgUser.id) {
      res.status(401).json({ ok: false, error: "Invalid or expired Telegram authentication signature." });
      return;
    }

    try {
      const db = await getDb();
      const adminIds = await getAdminTelegramIds(db);
      const senderId = String(tgUser.id);

      if (!adminIds.has(senderId)) {
        res.status(403).json({
          ok: false,
          error: "ACCESS_DENIED_NOT_ADMIN",
          message: `Telegram ID ${senderId} is not registered as an Administrator.`
        });
        return;
      }

      // Verified Admin! Return temporary adminKey for frontend API sessions
      res.status(200).json({
        ok: true,
        authorized: true,
        adminKey: ADMIN_SECRET,
        user: {
          id: tgUser.id,
          username: tgUser.username || "",
          firstName: tgUser.first_name || ""
        }
      });
      return;
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
      return;
    }
  }

  if (!checkAdminAuth(req)) {
    res.status(401).json({ error: "Unauthorized: Invalid Admin Secret Key" });
    return;
  }

  try {
    const db = await getDb();
    const usersCol = db.collection("users");
    const withdrawalsCol = db.collection("withdrawals");
    const tasksCol = db.collection("tasks");

    // ==========================================
    // GET Requests: Stats, Withdrawals, Users, Tasks
    // ==========================================
    if (req.method === "GET") {
      const action = req.query.action || "stats";

      // 1. Stats
      if (action === "stats") {
        await purgeExpiredBannedUsers(db).catch(() => {});
        const totalUsers = await usersCol.countDocuments({});
        const bannedUsers = await usersCol.countDocuments({ isBanned: true });
        const bannedPurged = await usersCol.countDocuments({ isBanned: true, dataPurged: true });
        const bannedGrace = await usersCol.countDocuments({ isBanned: true, dataPurged: { $ne: true } });
        const pendingW = await withdrawalsCol.countDocuments({ status: "PENDING" });
        const approvedW = await withdrawalsCol.countDocuments({ status: "APPROVED" });

        const balAgg = await usersCol.aggregate([
          { $group: { _id: null, totalCoins: { $sum: "$balance" } } }
        ]).toArray();
        const totalCoins = balAgg[0] ? balAgg[0].totalCoins : 0;

        const TON_PER_USD = 0.019 / 0.03; // 3 cents = 0.019 TON

        const paidAgg = await withdrawalsCol.aggregate([
          { $match: { status: "APPROVED" } },
          { $group: { _id: null, totalUsdt: { $sum: "$usdtAmount" }, totalTon: { $sum: { $ifNull: ["$tonAmount", { $multiply: ["$usdtAmount", TON_PER_USD] }] } } } }
        ]).toArray();
        const totalPaidUsdt = paidAgg[0] ? paidAgg[0].totalUsdt : 0;
        const totalPaidTon = paidAgg[0] ? paidAgg[0].totalTon : (totalPaidUsdt * TON_PER_USD);

        const pendingUsdtAgg = await withdrawalsCol.aggregate([
          { $match: { status: "PENDING" } },
          { $group: { _id: null, totalUsdt: { $sum: "$usdtAmount" }, totalTon: { $sum: { $ifNull: ["$tonAmount", { $multiply: ["$usdtAmount", TON_PER_USD] }] } } } }
        ]).toArray();
        const totalPendingUsdt = pendingUsdtAgg[0] ? pendingUsdtAgg[0].totalUsdt : 0;
        const totalPendingTon = pendingUsdtAgg[0] ? pendingUsdtAgg[0].totalTon : (totalPendingUsdt * TON_PER_USD);

        const activeUsers60d = await usersCol.countDocuments({
          lastActiveAt: { $gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) }
        });

        // Count unbanned users matching High Fraud Risk criteria (80% - 100%)
        const highRiskUnbannedCount = await usersCol.countDocuments({
          isBanned: { $ne: true },
          $or: [
            { isHighRiskHacker: true },
            { balance: { $lt: 0 } },
            { isSuspendedMultipleAccount: true },
            { securityFlag: { $regex: "RED_FLAG|HIGH RISK|EXPLOIT", $options: "i" } },
            { deviceViolationsCount: { $gte: 2 } },
            { adSkipUnder9sStrikes: { $gte: 2 } }
          ]
        });

        res.status(200).json({
          ok: true,
          totalUsers,
          activeUsers60d,
          ttlDays: 60,
          bannedUsers,
          bannedPurged,
          bannedGrace,
          highRiskUnbannedCount,
          pendingWithdrawals: pendingW,
          totalPendingUsdt: Number(totalPendingUsdt.toFixed(2)),
          totalPendingTon: Number(totalPendingTon.toFixed(4)),
          approvedWithdrawals: approvedW,
          totalCoinsInCirculation: Math.round(totalCoins),
          totalPaidUsdt: Number(totalPaidUsdt.toFixed(2)),
          totalPaidTon: Number(totalPaidTon.toFixed(4))
        });
        return;
      }

      // 2. Withdrawals List
      if (action === "withdrawals") {
        const filter = {};
        if (req.query.status && req.query.status !== "ALL") {
          filter.status = req.query.status.toUpperCase();
        }

        const rawList = await withdrawalsCol
          .find(filter)
          .sort({ createdAt: -1 })
          .limit(100)
          .toArray();

        // Attach user info
        const userIds = [...new Set(rawList.map(w => String(w.telegramId)))];
        const usersMap = {};
        if (userIds.length > 0) {
          const foundUsers = await usersCol.find({
            $or: [
              { telegramId: { $in: userIds } },
              { telegramId: { $in: userIds.map(Number).filter(Boolean) } }
            ]
          }).toArray();
          foundUsers.forEach(u => {
            usersMap[String(u.telegramId)] = u;
          });
        }

        const list = rawList.map(w => {
          const u = usersMap[String(w.telegramId)] || {};
          return {
            id: String(w._id),
            telegramId: w.telegramId,
            username: u.username ? ("@" + u.username) : "N/A",
            name: (u.firstName || "") + (u.lastName ? " " + u.lastName : "") || "Miner",
            currentBalance: Number(u.balance || 0),
            recruitsCount: Number(u.recruitsCount || 0),
            isBanned: !!u.isBanned,
            isSuspicious: !!u.isSuspicious,
            suspiciousReason: u.suspiciousReason || "",
            isHighRiskHacker: !!u.isHighRiskHacker,
            securityFlag: u.securityFlag || "",
            isSuspendedMultipleAccount: !!u.isSuspendedMultipleAccount,
            deviceViolationsCount: Number(u.deviceViolationsCount || 0),
            registeredIp: u.registeredIp || u.lastIp || "",
            amount: w.amount,
            usdtAmount: w.usdtAmount,
            tonAmount: w.tonAmount !== undefined ? Number(w.tonAmount) : Number(((w.usdtAmount || 0) * (0.019 / 0.03)).toFixed(4)),
            walletAddress: w.walletAddress,
            network: w.network || "TON",
            status: w.status || "PENDING",
            txHash: w.txHash || "",
            createdAt: w.createdAt,
            approvedAt: w.approvedAt,
            rejectedAt: w.rejectedAt,
            reason: w.reason || ""
          };
        });

        res.status(200).json({ ok: true, withdrawals: list });
        return;
      }

      // 3. Search User (UID or Username)
      if (action === "search_user") {
        const q = String(req.query.q || "").trim();
        if (!q) {
          res.status(400).json({ error: "Search query required" });
          return;
        }

        const cleanUsername = q.replace(/^@/, "");
        const numId = Number(q);
        const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escapedUsername = cleanUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        const query = {
          $or: [
            { telegramId: q },
            ...(numId ? [{ telegramId: numId }] : []),
            { username: { $regex: escapedUsername, $options: "i" } },
            { firstName: { $regex: escapedQ, $options: "i" } }
          ]
        };

        const found = await usersCol.find(query).limit(20).toArray();
        const mapped = found.map(u => ({
          id: String(u._id),
          telegramId: String(u.telegramId),
          name: (u.firstName || "") + (u.lastName ? " " + u.lastName : "") || "Miner",
          username: u.username ? ("@" + u.username) : "N/A",
          photoUrl: u.photoUrl || "",
          balance: Number(u.balance || 0),
          minerLevel: u.minerLevel || 1,
          recruitsCount: Number(u.recruitsCount || 0),
          refEarnings: Number(u.refEarnings || 0),
          totalAdsWatched: Number(u.totalAdsWatched || 0),
          spinTickets: Number(u.spinTickets || 0),
          spinUnder5sStrikes: Number(u.spinUnder5sStrikes || 0),
          adSkipUnder9sStrikes: Number(u.adSkipUnder9sStrikes || 0),
          fraudRiskScore: calculateFraudRiskScore(u),
          isBanned: !!u.isBanned,
          banReason: u.banReason || "",
          isSuspicious: !!u.isSuspicious,
          suspiciousReason: u.suspiciousReason || "",
          isHighRiskHacker: !!u.isHighRiskHacker,
          isFakeAdBypasser: !!u.isFakeAdBypasser,
          permanentWarning: !!u.permanentWarning,
          securityFlag: u.securityFlag || "",
          isSuspendedMultipleAccount: !!u.isSuspendedMultipleAccount,
          deviceViolationsCount: Number(u.deviceViolationsCount || 0),
          penaltyNotice: u.penaltyNotice || "",
          registeredIp: u.registeredIp || u.lastIp || "N/A",
          boundWalletAddress: u.boundWalletAddress || null,
          accountLocked: !!u.accountLocked,
          velocityFlaggedAt: u.velocityFlaggedAt || null,
          velocityFlaggedReason: u.velocityFlaggedReason || "",
          bannedAt: u.bannedAt || null,
          dataPurged: !!u.dataPurged,
          purgedAt: u.purgedAt || null,
          createdAt: u.createdAt || null
        }));

        res.status(200).json({ ok: true, users: mapped });
        return;
      }

      // 3a. Get Referrals of a Specific User
      if (action === "user_referrals") {
        const uid = String(req.query.userId || req.query.uid || req.query.telegramId || "").trim();
        if (!uid) {
          res.status(400).json({ error: "User ID required" });
          return;
        }

        const numId = Number(uid);
        const parentUser = await usersCol.findOne({
          $or: [{ telegramId: uid }, ...(numId ? [{ telegramId: numId }] : [])]
        });

        const referrals = await usersCol.find({
          $or: [
            { referredBy: uid },
            ...(numId ? [{ referredBy: String(numId) }, { referredBy: numId }] : [])
          ]
        }).sort({ createdAt: -1 }).toArray();

        const mappedRefs = referrals.map(u => ({
          id: String(u._id),
          telegramId: String(u.telegramId),
          name: (u.firstName || "") + (u.lastName ? " " + u.lastName : "") || "Miner",
          username: u.username ? ("@" + u.username) : "N/A",
          photoUrl: u.photoUrl || "",
          balance: Number(u.balance || 0),
          minerLevel: u.minerLevel || 1,
          totalAdsWatched: Number(u.totalAdsWatched || 0),
          isBanned: !!u.isBanned,
          isIdentityVerified: !!u.isIdentityVerified,
          referralRewarded: !!u.referralRewarded,
          createdAt: u.createdAt || null
        }));

        res.status(200).json({
          ok: true,
          user: parentUser ? {
            telegramId: String(parentUser.telegramId),
            name: (parentUser.firstName || "") + (parentUser.lastName ? " " + parentUser.lastName : "") || "Miner",
            username: parentUser.username ? ("@" + parentUser.username) : "N/A",
            recruitsCount: Number(parentUser.recruitsCount || 0),
            refEarnings: Number(parentUser.refEarnings || 0)
          } : null,
          totalReferrals: mappedRefs.length,
          referrals: mappedRefs
        });
        return;
      }

      // 3b. High Risk Users List (Fraud Risk Score 80% - 100%)
      if (action === "high_risk_users") {
        const candidates = await usersCol.find({
          $or: [
            { isFakeAdBypasser: true },
            { permanentWarning: true },
            { isHighRiskHacker: true },
            { balance: { $lt: 0 } },
            { isSuspendedMultipleAccount: true },
            { isSuspicious: true },
            { deviceViolationsCount: { $gt: 0 } },
            { adSkipUnder9sStrikes: { $gt: 0 } },
            { spinUnder5sStrikes: { $gte: 3 } },
            { securityFlag: { $exists: true, $ne: "" } },
            { suspiciousReason: { $regex: "tamper|bot|hack|exploit|script", $options: "i" } }
          ]
        }).sort({ balance: 1 }).limit(200).toArray();

        const mapped = candidates.map(u => ({
          id: String(u._id),
          telegramId: String(u.telegramId),
          name: (u.firstName || "") + (u.lastName ? " " + u.lastName : "") || "Miner",
          username: u.username ? ("@" + u.username) : "N/A",
          photoUrl: u.photoUrl || "",
          balance: Number(u.balance || 0),
          minerLevel: u.minerLevel || 1,
          recruitsCount: Number(u.recruitsCount || 0),
          refEarnings: Number(u.refEarnings || 0),
          totalAdsWatched: Number(u.totalAdsWatched || 0),
          spinTickets: Number(u.spinTickets || 0),
          spinUnder5sStrikes: Number(u.spinUnder5sStrikes || 0),
          adSkipUnder9sStrikes: Number(u.adSkipUnder9sStrikes || 0),
          fraudRiskScore: calculateFraudRiskScore(u),
          isBanned: !!u.isBanned,
          banReason: u.banReason || "",
          isSuspicious: !!u.isSuspicious,
          suspiciousReason: u.suspiciousReason || "",
          isHighRiskHacker: !!u.isHighRiskHacker,
          isFakeAdBypasser: !!u.isFakeAdBypasser,
          permanentWarning: !!u.permanentWarning,
          securityFlag: u.securityFlag || "",
          isSuspendedMultipleAccount: !!u.isSuspendedMultipleAccount,
          deviceViolationsCount: Number(u.deviceViolationsCount || 0),
          penaltyNotice: u.penaltyNotice || "",
          registeredIp: u.registeredIp || u.lastIp || "N/A",
          boundWalletAddress: u.boundWalletAddress || null,
          accountLocked: !!u.accountLocked,
          velocityFlaggedAt: u.velocityFlaggedAt || null,
          velocityFlaggedReason: u.velocityFlaggedReason || "",
          bannedAt: u.bannedAt || null,
          dataPurged: !!u.dataPurged,
          purgedAt: u.purgedAt || null,
          createdAt: u.createdAt || null
        })).filter(u => u.fraudRiskScore >= 80 && u.fraudRiskScore <= 100);

        const unbannedCount = mapped.filter(u => !u.isBanned).length;
        const bannedCount = mapped.filter(u => u.isBanned).length;

        res.status(200).json({
          ok: true,
          users: mapped,
          totalHighRisk: mapped.length,
          unbannedCount,
          bannedCount
        });
        return;
      }

      // 4. Tasks List (Strictly show active/paid tasks - exclude unpaid, cancelled, or pending payment tasks)
      if (action === "tasks") {
        // Auto-cleanup any abandoned unpaid/cancelled task drafts created by non-admins
        tasksCol.deleteMany({
          paid: { $ne: true },
          creatorId: { $ne: "admin" },
          status: { $in: ["pending_payment", "declined", "cancelled"] }
        }).catch(() => {});

        const customTasks = await tasksCol
          .find({
            status: { $nin: ["pending_payment", "declined", "cancelled"] },
            $or: [
              { creatorId: "admin" },
              { paid: true }
            ]
          })
          .sort({ createdAt: -1 })
          .toArray();
        const mapped = customTasks.map(t => ({
          id: String(t._id),
          title: t.title,
          link: t.link,
          type: t.type || "normal",
          reward: 10,
          targetCount: t.targetCount === 99999999 || !t.targetCount ? "Unlimited" : t.targetCount,
          completedCount: (t.completedBy || []).length,
          status: t.status || "active",
          creatorId: t.creatorId,
          createdAt: t.createdAt
        }));

        const appSetting = await db.collection("settings").findOne({ key: "app_settings" });
        const watchAdReward = (appSetting && typeof appSetting.watchAdReward === "number" && appSetting.watchAdReward > 0) ? appSetting.watchAdReward : 10;
        const coinPriceUsd = (appSetting && typeof appSetting.coinPriceUsd === "number" && appSetting.coinPriceUsd > 0) ? appSetting.coinPriceUsd : 0.00003;
        const adMissionReward = (appSetting && typeof appSetting.adMissionReward === "number" && appSetting.adMissionReward > 0) ? appSetting.adMissionReward : 20;

        res.status(200).json({ ok: true, tasks: mapped, watchAdReward, coinPriceUsd, adMissionReward });
        return;
      }

      // 5. App & Ad Reward Settings
      if (action === "app_settings" || action === "ad_settings") {
        const appSetting = await db.collection("settings").findOne({ key: "app_settings" });
        const watchAdReward = (appSetting && typeof appSetting.watchAdReward === "number" && appSetting.watchAdReward > 0) ? appSetting.watchAdReward : 10;
        const coinPriceUsd = (appSetting && typeof appSetting.coinPriceUsd === "number" && appSetting.coinPriceUsd > 0) ? appSetting.coinPriceUsd : 0.00003;
        const adMissionReward = (appSetting && typeof appSetting.adMissionReward === "number" && appSetting.adMissionReward > 0) ? appSetting.adMissionReward : 20;
        res.status(200).json({ ok: true, watchAdReward, coinPriceUsd, adMissionReward });
        return;
      }

      // 5. Bot & Webhook Settings
      if (action === "bot_settings") {
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        const protocol = req.headers["x-forwarded-proto"] || "https";
        const webhookUrl = `${protocol}://${host}/api/webhook`;
        const setting = await db.collection("settings").findOne({ key: "bot_settings" });
        const adminIds = await getAdminTelegramIds(db);

        let webhookInfo = null;
        if (botToken) {
          try {
            const whRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
            webhookInfo = await whRes.json();
          } catch(e){}
        }

        res.status(200).json({
          ok: true,
          hasBotToken: !!botToken,
          webhookUrl,
          webhookInfo,
          envAdminId: process.env.ADMIN_TELEGRAM_ID || null,
          dbAdminId: setting ? setting.adminTelegramId : null,
          registeredAdmins: Array.from(adminIds)
        });
        return;
      }

      if (action === "setup_indexes") {
        const {
          USER_INACTIVITY_TTL_SECONDS,
          USER_BANNED_TTL_SECONDS,
          WITHDRAWAL_REJECTED_TTL_SECONDS,
          IP_REGISTRY_TTL_SECONDS,
          IP_VELOCITY_TTL_SECONDS,
          CAPTCHA_TTL_SECONDS,
          VERIFICATION_CODES_TTL_SECONDS,
          BROADCAST_DELIVERIES_TTL_SECONDS,
          ADMIN_STATE_TTL_SECONDS
        } = require("../lib/constants");

        async function safeIndex(colName, spec, options = {}) {
          const col = db.collection(colName);
          try {
            await col.createIndex(spec, options);
            return { index: `${colName}.${JSON.stringify(spec)}`, ok: true };
          } catch (err) {
            if (err.codeName === "IndexOptionsConflict" || (err.message && err.message.includes("already exists with different options"))) {
              try {
                if (options.name) await col.dropIndex(options.name);
                await col.createIndex(spec, options);
                return { index: `${colName}.${JSON.stringify(spec)}`, ok: true, note: "Recreated after dropping conflict" };
              } catch (dropErr) {
                return { index: `${colName}.${JSON.stringify(spec)}`, ok: false, error: dropErr.message };
              }
            }
            return { index: `${colName}.${JSON.stringify(spec)}`, ok: false, error: err.message };
          }
        }

        const steps = [
          ["users.telegramId", () => safeIndex("users", { telegramId: 1 })],
          ["users.totalMinedCoins+minerLevel", () => safeIndex("users", { totalMinedCoins: -1, minerLevel: -1 })],
          ["users.recruitsCount", () => safeIndex("users", { recruitsCount: -1 })],
          ["users.referredBy", () => safeIndex("users", { referredBy: 1 })],
          ["users.isBanned", () => safeIndex("users", { isBanned: 1 })],
          ["users.lastActiveAt (TTL 90d dead-account cleanup)", () => safeIndex("users", { lastActiveAt: 1 }, { expireAfterSeconds: USER_INACTIVITY_TTL_SECONDS, name: "ttl_users_inactivity_90d" })],
          ["users.bannedAtDate (partial TTL 60d, isBanned:true only)", () => safeIndex("users", { bannedAtDate: 1 }, { expireAfterSeconds: USER_BANNED_TTL_SECONDS, partialFilterExpression: { isBanned: true }, name: "ttl_users_banned_60d" })],
          ["withdrawals.telegramId+status", () => safeIndex("withdrawals", { telegramId: 1, status: 1 })],
          ["withdrawals.status+createdAt", () => safeIndex("withdrawals", { status: 1, createdAt: -1 })],
          ["withdrawals.rejectedAtDate (partial TTL 90d, status:REJECTED only)", () => safeIndex("withdrawals", { rejectedAtDate: 1 }, { expireAfterSeconds: WITHDRAWAL_REJECTED_TTL_SECONDS, partialFilterExpression: { status: "REJECTED" }, name: "ttl_withdrawals_rejected_90d" })],
          ["ipSignupVelocity.updatedAt (TTL 24h)", () => safeIndex("ipSignupVelocity", { updatedAt: 1 }, { expireAfterSeconds: IP_VELOCITY_TTL_SECONDS, name: "ttl_ip_signup_velocity_24h" })],
          ["ipRegistry.lastSeenAt (TTL 120d)", () => safeIndex("ipRegistry", { lastSeenAt: 1 }, { expireAfterSeconds: IP_REGISTRY_TTL_SECONDS, name: "ttl_ip_registry_120d" })],
          ["ipRegistry.userId", () => safeIndex("ipRegistry", { userId: 1 })],
          ["captcha_tokens.createdAtDate (TTL 10m)", () => safeIndex("captcha_tokens", { createdAtDate: 1 }, { expireAfterSeconds: CAPTCHA_TTL_SECONDS, name: "ttl_captcha_tokens_10m" })],
          ["captcha_challenges.createdAtDate (TTL 10m)", () => safeIndex("captcha_challenges", { createdAtDate: 1 }, { expireAfterSeconds: CAPTCHA_TTL_SECONDS, name: "ttl_captcha_challenges_10m" })],
          ["user_verification_codes.createdAtDate (TTL 1h)", () => safeIndex("user_verification_codes", { createdAtDate: 1 }, { expireAfterSeconds: VERIFICATION_CODES_TTL_SECONDS, name: "ttl_verification_codes_1h" })],
          ["broadcast_deliveries.createdAt (TTL 30d)", () => safeIndex("broadcast_deliveries", { createdAt: 1 }, { expireAfterSeconds: BROADCAST_DELIVERIES_TTL_SECONDS, name: "ttl_broadcast_30d" })],
          ["adminState.updatedAt (TTL 1h)", () => safeIndex("adminState", { updatedAt: 1 }, { expireAfterSeconds: ADMIN_STATE_TTL_SECONDS, name: "ttl_admin_state_1h" })],
          ["tasks.status+createdAt", () => safeIndex("tasks", { status: 1, createdAt: -1 })]
        ];

        const results = [];
        for (const [name, fn] of steps) {
          try {
            const r = await fn();
            results.push({ name, ...r });
          } catch(e) {
            results.push({ name, ok: false, error: e.message });
          }
        }
        const failed = results.filter(r => !r.ok);
        res.status(200).json({ ok: failed.length === 0, total: results.length, successCount: results.length - failed.length, failedCount: failed.length, results });
        return;
      }

      res.status(400).json({ error: "Unknown GET action" });
      return;
    }

    // ==========================================
    // POST Requests: Actions (Approve, Reject, Ban, Unban, Funds, Broadcast, Tasks)
    // ==========================================
    if (req.method === "POST") {
      const { action } = req.body || {};

      // 1. Approve Withdrawal
      if (action === "approve_withdrawal") {
        const { withdrawalId, txHash } = req.body || {};
        if (!withdrawalId) {
          res.status(400).json({ error: "withdrawalId required" });
          return;
        }

        let objId;
        try { objId = new ObjectId(withdrawalId); } catch(e){ objId = null; }
        const wQuery = objId ? { _id: objId } : { _id: withdrawalId };

        const w = await withdrawalsCol.findOne(wQuery);
        if (!w) {
          res.status(404).json({ error: "Withdrawal not found" });
          return;
        }

        if (w.status !== "PENDING") {
          res.status(400).json({ error: `Withdrawal has already been processed (Current status: ${w.status}). Cannot approve again.` });
          return;
        }

        const now = Date.now();
        const tonVal = w.tonAmount !== undefined ? Number(w.tonAmount) : Number(((w.usdtAmount || 0) * (0.019 / 0.03)).toFixed(4));
        let finalTx = txHash ? txHash.trim() : "";
        let autoPaySuccess = false;
        let autoPayMsg = "";

        // ATOMIC CLAIM BEFORE PAYING: move PENDING -> PROCESSING first. Only ONE request can win this.
        // Previously the real TON payout was sent first and the status changed afterwards, so a double
        // click / two admins / a retry could send the same payout twice.
        const claimPayoutRes = await withdrawalsCol.updateOne(
          { ...wQuery, status: "PENDING" },
          { $set: { status: "PROCESSING", processingAt: now } }
        );
        if (!claimPayoutRes || claimPayoutRes.modifiedCount === 0) {
          res.status(400).json({ error: "Withdrawal has already been processed or is being processed right now." });
          return;
        }
        const releasePayoutClaim = async () => {
          try { await withdrawalsCol.updateOne({ ...wQuery, status: "PROCESSING" }, { $set: { status: "PENDING" }, $unset: { processingAt: "" } }); } catch (e) {}
        };

        // If no manual TxHash provided, try automated TON payout dispatcher
        if (!finalTx) {
          let autoPayRes;
          try {
            autoPayRes = await dispatchTonPayout(w.walletAddress, tonVal, `HOOCOOH Payout UID ${w.telegramId}`);
          } catch (payErr) {
            await releasePayoutClaim();
            res.status(500).json({ error: `Auto-pay error: ${payErr && payErr.message ? payErr.message : payErr}` });
            return;
          }
          if (autoPayRes.isConfigured) {
            if (!autoPayRes.success) {
              await releasePayoutClaim();
              res.status(400).json({
                error: `Auto-pay halted: ${autoPayRes.message || autoPayRes.error}`
              });
              return;
            }
            finalTx = autoPayRes.txHash;
            autoPaySuccess = true;
            autoPayMsg = autoPayRes.message || "On-chain transfer dispatched";
          } else {
            finalTx = "0x" + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
            autoPayMsg = "Auto-pay env variables (TON_AUTO_PAY / TON_WALLET_MNEMONIC) not active. Approved manually.";
          }
        }

        // Finalize: PROCESSING (claimed above by this request) -> APPROVED
        const approveUpdateRes = await withdrawalsCol.updateOne(
          { ...wQuery, status: "PROCESSING" },
          {
            $set: {
              status: "APPROVED",
              tonAmount: tonVal,
              txHash: finalTx,
              approvedAt: now
            }
          }
        );

        if (approveUpdateRes.matchedCount === 0 || approveUpdateRes.modifiedCount === 0) {
          res.status(400).json({ error: "Withdrawal has already been processed or is no longer pending." });
          return;
        }

        // Notify Payout Channel (@hoocoohpaylogs) and User via Telegram Bot
        if (botToken) {
          try {
            const userDoc = await usersCol.findOne({
              $or: [
                { telegramId: String(w.telegramId) },
                { telegramId: Number(w.telegramId) }
              ]
            });

            const rawName = userDoc?.username 
              ? `@${userDoc.username}` 
              : (userDoc?.firstName ? `${userDoc.firstName}${userDoc.lastName ? ' ' + userDoc.lastName : ''}` : `Miner_${String(w.telegramId).slice(-4)}`);
            const displayName = escapeHtml(rawName);

            const txUrl = `https://tonviewer.com/transaction/${encodeURIComponent(finalTx)}`;
            const txLinkHtml = `<a href="${txUrl}">View Transaction</a>`;

            // 1. Post to Payout Logs Channel (with BOT ---> @hoocoohmine_bot appended)
            const channelId = process.env.PAYOUT_CHANNEL_ID || "@hoocoohpaylogs";
            const channelMsg = 
`🎉 <b>New payout paid</b> 🎉\n\n` +
`👤 <b>User:</b> ${displayName}\n` +
`🔘 <b>Amount:</b> ${Number(w.amount).toLocaleString()} HOOCOOH (${Number(w.usdtAmount).toFixed(2)} USDT)\n` +
`💳 <b>Wallet address:</b>\n` +
`<code>${w.walletAddress}</code>\n` +
`🔗 <b>Transaction id:</b> ${txLinkHtml}\n\n` +
`BOT ---> @hoocoohmine_bot`;

            await sendTelegramMsg(botToken, channelId, channelMsg);

            // 2. Send 1:1 exact notification to the withdrawing user (matching media_1791525638939.png)
            if (w.telegramId) {
              const userMsg = 
`✅ <b>Withdrawal Approved!</b>\n\n` +
`🪙 <b>${Number(w.amount).toLocaleString()} HOOCOOH Coins ($${Number(w.usdtAmount).toFixed(2)} USDT) sent!</b>\n` +
`🔗 <a href="${txUrl}">View Transaction</a>`;

              await sendTelegramMsg(botToken, w.telegramId, userMsg, {
                buttonText: "🔗 View Transaction",
                buttonUrl: txUrl
              });
            }
          } catch (notifErr) {
            console.error("Payout notification error:", notifErr);
          }
        }

        res.status(200).json({ 
          ok: true, 
          message: `Withdrawal of ${tonVal} TON approved successfully!`, 
          tonAmount: tonVal, 
          txHash: finalTx,
          autoPaySuccess,
          autoPayMsg
        });
        return;
      }

      // 2. Reject Withdrawal (Refunds coins back to user balance exactly once!)
      if (action === "reject_withdrawal") {
        const { withdrawalId, reason } = req.body || {};
        if (!withdrawalId) {
          res.status(400).json({ error: "withdrawalId required" });
          return;
        }

        let objId;
        try { objId = new ObjectId(withdrawalId); } catch(e){ objId = null; }
        const wQuery = objId ? { _id: objId } : { _id: withdrawalId };

        const w = await withdrawalsCol.findOne(wQuery);
        if (!w) {
          res.status(404).json({ error: "Withdrawal not found" });
          return;
        }

        if (w.status !== "PENDING") {
          res.status(400).json({ error: `Withdrawal has already been processed (Current status: ${w.status}). Cannot refund again.` });
          return;
        }

        const now = Date.now();
        const refundAmt = Number(w.amount || 0);
        const rejReason = (reason || "Review failed / suspicious activity").trim();

        // Atomically update withdrawal ONLY if it is still PENDING
        const rejectUpdateRes = await withdrawalsCol.updateOne(
          { ...wQuery, status: "PENDING" },
          {
            $set: {
              status: "REJECTED",
              reason: rejReason,
              rejectedAt: now,
              rejectedAtDate: new Date()
            }
          }
        );

        // If another concurrent request already processed this withdrawal, abort refund
        if (rejectUpdateRes.matchedCount === 0 || rejectUpdateRes.modifiedCount === 0) {
          res.status(400).json({ error: "Withdrawal has already been processed or is no longer pending." });
          return;
        }

        // Refund coins to user EXACTLY ONCE
        const tid = String(w.telegramId);
        const numId = Number(w.telegramId);
        await usersCol.updateOne(
          { $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])] },
          { $inc: { balance: refundAmt } }
        );

        // Notify user via Telegram Bot
        if (botToken && w.telegramId) {
          const msg = `⚠️ <b>Withdrawal Rejected & Refunded</b>\n\nYour request for <b>${refundAmt.toLocaleString()} Coins</b> was rejected.\n<b>Reason:</b> ${rejReason}\n\nYour <b>${refundAmt.toLocaleString()} HOOCOOH Coins</b> have been returned to your miner balance.`;
          sendTelegramMsg(botToken, w.telegramId, msg);
        }

        res.status(200).json({ ok: true, message: `Withdrawal rejected and ${refundAmt.toLocaleString()} coins refunded to user.` });
        return;
      }

      // 3. Ban User (and optionally reject pending withdrawal)
      if (action === "ban_user") {
        const { telegramId, reason, withdrawalId } = req.body || {};
        if (!telegramId) {
          res.status(400).json({ error: "telegramId required" });
          return;
        }

        const tid = String(telegramId);
        const numId = Number(telegramId);
        const banReason = (reason || "Violation of HOOCOOH Miner rules & anti-cheat policies").trim();

        await usersCol.updateMany(
          { $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])] },
          {
            $set: {
              isBanned: true,
              banReason: banReason,
              bannedAt: Date.now(),
              bannedAtDate: new Date(),
              dataPurged: false
            },
            $unset: { lastActiveAt: "" }
          }
        );

        // If from withdrawal, reject it only if still PENDING
        if (withdrawalId) {
          let objId;
          try { objId = new ObjectId(withdrawalId); } catch(e){ objId = null; }
          const targetWQuery = objId ? { _id: objId } : { _id: withdrawalId };
          await withdrawalsCol.updateOne(
            { ...targetWQuery, status: "PENDING" },
            { $set: { status: "REJECTED", reason: "User Banned: " + banReason, rejectedAt: Date.now() } }
          );
        }

        // Notify banned user
        if (botToken) {
          const msg = `⛔ <b>Account Suspended</b>\n\nYour HOOCOOH Miner account has been suspended.\n<b>Reason:</b> ${banReason}\n\n<i>⚠️ Notice: If this suspension is not lifted within 7 days, all your account progress, coins, and referrals will be permanently deleted while account remains suspended.</i>`;
          sendTelegramMsg(botToken, tid, msg);
        }

        res.status(200).json({ ok: true, message: `User ${tid} has been permanently banned.` });
        return;
      }

      // 3b. Bulk Ban High Fraud Risk (80% - 100%) Users
      if (action === "bulk_ban_high_risk") {
        const candidates = await usersCol.find({
          isBanned: { $ne: true },
          $or: [
            { isFakeAdBypasser: true },
            { permanentWarning: true },
            { isHighRiskHacker: true },
            { balance: { $lt: 0 } },
            { isSuspendedMultipleAccount: true },
            { isSuspicious: true },
            { deviceViolationsCount: { $gt: 0 } },
            { adSkipUnder9sStrikes: { $gt: 0 } },
            { spinUnder5sStrikes: { $gte: 3 } },
            { securityFlag: { $exists: true, $ne: "" } },
            { suspiciousReason: { $regex: "tamper|bot|hack|exploit|script", $options: "i" } }
          ]
        }).toArray();

        // Strictly target users whose fraud risk score is between 80% and 100%
        const highRiskUsers = candidates.filter(u => {
          const score = calculateFraudRiskScore(u);
          return score >= 80 && score <= 100;
        });

        if (highRiskUsers.length === 0) {
          res.status(200).json({
            ok: true,
            bannedCount: 0,
            message: "No active users found with High Fraud Risk (80%-100%). All clean users are protected!"
          });
          return;
        }

        const targetIds = highRiskUsers.map(u => u._id);
        const banTimestamp = Date.now();
        const banDate = new Date();
        const banReason = "Permanent ban: High Fraud Risk Score (80%-100%) detected (automated bot/tampering/multi-account exploit)";

        const banResult = await usersCol.updateMany(
          { _id: { $in: targetIds }, isBanned: { $ne: true } },
          {
            $set: {
              isBanned: true,
              banReason: banReason,
              bannedAt: banTimestamp,
              bannedAtDate: banDate,
              dataPurged: false
            },
            $unset: { lastActiveAt: "" }
          }
        );

        // Reject any pending withdrawals from these high-risk users
        const tgIds = highRiskUsers.map(u => String(u.telegramId)).filter(Boolean);
        if (tgIds.length > 0) {
          await withdrawalsCol.updateMany(
            {
              status: "PENDING",
              $or: [
                { telegramId: { $in: tgIds } },
                { telegramId: { $in: tgIds.map(Number).filter(Boolean) } }
              ]
            },
            {
              $set: {
                status: "REJECTED",
                reason: "User Banned: " + banReason,
                rejectedAt: banTimestamp
              }
            }
          ).catch(() => {});
        }

        res.status(200).json({
          ok: true,
          bannedCount: banResult.modifiedCount,
          totalEligible: highRiskUsers.length,
          message: `Successfully banned ${banResult.modifiedCount} high fraud risk user(s) (Score 80%-100%). Clean users were not affected.`
        });
        return;
      }

      // 4. Unban User
      if (action === "unban_user") {
        const { telegramId } = req.body || {};
        if (!telegramId) {
          res.status(400).json({ error: "telegramId required" });
          return;
        }

        const tid = String(telegramId);
        const numId = Number(telegramId);

        await usersCol.updateMany(
          { $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])] },
          {
            $set: {
              isBanned: false,
              banReason: null,
              accountLocked: false,
              velocityFlaggedAt: null,
              velocityFlaggedReason: null,
              unbannedAt: Date.now(),
              bannedAt: null,
              bannedAtDate: null,
              dataPurged: false,
              lastActiveAt: new Date()
            }
          }
        );

        // Notify user
        if (botToken) {
          const msg = `✅ <b>Account Restored!</b>\n\nYour suspension has been lifted. You can now reopen and continue mining on HOOCOOH Miner.`;
          sendTelegramMsg(botToken, tid, msg);
        }

        res.status(200).json({ ok: true, message: `User ${tid} has been unbanned successfully.` });
        return;
      }

      // 4b. Clear Security / Suspicious Flag
      if (action === "clear_suspicious") {
        const { telegramId } = req.body || {};
        if (!telegramId) {
          res.status(400).json({ error: "telegramId required" });
          return;
        }

        const tid = String(telegramId);
        const numId = Number(telegramId);
        const query = { $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])] };

        // Permanent warning safeguard: Cannot be removed if flagged as Ghost Claim bypass!
        const targetUser = await usersCol.findOne(query);
        if (targetUser && (targetUser.isFakeAdBypasser || targetUser.permanentWarning || targetUser.securityFlag === "RED_FLAG_FAKE_AD_BYPASS")) {
          res.status(400).json({
            ok: false,
            error: "PERMANENT_WARNING_LOCKED",
            message: `⚠️ User ${tid} has a PERMANENT security flag (${targetUser.securityFlag || "RED_FLAG_FAKE_AD_BYPASS"}). Ghost Claim / Fake Ad Bypass warnings cannot be cleared!`
          });
          return;
        }

        await usersCol.updateMany(
          query,
          {
            $unset: {
              isSuspicious: "",
              suspiciousReason: "",
              isHighRiskHacker: "",
              securityFlag: "",
              lastSuspiciousAt: "",
              spinUnder5sStrikes: ""
            }
          }
        );

        res.status(200).json({ ok: true, message: `Security/Suspicious flag cleared for user ${tid}.` });
        return;
      }

      // 5. Update Funds (Add or Deduct coins)
      if (action === "update_funds") {
        const { telegramId, delta, note } = req.body || {};
        if (!telegramId || delta === undefined) {
          res.status(400).json({ error: "telegramId and delta required" });
          return;
        }

        const numDelta = parseInt(delta, 10);
        if (isNaN(numDelta) || numDelta === 0) {
          res.status(400).json({ error: "Delta must be a non-zero integer" });
          return;
        }

        const tid = String(telegramId);
        const numId = Number(telegramId);

        const targetUser = await usersCol.findOne({
          $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])]
        });

        if (!targetUser) {
          res.status(404).json({ error: "User not found" });
          return;
        }

        const currentBal = Number(targetUser.balance || 0);
        const newBal = Math.max(0, currentBal + numDelta);

        await usersCol.updateOne(
          { _id: targetUser._id },
          { $set: { balance: newBal } }
        );

        // Notify user if added/deducted
        if (botToken) {
          const sign = numDelta > 0 ? "+" : "";
          const msg = `💰 <b>Balance Adjustment by Admin</b>\n\nYour balance was adjusted by: <b>${sign}${numDelta.toLocaleString()} HOOCOOH Coins</b>\n<b>New Balance:</b> ${newBal.toLocaleString()} Coins\n${note ? ("<b>Note:</b> " + note) : ""}`;
          sendTelegramMsg(botToken, tid, msg);
        }

        res.status(200).json({
          ok: true,
          previousBalance: currentBal,
          newBalance: newBal,
          delta: numDelta,
          message: `Balance updated: ${currentBal.toLocaleString()} -> ${newBal.toLocaleString()} Coins.`
        });
        return;
      }

      // 6. Broadcast to All Users (Instant + Cron-Job.org Background Queue for Large User Bases)
      if (action === "broadcast") {
        const { message, photoUrl, buttonText, buttonUrl } = req.body || {};
        if (!message || !message.trim()) {
          res.status(400).json({ error: "Message is required" });
          return;
        }

        if (!botToken) {
          res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not set" });
          return;
        }

        const result = await startOrContinueBroadcast(
          db,
          botToken,
          { message, photoUrl, buttonText, buttonUrl },
          5800
        );

        res.status(200).json(result);
        return;
      }

      if (action === "broadcast_step" || action === "broadcast_status") {
        if (!botToken) {
          res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not set" });
          return;
        }
        const stepRes = await processBroadcastQueue(db, botToken, 5800);
        res.status(200).json({ ok: true, ...stepRes });
        return;
      }

      // Reset Admin's Own Verification Status (Admin Only - for re-testing 4-digit code verify anytime)
      if (action === "reset_my_verification" || action === "reset_admin_verification") {
        const adminIdsSet = await getAdminTelegramIds(db);
        const reqAdminUid = String((req.body && req.body.adminUid) || "").trim();
        if (reqAdminUid && adminIdsSet.has(reqAdminUid)) {
          adminIdsSet.clear();
          adminIdsSet.add(reqAdminUid);
        }
        const adminIdList = Array.from(adminIdsSet);
        if (adminIdList.length === 0) {
          res.status(400).json({ error: "No Admin Telegram ID configured." });
          return;
        }

        const orQueries = [];
        for (const aid of adminIdList) {
          orQueries.push({ telegramId: String(aid) });
          const nId = Number(aid);
          if (!isNaN(nId)) orQueries.push({ telegramId: nId });
        }

        await usersCol.updateMany(
          { $or: orQueries },
          { $set: { isIdentityVerified: false, identityVerifiedAt: 0 } }
        );

        const codesCol = db.collection("user_verification_codes");
        await codesCol.updateMany(
          { userId: { $in: adminIdList.map(String) }, used: false },
          { $set: { used: true, reason: "admin_reset" } }
        );

        res.status(200).json({
          ok: true,
          resetAdminIds: adminIdList,
          message: `Code verification reset for your Admin ID (${adminIdList.join(", ")})! Open the Mini App now to verify again.`
        });
        return;
      }

      // 7. Create Task (Admin can post for free, set limit or unlimited, reward fixed at 10)
      if (action === "create_task") {
        const { title, link, type, targetUsers, isUnlimited } = req.body || {};
        if (!title || !title.trim()) {
          res.status(400).json({ error: "Task title is required" });
          return;
        }
        if (!link || !link.trim()) {
          res.status(400).json({ error: "Link is required" });
          return;
        }

        let cleanLink = link.trim();
        if (!cleanLink.startsWith("http") && !cleanLink.startsWith("t.me")) {
          cleanLink = "https://t.me/" + cleanLink.replace(/^@/, "");
        } else if (cleanLink.startsWith("t.me")) {
          cleanLink = "https://" + cleanLink;
        }

        const taskType = type === "verified" ? "verified" : "normal";
        const finalCount = isUnlimited ? 99999999 : (Math.max(1, parseInt(targetUsers, 10) || 100));

        const newTask = {
          creatorId: "admin",
          type: taskType,
          title: title.trim(),
          link: cleanLink,
          reward: 10, // Strictly fixed at 10 HOOCOOH Coins as required!
          targetCount: finalCount,
          isUnlimited: !!isUnlimited,
          completedBy: [],
          status: "active",
          createdAt: Date.now()
        };

        const insRes = await tasksCol.insertOne(newTask);

        res.status(200).json({
          ok: true,
          task: { id: String(insRes.insertedId), ...newTask },
          message: `Task successfully created! Target: ${isUnlimited ? 'Unlimited' : finalCount} users, Reward: 10 HOOCOOH Coins.`
        });
        return;
      }

      // 8. Delete / Disable Task
      if (action === "delete_task") {
        const { taskId } = req.body || {};
        if (!taskId) {
          res.status(400).json({ error: "taskId is required" });
          return;
        }

        let objId;
        try { objId = new ObjectId(taskId); } catch(e){ objId = null; }
        const tQuery = objId ? { _id: objId } : { _id: taskId };

        await tasksCol.deleteOne(tQuery);

        res.status(200).json({ ok: true, message: "Task deleted successfully." });
        return;
      }

      // 9. Set Admin Telegram ID
      if (action === "set_admin_telegram_id") {
        const { adminTelegramId } = req.body || {};
        if (!adminTelegramId || !String(adminTelegramId).trim()) {
          res.status(400).json({ error: "adminTelegramId is required" });
          return;
        }
        await db.collection("settings").updateOne(
          { key: "bot_settings" },
          { $set: { adminTelegramId: String(adminTelegramId).trim(), updatedAt: Date.now() } },
          { upsert: true }
        );
        res.status(200).json({
          ok: true,
          message: `Admin Telegram ID successfully set to: ${String(adminTelegramId).trim()}`
        });
        return;
      }

      // 10. Register Webhook with Telegram API
      if (action === "set_webhook") {
        if (!botToken) {
          res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not configured in environment variables" });
          return;
        }
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        const protocol = req.headers["x-forwarded-proto"] || "https";
        const webhookUrl = `${protocol}://${host}/api/webhook`;

        const tgRes = await fetch(
          `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=true`
        );
        const tgData = await tgRes.json();
        res.status(200).json({
          ok: true,
          webhookUrl,
          telegramResponse: tgData
        });
        return;
      }

      // 11. Update Watch Ad Reward
      if (action === "update_ad_reward") {
        const { reward } = req.body || {};
        const parsedReward = parseInt(reward, 10);
        if (isNaN(parsedReward) || parsedReward < 1 || parsedReward > 100000) {
          res.status(400).json({ error: "Reward must be a positive number between 1 and 100,000" });
          return;
        }

        await db.collection("settings").updateOne(
          { key: "app_settings" },
          { $set: { watchAdReward: parsedReward, updatedAt: Date.now() } },
          { upsert: true }
        );

        res.status(200).json({
          ok: true,
          watchAdReward: parsedReward,
          message: `Watch Ad reward successfully set to ${parsedReward} HOOCOOH Coins!`
        });
        return;
      }

      // 11.5. Update Ad Mission Reward (Coins)
      if (action === "update_ad_mission_reward") {
        const { reward } = req.body || {};
        const parsedReward = parseInt(reward, 10);
        if (isNaN(parsedReward) || parsedReward < 1 || parsedReward > 100000) {
          res.status(400).json({ error: "Reward must be a positive number between 1 and 100,000" });
          return;
        }

        await db.collection("settings").updateOne(
          { key: "app_settings" },
          { $set: { adMissionReward: parsedReward, updatedAt: Date.now() } },
          { upsert: true }
        );

        res.status(200).json({
          ok: true,
          adMissionReward: parsedReward,
          message: `Ad Mission reward successfully set to ${parsedReward} HOOCOOH Coins!`
        });
        return;
      }

      // 12. Update HOOCOOH Coin Price ($ USD Rate)
      if (action === "update_coin_price") {
        const { coinPrice } = req.body || {};
        const parsedPrice = parseFloat(coinPrice);
        if (isNaN(parsedPrice) || parsedPrice <= 0 || parsedPrice > 1000) {
          res.status(400).json({ error: "Coin price must be a valid positive number (e.g. 0.00003)" });
          return;
        }

        await db.collection("settings").updateOne(
          { key: "app_settings" },
          { $set: { coinPriceUsd: parsedPrice, updatedAt: Date.now() } },
          { upsert: true }
        );

        res.status(200).json({
          ok: true,
          coinPriceUsd: parsedPrice,
          message: `HOOCOOH Coin price successfully set to $${parsedPrice} USD per coin!`
        });
        return;
      }

      res.status(400).json({ error: "Unknown POST action" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("admin.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
