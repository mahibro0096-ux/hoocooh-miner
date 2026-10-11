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

    // 1. GET: Fetch Ads and Spin status
    if (req.method === "GET") {
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
        ads: {
          watchedToday,
          remainingToday: Math.max(0, MAX_ADS_PER_DAY - watchedToday),
          earnedToday,
          maxAds: MAX_ADS_PER_DAY,
          rewardPerAd: currentAdReward,
          requiresCaptcha: ((watchedToday + 1) % 3 === 0),
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

    // Puzzle Captcha Verification: required only once every 3 completed ads (e.g. ad #3, #6, #9)
    const requiresCaptcha = ((watchedToday + 1) % 3 === 0);
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
      requiresNextCaptcha: ((finalWatchedToday + 1) % 3 === 0)
    });
  } catch (err) {
    console.error("ads.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
