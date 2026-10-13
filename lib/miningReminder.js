const { MINE_INTERVAL_MS } = require("./gameLogic");
const { processBroadcastQueue } = require("./broadcastQueue");

const SPIN_CYCLE_MS = 10 * 60 * 60 * 1000; // 10 hours

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getBaseUrl(providedUrl) {
  if (providedUrl && typeof providedUrl === "string" && providedUrl.startsWith("http")) {
    return providedUrl.replace(/\/+$/, "");
  }
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://hoocooh-miner.vercel.app";
}

async function sendTelegramMsg(botToken, chatId, text, options = {}) {
  if (!botToken || !chatId) return false;
  try {
    const basePayload = {
      chat_id: String(chatId),
      parse_mode: "HTML",
      disable_web_page_preview: false,
      text: text
    };

    if (options.reply_markup) {
      basePayload.reply_markup = options.reply_markup;
    }

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload)
    });
    return await res.json();
  } catch (e) {
    console.error("sendTelegramMsg error:", e.message);
    return null;
  }
}

/**
 * Send congratulations message to inviter when a recruited friend joins and completes verification
 * Includes "⛏️ Open HOOCOOH Mine" WebApp button as requested
 */
async function notifyInviterReferralSuccess(botToken, inviter, recruitUser, customBaseUrl) {
  if (!botToken || !inviter || !inviter.telegramId || !recruitUser) return false;
  try {
    const rawFirst = (recruitUser.firstName || recruitUser.first_name || "").trim();
    const rawLast = (recruitUser.lastName || recruitUser.last_name || "").trim();
    const fullName = (rawFirst + (rawLast ? " " + rawLast : "")).trim();

    const cleanUsername = recruitUser.username ? String(recruitUser.username).replace(/^@/, "").trim() : "";
    const recruitUid = String(recruitUser.telegramId || recruitUser.id || "").trim();

    // Telegram profile link: opens profile and shows user ID
    const profileUrl = cleanUsername
      ? `https://t.me/${cleanUsername}`
      : (recruitUid ? `tg://user?id=${recruitUid}` : "");

    let userLinkHtml = "";

    if (fullName) {
      // User has a name: ONLY the name part is written as a clickable link
      const escapedName = escapeHtml(fullName);
      userLinkHtml = profileUrl ? `<a href="${profileUrl}">${escapedName}</a>` : `<b>${escapedName}</b>`;
    } else if (cleanUsername) {
      // No name, but has username: link the username
      userLinkHtml = profileUrl ? `<a href="${profileUrl}">@${escapeHtml(cleanUsername)}</a>` : `@${escapeHtml(cleanUsername)}`;
    } else {
      // No name: normally just show their UID
      const uidText = recruitUid || "Unknown";
      userLinkHtml = profileUrl ? `<a href="${profileUrl}">UID: ${uidText}</a>` : `UID: <code>${uidText}</code>`;
    }

    const inviterLang = inviter.language || "en";

    let msg = `🎉 <b>Congratulations!</b>\n\n${userLinkHtml} joined the bot using your referral link!\n\nYou got <b>+100 HOOCOOH Coins</b> 🪙.`;

    if (inviterLang === "ru") {
      msg = `🎉 <b>Поздравляем!</b>\n\n${userLinkHtml} присоединился к боту по вашей реферальной ссылке!\n\nВы получили <b>+100 HOOCOOH Coins</b> 🪙.`;
    } else if (inviterLang === "ar") {
      msg = `🎉 <b>تهانينا!</b>\n\nانضم ${userLinkHtml} إلى البوت باستخدام رابط الإحالة الخاص بك!\n\nلقد حصلت على <b>+100 عملة HOOCOOH</b> 🪙.`;
    }

    const base = getBaseUrl(customBaseUrl);
    const appUrl = `${base}/index.html?lang=${inviterLang}`;

    return await sendTelegramMsg(botToken, inviter.telegramId, msg, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⛏️ Open HOOCOOH Mine",
              web_app: { url: appUrl }
            }
          ]
        ]
      }
    });
  } catch (err) {
    console.warn("notifyInviterReferralSuccess warning:", err.message);
    return null;
  }
}

/**
 * High-Scale Serverless-Safe Reminder Processor:
 * Designed to handle 100,000+ (1 lakh+) users smoothly without Vercel timeout errors:
 * - Time-budget guard: Caps total execution to 6.5s (Vercel max is 10s on Hobby).
 * - Chunking: Processes users in controlled batches with rate limiting.
 * - MongoDB compound indexing: Ensures ultra-fast queries even with 100k+ users.
 * - Error isolation: Dead/blocked accounts are flagged to avoid repeated retries.
 * - Handles both 2-hour mining reminders and 10-hour spin ticket reloads.
 * - All broadcast messages include the "⛏️ Open HOOCOOH Mine" WebApp button.
 */
let indexEnsured = false;

async function processMiningReminders(db, botToken, baseUrl) {
  if (!db || !botToken) return { processed: 0, sent: 0, hasMore: false };
  const usersCol = db.collection("users");
  const base = getBaseUrl(baseUrl);

  // Compound indexes for fast queries over 100,000+ documents
  if (!indexEnsured) {
    usersCol.createIndex({
      lastMineCollectedAt: 1,
      mineReminderSent: 1,
      isBotBlocked: 1
    }).catch(() => {});
    usersCol.createIndex({
      spinCycleCompletedAt: 1,
      spinReminderSent: 1,
      isBotBlocked: 1
    }).catch(() => {});
    indexEnsured = true;
  }

  const startTime = Date.now();
  const TIME_BUDGET_MS = 6500; // 6.5s hard limit for Vercel Hobby plan
  const now = Date.now();
  const cutoffMineTime = now - MINE_INTERVAL_MS; // 2 hours ago
  const cutoffSpinTime = now - SPIN_CYCLE_MS;     // 10 hours ago

  // 0. Process any active Admin Broadcast queued for Cron-Job.org delivery
  const broadcastResult = await processBroadcastQueue(db, botToken, 3800);

  let totalProcessed = 0;
  let totalSent = 0;
  let hasMore = Boolean(broadcastResult && broadcastResult.active && !broadcastResult.completed);

  // 1. Process 2-hour Mining Reminders
  while (Date.now() - startTime < TIME_BUDGET_MS) {
    const remainingTime = TIME_BUDGET_MS - (Date.now() - startTime);
    if (remainingTime < 800) break;

    const mineBatch = await usersCol.find({
      telegramId: { $exists: true, $ne: null },
      lastMineCollectedAt: { $exists: true, $ne: null, $lte: cutoffMineTime },
      mineReminderSent: { $ne: true },
      isBotBlocked: { $ne: true }
    })
    .project({ _id: 1, telegramId: 1, language: 1 })
    .limit(20)
    .toArray();

    if (!mineBatch || mineBatch.length === 0) {
      break;
    }

    if (mineBatch.length === 20) {
      hasMore = true;
    }

    // Process chunk with concurrency of 5
    for (let i = 0; i < mineBatch.length; i += 5) {
      if (Date.now() - startTime >= TIME_BUDGET_MS) break;

      const chunk = mineBatch.slice(i, i + 5);
      await Promise.all(chunk.map(async (user) => {
        totalProcessed++;
        const userLang = user.language || "en";
        const appUrl = `${base}/index.html?lang=${userLang}`;

        let msgText =
          `⏰ <b>Don't forget!</b>\n\n` +
          `Your HOOCOOH is waiting to dive ⛏️\n` +
          `Log in now and collect your daily mining reward!`;

        if (userLang === "ru") {
          msgText =
            `⏰ <b>Не забудьте!</b>\n\n` +
            `Ваш HOOCOOH готов к добыче ⛏️\n` +
            `Войдите сейчас и заберите свою награду за майнинг!`;
        } else if (userLang === "ar") {
          msgText =
            `⏰ <b>لا تنسَ!</b>\n\n` +
            `تعدين HOOCOOH الخاص بك جاهز ⛏️\n` +
            `سجل الدخول الآن واجمع مكافأة التعدين الخاصة بك!`;
        }

        const btnText = "⛏️ Open HOOCOOH Mine";

        try {
          const res = await sendTelegramMsg(botToken, user.telegramId, msgText, {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: btnText,
                    web_app: { url: appUrl }
                  }
                ]
              ]
            }
          });

          if (res && res.ok) {
            totalSent++;
            await usersCol.updateOne(
              { _id: user._id },
              { $set: { mineReminderSent: true, lastMineReminderSentAt: Date.now() } }
            );
          } else {
            const isBlocked = res && (res.error_code === 403 || String(res.description).includes("blocked") || String(res.description).includes("deactivated"));
            await usersCol.updateOne(
              { _id: user._id },
              { $set: { mineReminderSent: true, isBotBlocked: Boolean(isBlocked), lastMineReminderSentAt: Date.now() } }
            );
          }
        } catch (err) {
          await usersCol.updateOne(
            { _id: user._id },
            { $set: { mineReminderSent: true, lastMineReminderSentAt: Date.now() } }
          );
        }
      }));

      // Short delay between chunks to respect Telegram rate limits
      await new Promise(r => setTimeout(r, 60));
    }
  }

  // 2. Process 10-hour Spin Tickets Reload Reminders
  while (Date.now() - startTime < TIME_BUDGET_MS) {
    const remainingTime = TIME_BUDGET_MS - (Date.now() - startTime);
    if (remainingTime < 800) break;

    const spinBatch = await usersCol.find({
      telegramId: { $exists: true, $ne: null },
      spinCycleCompletedAt: { $exists: true, $ne: null, $lte: cutoffSpinTime },
      spinReminderSent: { $ne: true },
      isBotBlocked: { $ne: true }
    })
    .project({ _id: 1, telegramId: 1, language: 1 })
    .limit(20)
    .toArray();

    if (!spinBatch || spinBatch.length === 0) {
      break;
    }

    if (spinBatch.length === 20) {
      hasMore = true;
    }

    for (let i = 0; i < spinBatch.length; i += 5) {
      if (Date.now() - startTime >= TIME_BUDGET_MS) break;

      const chunk = spinBatch.slice(i, i + 5);
      await Promise.all(chunk.map(async (user) => {
        totalProcessed++;
        const userLang = user.language || "en";
        const appUrl = `${base}/index.html?lang=${userLang}`;

        let spinMsg =
          `🎟️ <b>Spin Tickets Are Ready!</b> 🎡\n\n` +
          `Your 6 free spin tickets have reloaded!\n` +
          `Spin the wheel now to win HOOCOOH Coins and big rewards! 🚀`;

        if (userLang === "ru") {
          spinMsg =
            `🎟️ <b>Билеты на спин готовы!</b> 🎡\n\n` +
            `Ваши 6 бесплатных билетов снова доступны!\n` +
            `Вращайте колесо фортуны и выигрывайте монеты HOOCOOH! 🚀`;
        } else if (userLang === "ar") {
          spinMsg =
            `🎟️ <b>تذاكر العجلة الدوارة جاهزة!</b> 🎡\n\n` +
            `تم تجديد 6 تذاكر مجانية لك!\n` +
            `قم بتدوير العجلة الآن واربح عملات HOOCOOH وجوائز رائعة! 🚀`;
        }

        const btnText = "⛏️ Open HOOCOOH Mine";

        try {
          const res = await sendTelegramMsg(botToken, user.telegramId, spinMsg, {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: btnText,
                    web_app: { url: appUrl }
                  }
                ]
              ]
            }
          });

          if (res && res.ok) {
            totalSent++;
            await usersCol.updateOne(
              { _id: user._id },
              {
                $set: {
                  spinReminderSent: true,
                  lastSpinReminderSentAt: Date.now(),
                  spinAdsWatchedToday: 0
                }
              }
            );
          } else {
            const isBlocked = res && (res.error_code === 403 || String(res.description).includes("blocked") || String(res.description).includes("deactivated"));
            await usersCol.updateOne(
              { _id: user._id },
              {
                $set: {
                  spinReminderSent: true,
                  isBotBlocked: Boolean(isBlocked),
                  lastSpinReminderSentAt: Date.now(),
                  spinAdsWatchedToday: 0
                }
              }
            );
          }
        } catch (err) {
          await usersCol.updateOne(
            { _id: user._id },
            {
              $set: {
                spinReminderSent: true,
                lastSpinReminderSentAt: Date.now(),
                spinAdsWatchedToday: 0
              }
            }
          );
        }
      }));

      await new Promise(r => setTimeout(r, 60));
    }
  }

  return {
    processed: totalProcessed,
    sent: totalSent,
    hasMore,
    broadcast: broadcastResult,
    executionMs: Date.now() - startTime
  };
}

module.exports = {
  processMiningReminders,
  notifyInviterReferralSuccess,
  sendTelegramMsg,
  getBaseUrl
};
