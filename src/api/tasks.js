const { getDb } = require("../lib/mongodb");
const { validateInitData } = require("../lib/telegramAuth");
const { findOrCreateUser } = require("../lib/userHelper");
const { getAdminDepositAddress, checkTonDeposit, notifyUserTaskActivated } = require("../lib/tonDeposit");
const { processMiningReminders } = require("../lib/miningReminder");
const { ObjectId } = require("mongodb");
const { verifyActionToken, createActionToken } = require("../lib/actionSigner");

module.exports = async (req, res) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not configured" });
    return;
  }

  // 0. CRON JOB TRIGGER (compatible with Vercel Cron, cron-job.org & external services)
  // Check all pending task deposits on-chain and send 2-hour mining reminders
  const isCron = (req.query && (req.query.cron === "check_deposits" || req.query.cron === "deposit" || req.query.cron === "true" || req.query.cron === "mining_reminder" || req.query.cron === "mining")) ||
                 (req.headers && (req.headers["x-cron-check"] === "check_deposits" || (req.headers["user-agent"] && req.headers["user-agent"].includes("cron-job.org"))));
  if (isCron) {
    // Authenticate cron trigger if CRON_SECRET or ADMIN_SECRET_KEY is configured
    const cronSecret = process.env.CRON_SECRET || process.env.ADMIN_SECRET_KEY;
    if (cronSecret) {
      const authHeader = req.headers["authorization"] || "";
      const cronKeyHeader = req.headers["x-cron-secret"] || req.headers["x-admin-key"] || "";
      const queryKey = req.query ? (req.query.secret || req.query.key || req.query.adminKey || "") : "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
      const providedKey = (cronKeyHeader || queryKey || bearerToken).trim();

      if (providedKey !== cronSecret.trim()) {
        res.status(401).json({ error: "Unauthorized cron trigger: Invalid or missing cron secret" });
        return;
      }
    }

    try {
      const db = await getDb();
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const baseUrl = `${protocol}://${host}`;

      // 1. Process 2-hour mining reminders for completed miners
      const miningReminders = await processMiningReminders(db, botToken, baseUrl);

      // 2. Check pending task deposits on-chain
      const tasksCol = db.collection("tasks");
      const pendingTasks = await tasksCol
        .find({ status: "pending_payment" })
        .toArray();

      let activated = 0;
      let declined = 0;
      const now = Date.now();

      for (const t of pendingTasks) {
        if (!t.depositAddress || !t.memo) continue;
        const taskExpiry = t.expiresAt || (t.createdAt ? t.createdAt + 30 * 60 * 1000 : 0);

        // First check on-chain if user paid
        const resCheck = await checkTonDeposit(t.depositAddress, t.tonCost, t.memo);
        if (resCheck.verified) {
          await tasksCol.updateOne(
            { _id: t._id },
            { $set: { status: "active", paid: true, paidAt: now, txHash: resCheck.txHash } }
          );
          if (t.creatorId) {
            await notifyUserTaskActivated(botToken, t.creatorId, t, resCheck.txHash);
          }
          activated++;
          continue;
        }

        // If unpaid and 30 minutes have passed -> auto-decline
        if (taskExpiry && now > taskExpiry) {
          await tasksCol.updateOne(
            { _id: t._id },
            { $set: { status: "declined", declinedReason: "Unpaid within 30 minutes" } }
          );
          declined++;
        }
      }

      res.status(200).json({
        ok: true,
        deposits: { processed: pendingTasks.length, activated, declined },
        miningReminders
      });
      return;
    } catch (cronErr) {
      console.error("Cron check_deposits error:", cronErr);
      res.status(500).json({ error: cronErr.message });
      return;
    }
  }

  const initData = req.headers["x-telegram-init-data"];
  const tgUser = validateInitData(initData, botToken);
  if (!tgUser) {
    res.status(401).json({ error: "Invalid session - reopen app from Telegram" });
    return;
  }
  const telegramId = String(tgUser.id);

  try {
    const db = await getDb();
    const tasksCol = db.collection("tasks");
    const usersCol = db.collection("users");

    // Retrieve or merge unified user record
    const user = await findOrCreateUser(usersCol, tgUser);

    if (user && user.isBanned) {
      res.status(403).json({ error: "Your account has been suspended" });
      return;
    }

    // GET: list tasks or user's task history
    if (req.method === "GET") {
      // 1. User's own task history
      if (req.query && (req.query.my === "1" || req.query.action === "history")) {
        const myTasks = await tasksCol.find({ creatorId: telegramId }).sort({ createdAt: -1 }).toArray();
        const now = Date.now();

        // Check pending tasks to auto-verify or decline if 30m expired
        for (const t of myTasks) {
          if (t.status === "pending_payment" && t.depositAddress && t.memo) {
            const taskExpiry = t.expiresAt || (t.createdAt ? t.createdAt + 30 * 60 * 1000 : 0);
            const resCheck = await checkTonDeposit(t.depositAddress, t.tonCost, t.memo);
            if (resCheck.verified) {
              t.status = "active";
              t.paid = true;
              t.paidAt = now;
              t.txHash = resCheck.txHash;
              await tasksCol.updateOne(
                { _id: t._id },
                { $set: { status: "active", paid: true, paidAt: now, txHash: resCheck.txHash } }
              );
              await notifyUserTaskActivated(botToken, telegramId, t, resCheck.txHash);
            } else if (taskExpiry && now > taskExpiry) {
              t.status = "declined";
              await tasksCol.updateOne(
                { _id: t._id },
                { $set: { status: "declined", declinedReason: "Unpaid within 30 minutes" } }
              );
            }
          }
        }

        const mappedHistory = myTasks.map(t => {
          const completedArr = t.completedBy || [];
          const target = t.targetCount || 100;
          const completed = completedArr.length;
          const isCompleted = completed >= target;
          let displayStatus = t.status || "pending_payment";
          if (displayStatus === "active" && isCompleted) {
            displayStatus = "completed";
          }
          return {
            id: String(t._id),
            title: t.title,
            link: t.link,
            type: t.type || "normal",
            targetUsers: target,
            completedUsers: completed,
            remainingUsers: Math.max(0, target - completed),
            isCompleted: isCompleted,
            status: displayStatus,
            tonCost: t.tonCost || 0.15,
            depositAddress: t.depositAddress,
            memo: t.memo,
            createdAt: t.createdAt,
            expiresAt: t.expiresAt || (t.createdAt + 30 * 60 * 1000),
            txHash: t.txHash || null
          };
        });

        res.status(200).json({ ok: true, history: mappedHistory });
        return;
      }

      const userCompleted = (user && user.completedTasks) || [];

      // Find active tasks from database
      const customTasks = await tasksCol.find({ status: "active" }).sort({ createdAt: -1 }).toArray();

      // Filter out tasks already completed/claimed by this user OR target limit reached
      const activeTasks = customTasks.filter(t => {
        const idStr = String(t._id);
        const completedArr = t.completedBy || [];
        const isCompleted = userCompleted.includes(idStr) || completedArr.includes(telegramId);
        
        // If user already claimed this task, it disappears!
        if (isCompleted) return false;

        // If target limit reached (and not unlimited), hide from new users
        if (!t.isUnlimited && t.targetCount && completedArr.length >= t.targetCount) {
          return false;
        }

        return true;
      });

      const mapped = activeTasks.map(t => {
        const idStr = String(t._id);
        const completedArr = t.completedBy || [];
        return {
          id: idStr,
          type: t.type || "normal",
          title: t.title,
          link: t.link,
          reward: 10,
          targetCount: t.targetCount === 99999999 || !t.targetCount || t.isUnlimited ? "Unlimited" : t.targetCount,
          completedCount: completedArr.length,
          isCompleted: false
        };
      });

      res.status(200).json({ ok: true, tasks: mapped });
      return;
    }

    // POST: claim or create
    if (req.method === "POST") {
      const { action } = req.body || {};

      // 1. CLAIM
      if (action === "claim") {
        // Cryptographic Action Signing Verification
        const actionToken = (req.body && req.body.actionToken) || req.headers["x-action-token"] || req.headers["x-action-signature"] || req.headers["x-action-secret"];
        if (!verifyActionToken(telegramId, "complete_task", actionToken)) {
          res.status(403).json({ error: "Security check failed: Invalid or missing action signature token." });
          return;
        }

        const { taskId } = req.body || {};
        if (!taskId) {
          res.status(400).json({ error: "Task ID is required" });
          return;
        }

        const userCompleted = (user && user.completedTasks) || [];
        if (userCompleted.includes(String(taskId))) {
          res.status(400).json({ error: "Task already claimed" });
          return;
        }

        let objId;
        try { objId = new ObjectId(taskId); } catch(e) { objId = null; }
        const taskQuery = objId ? { _id: objId } : { _id: taskId };
        const taskObj = await tasksCol.findOne(taskQuery);

        if (!taskObj) {
          res.status(404).json({ error: "Task not found" });
          return;
        }

        // Verified task check: User must actually have joined the Telegram channel/group!
        if (taskObj.type === "verified" && taskObj.link) {
          let cleanChat = taskObj.link.trim()
            .replace(/https?:\/\/t\.me\//i, "")
            .replace(/^@/, "")
            .split("/")[0]
            .split("?")[0]
            .trim();

          if (cleanChat) {
            const targetChatId = "@" + cleanChat;
            try {
              const checkRes = await fetch(
                `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(targetChatId)}&user_id=${telegramId}`
              );
              const checkData = await checkRes.json();

              if (!checkData.ok) {
                const desc = (checkData.description || "").toLowerCase();
                // If user not in chat
                if (desc.includes("user not found") || desc.includes("user_not_participant")) {
                  res.status(400).json({
                    error: `You haven't joined ${targetChatId} yet! Please join first to claim reward.`
                  });
                  return;
                } else if (!desc.includes("chat not found")) {
                  res.status(400).json({
                    error: `Please join ${targetChatId} to claim your +10 HOOCOOH reward!`
                  });
                  return;
                }
              } else {
                const memberStatus = checkData.result && checkData.result.status;
                if (memberStatus === "left" || memberStatus === "kicked" || !memberStatus) {
                  res.status(400).json({
                    error: `You must join ${targetChatId} first to claim your +10 HOOCOOH reward!`
                  });
                  return;
                }
              }
            } catch (checkErr) {
              console.warn("Telegram membership check warning:", checkErr);
              res.status(400).json({
                error: `Could not verify membership for ${targetChatId}. Please make sure you joined and try again.`
              });
              return;
            }
          }
        }

        if (taskQuery) {
          await tasksCol.updateOne(taskQuery, { $addToSet: { completedBy: telegramId } });
        }

        // Atomically claim task (impossible for concurrent requests to both claim)
        const claimTaskRes = await usersCol.updateOne(
          {
            _id: user._id,
            completedTasks: { $ne: String(taskId) }
          },
          {
            $inc: { balance: 10 },
            $push: { completedTasks: String(taskId) },
            $set: { lastActiveAt: new Date() }
          }
        );

        if (!claimTaskRes || claimTaskRes.modifiedCount === 0) {
          res.status(400).json({ error: "Task already claimed" });
          return;
        }

        const updatedUser = await usersCol.findOne({ _id: user._id });
        const newBal = Number(updatedUser ? updatedUser.balance : (Number(user.balance || 0) + 10));

        res.status(200).json({
          ok: true,
          reward: 10,
          newBalance: newBal,
          newActionToken: createActionToken(telegramId, "complete_task")
        });
        return;
      }

      // 2. CREATE (Initializes task with pending_payment status and returns deposit details)
      if (action === "create") {
        const { title, link, type, targetUsers } = req.body || {};
        if (!title || !title.trim()) {
          res.status(400).json({ error: "Task title is required" });
          return;
        }
        if (!link || !link.trim()) {
          res.status(400).json({ error: "Channel/Group link or username is required" });
          return;
        }

        const count = Math.max(100, parseInt(targetUsers, 10) || 100);
        const taskType = type === "verified" ? "verified" : "normal";
        const tonCost = Number(req.body.tonCost || ((count / 100) * 0.15).toFixed(2));

        let cleanLink = link.trim();
        if (!cleanLink.startsWith("http") && !cleanLink.startsWith("t.me")) {
          cleanLink = "https://t.me/" + cleanLink.replace(/^@/, "");
        } else if (cleanLink.startsWith("t.me")) {
          cleanLink = "https://" + cleanLink;
        }

        const depositAddress = await getAdminDepositAddress(db);
        const memo = `TASK-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

        const now = Date.now();
        const expiresAt = now + 30 * 60 * 1000;

        const newTask = {
          creatorId: telegramId,
          type: taskType,
          title: title.trim(),
          link: cleanLink,
          reward: 10,
          targetCount: count,
          tonCost: tonCost,
          currency: "TON",
          depositAddress: depositAddress,
          memo: memo,
          completedBy: [],
          status: "pending_payment",
          paid: false,
          createdAt: now,
          expiresAt: expiresAt
        };

        const insertRes = await tasksCol.insertOne(newTask);
        const taskId = String(insertRes.insertedId);

        res.status(200).json({
          ok: true,
          requiresDeposit: true,
          deposit: {
            taskId: taskId,
            title: newTask.title,
            targetUsers: count,
            tonCost: tonCost,
            depositAddress: depositAddress,
            memo: memo,
            createdAt: now,
            expiresAt: expiresAt
          },
          message: "Please complete the TON deposit to publish your task."
        });
        return;
      }

      // 3. CHECK DEPOSIT (Triggered by client polling, wallet confirmation, or manual check)
      if (action === "check_deposit") {
        const { taskId } = req.body || {};
        if (!taskId) {
          res.status(400).json({ error: "taskId is required" });
          return;
        }

        let objId;
        try { objId = new ObjectId(taskId); } catch(e) { objId = null; }
        const taskQuery = objId ? { _id: objId } : { _id: taskId };
        const task = await tasksCol.findOne(taskQuery);

        if (!task) {
          res.status(404).json({ error: "Task not found" });
          return;
        }

        if (task.status === "active" && task.paid) {
          res.status(200).json({
            ok: true,
            paid: true,
            status: "active",
            txHash: task.txHash || null,
            message: "Task is active and published!"
          });
          return;
        }

        if (task.status === "declined") {
          res.status(200).json({
            ok: true,
            paid: false,
            status: "declined",
            message: "Deposit window expired (30 minutes). Task declined."
          });
          return;
        }

        const now = Date.now();
        const taskExpiry = task.expiresAt || (task.createdAt ? task.createdAt + 30 * 60 * 1000 : 0);

        // Check on-chain deposit
        const resCheck = await checkTonDeposit(task.depositAddress, task.tonCost, task.memo);
        if (resCheck.verified) {
          await tasksCol.updateOne(
            taskQuery,
            {
              $set: {
                status: "active",
                paid: true,
                paidAt: now,
                txHash: resCheck.txHash,
                sender: resCheck.sender || null
              }
            }
          );

          await notifyUserTaskActivated(botToken, telegramId, task, resCheck.txHash);

          res.status(200).json({
            ok: true,
            paid: true,
            status: "active",
            txHash: resCheck.txHash,
            message: "Payment confirmed! Your task is now active."
          });
          return;
        }

        // If unpaid and 30 minutes expired -> decline
        if (taskExpiry && now > taskExpiry) {
          await tasksCol.updateOne(
            taskQuery,
            { $set: { status: "declined", declinedReason: "Unpaid within 30 minutes" } }
          );
          res.status(200).json({
            ok: true,
            paid: false,
            status: "declined",
            message: "Deposit window expired (30 minutes). Task declined."
          });
          return;
        }

        res.status(200).json({
          ok: true,
          paid: false,
          status: "pending_payment",
          expiresAt: taskExpiry,
          message: "Payment not detected on-chain yet. Please ensure you sent with the exact memo."
        });
        return;
      }

      // 4. CANCEL UNPAID PENDING TASK DRAFT
      if (action === "cancel_task") {
        const { taskId } = req.body || {};
        if (taskId) {
          let objId;
          try { objId = new ObjectId(taskId); } catch(e) { objId = null; }
          const taskQuery = objId ? { _id: objId } : { _id: taskId };
          await tasksCol.deleteOne({
            ...taskQuery,
            creatorId: telegramId,
            paid: { $ne: true },
            status: "pending_payment"
          });
        }
        res.status(200).json({ ok: true, message: "Unpaid task draft removed." });
        return;
      }

      res.status(400).json({ error: "Unknown action" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("tasks.js error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
};
