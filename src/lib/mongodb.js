const { MongoClient } = require("mongodb");

let cachedClient = global._hoocoohMongoClient;
let cachedDb = global._hoocoohMongoDb;

let indexesEnsured = false;

async function safeCreateTTLIndex(col, spec, options) {
  try {
    await col.createIndex(spec, options);
  } catch (err) {
    if (err.codeName === "IndexOptionsConflict" || (err.message && err.message.includes("already exists with different options"))) {
      try {
        if (options && options.name) {
          await col.dropIndex(options.name);
          await col.createIndex(spec, options);
        }
      } catch(e){}
    }
  }
}

async function ensureIndexes(db) {
  if (indexesEnsured) return;
  indexesEnsured = true;

  try {
    const usersCol = db.collection("users");
    const tokensCol = db.collection("captcha_tokens");
    const challengesCol = db.collection("captcha_challenges");
    const codesCol = db.collection("user_verification_codes");
    const withdrawalsCol = db.collection("withdrawals");
    const tasksCol = db.collection("tasks");

    // 1. Users: fast query on telegramId, leaderboard sorting & 60-day (2 months = 5,184,000s) Inactivity TTL
    usersCol.createIndex({ telegramId: 1 }).catch(() => {});
    usersCol.createIndex({ totalMinedCoins: -1, minerLevel: -1 }).catch(() => {});
    usersCol.createIndex({ recruitsCount: -1 }).catch(() => {});
    await safeCreateTTLIndex(
      usersCol,
      { lastActiveAt: 1 },
      { expireAfterSeconds: 60 * 24 * 60 * 60, name: "ttl_users_inactivity_60d" }
    );

    // 2. Captcha Tokens: 10-Minute TTL to prevent storage explosion on 100k users
    await safeCreateTTLIndex(
      tokensCol,
      { createdAtDate: 1 },
      { expireAfterSeconds: 600, name: "ttl_captcha_tokens_10m" }
    );
    tokensCol.createIndex({ token: 1 }).catch(() => {});

    // 3. Captcha Challenges: 10-Minute TTL
    await safeCreateTTLIndex(
      challengesCol,
      { createdAtDate: 1 },
      { expireAfterSeconds: 600, name: "ttl_captcha_challenges_10m" }
    );
    challengesCol.createIndex({ challengeId: 1 }).catch(() => {});

    // 4. Verification Codes: 1-Hour TTL
    await safeCreateTTLIndex(
      codesCol,
      { createdAtDate: 1 },
      { expireAfterSeconds: 3600, name: "ttl_verification_codes_1h" }
    );
    codesCol.createIndex({ userId: 1, used: 1 }).catch(() => {});

    // 5. Withdrawals Collection Indexes
    withdrawalsCol.createIndex({ telegramId: 1, status: 1 }).catch(() => {});
    withdrawalsCol.createIndex({ status: 1, createdAt: -1 }).catch(() => {});

    // 6. Tasks Collection Indexes
    tasksCol.createIndex({ status: 1, createdAt: -1 }).catch(() => {});

  } catch (err) {
    console.warn("MongoDB ensureIndexes warning (non-fatal):", err.message);
  }
}

async function getDb() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "hoocooh_mine";

  if (!uri) {
    throw new Error("MONGODB_URI is not set in Vercel environment variables");
  }

  if (cachedDb) return cachedDb;

  if (!cachedClient) {
    cachedClient = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
    });
    global._hoocoohMongoClient = cachedClient;
  }

  try {
    await cachedClient.connect();
    cachedDb = cachedClient.db(dbName);
    global._hoocoohMongoDb = cachedDb;
    ensureIndexes(cachedDb).catch(() => {});
    return cachedDb;
  } catch (err) {
    // If cached client had stale connection, recreate and connect
    console.warn("Re-establishing MongoDB connection...", err.message);
    cachedClient = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
    });
    global._hoocoohMongoClient = cachedClient;
    await cachedClient.connect();
    cachedDb = cachedClient.db(dbName);
    global._hoocoohMongoDb = cachedDb;
    ensureIndexes(cachedDb).catch(() => {});
    return cachedDb;
  }
}

module.exports = { getDb };
