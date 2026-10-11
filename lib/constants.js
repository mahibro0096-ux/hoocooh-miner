/**
 * HOOCOOH Miner Constants
 * Modeled after NEWTUBE-TON architecture for Velocity Gates & TTL Auto-Cleanup.
 */

// --------------------------------------------------------------------------
// 1. SIGNUP & REFERRAL VELOCITY CONSTANTS
// --------------------------------------------------------------------------

// Raw-IP signup velocity lock (direct defense against automated multi-account farms).
// 6+ new accounts from one IP inside 3 minutes flags accounts and alerts the admin.
const IP_SIGNUP_VELOCITY_WINDOW_MS = 3 * 60 * 1000; // 3 minutes
const IP_SIGNUP_VELOCITY_THRESHOLD = 6;              // 6+ new accounts inside window

// Referral signup velocity lock.
// 20+ referral signups under one referrer within 2 minutes flags referrer for review.
const REFERRAL_VELOCITY_WINDOW_MS = 2 * 60 * 1000;   // 2 minutes
const REFERRAL_VELOCITY_THRESHOLD = 20;              // 20+ signups inside window

// Device / IP account switch cooldown (closing rapid-loop account switching)
const SWITCH_COOLDOWN_HOURS = 24;                    // 24 hours cooldown

// --------------------------------------------------------------------------
// 2. MONGODB TTL (TIME-TO-LIVE) SECONDS
// --------------------------------------------------------------------------

// Inactive dead accounts: 90 days without opening the app auto-cleans user doc
const USER_INACTIVITY_TTL_SECONDS = 90 * 24 * 60 * 60; // 7,776,000s (90 days)

// Confirmed banned accounts: 60 days after ban date auto-cleans user doc
const USER_BANNED_TTL_SECONDS = 60 * 24 * 60 * 60;     // 5,184,000s (60 days)

// Rejected withdrawals: 90 days audit window, then cleaned. Completed/Pending are NEVER deleted.
const WITHDRAWAL_REJECTED_TTL_SECONDS = 90 * 24 * 60 * 60; // 7,776,000s (90 days)

// Device / IP Registry: 120 days rolling TTL based on lastSeenAt
const IP_REGISTRY_TTL_SECONDS = 120 * 24 * 60 * 60;   // 10,368,000s (120 days)

// IP signup velocity rolling history: 24 hours TTL
const IP_VELOCITY_TTL_SECONDS = 24 * 60 * 60;          // 86,400s (1 day)

// Captcha tokens & challenges: 10 minutes TTL
const CAPTCHA_TTL_SECONDS = 600;                       // 600s (10 minutes)

// User verification codes: 1 hour TTL
const VERIFICATION_CODES_TTL_SECONDS = 3600;           // 3,600s (1 hour)

// Broadcast deliveries: 30 days TTL
const BROADCAST_DELIVERIES_TTL_SECONDS = 30 * 24 * 60 * 60; // 2,592,000s (30 days)

// Admin session / transient states: 1 hour TTL
const ADMIN_STATE_TTL_SECONDS = 3600;                  // 3,600s (1 hour)

module.exports = {
  IP_SIGNUP_VELOCITY_WINDOW_MS,
  IP_SIGNUP_VELOCITY_THRESHOLD,
  REFERRAL_VELOCITY_WINDOW_MS,
  REFERRAL_VELOCITY_THRESHOLD,
  SWITCH_COOLDOWN_HOURS,
  USER_INACTIVITY_TTL_SECONDS,
  USER_BANNED_TTL_SECONDS,
  WITHDRAWAL_REJECTED_TTL_SECONDS,
  IP_REGISTRY_TTL_SECONDS,
  IP_VELOCITY_TTL_SECONDS,
  CAPTCHA_TTL_SECONDS,
  VERIFICATION_CODES_TTL_SECONDS,
  BROADCAST_DELIVERIES_TTL_SECONDS,
  ADMIN_STATE_TTL_SECONDS
};
