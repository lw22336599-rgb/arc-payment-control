export function createSqlRepo(db) {
  return {
    async init() {
      if (!db) return
      await db.exec(`
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
        CREATE TABLE IF NOT EXISTS payment_links (
          id TEXT PRIMARY KEY,
          api_key TEXT NOT NULL,
          recipient TEXT NOT NULL,
          amount_micro TEXT NOT NULL,
          amount_display TEXT NOT NULL,
          purpose TEXT,
          status TEXT DEFAULT 'open',
          tx_hash TEXT,
          payer TEXT,
          evidence TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          settled_at TEXT
        );
      `)
      for (const sql of [
        "ALTER TABLE payment_intents ADD COLUMN amount_micro TEXT",
        "ALTER TABLE payment_intents ADD COLUMN purpose TEXT",
        "ALTER TABLE payment_intents ADD COLUMN created_day TEXT",
        "ALTER TABLE api_keys ADD COLUMN calls_month TEXT",
        "ALTER TABLE payment_links ADD COLUMN created_day TEXT",
      ]) {
        try {
          await db.exec(sql)
        } catch {
          /* column already exists */
        }
      }
    },
    async createKey({ key, owner }) {
      await db.prepare("INSERT INTO api_keys (key, tier, owner) VALUES (?, ?, ?)").bind(key, "free", owner).run()
    },
    async getKey(key, month) {
      const row = await db.prepare("SELECT * FROM api_keys WHERE key = ?").bind(key).first()
      if (!row || !month || row.calls_month === month) return row
      await db.prepare("UPDATE api_keys SET calls = 0, calls_month = ? WHERE key = ?").bind(month, key).run()
      return { ...row, calls: 0, calls_month: month }
    },
    async bumpCalls(key, month) {
      await db
        .prepare(
          "UPDATE api_keys SET calls = CASE WHEN calls_month = ? THEN calls + 1 ELSE 1 END, calls_month = ?, last_call = datetime('now') WHERE key = ?",
        )
        .bind(month, month, key)
        .run()
    },
    async insertIntent({ apiKey, recipient, amountDisplay, amountMicro, status, decision, purpose, day }) {
      const result = await db
        .prepare(
          "INSERT INTO payment_intents (api_key, recipient, amount, amount_micro, status, policy_decision, purpose, created_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(apiKey, recipient, amountDisplay, amountMicro, status, decision, purpose || null, day)
        .run()
      return result.meta?.last_row_id ?? null
    },
    async daySpentMicro(apiKey, day, exceptLinkId = "") {
      const intents = await db
        .prepare(
          "SELECT COALESCE(SUM(CAST(amount_micro AS INTEGER)), 0) AS total FROM payment_intents WHERE api_key = ? AND created_day = ? AND status != 'blocked'",
        )
        .bind(apiKey, day)
        .first()
      const links = await db
        .prepare(
          "SELECT COALESCE(SUM(CAST(amount_micro AS INTEGER)), 0) AS total FROM payment_links WHERE api_key = ? AND created_day = ? AND id != ? AND status != 'blocked'",
        )
        .bind(apiKey, day, exceptLinkId || "")
        .first()
      return BigInt(intents?.total ?? 0) + BigInt(links?.total ?? 0)
    },
    async audit(apiKey, action, detail) {
      await db
        .prepare("INSERT INTO audit_log (api_key, action, detail) VALUES (?, ?, ?)")
        .bind(apiKey, action, JSON.stringify(detail))
        .run()
    },
    async listAudit(apiKey) {
      const rows = await db
        .prepare("SELECT * FROM audit_log WHERE api_key = ? ORDER BY created_at DESC LIMIT 50")
        .bind(apiKey)
        .all()
      return rows.results || []
    },
    async createLink(link) {
      await db
        .prepare(
          "INSERT INTO payment_links (id, api_key, recipient, amount_micro, amount_display, purpose, status, created_day) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)",
        )
        .bind(link.id, link.apiKey, link.recipient, link.amountMicro, link.amountDisplay, link.purpose || null, link.day)
        .run()
    },
    async getLink(id) {
      return db.prepare("SELECT * FROM payment_links WHERE id = ?").bind(id).first()
    },
    async findLinkByTx(txHash) {
      return db.prepare("SELECT * FROM payment_links WHERE lower(tx_hash) = lower(?)").bind(txHash).first()
    },
    async settleLink({ id, txHash, payer, evidence }) {
      await db
        .prepare(
          "UPDATE payment_links SET status = 'settled', tx_hash = ?, payer = ?, evidence = ?, settled_at = datetime('now') WHERE id = ? AND status = 'open'",
        )
        .bind(txHash, payer, JSON.stringify(evidence), id)
        .run()
    },
  }
}

export function createMemoryRepo() {
  const keys = []
  const intents = []
  const audits = []
  const links = []
  return {
    async init() {},
    async createKey({ key, owner }) {
      keys.push({ key, tier: "free", owner, calls: 0 })
    },
    async getKey(key, month) {
      const row = keys.find((item) => item.key === key)
      if (!row) return null
      if (month && row.calls_month !== month) {
        row.calls = 0
        row.calls_month = month
      }
      return row
    },
    async bumpCalls(key, month) {
      const row = keys.find((item) => item.key === key)
      if (!row) return
      if (month && row.calls_month !== month) {
        row.calls = 0
        row.calls_month = month
      }
      row.calls += 1
    },
    async insertIntent(row) {
      intents.push(row)
      return intents.length
    },
    async daySpentMicro(apiKey, day, exceptLinkId = "") {
      const intentSum = intents
        .filter((row) => row.apiKey === apiKey && row.day === day && row.status !== "blocked")
        .reduce((sum, row) => sum + BigInt(row.amountMicro), 0n)
      const linkSum = links
        .filter((row) => row.apiKey === apiKey && row.day === day && row.id !== exceptLinkId && row.status !== "blocked")
        .reduce((sum, row) => sum + BigInt(row.amountMicro), 0n)
      return intentSum + linkSum
    },
    async audit(apiKey, action, detail) {
      audits.push({ api_key: apiKey, action, detail: JSON.stringify(detail) })
    },
    async listAudit(apiKey) {
      return audits.filter((row) => row.api_key === apiKey)
    },
    async createLink(link) {
      links.push({ ...link, status: "open", tx_hash: null, payer: null, evidence: null })
    },
    async getLink(id) {
      const row = links.find((link) => link.id === id)
      if (!row) return null
      return {
        ...row,
        amount_micro: row.amountMicro,
        amount_display: row.amountDisplay,
        tx_hash: row.tx_hash,
      }
    },
    async findLinkByTx(txHash) {
      const needle = txHash.toLowerCase()
      return links.find((link) => link.tx_hash && link.tx_hash.toLowerCase() === needle) || null
    },
    async settleLink({ id, txHash, payer, evidence }) {
      const row = links.find((link) => link.id === id && link.status === "open")
      if (!row) return
      row.status = "settled"
      row.tx_hash = txHash
      row.payer = payer
      row.evidence = JSON.stringify(evidence)
    },
  }
}
