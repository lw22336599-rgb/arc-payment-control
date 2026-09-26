import test from "node:test"
import assert from "node:assert/strict"
import {
  NETWORKS,
  USDC,
  SYSTEM_USDC_EMITTER,
  TRANSFER_TOPIC,
  dollarsToMicro,
  encodeErc20Transfer,
  decodeErc20Transfer,
  evaluateEvidence,
  evaluatePreflight,
  microToNative,
  resolveRpc,
} from "../src/domain.js"

const recipient = "0x2222222222222222222222222222222222222222"
const payer = "0x1111111111111111111111111111111111111111"

test("testnet chain id hex matches 5042002", () => {
  assert.equal(Number(BigInt(NETWORKS.testnet.chainIdHex)), 5042002)
  assert.equal(Number(BigInt(NETWORKS.mainnet.chainIdHex)), 5042)
})

test("dollar amounts use 6 decimal micro units", () => {
  assert.equal(dollarsToMicro("1"), 1_000_000n)
  assert.equal(dollarsToMicro("1.5"), 1_500_000n)
  assert.equal(dollarsToMicro("0.000001"), 1n)
  assert.throws(() => dollarsToMicro("1.0000001"))
})

test("erc20 transfer roundtrip", () => {
  const data = encodeErc20Transfer(recipient, 1_500_000n)
  const decoded = decodeErc20Transfer(data)
  assert.equal(decoded.recipient, recipient.toLowerCase())
  assert.equal(decoded.micro, 1_500_000n)
})

test("old unofficial rpc hosts are replaced", () => {
  assert.equal(
    resolveRpc({ NETWORK: "testnet", ARC_TESTNET_RPC: "https://testnet.arc.network" }),
    "https://rpc.testnet.arc.io",
  )
})

test("ALLOW requires a matching simulated transfer", () => {
  const tx = {
    to: USDC,
    data: encodeErc20Transfer(recipient, dollarsToMicro("2")),
    value: "0x0",
  }
  const allowed = evaluatePreflight({
    network: "testnet",
    mainnetEnabled: false,
    chainId: 5042002,
    expectedChainId: 5042002,
    recipient,
    amount: "2",
    tx,
    simulation: { ok: true },
  })
  assert.equal(allowed.decision, "ALLOW")

  const noTx = evaluatePreflight({
    network: "testnet",
    mainnetEnabled: false,
    chainId: 5042002,
    expectedChainId: 5042002,
    recipient,
    amount: "2",
  })
  assert.equal(noTx.decision, "REVIEW")

  const wrongToken = evaluatePreflight({
    network: "testnet",
    mainnetEnabled: false,
    chainId: 5042002,
    expectedChainId: 5042002,
    recipient,
    amount: "2",
    tx: { to: recipient, data: "0xdeadbeef", value: "0x0" },
    simulation: { ok: true },
  })
  assert.equal(wrongToken.decision, "BLOCK")
})

test("mainnet stays closed", () => {
  const result = evaluatePreflight({
    network: "mainnet",
    mainnetEnabled: false,
    chainId: 5042,
    expectedChainId: 5042,
    recipient,
    amount: "1",
    simulation: { ok: true },
  })
  assert.equal(result.decision, "BLOCK")
})

test("evidence accepts the paired 6-decimal and 18-decimal logs as one payment", () => {
  const micro = dollarsToMicro("3")
  const evidence = evaluateEvidence({
    receipt: { status: "0x1" },
    logs: [
      transferLog(SYSTEM_USDC_EMITTER, payer, recipient, microToNative(micro)),
      transferLog(USDC, payer, recipient, micro),
    ],
    expected: { recipient, amountMicro: micro.toString(), payer },
  })
  assert.equal(evidence.decision, "ALLOW")
  assert.deepEqual(evidence.streams.sort(), ["erc20", "system18"])
})

test("evidence blocks a second recipient", () => {
  const micro = dollarsToMicro("3")
  const other = "0x3333333333333333333333333333333333333333"
  const evidence = evaluateEvidence({
    receipt: { status: "0x1" },
    logs: [
      transferLog(USDC, payer, recipient, micro),
      transferLog(USDC, payer, other, micro),
    ],
    expected: { recipient, amountMicro: micro.toString(), payer },
  })
  assert.equal(evidence.decision, "BLOCK")
})

function transferLog(emitter, from, to, value) {
  return {
    address: emitter,
    topics: [TRANSFER_TOPIC, topic(from), topic(to)],
    data: "0x" + value.toString(16).padStart(64, "0"),
  }
}

function topic(address) {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0")
}
