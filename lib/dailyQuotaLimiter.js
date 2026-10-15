/**
 * Daily 24-Hour User Request Quota Limiter
 * Enforces a strict maximum of 100 requests per 24 hours per individual user.
 */

async function checkDailyRequestQuota(usersCol, telegramId, res) {
  if (!usersCol || !telegramId) return true;
  const tid = String(telegramId);
  const numId = Number(telegramId);
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  try {
    const user = await usersCol.findOne({
      $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])]
    });

    if (!user) return true;

    const cycleStart = Number(user.dailyReqCycleStart || 0);
    const currentCount = Number(user.dailyReqCount || 0);

    // If 24 hours have passed since the cycle started, reset cycle to 1
    if (!cycleStart || (now - cycleStart) >= ONE_DAY_MS) {
      await usersCol.updateOne(
        { _id: user._id },
        { $set: { dailyReqCycleStart: now, dailyReqCount: 1 } }
      );
      return true;
    }

    // If already reached limit of 100 requests in current 24-hour cycle
    if (currentCount >= 100) {
      const msLeft = (cycleStart + ONE_DAY_MS) - now;
      const hoursLeft = Math.max(1, Math.ceil(msLeft / (60 * 60 * 1000)));
      if (res) {
        res.setHeader("Retry-After", String(Math.ceil(msLeft / 1000)));
        res.status(429).json({
          error: `⚠️ 24-Hour Request Limit Reached: You have reached the maximum 100 requests allowed in 24 hours. Please wait ~${hoursLeft} hour(s) for your daily quota to reset.`,
          dailyLimitExceeded: true,
          resetInHours: hoursLeft
        });
      }
      return false;
    }

    // Otherwise increment request count
    await usersCol.updateOne(
      { _id: user._id },
      { $inc: { dailyReqCount: 1 } }
    );

    return true;
  } catch (err) {
    console.error("checkDailyRequestQuota error:", err);
    return true; // Fail-open on transient database glitch so legitimate players are not blocked
  }
}

module.exports = {
  checkDailyRequestQuota
};
