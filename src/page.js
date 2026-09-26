export function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Arc 收款</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font: 16px/1.5 "Segoe UI", sans-serif; background: #f6f4ef; color: #1c1915; }
    main { max-width: 40rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
    h1 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 .5rem; }
    p { margin: 0 0 1rem; }
    .banner { background: #fff; border: 1px solid #e4ddd2; padding: .75rem 1rem; margin: 1rem 0 1.5rem; }
    label { display: block; font-size: .85rem; margin: .8rem 0 .25rem; }
    input, textarea { width: 100%; box-sizing: border-box; padding: .6rem .7rem; border: 1px solid #cfc6ba; background: #fff; font: inherit; }
    button { margin-top: 1rem; background: #1c1915; color: #fff; border: 0; padding: .7rem 1rem; font: inherit; cursor: pointer; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    code, .mono { font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
    .result { margin-top: 1rem; background: #fff; border: 1px solid #e4ddd2; padding: 1rem; }
    .warn { color: #8a3b12; }
    a { color: #1c1915; }
  </style>
</head>
<body>
  <main>
    <h1>在 Arc 测试网收款</h1>
    <p>付款前核对收款人、金额和用途。签名在你自己的钱包里完成。当前全部免费，不托管资金。</p>
    <div class="banner" id="banner">正在读取网络配置…</div>
    <section id="merchant">
      <label for="recipient">收款地址</label>
      <input id="recipient" autocomplete="off" placeholder="0x…" />
      <label for="amount">金额（测试网 USDC）</label>
      <input id="amount" inputmode="decimal" placeholder="1.00" />
      <label for="purpose">用途</label>
      <textarea id="purpose" rows="2" maxlength="120" placeholder="这笔钱是给什么的"></textarea>
      <button id="create" type="button">生成免费收款链接</button>
    </section>
    <section id="payer" hidden>
      <h2 id="pay-title">付款</h2>
      <p id="pay-detail"></p>
      <button id="pay" type="button">用钱包支付测试币</button>
    </section>
    <div class="result" id="result" hidden></div>
  </main>
  <script>
    const result = document.querySelector("#result")
    const banner = document.querySelector("#banner")
    const paySection = document.querySelector("#payer")
    const merchant = document.querySelector("#merchant")
    let config = null

    function show(text, warn) {
      result.hidden = false
      result.textContent = text
      result.className = warn ? "result warn" : "result"
    }

    function payId() {
      const parts = location.pathname.split("/").filter(Boolean)
      return parts[0] === "pay" ? parts[1] : ""
    }

    async function loadConfig() {
      const res = await fetch("/api/config")
      config = await res.json()
      banner.textContent = config.network === "testnet"
        ? "Arc 测试网 · 测试币没有真实价值 · 全部免费 · 我们不保管私钥"
        : "当前网络不是测试网，页面已停止付款。"
    }

    async function connect() {
      if (!window.ethereum) throw new Error("没有检测到钱包。请先安装 MetaMask 或 Phantom。")
      const accounts = await ethereum.request({ method: "eth_requestAccounts" })
      const from = accounts[0]
      try {
        await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: config.chainIdHex }] })
      } catch (error) {
        if (error.code !== 4902) throw error
        await ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: config.chainIdHex,
            chainName: config.name,
            nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
            rpcUrls: [config.rpc],
            blockExplorerUrls: [config.explorer],
          }],
        })
      }
      return from
    }

    async function createLink() {
      if (config.network !== "testnet" || config.mainnetEnabled) {
        show("只生成 Arc 测试网账单。", true)
        return
      }
      const from = await connect()
      const recipient = document.querySelector("#recipient").value.trim() || from
      const amount = document.querySelector("#amount").value.trim()
      const purpose = document.querySelector("#purpose").value.trim()
      let apiKey = localStorage.getItem("arcApiKey")
      if (!apiKey) {
        const reg = await fetch("/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner: from }),
        })
        const created = await reg.json()
        if (!reg.ok) throw new Error(created.error || "注册失败")
        apiKey = created.apiKey
        localStorage.setItem("arcApiKey", apiKey)
      }
      const res = await fetch("/api/links", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ recipient, amount, purpose }),
      })
      const link = await res.json()
      if (!res.ok) throw new Error(link.error || "创建失败")
      show("收款链接（免费）：\\n" + link.payUrl)
    }

    async function loadBill() {
      const id = payId()
      if (!id) return
      merchant.hidden = true
      paySection.hidden = false
      const res = await fetch("/api/links/" + id)
      const bill = await res.json()
      if (!res.ok) {
        show(bill.error || "账单不存在", true)
        document.querySelector("#pay").disabled = true
        return
      }
      document.querySelector("#pay-detail").textContent =
        bill.amount + " 测试网 USDC · " + (bill.purpose || "无用途说明") + " · 收款 " + bill.recipient
      if (bill.status !== "open") {
        document.querySelector("#pay").disabled = true
        show("这笔账单已结算。交易 " + (bill.txHash || ""))
      }
      document.querySelector("#pay").onclick = () => payBill(bill)
    }

    async function payBill(bill) {
      const from = await connect()
      const pre = await fetch("/api/links/" + bill.id + "/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from }),
      })
      const check = await pre.json()
      if (check.decision !== "ALLOW" || !check.tx) {
        show((check.reasons || [check.error || "不能支付"]).join("\\n"), true)
        return
      }
      const gas = await ethereum.request({ method: "eth_gasPrice" })
      const min = BigInt(config.minMaxFeePerGas)
      const price = BigInt(gas)
      const maxFee = price > min ? price : min
      const txHash = await ethereum.request({
        method: "eth_sendTransaction",
        params: [{
          from,
          to: check.tx.to,
          data: check.tx.data,
          value: check.tx.value,
          maxFeePerGas: "0x" + maxFee.toString(16),
          maxPriorityFeePerGas: "0x0",
        }],
      })
      let evidence = null
      for (let attempt = 0; attempt < 8; attempt++) {
        const done = await fetch("/api/links/" + bill.id + "/evidence", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ txHash }),
        })
        evidence = await done.json()
        if (evidence.decision === "ALLOW") break
        const pending = (evidence.reasons || []).some((reason) => reason.indexOf("尚未上链") >= 0)
        if (!pending) break
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      if (evidence.decision === "ALLOW") {
        show("已核对到账。交易 " + txHash + "\\n浏览器：" + config.explorer + "/tx/" + txHash)
      } else {
        show("交易已发送，但证据未通过：\\n" + (evidence.reasons || []).join("\\n") + "\\n" + txHash, true)
      }
    }

    document.querySelector("#create").onclick = () => createLink().catch((error) => show(error.message, true))
    loadConfig().then(loadBill).catch((error) => show(error.message, true))
  </script>
</body>
</html>`
}
