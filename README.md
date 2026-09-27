# Arc 收款

Arc 测试网上的 USDC 收款页。付款前核对收款人、金额和用途；签名在付款人自己的钱包里；到账后用链上回执核对。

**现在全部免费。** 不向付款人收费，也不接受“转一笔 USDC 就升级”。主网收款关闭。

## 使用

```bash
npm install
npm test
npm run dev
```

线上页面：https://arc-payment-control.lw22336599.workers.dev

打开页面，连接钱包，填写金额，生成链接发给对方。对方需要 Arc 测试网 USDC，可从 [Circle 水龙头](https://faucet.circle.com) 领取。测试币没有真实价值。`/api/health` 返回的链 ID 是测试网 `5042002`。

## 给其他应用接入

付款人不用注册。商户登记一次，创建账单，把 `payUrl` 交给付款人。

```bash
curl -X POST http://127.0.0.1:8787/api/register \
  -H "content-type: application/json" \
  -d '{"owner":"0x你的钱包地址"}'

curl -X POST http://127.0.0.1:8787/api/links \
  -H "content-type: application/json" \
  -H "x-api-key: 上一步返回的 apiKey" \
  -d '{"recipient":"0x收款地址","amount":"1.00","purpose":"测试账单"}'
```

付款前调用 `POST /api/links/账单id/preflight`，正文只要 `{"from":"0x付款地址"}`。返回 `ALLOW` 才让钱包签名。交易上链后把哈希交给 `POST /api/links/账单id/evidence`。

调用次数按月清零，仍然免费。默认每月 1000 次，用完下月恢复。这不是价格。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 链 ID 必须是测试网 `5042002` |
| GET | `/api/config` | 钱包需要的网络参数 |
| POST | `/api/register` | 免费登记，忽略任何付费档位 |
| POST | `/api/upgrade` | 已关闭，返回 410 |
| POST | `/api/links` | 用 API key 创建收款链接 |
| POST | `/api/links/:id/preflight` | 付款人无需注册。只有模拟成功才返回 `ALLOW` |
| POST | `/api/links/:id/evidence` | 用回执核对，不一致不标记已付 |

官方 USDC：`0x3600000000000000000000000000000000000000`。转账按 6 位小数计算。原生 gas 是 18 位小数，两者不会混在同一个金额里。

## 边界

服务不保管私钥，不代替签名。停服不影响钱包里的 USDC。单笔默认不超过 10,000、当日不超过 50,000 个测试网 USDC，超出不会放行。这是限额，不是价格。
