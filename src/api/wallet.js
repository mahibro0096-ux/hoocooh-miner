const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const crypto = require("crypto");
const { checkVelocityLimit } = require("../lib/velocityLimiter");

// Base rate fallback: 1 HOOCOOH Coin = $0.00003 USD
const COIN_RATE = 0.00003;

async function getCoinRate(db) {
  try {
    const s = await db.collection("settings").findOne({ key: "app_settings" });
    if (s && typeof s.coinPriceUsd === "number" && s.coinPriceUsd > 0) {
      return s.coinPriceUsd;
    }
  } catch (e) {}
  return COIN_RATE;
}

function calculateCoinsUsdt(coins, rate = COIN_RATE) {
  const c = Math.max(0, Number(coins) || 0);
  return c * rate;
}

// Conversion rate: 3 cents ($0.03 USD) = 0.019 TON
// TON per USD = 0.019 / 0.03 = 19 / 30 (~0.63333333 TON per $1 USDT)
const TON_PER_USD = 0.019 / 0.03;

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
  const telegramId = String(tgUser.id);

  // Velocity Check: Max 12 wallet requests per minute per user/IP
  if (!checkVelocityLimit(req, res, { endpoint: "wallet", max: 12, windowMs: 60000, uid: telegramId })) {
    return;
  }

  try {
    const db = await getDb();
    const usersCol = db.collection("users");
    const withdrawalsCol = db.collection("withdrawals");

    let user = await findOrCreateUser(usersCol, tgUser);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (user.isBanned) {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    if (user.accountLocked) {
      res.status(403).json({ error: "Your account is temporarily locked for security review. Please contact support." });
      return;
    }

    // 1. GET: Fetch wallet summary and transaction history
    if (req.method === "GET") {
      const txs = await withdrawalsCol
        .find({ telegramId })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

      const mappedTxs = txs.map(t => ({
        id: String(t._id),
        amount: t.amount,
        usdtAmount: t.usdtAmount,
        walletAddress: t.walletAddress,
        network: t.network || "USDT",
        status: t.status || "PENDING",
        txHash: t.txHash || "",
        createdAt: t.createdAt
      }));

      // Check and retrieve locked/bound wallet address
      let boundWallet = user.boundWalletAddress || null;
      if (!boundWallet) {
        const prevTx = await withdrawalsCol.findOne({ telegramId }, { sort: { createdAt: -1 } });
        if (prevTx && prevTx.walletAddress) {
          boundWallet = prevTx.walletAddress;
          await usersCol.updateOne({ _id: user._id }, { $set: { boundWalletAddress: boundWallet, walletBoundAt: Date.now() } });
          user.boundWalletAddress = boundWallet;
        }
      }

      const activeCoinRate = await getCoinRate(db);
      const recruits = Number(user.recruitsCount || 0);
      const balance = Number(user.balance || 0);
      const usdtEquivalent = Number(calculateCoinsUsdt(balance, activeCoinRate).toFixed(2));

      res.status(200).json({
        ok: true,
        balance,
        usdtEquivalent,
        coinRate: activeCoinRate,
        recruitsCount: recruits,
        totalMined: Math.round(balance + (Number(user.totalDailyEarned) || 0) + (Number(user.refEarnings) || 0)),
        boundWalletAddress: boundWallet,
        transactions: mappedTxs
      });
      return;
    }

    // 2. POST: Process withdrawal
    if (req.method === "POST") {
      const { action, amount, walletAddress, network } = req.body || {};

      if (action === "withdraw") {
        const { captchaToken } = req.body || {};
        const cleanCaptchaToken = String(captchaToken || "").trim();

        if (!cleanCaptchaToken) {
          res.status(403).json({ error: "Security verification required! Please complete the verification puzzle." });
          return;
        }

        const numAmount = parseInt(amount, 10);
        if (isNaN(numAmount) || numAmount < 1000) {
          res.status(400).json({ error: "Minimum withdrawal amount is 1,000 HOOCOOH Coins" });
          return;
        }

        const now = Date.now();
        const tokensCol = db.collection("captcha_tokens");

        // Atomically invalidate captcha token to prevent concurrent replay
        const tokenResult = await tokensCol.findOneAndUpdate(
          {
            token: cleanCaptchaToken,
            userId: { $in: [telegramId, Number(telegramId)] },
            used: false,
            createdAt: { $gte: now - 180000 } // Valid for 3 minutes
          },
          {
            $set: { used: true, usedAt: now }
          },
          { returnDocument: "before" }
        );

        const validToken = tokenResult && (tokenResult.value || tokenResult);
        if (!validToken) {
          res.status(403).json({ error: "Security verification invalid, already used, or expired. Please complete verification again." });
          return;
        }

        let cleanAddress = "";

        // Wallet Lock Logic:
        // Once a wallet address is used, it is permanently locked to the account.
        // Subsequent withdrawals automatically use this locked wallet address without requiring re-entry.
        if (user.boundWalletAddress) {
          cleanAddress = user.boundWalletAddress;
          const inputAddr = (walletAddress || "").trim();
          if (inputAddr && inputAddr !== user.boundWalletAddress) {
            res.status(400).json({
              error: `Your account is permanently locked to TON address: ${user.boundWalletAddress}. All withdrawals are sent to this address.`
            });
            return;
          }
        } else {
          // Check if previously had a withdrawal
          const prevTx = await withdrawalsCol.findOne({ telegramId }, { sort: { createdAt: -1 } });
          if (prevTx && prevTx.walletAddress) {
            cleanAddress = prevTx.walletAddress;
            await usersCol.updateOne(
              { _id: user._id },
              { $set: { boundWalletAddress: cleanAddress, walletBoundAt: now } }
            );
            user.boundWalletAddress = cleanAddress;
          } else {
            // First withdrawal: validate and lock address permanently
            cleanAddress = (walletAddress || "").trim();
            const isTon = /^(UQ|EQ|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(cleanAddress) || /^(-1|0):[0-9a-fA-F]{64}$/.test(cleanAddress);
            if (!isTon) {
              res.status(400).json({ error: "Invalid TON address! Address must be 48 characters starting with UQ or EQ" });
              return;
            }
            await usersCol.updateOne(
              { _id: user._id },
              { $set: { boundWalletAddress: cleanAddress, walletBoundAt: now } }
            );
            user.boundWalletAddress = cleanAddress;
          }
        }

        // Atomically verify balance and deduct Coins in a single atomic operation
        // This prevents race condition double-spending via simultaneous requests
        const deductResult = await usersCol.findOneAndUpdate(
          {
            _id: user._id,
            balance: { $gte: numAmount }
          },
          {
            $inc: { balance: -numAmount },
            $set: { lastActiveAt: new Date() }
          },
          { returnDocument: "after" }
        );

        const updatedUser = deductResult && (deductResult.value || deductResult);
        if (!updatedUser) {
          const freshUser = await usersCol.findOne({ _id: user._id });
          const freshBal = Number(freshUser ? freshUser.balance : 0);
          res.status(400).json({
            error: `Insufficient balance! Current: ${freshBal.toLocaleString()} Coins. Requested: ${numAmount.toLocaleString()} Coins.`
          });
          return;
        }

        const newBal = Number(updatedUser.balance || 0);
        const activeCoinRate = await getCoinRate(db);
        const usdtVal = Number(calculateCoinsUsdt(numAmount, activeCoinRate).toFixed(4));
        const tonVal = Number((usdtVal * TON_PER_USD).toFixed(6));

        // Record withdrawal transaction in MongoDB with PENDING status
        const txDoc = {
          telegramId,
          amount: numAmount,
          usdtAmount: usdtVal,
          tonAmount: tonVal,
          walletAddress: cleanAddress,
          network: "TON",
          status: "PENDING",
          txHash: "",
          createdAt: now
        };

        const insertRes = await withdrawalsCol.insertOne(txDoc);

        res.status(200).json({
          ok: true,
          message: `⏳ Withdrawal request of ${numAmount.toLocaleString()} Coins ($${usdtVal.toFixed(2)} USDT) submitted for review!`,
          newBalance: newBal,
          boundWalletAddress: cleanAddress,
          transaction: {
            id: String(insertRes.insertedId),
            ...txDoc
          }
        });
        return;
      }

      res.status(400).json({ error: "Unknown action" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("wallet.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
