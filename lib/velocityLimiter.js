/**
 * Security & Anti-Bot Velocity Check (Rate Limiter)
 * Protects Vercel Serverless Functions from:
 * 1. Bot spam & automated curl/python loop attacks
 * 2. Rapid double-spend & race-condition spamming
 * 3. Excessive function invocations that burn Vercel limits
 */

// In-memory sliding window bucket cache
// Key: identifier + endpoint
// Value: { count: number, resetAt: number }
const velocityBuckets = new Map();

// Automatic garbage collection: clean expired keys every 3 minutes
const CLEANUP_INTERVAL_MS = 3 * 60 * 1000;
let lastCleanupTime = Date.now();

function cleanupExpiredBuckets(now) {
  if (now - lastCleanupTime < CLEANUP_INTERVAL_MS) return;
  lastCleanupTime = now;
  for (const [key, data] of velocityBuckets.entries()) {
    if (data.resetAt <= now) {
      velocityBuckets.delete(key);
    }
  }
}

/**
 * Checks velocity for a client.
 * Returns true if allowed, false if limit exceeded.
 * Automatically sends HTTP 429 response if limit is exceeded.
 *
 * @param {object} req - Express / Vercel request object
 * @param {object} res - Express / Vercel response object
 * @param {object} options
 * @param {string} options.endpoint - Name of the action or endpoint (e.g. "collect", "wallet")
 * @param {number} options.max - Maximum requests allowed within windowMs (e.g. 5)
 * @param {number} options.windowMs - Time window in milliseconds (default: 60,000ms = 1 min)
 * @param {string|number} [options.uid] - Optional Telegram User ID
 * @returns {boolean} true if allowed, false if rate limited and 429 was sent
 */
function checkVelocityLimit(req, res, { endpoint = "global", max = 20, windowMs = 60000, uid = null } = {}) {
  const now = Date.now();
  cleanupExpiredBuckets(now);

  const rawIp = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.socket?.remoteAddress || "";
  const clientIp = rawIp.split(",")[0].trim() || "unknown_ip";

  // If user ID is available, rate-limit primarily by user account; fallback to IP
  const idPrefix = uid ? `usr:${uid}` : `ip:${clientIp}`;
  const bucketKey = `${idPrefix}:${endpoint}`;

  let record = velocityBuckets.get(bucketKey);

  if (!record || now >= record.resetAt) {
    // New window
    record = { count: 1, resetAt: now + windowMs };
    velocityBuckets.set(bucketKey, record);
    return true;
  }

  record.count += 1;

  if (record.count > max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    
    // Set standard RateLimit headers
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", "0");
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(record.resetAt / 1000)));

    res.status(429).json({
      error: "Too many requests. Please slow down (Velocity check limit exceeded).",
      retryAfter: retryAfterSeconds,
      endpoint: endpoint
    });
    return false;
  }

  // Allowed
  res.setHeader("X-RateLimit-Limit", String(max));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - record.count)));
  return true;
}

module.exports = {
  checkVelocityLimit
};
