const crypto = require("crypto");

/**
 * Action Signing System using HMAC-SHA256
 * Protects critical reward endpoints:
 * - Miner collection
 * - Spin ticket claiming
 * - Task reward completion
 * 
 * Configured via process.env.ACTION_SIGNING_SECRET
 */
function getSigningSecret() {
  return process.env.ACTION_SIGNING_SECRET || process.env.TELEGRAM_BOT_TOKEN || "hoocooh_action_signing_secret_key_2026";
}

/**
 * Creates a cryptographically signed action token.
 * Token format: <expiresAt>.<hmacSignature>
 */
function createActionToken(telegramId, action, ttlMs = 15 * 60 * 1000) {
  const secret = getSigningSecret();
  const tid = String(telegramId || "").trim();
  const act = String(action || "").trim();
  const expiresAt = Date.now() + ttlMs;

  const payload = `${tid}:${act}:${expiresAt}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  return `${expiresAt}.${hmac}`;
}

/**
 * Verifies that the provided token was authentically signed and not expired.
 * Also supports direct secret verification if user provides ACTION_SIGNING_SECRET directly.
 */
function verifyActionToken(telegramId, action, token) {
  if (!token || typeof token !== "string") return false;
  const cleanToken = token.trim();
  const secret = getSigningSecret();



  const parts = cleanToken.split(".");
  if (parts.length !== 2) return false;

  const expiresAt = Number(parts[0]);
  const signature = parts[1];

  if (!expiresAt || isNaN(expiresAt)) return false;
  if (Date.now() > expiresAt) return false; // Expired token

  const tid = String(telegramId || "").trim();
  const act = String(action || "").trim();
  const payload = `${tid}:${act}:${expiresAt}`;
  const expectedHmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expectedHmac, "hex");
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch(e) {
    return false;
  }
}

module.exports = {
  createActionToken,
  verifyActionToken,
  getSigningSecret
};
