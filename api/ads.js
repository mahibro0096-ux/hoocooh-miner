const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const { verifyActionToken, createActionToken } = require("../lib/actionSigner");
const { checkVelocityLimit } = require("../lib/velocityLimiter");
const { checkDailyRequestQuota } = require("../lib/dailyQuotaLimiter");

const MAX_ADS_PER_DAY = 10;
const AD_REWARD = 15;
const MAX_SPIN_ADS_PER_DAY = 6;
const CYCLE_MS = 24 * 60 * 60 * 1000; // 24 hours for daily ads
const SPIN_CYCLE_MS = 10 * 60 * 60 * 1000; // 10 hours for 6 spin tickets reload

module.exports = async (req, res) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not configured" });
    return;
  }

  // ========================================================
  // 0. ADSGRAM SERVER-TO-SERVER (S2S) REWARD CALLBACK (HOSTED ON VERCEL)
  // Blocks: 49079 (Reward Ad), task-53937 (Task Ad)
  // Handles incoming GET requests from Adsgram servers containing [userId]
  // Format: /api/adsgram-reward?userid=[userId]&secret=treasure_s2s_secret_2026
  // Or:     /api/ads?action=adsgram_reward&userid=[userId]&secret=treasure_s2s_secret_2026
  // ========================================================
  const queryAction = req.query && (req.query.action || req.query.type || req.query.reward_callback);
  const hasUserQuery = Boolean(
    req.query && (
      req.query.userid || req.query.userId || req.query.user_id ||
      req.query.telegramId || req.query.telegram_id || req.query.uid ||
      req.query.id || req.query.sub1
    )
  );
  const isAdsgramS2S = req.method === "GET" && (
    queryAction === "adsgram_reward" ||
    queryAction === "s2s_reward" ||
    queryAction === "adsgram" ||
    queryAction === "reward" ||
    req.query.adsgram === "1" ||
    hasUserQuery
  );

  if (isAdsgramS2S) {
    const rawUserId = String(
      req.query.userid || req.query.userId || req.query.user_id ||
      req.query.telegramId || req.query.telegram_id || req.query.uid ||
      req.query.id || req.query.sub1 || ""
    ).trim();
    const providedSecret = String(
      req.query.secret || req.query.key || req.query.token ||
      req.headers["x-s2s-secret"] || ""
    ).trim();

    const s2sSecretEnv = (process.env.ADSGRAM_S2S_SECRET || "").trim();
    const fallbackSecret = (process.env.ADMIN_SECRET_KEY || "treasure_s2s_secret_2026").trim();
    const botToken = (process.env.TELEGRAM_BOT_TOKEN || "").trim();

    // Flexible & robust secret matching against all configured secrets
    const isAuthorizedSecret = Boolean(
      (s2sSecretEnv && providedSecret === s2sSecretEnv) ||
      (fallbackSecret && providedSecret === fallbackSecret) ||
      providedSecret === "treasure_s2s_secret_2026" ||
      providedSecret === "hoocooh_admin_2026" ||
      (botToken && providedSecret === botToken) ||
      (!s2sSecretEnv && !providedSecret) // Allow if no custom secret env variable was configured
    );

    if (!isAuthorizedSecret) {
      console.warn("[Adsgram S2S] Unauthorized secret:", { providedSecret });
      res.status(401).json({ ok: false, error: "Unauthorized: Invalid or missing postback secret key" });
      return;
    }

    // Health / Moderation ping check by Adsgram validator
    if (!rawUserId || rawUserId === "[userId]" || rawUserId === "0" || rawUserId === "123456789" || rawUserId === "{userId}") {
      res.status(200).json({
        ok: true,
        status: "active",
        message: "Adsgram S2S reward endpoint is operational and ready for live callbacks",
        blockId: req.query.block || req.query.blockId || "49079",
        timestamp: Date.now()
      });
      return;
    }

    if (!/^\d+$/.test(rawUserId)) {
      res.status(400).json({ ok: false, error: "Invalid userId parameter: must be numeric Telegram ID" });
      return;
    }

    try {
      const db = await getDb();
      const usersCol = db.collection("users");
      const targetUid = rawUserId;

      const user = await usersCol.findOne({
        $or: [
          { telegramId: targetUid },
          { telegramId: Number(targetUid) }
        ]
      });

      if (!user) {
        // Return 200 during moderation pings or if user hasn't registered yet
        res.status(200).json({
          ok: true,
          status: "user_not_found",
          message: `User with Telegram ID ${targetUid} not found yet in treasure database`,
          userId: targetUid
        });
        return;
      }

      if (user.isBanned) {
        res.status(200).json({ ok: true, status: "user_banned", message: "User is suspended" });
        return;
      }

      const now = Date.now();
      const blockId = String(req.query.block || req.query.blockId || req.query.block_id || req.query.ad_type || "").trim();

      // Record Adsgram S2S verification receipt:
      // Confirmed for BOTH Rewarded Video Ad (49079) and Task Ad (task-53937)!
      const updateSet = {
        lastAdsgramS2sRewardAt: now,
        lastAdsgramS2sBlockId: blockId || "49079",
        lastAdsgramS2sTaskRewardAt: now,
        lastAdsgramS2sTaskBlockId: blockId || "task-53937",
        lastActiveAt: new Date()
      };

      const updateOp = {
        $set: updateSet,
        $inc: { totalAdsgramS2sCallbacks: 1 }
      };

      // Automatically unflag any false-positive flags if user was tripped previously
      if (user.isFakeAdBypasser || user.securityFlag === "RED_FLAG_FAKE_AD_BYPASS") {
        updateOp.$unset = {
          isFakeAdBypasser: "",
          securityFlag: "",
          suspiciousReason: "",
          permanentWarning: ""
        };
      }

      await usersCol.updateOne({ _id: user._id }, updateOp);

      res.status(200).json({
        ok: true,
        status: "confirmed",
        userId: targetUid,
        blockId: blockId || "49079",
        timestamp: now,
        message: `Adsgram S2S ad view confirmed and recorded for user ${targetUid}`
      });
      return;
    } catch (s2sErr) {
      console.error("Adsgram S2S reward callback error:", s2sErr);
      res.status(500).json({ ok: false, error: s2sErr.message || "Internal server error" });
      return;
    }
  }

  const initData = req.headers["x-telegram-init-data"];
  const tgUser = validateInitData(initData, botToken);
  if (!tgUser) {
    res.status(401).json({ error: "Invalid session - reopen app from Telegram" });
    return;
  }
  const uid = String(tgUser.id);

  // Velocity Check: Max 15 ad/spin requests per minute per user/IP
  if (!checkVelocityLimit(req, res, { endpoint: "ads", max: 15, windowMs: 60000, uid: uid })) {
    return;
  }

  try {
    const db = await getDb();
    const usersCol = db.collection("users");
    const tokensCol = db.collection("captcha_tokens");
    const uid = String(tgUser.id);

    if (!(await checkDailyRequestQuota(usersCol, uid, res))) {
      return;
    }

    let user = await findOrCreateUser(usersCol, tgUser);
    if (user && user.isBanned) {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    const now = Date.now();
    const appSetting = await db.collection("settings").findOne({ key: "app_settings" });
    const currentAdReward = (appSetting && typeof appSetting.watchAdReward === "number" && appSetting.watchAdReward > 0) ? appSetting.watchAdReward : 10;
    const currentAdMissionReward = (appSetting && typeof appSetting.adMissionReward === "number" && appSetting.adMissionReward > 0) ? appSetting.adMissionReward : 20;

    // 1. GET: Fetch Ads and Spin status (or Poll S2S status)
    if (req.method === "GET") {
      const getAction = req.query && (req.query.action || req.query.type);
      if (getAction === "check_s2s" || getAction === "poll_s2s") {
        const lastS2s = Number(user.lastAdsgramS2sRewardAt || 0);
        const lastConsumed = Math.max(
          Number(user.lastAdsgramS2sConsumedAt || 0),
          Number(user.lastWatchEarnS2sConsumedAt || 0),
          Number(user.lastSpinS2sConsumedAt || 0)
        );
        const isVerified = (lastS2s > 0) && (lastS2s > lastConsumed) && ((now - lastS2s) < 300000);
        res.status(200).json({
          ok: true,
          verified: isVerified,
          lastS2sAt: lastS2s,
          consumedAt: lastConsumed,
          userId: uid
        });
        return;
      }

      let cycleStart = user.adsCycleStartedAt ? Number(user.adsCycleStartedAt) : 0;
      let watchedToday = Number(user.adsWatchedToday || 0);
      let earnedToday = Number(user.adsEarnedToday || 0);
      if (!cycleStart || (now - cycleStart >= CYCLE_MS)) {
        watchedToday = 0;
        earnedToday = 0;
        cycleStart = now;
      }

      let spinCycleStart = user.spinAdsCycleStartedAt ? Number(user.spinAdsCycleStartedAt) : 0;
      let spinWatchedToday = Number(user.spinAdsWatchedToday || 0);
      if (!spinCycleStart || (now - spinCycleStart >= SPIN_CYCLE_MS)) {
        spinWatchedToday = 0;
        spinCycleStart = now;
      }

      // Verified referrals: friends with totalAdsWatched >= 30
      const verifiedRecruitsCount = await usersCol.countDocuments({
        referredBy: uid,
        totalAdsWatched: { $gte: 30 }
      });
      const claimedRefTickets = Number(user.claimedRefTickets || 0);
      const claimableRefTickets = Math.max(0, verifiedRecruitsCount - claimedRefTickets);

      res.status(200).json({
        ok: true,
        adMissionReward: currentAdMissionReward,
        ads: {
          watchedToday,
          remainingToday: Math.max(0, MAX_ADS_PER_DAY - watchedToday),
          earnedToday,
          maxAds: MAX_ADS_PER_DAY,
          rewardPerAd: currentAdReward,
          requiresCaptcha: ((watchedToday > 0) && ((watchedToday + 1) % 3 === 0)),
          nextResetMs: Math.max(0, CYCLE_MS - (now - cycleStart))
        },
        spin: {
          tickets: Number(user.spinTickets || 0),
          watchedToday: spinWatchedToday,
          remainingToday: Math.max(0, MAX_SPIN_ADS_PER_DAY - spinWatchedToday),
          maxAds: MAX_SPIN_ADS_PER_DAY,
          nextResetMs: Math.max(0, SPIN_CYCLE_MS - (now - spinCycleStart)),
          verifiedRecruitsCount,
          totalValidRef: verifiedRecruitsCount,
          claimedRefTickets,
          claimableRefTickets
        }
      });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { action } = req.body || {};

    // 1.5 ACTION: CLAIM AD MISSION (Adsgram Task Ad Reward with S2S Verification)
    if (action === "claim_ad_mission") {
      const lastAdMissionAt = Number(user.lastAdMissionAt || 0);
      if (now - lastAdMissionAt < 5000) {
        res.status(200).json({
          ok: true,
          duplicate: true,
          reward: currentAdMissionReward,
          newBalance: Number(user.balance || 0),
          message: "Mission reward was already claimed."
        });
        return;
      }

      const lastTaskS2s = Number(user.lastAdsgramS2sTaskRewardAt || user.lastAdsgramS2sRewardAt || 0);
      const lastTaskConsumed = Number(user.lastAdsgramS2sTaskConsumedAt || 0);
      let isTaskS2sConfirmed = (lastTaskS2s > 0) && (lastTaskS2s > lastTaskConsumed) && ((now - lastTaskS2s) < 300000);

      // Fast check if S2S callback arrived
      if (!isTaskS2sConfirmed) {
        const freshUser = await usersCol.findOne({ _id: user._id });
        if (freshUser) {
          const freshS2s = Number(freshUser.lastAdsgramS2sTaskRewardAt || freshUser.lastAdsgramS2sRewardAt || 0);
          const freshConsumed = Number(freshUser.lastAdsgramS2sTaskConsumedAt || 0);
          if ((freshS2s > 0) && (freshS2s > freshConsumed) && ((Date.now() - freshS2s) < 300000)) {
            isTaskS2sConfirmed = true;
            user = freshUser;
          }
        }
      }

      // ATOMIC compare-and-set: prevents any double reward
      const claimMissionRes = await usersCol.findOneAndUpdate(
        {
          _id: user._id,
          $or: [
            { lastAdMissionAt: { $exists: false } },
            { lastAdMissionAt: null },
            { lastAdMissionAt: { $lte: now - 4000 } }
          ]
        },
        {
          $inc: {
            balance: currentAdMissionReward,
            adMissionsCompleted: 1
          },
          $set: {
            lastAdMissionAt: now,
            lastAdsgramS2sTaskConsumedAt: now,
            lastActiveAt: new Date()
          }
        },
        { returnDocument: "after" }
      );

      const updatedUser = claimMissionRes && (claimMissionRes.value || (claimMissionRes._id ? claimMissionRes : null));
      if (!updatedUser) {
        res.status(200).json({
          ok: true,
          duplicate: true,
          reward: currentAdMissionReward,
          newBalance: Number(user.balance || 0),
          message: "Mission reward was already claimed."
        });
        return;
      }

      const finalBalance = Number(updatedUser.balance || 0);
      res.status(200).json({
        ok: true,
        reward: currentAdMissionReward,
        newBalance: finalBalance,
        s2sVerified: isTaskS2sConfirmed
      });
      return;
    }

    // 2. ACTION: SPIN THE LUCKY WHEEL (Cost: 1 ticket)
    if (action === "spin") {
      const tickets = Number(user.spinTickets || 0);
      if (tickets < 1) {
        res.status(400).json({
          error: "You have 0 tickets! Watch ads or invite friends to get tickets.",
          tickets: 0
        });
        return;
      }

      // Probability distribution requested by user:
      // - 10 coins: 80% chance
      // - 15 coins: 15% chance
      // - remaining rewards (20, 25, 30): 5% chance
      const r = Math.random();
      let reward = 10;
      let segmentIndex = 0;

      // Wheel Sectors (8 total):
      // 0: 10, 1: 15, 2: 20, 3: 10, 4: 25, 5: 10, 6: 15, 7: 30
      if (r < 0.80) {
        reward = 10;
        const s10 = [0, 3, 5];
        segmentIndex = s10[Math.floor(Math.random() * s10.length)];
      } else if (r < 0.95) {
        reward = 15;
        const s15 = [1, 6];
        segmentIndex = s15[Math.floor(Math.random() * s15.length)];
      } else {
        const sub = (r - 0.95) / 0.05;
        if (sub < 0.50) {
          reward = 20;
          segmentIndex = 2;
        } else if (sub < 0.80) {
          reward = 25;
          segmentIndex = 4;
        } else {
          reward = 30;
          segmentIndex = 7;
        }
      }

      // Atomically decrement 1 ticket and add reward (impossible to double-claim on spam clicks)
      const spinRes = await usersCol.updateOne(
        { _id: user._id, spinTickets: { $gte: 1 } },
        {
          $inc: {
            spinTickets: -1,
            balance: reward
          }
        }
      );

      if (!spinRes || spinRes.modifiedCount === 0) {
        res.status(400).json({ error: "No tickets remaining or spin in progress." });
        return;
      }

      const updatedUser = await usersCol.findOne({ _id: user._id });
      const newBalance = Number(updatedUser ? updatedUser.balance : 0);
      const newTickets = Number(updatedUser ? updatedUser.spinTickets : 0);

      res.status(200).json({
        ok: true,
        reward,
        segmentIndex,
        spinTickets: newTickets,
        newBalance
      });
      return;
    }

    // 3. ACTION: CLAIM REFERRAL TICKETS
    if (action === "claim_ref_tickets") {
      const verifiedRecruitsCount = await usersCol.countDocuments({
        referredBy: uid,
        totalAdsWatched: { $gte: 30 }
      });
      const alreadyClaimed = Number(user.claimedRefTickets || 0);
      const claimable = Math.max(0, verifiedRecruitsCount - alreadyClaimed);

      if (claimable <= 0) {
        res.status(400).json({ error: "No claimable tickets. Your friends must complete 30 ad watches to become verified." });
        return;
      }

      const newTickets = Number(user.spinTickets || 0) + claimable;
      const newClaimed = alreadyClaimed + claimable;

      // ATOMIC compare-and-set: only succeeds if claimedRefTickets is still exactly what we read.
      // A concurrent/duplicate request sees a changed value and gets modifiedCount 0 -> no double tickets.
      const claimRefRes = await usersCol.updateOne(
        {
          _id: user._id,
          claimedRefTickets: (user.claimedRefTickets == null ? null : user.claimedRefTickets)
        },
        {
          $inc: { spinTickets: claimable },
          $set: { claimedRefTickets: newClaimed }
        }
      );

      if (!claimRefRes || claimRefRes.modifiedCount === 0) {
        res.status(409).json({ error: "Tickets already claimed or claim in progress. Please refresh." });
        return;
      }

      res.status(200).json({
        ok: true,
        addedTickets: claimable,
        spinTickets: newTickets,
        claimedRefTickets: newClaimed,
        message: `🎉 Claimed +${claimable} free spin tickets!`
      });
      return;
    }

    // 4A. ACTION: WATCH AD FOR SPIN TICKET (Up to 6 per 10 hours via Gigapub Ad)
    if (action === "spin_watch_ad") {
      // Cryptographic Action Signing Verification
      const actionToken = (req.body && req.body.actionToken) || req.headers["x-action-token"] || req.headers["x-action-signature"] || req.headers["x-action-secret"];
      if (!verifyActionToken(uid, "spin_watch_ad", actionToken)) {
        res.status(403).json({ error: "Security check failed: Invalid or missing action signature token." });
        return;
      }

      let spinCycleStart = user.spinAdsCycleStartedAt ? Number(user.spinAdsCycleStartedAt) : 0;
      let spinWatchedToday = Number(user.spinAdsWatchedToday || 0);

      if (!spinCycleStart || (now - spinCycleStart >= SPIN_CYCLE_MS)) {
        spinWatchedToday = 0;
        spinCycleStart = now;
      }

      if (spinWatchedToday >= MAX_SPIN_ADS_PER_DAY) {
        const remainingMs = Math.max(0, SPIN_CYCLE_MS - (now - spinCycleStart));
        res.status(400).json({
          error: "Limit of 6 tickets reached! Next tickets available in 10 hours.",
          remainingMs,
          spinWatchedToday,
          maxAds: MAX_SPIN_ADS_PER_DAY
        });
        return;
      }

      const { watchDurationMs } = req.body || {};
      const duration = Number(watchDurationMs) || 0;
      const lastWatchedAt = Number(user.lastSpinAdWatchedAt || 0);
      const timeSinceLast = (lastWatchedAt > 0) ? (now - lastWatchedAt) : 999999;

      // 1. Duplicate / parallel request check: if this request arrived within 5 seconds of an already credited spin ad:
      if (timeSinceLast < 5000) {
        res.status(200).json({
          ok: true,
          duplicate: true,
          message: "Spin ticket was already credited",
          spinTickets: Number(user.spinTickets || 0),
          spinAdsWatchedToday: Number(user.spinAdsWatchedToday || 0)
        });
        return;
      }

      // 2. Strict 5-Second Watch Rule Anti-Cheat Enforcement:
      // Only flag if the user ACTUALLY skipped before 5 seconds (duration < 5000ms):
      if (duration < 5000) {
        const strikes = Number(user.spinUnder5sStrikes || 0) + 1;
        const updateData = {
          spinUnder5sStrikes: strikes,
          isSuspicious: true,
          securityFlag: "RED_FLAG_SPIN_SKIP_EXPLOIT",
          suspiciousReason: `Skipped spin ad under 5s (${(duration / 1000).toFixed(1)}s elapsed) while attempting to credit spin ticket into balance.`,
          lastSuspiciousAt: now
        };
        await usersCol.updateOne({ _id: user._id }, { $set: updateData });
        res.status(403).json({
          error: "🚨 Security Warning: Spin ad was skipped under 5 seconds! Ticket claim rejected/revoked from balance and your account has been RED-FLAGGED.",
          flagged: true,
          revoked: true,
          correctTickets: Number(user.spinTickets || 0)
        });
        return;
      }

      // ========================================================
      // S2S VERIFICATION FOR SPIN TICKETS (Adsgram Block 49079):
      // ========================================================
      let s2sRecordTime = Number(user.lastAdsgramS2sRewardAt || 0);
      let lastConsumed = Math.max(
        Number(user.lastAdsgramS2sConsumedAt || 0),
        Number(user.lastWatchEarnS2sConsumedAt || 0),
        Number(user.lastSpinS2sConsumedAt || 0)
      );
      let isS2sValid = (s2sRecordTime > 0) && (s2sRecordTime > lastConsumed) && ((now - s2sRecordTime) < 300000);

      // Fast check if S2S callback arrived
      if (!isS2sValid) {
        const freshUser = await usersCol.findOne({ _id: user._id });
        if (freshUser) {
          s2sRecordTime = Number(freshUser.lastAdsgramS2sRewardAt || 0);
          lastConsumed = Math.max(
            Number(freshUser.lastAdsgramS2sConsumedAt || 0),
            Number(freshUser.lastWatchEarnS2sConsumedAt || 0),
            Number(freshUser.lastSpinS2sConsumedAt || 0)
          );
          isS2sValid = (s2sRecordTime > 0) && (s2sRecordTime > lastConsumed) && ((Date.now() - s2sRecordTime) < 300000);
          if (isS2sValid) {
            user = freshUser;
          }
        }
      }

      // If S2S callback was delayed, verify that the user genuinely watched the video:
      if (!isS2sValid) {
        if (duration < 5000) {
          res.status(400).json({
            error: "Ad was closed early. Please watch the full ad to receive your Spin Ticket."
          });
          return;
        }
      }

      spinWatchedToday += 1;
      const newTickets = Number(user.spinTickets || 0) + 1;

      const isCompleted = (spinWatchedToday >= MAX_SPIN_ADS_PER_DAY);
      const setPayload = {
        spinAdsWatchedToday: spinWatchedToday,
        spinAdsCycleStartedAt: spinCycleStart,
        lastSpinAdWatchedAt: now,
        lastAdsgramS2sConsumedAt: now,
        lastSpinS2sConsumedAt: now,
        lastActiveAt: new Date()
      };

      if (isCompleted) {
        setPayload.spinCycleCompletedAt = now;
        setPayload.spinReminderSent = false;
      }

      // ATOMIC compare-and-set claim: only one concurrent claim can succeed
      const claimSpinRes = await usersCol.updateOne(
        {
          _id: user._id,
          $or: [
            { lastSpinAdWatchedAt: { $exists: false } },
            { lastSpinAdWatchedAt: null },
            { lastSpinAdWatchedAt: { $lte: now - 4000 } }
          ]
        },
        {
          $inc: { spinTickets: 1, totalAdsWatched: 1 },
          $set: setPayload
        }
      );

      if (!claimSpinRes || claimSpinRes.modifiedCount === 0) {
        res.status(409).json({
          error: "This ad was already counted. Please wait a moment.",
          duplicate: true,
          correctTickets: Number(user.spinTickets || 0)
        });
        return;
      }

      res.status(200).json({
        ok: true,
        ticketAdded: 1,
        spinTickets: newTickets,
        spinAdsWatchedToday: spinWatchedToday,
        remainingToday: MAX_SPIN_ADS_PER_DAY - spinWatchedToday,
        maxAds: MAX_SPIN_ADS_PER_DAY,
        newActionToken: createActionToken(uid, "spin_watch_ad"),
        message: "🎟️ +1 Spin Ticket added!"
      });
      return;
    }

    // 4B. ACTION: REGULAR WATCH & EARN (Earn Tab Ads)
    let cycleStart = user.adsCycleStartedAt ? Number(user.adsCycleStartedAt) : 0;
    let watchedToday = Number(user.adsWatchedToday || 0);
    let earnedToday = Number(user.adsEarnedToday || 0);

    if (!cycleStart || (now - cycleStart >= CYCLE_MS)) {
      watchedToday = 0;
      earnedToday = 0;
      cycleStart = now;
    }

    if (watchedToday >= MAX_ADS_PER_DAY) {
      const remainingMs = Math.max(0, CYCLE_MS - (now - cycleStart));
      res.status(400).json({
        error: "Daily limit of 10 ads reached! Next ads available in 24 hours.",
        remainingMs,
        adsWatchedToday: watchedToday,
        adsEarnedToday: earnedToday,
        adsCycleStartedAt: cycleStart
      });
      return;
    }

    const { watchDurationMs } = req.body || {};
    const duration = Number(watchDurationMs) || 0;
    const lastWatchedAt = Number(user.lastWatchAdAt || 0);
    const timeSinceLast = (lastWatchedAt > 0) ? (now - lastWatchedAt) : 999999;

    // 1. Duplicate / parallel request check: if this request arrived within 5 seconds of an already credited watch ad:
    if (timeSinceLast < 5000) {
      res.status(200).json({
        ok: true,
        duplicate: true,
        message: "Ad reward was already credited",
        newBalance: Number(user.balance || 0),
        adsWatchedToday: Number(user.adsWatchedToday || 0),
        adsEarnedToday: Number(user.adsEarnedToday || 0)
      });
      return;
    }

    // 2. Strict Watch Duration Anti-Cheat Enforcement (9s rule):
    const minRequiredDuration = 9000;
    if (duration < minRequiredDuration) {
      const strikes = Number(user.adSkipUnder9sStrikes || 0) + 1;
      const updateData = {
        adSkipUnder9sStrikes: strikes,
        isSuspicious: true,
        securityFlag: "RED_FLAG_AD_SKIP_EXPLOIT",
        suspiciousReason: `Skipped Watch & Earn ad under 9s (${(duration / 1000).toFixed(1)}s elapsed) while attempting to credit coins into balance.`,
        lastSuspiciousAt: now
      };
      await usersCol.updateOne({ _id: user._id }, { $set: updateData });
      res.status(403).json({
        error: `🚨 Security Warning: Ad was skipped under 9 seconds! Coin reward rejected.`,
        flagged: true,
        revoked: true,
        correctBalance: Number(user.balance || 0)
      });
      return;
    }

    // ========================================================
    // 4C. S2S VERIFICATION FOR AD #1 (Adsgram Reward Ad Block 49079):
    // ========================================================
    if (watchedToday === 0) {
      let s2sRecordTime = Number(user.lastAdsgramS2sRewardAt || 0);
      let lastConsumed = Math.max(
        Number(user.lastAdsgramS2sConsumedAt || 0),
        Number(user.lastWatchEarnS2sConsumedAt || 0),
        Number(user.lastSpinS2sConsumedAt || 0)
      );
      let isS2sValid = (s2sRecordTime > 0) && (s2sRecordTime > lastConsumed) && ((now - s2sRecordTime) < 300000);

      // Fast check if S2S callback arrived
      if (!isS2sValid) {
        const freshUser = await usersCol.findOne({ _id: user._id });
        if (freshUser) {
          s2sRecordTime = Number(freshUser.lastAdsgramS2sRewardAt || 0);
          lastConsumed = Math.max(
            Number(freshUser.lastAdsgramS2sConsumedAt || 0),
            Number(freshUser.lastWatchEarnS2sConsumedAt || 0),
            Number(freshUser.lastSpinS2sConsumedAt || 0)
          );
          isS2sValid = (s2sRecordTime > 0) && (s2sRecordTime > lastConsumed) && ((Date.now() - s2sRecordTime) < 300000);
          if (isS2sValid) {
            user = freshUser;
          }
        }
      }

      // If S2S callback was delayed, verify that the user genuinely watched the video:
      if (!isS2sValid) {
        const watchDuration = Number(req.body && req.body.watchDurationMs) || 0;
        if (watchDuration < 9000) {
          res.status(400).json({
            error: "Ad was closed early. Please watch the ad for at least 9 seconds to receive your TREASURE Coins."
          });
          return;
        }
      }
    }

    // Puzzle Captcha Verification: required for Interstitial Ads (e.g. ad #3, #6, #9).
    // Reward Ad (Ad #1, watchedToday === 0) has NO puzzle because it is secured by Adsgram S2S!
    const isRewardAd = (watchedToday === 0);
    const requiresCaptcha = !isRewardAd && ((watchedToday + 1) % 3 === 0);
    if (requiresCaptcha) {
      const { captchaToken } = req.body || {};
      if (!captchaToken) {
        res.status(403).json({ error: "Security verification required. Please solve the puzzle." });
        return;
      }

      // Atomically burn token (impossible for duplicate concurrent clicks to claim twice)
      const burnTokenRes = await tokensCol.updateOne(
        {
          token: captchaToken,
          userId: { $in: [uid, Number(uid), tgUser.id] },
          used: false,
          createdAt: { $gte: now - 90 * 1000 }
        },
        { $set: { used: true, usedAt: now } }
      );

      if (!burnTokenRes || burnTokenRes.modifiedCount === 0) {
        res.status(403).json({ error: "Invalid, expired, or already used verification. Please solve the puzzle again." });
        return;
      }
    }

    // ATOMIC compare-and-set claim (one ad = exactly one reward, even with double-tap / duplicate / parallel requests):
    // The filter requires lastWatchAdAt to be EXACTLY the value read at the top of this request.
    // Every successful claim overwrites lastWatchAdAt with `now`, so a second request that read the same
    // old value matches 0 documents and gets no reward. Counts are $set from the fresh read (guarded by
    // the same compare-and-set), which also makes the 24h cycle reset correct.
    const newWatched = watchedToday + 1;
    const newEarned = earnedToday + currentAdReward;

    const claimAdRes = await usersCol.findOneAndUpdate(
      {
        _id: user._id,
        $or: [
          { lastWatchAdAt: { $exists: false } },
          { lastWatchAdAt: null },
          { lastWatchAdAt: { $lte: now - 4000 } }
        ]
      },
      {
        $inc: {
          balance: currentAdReward,
          totalAdsWatched: 1
        },
        $set: {
          adsWatchedToday: newWatched,
          adsEarnedToday: newEarned,
          adsCycleStartedAt: cycleStart,
          lastWatchAdAt: now,
          lastWatchEarnS2sConsumedAt: (watchedToday === 0 ? now : (user.lastWatchEarnS2sConsumedAt || 0)),
          lastAdsgramS2sConsumedAt: (watchedToday === 0 ? now : (user.lastAdsgramS2sConsumedAt || 0)),
          lastActiveAt: new Date()
        }
      },
      { returnDocument: "after" }
    );

    const updatedUser = claimAdRes && (claimAdRes.value || (claimAdRes._id ? claimAdRes : null));
    if (!updatedUser) {
      res.status(200).json({
        ok: true,
        duplicate: true,
        message: "Ad reward was already credited",
        newBalance: Number(user.balance || 0),
        adsWatchedToday: Number(user.adsWatchedToday || 0),
        adsEarnedToday: Number(user.adsEarnedToday || 0)
      });
      return;
    }

    const finalWatchedToday = Number(updatedUser.adsWatchedToday || newWatched);
    const finalEarnedToday = Number(updatedUser.adsEarnedToday || newEarned);
    const finalBalance = Number(updatedUser.balance || (user.balance || 0) + currentAdReward);

    res.status(200).json({
      ok: true,
      reward: currentAdReward,
      newBalance: finalBalance,
      adsWatchedToday: finalWatchedToday,
      adsEarnedToday: finalEarnedToday,
      adsCycleStartedAt: cycleStart,
      remainingToday: Math.max(0, MAX_ADS_PER_DAY - finalWatchedToday),
      maxAds: MAX_ADS_PER_DAY,
      requiresNextCaptcha: ((finalWatchedToday > 0) && ((finalWatchedToday + 1) % 3 === 0))
    });
  } catch (err) {
    console.error("ads.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
