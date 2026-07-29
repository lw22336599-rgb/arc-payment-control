## Arc Payment Policy Gateway — Free AI Agent USDC Payment Control on Arc Testnet

Built a non-custodial payment policy gateway for AI agents on Arc:

**What it does:**
- AI agents create auditable USDC payment intents
- Auto-enforce spending policies (per-tx limit: $10k, daily: $50k)
- On-chain verification via Arc RPC
- Full audit trail & reconciliation

**Tech stack:** Cloudflare Workers + D1 (SQLite), Hono.js, Arc network
**Deployed:** Live on testnet, zero-cost to run

Would love feedback from the Arc builder community! What other policy controls would be useful for agent payments?

**GitHub:** https://github.com/lw22336599-rgb/arc-payment-control
**API:** https://arc-payment-control.useful-ermine.workers.dev/api/health
