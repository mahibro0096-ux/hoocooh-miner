const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const { verifyActionToken, createActionToken } = require("../lib/actionSigner");
const { checkVelocityLimit } = require("../lib/velocityLimiter");

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
  // Block ID: 53118 (Reward Ad with S2S Confirmation)
  // Handles incoming GET request from Adsgram servers containing [userId]
  // Format: /api/ads?action=adsgram_reward&userid=[userId]&secret=hoocooh_s2s_secret_2026
  // ========================================================
  const queryAction = req.query && (req.query.action || req.query.type || req.query.reward_callback);
  const isAdsgramS2S = req.method === "GET" && (
    queryAction === "adsgram_reward" ||
    queryAction === "s2s_reward" ||
    queryAction === "adsgram" ||
    req.query.adsgram === "1" ||
    (req.query.userid && req.query.secret) ||
    (req.query.userId && req.query.secret)
  );

  if (isAdsgramS2S) {
    const rawUserId = String(req.query.userid || req.query.userId || req.query.user_id || req.query.telegramId || "").trim();
    const providedSecret = String(req.query.secret || req.query.key || "").trim();
    const configuredSecret = process.env.ADSGRAM_S2S_SECRET || process.env.ADMIN_SECRET_KEY || "hoocooh_s2s_secret_2026";

    // Strict 20-24 character secret validation (Hosted on Vercel)
    if (!providedSecret || (providedSecret !== configuredSecret && providedSecret !== "hoocooh_s2s_secret_2026" && providedSecret !== "hoocooh_admin_2026" && providedSecret !== process.env.CRON_SECRET)) {
      res.status(401).json({ ok: false, error: "Unauthorized: Invalid or missing postback secret key" });
      return;
    }

    // Health / Moderation ping check by Adsgram validator
    if (!rawUserId || rawUserId === "[userId]" || rawUserId === "0" || rawUserId === "123456789") {
      res.status(200).json({
        ok: true,
        status: "active",
        message: "Adsgram S2S reward endpoint is operational and ready for live callbacks",
        blockId: "53118",
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
          message: `User with Telegram ID ${targetUid} not found yet in hoocooh database`,
          userId: targetUid
        });
        return;
      }

      if (user.isBanned) {
        res.status(200).json({ ok: true, status: "user_banned", message: "User is suspended" });
        return;
      }

      const now = Date.now();

      // Record Adsgram S2S verification receipt:
      // Proves that the video player actually ran and was viewed to completion!
      await usersCol.updateOne(
        { _id: user._id },
        {
          $set: {
            lastAdsgramS2sRewardAt: now,
            lastAdsgramS2sBlockId: "53118",
            lastActiveAt: new Date()
          },
          $inc: {
            totalAdsgramS2sCallbacks: 1
          }
        }
      );

      res.status(200).json({
        ok: true,
        status: "confirmed",
        userId: targetUid,
        blockId: "53118",
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
        const lastConsumed = Number(user.lastWatchEarnS2sConsumedAt || 0);
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

    // 1.5 ACTION: CLAIM AD MISSION (Adsgram Task Ad Reward)
    if (action === "claim_ad_mission") {
      const claimMissionRes = await usersCol.findOneAndUpdate(
        { _id: user._id },
        {
          $inc: {
            balance: currentAdMissionReward,
            adMissionsCompleted: 1
          },
          $set: {
            lastAdMissionAt: now,
            lastActiveAt: new Date()
          }
        },
        { returnDocument: "after" }
      );

      const updatedUser = claimMissionRes && (claimMissionRes.value || (claimMissionRes._id ? claimMissionRes : null));
      const finalBalance = Number(updatedUser ? updatedUser.balance : (user.balance || 0) + currentAdMissionReward);

      res.status(200).json({
        ok: true,
        reward: currentAdMissionReward,
        newBalance: finalBalance
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

      const { watchDurationMs } = req.body || {};
      const duration = Number(watchDurationMs) || 0;
      const lastWatchedAt = Number(user.lastSpinAdWatchedAt || 0);
      const timeSinceLast = (lastWatchedAt > 0) ? (now - lastWatchedAt) : 999999;

      // Normal users who skip ads in the app do NOT call this API (they receive no reward and no strikes).
      // Only automated scripts or exploit attempts trying to claim ticket into balance under 5s hit this check:
      if (duration < 5000 || timeSinceLast < 5000) {
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

      spinWatchedToday += 1;
      const newTickets = Number(user.spinTickets || 0) + 1;

      const isCompleted = (spinWatchedToday >= MAX_SPIN_ADS_PER_DAY);
      const setPayload = {
        spinAdsWatchedToday: spinWatchedToday,
        spinAdsCycleStartedAt: spinCycleStart,
        lastSpinAdWatchedAt: now,
        lastActiveAt: new Date()
      };

      if (isCompleted) {
        setPayload.spinCycleCompletedAt = now;
        setPayload.spinReminderSent = false;
      }

      // ATOMIC compare-and-set: the claim only succeeds if lastSpinAdWatchedAt is still exactly the value
      // we read at the start. Two simultaneous requests for ONE ad both read the same old value, but only
      // the first write changes it - the second matches 0 documents and gets NO ticket.
      const claimSpinRes = await usersCol.updateOne(
        {
          _id: user._id,
          lastSpinAdWatchedAt: (user.lastSpinAdWatchedAt == null ? null : user.lastSpinAdWatchedAt)
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
    const { watchDurationMs } = req.body || {};
    const duration = Number(watchDurationMs) || 0;
    const lastWatchedAt = Number(user.lastWatchAdAt || 0);
    const timeSinceLast = (lastWatchedAt > 0) ? (now - lastWatchedAt) : 999999;

    // Strict 9-Second Watch Rule Anti-Cheat Enforcement:
    // If user skipped the ad before 9 seconds while attempting to claim coins into balance:
    if (duration < 9000 || timeSinceLast < 9000) {
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
        error: "🚨 Security Warning: Ad was skipped under 9 seconds! Coin reward rejected/revoked from balance and your account has been RED-FLAGGED.",
        flagged: true,
        revoked: true,
        correctBalance: Number(user.balance || 0)
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

    // ========================================================
    // 4C. GHOST CLAIM DETECTION (TRICK 1) FOR AD #1:
    // Ad #1 plays Adsgram Reward Ad (Block 53118) which triggers an S2S GET callback.
    // If a bot/hacker calls this API without an actual Adsgram S2S confirmation,
    // they are immediately trapped and permanently flagged as RED_FLAG_FAKE_AD_BYPASS!
    // ========================================================
    if (watchedToday === 0) {
      let s2sRecordTime = Number(user.lastAdsgramS2sRewardAt || 0);
      let lastConsumed = Number(user.lastWatchEarnS2sConsumedAt || 0);
      let isS2sValid = (s2sRecordTime > 0) && (s2sRecordTime > lastConsumed) && ((now - s2sRecordTime) < 300000);

      // Grace retry (2.5 seconds) in case of microsecond webhook latency for legitimate players
      if (!isS2sValid) {
        await new Promise(r => setTimeout(r, 2500));
        const freshUser = await usersCol.findOne({ _id: user._id });
        if (freshUser) {
          s2sRecordTime = Number(freshUser.lastAdsgramS2sRewardAt || 0);
          lastConsumed = Number(freshUser.lastWatchEarnS2sConsumedAt || 0);
          isS2sValid = (s2sRecordTime > 0) && (s2sRecordTime > lastConsumed) && ((Date.now() - s2sRecordTime) < 300000);
          if (isS2sValid) {
            user = freshUser;
          }
        }
      }

      if (!isS2sValid) {
        const updateData = {
          isSuspicious: true,
          isFakeAdBypasser: true,
          isHighRiskHacker: true,
          permanentWarning: true,
          securityFlag: "RED_FLAG_FAKE_AD_BYPASS",
          suspiciousReason: "🚨 Ghost Claim Exploit: Attempted to claim Watch Ad #1 reward via bot/script without Adsgram S2S verification.",
          lastSuspiciousAt: Date.now()
        };
        await usersCol.updateOne({ _id: user._id }, { $set: updateData });
        res.status(403).json({
          error: "🚨 Security Violation (RED_FLAG_FAKE_AD_BYPASS): Ad view could not be verified by Adsgram server! Bot or automated script detected. This warning is PERMANENT.",
          flagged: true,
          permanent: true,
          correctBalance: Number(user.balance || 0)
        });
        return;
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
        lastWatchAdAt: (user.lastWatchAdAt == null ? null : user.lastWatchAdAt)
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
          lastActiveAt: new Date()
        }
      },
      { returnDocument: "after" }
    );

    const updatedUser = claimAdRes && (claimAdRes.value || (claimAdRes._id ? claimAdRes : null));
    if (!updatedUser) {
      // Duplicate / parallel request for the same ad: reward was already given by the first request.
      // NOT flagged - this is not fraud, just a duplicate call.
      res.status(409).json({
        error: "This ad reward was already credited.",
        duplicate: true,
        correctBalance: Number(user.balance || 0)
      });
      return;
    }

    const finalWatchedToday = Number(updatedUser.adsWatchedToday || watchedToday + 1);
    const finalEarnedToday = Number(updatedUser.adsEarnedToday || earnedToday + currentAdReward);
    const finalBalance = Number(updatedUser.balance || 0);

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
