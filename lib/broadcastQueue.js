const crypto = require("crypto");

let broadcastIndexesEnsured = false;

async function ensureBroadcastIndexes(db) {
  if (broadcastIndexesEnsured || !db) return;
  broadcastIndexesEnsured = true;
  try {
    await db.collection("users").createIndex({ lastBroadcastId: 1 }).catch(() => {});
    await db.collection("broadcast_jobs").createIndex({ status: 1, createdAt: 1 }).catch(() => {});
    await db.collection("broadcast_deliveries").createIndex(
      { broadcastId: 1, telegramId: 1 },
      { unique: true }
    ).catch(() => {});
  } catch (e) {}
}

async function sendBroadcastTelegramMsg(botToken, chatId, text, options = {}) {
  if (!botToken || !chatId) return { ok: false, error_code: 400 };
  try {
    const basePayload = {
      chat_id: String(chatId),
      parse_mode: "HTML",
      disable_web_page_preview: false
    };

    if (options.buttonText && options.buttonUrl) {
      const isWebApp = options.buttonUrl.includes("t.me/") === false;
      basePayload.reply_markup = {
        inline_keyboard: [
          [
            isWebApp
              ? { text: options.buttonText, web_app: { url: options.buttonUrl } }
              : { text: options.buttonText, url: options.buttonUrl }
          ]
        ]
      };
    }

    if (options.photoUrl) {
      try {
        const photoPayload = Object.assign({}, basePayload, {
          photo: options.photoUrl,
          caption: text
        });
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(photoPayload)
        });
        const data = await res.json();
        if (data && data.ok) return { ok: true };
        if (data && (data.error_code === 403 || data.error_code === 429)) {
          return { ok: false, error_code: data.error_code, description: data.description };
        }
      } catch (e) {}
    }

    const textPayload = Object.assign({}, basePayload, { text });
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(textPayload)
    });
    const data = await res.json();
    return {
      ok: Boolean(data && data.ok),
      error_code: data ? data.error_code : 0,
      description: data ? data.description : ""
    };
  } catch (e) {
    return { ok: false, error_code: 500, description: e.message };
  }
}

/**
 * Starts a new broadcast job (or attaches to an identical running job)
 * and immediately processes as many recipients as fit within timeBudgetMs.
 * Any remaining users are automatically processed by cron-job.org in the background!
 */
async function startOrContinueBroadcast(db, botToken, payload, timeBudgetMs = 5500) {
  await ensureBroadcastIndexes(db);

  const usersCol = db.collection("users");
  const jobsCol = db.collection("broadcast_jobs");

  const cleanMsg = String(payload.message || "").trim();
  const cleanPhoto = String(payload.photoUrl || "").trim();
  const cleanBtnText = String(payload.buttonText || "").trim();
  const cleanBtnUrl = String(payload.buttonUrl || "").trim();

  const contentHash = crypto
    .createHash("sha1")
    .update([cleanMsg, cleanPhoto, cleanBtnText, cleanBtnUrl].join("\u0001"))
    .digest("hex");

  // Check if an identical broadcast is already running
  let job = await jobsCol.findOne({ contentHash, status: "running" });

  if (!job) {
    // Count distinct telegramId recipients
    const allUsers = await usersCol.find(
      { telegramId: { $exists: true, $ne: null } },
      { projection: { telegramId: 1 } }
    ).toArray();
    const recipientSet = new Set();
    for (const u of allUsers) {
      const tid = u && u.telegramId != null ? String(u.telegramId).trim() : "";
      if (tid) recipientSet.add(tid);
    }
    const totalUsers = recipientSet.size;
    const broadcastId = `${contentHash.slice(0, 16)}_${Date.now()}`;

    job = {
      broadcastId,
      contentHash,
      message: cleanMsg,
      photoUrl: cleanPhoto || null,
      buttonText: cleanBtnText || null,
      buttonUrl: cleanBtnUrl || null,
      status: "running",
      totalUsers,
      sentCount: 0,
      failCount: 0,
      skippedCount: 0,
      createdAt: Date.now(),
      createdAtDate: new Date(),
      updatedAt: Date.now()
    };

    const insertRes = await jobsCol.insertOne(job);
    job._id = insertRes.insertedId;
  }

  return await processSingleBroadcastJob(db, botToken, job, timeBudgetMs);
}

/**
 * Processes the active broadcast job for up to timeBudgetMs.
 * Called both by Admin Panel and automatically by cron-job.org!
 */
async function processSingleBroadcastJob(db, botToken, job, timeBudgetMs = 5500) {
  if (!db || !botToken || !job) return null;
  await ensureBroadcastIndexes(db);

  const usersCol = db.collection("users");
  const jobsCol = db.collection("broadcast_jobs");
  const deliveriesCol = db.collection("broadcast_deliveries");

  const startTime = Date.now();
  let batchSent = 0;
  let batchFail = 0;
  let batchSkipped = 0;
  let hitRateLimit = false;

  while (Date.now() - startTime < timeBudgetMs && !hitRateLimit) {
    const remainingTime = timeBudgetMs - (Date.now() - startTime);
    if (remainingTime < 700) break;

    const rawBatch = await usersCol
      .find({
        telegramId: { $exists: true, $ne: null },
        lastBroadcastId: { $ne: job.broadcastId }
      })
      .project({ _id: 1, telegramId: 1 })
      .limit(25)
      .toArray();

    if (!rawBatch || rawBatch.length === 0) {
      break;
    }

    // Deduplicate telegramIds within this batch
    const uniqueTids = [];
    const seenTids = new Set();
    for (const u of rawBatch) {
      const tid = String(u.telegramId || "").trim();
      if (tid && !seenTids.has(tid)) {
        seenTids.add(tid);
        uniqueTids.push(tid);
      }
    }

    // Process in parallel sub-chunks of 5 to achieve ~20-25 msgs/sec safely
    for (let i = 0; i < uniqueTids.length; i += 5) {
      if (Date.now() - startTime >= timeBudgetMs || hitRateLimit) break;

      const chunk = uniqueTids.slice(i, i + 5);
      await Promise.all(
        chunk.map(async (tid) => {
          const numId = Number(tid);
          const idQuery = !isNaN(numId)
            ? { $or: [{ telegramId: tid }, { telegramId: numId }] }
            : { telegramId: tid };

          // Mark user documents as processed for this broadcastId
          await usersCol.updateMany(idQuery, { $set: { lastBroadcastId: job.broadcastId } });

          // Atomic delivery claim per (broadcastId, telegramId)
          try {
            await deliveriesCol.insertOne({
              broadcastId: job.broadcastId,
              telegramId: tid,
              createdAt: new Date()
            });
          } catch (claimErr) {
            if (claimErr && claimErr.code === 11000) {
              batchSkipped++;
              return;
            }
            batchFail++;
            return;
          }

          const sendRes = await sendBroadcastTelegramMsg(botToken, tid, job.message, {
            photoUrl: job.photoUrl,
            buttonText: job.buttonText,
            buttonUrl: job.buttonUrl
          });

          if (sendRes && sendRes.ok) {
            batchSent++;
          } else if (sendRes && sendRes.error_code === 429) {
            // Telegram rate limit: revert claim so next cron tick retries this user
            hitRateLimit = true;
            await usersCol.updateMany(idQuery, { $unset: { lastBroadcastId: "" } }).catch(() => {});
            await deliveriesCol.deleteOne({ broadcastId: job.broadcastId, telegramId: tid }).catch(() => {});
          } else {
            batchFail++;
          }
        })
      );

      // Polite 180ms pause between 5-message chunks (~25 msgs/sec)
      await new Promise((r) => setTimeout(r, 180));
    }
  }

  // Count how many users still haven't received this broadcast
  const remainingDocsCount = await usersCol.countDocuments({
    telegramId: { $exists: true, $ne: null },
    lastBroadcastId: { $ne: job.broadcastId }
  });

  const isCompleted = remainingDocsCount === 0 && !hitRateLimit;

  const updatedJobRes = await jobsCol.findOneAndUpdate(
    { _id: job._id },
    {
      $inc: {
        sentCount: batchSent,
        failCount: batchFail,
        skippedCount: batchSkipped
      },
      $set: {
        status: isCompleted ? "completed" : "running",
        remainingUsers: remainingDocsCount,
        updatedAt: Date.now(),
        ...(isCompleted ? { completedAt: Date.now() } : {})
      }
    },
    { returnDocument: "after" }
  );

  const finalJob = (updatedJobRes && updatedJobRes.value !== undefined)
    ? updatedJobRes.value
    : (updatedJobRes || job);

  const totalSent = Number(finalJob.sentCount) || (Number(job.sentCount || 0) + batchSent);
  const totalFail = Number(finalJob.failCount) || (Number(job.failCount || 0) + batchFail);
  const totalSkipped = Number(finalJob.skippedCount) || (Number(job.skippedCount || 0) + batchSkipped);
  const totalUsers = Number(finalJob.totalUsers) || 0;

  return {
    ok: true,
    broadcastId: job.broadcastId,
    status: isCompleted ? "completed" : "running",
    completed: isCompleted,
    queuedForCron: !isCompleted,
    batchSent,
    batchFail,
    sentCount: totalSent,
    failCount: totalFail,
    skippedCount: totalSkipped,
    remainingUsers: remainingDocsCount,
    totalUsers,
    message: isCompleted
      ? `Broadcast finished: ${totalSent} sent, ${totalFail} failed, ${totalSkipped} skipped.`
      : `Broadcast in progress (${totalSent + totalFail}/${totalUsers} processed, ${remainingDocsCount} remaining queued for Cron-Job.org).`
  };
}

/**
 * Called automatically by cron-job.org (via webhook.js / tasks.js / miningReminder.js)
 * or by Admin Panel step polling to process any active "running" broadcast job.
 */
async function processBroadcastQueue(db, botToken, timeBudgetMs = 4500) {
  if (!db || !botToken) return { active: false, processed: 0 };
  try {
    const jobsCol = db.collection("broadcast_jobs");
    const activeJob = await jobsCol.findOne(
      { status: "running" },
      { sort: { createdAt: 1 } }
    );
    if (!activeJob) {
      return { active: false, processed: 0 };
    }

    const result = await processSingleBroadcastJob(db, botToken, activeJob, timeBudgetMs);

    // If completed via background cron and it had multiple batches, notify Admin on Telegram!
    if (result && result.completed && process.env.ADMIN_TELEGRAM_ID) {
      const adminIds = String(process.env.ADMIN_TELEGRAM_ID)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const summaryText =
        `📢 <b>Broadcast Delivery Completed (Cron-Job)</b>\n\n` +
        `👥 <b>Total Users:</b> ${result.totalUsers}\n` +
        `✅ <b>Successfully Sent:</b> ${result.sentCount}\n` +
        `❌ <b>Failed / Blocked:</b> ${result.failCount}\n` +
        `⏭️ <b>Skipped (Duplicate):</b> ${result.skippedCount}`;
      for (const admId of adminIds) {
        sendBroadcastTelegramMsg(botToken, admId, summaryText).catch(() => {});
      }
    }

    return {
      active: true,
      ...result
    };
  } catch (err) {
    console.warn("processBroadcastQueue error:", err.message);
    return { active: false, error: err.message };
  }
}

module.exports = {
  startOrContinueBroadcast,
  processBroadcastQueue,
  processSingleBroadcastJob
};
