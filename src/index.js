import { Hono } from "hono"
import { cors } from "hono/cors"
import {
  MIN_MAX_FEE_PER_GAS,
  USDC,
  activeNetwork,
  dollarsToMicro,
  encodeErc20Transfer,
  evaluateEvidence,
  evaluatePreflight,
  isAddress,
  mainnetEnabled,
  microToDollars,
  policyLimits,
  resolveRpc,
  decodePayment,
} from "./domain.js"
import { createSqlRepo } from "./repo.js"
import { pageHtml } from "./page.js"

const app = new Hono()
app.use("/*", cors())

function repoOf(env) {
  if (env.REPO) return env.REPO
  if (!env.DB) return null
  if (!env._repo) env._repo = createSqlRepo(env.DB)
  return env._repo
}

function nowOf(env) {
  return env?.NOW ? new Date(env.NOW) : new Date()
}

function today(env) {
  return nowOf(env).toISOString().slice(0, 10)
}

function monthOf(env) {
  return today(env).slice(0, 7)
}

function newId(prefix, bytes) {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  const hex = Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("")
  return prefix ? `${prefix}${hex}` : hex
}

async function readJson(c) {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`rpc http ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || "rpc error")
  return data.result
}

function canonicalTransfer(recipient, amountMicro) {
  return {
    to: USDC,
    data: encodeErc20Transfer(recipient, amountMicro),
    value: "0x0",
  }
}

function viewLink(row, origin, env) {
  const network = activeNetwork(env)
  return {
    id: row.id,
    recipient: row.recipient,
    amount: row.amount_display,
    amountMicro: row.amount_micro,
    purpose: row.purpose,
    status: row.status,
    txHash: row.tx_hash || null,
    payer: row.payer || null,
    network: network.key,
    chainId: network.chainId,
    usdc: USDC,
    payUrl: `${origin}/pay/${row.id}`,
    pricing: "free",
  }
}

async function chainState(env) {
  const network = activeNetwork(env)
  const endpoint = resolveRpc(env)
  const hex = await rpc(endpoint, "eth_chainId", [])
  const blockHex = await rpc(endpoint, "eth_blockNumber", [])
  return {
    network,
    endpoint,
    chainId: Number(BigInt(hex)),
    blockNumber: Number(BigInt(blockHex)),
  }
}

async function simulate(env, tx, from) {
  try {
    await rpc(resolveRpc(env), "eth_call", [
      { from, to: tx.to, data: tx.data, value: tx.value },
      "latest",
    ])
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message || "模拟失败" }
  }
}

async function runPreflight(env, { recipient, amount, from, apiKey, tx, exceptLinkId }) {
  const network = activeNetwork(env)
  const limits = policyLimits(env)
  let chainId = null
  try {
    const state = await chainState(env)
    chainId = state.chainId
  } catch (error) {
    return { decision: "BLOCK", reasons: [`无法读取 Arc 链：${error.message}`], tx: null }
  }
  const repo = repoOf(env)
  const spent = repo && apiKey ? await repo.daySpentMicro(apiKey, today(env), exceptLinkId) : 0n
  let unsigned = tx || null
  if (!unsigned && from && recipient && amount != null) {
    try {
      unsigned = canonicalTransfer(recipient, dollarsToMicro(amount))
    } catch (error) {
      return { decision: "BLOCK", reasons: [error.message], tx: null }
    }
  }
  const simulation = unsigned && from ? await simulate(env, unsigned, from) : null
  const result = evaluatePreflight({
    network: network.key,
    mainnetEnabled: mainnetEnabled(env),
    chainId,
    expectedChainId: network.chainId,
    recipient,
    amount,
    tx: unsigned,
    daySpentMicro: spent,
    maxSingleMicro: limits.single,
    maxDailyMicro: limits.daily,
    simulation,
    requireSimulation: true,
  })
  return { ...result, tx: result.decision === "ALLOW" ? unsigned : null, chainId }
}

app.get("/api/health", async (c) => {
  const network = activeNetwork(c.env)
  try {
    const state = await chainState(c.env)
    const enabled = mainnetEnabled(c.env)
    const ok = state.chainId === network.chainId && (network.key !== "mainnet" || enabled)
    return c.json(
      {
        ok,
        custody: false,
        pricing: "free",
        network: network.key,
        chainId: state.chainId,
        expectedChainId: network.chainId,
        blockNumber: state.blockNumber,
        usdc: USDC,
        mainnetEnabled: enabled,
      },
      ok ? 200 : 503,
    )
  } catch {
    return c.json(
      { ok: false, pricing: "free", error: "rpc_unavailable", expectedChainId: network.chainId },
      503,
    )
  }
})

app.get("/api/config", (c) => {
  const network = activeNetwork(c.env)
  const limits = policyLimits(c.env)
  return c.json({
    pricing: "free",
    custody: false,
    network: network.key,
    chainId: network.chainId,
    chainIdHex: network.chainIdHex,
    rpc: network.rpc,
    explorer: network.explorer,
    name: network.name,
    usdc: USDC,
    minMaxFeePerGas: "0x" + MIN_MAX_FEE_PER_GAS.toString(16),
    mainnetEnabled: mainnetEnabled(c.env),
    maxSingle: microToDollars(limits.single),
    maxDaily: microToDollars(limits.daily),
  })
})

app.get("/", (c) => c.html(pageHtml()))
app.get("/pay/:id", (c) => c.html(pageHtml()))

app.post("/api/register", async (c) => {
  const body = await readJson(c)
  const owner = body?.owner
  if (!isAddress(owner || "")) return c.json({ error: "owner 必须是钱包地址" }, 400)
  const repo = repoOf(c.env)
  if (!repo) return c.json({ error: "数据库未配置" }, 503)
  const apiKey = newId("arc_", 18)
  await repo.createKey({ key: apiKey, owner })
  await repo.audit(apiKey, "register", { owner, pricing: "free" })
  return c.json({
    apiKey,
    tier: "free",
    pricing: "free",
    owner,
    note: "当前全部免费。不要为升级转账。",
  })
})

app.post("/api/upgrade", (c) =>
  c.json(
    {
      error: "收费未开启",
      pricing: "free",
      reason: "全部功能免费。交易哈希不会被当成付款，也不会提升档位。",
    },
    410,
  ),
)

async function requireApiKey(c, next) {
  const apiKey = c.req.header("x-api-key")
  if (!apiKey) return c.json({ error: "Missing x-api-key header" }, 401)
  const repo = repoOf(c.env)
  if (!repo) return c.json({ error: "数据库未配置" }, 503)
  const month = monthOf(c.env)
  const row = await repo.getKey(apiKey, month)
  if (!row) return c.json({ error: "Invalid API key" }, 401)
  const limit = Number.parseInt(c.env.TIER_FREE_LIMIT || "1000", 10)
  if ((row.calls || 0) >= limit) {
    return c.json({ error: "本月免费调用次数已用完，下月自动恢复", pricing: "free", limit, month }, 429)
  }
  await repo.bumpCalls(apiKey, month)
  c.set("apiKey", apiKey)
  return next()
}

app.post("/api/payment/intent", requireApiKey, async (c) => {
  const body = await readJson(c)
  if (!body?.recipient || body.amount == null) return c.json({ error: "recipient 和 amount 必填" }, 400)
  let micro
  try {
    micro = dollarsToMicro(body.amount)
  } catch (error) {
    return c.json({ error: error.message }, 400)
  }
  if (!isAddress(body.recipient) || micro <= 0n) return c.json({ error: "收款地址或金额无效" }, 400)
  const repo = repoOf(c.env)
  const id = await repo.insertIntent({
    apiKey: c.get("apiKey"),
    recipient: body.recipient,
    amountDisplay: microToDollars(micro),
    amountMicro: micro.toString(),
    status: "pending",
    decision: "REVIEW",
    purpose: body.purpose || null,
    day: today(c.env),
  })
  return c.json({
    id,
    recipient: body.recipient,
    amount: microToDollars(micro),
    status: "pending",
    pricing: "free",
    message: "意图已记录。ALLOW 需要调用 /api/preflight 并完成模拟。",
  })
})

app.post("/api/policy/check", requireApiKey, async (c) => {
  const body = await readJson(c)
  if (!body?.recipient || body.amount == null) return c.json({ error: "recipient 和 amount 必填" }, 400)
  const result = await runPreflight(c.env, {
    recipient: body.recipient,
    amount: String(body.amount),
    from: body.from,
    apiKey: c.get("apiKey"),
    tx: body.tx,
  })
  const repo = repoOf(c.env)
  await repo.audit(c.get("apiKey"), "policy_check", result)
  return c.json({ ...result, pricing: "free" })
})

app.post("/api/preflight", requireApiKey, async (c) => {
  const body = await readJson(c)
  if (!body?.recipient || body.amount == null || !body.from) {
    return c.json({ error: "recipient、amount、from 必填" }, 400)
  }
  const result = await runPreflight(c.env, {
    recipient: body.recipient,
    amount: String(body.amount),
    from: body.from,
    apiKey: c.get("apiKey"),
    tx: body.tx,
  })
  await repoOf(c.env).audit(c.get("apiKey"), "preflight", { decision: result.decision, reasons: result.reasons })
  return c.json({ ...result, pricing: "free" })
})

app.post("/api/links", requireApiKey, async (c) => {
  const body = await readJson(c)
  if (!body?.recipient || body.amount == null) return c.json({ error: "recipient 和 amount 必填" }, 400)
  let micro
  try {
    micro = dollarsToMicro(body.amount)
  } catch (error) {
    return c.json({ error: error.message }, 400)
  }
  if (!isAddress(body.recipient) || micro <= 0n) return c.json({ error: "收款地址或金额无效" }, 400)
  const purpose = String(body.purpose || "").slice(0, 120)
  const repo = repoOf(c.env)
  const id = newId("", 12)
  await repo.createLink({
    id,
    apiKey: c.get("apiKey"),
    recipient: body.recipient.toLowerCase(),
    amountMicro: micro.toString(),
    amountDisplay: microToDollars(micro),
    purpose,
    day: today(c.env),
  })
  const row = await repo.getLink(id)
  return c.json(viewLink(row, new URL(c.req.url).origin, c.env))
})

app.get("/api/links/:id", async (c) => {
  const repo = repoOf(c.env)
  if (!repo) return c.json({ error: "数据库未配置" }, 503)
  const row = await repo.getLink(c.req.param("id"))
  if (!row) return c.json({ error: "账单不存在" }, 404)
  return c.json(viewLink(row, new URL(c.req.url).origin, c.env))
})

app.post("/api/links/:id/preflight", async (c) => {
  const repo = repoOf(c.env)
  if (!repo) return c.json({ error: "数据库未配置" }, 503)
  const row = await repo.getLink(c.req.param("id"))
  if (!row) return c.json({ error: "账单不存在" }, 404)
  if (row.status !== "open") return c.json({ error: "账单已结算", status: row.status }, 409)
  const body = await readJson(c)
  if (!isAddress(body?.from || "")) return c.json({ error: "from 必须是付款钱包地址" }, 400)
  const result = await runPreflight(c.env, {
    recipient: row.recipient,
    amount: row.amount_display,
    from: body.from,
    apiKey: row.api_key || row.apiKey,
    exceptLinkId: row.id,
  })
  return c.json({ ...result, pricing: "free", linkId: row.id })
})

app.post("/api/links/:id/evidence", async (c) => {
  const repo = repoOf(c.env)
  if (!repo) return c.json({ error: "数据库未配置" }, 503)
  const row = await repo.getLink(c.req.param("id"))
  if (!row) return c.json({ error: "账单不存在" }, 404)
  const body = await readJson(c)
  const txHash = typeof body?.txHash === "string" ? body.txHash.toLowerCase() : ""
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return c.json({ error: "txHash 无效" }, 400)
  }
  if (row.status === "settled" && row.tx_hash?.toLowerCase() === txHash.toLowerCase()) {
    return c.json({ decision: "ALLOW", status: "settled", txHash, pricing: "free" })
  }
  const existing = await repo.findLinkByTx(txHash)
  if (existing && existing.id !== row.id) return c.json({ error: "这笔交易已经用于另一张账单" }, 409)

  let receipt
  let tx
  try {
    receipt = await rpc(resolveRpc(c.env), "eth_getTransactionReceipt", [txHash])
    tx = await rpc(resolveRpc(c.env), "eth_getTransactionByHash", [txHash])
  } catch (error) {
    return c.json({ decision: "BLOCK", reasons: [error.message] }, 502)
  }
  if (!receipt || !tx) return c.json({ decision: "BLOCK", reasons: ["交易尚未上链"] }, 404)
  const decoded = decodePayment({ to: tx.to, data: tx.input || tx.data || "0x", value: tx.value || "0x0" })
  if (!decoded.ok || decoded.recipient !== row.recipient.toLowerCase() || decoded.micro !== BigInt(row.amount_micro)) {
    return c.json({ decision: "BLOCK", reasons: ["交易内容与账单不一致"] })
  }
  const evidence = evaluateEvidence({
    receipt,
    expected: { recipient: row.recipient, amountMicro: row.amount_micro, payer: tx.from },
  })
  if (evidence.decision !== "ALLOW") return c.json(evidence)
  await repo.settleLink({ id: row.id, txHash, payer: tx.from, evidence })
  await repo.audit(row.api_key || row.apiKey, "evidence", { id: row.id, txHash, decision: "ALLOW" })
  return c.json({ ...evidence, status: "settled", txHash, pricing: "free" })
})

app.get("/api/transactions/:hash", requireApiKey, async (c) => {
  const hash = c.req.param("hash")
  try {
    const receipt = await rpc(resolveRpc(c.env), "eth_getTransactionReceipt", [hash])
    if (!receipt) return c.json({ status: "not_found" }, 404)
    return c.json({
      status: receipt.status === "0x1" ? "success" : "failed",
      blockNumber: Number.parseInt(receipt.blockNumber, 16),
      from: receipt.from,
      to: receipt.to,
    })
  } catch (error) {
    return c.json({ error: error.message }, 502)
  }
})

app.post("/api/reconciliation", requireApiKey, (c) =>
  c.json(
    {
      error: "不再把本地状态改成已对账。请把交易哈希提交到 /api/links/:id/evidence",
      pricing: "free",
    },
    410,
  ),
)

app.get("/api/audit", requireApiKey, async (c) => {
  const logs = await repoOf(c.env).listAudit(c.get("apiKey"))
  return c.json({ logs, pricing: "free" })
})

export { app }

export default {
  async fetch(request, env, ctx) {
    try {
      const repo = env.REPO || (env.DB ? createSqlRepo(env.DB) : null)
      if (repo) {
        env.REPO = repo
        await repo.init()
      }
      return app.fetch(request, env, ctx)
    } catch (error) {
      console.error(error)
      return Response.json({ ok: false, pricing: "free", error: "startup_failed" }, { status: 500 })
    }
  },
}
