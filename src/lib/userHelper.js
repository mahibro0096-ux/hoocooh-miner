const { ObjectId } = require("mongodb");

async function findOrCreateUser(usersCol, tgUser, meta = {}) {
  if (!tgUser || !tgUser.id) return null;
  const telegramId = String(tgUser.id);
  const numId = Number(tgUser.id);
  const clientIp = meta.clientIp || "";
  const clientDeviceId = meta.clientDeviceId || "";
  const prevUid = meta.prevUid || "";
  const isLocalIp = !clientIp || clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "localhost";

  const query = {
    $or: [
      { telegramId: telegramId },
      { telegramId: numId }
    ]
  };

  const matchingUsers = await usersCol.find(query).sort({ balance: -1, createdAt: 1 }).toArray();

  if (matchingUsers.length === 0) {
    // ----------------------------------------------------
    // CHECK MULTIPLE ACCOUNT DETECTION (Same IP or Same Device)
    // ----------------------------------------------------
    const checkOrList = [];
    if (clientDeviceId) {
      checkOrList.push({ registeredDeviceId: clientDeviceId });
      checkOrList.push({ lastDeviceId: clientDeviceId });
    }
    if (prevUid && String(prevUid) !== telegramId) {
      checkOrList.push({ telegramId: String(prevUid) });
      checkOrList.push({ telegramId: Number(prevUid) });
    }
    if (!isLocalIp) {
      checkOrList.push({ registeredIp: clientIp });
      checkOrList.push({ lastIp: clientIp });
    }

    let existingOldAccount = null;
    if (checkOrList.length > 0) {
      existingOldAccount = await usersCol.findOne(
        {
          telegramId: { $nin: [telegramId, numId] },
          $or: checkOrList
        },
        { sort: { createdAt: 1 } }
      );
    }

    if (existingOldAccount) {
      const isSameDevice = Boolean(
        (clientDeviceId && (existingOldAccount.registeredDeviceId === clientDeviceId || existingOldAccount.lastDeviceId === clientDeviceId)) ||
        (prevUid && (String(prevUid) === String(existingOldAccount.telegramId) || Number(prevUid) === Number(existingOldAccount.telegramId)))
      );

      // PENALTY ON OLD ACCOUNT (When multi-account is created on SAME DEVICE):
      // 1st offense on same device: balance reset to 0
      // 2nd offense / repeat: balance set to -999999999
      if (isSameDevice) {
        const currentViolations = Number(existingOldAccount.deviceViolationsCount || 0);
        if (currentViolations === 0) {
          await usersCol.updateOne(
            { _id: existingOldAccount._id },
            {
              $set: {
                balance: 0,
                deviceViolationsCount: 1,
                penaltyNotice: "Warning: Multiple accounts detected on your device! Your balance has been reset to 0.",
                lastPenaltyAt: Date.now()
              }
            }
          );
        } else {
          await usersCol.updateOne(
            { _id: existingOldAccount._id },
            {
              $set: {
                balance: -999999999,
                deviceViolationsCount: currentViolations + 1,
                penaltyNotice: "Severe Penalty: You created multiple accounts on this device after your balance was reset. Your balance has been penalized to -999,999,999 Coins.",
                lastPenaltyAt: Date.now()
              }
            }
          );
        }
      }

      // Create new secondary account as SUSPENDED
      const newUser = {
        telegramId: telegramId,
        firstName: tgUser.first_name || "",
        username: tgUser.username || "",
        photoUrl: tgUser.photo_url || "",
        balance: 0,
        minerLevel: 1,
        lastMineCollectedAt: null,
        mineReminderSent: false,
        dailyCycle: 1,
        dailyDayIndex: 0,
        lastCheckinAt: null,
        totalDailyEarned: 0,
        recruitsCount: 0,
        refEarnings: 0,
        referredBy: null,
        referralRewarded: false,
        claimedMilestones: [],
        completedTasks: [],
        language: "en",
        languageSelected: false,
        registeredIp: clientIp || "",
        lastIp: clientIp || "",
        registeredDeviceId: clientDeviceId || "",
        lastDeviceId: clientDeviceId || "",
        isBanned: true,
        bannedAt: Date.now(),
        bannedAtDate: new Date(),
        dataPurged: false,
        isSuspendedMultipleAccount: true,
        detectionType: isSameDevice ? "device" : "ip",
        banReason: isSameDevice
          ? "Multiple accounts detected on the same device"
          : "Multiple accounts detected on the same IP network",
        primaryTelegramId: existingOldAccount.telegramId,
        createdAt: Date.now()
      };
      const res = await usersCol.insertOne(newUser);
      newUser._id = res.insertedId;
      newUser.isMultipleAccountBlocked = true;
      newUser.primaryAccount = {
        telegramId: existingOldAccount.telegramId,
        name: existingOldAccount.firstName || existingOldAccount.name || "Original User",
        username: existingOldAccount.username || "N/A",
        photoUrl: existingOldAccount.photoUrl || ""
      };
      return newUser;
    }

    // Normal clean new user
    const newUser = {
      telegramId: telegramId,
      firstName: tgUser.first_name || "",
      username: tgUser.username || "",
      photoUrl: tgUser.photo_url || "",
      balance: 0,
      minerLevel: 1,
      totalMinedCoins: 0,
      totalMinedClaims: 0,
      lastMineCollectedAt: null,
      mineReminderSent: false,
      dailyCycle: 1,
      dailyDayIndex: 0,
      lastCheckinAt: null,
      totalDailyEarned: 0,
      recruitsCount: 0,
      refEarnings: 0,
      referredBy: null,
      referralRewarded: false,
      claimedMilestones: [],
      completedTasks: [],
      language: "en",
      languageSelected: false,
      registeredIp: clientIp || "",
      lastIp: clientIp || "",
      registeredDeviceId: clientDeviceId || "",
      lastDeviceId: clientDeviceId || "",
      createdAt: Date.now(),
      lastActiveAt: new Date()
    };
    const res = await usersCol.insertOne(newUser);
    newUser._id = res.insertedId;
    return newUser;
  }

  let primaryUser = matchingUsers[0];

  // If duplicate documents exist, merge all progression fields
  if (matchingUsers.length > 1) {
    let maxBalance = Number(primaryUser.balance) || 0;
    let maxLevel = Number(primaryUser.minerLevel) || 1;
    let maxMinedCoins = Number(primaryUser.totalMinedCoins) || 0;
    let maxMinedClaims = Number(primaryUser.totalMinedClaims) || 0;
    let maxRecruits = Number(primaryUser.recruitsCount) || 0;
    let maxRefEarnings = Number(primaryUser.refEarnings) || 0;
    let maxDailyEarned = Number(primaryUser.totalDailyEarned) || 0;
    let dailyCycle = Number(primaryUser.dailyCycle) || 1;
    let dailyDayIndex = Number(primaryUser.dailyDayIndex) || 0;
    let claimedMilestones = Array.isArray(primaryUser.claimedMilestones) ? [...primaryUser.claimedMilestones] : [];
    let completedTasks = Array.isArray(primaryUser.completedTasks) ? [...primaryUser.completedTasks] : [];
    let referredBy = primaryUser.referredBy || null;
    let lastMine = primaryUser.lastMineCollectedAt;
    let lastCheckin = primaryUser.lastCheckinAt;

    for (let i = 1; i < matchingUsers.length; i++) {
      const other = matchingUsers[i];
      if ((Number(other.balance) || 0) > maxBalance) maxBalance = Number(other.balance);
      if ((Number(other.minerLevel) || 1) > maxLevel) maxLevel = Number(other.minerLevel);
      if ((Number(other.totalMinedCoins) || 0) > maxMinedCoins) maxMinedCoins = Number(other.totalMinedCoins);
      if ((Number(other.totalMinedClaims) || 0) > maxMinedClaims) maxMinedClaims = Number(other.totalMinedClaims);
      if ((Number(other.recruitsCount) || 0) > maxRecruits) maxRecruits = Number(other.recruitsCount);
      if ((Number(other.refEarnings) || 0) > maxRefEarnings) maxRefEarnings = Number(other.refEarnings);
      if ((Number(other.totalDailyEarned) || 0) > maxDailyEarned) maxDailyEarned = Number(other.totalDailyEarned);
      if ((Number(other.dailyCycle) || 1) > dailyCycle) {
        dailyCycle = Number(other.dailyCycle);
        dailyDayIndex = Number(other.dailyDayIndex) || 0;
      }
      if (!referredBy && other.referredBy) referredBy = other.referredBy;
      if (Array.isArray(other.claimedMilestones)) {
        other.claimedMilestones.forEach(m => {
          if (!claimedMilestones.includes(m)) claimedMilestones.push(m);
        });
      }
      if (Array.isArray(other.completedTasks)) {
        other.completedTasks.forEach(t => {
          if (!completedTasks.includes(t)) completedTasks.push(t);
        });
      }
      if (other.lastMineCollectedAt && (!lastMine || other.lastMineCollectedAt > lastMine)) {
        lastMine = other.lastMineCollectedAt;
      }
      if (other.lastCheckinAt && (!lastCheckin || other.lastCheckinAt > lastCheckin)) {
        lastCheckin = other.lastCheckinAt;
      }
      if (other.languageSelected) primaryUser.languageSelected = true;
      if (other.termsAccepted) primaryUser.termsAccepted = true;
      if (other.isIdentityVerified) primaryUser.isIdentityVerified = true;
      if (other.referralRewarded) primaryUser.referralRewarded = true;
      if (other.isSuspicious) primaryUser.isSuspicious = true;
      if (other.isHighRiskHacker) primaryUser.isHighRiskHacker = true;
      if (other.suspiciousReason && !primaryUser.suspiciousReason) primaryUser.suspiciousReason = other.suspiciousReason;
      if (other.securityFlag && !primaryUser.securityFlag) primaryUser.securityFlag = other.securityFlag;
      if (other.lastSuspiciousAt && (!primaryUser.lastSuspiciousAt || other.lastSuspiciousAt > primaryUser.lastSuspiciousAt)) {
        primaryUser.lastSuspiciousAt = other.lastSuspiciousAt;
      }
      if (other.identityVerifiedAt && (!primaryUser.identityVerifiedAt || other.identityVerifiedAt > primaryUser.identityVerifiedAt)) {
        primaryUser.identityVerifiedAt = other.identityVerifiedAt;
      }
      if (other.boundWalletAddress && !primaryUser.boundWalletAddress) {
        primaryUser.boundWalletAddress = other.boundWalletAddress;
      }
      try {
        await usersCol.deleteOne({ _id: other._id });
      } catch (e) {
        console.error("Duplicate cleanup error:", e);
      }
    }

    primaryUser.balance = maxBalance;
    primaryUser.minerLevel = maxLevel;
    primaryUser.totalMinedCoins = maxMinedCoins;
    primaryUser.totalMinedClaims = maxMinedClaims;
    primaryUser.recruitsCount = maxRecruits;
    primaryUser.refEarnings = maxRefEarnings;
    primaryUser.totalDailyEarned = maxDailyEarned;
    primaryUser.dailyCycle = dailyCycle;
    primaryUser.dailyDayIndex = dailyDayIndex;
    primaryUser.claimedMilestones = claimedMilestones;
    primaryUser.completedTasks = completedTasks;
    primaryUser.referredBy = referredBy;
    if (lastMine) primaryUser.lastMineCollectedAt = lastMine;
    if (lastCheckin) primaryUser.lastCheckinAt = lastCheckin;
  }

  // Optimize DB writes: only write progression fields if duplicate docs were merged
  const updateFields = {};
  if (matchingUsers.length > 1) {
    updateFields.telegramId = telegramId;
    if (primaryUser.balance !== undefined) updateFields.balance = primaryUser.balance;
    if (primaryUser.minerLevel !== undefined) updateFields.minerLevel = primaryUser.minerLevel;
    if (primaryUser.totalMinedCoins !== undefined) updateFields.totalMinedCoins = primaryUser.totalMinedCoins;
    if (primaryUser.totalMinedClaims !== undefined) updateFields.totalMinedClaims = primaryUser.totalMinedClaims;
    if (primaryUser.lastMineCollectedAt !== undefined) updateFields.lastMineCollectedAt = primaryUser.lastMineCollectedAt;
    if (primaryUser.lastCheckinAt !== undefined) updateFields.lastCheckinAt = primaryUser.lastCheckinAt;
    if (primaryUser.recruitsCount !== undefined) updateFields.recruitsCount = primaryUser.recruitsCount;
    if (primaryUser.refEarnings !== undefined) updateFields.refEarnings = primaryUser.refEarnings;
    if (primaryUser.totalDailyEarned !== undefined) updateFields.totalDailyEarned = primaryUser.totalDailyEarned;
    if (primaryUser.dailyCycle !== undefined) updateFields.dailyCycle = primaryUser.dailyCycle;
    if (primaryUser.dailyDayIndex !== undefined) updateFields.dailyDayIndex = primaryUser.dailyDayIndex;
    if (primaryUser.claimedMilestones !== undefined) updateFields.claimedMilestones = primaryUser.claimedMilestones;
    if (primaryUser.completedTasks !== undefined) updateFields.completedTasks = primaryUser.completedTasks;
    if (primaryUser.referredBy !== undefined) updateFields.referredBy = primaryUser.referredBy;
    if (primaryUser.referralRewarded !== undefined) updateFields.referralRewarded = primaryUser.referralRewarded;
    if (primaryUser.languageSelected !== undefined) updateFields.languageSelected = primaryUser.languageSelected;
    if (primaryUser.termsAccepted !== undefined) updateFields.termsAccepted = primaryUser.termsAccepted;
    if (primaryUser.isIdentityVerified !== undefined) updateFields.isIdentityVerified = primaryUser.isIdentityVerified;
    if (primaryUser.identityVerifiedAt !== undefined) updateFields.identityVerifiedAt = primaryUser.identityVerifiedAt;
    if (primaryUser.boundWalletAddress !== undefined) updateFields.boundWalletAddress = primaryUser.boundWalletAddress;
  } else if (typeof primaryUser.telegramId !== "string" || primaryUser.telegramId !== telegramId) {
    updateFields.telegramId = telegramId;
  }

  // Throttle lastActiveAt update to once every 30 mins to avoid continuous DB writes
  const lastActiveTime = primaryUser.lastActiveAt ? new Date(primaryUser.lastActiveAt).getTime() : 0;
  if (!primaryUser.isBanned && (!lastActiveTime || (Date.now() - lastActiveTime > 30 * 60 * 1000))) {
    updateFields.lastActiveAt = new Date();
    primaryUser.lastActiveAt = updateFields.lastActiveAt;
  }

  if (primaryUser.isSuspicious) {
    updateFields.isSuspicious = true;
    if (primaryUser.suspiciousReason) updateFields.suspiciousReason = primaryUser.suspiciousReason;
    if (primaryUser.lastSuspiciousAt) updateFields.lastSuspiciousAt = primaryUser.lastSuspiciousAt;
  }
  if (primaryUser.isHighRiskHacker) {
    updateFields.isHighRiskHacker = true;
    if (primaryUser.securityFlag) updateFields.securityFlag = primaryUser.securityFlag;
  }

  if (tgUser.first_name && primaryUser.firstName !== tgUser.first_name) {
    updateFields.firstName = tgUser.first_name;
    primaryUser.firstName = tgUser.first_name;
  }
  if (tgUser.username && primaryUser.username !== tgUser.username) {
    updateFields.username = tgUser.username;
    primaryUser.username = tgUser.username;
  }
  if (tgUser.photo_url && primaryUser.photoUrl !== tgUser.photo_url) {
    updateFields.photoUrl = tgUser.photo_url;
    primaryUser.photoUrl = tgUser.photo_url;
  }

  // Update IP & device metadata only if changed/missing
  if (clientIp && primaryUser.lastIp !== clientIp) {
    updateFields.lastIp = clientIp;
    primaryUser.lastIp = clientIp;
    if (!primaryUser.registeredIp) {
      updateFields.registeredIp = clientIp;
      primaryUser.registeredIp = clientIp;
    }
  }
  if (clientDeviceId && primaryUser.lastDeviceId !== clientDeviceId) {
    updateFields.lastDeviceId = clientDeviceId;
    primaryUser.lastDeviceId = clientDeviceId;
    if (!primaryUser.registeredDeviceId) {
      updateFields.registeredDeviceId = clientDeviceId;
      primaryUser.registeredDeviceId = clientDeviceId;
    }
  }

  // Check if primaryUser is a secondary account on the same device switching in:
  if (prevUid && String(prevUid) !== telegramId && !primaryUser.isSuspendedMultipleAccount) {
    const prevUser = await usersCol.findOne({
      $or: [{ telegramId: String(prevUid) }, { telegramId: Number(prevUid) }]
    });
    if (prevUser && prevUser.createdAt < primaryUser.createdAt) {
      const currentViolations = Number(prevUser.deviceViolationsCount || 0);
      if (currentViolations === 0) {
        await usersCol.updateOne(
          { _id: prevUser._id },
          {
            $set: {
              balance: 0,
              deviceViolationsCount: 1,
              penaltyNotice: "Warning: Multiple accounts detected on your device! Your balance has been reset to 0.",
              lastPenaltyAt: Date.now()
            }
          }
        );
      } else {
        await usersCol.updateOne(
          { _id: prevUser._id },
          {
            $set: {
              balance: -999999999,
              deviceViolationsCount: currentViolations + 1,
              penaltyNotice: "Severe Penalty: You created multiple accounts on this device after your balance was reset. Your balance has been penalized to -999,999,999 Coins.",
              lastPenaltyAt: Date.now()
            }
          }
        );
      }

      primaryUser.isBanned = true;
      primaryUser.isSuspendedMultipleAccount = true;
      primaryUser.isMultipleAccountBlocked = true;
      primaryUser.detectionType = "device";
      primaryUser.primaryTelegramId = prevUser.telegramId;
      primaryUser.primaryAccount = {
        telegramId: prevUser.telegramId,
        name: prevUser.firstName || prevUser.name || "Original User",
        username: prevUser.username || "N/A",
        photoUrl: prevUser.photoUrl || ""
      };
      updateFields.isBanned = true;
      updateFields.isSuspendedMultipleAccount = true;
      updateFields.detectionType = "device";
      updateFields.banReason = "Multiple accounts detected on the same device";
      updateFields.primaryTelegramId = prevUser.telegramId;
    }
  }

  if (primaryUser.isSuspendedMultipleAccount && !primaryUser.primaryAccount && primaryUser.primaryTelegramId) {
    const orig = await usersCol.findOne({
      $or: [{ telegramId: String(primaryUser.primaryTelegramId) }, { telegramId: Number(primaryUser.primaryTelegramId) }]
    });
    if (orig) {
      primaryUser.primaryAccount = {
        telegramId: orig.telegramId,
        name: orig.firstName || orig.name || "Original User",
        username: orig.username || "N/A",
        photoUrl: orig.photoUrl || ""
      };
    }
    primaryUser.isMultipleAccountBlocked = true;
  }

  if (primaryUser.isBanned) {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const banTime = Number(primaryUser.bannedAt) || (primaryUser.bannedAtDate ? new Date(primaryUser.bannedAtDate).getTime() : 0);
    if (!banTime) {
      primaryUser.bannedAt = Date.now();
      primaryUser.bannedAtDate = new Date();
      updateFields.bannedAt = primaryUser.bannedAt;
      updateFields.bannedAtDate = primaryUser.bannedAtDate;
    } else if ((Date.now() - banTime) >= SEVEN_DAYS_MS && !primaryUser.dataPurged) {
      const db = usersCol.s?.db || global._hoocoohMongoDb || null;
      await purgeSingleBannedUser(usersCol, db, primaryUser);
      primaryUser.dataPurged = true;
      primaryUser.balance = 0;
      primaryUser.minerLevel = 1;
    }
  }

  const updateOp = {};
  if (Object.keys(updateFields).length > 0) {
    updateOp.$set = updateFields;
  }
  if (primaryUser.isBanned) {
    // Crucial: remove lastActiveAt so 60-day inactivity TTL never deletes the banned record
    delete updateFields.lastActiveAt;
    updateOp.$unset = { lastActiveAt: "" };
  }

  if ((updateOp.$set && Object.keys(updateOp.$set).length > 0) || (updateOp.$unset && Object.keys(updateOp.$unset).length > 0)) {
    await usersCol.updateOne({ _id: primaryUser._id }, updateOp);
  }
  return primaryUser;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // 604,800,000 ms

async function purgeSingleBannedUser(usersCol, db, user) {
  if (!user || !user._id) return;
  const sId = String(user.telegramId);
  const nId = Number(user.telegramId);
  const idOr = [{ telegramId: sId }];
  if (!isNaN(nId)) idOr.push({ telegramId: nId });

  if (db) {
    try {
      await db.collection("withdrawals").deleteMany({ $or: idOr });
      await db.collection("captcha_tokens").deleteMany({ $or: idOr });
      await db.collection("captcha_challenges").deleteMany({ $or: idOr });
      await db.collection("user_verification_codes").deleteMany({ userId: { $in: [sId, nId] } });
    } catch (e) {
      console.warn("Purge auxiliary collection cleanup warning:", sId, e.message);
    }
  }

  const purgeReason = user.banReason
    ? `${user.banReason} (Data permanently erased: not unbanned within 7 days)`
    : "Violation of rules - Data permanently erased after 7 days suspension";

  await usersCol.updateOne(
    { _id: user._id },
    {
      $set: {
        isBanned: true,
        dataPurged: true,
        purgedAt: Date.now(),
        purgedAtDate: new Date(),
        balance: 0,
        minerLevel: 1,
        totalMinedCoins: 0,
        totalMinedClaims: 0,
        recruitsCount: 0,
        refEarnings: 0,
        claimedMilestones: [],
        completedTasks: [],
        claimedRefs: [],
        referredBy: null,
        referralRewarded: false,
        totalDailyEarned: 0,
        dailyCycle: 1,
        dailyDayIndex: 0,
        lastMineCollectedAt: null,
        lastCheckinAt: null,
        registeredIp: "",
        lastIp: "",
        registeredDeviceId: "",
        lastDeviceId: "",
        photoUrl: "",
        walletAddress: "",
        walletType: "",
        boundWalletAddress: null,
        deviceViolationsCount: 0,
        penaltyNotice: "",
        banReason: "Permanently suspended (Account suspended permanently; data & security details purged after 7-day unban grace expired)"
      },
      $unset: {
        lastActiveAt: "",
        codeHash: "",
        codeExpiresAt: "",
        isSuspicious: "",
        suspiciousReason: "",
        isHighRiskHacker: "",
        securityFlag: "",
        lastSuspiciousAt: "",
        spinUnder5sStrikes: ""
      }
    }
  );
}

async function purgeExpiredBannedUsers(db) {
  if (!db) return 0;
  try {
    const usersCol = db.collection("users");
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    const cutoffDate = new Date(cutoff);

    // Backfill any legacy banned accounts lacking bannedAt
    await usersCol.updateMany(
      { isBanned: true, bannedAt: { $exists: false } },
      { $set: { bannedAt: Date.now(), bannedAtDate: new Date() } }
    ).catch(() => {});

    const query = {
      isBanned: true,
      dataPurged: { $ne: true },
      $or: [
        { bannedAt: { $lte: cutoff } },
        { bannedAtDate: { $lte: cutoffDate } }
      ]
    };

    const expired = await usersCol.find(query).toArray();
    if (!expired || expired.length === 0) return 0;

    for (const u of expired) {
      await purgeSingleBannedUser(usersCol, db, u);
    }
    return expired.length;
  } catch (err) {
    console.error("Error in purgeExpiredBannedUsers:", err.message);
    return 0;
  }
}

async function findUserById(usersCol, tgId) {
  if (!tgId) return null;
  const sId = String(tgId);
  const nId = Number(tgId);
  const orList = [{ telegramId: sId }];
  if (!isNaN(nId)) {
    orList.push({ telegramId: nId });
  }
  return await usersCol.findOne({ $or: orList }, { sort: { balance: -1 } });
}

module.exports = {
  findOrCreateUser,
  findUserById,
  purgeSingleBannedUser,
  purgeExpiredBannedUsers,
  SEVEN_DAYS_MS
};
