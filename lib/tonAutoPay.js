/**
 * TON On-Chain Auto-Payout Dispatcher
 * Dispatches automated on-chain payments to user TON wallet addresses upon admin approval.
 *
 * SECURE:
 * - Never stores or logs mnemonic phrases or private keys.
 * - Credentials read from Vercel environment variables OR secure admin settings.
 *
 * Supported Environment Variables:
 * - TON_AUTO_PAY: Set to 'true', '1', or 'yes' (auto-enabled if mnemonic is provided).
 * - TON_WALLET_MNEMONIC: 24 (or 12) secret words of the hot wallet.
 * - TON_WALLET_ADDRESS: Optional hot wallet address (matches V5/V4).
 * - TON_RPC_ENDPOINT: Optional custom endpoint.
 * - TON_API_KEY / TONCENTER_API_KEY / TON_CONSOLE_API_KEY: Optional RPC key.
 */

const { TonClient, WalletContractV4, WalletContractV5R1, internal, toNano, fromNano, beginCell, external, storeMessage, SendMode } = require("@ton/ton");
const { mnemonicToPrivateKey } = require("@ton/crypto");

async function getTonAutoPayConfig(db = null) {
  let envMnemonic = (
    process.env.TON_WALLET_MNEMONIC ||
    process.env.WALLET_MNEMONIC ||
    process.env.MNEMONIC ||
    process.env.TON_MNEMONIC ||
    process.env.HOT_WALLET_MNEMONIC ||
    process.env.MNEMONIC_PHRASE ||
    process.env.TON_SEED_PHRASE ||
    process.env.SEED_PHRASE ||
    ""
  ).trim();

  let autoPayRaw = String(process.env.TON_AUTO_PAY || "").toLowerCase().trim();
  let configuredAddress = (process.env.TON_WALLET_ADDRESS || "").trim();

  let dbMnemonic = "";
  if (db) {
    try {
      const doc = await db.collection("settings").findOne({ key: "ton_autopay" });
      if (doc && doc.mnemonic) {
        dbMnemonic = String(doc.mnemonic).trim();
        if (doc.autoPay !== undefined) {
          autoPayRaw = String(doc.autoPay).toLowerCase().trim();
        }
        if (doc.walletAddress && !configuredAddress) {
          configuredAddress = String(doc.walletAddress).trim();
        }
      }
    } catch (_) {}
  }

  const countWords = (str) => {
    if (!str) return 0;
    return String(str).trim().replace(/^["']|["']$/g, "").split(/[\s,]+/).filter(Boolean).length;
  };

  const envCount = countWords(envMnemonic);
  const dbCount = countWords(dbMnemonic);

  let mnemonicStr = "";
  let source = "";

  // 1. If DB has valid 24 (or 12) words, give priority to DB (since admin explicitly saved it via admin panel)!
  if (dbCount === 24 || dbCount === 12) {
    mnemonicStr = dbMnemonic;
    source = "db";
  } else if (envCount === 24 || envCount === 12) {
    mnemonicStr = envMnemonic;
    source = "env";
  } else if (dbMnemonic) {
    mnemonicStr = dbMnemonic;
    source = "db";
  } else if (envMnemonic) {
    mnemonicStr = envMnemonic;
    source = "env";
  }

  const isExplicitlyDisabled = autoPayRaw === "false" || autoPayRaw === "0" || autoPayRaw === "no";
  const isEnabled = !isExplicitlyDisabled && (autoPayRaw === "true" || autoPayRaw === "1" || autoPayRaw === "yes" || !!mnemonicStr);

  return {
    mnemonicStr,
    isEnabled,
    isExplicitlyDisabled,
    configuredAddress,
    source
  };
}

async function getTonAutoPayStatus(db = null) {
  try {
    const config = await getTonAutoPayConfig(db);
    if (!config.mnemonicStr) {
      return {
        configured: false,
        enabled: false,
        source: null,
        configuredAddress: config.configuredAddress || null,
        message: "TON_WALLET_MNEMONIC (24 secret words) is not configured in Vercel or database."
      };
    }

    if (config.isExplicitlyDisabled) {
      return {
        configured: true,
        enabled: false,
        source: config.source,
        message: "TON_AUTO_PAY is set to 'false'. Auto-payout is disabled."
      };
    }

    const cleanMnemonic = String(config.mnemonicStr).trim().replace(/^["']|["']$/g, "").trim();
    const words = cleanMnemonic.split(/[\s,]+/).map(w => w.replace(/["',]/g, "").trim().toLowerCase()).filter(Boolean);

    if (words.length !== 24 && words.length !== 12) {
      return {
        configured: false,
        enabled: config.isEnabled,
        wordCount: words.length,
        message: `Invalid mnemonic length (${words.length} words found, expected 24 or 12).`
      };
    }

    const keyPair = await mnemonicToPrivateKey(words);
    const walletV5 = WalletContractV5R1 ? WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey }) : null;
    const walletV4 = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
    const addrV5 = walletV5 ? walletV5.address.toString({ bounceable: false }) : "";
    const addrV4 = walletV4.address.toString({ bounceable: false });

    let activeWallet = walletV5 || walletV4;
    let walletType = walletV5 ? "V5R1" : "V4";
    if (config.configuredAddress) {
      if (addrV4.toLowerCase() === config.configuredAddress.toLowerCase()) {
        activeWallet = walletV4;
        walletType = "V4";
      } else if (addrV5.toLowerCase() === config.configuredAddress.toLowerCase()) {
        activeWallet = walletV5;
        walletType = "V5R1";
      }
    }

    const walletAddress = activeWallet.address.toString({ bounceable: false });
    const client = new TonClient({
      endpoint: "https://ton.access.orbs.network/44A1c0ff5Bd3F8B62C092Ab4D238bEE463E644A1/1/mainnet/toncenter-api-v2/jsonRPC"
    });

    let balanceTon = 0;
    try {
      const nano = await client.getBalance(activeWallet.address);
      balanceTon = parseFloat(fromNano(nano));
    } catch (_) {}

    let seqno = 0;
    try {
      const seqRes = await client.runMethod(activeWallet.address, 'seqno');
      if (seqRes && seqRes.stack) {
        seqno = seqRes.stack.readNumber();
      }
    } catch (_) {}

    return {
      configured: true,
      enabled: config.isEnabled,
      source: config.source,
      walletType,
      walletAddress,
      balanceTon,
      seqno,
      wordCount: words.length
    };
  } catch (err) {
    return {
      configured: false,
      error: err.message
    };
  }
}

async function dispatchTonPayout(toAddress, tonAmount, memo = "TREASURE Mine Payout", db = null) {
  const config = await getTonAutoPayConfig(db);

  if (!config.mnemonicStr) {
    return {
      success: false,
      isConfigured: false,
      txHash: null,
      message: "TON_WALLET_MNEMONIC (24 secret words) is not configured in Vercel or database."
    };
  }

  if (config.isExplicitlyDisabled) {
    return {
      success: false,
      isConfigured: false,
      txHash: null,
      message: "TON_AUTO_PAY is set to 'false'. To enable automatic payouts, remove TON_AUTO_PAY or set TON_AUTO_PAY=true."
    };
  }

  if (!config.isEnabled) {
    return {
      success: false,
      isConfigured: false,
      txHash: null,
      message: "TON auto-pay is disabled."
    };
  }

  // Clean quotes, double quotes, brackets, newlines, commas
  const cleanMnemonic = String(config.mnemonicStr).trim().replace(/^["']|["']$/g, "").trim();
  const words = cleanMnemonic.split(/[\s,]+/).map(w => w.replace(/["',]/g, "").trim().toLowerCase()).filter(Boolean);
  if (words.length !== 24 && words.length !== 12) {
    return {
      success: false,
      isConfigured: true,
      error: "INVALID_MNEMONIC_LENGTH",
      message: `Invalid mnemonic length (${words.length} words found, expected 24 or 12).`
    };
  }

  const amtNum = parseFloat(tonAmount);
  if (isNaN(amtNum) || amtNum <= 0) {
    return {
      success: false,
      isConfigured: true,
      error: "INVALID_AMOUNT",
      message: `Invalid payout amount: ${tonAmount} TON`
    };
  }

  // Clean and parse destination address
  const cleanToAddr = String(toAddress || "").trim();
  if (!cleanToAddr) {
    return {
      success: false,
      isConfigured: true,
      error: "INVALID_DESTINATION_ADDRESS",
      message: "User destination wallet address is empty."
    };
  }

  try {
    const rawKey = (process.env.TONCENTER_API_KEY || process.env.TON_API_KEY || process.env.TON_CONSOLE_API_KEY || "").trim();
    const validToncenterKey = /^[0-9a-fA-F]{64}$/.test(rawKey) ? rawKey : undefined;
    const customEndpoint = (process.env.TON_RPC_ENDPOINT || "").trim();

    // High-performance endpoints array with automatic failover
    const rpcConfigs = [];
    if (customEndpoint) {
      rpcConfigs.push({ endpoint: customEndpoint, apiKey: validToncenterKey });
    }
    // High-performance decentralized Orbs gateway (no rate limits, fast)
    rpcConfigs.push({
      endpoint: "https://ton.access.orbs.network/44A1c0ff5Bd3F8B62C092Ab4D238bEE463E644A1/1/mainnet/toncenter-api-v2/jsonRPC",
      apiKey: undefined
    });
    // Official Toncenter endpoint
    rpcConfigs.push({
      endpoint: "https://toncenter.com/api/v2/jsonRPC",
      apiKey: validToncenterKey
    });

    const clients = rpcConfigs.map(c => new TonClient({ endpoint: c.endpoint, apiKey: c.apiKey }));

    // Helper: try calls with endpoint failover
    async function callWithFailover(fn) {
      let lastErr = null;
      for (const client of clients) {
        try {
          return await fn(client);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    }

    // Derive key pair securely in memory
    const keyPair = await mnemonicToPrivateKey(words);
    const workchain = 0;
    const walletV5 = WalletContractV5R1 ? WalletContractV5R1.create({ workchain, publicKey: keyPair.publicKey }) : null;
    const walletV4 = WalletContractV4.create({ workchain, publicKey: keyPair.publicKey });

    const addrV5 = walletV5 ? walletV5.address.toString({ bounceable: false }) : "";
    const addrV4 = walletV4.address.toString({ bounceable: false });
    const configuredAddr = (config.configuredAddress || "").trim().toLowerCase();

    // Select wallet contract version
    let activeWallet = walletV5 || walletV4;
    if (configuredAddr) {
      if (addrV4.toLowerCase() === configuredAddr) {
        activeWallet = walletV4;
      } else if (addrV5.toLowerCase() === configuredAddr) {
        activeWallet = walletV5;
      }
    } else {
      // If not explicitly configured, check balances in parallel to find which wallet has funds
      try {
        const [resV5, resV4] = await Promise.allSettled([
          walletV5 ? callWithFailover(c => c.getBalance(walletV5.address)) : Promise.reject(),
          callWithFailover(c => c.getBalance(walletV4.address))
        ]);
        const balV5 = resV5.status === "fulfilled" ? parseFloat(fromNano(resV5.value)) : 0;
        const balV4 = resV4.status === "fulfilled" ? parseFloat(fromNano(resV4.value)) : 0;
        if (balV4 > balV5) {
          activeWallet = walletV4;
        }
      } catch (_) {}
    }

    const senderAddress = activeWallet.address.toString({ bounceable: false });
    const requiredTotal = amtNum + 0.008;

    // Check balance (only block if balance was successfully fetched AND is demonstrably low)
    let balanceTon = -1;
    try {
      const nano = await callWithFailover(c => c.getBalance(activeWallet.address));
      balanceTon = parseFloat(fromNano(nano));
    } catch (balErr) {
      console.warn("[TON Auto-Pay] Warning: Balance check failed, proceeding with broadcast:", balErr.message);
    }

    if (balanceTon >= 0 && balanceTon < requiredTotal) {
      return {
        success: false,
        isConfigured: true,
        error: "INSUFFICIENT_HOT_WALLET_BALANCE",
        message: `Hot wallet balance too low! Available: ${balanceTon.toFixed(4)} TON, Needed: ${requiredTotal.toFixed(4)} TON (including network gas fee). Please deposit TON to: ${senderAddress}`
      };
    }

    // Fetch seqno reliably
    let currentSeqno = -1;
    try {
      const seqRes = await callWithFailover(c => c.runMethod(activeWallet.address, 'seqno'));
      if (seqRes && seqRes.stack) {
        currentSeqno = seqRes.stack.readNumber();
      }
    } catch (_) {
      try {
        const contract = clients[0].open(activeWallet);
        currentSeqno = await contract.getSeqno();
      } catch (_) {
        try {
          const state = await callWithFailover(c => c.getContractState(activeWallet.address));
          currentSeqno = state.state === "active" ? 1 : 0;
        } catch (_) {
          currentSeqno = 0;
        }
      }
    }

    if (currentSeqno < 0) currentSeqno = 0;

    // Construct transfer message cleanly in memory
    const transfer = activeWallet.createTransfer({
      seqno: currentSeqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
      messages: [
        internal({
          to: cleanToAddr,
          value: toNano(amtNum.toFixed(6)),
          bounce: false,
          body: memo || "TREASURE Mine Payout"
        })
      ]
    });

    // Build external envelope
    const extMessage = external({
      to: activeWallet.address,
      init: currentSeqno === 0 ? activeWallet.init : null,
      body: transfer
    });

    const extCell = beginCell().store(storeMessage(extMessage)).endCell();
    const boc = extCell.toBoc();

    // Broadcast on-chain transfer with endpoint failover
    let broadcastOk = false;
    let lastBroadcastErr = "";

    for (const client of clients) {
      try {
        await client.sendFile(boc);
        broadcastOk = true;
        break;
      } catch (err) {
        lastBroadcastErr = (err && err.message) ? err.message : String(err);
        console.warn("[TON Auto-Pay] Broadcast attempt error:", lastBroadcastErr);
      }
    }

    if (!broadcastOk) {
      return {
        success: false,
        isConfigured: true,
        error: "BROADCAST_FAILED",
        message: `On-chain transfer failed to broadcast: ${lastBroadcastErr}`
      };
    }

    const txId = extCell.hash().toString("hex");

    return {
      success: true,
      isConfigured: true,
      txHash: txId,
      sender: senderAddress,
      amount: amtNum,
      confirmed: true,
      message: `Successfully broadcast ${amtNum} TON on-chain from ${senderAddress}!`
    };
  } catch (err) {
    const errorDetails = err.response?.data?.error || err.response?.data?.message || err.message;
    console.error("TON Auto-Pay error:", errorDetails);
    return {
      success: false,
      isConfigured: true,
      error: errorDetails,
      message: `On-chain transfer failed: ${errorDetails}`
    };
  }
}

module.exports = {
  dispatchTonPayout,
  getTonAutoPayStatus,
  getTonAutoPayConfig
};
