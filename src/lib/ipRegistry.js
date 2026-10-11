/**
 * lib/ipRegistry.js — Modeled from NEWTUBE-TON architecture
 * Device-fingerprint-based one-account gate with Bangladeshi carrier CGNAT protection.
 *
 * COLLECTION: ipRegistry
 *   { _id: "<fingerprint hash or 'ip:<address>'>", userId: "<telegramId>", claimedAt: Date, lastSeenAt: Date, switchCount: Number, lastSwitchAt: Date }
 *
 * COLLECTION: ipSignupVelocity
 *   { _id: "<ip>", recentSignups: [Date, ...], updatedAt: Date }
 */

const {
  IP_SIGNUP_VELOCITY_WINDOW_MS,
  SWITCH_COOLDOWN_HOURS
} = require("./constants");

function getClientIp(req) {
  if (!req) return "unknown";
  const xff = req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
  if (xff) return String(xff).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/**
 * Records this signup against raw client IP and returns how many new account
 * signups this same IP has produced inside IP_SIGNUP_VELOCITY_WINDOW_MS.
 */
async function recordSignupAndCheckVelocity(db, ip) {
  if (!ip || ip === "unknown" || ip === "127.0.0.1" || ip === "::1") {
    return { count: 0 };
  }
  const now = new Date();
  try {
    const result = await db.collection("ipSignupVelocity").findOneAndUpdate(
      { _id: ip },
      {
        $push: { recentSignups: { $each: [now], $slice: -50 } },
        $set: { updatedAt: now }
      },
      { upsert: true, returnDocument: "after" }
    );
    const entry = result?.value !== undefined ? result.value : result;
    const windowStart = Date.now() - IP_SIGNUP_VELOCITY_WINDOW_MS;
    const count = (entry?.recentSignups || []).filter(t => new Date(t).getTime() >= windowStart).length;
    return { count };
  } catch (err) {
    console.warn("recordSignupAndCheckVelocity warning:", err.message);
    return { count: 1 };
  }
}

function registryKey(fingerprint, ip) {
  if (fingerprint && typeof fingerprint === "string" && fingerprint.trim().length >= 16) {
    return fingerprint.trim();
  }
  if (ip && ip !== "unknown" && ip !== "127.0.0.1" && ip !== "::1") {
    return `ip:${ip}`;
  }
  return null;
}

/**
 * Checks if this device/IP is free or already owned by this userId.
 * Protects Bangladeshi CGNAT by allowing soft pass if only IP collided without fingerprint.
 */
async function checkDevice(db, fingerprint, ip, userId) {
  const key = registryKey(fingerprint, ip);
  if (!key) return { blocked: false, key: null };
  const isFallbackKey = key.startsWith("ip:");

  try {
    const entry = await db.collection("ipRegistry").findOne({ _id: key });
    if (!entry) return { blocked: false, unclaimed: true, key };

    if (String(entry.userId) === String(userId)) {
      // Fire-and-forget lastSeenAt update to keep TTL fresh
      db.collection("ipRegistry").updateOne({ _id: key }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
      return { blocked: false, key };
    }

    if (isFallbackKey) {
      // Soft path for mobile CGNAT (Robi, GP, Banglalink shared IPs)
      return { blocked: false, fallbackCollision: true, ownerId: entry.userId, key };
    }

    // High confidence physical device match
    return { blocked: true, ownerId: entry.userId, key };
  } catch (err) {
    console.warn("checkDevice error:", err.message);
    return { blocked: false, key };
  }
}

async function claimDevice(db, key, userId) {
  if (!key || !userId) return;
  try {
    await db.collection("ipRegistry").updateOne(
      { _id: key },
      { $set: { userId: String(userId), claimedAt: new Date(), lastSeenAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.warn("claimDevice warning:", err.message);
  }
}

async function claimDeviceForUser(db, key, userId) {
  if (!key) return { ok: true };

  try {
    const registry = db.collection("ipRegistry");
    const entry = await registry.findOne({ _id: key });
    if (entry?.lastSwitchAt) {
      const cooldownMs = SWITCH_COOLDOWN_HOURS * 60 * 60 * 1000;
      const elapsedMs = Date.now() - new Date(entry.lastSwitchAt).getTime();
      if (elapsedMs < cooldownMs) {
        return { ok: false, retryAfterMs: cooldownMs - elapsedMs };
      }
    }

    const updated = await registry.findOneAndUpdate(
      { _id: key },
      {
        $set: { userId: String(userId), claimedAt: new Date(), lastSeenAt: new Date(), lastSwitchAt: new Date() },
        $inc: { switchCount: 1 }
      },
      { upsert: true, returnDocument: "after" }
    );

    const switchCount = updated?.switchCount ?? updated?.value?.switchCount;
    if (switchCount === 5 || switchCount === 15 || switchCount === 50) {
      const adminId = process.env.ADMIN_TELEGRAM_ID;
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (adminId && botToken) {
        const alertMsg =
          `🚩 <b>Device switched ${switchCount}× (no action taken)</b>\n\n` +
          `A device/IP key has been force-switched ${switchCount} times.\n` +
          `Latest account: <code>${userId}</code>`;
        fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: String(adminId), text: alertMsg, parse_mode: "HTML" })
        }).catch(() => {});
      }
    }

    return { ok: true };
  } catch (err) {
    console.warn("claimDeviceForUser error:", err.message);
    return { ok: true };
  }
}

module.exports = {
  getClientIp,
  recordSignupAndCheckVelocity,
  checkDevice,
  claimDevice,
  claimDeviceForUser
};
