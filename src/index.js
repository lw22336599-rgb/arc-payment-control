import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()
app.use('/*', cors())

// ====== 数据库初始化 ======
async function initDB(env) {
  if (!env.DB) return
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      tier TEXT DEFAULT 'free',
      owner TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      calls INTEGER DEFAULT 0,
      last_call TEXT
    );
    CREATE TABLE IF NOT EXISTS payment_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key TEXT NOT NULL,
      recipient TEXT NOT NULL,
      amount TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      tx_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      checked_at TEXT,
      reconciled_at TEXT,
      policy_decision TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
}

// ====== 中间件：API Key验证 ======
async function requireApiKey(c, next) {
  // Free tier - anyone can use without key for basic health check
  const path = c.req.path
  if (path === '/api/health' || path === '/') return next()

  const apiKey = c.req.header('x-api-key')
  if (!apiKey) return c.json({ error: 'Missing x-api-key header' }, 401)

  const row = await c.env.DB.prepare('SELECT * FROM api_keys WHERE key = ?').bind(apiKey).first()
  if (!row) return c.json({ error: 'Invalid API key' }, 401)

  // Update usage
  await c.env.DB.prepare(
    'UPDATE api_keys SET calls = calls + 1, last_call = datetime("now") WHERE key = ?'
  ).bind(apiKey).run()

  // Check tier limits
  const limit = row.tier === 'pro' ? parseInt(c.env.TIER_PRO_LIMIT) : parseInt(c.env.TIER_FREE_LIMIT)
  if (row.calls >= limit && row.tier === 'free') {
    return c.json({ 
      error: 'Free tier limit reached',
      limit,
      upgrade: `Pay USDC to ${c.env.OWNER_WALLET} and send tx hash to get Pro tier`
    }, 402)
  }

  c.set('apiKey', apiKey)
  c.set('tier', row.tier)
  return next()
}

// ====== 工具函数 ======
function getRpcUrl(env) {
  return env.NETWORK === 'mainnet' ? env.ARC_MAINNET_RPC : env.ARC_TESTNET_RPC
}

async function getBlockNumber(rpc) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
  })
  const data = await res.json()
  return parseInt(data.result, 16)
}

// ====== 路由 ======

// 健康检查
app.get('/api/health', async (c) => {
  const rpc = getRpcUrl(c.env)
  let blockNumber = 0
  try { blockNumber = await getBlockNumber(rpc) } catch (e) {}
  return c.json({
    ok: true,
    network: c.env.NETWORK,
    blockNumber,
    owner: c.env.OWNER_WALLET,
    tierFreeLimit: parseInt(c.env.TIER_FREE_LIMIT),
    tierProMonthly: `$${c.env.TIER_PRO_MONTHLY}/month`
  })
})

// 提交支付意图
app.post('/api/payment/intent', requireApiKey, async (c) => {
  const body = await c.req.json()
  const { recipient, amount, agentId } = body
  if (!recipient || !amount) {
    return c.json({ error: 'recipient and amount required' }, 400)
  }
  const apiKey = c.get('apiKey')
  const result = await c.env.DB.prepare(
    'INSERT INTO payment_intents (api_key, recipient, amount, status) VALUES (?, ?, ?, ?)'
  ).bind(apiKey, recipient, amount, 'pending').run()
  return c.json({
    id: result.meta.last_row_id,
    recipient,
    amount,
    status: 'pending',
    message: 'Payment intent created. Awaiting policy check.'
  })
})

// 策略检查
app.post('/api/policy/check', requireApiKey, async (c) => {
  const body = await c.req.json()
  const { amount, recipient } = body
  if (!amount || !recipient) {
    return c.json({ error: 'amount and recipient required' }, 400)
  }
  const amountNum = parseFloat(amount)
  let decision = 'allow'
  let reason = ''

  // 规则1：单笔上限 $10,000
  if (amountNum > 10000) {
    decision = 'require_approval'
    reason = 'Amount exceeds single transaction limit of $10,000'
  }
  // 规则2：每天上限
  const apiKey = c.get('apiKey')
  const today = new Date().toISOString().split('T')[0]
  const dayTotal = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) as total FROM payment_intents WHERE api_key = ? AND date(created_at) = ?"
  ).bind(apiKey, today).first()
  if (dayTotal && parseFloat(dayTotal.total || '0') + amountNum > 50000) {
    decision = 'deny'
    reason = 'Daily limit of $50,000 exceeded'
  }

  // 记录审计
  await c.env.DB.prepare(
    'INSERT INTO audit_log (api_key, action, detail) VALUES (?, ?, ?)'
  ).bind(apiKey, 'policy_check', JSON.stringify({ amount, recipient, decision, reason })).run()

  return c.json({ decision, reason, amount, recipient })
})

// 查询交易
app.get('/api/transactions/:hash', requireApiKey, async (c) => {
  const hash = c.req.param('hash')
  const rpc = getRpcUrl(c.env)
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt',
      params: [hash]
    })
  })
  const data = await res.json()
  if (!data.result) return c.json({ status: 'not_found' }, 404)
  return c.json({
    status: data.result.status === '0x1' ? 'success' : 'failed',
    blockNumber: parseInt(data.result.blockNumber, 16),
    from: data.result.from,
    to: data.result.to
  })
})

// 对账
app.post('/api/reconciliation', requireApiKey, async (c) => {
  const apiKey = c.get('apiKey')
  // 标记所有pending的为checked
  await c.env.DB.prepare(
    "UPDATE payment_intents SET status = 'checked', checked_at = datetime('now') WHERE api_key = ? AND status = 'pending'"
  ).bind(apiKey).run()
  const result = await c.env.DB.prepare(
    'SELECT COUNT(*) as total, status FROM payment_intents WHERE api_key = ? GROUP BY status'
  ).bind(apiKey).all()
  return c.json({
    checked: true,
    summary: result.results || []
  })
})

// 注册API Key（付费入口）
app.post('/api/register', async (c) => {
  const body = await c.req.json()
  const { owner, tier } = body
  if (!owner) return c.json({ error: 'owner required (wallet address)' }, 400)

  // Generate random API key using crypto
  const arr = new Uint8Array(18)
  crypto.getRandomValues(arr)
  const apiKey = `arc_${Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')}`

  await c.env.DB.prepare(
    'INSERT INTO api_keys (key, tier, owner) VALUES (?, ?, ?)'
  ).bind(apiKey, tier || 'free', owner).run()

  await c.env.DB.prepare(
    'INSERT INTO audit_log (api_key, action, detail) VALUES (?, ?, ?)'
  ).bind(apiKey, 'register', JSON.stringify({ owner, tier: tier || 'free' })).run()

  return c.json({
    apiKey,
    tier: tier || 'free',
    owner,
    upgradeInfo: {
      proPrice: `$${c.env.TIER_PRO_MONTHLY}/month`,
      paymentWallet: c.env.OWNER_WALLET
    }
  })
})

// 升级到Pro
app.post('/api/upgrade', async (c) => {
  const body = await c.req.json()
  const { apiKey, txHash } = body
  if (!apiKey || !txHash) return c.json({ error: 'apiKey and txHash required' }, 400)

  // 验证交易（简化版）
  const rpc = getRpcUrl(c.env)
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash',
      params: [txHash]
    })
  })
  const data = await res.json()
  if (!data.result) return c.json({ error: 'Transaction not found' }, 404)

  await c.env.DB.prepare(
    "UPDATE api_keys SET tier = 'pro', calls = 0 WHERE key = ?"
  ).bind(apiKey).run()

  await c.env.DB.prepare(
    'INSERT INTO audit_log (api_key, action, detail) VALUES (?, ?, ?)'
  ).bind(apiKey, 'upgrade', JSON.stringify({ txHash, tier: 'pro' })).run()

  return c.json({ apiKey, tier: 'pro', message: 'Upgraded to Pro' })
})

// 审计日志
app.get('/api/audit', requireApiKey, async (c) => {
  const apiKey = c.get('apiKey')
  const logs = await c.env.DB.prepare(
    'SELECT * FROM audit_log WHERE api_key = ? ORDER BY created_at DESC LIMIT 50'
  ).bind(apiKey).all()
  return c.json({ logs: logs.results })
})

// ====== 启动 ======
export default {
  async fetch(request, env, ctx) {
    try { await initDB(env) } catch (e) {}
    return app.fetch(request, env, ctx)
  }
}
