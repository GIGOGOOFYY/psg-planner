const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'psg_planner.db'));

function hashPass(password) {
  return crypto.createHash('sha256').update('psg_salt_' + password).digest('hex');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'team',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,
    parent_order TEXT,
    height_mm REAL DEFAULT 0,
    width_mm REAL DEFAULT 0,
    order_date TEXT,
    delivery_date TEXT,
    order_type TEXT DEFAULT 'Architectural',
    client_name TEXT DEFAULT '',
    ct INTEGER DEFAULT 0,
    gr INTEGER DEFAULT 0,
    pe INTEGER DEFAULT 0,
    bv INTEGER DEFAULT 0,
    hl INTEGER DEFAULT 0,
    pr INTEGER DEFAULT 0,
    tg INTEGER DEFAULT 0,
    bg INTEGER DEFAULT 0,
    lg INTEGER DEFAULT 0,
    fr INTEGER DEFAULT 0,
    dg INTEGER DEFAULT 0,
    qc INTEGER DEFAULT 0,
    order_qty INTEGER DEFAULT 0,
    status TEXT DEFAULT 'Active',
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS wc_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    work_center TEXT NOT NULL,
    received_qty INTEGER DEFAULT 0,
    done_qty INTEGER DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    updated_by TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    UNIQUE(order_id, work_center)
  );

  CREATE TABLE IF NOT EXISTS ncr (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    work_center TEXT NOT NULL,
    qty_rejected INTEGER NOT NULL,
    type TEXT NOT NULL,
    reason TEXT,
    created_by TEXT,
    resolved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holiday_date TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS capacity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_center TEXT NOT NULL UNIQUE,
    capacity_sqft REAL NOT NULL
  );
`);

// Add missing columns if upgrading from v1 (safe to run repeatedly)
const alterStmts = [
  "ALTER TABLE orders ADD COLUMN parent_order TEXT",
  "ALTER TABLE orders ADD COLUMN pe INTEGER DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN bv INTEGER DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN qc INTEGER DEFAULT 0",
  "ALTER TABLE orders ADD COLUMN notes TEXT DEFAULT ''",
];
for (const stmt of alterStmts) {
  try { db.exec(stmt); } catch(e) { /* column already exists, skip */ }
}

// Seed capacity (add new WCs if missing)
try {
  db.exec(`
    INSERT OR IGNORE INTO capacity (work_center, capacity_sqft) VALUES
      ('CT',4500),('GR',3045),('PE',2500),('BV',1800),('HL',1917),
      ('PR',3825),('TG',3717),('BG',990),('LG',1800),('FR',1800),('DG',900),('QC',5000);

    INSERT OR IGNORE INTO holidays (holiday_date, name) VALUES
      ('2026-02-05','Kashmir Day'),
      ('2026-03-23','Pakistan Day'),
      ('2026-05-01','Labour Day'),
      ('2026-06-07','Eid al-Adha (Day 1)'),
      ('2026-06-08','Eid al-Adha (Day 2)'),
      ('2026-06-09','Eid al-Adha (Day 3)'),
      ('2026-08-14','Independence Day'),
      ('2026-11-09','Iqbal Day'),
      ('2026-12-25','Quaid-e-Azam Day');
  `);
} catch(e) {}

// Create default admin if no users exist
const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
if (userCount.cnt === 0) {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)').run(
    'admin', hashPass('admin123'), 'admin'
  );
  console.log('Default admin created: admin / admin123');
}

module.exports = { db, hashPass };
