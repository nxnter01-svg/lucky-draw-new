const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const SUPABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres.arrgacekxogmejghbuih:25122467Nan_@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres';
const USE_SQLITE = process.env.USE_SQLITE === 'true';

let db = null;

function toPgSql(sql) {
  let converted = sql;

  // Replace INSERT OR IGNORE
  if (/INSERT\s+OR\s+IGNORE\s+INTO\s+ranks/i.test(converted)) {
    converted = converted.replace(/INSERT\s+OR\s+IGNORE\s+INTO\s+ranks/i, 'INSERT INTO ranks');
    if (!/ON\s+CONFLICT/i.test(converted)) {
      converted += ' ON CONFLICT (name) DO NOTHING';
    }
  } else if (/INSERT\s+OR\s+IGNORE\s+INTO\s+departments/i.test(converted)) {
    converted = converted.replace(/INSERT\s+OR\s+IGNORE\s+INTO\s+departments/i, 'INSERT INTO departments');
    if (!/ON\s+CONFLICT/i.test(converted)) {
      converted += ' ON CONFLICT (name) DO NOTHING';
    }
  } else if (/INSERT\s+OR\s+IGNORE\s+INTO\s+system_settings/i.test(converted)) {
    converted = converted.replace(/INSERT\s+OR\s+IGNORE\s+INTO\s+system_settings/i, 'INSERT INTO system_settings');
    if (!/ON\s+CONFLICT/i.test(converted)) {
      converted += ' ON CONFLICT (key) DO NOTHING';
    }
  }

  // Replace ? with $1, $2, etc.
  let paramIndex = 1;
  converted = converted.replace(/\?/g, () => `$${paramIndex++}`);

  return converted;
}

function preparePg(pool, sql) {
  const hasReturning = /RETURNING/i.test(sql);
  const isInsert = /^\s*INSERT\s+INTO/i.test(sql);
  let finalSql = toPgSql(sql);
  if (isInsert && !hasReturning && !/system_settings/i.test(sql)) {
    finalSql += ' RETURNING id';
  }

  const queue = [];
  let isFinalized = false;
  let finalizeCallback = null;
  let processing = false;

  async function processQueue() {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        const res = await pool.query(finalSql, item.params);
        const ctx = {
          lastID: res && res.rows && res.rows[0] ? res.rows[0].id : undefined,
          changes: res ? res.rowCount : 0
        };
        if (item.callback) item.callback.call(ctx, null);
      } catch (err) {
        if (item.callback) item.callback.call({}, err);
      }
    }
    if (isFinalized && finalizeCallback) {
      finalizeCallback(null);
      finalizeCallback = null;
    }
  }

  function trigger() {
    if (processing) return;
    processing = true;
    processQueue().finally(() => {
      processing = false;
      if (queue.length > 0 || (isFinalized && finalizeCallback)) {
        trigger();
      }
    });
  }

  return {
    run(...args) {
      let callback = null;
      if (typeof args[args.length - 1] === 'function') {
        callback = args.pop();
      }
      queue.push({ params: args, callback });
      trigger();
    },
    finalize(cb) {
      isFinalized = true;
      finalizeCallback = cb || (() => {});
      trigger();
    }
  };
}

if (!USE_SQLITE && SUPABASE_URL) {
  console.log('Connecting to PostgreSQL (Supabase)...');
  const pool = new Pool({
    connectionString: SUPABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  pool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL client', err);
  });

  db = {
    isPostgres: true,
    all(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      const pgSql = toPgSql(sql);
      pool.query(pgSql, params || [], (err, res) => {
        if (callback) callback(err, res ? res.rows : []);
      });
    },

    get(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      const pgSql = toPgSql(sql);
      pool.query(pgSql, params || [], (err, res) => {
        if (callback) callback(err, res && res.rows.length > 0 ? res.rows[0] : null);
      });
    },

    run(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      const hasReturning = /RETURNING/i.test(sql);
      const isInsert = /^\s*INSERT\s+INTO/i.test(sql);
      let pgSql = toPgSql(sql);
      if (isInsert && !hasReturning && !/system_settings/i.test(sql)) {
        pgSql += ' RETURNING id';
      }
      pool.query(pgSql, params || [], (err, res) => {
        const ctx = {
          lastID: res && res.rows && res.rows[0] ? res.rows[0].id : undefined,
          changes: res ? res.rowCount : 0
        };
        if (callback) callback.call(ctx, err);
      });
    },

    serialize(fn) {
      if (typeof fn === 'function') fn();
    },

    prepare(sql) {
      return preparePg(pool, sql);
    }
  };

  // Ensure tables exist on Supabase
  pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ranks (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      order_index INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      emp_code TEXT UNIQUE,
      name TEXT NOT NULL,
      department TEXT,
      status TEXT DEFAULT 'eligible',
      rank TEXT,
      first_name TEXT,
      last_name TEXT,
      special_type TEXT DEFAULT 'ปกติ'
    );
    CREATE TABLE IF NOT EXISTS prizes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      total_amount INTEGER DEFAULT 1,
      remaining_amount INTEGER DEFAULT 1,
      image_url TEXT,
      allow_on_duty INTEGER DEFAULT 1,
      allow_mission INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS winners (
      id SERIAL PRIMARY KEY,
      prize_id INTEGER REFERENCES prizes(id) ON DELETE CASCADE,
      employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      won_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS locked_winners (
      id SERIAL PRIMARY KEY,
      prize_id INTEGER REFERENCES prizes(id) ON DELETE CASCADE,
      employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT INTO system_settings (key, value) VALUES ('registration_open', 'true') ON CONFLICT (key) DO NOTHING;
  `).then(() => {
    console.log('Connected to PostgreSQL (Supabase) and tables verified.');
  }).catch((err) => {
    console.error('Error verifying Supabase tables:', err);
  });

} else {
  console.log('Connecting to local SQLite database...');
  const sqliteDb = new sqlite3.Database(path.join(__dirname, 'database.db'), (err) => {
    if (err) console.error("Database connection error:", err.message);
    else console.log("Connected to SQLite database.");
  });

  sqliteDb.serialize(() => {
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)`);
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS ranks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, order_index INTEGER DEFAULT 0)`);
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY AUTOINCREMENT, emp_code TEXT UNIQUE, name TEXT NOT NULL, department TEXT, status TEXT DEFAULT 'eligible', rank TEXT, first_name TEXT, last_name TEXT, special_type TEXT DEFAULT 'ปกติ')`);
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS prizes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, total_amount INTEGER DEFAULT 1, remaining_amount INTEGER DEFAULT 1, image_url TEXT, allow_on_duty INTEGER DEFAULT 1, allow_mission INTEGER DEFAULT 1)`);
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS winners (id INTEGER PRIMARY KEY AUTOINCREMENT, prize_id INTEGER, employee_id INTEGER, won_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(prize_id) REFERENCES prizes(id), FOREIGN KEY(employee_id) REFERENCES employees(id))`);
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS locked_winners (id INTEGER PRIMARY KEY AUTOINCREMENT, prize_id INTEGER, employee_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(prize_id) REFERENCES prizes(id), FOREIGN KEY(employee_id) REFERENCES employees(id))`);
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT)`);
    sqliteDb.run(`INSERT OR IGNORE INTO system_settings (key, value) VALUES ('registration_open', 'true')`);
  });

  db = sqliteDb;
}

module.exports = db;
