import test from "node:test"
import assert from "node:assert/strict"
import { app } from "../src/index.js"
import { createMemoryRepo } from "../src/repo.js"
import { USDC, encodeErc20Transfer, dollarsToMicro, microToNative, SYSTEM_USDC_EMITTER, TRANSFER_TOPIC } from "../src/domain.js"

const owner = "0x1111111111111111111111111111111111111111"
const recipient = "0x2222222222222222222222222222222222222222"

function env() {
  return {
    REPO: createMemoryRepo(),
    NETWORK: "testnet",
    ARC_TESTNET_RPC: "https://rpc.testnet.arc.io",
    ARC_MAINNET_ENABLED: "false",
    TIER_FREE_LIMIT: "1000",
  }
}

test("free monthly calls reset and do not bill", async () => {
  const state = env()
  state.TIER_FREE_LIMIT = "1"
  state.NOW = "2026-09-01T00:00:00.000Z"
  const register = await app.request(
    "/api/register",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) },
    state,
  )
  const { apiKey } = await register.json()
  const headers = { "content-type": "application/json", "x-api-key": apiKey }
  const body = JSON.stringify({ recipient, amount: "1", purpose: "月度" })
  const first = await app.request("/api/links", { method: "POST", headers, body }, state)
  assert.equal(first.status, 200)
  const second = await app.request("/api/links", { method: "POST", headers, body }, state)
  assert.equal(second.status, 429)
  state.NOW = "2026-10-01T00:00:00.000Z"
  const third = await app.request("/api/links", { method: "POST", headers, body }, state)
  assert.equal(third.status, 200)
  assert.equal((await third.json()).pricing, "free")
})

test("upgrade is closed and registration stays free", async () => {
  const upgrade = await app.request("/api/upgrade", { method: "POST", body: "{}" }, env())
  assert.equal(upgrade.status, 410)
  const body = await upgrade.json()
  assert.equal(body.pricing, "free")

  const register = await app.request(
    "/api/register",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, tier: "pro" }) },
    env(),
  )
  assert.equal(register.status, 200)
  const created = await register.json()
  assert.equal(created.tier, "free")
  assert.equal(created.pricing, "free")
  assert.match(created.apiKey, /^arc_/)
})

test("payer can preflight a free link and settle only a matching receipt", async (t) => {
  const state = env()
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body)
    if (payload.method === "eth_chainId") return json({ result: "0x" + (5042002).toString(16) })
    if (payload.method === "eth_blockNumber") return json({ result: "0x10" })
    if (payload.method === "eth_call") return json({ result: "0x1" })
    if (payload.method === "eth_getTransactionByHash") {
      const micro = dollarsToMicro("1.25")
      return json({
        result: {
          from: owner,
          to: USDC,
          input: encodeErc20Transfer(recipient, micro),
          value: "0x0",
        },
      })
    }
    if (payload.method === "eth_getTransactionReceipt") {
      const micro = dollarsToMicro("1.25")
      return json({
        result: {
          status: "0x1",
          logs: [
            log(SYSTEM_USDC_EMITTER, owner, recipient, microToNative(micro)),
            log(USDC, owner, recipient, micro),
          ],
        },
      })
    }
    throw new Error(payload.method)
  }

  const register = await app.request(
    "/api/register",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) },
    state,
  )
  const { apiKey } = await register.json()
  const created = await app.request(
    "/api/links",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ recipient, amount: "1.25", purpose: "测试账单" }),
    },
    state,
  )
  assert.equal(created.status, 200)
  const link = await created.json()
  assert.equal(link.pricing, "free")

  const preflight = await app.request(
    `/api/links/${link.id}/preflight`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: owner }),
    },
    state,
  )
  const check = await preflight.json()
  assert.equal(check.decision, "ALLOW")
  assert.equal(check.tx.to, USDC)

  const evidence = await app.request(
    `/api/links/${link.id}/evidence`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash: "0x" + "ab".repeat(32) }),
    },
    state,
  )
  const settled = await evidence.json()
  assert.equal(settled.decision, "ALLOW")
  assert.equal(settled.status, "settled")
})

function json(body) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
}

function log(emitter, from, to, value) {
  return {
    address: emitter,
    topics: [TRANSFER_TOPIC, topic(from), topic(to)],
    data: "0x" + value.toString(16).padStart(64, "0"),
  }
}

function topic(address) {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0")
}
