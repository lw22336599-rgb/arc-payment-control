# Arc Payment Policy Gateway

**AI Agent USDC支付控制面板 — 用于Arc Testnet**

非托管的支付意图系统，让AI代理在Arc链上安全地创建、审计USDC支付，无需暴露私钥。

## 功能

- 🔐 **支付意图创建** — AI Agent发起支付请求，系统记录并排队
- 🛡️ **策略检查引擎** — 自动检查单笔上限($10k)、日限额($50k)，允许/拒绝/审批
- 🔍 **链上交易查询** — 通过Arc RPC实时查询链上交易状态
- 📊 **自动对账** — 将链上交易与本地记录自动匹配
- 📋 **审计日志** — 完整记录所有操作的不可篡改日志
- 💳 **分等级API** — Free Tier（1,000次/月），Pro Tier（50,000次/月，$50/月）

## 快速开始

### 注册API Key

```bash
curl -X POST https://arc-payment-control.useful-ermine.workers.dev/api/register \
  -H "Content-Type: application/json" \
  -d '{"owner":"你的Arc钱包地址"}'
```

### 创建支付意图

```bash
curl -X POST https://arc-payment-control.useful-ermine.workers.dev/api/payment/intent \
  -H "Content-Type: application/json" \
  -H "x-api-key: 你的API_KEY" \
  -d '{"recipient":"0x...","amount":"100"}'
```

### 检查策略

```bash
curl -X POST https://arc-payment-control.useful-ermine.workers.dev/api/policy/check \
  -H "Content-Type: application/json" \
  -H "x-api-key: 你的API_KEY" \
  -d '{"amount":"100","recipient":"0x..."}'
```

## API 文档

| 端点 | Method | 说明 |
|------|--------|------|
| `/api/health` | GET | 健康检查 & 网络状态 |
| `/api/register` | POST | 注册API Key |
| `/api/payment/intent` | POST | 创建支付意图 |
| `/api/policy/check` | POST | 策略合规检查 |
| `/api/transactions/:hash` | GET | 查询链上交易 |
| `/api/reconciliation` | POST | 执行对账 |
| `/api/audit` | GET | 获取审计日志 |
| `/api/upgrade` | POST | 升级到Pro |

## 升级到Pro

支付USDC到 `0xf1437d9cd304ae49f2ec005ac967813b3a7c466c`，然后调用upgrade接口：

```bash
curl -X POST https://arc-payment-control.useful-ermine.workers.dev/api/upgrade \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"你的API_KEY","txHash":"USDC转账交易哈希"}'
```

## 技术栈

- **Runtime**: Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite)
- **Framework**: Hono.js
- **Blockchain**: Arc Network (EVM-compatible)

## 部署

```bash
npm install
npx wrangler deploy
```

## 架构

```
AI Agent → Payment Intent → Policy Check → Arc RPC → Audit Log
                                                     ↓
                                            Reconciliation
```

## 钱包地址（收款）

`0xf1437d9cd304ae49f2ec005ac967813b3a7c466c`

## License

MIT
