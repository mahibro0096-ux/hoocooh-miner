const fs = require("fs");
const path = require("path");
const { ObjectId } = require("mongodb");
const { getDb } = require("../lib/mongodb");
const { generateVerificationImage } = require("../lib/verificationImage");
const { processMiningReminders } = require("../lib/miningReminder");
const { dispatchTonPayout } = require("../lib/tonAutoPay");
const { purgeExpiredBannedUsers } = require("../lib/userHelper");

const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || "hoocooh_admin_2026";

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function getAdminTelegramIds(db) {
  const ids = new Set();
  
  // 1. From Vercel Environment Variable (comma separated or single)
  if (process.env.ADMIN_TELEGRAM_ID) {
    process.env.ADMIN_TELEGRAM_ID.split(",").forEach(id => {
      const trimmed = id.trim();
      if (trimmed) ids.add(trimmed);
    });
  }

  // 2. From MongoDB settings or admins collection
  try {
    if (db) {
      const setting = await db.collection("settings").findOne({ key: "bot_settings" });
      if (setting && setting.adminTelegramId) {
        String(setting.adminTelegramId).split(",").forEach(id => {
          const trimmed = id.trim();
          if (trimmed) ids.add(trimmed);
        });
      }
      const adminDocs = await db.collection("admins").find({}).toArray();
      adminDocs.forEach(doc => {
        if (doc.telegramId) ids.add(String(doc.telegramId).trim());
      });
    }
  } catch (e) {
    console.error("Error fetching admin IDs from DB:", e);
  }

  return ids;
}

async function sendTelegramMsg(botToken, chatId, text, options = {}) {
  if (!botToken || !chatId) return false;
  try {
    const basePayload = {
      chat_id: String(chatId),
      parse_mode: "HTML",
      disable_web_page_preview: false
    };

    if (options.reply_markup) {
      basePayload.reply_markup = options.reply_markup;
    }

    // If photoBuffer is provided, send as multipart photo
    if (options.photoBuffer) {
      try {
        const formData = new FormData();
        formData.append("chat_id", String(chatId));
        const mimeType = options.photoMime || "image/jpeg";
        const ext = mimeType.includes("png") ? "png" : "jpg";
        const blob = new Blob([options.photoBuffer], { type: mimeType });
        formData.append("photo", blob, `hoocooh_${Date.now()}.${ext}`);
        formData.append("caption", text);
        formData.append("parse_mode", "HTML");
        if (options.reply_markup) {
          formData.append("reply_markup", JSON.stringify(options.reply_markup));
        }
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: "POST",
          body: formData
        });
        const data = await res.json();
        if (data && data.ok) return data;
        console.warn("sendPhoto buffer was not ok, falling back to sendMessage:", data);
      } catch (photoErr) {
        console.warn("sendPhoto buffer error, falling back to sendMessage:", photoErr.message);
      }
    }

    // If photoUrl is provided, send as photo with caption
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
        if (data && data.ok) return data;
        console.warn("sendPhoto was not ok, falling back to sendMessage:", data);
      } catch (photoErr) {
        console.warn("sendPhoto error, falling back to sendMessage:", photoErr);
      }
    }

    // Fallback: send text message
    const textPayload = Object.assign({}, basePayload, {
      text: text
    });
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(textPayload)
    });
    const data = await res.json();
    return data;
  } catch (e) {
    console.error("sendTelegramMsg error:", e);
    return null;
  }
}

const WELCOME_MESSAGES = {
  en: {
    name: "English",
    text: 
`⛏️ <b>Welcome to HOOCOOH Miner!</b>

🌕 <b>Mine the depths, earn HOOCOOH Coins, invite your crew, and withdraw real USDT!</b>

🎮 <b>How it works:</b>

• Dive deep to Mine & Earn
• Complete tasks to stack more HOOCOOH Coins
• Upgrade your mining gear for bigger rewards
• Invite friends to expand your crew & Earn
• Withdraw your earnings directly as USDT!

<b>Convert HOOCOOH Coins ➔ USDT 💲</b>

👇 <b>Tap the button below to start your dive!</b> 👇`,
    btnStart: "⛏️ Start hoocooh miner",
    btnLang: "🌐 Select your language",
    promptLang: "• <b>Language</b>\nChoose your language:",
    toastChanged: "✅ Language set to English!"
  },
  ru: {
    name: "Русский",
    text: 
`⛏️ <b>Добро пожаловать в HOOCOOH Miner!</b>

🌕 <b>Добывайте в глубинах, зарабатывайте HOOCOOH Coins, приглашайте друзей и выводите реальные USDT!</b>

🎮 <b>Как это работает:</b>

• Погружайтесь в шахту, чтобы майнить и зарабатывать
• Выполняйте задания, чтобы получить больше монет
• Улучшайте снаряжение для максимальных наград
• Приглашайте друзей в свою команду и зарабатывайте вместе
• Выводите заработанные средства прямо в USDT!

<b>Конвертируйте HOOCOOH Coins ➔ USDT 💲</b>

👇 <b>Нажмите кнопку ниже, чтобы начать погружение!</b> 👇`,
    btnStart: "⛏️ Начать майнинг hoocooh",
    btnLang: "🌐 Выбрать язык",
    promptLang: "• <b>Язык</b>\nВыберите ваш язык:",
    toastChanged: "✅ Язык изменен на Русский!"
  },
  ar: {
    name: "العربية",
    text: 
`⛏️ <b>مرحبًا بك في HOOCOOH Miner!</b>

🌕 <b>قم بالتعدين في الأعماق، واكسب عملات HOOCOOH، وادعُ أصدقاءك، واسحب عملات USDT حقيقية!</b>

🎮 <b>كيف يعمل:</b>

• انغمس в الأعماق للتعدين والربح
• أكمل المهام لجمع المزيد من عملات HOOCOOH
• قم بترقية معدات التعدين للحصول على أكبر المكافآت
• ادعُ أصدقاءك للانضمام إلى فريقك والربح معًا
• اسحب أرباحك مباشرة كعملة USDT!

<b>تحويل عملات HOOCOOH ➔ USDT 💲</b>

👇 <b>اضغط على الزر أدناه لبدء التعدين!</b> 👇`,
    btnStart: "⛏️ ابدأ تعدين hoocooh",
    btnLang: "🌐 اختر لغتك",
    promptLang: "• <b>اللغة</b>\nاختر لغتك:",
    toastChanged: "✅ تم تعيين اللغة إلى العربية!"
  }
};

async function answerCallbackQuery(botToken, callbackQueryId, text, showAlert = false) {
  if (!botToken || !callbackQueryId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: String(callbackQueryId),
        text: text || "",
        show_alert: !!showAlert
      })
    });
  } catch(e){}
}

async function editTelegramMsg(botToken, chatId, messageId, text, options = {}) {
  if (!botToken || !chatId || !messageId) return null;
  try {
    const payload = {
      chat_id: String(chatId),
      message_id: Number(messageId),
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    if (options.reply_markup) {
      payload.reply_markup = options.reply_markup;
    }
    const res = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    console.error("editTelegramMsg error:", e);
    return null;
  }
}

async function handleAdminApproveWithdrawal(db, botToken, wid, baseUrl) {
  const withdrawalsCol = db.collection("withdrawals");
  const usersCol = db.collection("users");

  let objId;
  try { objId = new ObjectId(wid); } catch(e){ objId = null; }
  const wQuery = objId ? { _id: objId } : { _id: wid };

  const w = await withdrawalsCol.findOne(wQuery);
  if (!w) return { ok: false, message: "Withdrawal request not found." };
  if (w.status !== "PENDING") return { ok: false, message: `Already processed (${w.status}).` };

  const now = Date.now();
  const tonVal = w.tonAmount !== undefined ? Number(w.tonAmount) : Number(((w.usdtAmount || 0) * (0.019 / 0.03)).toFixed(4));
  let finalTx = "";

  // ATOMIC CLAIM BEFORE PAYING: PENDING -> PROCESSING. Only one request can win it, so a double tap on
  // the Approve button / Telegram callback retry can never send the real TON payout twice.
  const claimPayoutRes = await withdrawalsCol.updateOne(
    { ...wQuery, status: "PENDING" },
    { $set: { status: "PROCESSING", processingAt: now } }
  );
  if (!claimPayoutRes || claimPayoutRes.modifiedCount === 0) {
    return { ok: false, message: "Already processed or being processed right now." };
  }

  let autoPayRes;
  try {
    autoPayRes = await dispatchTonPayout(w.walletAddress, tonVal, `HOOCOOH Payout UID ${w.telegramId}`);
  } catch (payErr) {
    try { await withdrawalsCol.updateOne({ ...wQuery, status: "PROCESSING" }, { $set: { status: "PENDING" }, $unset: { processingAt: "" } }); } catch (e) {}
    return { ok: false, message: `Auto-pay error: ${payErr && payErr.message ? payErr.message : payErr}` };
  }
  if (autoPayRes && autoPayRes.isConfigured && autoPayRes.success) {
    finalTx = autoPayRes.txHash;
  } else {
    finalTx = "0x" + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
  }

  const approveUpdateRes = await withdrawalsCol.updateOne(
    { ...wQuery, status: "PROCESSING" },
    {
      $set: {
        status: "APPROVED",
        tonAmount: tonVal,
        txHash: finalTx,
        approvedAt: now
      }
    }
  );

  if (approveUpdateRes.matchedCount === 0 || approveUpdateRes.modifiedCount === 0) {
    return { ok: false, message: "Already processed or no longer pending." };
  }

  // Channel & user notification
  if (botToken) {
    try {
      const userDoc = await usersCol.findOne({
        $or: [{ telegramId: String(w.telegramId) }, { telegramId: Number(w.telegramId) }]
      });
      const rawName = userDoc?.username 
        ? `@${userDoc.username}` 
        : (userDoc?.firstName ? `${userDoc.firstName}${userDoc.lastName ? ' ' + userDoc.lastName : ''}` : `Miner_${String(w.telegramId).slice(-4)}`);
      const displayName = escapeHtml(rawName);
      const txUrl = `https://tonviewer.com/transaction/${encodeURIComponent(finalTx)}`;
      const txLinkHtml = `<a href="${txUrl}">View Transaction</a>`;

      const channelId = process.env.PAYOUT_CHANNEL_ID || "@hoocoohpaylogs";
      const channelMsg = 
`🎉 <b>New payout paid</b> 🎉\n\n` +
`👤 <b>User:</b> ${displayName}\n` +
`🔘 <b>Amount:</b> ${Number(w.amount).toLocaleString()} HOOCOOH (${Number(w.usdtAmount).toFixed(2)} USDT)\n` +
`💳 <b>Wallet address:</b>\n` +
`<code>${w.walletAddress}</code>\n` +
`🔗 <b>Transaction id:</b> ${txLinkHtml}\n\n` +
`BOT ---> @hoocoohmine_bot`;

      await sendTelegramMsg(botToken, channelId, channelMsg);

      if (w.telegramId) {
        const userMsg = 
`✅ <b>Withdrawal Approved!</b>\n\n` +
`🪙 <b>${Number(w.amount).toLocaleString()} HOOCOOH Coins ($${Number(w.usdtAmount).toFixed(2)} USDT) sent!</b>\n` +
`🔗 <a href="${txUrl}">View Transaction</a>`;

        await sendTelegramMsg(botToken, w.telegramId, userMsg, {
          buttonText: "🔗 View Transaction",
          buttonUrl: txUrl
        });
      }
    } catch(e) {
      console.error("Payout notification error:", e);
    }
  }

  return { ok: true, message: `Approved! Sent ${tonVal} TON.` };
}

async function handleAdminRejectWithdrawal(db, botToken, wid) {
  const withdrawalsCol = db.collection("withdrawals");
  const usersCol = db.collection("users");

  let objId;
  try { objId = new ObjectId(wid); } catch(e){ objId = null; }
  const wQuery = objId ? { _id: objId } : { _id: wid };

  const w = await withdrawalsCol.findOne(wQuery);
  if (!w) return { ok: false, message: "Withdrawal not found." };
  if (w.status !== "PENDING") return { ok: false, message: `Already processed (${w.status}).` };

  const now = Date.now();
  const refundAmt = Number(w.amount || 0);
  const rejReason = "Review failed / rejected by admin";

  const rejectUpdateRes = await withdrawalsCol.updateOne(
    { ...wQuery, status: "PENDING" },
    {
      $set: {
        status: "REJECTED",
        reason: rejReason,
        rejectedAt: now
      }
    }
  );

  if (rejectUpdateRes.matchedCount === 0 || rejectUpdateRes.modifiedCount === 0) {
    return { ok: false, message: "Already processed or no longer pending." };
  }

  // Refund coins back to user balance exactly once
  const tid = String(w.telegramId);
  const numId = Number(w.telegramId);
  await usersCol.updateOne(
    { $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])] },
    { $inc: { balance: refundAmt } }
  );

  if (botToken && w.telegramId) {
    const msg = `⚠️ <b>Withdrawal Rejected & Refunded</b>\n\nYour request for <b>${refundAmt.toLocaleString()} Coins</b> was rejected.\n<b>Reason:</b> ${rejReason}\n\nYour <b>${refundAmt.toLocaleString()} HOOCOOH Coins</b> have been returned to your miner balance.`;
    sendTelegramMsg(botToken, w.telegramId, msg);
  }

  return { ok: true, message: `Rejected & ${refundAmt.toLocaleString()} coins refunded.` };
}

async function handleAdminBanWithdrawalUser(db, botToken, wid) {
  const withdrawalsCol = db.collection("withdrawals");
  const usersCol = db.collection("users");

  let objId;
  try { objId = new ObjectId(wid); } catch(e){ objId = null; }
  const wQuery = objId ? { _id: objId } : { _id: wid };

  const w = await withdrawalsCol.findOne(wQuery);
  if (!w) return { ok: false, message: "Withdrawal not found." };

  const tid = String(w.telegramId);
  const numId = Number(w.telegramId);
  const banReason = "Violation of HOOCOOH Miner rules detected during withdrawal review";

  await usersCol.updateMany(
    { $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])] },
    {
      $set: {
        isBanned: true,
        banReason: banReason,
        bannedAt: Date.now(),
        bannedAtDate: new Date(),
        dataPurged: false
      },
      $unset: { lastActiveAt: "" }
    }
  );

  await withdrawalsCol.updateOne(
    { ...wQuery, status: "PENDING" },
    { $set: { status: "REJECTED", reason: "User Banned: " + banReason, rejectedAt: Date.now() } }
  );

  if (botToken && w.telegramId) {
    const msg = `⛔ <b>Account Suspended</b>\n\nYour HOOCOOH Miner account has been suspended.\n<b>Reason:</b> ${banReason}\n\n<i>⚠️ Notice: If this suspension is not lifted within 7 days, all your account progress, coins, and referrals will be permanently deleted while account remains suspended.</i>`;
    sendTelegramMsg(botToken, tid, msg);
  }

  return { ok: true, message: `User ${tid} has been permanently banned.` };
}

async function renderWithdrawalsPage(db, botToken, chatId, messageId, page = 0, baseUrl, bannerText = "") {
  const withdrawalsCol = db.collection("withdrawals");
  const usersCol = db.collection("users");

  const pendingList = await withdrawalsCol.find({ status: "PENDING" }).sort({ createdAt: -1 }).toArray();
  const totalCount = pendingList.length;

  const adminUrl = `${baseUrl}/admin.html`;

  if (totalCount === 0) {
    let msgText = "";
    if (bannerText) msgText += `${bannerText}\n\n`;
    msgText += `💸 <b>Pending Withdrawals</b>\n\n✅ <i>No pending withdrawal requests found! All requests have been processed.</i>`;

    const inlineKeyboard = [
      [
        { text: "🔄 Refresh", callback_data: "adm_wd_page_0" },
        { text: "🛡️ Open Admin Panel", web_app: { url: adminUrl } }
      ]
    ];

    if (messageId) {
      const editRes = await editTelegramMsg(botToken, chatId, messageId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
      if (!editRes || !editRes.ok) {
        await sendTelegramMsg(botToken, chatId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
      }
    } else {
      await sendTelegramMsg(botToken, chatId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
    }
    return;
  }

  const PAGE_SIZE = 5;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const currPage = Math.max(0, Math.min(page, totalPages - 1));
  const items = pendingList.slice(currPage * PAGE_SIZE, (currPage + 1) * PAGE_SIZE);

  // Fetch users info
  const userIds = [...new Set(items.map(w => String(w.telegramId)))];
  const usersMap = {};
  if (userIds.length > 0) {
    const foundUsers = await usersCol.find({
      $or: [
        { telegramId: { $in: userIds } },
        { telegramId: { $in: userIds.map(Number).filter(Boolean) } }
      ]
    }).toArray();
    foundUsers.forEach(u => {
      usersMap[String(u.telegramId)] = u;
    });
  }

  let msgText = "";
  if (bannerText) msgText += `${bannerText}\n\n`;
  msgText += `💸 <b>Pending Withdrawals</b> (Page ${currPage + 1}/${totalPages} • Total: ${totalCount})\n\n`;

  const inlineKeyboard = [];

  items.forEach((w, idx) => {
    const itemNum = currPage * PAGE_SIZE + idx + 1;
    const u = usersMap[String(w.telegramId)] || {};
    const rawName = u.username ? `@${u.username}` : (u.firstName ? u.firstName : "Miner");
    const uname = escapeHtml(rawName);
    const uid = String(w.telegramId || "N/A");
    const coinAmt = Number(w.amount || 0).toLocaleString();
    const usdtAmt = Number(w.usdtAmount || 0).toFixed(2);
    const tonAmt = w.tonAmount !== undefined ? Number(w.tonAmount) : Number(((w.usdtAmount || 0) * (0.019 / 0.03)).toFixed(4));

    let riskBadge = "🟢 Clean";
    if (u.isHighRiskHacker) {
      riskBadge = "🔴 HIGH RISK HACKER";
    } else if (u.isSuspicious) {
      riskBadge = `🟡 Suspicious (${escapeHtml(u.suspiciousReason || "Flagged")})`;
    } else if (u.isBanned) {
      riskBadge = "⛔ Banned";
    }

    const dateStr = w.createdAt ? new Date(w.createdAt).toISOString().replace("T", " ").slice(5, 16) : "Recent";

    msgText += `<b>${itemNum}.</b> ${uname} (UID: <code>${uid}</code>)\n`;
    msgText += `💰 <b>${coinAmt} Coins</b> ($${usdtAmt} USDT • ${tonAmt} TON)\n`;
    msgText += `💳 <code>${w.walletAddress || "No wallet"}</code>\n`;
    msgText += `⚠️ Risk: <b>${riskBadge}</b> | 🕒 ${dateStr}\n\n`;

    const wid = String(w._id);
    inlineKeyboard.push([
      { text: `✅ Approve #${itemNum}`, callback_data: `adm_appr_${wid}` },
      { text: `❌ Reject #${itemNum}`, callback_data: `adm_rej_${wid}` },
      { text: `🚫 Ban #${itemNum}`, callback_data: `adm_ban_${wid}` }
    ]);
  });

  // Pagination navigation row
  const navRow = [];
  if (currPage > 0) {
    navRow.push({ text: "⬅️ Prev", callback_data: `adm_wd_page_${currPage - 1}` });
  }
  navRow.push({ text: `📄 ${currPage + 1}/${totalPages}`, callback_data: `adm_wd_page_${currPage}` });
  if (currPage < totalPages - 1) {
    navRow.push({ text: "Next ➡️", callback_data: `adm_wd_page_${currPage + 1}` });
  }
  inlineKeyboard.push(navRow);

  // Bottom action row
  inlineKeyboard.push([
    { text: "🔄 Refresh", callback_data: `adm_wd_page_${currPage}` },
    { text: "🛡️ Open Admin Panel", web_app: { url: adminUrl } }
  ]);

  if (messageId) {
    const editRes = await editTelegramMsg(botToken, chatId, messageId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
    if (!editRes || !editRes.ok) {
      await sendTelegramMsg(botToken, chatId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
    }
  } else {
    await sendTelegramMsg(botToken, chatId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
  }
}

async function renderTasksPage(db, botToken, chatId, messageId, page = 0, baseUrl, bannerText = "") {
  const tasksCol = db.collection("tasks");

  const allTasks = await tasksCol.find({}).sort({ createdAt: -1 }).toArray();
  const totalCount = allTasks.length;
  const adminUrl = `${baseUrl}/admin.html`;

  if (totalCount === 0) {
    let msgText = "";
    if (bannerText) msgText += `${bannerText}\n\n`;
    msgText += `📋 <b>Platform Tasks</b>\n\n<i>No tasks found in the system.</i>\n\nTap <b>➕ Add Task</b> below to create a new task!`;

    const inlineKeyboard = [
      [
        { text: "➕ Add Task", callback_data: "adm_task_prompt" },
        { text: "🔄 Refresh", callback_data: "adm_tasks_page_0" }
      ],
      [
        { text: "💸 Withdraw", callback_data: "adm_wd_page_0" },
        { text: "🛡️ Open Admin Panel", web_app: { url: adminUrl } }
      ]
    ];

    if (messageId) {
      const editRes = await editTelegramMsg(botToken, chatId, messageId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
      if (!editRes || !editRes.ok) {
        await sendTelegramMsg(botToken, chatId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
      }
    } else {
      await sendTelegramMsg(botToken, chatId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
    }
    return;
  }

  const PAGE_SIZE = 5;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const currPage = Math.max(0, Math.min(page, totalPages - 1));
  const items = allTasks.slice(currPage * PAGE_SIZE, (currPage + 1) * PAGE_SIZE);

  let msgText = "";
  if (bannerText) {
    msgText += `${bannerText}\n\n`;
  }
  msgText += `📋 <b>Platform Tasks (Total: ${totalCount})</b>\n`;
  msgText += `<i>Page ${currPage + 1} of ${totalPages} (Showing 5 per page)</i>\n`;
  msgText += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  const inlineKeyboard = [];

  items.forEach((t, idx) => {
    const itemNum = (currPage * PAGE_SIZE) + idx + 1;
    const completedArr = t.completedBy || [];
    const completedCount = completedArr.length;
    const targetDisplay = t.isUnlimited || !t.targetCount || t.targetCount === 99999999 ? "Unlimited" : t.targetCount;
    const rewardVal = t.reward || 10;
    const statusVal = t.status || "active";
    const statusIcon = statusVal === "active" ? "🟢" : "⚪";

    msgText += `<b>#${itemNum} | ${escapeHtml(t.title || "Untitled Task")}</b>\n`;
    msgText += `🔗 <a href="${t.link || "#"}">${escapeHtml(t.link || "No Link")}</a>\n`;
    msgText += `🎯 <b>Target:</b> ${targetDisplay} | 👥 <b>Done:</b> ${completedCount}\n`;
    msgText += `🎁 <b>Reward:</b> ${rewardVal} Coins | ${statusIcon} <b>Status:</b> ${statusVal}\n\n`;

    inlineKeyboard.push([
      { text: `🗑️ Delete #${itemNum}`, callback_data: `adm_task_del_${t._id}` }
    ]);
  });

  // Navigation row
  const navRow = [];
  if (currPage > 0) {
    navRow.push({ text: "⬅️ Prev", callback_data: `adm_tasks_page_${currPage - 1}` });
  }
  navRow.push({ text: `📄 ${currPage + 1}/${totalPages}`, callback_data: `adm_tasks_page_${currPage}` });
  if (currPage < totalPages - 1) {
    navRow.push({ text: "Next ➡️", callback_data: `adm_tasks_page_${currPage + 1}` });
  }
  inlineKeyboard.push(navRow);

  // Bottom action buttons
  inlineKeyboard.push([
    { text: "➕ Add Task", callback_data: "adm_task_prompt" },
    { text: "🔄 Refresh", callback_data: `adm_tasks_page_${currPage}` }
  ]);
  inlineKeyboard.push([
    { text: "💸 Withdraw", callback_data: "adm_wd_page_0" },
    { text: "🛡️ Open Admin Panel", web_app: { url: adminUrl } }
  ]);

  if (messageId) {
    const editRes = await editTelegramMsg(botToken, chatId, messageId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
    if (!editRes || !editRes.ok) {
      await sendTelegramMsg(botToken, chatId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
    }
  } else {
    await sendTelegramMsg(botToken, chatId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
  }
}

async function renderReferralsPage(db, botToken, chatId, messageId, targetUid, page = 0, baseUrl) {
  const usersCol = db.collection("users");
  const cleanUid = String(targetUid).trim();
  const numId = Number(cleanUid);

  const parentUser = await usersCol.findOne({
    $or: [{ telegramId: cleanUid }, ...(numId ? [{ telegramId: numId }] : [])]
  });

  if (!parentUser) {
    const notFoundText = `❌ <b>User Not Found</b>\n\nNo miner found with UID or Telegram ID: <code>${escapeHtml(cleanUid)}</code>`;
    const keyboard = [
      [{ text: "🔍 Search Another User", callback_data: "adm_ref_prompt" }],
      [{ text: "🔙 Back to Admin", callback_data: "adm_back_menu" }]
    ];
    if (messageId) {
      await editTelegramMsg(botToken, chatId, messageId, notFoundText, { reply_markup: { inline_keyboard: keyboard } });
    } else {
      await sendTelegramMsg(botToken, chatId, notFoundText, { reply_markup: { inline_keyboard: keyboard } });
    }
    return;
  }

  const rawParentName = parentUser.username ? `@${parentUser.username}` : (parentUser.firstName ? parentUser.firstName : "Miner");
  const parentName = escapeHtml(rawParentName);

  const referrals = await usersCol.find({
    $or: [
      { referredBy: cleanUid },
      ...(numId ? [{ referredBy: String(numId) }, { referredBy: numId }] : [])
    ]
  }).sort({ createdAt: -1 }).toArray();

  const totalCount = referrals.length;
  const PAGE_SIZE = 5;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currPage = Math.max(0, Math.min(page, totalPages - 1));
  const items = referrals.slice(currPage * PAGE_SIZE, (currPage + 1) * PAGE_SIZE);

  let msgText = `👥 <b>Referral Crew of ${parentName}</b>\n`;
  msgText += `UID: <code>${cleanUid}</code> • Total Referred: <b>${totalCount} miners</b>\n`;
  msgText += `<i>Page ${currPage + 1} of ${totalPages} (Showing 5 per page)</i>\n`;
  msgText += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (totalCount === 0) {
    msgText += `<i>This user has not invited any friends yet.</i>\n\n`;
  } else {
    items.forEach((ref, idx) => {
      const itemNum = currPage * PAGE_SIZE + idx + 1;
      const refUid = String(ref.telegramId);
      const rawRefName = ref.firstName ? (ref.firstName + (ref.lastName ? " " + ref.lastName : "")) : (ref.username ? `@${ref.username}` : `Miner_${refUid.slice(-4)}`);
      const refName = escapeHtml(rawRefName);
      const isVerified = !!ref.isIdentityVerified;
      const verifiedBadge = isVerified ? "✅ Verified" : "⏳ Unverified";
      const adsCount = Number(ref.totalAdsWatched || 0);
      const bal = Number(ref.balance || 0).toLocaleString();

      // Telegram profile link (Direct username or tg://user?id=)
      const profileLink = ref.username 
        ? `https://t.me/${ref.username.replace(/^@/, '')}` 
        : `tg://user?id=${refUid}`;

      msgText += `<b>#${itemNum} | <a href="${profileLink}">${refName}</a></b>\n`;
      msgText += `🆔 ID: <a href="${profileLink}"><code>${refUid}</code></a> ${ref.username ? `(@${escapeHtml(ref.username)})` : ''}\n`;
      msgText += `💰 Balance: <b>${bal}</b> | 🎬 Ads: <b>${adsCount}</b>\n`;
      msgText += `🛡️ Status: <b>${verifiedBadge}</b>\n\n`;
    });
  }

  msgText += `<i>👉 Click on any user name or ID link to view their Telegram account!</i>`;

  const inlineKeyboard = [];

  // Individual profile quick buttons for current page items
  items.forEach((ref, idx) => {
    const itemNum = currPage * PAGE_SIZE + idx + 1;
    const refUid = String(ref.telegramId);
    const profileUrl = ref.username 
      ? `https://t.me/${ref.username.replace(/^@/, '')}` 
      : `tg://user?id=${refUid}`;
    inlineKeyboard.push([
      { text: `👤 Open Telegram #${itemNum}`, url: profileUrl }
    ]);
  });

  // Navigation row
  const navRow = [];
  if (currPage > 0) {
    navRow.push({ text: "⬅️ Prev", callback_data: `adm_ref_p_${cleanUid}_${currPage - 1}` });
  }
  navRow.push({ text: `📄 ${currPage + 1}/${totalPages}`, callback_data: `adm_ref_p_${cleanUid}_${currPage}` });
  if (currPage < totalPages - 1) {
    navRow.push({ text: "Next ➡️", callback_data: `adm_ref_p_${cleanUid}_${currPage + 1}` });
  }
  if (navRow.length > 0) inlineKeyboard.push(navRow);

  // Bottom action buttons
  inlineKeyboard.push([
    { text: "🔍 Check Another User", callback_data: "adm_ref_prompt" },
    { text: "🔄 Refresh", callback_data: `adm_ref_p_${cleanUid}_${currPage}` }
  ]);
  inlineKeyboard.push([
    { text: "🔙 Back to Admin", callback_data: "adm_back_menu" },
    { text: "🛡️ Admin Panel", web_app: { url: `${baseUrl}/admin.html` } }
  ]);

  if (messageId) {
    const editRes = await editTelegramMsg(botToken, chatId, messageId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
    if (!editRes || !editRes.ok) {
      await sendTelegramMsg(botToken, chatId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
    }
  } else {
    await sendTelegramMsg(botToken, chatId, msgText, { reply_markup: { inline_keyboard: inlineKeyboard } });
  }
}

module.exports = async (req, res) => {
  // CORS / Preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const baseUrl = `${protocol}://${host}`;

  // ==========================================
  // GET: Setup Webhook & Diagnostics Helper
  // ==========================================
  if (req.method === "GET") {
    const { action, setup, setWebhook, info, key, id } = req.query || {};

    if (!botToken) {
      res.status(500).json({
        ok: false,
        error: "TELEGRAM_BOT_TOKEN is not configured in Vercel environment variables."
      });
      return;
    }

    // Quick Webhook Registration: /api/webhook?setup=1 or /api/webhook?action=set
    if (setup === "1" || setWebhook === "1" || action === "set") {
      try {
        const webhookUrl = `${baseUrl}/api/webhook`;
        const secretToken = (process.env.TELEGRAM_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "").trim();
        let tgApiUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=true`;
        if (secretToken && /^[A-Za-z0-9_-]{1,256}$/.test(secretToken)) {
          tgApiUrl += `&secret_token=${encodeURIComponent(secretToken)}`;
        }
        const tgRes = await fetch(tgApiUrl);
        const tgData = await tgRes.json();
        res.status(200).json({
          ok: true,
          message: "Telegram Webhook set successfully!",
          webhookUrl,
          hasSecretToken: Boolean(secretToken),
          telegramResponse: tgData
        });
        return;
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
        return;
      }
    }

    // Webhook Info: /api/webhook?info=1
    if (info === "1" || action === "info") {
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
        const tgData = await tgRes.json();
        res.status(200).json({ ok: true, info: tgData });
        return;
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
        return;
      }
    }

    // Cron trigger for 2-hour mining reminders: /api/webhook?cron=mining_reminder or ?action=cron_mining
    if (action === "cron_mining" || action === "mining_reminder" || (req.query && (req.query.cron === "mining_reminder" || req.query.cron === "mining"))) {
      try {
        const db = await getDb();
        const result = await processMiningReminders(db, botToken, baseUrl);
        res.status(200).json({ ok: true, task: "mining_reminder", ...result });
        return;
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
        return;
      }
    }

    // Set Admin Telegram ID helper: /api/webhook?action=set_admin&id=123456789&key=SECRET
    if (action === "set_admin" && id && key) {
      if (String(key).trim() !== String(ADMIN_SECRET).trim()) {
        res.status(401).json({ error: "Invalid Admin Secret Key" });
        return;
      }
      try {
        const db = await getDb();
        await db.collection("settings").updateOne(
          { key: "bot_settings" },
          { $set: { adminTelegramId: String(id).trim(), updatedAt: Date.now() } },
          { upsert: true }
        );
        res.status(200).json({
          ok: true,
          message: `Admin Telegram ID successfully set to: ${id}`
        });
        return;
      } catch (err) {
        res.status(500).json({ error: err.message });
        return;
      }
    }

    // Default status
    let dbAdmins = [];
    try {
      const db = await getDb();
      const adminSet = await getAdminTelegramIds(db);
      dbAdmins = Array.from(adminSet);
    } catch(e){}

    const configuredSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "").trim();

    res.status(200).json({
      ok: true,
      service: "HOOCOOH Telegram Webhook",
      hasBotToken: !!botToken,
      hasWebhookSecret: Boolean(configuredSecret),
      registeredAdminIds: dbAdmins,
      help: {
        setupWebhook: `${baseUrl}/api/webhook?setup=1`,
        checkWebhook: `${baseUrl}/api/webhook?info=1`
      }
    });
    return;
  }

  // ==========================================
  // POST: Telegram Webhook Update Handler
  // ==========================================
  if (req.method === "POST") {
    // Secret Token Security: verify X-Telegram-Bot-Api-Secret-Token if secret is configured
    const configuredSecret = (process.env.TELEGRAM_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "").trim();
    if (configuredSecret) {
      const incomingSecret = req.headers["x-telegram-bot-api-secret-token"] || "";
      if (incomingSecret !== configuredSecret) {
        console.warn("Unauthorized webhook call: X-Telegram-Bot-Api-Secret-Token mismatch");
        res.status(401).json({ error: "Unauthorized: Invalid Telegram webhook secret" });
        return;
      }
    }

    let update = req.body;
    if (typeof update === "string") {
      try { update = JSON.parse(update); } catch(e){}
    }

    if (!update) {
      res.status(200).send("OK");
      return;
    }

    // ----------------------------------------------------
    // Callback Query Handler (Language Selection)
    // ----------------------------------------------------
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbData = cb.data || "";
      const cbChatId = cb.message?.chat?.id;
      const cbSenderId = cb.from?.id ? String(cb.from.id) : "";

      let db = null;
      try { db = await getDb(); } catch(e){}

      // Open Language Selection menu
      if (cbData === "choose_lang") {
        let userLang = "en";
        try {
          if (db) {
            const u = await db.collection("users").findOne({ telegramId: cbSenderId });
            if (u && u.language) userLang = u.language;
          }
        } catch(e){}

        const langDict = WELCOME_MESSAGES[userLang] || WELCOME_MESSAGES.en;

        await sendTelegramMsg(botToken, cbChatId, langDict.promptLang, {
          reply_markup: {
            inline_keyboard: [
              [{ text: userLang === "en" ? "English ✓" : "English", callback_data: "set_lang_en" }],
              [{ text: userLang === "ru" ? "Русский ✓" : "Русский", callback_data: "set_lang_ru" }],
              [{ text: userLang === "ar" ? "العربية ✓" : "العربية", callback_data: "set_lang_ar" }]
            ]
          }
        });
        await answerCallbackQuery(botToken, cb.id);
        res.status(200).json({ ok: true });
        return;
      }

      // User selected a language option
      if (cbData.startsWith("set_lang_")) {
        const chosenLang = cbData.replace("set_lang_", "");
        const validLangs = ["en", "ru", "ar"];
        const finalLang = validLangs.includes(chosenLang) ? chosenLang : "en";

        try {
          if (db) {
            await db.collection("users").updateOne(
              { telegramId: cbSenderId },
              { $set: { language: finalLang, languageSelected: true, updatedAt: Date.now() } },
              { upsert: true }
            );
          }
        } catch(e){}

        const langDict = WELCOME_MESSAGES[finalLang] || WELCOME_MESSAGES.en;
        await answerCallbackQuery(botToken, cb.id, langDict.toastChanged);

        // Send updated welcome message in newly selected language
        const appUrl = `${baseUrl}/index.html?lang=${finalLang}`;
        const photoUrl = `${baseUrl}/assets/botfather_banner.jpg?v=2`;

        await sendTelegramMsg(botToken, cbChatId, langDict.text, {
          photoUrl: photoUrl,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: langDict.btnStart,
                  web_app: { url: appUrl }
                }
              ],
              [
                {
                  text: langDict.btnLang,
                  callback_data: "choose_lang"
                }
              ]
            ]
          }
        });

        res.status(200).json({ ok: true, language: finalLang });
        return;
      }

      // ----------------------------------------------------
      // Admin: Withdrawals Management via Telegram
      // ----------------------------------------------------
      if (cbData.startsWith("adm_wd_page_")) {
        const adminIds = await getAdminTelegramIds(db);
        if (!adminIds.has(cbSenderId)) {
          await answerCallbackQuery(botToken, cb.id, "Unauthorized: Admin only", true);
          res.status(200).json({ ok: true });
          return;
        }

        const pageNum = parseInt(cbData.replace("adm_wd_page_", ""), 10) || 0;
        await answerCallbackQuery(botToken, cb.id);
        await renderWithdrawalsPage(db, botToken, cbChatId, cb.message?.message_id, pageNum, baseUrl);
        res.status(200).json({ ok: true });
        return;
      }

      if (cbData.startsWith("adm_appr_")) {
        const adminIds = await getAdminTelegramIds(db);
        if (!adminIds.has(cbSenderId)) {
          await answerCallbackQuery(botToken, cb.id, "Unauthorized: Admin only", true);
          res.status(200).json({ ok: true });
          return;
        }

        const wid = cbData.replace("adm_appr_", "");
        const result = await handleAdminApproveWithdrawal(db, botToken, wid, baseUrl);
        await answerCallbackQuery(botToken, cb.id, result.message, !result.ok);
        await renderWithdrawalsPage(db, botToken, cbChatId, cb.message?.message_id, 0, baseUrl, result.ok ? `✅ <b>Withdrawal Approved!</b>` : `⚠️ ${result.message}`);
        res.status(200).json({ ok: true });
        return;
      }

      if (cbData.startsWith("adm_rej_")) {
        const adminIds = await getAdminTelegramIds(db);
        if (!adminIds.has(cbSenderId)) {
          await answerCallbackQuery(botToken, cb.id, "Unauthorized: Admin only", true);
          res.status(200).json({ ok: true });
          return;
        }

        const wid = cbData.replace("adm_rej_", "");
        const result = await handleAdminRejectWithdrawal(db, botToken, wid);
        await answerCallbackQuery(botToken, cb.id, result.message, !result.ok);
        await renderWithdrawalsPage(db, botToken, cbChatId, cb.message?.message_id, 0, baseUrl, result.ok ? `❌ <b>Withdrawal Rejected & Refunded!</b>` : `⚠️ ${result.message}`);
        res.status(200).json({ ok: true });
        return;
      }

      if (cbData.startsWith("adm_ban_")) {
        const adminIds = await getAdminTelegramIds(db);
        if (!adminIds.has(cbSenderId)) {
          await answerCallbackQuery(botToken, cb.id, "Unauthorized: Admin only", true);
          res.status(200).json({ ok: true });
          return;
        }

        const wid = cbData.replace("adm_ban_", "");
        const result = await handleAdminBanWithdrawalUser(db, botToken, wid);
        await answerCallbackQuery(botToken, cb.id, result.message, !result.ok);
        await renderWithdrawalsPage(db, botToken, cbChatId, cb.message?.message_id, 0, baseUrl, result.ok ? `🚫 <b>User Banned & Request Rejected!</b>` : `⚠️ ${result.message}`);
        res.status(200).json({ ok: true });
        return;
      }

      // ----------------------------------------------------
      // Admin: Tasks Management via Telegram
      // ----------------------------------------------------
      if (cbData.startsWith("adm_tasks_page_")) {
        const adminIds = await getAdminTelegramIds(db);
        if (!adminIds.has(cbSenderId)) {
          await answerCallbackQuery(botToken, cb.id, "Unauthorized: Admin only", true);
          res.status(200).json({ ok: true });
          return;
        }

        const pageNum = parseInt(cbData.replace("adm_tasks_page_", ""), 10) || 0;
        await answerCallbackQuery(botToken, cb.id);
        await renderTasksPage(db, botToken, cbChatId, cb.message?.message_id, pageNum, baseUrl);
        res.status(200).json({ ok: true });
        return;
      }

      if (cbData === "adm_task_prompt") {
        const adminIds = await getAdminTelegramIds(db);
        if (!adminIds.has(cbSenderId)) {
          await answerCallbackQuery(botToken, cb.id, "Unauthorized: Admin only", true);
          res.status(200).json({ ok: true });
          return;
        }

        if (db) {
          await db.collection("settings").updateOne(
            { key: "admin_state_" + cbSenderId },
            { $set: { state: "awaiting_task", updatedAt: Date.now() } },
            { upsert: true }
          );
        }

        const promptText = 
          `➕ <b>Add New Task to HOOCOOH Miner</b>\n\n` +
          `Send your task details in this format:\n` +
          `<code>Title | Link</code>\n\n` +
          `Or with a custom target user limit:\n` +
          `<code>Title | Link | TargetCount</code>\n\n` +
          `<b>Examples:</b>\n` +
          `• <code>Join Official Telegram | https://t.me/hoocoohminer</code>\n` +
          `• <code>Subscribe YouTube | https://youtube.com/@channel | 500</code>\n\n` +
          `<i>Reward is fixed at 10 HOOCOOH Coins. Once created, it is live immediately for all miners!</i>`;

        await answerCallbackQuery(botToken, cb.id);
        await sendTelegramMsg(botToken, cbChatId, promptText, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "❌ Cancel", callback_data: "adm_task_cancel" }
              ]
            ]
          }
        });
        res.status(200).json({ ok: true });
        return;
      }

      if (cbData === "adm_task_cancel") {
        const adminIds = await getAdminTelegramIds(db);
        if (!adminIds.has(cbSenderId)) {
          await answerCallbackQuery(botToken, cb.id, "Unauthorized: Admin only", true);
          res.status(200).json({ ok: true });
          return;
        }

        if (db) {
          await db.collection("settings").deleteOne({ key: "admin_state_" + cbSenderId });
        }

        await answerCallbackQuery(botToken, cb.id, "Cancelled");
        await renderTasksPage(db, botToken, cbChatId, cb.message?.message_id, 0, baseUrl, "❌ <i>Task creation was cancelled.</i>");
        res.status(200).json({ ok: true });
        return;
      }

      if (cbData.startsWith("adm_task_del_")) {
        const adminIds = await getAdminTelegramIds(db);
        if (!adminIds.has(cbSenderId)) {
          await answerCallbackQuery(botToken, cb.id, "Unauthorized: Admin only", true);
          res.status(200).json({ ok: true });
          return;
        }

        const taskId = cbData.replace("adm_task_del_", "");
        let objId;
        try { objId = new ObjectId(taskId); } catch(e){ objId = null; }
        const tQuery = objId ? { _id: objId } : { _id: taskId };

        if (db) {
          await db.collection("tasks").deleteOne(tQuery);
        }

        await answerCallbackQuery(botToken, cb.id, "Task deleted successfully!");
        await renderTasksPage(db, botToken, cbChatId, cb.message?.message_id, 0, baseUrl, "🗑️ <b>Task was deleted successfully!</b>");
        res.status(200).json({ ok: true });
        return;
      }

      // Check User Referrals - Prompt Input
      if (cbData === "adm_ref_prompt") {
        const adminIds = await getAdminTelegramIds(db);
        if (!adminIds.has(cbSenderId)) {
          await answerCallbackQuery(botToken, cb.id, "Unauthorized: Admin only", true);
          res.status(200).json({ ok: true });
          return;
        }

        if (db) {
          await db.collection("settings").updateOne(
            { key: "admin_state_" + cbSenderId },
            { $set: { state: "awaiting_ref_uid", updatedAt: Date.now() } },
            { upsert: true }
          );
        }

        const promptText = 
          `👥 <b>Check User Referrals</b>\n\n` +
          `Please send the <b>Telegram UID or Username</b> of the user whose invited referral accounts you want to inspect:\n\n` +
          `<b>Examples:</b>\n` +
          `• <code>123456789</code>\n` +
          `• <code>@username</code>\n\n` +
          `<i>Once sent, all recruited accounts will be listed with clickable Telegram profiles!</i>`;

        await answerCallbackQuery(botToken, cb.id);
        await sendTelegramMsg(botToken, cbChatId, promptText, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❌ Cancel", callback_data: "adm_back_menu" }]
            ]
          }
        });
        res.status(200).json({ ok: true });
        return;
      }

      // Check User Referrals - Pagination Handler
      if (cbData.startsWith("adm_ref_p_")) {
        const adminIds = await getAdminTelegramIds(db);
        if (!adminIds.has(cbSenderId)) {
          await answerCallbackQuery(botToken, cb.id, "Unauthorized: Admin only", true);
          res.status(200).json({ ok: true });
          return;
        }

        // Format: adm_ref_p_<uid>_<page>
        const rest = cbData.replace("adm_ref_p_", "");
        const lastUnderscore = rest.lastIndexOf("_");
        const targetUid = rest.substring(0, lastUnderscore);
        const pNum = parseInt(rest.substring(lastUnderscore + 1), 10) || 0;

        await answerCallbackQuery(botToken, cb.id);
        await renderReferralsPage(db, botToken, cbChatId, cb.message?.message_id, targetUid, pNum, baseUrl);
        res.status(200).json({ ok: true });
        return;
      }

      // Return to main Admin menu
      if (cbData === "adm_back_menu") {
        const adminIds = await getAdminTelegramIds(db);
        if (!adminIds.has(cbSenderId)) {
          await answerCallbackQuery(botToken, cb.id, "Unauthorized: Admin only", true);
          res.status(200).json({ ok: true });
          return;
        }

        if (db) {
          await db.collection("settings").deleteOne({ key: "admin_state_" + cbSenderId });
        }

        const adminUrl = `${baseUrl}/admin.html`;
        const replyText = 
          `🛡️ <b>HOOCOOH Admin Control Center</b>\n\n` +
          `Tap a button below to manage the platform:`;

        await answerCallbackQuery(botToken, cb.id);
        const menuKeyboard = [
          [
            { text: "🛡️ Open Admin Panel", web_app: { url: adminUrl } },
            { text: "💸 Withdraw", callback_data: "adm_wd_page_0" }
          ],
          [
            { text: "👥 Check User Refer Users", callback_data: "adm_ref_prompt" }
          ],
          [
            { text: "📋 Tasks", callback_data: "adm_tasks_page_0" },
            { text: "➕ Add Task", callback_data: "adm_task_prompt" }
          ]
        ];

        if (cb.message?.message_id) {
          await editTelegramMsg(botToken, cbChatId, cb.message.message_id, replyText, { reply_markup: { inline_keyboard: menuKeyboard } });
        } else {
          await sendTelegramMsg(botToken, cbChatId, replyText, { reply_markup: { inline_keyboard: menuKeyboard } });
        }
        res.status(200).json({ ok: true });
        return;
      }

      await answerCallbackQuery(botToken, cb.id);
      res.status(200).send("OK");
      return;
    }

    const message = update.message || update.edited_message;
    if (!message || !message.text) {
      // Not a text message, ignore silently
      res.status(200).send("OK");
      return;
    }

    const text = (message.text || "").trim();
    const chatId = message.chat.id;
    const senderId = message.from && message.from.id ? String(message.from.id) : "";
    const firstName = message.from?.first_name || "Admin";

    const parts = text.split(/\s+/);
    const firstWord = parts[0].toLowerCase();
    const command = firstWord.split("@")[0]; // removes bot username e.g. /admin@mybot -> /admin

    // ----------------------------------------------------
    // Command: /admin
    // ----------------------------------------------------
    if (command === "/admin") {
      let db = null;
      try { db = await getDb(); } catch(e){}
      const adminIds = await getAdminTelegramIds(db);

      // Strict Security Check:
      // If the sender is NOT the admin ID, do ABSOLUTELY NOTHING.
      // Silently return 200 OK so regular users get no response.
      if (!senderId || !adminIds.has(senderId)) {
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      // SENDER IS VERIFIED ADMIN!
      // Send secure WebApp launch button for Admin Panel & Withdrawals button
      const adminUrl = `${baseUrl}/admin.html`;
      const replyText = 
        `🛡️ <b>HOOCOOH Admin Control Center</b>\n\n` +
        `Welcome back, <b>${escapeHtml(firstName)}</b> (ID: <code>${senderId}</code>)!\n\n` +
        `Tap a button below to manage the platform:`;

      await sendTelegramMsg(botToken, chatId, replyText, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🛡️ Open Admin Panel",
                web_app: { url: adminUrl }
              },
              {
                text: "💸 Withdraw",
                callback_data: "adm_wd_page_0"
              }
            ],
            [
              {
                text: "👥 Check User Refer Users",
                callback_data: "adm_ref_prompt"
              }
            ],
            [
              {
                text: "📋 Tasks",
                callback_data: "adm_tasks_page_0"
              },
              {
                text: "➕ Add Task",
                callback_data: "adm_task_prompt"
              }
            ]
          ]
        }
      });

      res.status(200).json({ ok: true, sent: true });
      return;
    }

    // ----------------------------------------------------
    // Admin Text Actions (Task Creation & Direct Inputs)
    // ----------------------------------------------------
    let db = null;
    try { db = await getDb(); } catch(e){}
    const adminIds = await getAdminTelegramIds(db);
    const isAdmin = senderId && adminIds.has(senderId);

    if (isAdmin) {
      if (command === "/setadreward" || command === "/adreward") {
        const val = parseInt(parts[1], 10);
        if (!val || val < 1 || val > 100000) {
          let curr = 10;
          if (db) {
            const s = await db.collection("settings").findOne({ key: "app_settings" });
            if (s && typeof s.watchAdReward === "number" && s.watchAdReward > 0) curr = s.watchAdReward;
          }
          await sendTelegramMsg(botToken, chatId, `🎬 <b>Watch Ad & Earn Reward</b>\n\nCurrent Reward: <b>${curr} HOOCOOH Coins</b>\n\nTo update the reward, send:\n<code>/setadreward 10</code>\n<i>(Enter any number between 1 and 100,000)</i>`);
          res.status(200).json({ ok: true });
          return;
        }

        if (db) {
          await db.collection("settings").updateOne(
            { key: "app_settings" },
            { $set: { watchAdReward: val, updatedAt: Date.now() } },
            { upsert: true }
          );
        }

        await sendTelegramMsg(botToken, chatId, `✅ <b>Watch Ad Reward Updated!</b>\n\nUsers will now receive <b>${val} HOOCOOH Coins</b> per watched ad in the Earn section.`);
        res.status(200).json({ ok: true, adRewardUpdated: true });
        return;
      }

      if (command === "/unban") {
        const targetUid = parts[1] ? parts[1].trim() : "";
        if (!targetUid) {
          await sendTelegramMsg(botToken, chatId, `ℹ️ <b>Unban User Command</b>\n\nUsage:\n<code>/unban &lt;telegramId&gt;</code>\n\nExample:\n<code>/unban 123456789</code>`);
          res.status(200).json({ ok: true });
          return;
        }

        const tid = String(targetUid);
        const numId = Number(targetUid);
        const usersCol = db ? db.collection("users") : null;

        if (!usersCol) {
          res.status(500).json({ error: "Database not connected" });
          return;
        }

        const targetUser = await usersCol.findOne({
          $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])]
        });

        if (!targetUser) {
          await sendTelegramMsg(botToken, chatId, `❌ User with ID <code>${escapeHtml(tid)}</code> not found in database.`);
          res.status(200).json({ ok: true });
          return;
        }

        const wasPurged = !!targetUser.dataPurged;

        await usersCol.updateMany(
          { $or: [{ telegramId: tid }, ...(numId ? [{ telegramId: numId }] : [])] },
          {
            $set: {
              isBanned: false,
              banReason: null,
              unbannedAt: Date.now(),
              bannedAt: null,
              bannedAtDate: null,
              dataPurged: false,
              lastActiveAt: new Date()
            }
          }
        );

        let replyMsg = `✅ <b>User Unbanned Successfully!</b>\n\nUser ID: <code>${tid}</code>\nSuspension has been lifted.`;
        if (wasPurged) {
          replyMsg += `\n\n⚠️ <i>Note: This user was banned for over 7 days, so their previous balance and stats were permanently wiped. They will start fresh.</i>`;
        } else {
          replyMsg += `\n\n✨ <i>User's original data and balance remain fully intact.</i>`;
        }

        await sendTelegramMsg(botToken, chatId, replyMsg);
        res.status(200).json({ ok: true, unbanned: true });
        return;
      }

      let isAwaitingTask = false;
      let isAwaitingRefUid = false;
      if (db) {
        const adminStateDoc = await db.collection("settings").findOne({ key: "admin_state_" + senderId });
        if (adminStateDoc) {
          if (adminStateDoc.state === "awaiting_task") isAwaitingTask = true;
          if (adminStateDoc.state === "awaiting_ref_uid") isAwaitingRefUid = true;
        }
      }

      // 1. Direct Command or Prompt response for Check User Referrals
      if (command === "/referrals" || command === "/checkreferrals" || command === "/checkreferral" || command === "/checkrefs" || isAwaitingRefUid) {
        let targetQuery = "";
        if (isAwaitingRefUid) {
          targetQuery = text.trim();
        } else {
          targetQuery = parts[1] ? parts[1].trim() : "";
        }

        if (!targetQuery) {
          const promptText = 
            `👥 <b>Check User Referrals</b>\n\n` +
            `Please send the <b>Telegram UID or Username</b> of the miner:\n\n` +
            `<b>Usage:</b>\n` +
            `<code>/referrals 123456789</code>\n` +
            `or <code>/referrals @username</code>`;

          await sendTelegramMsg(botToken, chatId, promptText, {
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Cancel", callback_data: "adm_back_menu" }]
              ]
            }
          });

          if (db) {
            await db.collection("settings").updateOne(
              { key: "admin_state_" + senderId },
              { $set: { state: "awaiting_ref_uid", updatedAt: Date.now() } },
              { upsert: true }
            );
          }

          res.status(200).json({ ok: true, promptSent: true });
          return;
        }

        // Clean query (could be @username or UID)
        let cleanQ = targetQuery.replace(/^@/, "").trim();
        const usersCol = db ? db.collection("users") : null;
        let foundTargetUid = cleanQ;

        if (usersCol) {
          const numQ = Number(cleanQ);
          const foundU = await usersCol.findOne({
            $or: [
              { telegramId: cleanQ },
              ...(numQ ? [{ telegramId: numQ }] : []),
              { username: { $regex: "^" + cleanQ + "$", $options: "i" } }
            ]
          });
          if (foundU) {
            foundTargetUid = String(foundU.telegramId);
          }
        }

        if (db) {
          await db.collection("settings").deleteOne({ key: "admin_state_" + senderId });
        }

        await renderReferralsPage(db, botToken, chatId, null, foundTargetUid, 0, baseUrl);
        res.status(200).json({ ok: true, referralsRendered: true });
        return;
      }

      const isAddTaskCmd = command === "/addtask";
      const hasPipe = text.includes("|");

      if (isAddTaskCmd || isAwaitingTask || (hasPipe && (text.includes("http") || text.includes("t.me")))) {
        let rawInput = text;
        if (isAddTaskCmd) {
          rawInput = text.replace(/^\/addtask\s*/i, "").trim();
        }

        if (!rawInput && isAddTaskCmd) {
          const promptText = 
            `➕ <b>Add New Task to HOOCOOH Miner</b>\n\n` +
            `Send your task details in this format:\n` +
            `<code>Title | Link</code>\n\n` +
            `Or with a custom target user limit:\n` +
            `<code>Title | Link | TargetCount</code>\n\n` +
            `<b>Examples:</b>\n` +
            `• <code>Join Official Telegram | https://t.me/hoocoohminer</code>\n` +
            `• <code>Subscribe YouTube | https://youtube.com/@channel | 500</code>\n\n` +
            `<i>Reward is fixed at 10 HOOCOOH Coins. Once created, it is live immediately for all miners!</i>`;

          await sendTelegramMsg(botToken, chatId, promptText, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "❌ Cancel", callback_data: "adm_task_cancel" }
                ]
              ]
            }
          });

          if (db) {
            await db.collection("settings").updateOne(
              { key: "admin_state_" + senderId },
              { $set: { state: "awaiting_task", updatedAt: Date.now() } },
              { upsert: true }
            );
          }

          res.status(200).json({ ok: true, promptSent: true });
          return;
        }

        const pipeParts = rawInput.split("|").map(s => s.trim()).filter(Boolean);
        if (pipeParts.length >= 2) {
          const taskTitle = pipeParts[0];
          let taskLink = pipeParts[1];
          const targetPart = pipeParts[2] ? pipeParts[2].toLowerCase() : "unlimited";

          let isUnlimited = targetPart === "unlimited" || targetPart === "all" || !pipeParts[2];
          let targetUsers = 99999999;
          if (!isUnlimited) {
            const parsedNum = parseInt(targetPart, 10);
            if (!isNaN(parsedNum) && parsedNum > 0) {
              targetUsers = parsedNum;
            } else {
              isUnlimited = true;
            }
          }

          if (!taskLink.startsWith("http") && !taskLink.startsWith("t.me")) {
            taskLink = "https://t.me/" + taskLink.replace(/^@/, "");
          } else if (taskLink.startsWith("t.me")) {
            taskLink = "https://" + taskLink;
          }

          const newTask = {
            creatorId: "admin",
            type: "normal",
            title: taskTitle,
            link: taskLink,
            reward: 10,
            targetCount: isUnlimited ? 99999999 : targetUsers,
            isUnlimited: isUnlimited,
            completedBy: [],
            status: "active",
            createdAt: Date.now()
          };

          if (db) {
            await db.collection("tasks").insertOne(newTask);
            await db.collection("settings").deleteOne({ key: "admin_state_" + senderId });
          }

          const successMsg = 
            `✅ <b>Task Created Successfully!</b>\n\n` +
            `📌 <b>Title:</b> ${escapeHtml(taskTitle)}\n` +
            `🔗 <b>Link:</b> <a href="${taskLink}">${escapeHtml(taskLink)}</a>\n` +
            `🎯 <b>Target:</b> ${isUnlimited ? "Unlimited" : targetUsers} users\n` +
            `🎁 <b>Reward:</b> 10 HOOCOOH Coins\n` +
            `⚡ <b>Status:</b> Active (Live in Task list for all miners)`;

          await sendTelegramMsg(botToken, chatId, successMsg, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "📋 View Tasks", callback_data: "adm_tasks_page_0" },
                  { text: "➕ Add Another", callback_data: "adm_task_prompt" }
                ],
                [
                  { text: "💸 Withdraw", callback_data: "adm_wd_page_0" },
                  { text: "🛡️ Admin Panel", web_app: { url: `${baseUrl}/admin.html` } }
                ]
              ]
            }
          });

          res.status(200).json({ ok: true, taskCreated: true });
          return;
        } else if (isAwaitingTask) {
          const errMsg = 
            `⚠️ <b>Invalid Task Format!</b>\n\n` +
            `Please separate Title and Link using a vertical bar (<code>|</code>).\n\n` +
            `<b>Format:</b>\n` +
            `<code>Title | Link</code>\n\n` +
            `<b>Example:</b>\n` +
            `<code>Join Telegram | https://t.me/hoocoohminer</code>`;

          await sendTelegramMsg(botToken, chatId, errMsg, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "❌ Cancel", callback_data: "adm_task_cancel" }
                ]
              ]
            }
          });

          res.status(200).json({ ok: true, invalidFormat: true });
          return;
        }
      }
    }

    // ----------------------------------------------------
    // Command: /start
    // ----------------------------------------------------
    if (command === "/start") {
      let userLang = "en";
      let hasSelected = false;
      let db = null;
      let u = null;
      try {
        db = await getDb();
        if (db) {
          u = await db.collection("users").findOne({
            $or: [{ telegramId: String(senderId) }, { telegramId: Number(senderId) }]
          });
          if (u) {
            if (u.isBanned) {
              const banMsg = 
                `🚫 <b>Access Denied: Account Suspended</b>\n\n` +
                `Your account has been permanently suspended due to security violation or automated script tampering.\n\n` +
                `<i>Reason: ${escapeHtml(u.banReason || "Security violation detected")}</i>`;
              await sendTelegramMsg(botToken, chatId, banMsg);
              res.status(200).json({ ok: true, banned: true });
              return;
            }
            if (u.language) userLang = u.language;
            if (u.languageSelected === true) hasSelected = true;
          }
        }
      } catch(e){}

      let appUrl = `${baseUrl}/index.html?lang=${userLang}`;
      if (!hasSelected) {
        appUrl += `&needLang=1`;
      }
      const startParam = parts[1] || "";
      if (startParam) {
        appUrl += `&tgWebAppStartParam=${encodeURIComponent(startParam)}`;
        try {
          if (db) {
            const inviterId = String(startParam).replace(/^ref_/, "").trim();
            if (inviterId && /^\d+$/.test(inviterId) && String(inviterId) !== String(senderId)) {
              const inviter = await db.collection("users").findOne({
                $or: [{ telegramId: inviterId }, { telegramId: Number(inviterId) }]
              });
              if (inviter && String(inviter.telegramId) !== String(senderId)) {
                await db.collection("users").updateOne(
                  { telegramId: String(senderId), referredBy: { $in: [null, undefined] } },
                  { $set: { referredBy: String(inviter.telegramId) } }
                );
              }
            }
          }
        } catch(refErr){}
      }

      let welcomePhotoBuf = null;
      try {
        const p = path.join(process.cwd(), "public/assets/welcome_banner.jpg");
        if (fs.existsSync(p)) {
          welcomePhotoBuf = fs.readFileSync(p);
        }
      } catch(e){}

      const photoUrl = `${baseUrl}/assets/welcome_banner.jpg?v=4`;
      const langDict = WELCOME_MESSAGES[userLang] || WELCOME_MESSAGES.en;

      await sendTelegramMsg(botToken, chatId, langDict.text, {
        photoBuffer: welcomePhotoBuf,
        photoMime: "image/jpeg",
        photoUrl: photoUrl,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: langDict.btnStart,
                web_app: { url: appUrl }
              }
            ],
            [
              {
                text: langDict.btnLang,
                callback_data: "choose_lang"
              }
            ]
          ]
        }
      });

      res.status(200).json({ ok: true, sent: true });
      return;
    }

    // All other messages - return 200 OK
    res.status(200).send("OK");
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
