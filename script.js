/**
 * Simple Solana SPL Token Transfers Viewer
 * - Uses public RPC endpoint to fetch signatures and parsed transactions
 * - Filters SPL token transfer instructions (transfer, transferChecked)
 * - Displays last 10 token transfers with token info resolved from Solana token list
 */

const RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";
const SOLANA_TOKEN_LIST_URL = "https://cdn.jsdelivr.net/gh/solana-labs/token-list@main/src/tokens/solana.tokenlist.json";

const el = {
  address: document.getElementById("address"),
  fetchBtn: document.getElementById("fetchBtn"),
  status: document.getElementById("status"),
  statusText: document.getElementById("statusText"),
  error: document.getElementById("error"),
  errorBox: document.querySelector("#error > div"),
  results: document.getElementById("results"),
  tbody: document.getElementById("tbody"),
  count: document.getElementById("count"),
};

const state = {
  tokenMap: new Map(), // mint -> {name, symbol, decimals}
};

// Basic base58 check (lightweight)
function isLikelySolanaAddress(addr) {
  if (!addr || typeof addr !== "string") return false;
  if (addr.length < 32 || addr.length > 44) return false;
  // base58 regex excluding 0,O,I,l
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr);
}

async function fetchTokenList() {
  try {
    const res = await fetch(SOLANA_TOKEN_LIST_URL);
    if (!res.ok) throw new Error("Failed token list fetch");
    const json = await res.json();
    const tokens = json.tokens || [];
    const map = new Map();
    for (const t of tokens) {
      if (t.chainId === 101 && t.address) {
        map.set(t.address, { name: t.name || "", symbol: t.symbol || "", decimals: t.decimals ?? null });
      }
    }
    state.tokenMap = map;
  } catch (e) {
    // Keep map empty if token list fails; we will still show mint and raw amounts
    console.warn("Token list fetch failed:", e.message || e);
  }
}

async function rpc(method, params) {
  const res = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

async function getSignaturesForAddress(address, limit = 50) {
  // We start with a reasonably high limit to find up to 10 transfers
  return rpc("getSignaturesForAddress", [address, { limit }]);
}

async function getTransaction(signature) {
  // jsonParsed returns parsed instructions including spl-token transfer details
  return rpc("getTransaction", [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
}

function uiAmountFromRaw(amountStr, decimals) {
  const amount = BigInt(amountStr);
  if (typeof decimals !== "number" || Number.isNaN(decimals)) return amount.toString();
  const divisor = BigInt(10) ** BigInt(decimals);
  const integerPart = amount / divisor;
  const fractionalPart = amount % divisor;
  if (fractionalPart === 0n) return integerPart.toString();
  const fracStr = fractionalPart.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${integerPart.toString()}.${fracStr}`;
}

function resolveTokenAccountOwner(tokenAccountAddr, tx) {
  // Map token account (source/destination) to its owner using token balance indices
  const meta = tx.meta;
  const message = tx.transaction?.message;

  const keys = (message?.accountKeys || []).map(k => {
    // In jsonParsed, each key is an object { pubkey, signer, writable }
    return typeof k === "string" ? k : k?.pubkey;
  });

  const balances = [
    ...(meta?.preTokenBalances || []),
    ...(meta?.postTokenBalances || []),
  ];

  for (const b of balances) {
    const idx = b?.accountIndex;
    if (typeof idx === "number" && keys[idx] === tokenAccountAddr) {
      return b.owner || null;
    }
  }
  return null;
}

function extractTransfersFromTransaction(txn) {
  if (!txn) return [];
  const transfers = [];
  const message = txn.transaction?.message;
  const meta = txn.meta;
  const blockTime = txn.blockTime || null;

  const sig = txn.transaction?.signatures?.[0];

  // Helper to process an instruction object (parsed)
  function processInstruction(ix) {
    if (!ix || ix.program !== "spl-token" || !ix.parsed) return;
    const type = ix.parsed?.type;
    const info = ix.parsed?.info || {};
    if (type !== "transfer" && type !== "transferChecked") return;

    const mint = info.mint || info.token?.mint || null;
    let amountUi = null;
    let rawAmount = null;
    if (type === "transferChecked" && info.tokenAmount) {
      amountUi = info.tokenAmount.uiAmountString || info.tokenAmount.uiAmount?.toString() || null;
      rawAmount = info.tokenAmount.amount || null;
    } else {
      rawAmount = info.amount || null; // string
    }

    const sourceTokenAcc = info.source || info.account || null;
    const destTokenAcc = info.destination || info.dest || null;

    // Resolve token metadata
    const tmeta = mint ? state.tokenMap.get(mint) : null;
    const tokenName = tmeta?.name || (mint ? `Token ${mint.slice(0,4)}…${mint.slice(-4)}` : "Unknown Token");
    const tokenSymbol = tmeta?.symbol || (mint ? "SPL" : "");
    const decimals = tmeta?.decimals ?? null;

    // Compute UI amount if needed
    const uiAmount = amountUi || (rawAmount ? uiAmountFromRaw(rawAmount, decimals) : null);

    // Resolve owners via token balances (best-effort)
    const fromOwner = sourceTokenAcc ? resolveTokenAccountOwner(sourceTokenAcc, { ...txn, transaction: txn.transaction, meta: txn.meta }) : null;
    const toOwner = destTokenAcc ? resolveTokenAccountOwner(destTokenAcc, { ...txn, transaction: txn.transaction, meta: txn.meta }) : null;

    transfers.push({
      signature: sig,
      blockTime,
      token: { mint, name: tokenName, symbol: tokenSymbol, decimals },
      amount: uiAmount || rawAmount || "—",
      fromTokenAcc: sourceTokenAcc,
      toTokenAcc: destTokenAcc,
      fromOwner,
      toOwner,
      type,
    });
  }

  // Top-level parsed instructions
  const instructions = message?.instructions || [];
  for (const ix of instructions) {
    processInstruction(ix);
  }

  // Inner instructions may contain token transfers
  const inner = meta?.innerInstructions || [];
  for (const entry of inner) {
    for (const ix of entry?.instructions || []) {
      processInstruction(ix);
    }
  }

  return transfers;
}

function formatAddress(addr, ownerIfAvailable = null) {
  if (!addr) return "—";
  const short = `${addr.slice(0, 4)}…${addr.slice(-4)}`;
  if (ownerIfAvailable) {
    const ownerShort = `${ownerIfAvailable.slice(0, 4)}…${ownerIfAvailable.slice(-4)}`;
    return `${short} (owner: ${ownerShort})`;
  }
  return short;
}

function formatTimestamp(blockTime) {
  if (!blockTime) return "—";
  const d = new Date(blockTime * 1000);
  return d.toLocaleString();
}

function setStatus(text = "", show = false) {
  el.statusText.textContent = text;
  el.status.classList.toggle("hidden", !show);
}

function setError(text = "", show = false) {
  if (show && text) {
    el.errorBox.textContent = text;
  }
  el.error.classList.toggle("hidden", !show);
}

function setResults(rows) {
  el.tbody.innerHTML = rows.map(r => `
    <tr class="hover:bg-slate-50 transition">
      <td class="px-4 py-3">
        <div class="flex flex-col">
          <span class="font-medium text-slate-900">${r.token.name}</span>
          <span class="text-xs text-slate-500">${r.token.symbol}${r.token.mint ? ` • ${r.token.mint.slice(0,8)}…` : ""}</span>
        </div>
      </td>
      <td class="px-4 py-3 text-right font-medium">${r.amount}</td>
      <td class="px-4 py-3">
        <div class="text-sm">
          <span class="text-slate-700">${formatAddress(r.fromTokenAcc, r.fromOwner)}</span>
        </div>
      </td>
      <td class="px-4 py-3">
        <div class="text-sm">
          <span class="text-slate-700">${formatAddress(r.toTokenAcc, r.toOwner)}</span>
        </div>
      </td>
      <td class="px-4 py-3">
        <a class="text-sky-600 hover:text-sky-700 underline underline-offset-2" href="https://solscan.io/tx/${r.signature}" target="_blank" rel="noopener noreferrer">
          ${r.signature.slice(0,10)}…
        </a>
      </td>
      <td class="px-4 py-3 text-sm text-slate-700">${formatTimestamp(r.blockTime)}</td>
    </tr>
  `).join("");
}

async function fetchTransfersForAddress(address) {
  setError("", false);
  setResults([]);
  el.results.classList.add("hidden");

  if (!isLikelySolanaAddress(address)) {
    setError("Please enter a valid Solana address (base58, 32–44 characters).", true);
    return;
  }

  setStatus("Fetching signatures…", true);

  try {
    // Ensure token list is available (best-effort)
    if (state.tokenMap.size === 0) {
      await fetchTokenList();
    }

    const sigs = await getSignaturesForAddress(address, 100);
    if (!sigs || sigs.length === 0) {
      setStatus("", false);
      setError("No signatures found for this address.", true);
      return;
    }

    setStatus("Fetching and parsing transactions…", true);

    const transfers = [];

    // Concurrency-limited fetch of transactions
    const limit = 6;
    let i = 0;

    async function worker() {
      while (i < sigs.length && transfers.length < 10) {
        const idx = i++;
        const s = sigs[idx];
        try {
          const txn = await getTransaction(s.signature);
          if (!txn) continue;
          const txTransfers = extractTransfersFromTransaction(txn);
          // Attach blockTime from signatures entry because sometimes txn.blockTime may be null
          for (const t of txTransfers) {
            if (t.signature === s.signature && !t.blockTime) t.blockTime = s.blockTime;
          }
          for (const t of txTransfers) {
            // Filter to transfers where the provided address is either owner or token account involved
            const involvesAddr = [
              t.fromOwner, t.toOwner, t.fromTokenAcc, t.toTokenAcc
            ].some(v => v === address);
            if (involvesAddr) {
              transfers.push(t);
              if (transfers.length >= 10) break;
            }
          }
        } catch (err) {
          // Ignore individual transaction errors
          console.warn("Failed to fetch tx", s.signature, err?.message || err);
        }
      }
    }

    const workers = Array.from({ length: Math.min(limit, sigs.length) }, () => worker());
    await Promise.all(workers);

    setStatus("", false);

    if (transfers.length === 0) {
      setError("No SPL token transfers found for this address in recent transactions.", true);
      return;
    }

    // Render
    el.count.textContent = `${transfers.length} transfer${transfers.length !== 1 ? "s" : ""} shown`;
    setResults(transfers);
    el.results.classList.remove("hidden");

  } catch (e) {
    console.error(e);
    setStatus("", false);
    setError(`Failed to fetch data: ${e.message || e}`, true);
  }
}

el.fetchBtn.addEventListener("click", () => {
  const addr = el.address.value.trim();
  fetchTransfersForAddress(addr);
});

el.address.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    const addr = el.address.value.trim();
    fetchTransfersForAddress(addr);
  }
});