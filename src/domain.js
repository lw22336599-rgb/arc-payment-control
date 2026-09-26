/** Arc USDC payment rules. Pure functions only. No network, no keys. */

export const USDC = "0x3600000000000000000000000000000000000000"
export const SYSTEM_USDC_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE"
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
export const TRANSFER_SELECTOR = "a9059cbb"
export const MICRO = 1_000_000n
export const NATIVE_PER_MICRO = 1_000_000_000_000n
export const MIN_MAX_FEE_PER_GAS = 20_000_000_000n

function chainHex(chainId) {
  return "0x" + chainId.toString(16)
}

export const NETWORKS = {
  testnet: {
    key: "testnet",
    chainId: 5042002,
    chainIdHex: chainHex(5042002),
    rpc: "https://rpc.testnet.arc.io",
    explorer: "https://explorer.testnet.arc.io",
    name: "Arc Testnet",
  },
  mainnet: {
    key: "mainnet",
    chainId: 5042,
    chainIdHex: chainHex(5042),
    rpc: "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
    name: "Arc",
  },
}

const DEFAULT_SINGLE = 10_000n * MICRO
const DEFAULT_DAILY = 50_000n * MICRO

export function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value)
}

export function dollarsToMicro(amount) {
  const s = String(amount ?? "").trim()
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(s)) {
    throw new Error("金额须为最多 6 位小数的美元数字")
  }
  const [whole, frac = ""] = s.split(".")
  return BigInt(whole) * MICRO + BigInt(frac.padEnd(6, "0"))
}

export function microToDollars(micro) {
  const value = BigInt(micro)
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = abs / MICRO
  const frac = (abs % MICRO).toString().padStart(6, "0").replace(/0+$/, "")
  const text = frac ? `${whole}.${frac}` : `${whole}`
  return negative ? `-${text}` : text
}

export function microToNative(micro) {
  return BigInt(micro) * NATIVE_PER_MICRO
}

/** Official RPC wins when config still points at the old unofficial host. */
export function resolveRpc(env) {
  const mainnet = env?.NETWORK === "mainnet"
  const official = mainnet ? NETWORKS.mainnet.rpc : NETWORKS.testnet.rpc
  const configured = mainnet ? env?.ARC_MAINNET_RPC : env?.ARC_TESTNET_RPC
  if (!configured || typeof configured !== "string") return official
  try {
    const host = new URL(configured).host
    if (host === "testnet.arc.network" || host === "mainnet.arc.network") return official
  } catch {
    return official
  }
  return configured
}

export function activeNetwork(env) {
  return env?.NETWORK === "mainnet" ? NETWORKS.mainnet : NETWORKS.testnet
}

export function mainnetEnabled(env) {
  return env?.ARC_MAINNET_ENABLED === "true"
}

export function policyLimits(env) {
  const single = readLimit(env?.POLICY_MAX_SINGLE, DEFAULT_SINGLE)
  const daily = readLimit(env?.POLICY_MAX_DAILY, DEFAULT_DAILY)
  return { single, daily }
}

function readLimit(value, fallback) {
  if (value == null || value === "") return fallback
  try {
    return dollarsToMicro(value)
  } catch {
    return fallback
  }
}

export function encodeErc20Transfer(recipient, micro) {
  const addr = recipient.toLowerCase().replace(/^0x/, "").padStart(64, "0")
  const amount = BigInt(micro).toString(16).padStart(64, "0")
  return "0x" + TRANSFER_SELECTOR + addr + amount
}

export function decodeErc20Transfer(data) {
  if (typeof data !== "string") return null
  const hex = data.toLowerCase().replace(/^0x/, "")
  if (hex.length !== 8 + 64 + 64) return null
  if (!hex.startsWith(TRANSFER_SELECTOR)) return null
  const addressWord = hex.slice(8, 8 + 64)
  if (!addressWord.startsWith("0".repeat(24))) return null
  try {
    return {
      recipient: "0x" + addressWord.slice(24),
      micro: BigInt("0x" + hex.slice(8 + 64)),
    }
  } catch {
    return null
  }
}

export function decodePayment(tx) {
  if (!tx || !isAddress(tx.to || "")) {
    return { ok: false, reason: "交易缺少有效的 to 地址" }
  }
  const to = tx.to.toLowerCase()
  const data = typeof tx.data === "string" ? tx.data : "0x"
  const value = parseHexBigint(tx.value ?? "0x0")
  if (value == null) return { ok: false, reason: "value 不是合法整数" }

  const erc20 = to === USDC.toLowerCase() ? decodeErc20Transfer(data) : null
  if (erc20) {
    if (value !== 0n) return { ok: false, reason: "ERC-20 转账不能同时携带原生 value" }
    return { ok: true, method: "erc20", recipient: erc20.recipient, micro: erc20.micro }
  }

  const empty = data === "0x" || data === "0x0" || data === ""
  if (empty) {
    if (value <= 0n) return { ok: false, reason: "原生转账金额必须大于 0" }
    if (value % NATIVE_PER_MICRO !== 0n) {
      return { ok: false, reason: "原生 USDC 含有不足 0.000001 美元的尾数，拒绝入账" }
    }
    return { ok: true, method: "native", recipient: to, micro: value / NATIVE_PER_MICRO }
  }

  return { ok: false, reason: "只接受官方 USDC 的 transfer 或原生 USDC 转账" }
}

function parseHexBigint(value) {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value)
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

/**
 * ALLOW only when the unsigned transaction matches the intent and simulation succeeded.
 * Missing transaction or skipped simulation stays REVIEW. Unknown calls are BLOCK.
 */
export function evaluatePreflight({
  network,
  mainnetEnabled: mainnetOn,
  chainId,
  expectedChainId,
  recipient,
  amount,
  tx,
  daySpentMicro = 0n,
  maxSingleMicro = DEFAULT_SINGLE,
  maxDailyMicro = DEFAULT_DAILY,
  simulation = null,
  requireSimulation = true,
}) {
  if (network === "mainnet" && !mainnetOn) {
    return block("主网收款未开启")
  }
  if (chainId !== expectedChainId) {
    return block(`链 ID 不匹配，期望 ${expectedChainId}，实际 ${chainId}`)
  }
  if (!isAddress(recipient || "")) return block("收款地址无效")

  let micro
  try {
    micro = typeof amount === "bigint" ? amount : dollarsToMicro(amount)
  } catch (error) {
    return block(error.message)
  }
  if (micro <= 0n) return block("金额必须大于 0")

  const reasons = []
  let decision = "ALLOW"
  if (micro > maxSingleMicro) {
    decision = "REVIEW"
    reasons.push("超过单笔上限，当前没有人工审批，不能发出")
  }
  if (daySpentMicro + micro > maxDailyMicro) {
    decision = "BLOCK"
    reasons.push("超过当日上限")
  }

  if (!tx) {
    if (decision === "ALLOW") decision = "REVIEW"
    reasons.push("没有未签名交易。ALLOW 必须先解码并模拟 USDC 转账")
    return finish(decision, reasons, micro)
  }

  const decoded = decodePayment(tx)
  if (!decoded.ok) return block(decoded.reason)
  if (decoded.recipient !== recipient.toLowerCase()) return block("交易收款人与意图不一致")
  if (decoded.micro !== micro) return block("交易金额与意图不一致")

  if (requireSimulation) {
    if (!simulation) return block("缺少模拟结果")
    if (!simulation.ok) return block(simulation.error || "模拟失败")
  } else if (!simulation?.ok) {
    if (decision === "ALLOW") decision = "REVIEW"
    reasons.push("未执行模拟，不能视为可以签名")
  }

  return finish(decision, reasons, micro, decoded.method)
}

function finish(decision, reasons, micro, method) {
  return {
    decision,
    reasons,
    amountMicro: micro.toString(),
    amount: microToDollars(micro),
    method: method || null,
  }
}

function block(reason) {
  return { decision: "BLOCK", reasons: [reason], amountMicro: null, amount: null, method: null }
}

export function evaluateEvidence({ receipt, logs, expected }) {
  if (!receipt || receipt.status !== "0x1") {
    return { decision: "BLOCK", reasons: ["交易失败或不存在"] }
  }
  const parsed = parseMovements(logs || receipt.logs || [])
  if (!parsed.ok) return { decision: "BLOCK", reasons: [parsed.reason] }
  if (parsed.movements.length !== 1) {
    return { decision: "BLOCK", reasons: ["必须恰好有一笔 USDC 转移，发现了额外转账"] }
  }
  const movement = parsed.movements[0]
  if (movement.to !== expected.recipient.toLowerCase()) {
    return { decision: "BLOCK", reasons: ["链上收款人与账单不一致"] }
  }
  if (movement.micro !== BigInt(expected.amountMicro)) {
    return { decision: "BLOCK", reasons: ["链上金额与账单不一致"] }
  }
  if (expected.payer && movement.from !== expected.payer.toLowerCase()) {
    return { decision: "BLOCK", reasons: ["链上付款人与交易发送者不一致"] }
  }
  return {
    decision: "ALLOW",
    reasons: [],
    from: movement.from,
    to: movement.to,
    amountMicro: movement.micro.toString(),
    amount: microToDollars(movement.micro),
    streams: movement.streams,
  }
}

function parseMovements(logs) {
  const raw = []
  for (const log of logs) {
    const item = parseTransfer(log)
    if (item?.ignore) continue
    if (item?.error) return { ok: false, reason: item.error }
    if (item) raw.push(item)
  }
  const movements = []
  for (const item of raw) {
    const existing = movements.find(
      (row) => row.from === item.from && row.to === item.to && row.micro === item.micro,
    )
    if (existing) {
      if (existing.streams.includes(item.stream)) {
        return { ok: false, reason: "同一笔转移被重复记录" }
      }
      existing.streams.push(item.stream)
      continue
    }
    movements.push({ from: item.from, to: item.to, micro: item.micro, streams: [item.stream] })
  }
  return { ok: true, movements }
}

function parseTransfer(log) {
  if (!log?.address || !log.topics?.[0]) return { ignore: true }
  if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) return { ignore: true }
  const emitter = log.address.toLowerCase()
  const erc20 = emitter === USDC.toLowerCase()
  const system = emitter === SYSTEM_USDC_EMITTER.toLowerCase()
  if (!erc20 && !system) return { ignore: true }
  if (!log.topics[1] || !log.topics[2] || typeof log.data !== "string") {
    return { error: "Transfer 日志不完整" }
  }
  let value
  try {
    value = BigInt(log.data)
  } catch {
    return { error: "Transfer 金额无法解析" }
  }
  if (system && value % NATIVE_PER_MICRO !== 0n) {
    return { error: "系统 USDC 日志含有不能折算成 6 位小数的尾数" }
  }
  return {
    from: topicAddress(log.topics[1]),
    to: topicAddress(log.topics[2]),
    micro: system ? value / NATIVE_PER_MICRO : value,
    stream: system ? "system18" : "erc20",
  }
}

function topicAddress(topic) {
  return ("0x" + topic.toLowerCase().replace(/^0x/, "").slice(-40)).toLowerCase()
}
