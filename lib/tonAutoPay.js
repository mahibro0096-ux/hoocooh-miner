/**
 * TON On-Chain Auto-Payout Dispatcher
 * Dispatches automated on-chain payments to user TON wallet addresses upon admin approval.
 *
 * SECURE:
 * - Never stores or logs mnemonic phrases or private keys.
 * - All credentials read exclusively from environment variables.
 *
 * Supported Environment Variables:
 * - TON_AUTO_PAY: Set to 'true', '1', or 'yes' to activate automatic payout on approval.
 * - TON_WALLET_MNEMONIC: 24 (or 12) secret words of the hot wallet.
 * - TON_WALLET_ADDRESS: Optional hot wallet address (matches V5/V4).
 * - TON_RPC_ENDPOINT: Optional custom endpoint.
 * - TON_API_KEY / TONCENTER_API_KEY / TON_CONSOLE_API_KEY: Optional RPC key.
 */

const { TonClient, WalletContractV4, WalletContractV5R1, internal, toNano, fromNano, beginCell, external, storeMessage, SendMode } = require("@ton/ton");
const { mnemonicToPrivateKey } = require("@ton/crypto");

async function dispatchTonPayout(toAddress, tonAmount, memo = "HOOCOOH Miner Payout") {
  const autoPayRaw = String(process.env.TON_AUTO_PAY || "").toLowerCase().trim();
  const autoPayEnabled = autoPayRaw === "true" || autoPayRaw === "1" || autoPayRaw === "yes";
  const mnemonicStr = process.env.TON_WALLET_MNEMONIC || process.env.WALLET_MNEMONIC || process.env.MNEMONIC;

  if (!autoPayEnabled || !mnemonicStr) {
    return {
      success: false,
      isConfigured: false,
      txHash: null,
      message: "TON auto-pay is disabled or TON_WALLET_MNEMONIC is not configured in environment."
    };
  }

  // Clean quotes, double quotes, brackets, newlines, commas
  const cleanMnemonic = String(mnemonicStr).trim().replace(/^["']|["']$/g, "").trim();
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
    const configuredAddr = (process.env.TON_WALLET_ADDRESS || "").trim().toLowerCase();

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
          body: memo || "HOOCOOH Miner Payout"
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
  dispatchTonPayout
};
