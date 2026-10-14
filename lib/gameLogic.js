// Shared reward-schedule / timing logic used by the API routes.
// Keeping this in one file means the mining and daily-bonus rules
// only ever live in one place.

const DAILY_REWARDS = [5, 7, 11, 15, 20, 25, 30]; // 5 to 30 strictly increasing pattern (Day 1: 5, Day 2: 7, ..., Day 7: 30)

const DAY_MS = 24 * 60 * 60 * 1000;
const MINE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MINE_REWARD = 50; // Cap: 50 coins per 2 hours
const MAX_TAP_ENERGY = 50;
const ENERGY_RECHARGE_RATE_MS = Math.floor(MINE_INTERVAL_MS / MAX_TAP_ENERGY); // 144,000 ms (2.4 min per 1 energy)

function calculateCurrentEnergy(user, now = Date.now()) {
  if (!user) return MAX_TAP_ENERGY;
  const lastSync = user.lastEnergySyncAt || user.lastMineCollectedAt;
  if (!lastSync) return MAX_TAP_ENERGY;
  const storedEnergy = (typeof user.energy === "number") ? user.energy : MAX_TAP_ENERGY;
  const elapsed = Math.max(0, now - Number(lastSync));
  const recovered = Math.floor(elapsed / ENERGY_RECHARGE_RATE_MS);
  return Math.min(MAX_TAP_ENERGY, Math.max(0, storedEnergy + recovered));
}

function rewardForCycleDay(cycle, dayIndex) {
  // dayIndex is 0-based (0..6). Rewards cycle across weeks starting from Day 1 reward
  const idx = (Math.max(0, Number(dayIndex) || 0)) % DAILY_REWARDS.length;
  return DAILY_REWARDS[idx];
}

// "ready"   -> user can check in right now (first time, or 24h+ have passed but < 48h)
// "waiting" -> not yet 24h since last check-in
// "broken"  -> 48h+ have passed, streak is broken and restarts at day 1
function dailyStatus(lastCheckinAt) {
  if (!lastCheckinAt) return "ready";
  const elapsed = Date.now() - lastCheckinAt;
  if (elapsed < DAY_MS) return "waiting";
  if (elapsed >= 2 * DAY_MS) return "broken";
  return "ready";
}

function mineIsReady(lastMineCollectedAt) {
  if (!lastMineCollectedAt) return true;
  return (Date.now() - lastMineCollectedAt) >= MINE_INTERVAL_MS;
}

const LEVEL_NAMES = [
  "Starter",
  "Developed",
  "Refined",
  "Vanguard",
  "Apex",
  "Celestial",
  "Quantum",
  "Mythic",
  "Sovereign",
  "Transcendent"
];

const LEVEL_MULTIPLIERS = [1.0, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0];
const UPGRADE_COSTS = [1000, 4500, 7000, 10000, 20000, 40000, 80000, 100000, 200000];

function getMultiplierForLevel(level) {
  const idx = Math.max(1, Math.min(10, level || 1)) - 1;
  return LEVEL_MULTIPLIERS[idx];
}

function getUpgradeCostForLevel(level) {
  const idx = Math.max(1, Math.min(10, level || 1)) - 1;
  return UPGRADE_COSTS[idx] !== undefined ? UPGRADE_COSTS[idx] : null;
}

module.exports = {
  DAILY_REWARDS,
  DAY_MS,
  MINE_INTERVAL_MS,
  MINE_REWARD,
  MAX_TAP_ENERGY,
  ENERGY_RECHARGE_RATE_MS,
  calculateCurrentEnergy,
  LEVEL_NAMES,
  LEVEL_MULTIPLIERS,
  UPGRADE_COSTS,
  getMultiplierForLevel,
  getUpgradeCostForLevel,
  rewardForCycleDay,
  dailyStatus,
  mineIsReady
};

