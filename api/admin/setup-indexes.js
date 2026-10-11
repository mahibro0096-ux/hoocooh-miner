/**
 * api/admin/setup-indexes.js — Modeled from NEWTUBE-TON architecture
 * Mobile/Browser-accessible index and TTL creator for MongoDB.
 *
 * Usage:
 *   https://<your-vercel-domain>/api/admin/setup-indexes?secret=<ADMIN_SECRET_KEY>
 */

const { getDb } = require("../../lib/mongodb");
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
} = require("../../lib/constants");

const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || "hoocooh_admin_2026";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-key");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const querySecret = req.query && (req.query.secret || req.query.key || req.query.adminKey);
  const headerKey = req.headers && req.headers["x-admin-key"];
  const provided = String(querySecret || headerKey || "").trim();

  const isAuthed = (
    provided === String(ADMIN_SECRET).trim() ||
    (BOT_TOKEN && provided === String(BOT_TOKEN).trim())
  );

  if (!isAuthed) {
    res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "Please provide valid secret query parameter: ?secret=<ADMIN_SECRET_KEY>"
    });
    return;
  }

  const results = [];
  try {
    const db = await getDb();

    // Helper to safely create an index and handle option conflicts
    async function safeIndex(colName, spec, options = {}) {
      const col = db.collection(colName);
      try {
        await col.createIndex(spec, options);
        return { index: `${colName}.${JSON.stringify(spec)}`, ok: true };
      } catch (err) {
        if (err.codeName === "IndexOptionsConflict" || (err.message && err.message.includes("already exists with different options"))) {
          try {
            if (options.name) {
              await col.dropIndex(options.name);
            }
            await col.createIndex(spec, options);
            return { index: `${colName}.${JSON.stringify(spec)}`, ok: true, note: "Recreated after dropping conflicting options" };
          } catch (dropErr) {
            return { index: `${colName}.${JSON.stringify(spec)}`, ok: false, error: dropErr.message };
          }
        }
        return { index: `${colName}.${JSON.stringify(spec)}`, ok: false, error: err.message };
      }
    }

    const steps = [
      // 1. Users collection
      ["users.telegramId", () => safeIndex("users", { telegramId: 1 })],
      ["users.totalMinedCoins+minerLevel", () => safeIndex("users", { totalMinedCoins: -1, minerLevel: -1 })],
      ["users.recruitsCount", () => safeIndex("users", { recruitsCount: -1 })],
      ["users.referredBy", () => safeIndex("users", { referredBy: 1 })],
      ["users.isBanned", () => safeIndex("users", { isBanned: 1 })],
      ["users.lastActiveAt (TTL 90d dead-account cleanup)", () => safeIndex(
        "users",
        { lastActiveAt: 1 },
        { expireAfterSeconds: USER_INACTIVITY_TTL_SECONDS, name: "ttl_users_inactivity_90d" }
      )],
      ["users.bannedAtDate (partial TTL 60d, isBanned:true only)", () => safeIndex(
        "users",
        { bannedAtDate: 1 },
        { expireAfterSeconds: USER_BANNED_TTL_SECONDS, partialFilterExpression: { isBanned: true }, name: "ttl_users_banned_60d" }
      )],

      // 2. Withdrawals collection
      ["withdrawals.telegramId+status", () => safeIndex("withdrawals", { telegramId: 1, status: 1 })],
      ["withdrawals.status+createdAt", () => safeIndex("withdrawals", { status: 1, createdAt: -1 })],
      ["withdrawals.rejectedAtDate (partial TTL 90d, status:REJECTED only)", () => safeIndex(
        "withdrawals",
        { rejectedAtDate: 1 },
        { expireAfterSeconds: WITHDRAWAL_REJECTED_TTL_SECONDS, partialFilterExpression: { status: "REJECTED" }, name: "ttl_withdrawals_rejected_90d" }
      )],

      // 3. IP Signup Velocity & Device Registry (NEWTUBE-TON architecture)
      ["ipSignupVelocity.updatedAt (TTL 24h auto-expiry)", () => safeIndex(
        "ipSignupVelocity",
        { updatedAt: 1 },
        { expireAfterSeconds: IP_VELOCITY_TTL_SECONDS, name: "ttl_ip_signup_velocity_24h" }
      )],
      ["ipRegistry.lastSeenAt (TTL 120d)", () => safeIndex(
        "ipRegistry",
        { lastSeenAt: 1 },
        { expireAfterSeconds: IP_REGISTRY_TTL_SECONDS, name: "ttl_ip_registry_120d" }
      )],
      ["ipRegistry.userId", () => safeIndex("ipRegistry", { userId: 1 })],

      // 4. Captcha Tokens & Challenges (10-minute TTL)
      ["captcha_tokens.createdAtDate (TTL 10m)", () => safeIndex(
        "captcha_tokens",
        { createdAtDate: 1 },
        { expireAfterSeconds: CAPTCHA_TTL_SECONDS, name: "ttl_captcha_tokens_10m" }
      )],
      ["captcha_tokens.token", () => safeIndex("captcha_tokens", { token: 1 })],
      ["captcha_challenges.createdAtDate (TTL 10m)", () => safeIndex(
        "captcha_challenges",
        { createdAtDate: 1 },
        { expireAfterSeconds: CAPTCHA_TTL_SECONDS, name: "ttl_captcha_challenges_10m" }
      )],
      ["captcha_challenges.challengeId", () => safeIndex("captcha_challenges", { challengeId: 1 })],

      // 5. Verification Codes (1-hour TTL)
      ["user_verification_codes.createdAtDate (TTL 1h)", () => safeIndex(
        "user_verification_codes",
        { createdAtDate: 1 },
        { expireAfterSeconds: VERIFICATION_CODES_TTL_SECONDS, name: "ttl_verification_codes_1h" }
      )],
      ["user_verification_codes.userId+used", () => safeIndex("user_verification_codes", { userId: 1, used: 1 })],

      // 6. Broadcast Deliveries & Transient Admin State
      ["broadcast_deliveries.createdAt (TTL 30d)", () => safeIndex(
        "broadcast_deliveries",
        { createdAt: 1 },
        { expireAfterSeconds: BROADCAST_DELIVERIES_TTL_SECONDS, name: "ttl_broadcast_30d" }
      )],
      ["adminState.updatedAt (TTL 1h)", () => safeIndex(
        "adminState",
        { updatedAt: 1 },
        { expireAfterSeconds: ADMIN_STATE_TTL_SECONDS, name: "ttl_admin_state_1h" }
      )],

      // 7. Tasks collection
      ["tasks.status+createdAt", () => safeIndex("tasks", { status: 1, createdAt: -1 })]
    ];

    for (const [name, fn] of steps) {
      try {
        const resObj = await fn();
        results.push({ name, ...resObj });
      } catch (stepErr) {
        results.push({ name, ok: false, error: stepErr.message });
      }
    }

    const failed = results.filter(r => !r.ok);
    res.status(200).json({
      ok: failed.length === 0,
      total: results.length,
      successCount: results.length - failed.length,
      failedCount: failed.length,
      results
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: "server_error",
      message: err.message,
      results
    });
  }
};
