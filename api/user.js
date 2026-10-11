const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser, findUserById } = require("../lib/userHelper");
const { mineIsReady, dailyStatus, MINE_INTERVAL_MS, LEVEL_NAMES, getMultiplierForLevel } = require("../lib/gameLogic");
const { generateVerificationImage } = require("../lib/verificationImage");
const { notifyInviterReferralSuccess } = require("../lib/miningReminder");
const { createActionToken } = require("../lib/actionSigner");
const { checkVelocityLimit } = require("../lib/velocityLimiter");

let cachedBotUsername = null;
async function fetchBotUsername(token) {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    if (data.ok && data.result && data.result.username) {
      cachedBotUsername = data.result.username;
      return cachedBotUsername;
    }
  } catch(e) {}
  return "hoocooh_miner_bot";
}

let cachedAppSettings = null;
let cachedAppSettingsTime = 0;
async function getCachedAppSettings(db) {
  const now = Date.now();
  if (cachedAppSettings && (now - cachedAppSettingsTime < 60000)) {
    return cachedAppSettings;
  }
  try {
    const s = await db.collection("settings").findOne({ key: "app_settings" });
    cachedAppSettings = {
      watchAdReward: (s && typeof s.watchAdReward === "number" && s.watchAdReward > 0) ? s.watchAdReward : 10,
      coinRate: (s && typeof s.coinPriceUsd === "number" && s.coinPriceUsd > 0) ? s.coinPriceUsd : 0.00003
    };
    cachedAppSettingsTime = now;
    return cachedAppSettings;
  } catch(e) {
    return { watchAdReward: 10, coinRate: 0.00003 };
  }
}

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") {
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

  // Velocity Check: Max 30 profile requests per minute per user/IP
  if (!checkVelocityLimit(req, res, { endpoint: "user", max: 30, windowMs: 60000, uid: telegramId })) {
    return;
  }
  const clientIp = (
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    ""
  ).split(",")[0].trim();
  const clientDeviceId = String(req.headers["x-device-id"] || (req.body && req.body.deviceId) || (req.query && req.query.deviceId) || "").trim();
  const prevUid = String(req.headers["x-prev-uid"] || (req.body && req.body.prevUid) || (req.query && req.query.prevUid) || "").trim();

  try {
    const now = Date.now();
    const db = await getDb();
    const users = db.collection("users");

    // Unified user retrieval, multi-type ID lookup, and multi-account check
    let user = await findOrCreateUser(users, tgUser, { clientIp, clientDeviceId, prevUid });

    if (user && user.isBanned) {
      if (user.isSuspendedMultipleAccount || user.isMultipleAccountBlocked) {
        let primaryAccount = user.primaryAccount;
        if (!primaryAccount && user.primaryTelegramId) {
          const prim = await findUserById(users, user.primaryTelegramId);
          if (prim) {
            primaryAccount = {
              telegramId: prim.telegramId,
              name: prim.firstName || prim.name || "Original User",
              username: prim.username || "N/A",
              photoUrl: prim.photoUrl || ""
            };
          }
        }
        res.status(200).json({
          isBanned: true,
          isMultipleAccountBlocked: true,
          detectionType: user.detectionType || "ip",
          primaryAccount: primaryAccount || null,
          banReason: user.banReason || "Multiple accounts detected on same network/device",
          message: "Multiple accounts are not allowed on the same network or device! Please return to your original account or connect through a different network/VPN.",
          telegramId: user.telegramId
        });
        return;
      }

      res.status(200).json({
        isBanned: true,
        banReason: user.banReason || "Your account has been suspended",
        telegramId: user.telegramId
      });
      return;
    }

    // POST request handling (e.g. set_language)
    if (req.method === "POST") {
      const { action, language, code } = req.body || {};
      if (action === "set_language" && language) {
        const validLangs = ["en", "ru", "ar"];
        const finalLang = validLangs.includes(language) ? language : "en";
        await users.updateOne({ _id: user._id }, { $set: { language: finalLang, languageSelected: true, updatedAt: Date.now() } });
        res.status(200).json({ ok: true, language: finalLang, languageSelected: true });
        return;
      }
      if (action === "accept_terms") {
        const tid = String(user.telegramId);
        const numId = Number(user.telegramId);
        await users.updateMany(
          { $or: [{ _id: user._id }, { telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])] },
          { $set: { termsAccepted: true, termsAcceptedAt: Date.now() } }
        );
        res.status(200).json({ ok: true, termsAccepted: true });
        return;
      }

      // Verification: Request 4-digit verification code image
      if (action === "request_code" || action === "request_verification_code") {
        const now = Date.now();
        const codesCol = db.collection("user_verification_codes");

        // Duplicate suppression: if a code was created within the last 20 seconds, reuse it and don't re-send
        const recentCode = await codesCol.findOne(
          { userId: telegramId, used: false },
          { sort: { createdAt: -1 } }
        );
        if (recentCode && (now - recentCode.createdAt < 20000)) {
          const botUser = await fetchBotUsername(process.env.TELEGRAM_BOT_TOKEN);
          res.status(200).json({
            ok: true,
            expiresAt: recentCode.expiresAt,
            validitySeconds: Math.max(0, Math.floor((recentCode.expiresAt - now) / 1000)),
            botUsername: `@${botUser}`,
            message: "A verification code image was sent to your bot."
          });
          return;
        }

        const randomCode = Math.floor(1000 + Math.random() * 9000);
        const codeStr = String(randomCode);
        const expiresAt = now + (2 * 60 * 1000); // 2 minutes

        await codesCol.updateMany(
          { userId: telegramId, used: false },
          { $set: { used: true, reason: "superseded" } }
        );

        await codesCol.insertOne({
          userId: telegramId,
          code: codeStr,
          createdAt: now,
          createdAtDate: new Date(),
          expiresAt,
          used: false
        });

        const captionText =
          `🔐 <b>HOOCOOH MINER · Verify It's you</b>\n\n` +
          `Here is your secure 4-digit verification code:\n` +
          `👉 <b>Check the image above!</b>\n\n` +
          `⏱ <b>Validity: 2 minutes</b>\n` +
          `<i>Enter this 4-digit code in the app to unlock access. Never share this code.</i>`;

        let sentSuccess = false;
        try {
          const imageBuffer = generateVerificationImage(codeStr);
          const formData = new FormData();
          formData.append("chat_id", telegramId);
          const blob = new Blob([imageBuffer], { type: "image/png" });
          formData.append("photo", blob, `hoocooh_verify_${now}.png`);
          formData.append("caption", captionText);
          formData.append("parse_mode", "HTML");

          const tgRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
            method: "POST",
            body: formData
          });
          const tgData = await tgRes.json();
          sentSuccess = tgData && tgData.ok === true;
          if (!sentSuccess) {
            console.warn("sendPhoto by FormData failed:", tgData);
          }
        } catch (photoErr) {
          console.warn("sendPhoto exception:", photoErr.message);
        }

        // Fallback: send text message if sendPhoto fails
        if (!sentSuccess) {
          try {
            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: telegramId,
                parse_mode: "HTML",
                text:
                  `🔐 <b>HOOCOOH MINER · Verify It's you</b>\n\n` +
                  `Your 4-digit verification code: <code>${codeStr}</code>\n\n` +
                  `⏱ <b>Validity: 2 minutes</b>\n` +
                  `<i>Enter this 4-digit code in the app to unlock access.</i>`
              })
            });
            sentSuccess = true;
          } catch (msgErr) {
            console.error("sendMessage fallback error:", msgErr.message);
          }
        }

        const botUser = await fetchBotUsername(process.env.TELEGRAM_BOT_TOKEN);
        res.status(200).json({
          ok: true,
          expiresAt,
          validitySeconds: 120,
          botUsername: `@${botUser}`,
          message: "A 4-digit code was sent to your Telegram bot."
        });
        return;
      }

      // Verification: Submit 4-digit code
      if (action === "submit_code" || action === "submit_verification_code") {
        const cleanCode = String(code || "").trim();
        if (!/^\d{4}$/.test(cleanCode)) {
          res.status(400).json({ error: "Please enter a valid 4-digit code." });
          return;
        }

        const codesCol = db.collection("user_verification_codes");
        const activeRecord = await codesCol.findOne(
          { userId: telegramId, used: false },
          { sort: { createdAt: -1 } }
        );

        if (!activeRecord) {
          res.status(400).json({ error: "No active verification code found. Please request a new code." });
          return;
        }

        const now = Date.now();
        if (now > activeRecord.expiresAt) {
          await codesCol.updateOne({ _id: activeRecord._id }, { $set: { used: true, reason: "expired" } });
          res.status(400).json({ error: "Verification code has expired (2 minutes limit). Please request a new code." });
          return;
        }

        if (activeRecord.code !== cleanCode) {
          res.status(400).json({ error: "Incorrect verification code! Check the image in @hoocoohmine_bot and try again." });
          return;
        }

        // ATOMIC burn: only ONE request can consume this code. A duplicate / double-tap submit
        // (that would otherwise run the referral reward block twice) is stopped here.
        const burnCodeRes = await codesCol.updateOne(
          { _id: activeRecord._id, used: false },
          { $set: { used: true, verifiedAt: now } }
        );
        if (!burnCodeRes || burnCodeRes.modifiedCount === 0) {
          const freshUser = await users.findOne({ _id: user._id });
          res.status(200).json({
            ok: true,
            verified: true,
            identityVerifiedAt: (freshUser && freshUser.identityVerifiedAt) || now,
            expiresAt: now + (24 * 60 * 60 * 1000),
            balance: Number(freshUser ? freshUser.balance : user.balance) || 0,
            referralRewardGiven: false,
            message: "Identity verified successfully!"
          });
          return;
        }

        await users.updateOne(
          { _id: user._id },
          { $set: { isIdentityVerified: true, identityVerifiedAt: now } }
        );

        // Process referral: reward inviter ONLY when the recruited user completes verification!
        let referrerId = user.referredBy;
        const paramToTest = String((req.body && req.body.start_param) || tgUser.start_param || (req.query && req.query.start_param) || "").trim();
        if (!referrerId && paramToTest) {
          const parsedId = paramToTest.replace(/^ref_/, "").trim();
          if (parsedId && /^\d+$/.test(parsedId) && String(parsedId) !== telegramId) {
            referrerId = parsedId;
            user.referredBy = parsedId;
            await users.updateOne({ _id: user._id }, { $set: { referredBy: parsedId } });
          }
        }

        let userBalance = Number(user.balance) || 0;
        let referralRewardGiven = false;

        if (referrerId && String(referrerId) !== telegramId) {
          const inviter = await findUserById(users, referrerId);
          if (inviter && String(inviter.telegramId) !== telegramId) {
            const welcomeBonus = 50; // New verified recruit gets 50 HOOCOOH

            // ATOMIC one-time claim: only succeeds if referralRewarded is not already true.
            // Whichever request wins this update (modifiedCount 1) pays the inviter + sends the
            // notification. Any duplicate/parallel request gets modifiedCount 0 and does NOTHING,
            // so one referred user can NEVER reward the inviter twice or trigger a 2nd message.
            const claimRefRes = await users.updateOne(
              { _id: user._id, referralRewarded: { $ne: true } },
              {
                $set: {
                  referredBy: String(inviter.telegramId),
                  referralRewarded: true,
                  referralRewardedAt: now
                },
                $inc: { balance: welcomeBonus }
              }
            );

            if (claimRefRes && claimRefRes.modifiedCount === 1) {
              const freshRecruit = await users.findOne({ _id: user._id });
              userBalance = Number(freshRecruit ? freshRecruit.balance : (userBalance + welcomeBonus)) || 0;
              user.balance = userBalance;

              // Reward inviter: +1 recruit, +100 HOOCOOH to earnings and balance
              await users.updateOne(
                { _id: inviter._id },
                {
                  $inc: {
                    recruitsCount: 1,
                    refEarnings: 100,
                    balance: 100
                  }
                }
              );

              // Notify inviter via Telegram bot with Open HOOCOOH Mine button (sent exactly once)
              const reqProto = req.headers["x-forwarded-proto"] || "https";
              const reqHost = req.headers["x-forwarded-host"] || req.headers.host;
              const userBaseUrl = reqHost ? `${reqProto}://${reqHost}` : "";
              notifyInviterReferralSuccess(process.env.TELEGRAM_BOT_TOKEN, inviter, user, userBaseUrl).catch(() => {});

              referralRewardGiven = true;
            }
          }
        }

        res.status(200).json({
          ok: true,
          verified: true,
          identityVerifiedAt: now,
          expiresAt: now + (24 * 60 * 60 * 1000),
          balance: userBalance,
          referralRewardGiven: referralRewardGiven,
          message: "Identity verified successfully!"
        });
        return;
      }

      // Verification: Check status (24 hours validity check)
      if (action === "check_status" || action === "check_verification_status") {
        const isVerified24h = Boolean(
          user &&
          user.isIdentityVerified === true &&
          user.identityVerifiedAt &&
          (Date.now() - Number(user.identityVerifiedAt) < 24 * 60 * 60 * 1000)
        );
        res.status(200).json({
          ok: true,
          isVerified: isVerified24h
        });
        return;
      }

      res.status(400).json({ error: "Unknown action" });
      return;
    }

    // Process Referral if provided and not yet bound (DO NOT reward until verified!)
    const rawParam = String(tgUser.start_param || (req.query && req.query.start_param) || "").trim();
    if (rawParam && !user.referredBy) {
      const inviterId = rawParam.replace(/^ref_/, "").trim();
      if (inviterId && /^\d+$/.test(inviterId) && String(inviterId) !== telegramId) {
        const inviter = await findUserById(users, inviterId);
        if (inviter && String(inviter.telegramId) !== telegramId) {
          user.referredBy = String(inviter.telegramId);

          const isVerifiedNow = Boolean(
            user.isIdentityVerified === true &&
            user.identityVerifiedAt &&
            (now - Number(user.identityVerifiedAt) < 24 * 60 * 60 * 1000)
          );

          if (isVerifiedNow && !user.referralRewarded) {
            const welcomeBonus = 50; // Verified recruit gets 50 HOOCOOH

            // ATOMIC one-time claim (same guard as submit_code): only one request can ever win it.
            const claimRefRes = await users.updateOne(
              { _id: user._id, referralRewarded: { $ne: true } },
              {
                $set: { referredBy: user.referredBy, referralRewarded: true, referralRewardedAt: now },
                $inc: { balance: welcomeBonus }
              }
            );

            if (claimRefRes && claimRefRes.modifiedCount === 1) {
              user.balance = (Number(user.balance) || 0) + welcomeBonus;

              // Reward inviter: +1 recruit, +100 HOOCOOH to earnings and balance
              await users.updateOne(
                { _id: inviter._id },
                {
                  $inc: {
                    recruitsCount: 1,
                    refEarnings: 100,
                    balance: 100
                  }
                }
              );

              // Notify inviter via Telegram bot (sent exactly once)
              notifyInviterReferralSuccess(process.env.TELEGRAM_BOT_TOKEN, inviter, user).catch(() => {});
            }
          } else {
            // Unverified: simply record referredBy. Inviter gets NOTHING until verification!
            // Never overwrites an already-rewarded user or an already-bound inviter.
            await users.updateOne(
              { _id: user._id, referralRewarded: { $ne: true }, referredBy: null },
              { $set: { referredBy: user.referredBy } }
            );
          }
        }
      }
    }

    const minerLevel = Math.max(1, Math.min(10, user.minerLevel || 1));
    const minerMultiplier = getMultiplierForLevel(minerLevel);
    const minerLevelName = LEVEL_NAMES[minerLevel - 1] || "Starter";

    const botUsername = await fetchBotUsername(process.env.TELEGRAM_BOT_TOKEN);
    const CYCLE_MS = 24 * 60 * 60 * 1000;
    let cycleStart = user.adsCycleStartedAt ? Number(user.adsCycleStartedAt) : 0;
    let watchedToday = Number(user.adsWatchedToday || 0);
    let earnedToday = Number(user.adsEarnedToday || 0);

    if (cycleStart && (now - cycleStart >= CYCLE_MS)) {
      watchedToday = 0;
      earnedToday = 0;
      cycleStart = null;
      await users.updateOne({ _id: user._id }, {
        $set: { adsWatchedToday: 0, adsEarnedToday: 0, adsCycleStartedAt: null }
      });
    }

    users.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});

    res.status(200).json({
      telegramId: user.telegramId,
      firstName: user.firstName || tgUser.first_name || "Miner",
      username: user.username || tgUser.username || "",
      photoUrl: user.photoUrl || tgUser.photo_url || "",
      level: minerLevel,
      minerLevel: minerLevel,
      minerMultiplier: minerMultiplier,
      minerLevelName: minerLevelName,
      balance: user.balance,
      lastMineCollectedAt: user.lastMineCollectedAt,
      dailyCycle: user.dailyCycle || 1,
      dailyDayIndex: user.dailyDayIndex || 0,
      lastCheckinAt: user.lastCheckinAt,
      totalDailyEarned: user.totalDailyEarned || 0,
      mineReady: mineIsReady(user.lastMineCollectedAt),
      mineIntervalMs: MINE_INTERVAL_MS,
      dailyStatusNow: dailyStatus(user.lastCheckinAt),
      adsWatchedToday: watchedToday,
      adsEarnedToday: earnedToday,
      adsCycleStartedAt: cycleStart,
      recruitsCount: user.recruitsCount || 0,
      refEarnings: user.refEarnings || 0,
      claimedMilestones: user.claimedMilestones || [],
      language: user.language || "en",
      languageSelected: user.languageSelected === true,
      termsAccepted: user.termsAccepted === true,
      isIdentityVerified: Boolean(
        user.isIdentityVerified === true &&
        user.identityVerifiedAt &&
        (now - Number(user.identityVerifiedAt) < 24 * 60 * 60 * 1000)
      ),
      identityVerifiedAt: user.identityVerifiedAt || 0,
      referralRewarded: user.referralRewarded === true,
      penaltyNotice: user.penaltyNotice || null,
      deviceViolationsCount: Number(user.deviceViolationsCount || 0),
      actionTokens: {
        mine: createActionToken(telegramId, "mine"),
        spin_watch_ad: createActionToken(telegramId, "spin_watch_ad"),
        complete_task: createActionToken(telegramId, "complete_task"),
        checkin: createActionToken(telegramId, "checkin")
      },
      boundWalletAddress: user.boundWalletAddress || null,
      botUsername: botUsername,
      ...(await (async () => {
        const s = await getCachedAppSettings(db);
        return { watchAdReward: s.watchAdReward, coinRate: s.coinRate };
      })())
    });
  } catch (err) {
    console.error("user.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
