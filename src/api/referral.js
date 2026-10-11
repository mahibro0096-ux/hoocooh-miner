const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const { checkVelocityLimit } = require("../lib/velocityLimiter");

const MILESTONES_CONFIG = [
  { id: 1, required: 5, reward: 100, title: "Invite 5 Friends" },
  { id: 2, required: 10, reward: 200, title: "Invite 10 Friends" },
  { id: 3, required: 25, reward: 500, title: "Invite 25 Friends" },
  { id: 4, required: 50, reward: 1500, title: "Invite 50 Friends" }
];

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

  // Velocity Check: Max 20 referral requests per minute per user/IP
  if (!checkVelocityLimit(req, res, { endpoint: "referral", max: 20, windowMs: 60000, uid: uid })) {
    return;
  }

  try {
    const db = await getDb();
    const usersCol = db.collection("users");

    let user = await findOrCreateUser(usersCol, tgUser);

    const userRecruits = Number(user.recruitsCount || 0);
    const userRefEarnings = Number(user.refEarnings || 0);
    const userClaimedMilestones = Array.isArray(user.claimedMilestones) ? user.claimedMilestones : [];

    // 1. GET: Fetch 100% REAL Rankings & Milestones from Database
    if (req.method === "GET") {
      // Real Top Recruiters from Database
      const dbRecruiters = await usersCol
        .find({ recruitsCount: { $gt: 0 } })
        .sort({ recruitsCount: -1, balance: -1 })
        .limit(20)
        .toArray();

      const topRecruiters = dbRecruiters.map((u, idx) => {
        const displayName = u.firstName ? (u.firstName + (u.lastName ? " " + u.lastName : "")) : (u.username || "Miner");
        return {
          rank: idx + 1,
          telegramId: String(u.telegramId),
          name: displayName,
          username: u.username ? ("@" + u.username) : "",
          recruitsCount: Number(u.recruitsCount || 0),
          avatarText: displayName.slice(0, 2).toUpperCase()
        };
      });

      // User's real Recruiter rank
      let recruiterRank = null;
      if (userRecruits > 0) {
        const higherRecruits = await usersCol.countDocuments({ recruitsCount: { $gt: userRecruits } });
        const exactRank = higherRecruits + 1;
        if (exactRank <= 99) {
          recruiterRank = exactRank;
        }
      }

      // Real Top Miners from Database: strictly based on Home 2-Hour Mining!
      const dbMiners = await usersCol
        .find({
          $or: [
            { totalMinedCoins: { $gt: 0 } },
            { lastMineCollectedAt: { $ne: null } }
          ]
        })
        .sort({ totalMinedCoins: -1, minerLevel: -1, totalMinedClaims: -1, balance: -1 })
        .limit(100)
        .toArray();

      const topMiners = dbMiners.map((u, idx) => {
        const displayName = u.firstName ? (u.firstName + (u.lastName ? " " + u.lastName : "")) : (u.username || "Miner");
        const minedScore = Number(u.totalMinedCoins !== undefined ? u.totalMinedCoins : (u.lastMineCollectedAt ? 25 : 0));
        return {
          rank: idx + 1,
          telegramId: String(u.telegramId),
          name: displayName,
          username: u.username ? ("@" + u.username) : "",
          score: Math.round(minedScore),
          minerLevel: u.minerLevel || 1,
          avatarText: displayName.slice(0, 2).toUpperCase()
        };
      });

      // User's real Miner rank (based purely on 2-hour home cloud mining)
      const userMined = Number(user.totalMinedCoins !== undefined ? user.totalMinedCoins : (user.lastMineCollectedAt ? 25 : 0));
      let minerRank = null;
      if (userMined > 0 || user.lastMineCollectedAt) {
        const higherMined = await usersCol.countDocuments({ totalMinedCoins: { $gt: userMined } });
        const exactMinerRank = higherMined + 1;
        if (exactMinerRank <= 100) {
          minerRank = exactMinerRank;
        }
      }

      // Real Milestones
      const milestones = MILESTONES_CONFIG.map(m => {
        const isClaimed = userClaimedMilestones.includes(m.id);
        const canClaim = !isClaimed && (userRecruits >= m.required);
        return {
          id: m.id,
          required: m.required,
          reward: m.reward,
          title: m.title,
          isClaimed: isClaimed,
          canClaim: canClaim
        };
      });

      const claimedCount = milestones.filter(m => m.isClaimed).length;

      res.status(200).json({
        ok: true,
        recruitsCount: userRecruits,
        refEarnings: userRefEarnings,
        recruiterRank: recruiterRank,
        minerRank: minerRank,
        topRecruiters: topRecruiters,
        topMiners: topMiners,
        milestones: milestones,
        claimedMilestonesCount: claimedCount,
        totalMilestones: MILESTONES_CONFIG.length
      });
      return;
    }

    // 2. POST: Claim milestone
    if (req.method === "POST") {
      const { action, milestoneId } = req.body || {};

      if (action === "claim_milestone") {
        const mConfig = MILESTONES_CONFIG.find(m => m.id === Number(milestoneId));
        if (!mConfig) {
          res.status(400).json({ error: "Invalid milestone" });
          return;
        }

        if (userClaimedMilestones.includes(mConfig.id)) {
          res.status(400).json({ error: "Milestone already claimed" });
          return;
        }

        if (userRecruits < mConfig.required) {
          res.status(400).json({
            error: `You need ${mConfig.required} recruits to claim this milestone. Current: ${userRecruits}`
          });
          return;
        }

        // Atomically claim milestone (impossible for concurrent requests to both claim)
        const claimMRes = await usersCol.updateOne(
          {
            _id: user._id,
            claimedMilestones: { $ne: mConfig.id }
          },
          {
            $inc: { balance: mConfig.reward },
            $push: { claimedMilestones: mConfig.id }
          }
        );

        if (!claimMRes || claimMRes.modifiedCount === 0) {
          res.status(400).json({ error: "Milestone already claimed" });
          return;
        }

        const updatedUser = await usersCol.findOne({ _id: user._id });
        const newBal = Number(updatedUser ? updatedUser.balance : ((Number(user.balance) || 0) + mConfig.reward));
        const newClaimed = (updatedUser && updatedUser.claimedMilestones) ? updatedUser.claimedMilestones : [...userClaimedMilestones, mConfig.id];

        res.status(200).json({
          ok: true,
          reward: mConfig.reward,
          newBalance: newBal,
          claimedMilestones: newClaimed,
          message: `🎉 +${mConfig.reward} HOOCOOH Coins milestone reward claimed!`
        });
        return;
      }

      res.status(400).json({ error: "Unknown action" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("referral.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
