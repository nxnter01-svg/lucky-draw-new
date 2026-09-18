const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.redirect('/stage.html');
});

const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error("Database connection error:", err.message);
  else console.log("Connected to SQLite database.");
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ranks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, order_index INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT, emp_code TEXT UNIQUE,
    name TEXT NOT NULL, department TEXT, status TEXT DEFAULT 'eligible',
    rank TEXT, first_name TEXT, last_name TEXT
  )`);
  // Migration for existing tables without rank, first_name, last_name, order_index
  db.run(`ALTER TABLE employees ADD COLUMN rank TEXT`, () => {});
  db.run(`ALTER TABLE employees ADD COLUMN first_name TEXT`, () => {});
  db.run(`ALTER TABLE employees ADD COLUMN last_name TEXT`, () => {});
  db.run(`ALTER TABLE ranks ADD COLUMN order_index INTEGER DEFAULT 0`, () => {
    db.run(`UPDATE ranks SET order_index = id WHERE order_index IS NULL OR order_index = 0`);
  });

  db.run(`CREATE TABLE IF NOT EXISTS prizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    total_amount INTEGER DEFAULT 1, remaining_amount INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prize_id INTEGER,
    employee_id INTEGER, won_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(prize_id) REFERENCES prizes(id),
    FOREIGN KEY(employee_id) REFERENCES employees(id)
  )`);

  // Seed default ranks if empty
  db.get("SELECT COUNT(*) as count FROM ranks", (err, row) => {
    if (!err && row && row.count === 0) {
      const defaultRanks = [
        'พลฯ', 'จ.ต.', 'จ.ท.', 'จ.อ.', 'พ.อ.ต.', 'พ.อ.ท.', 'พ.อ.อ.',
        'ร.ต.', 'ร.ท.', 'ร.อ.', 'น.ต.', 'น.ท.', 'น.อ.',
        'พล.อ.ต.', 'พล.อ.ท.', 'พล.อ.', 'นาย', 'นาง', 'นางสาว'
      ];
      const stmt = db.prepare("INSERT OR IGNORE INTO ranks (name, order_index) VALUES (?, ?)");
      defaultRanks.forEach((r, idx) => stmt.run(r, idx + 1));
      stmt.finalize();
    } else {
      db.run(`UPDATE ranks SET order_index = id WHERE order_index IS NULL OR order_index = 0`);
    }
  });
});

// APIs - Departments
app.get('/api/departments', (req, res) => {
  db.all("SELECT * FROM departments ORDER BY id ASC", [], (err, rows) => res.json(rows || []));
});
app.post('/api/departments', (req, res) => {
  db.run(`INSERT INTO departments (name) VALUES (?)`, [req.body.name], function (err) {
    if (err) return res.status(400).json({ error: "สังกัดนี้มีอยู่ในระบบแล้ว" });
    res.json({ id: this.lastID, name: req.body.name });
  });
});
app.delete('/api/departments/:id', (req, res) => {
  db.run(`DELETE FROM departments WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

// APIs - Ranks (ยศ)
app.get('/api/ranks', (req, res) => {
  db.all("SELECT * FROM ranks ORDER BY order_index ASC, id ASC", [], (err, rows) => res.json(rows || []));
});
app.post('/api/ranks', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "กรุณาระบุชื่อยศ" });
  db.get("SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order FROM ranks", (err, row) => {
    const nextOrder = (row && row.next_order) ? row.next_order : 1;
    db.run(`INSERT INTO ranks (name, order_index) VALUES (?, ?)`, [name.trim(), nextOrder], function (err) {
      if (err) return res.status(400).json({ error: "ยศนี้มีอยู่แล้ว" });
      res.json({ id: this.lastID, name: name.trim(), order_index: nextOrder });
    });
  });
});
app.post('/api/ranks/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return res.status(400).json({ error: "ข้อมูล orderedIds ไม่ถูกต้อง" });
  }
  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    const stmt = db.prepare("UPDATE ranks SET order_index = ? WHERE id = ?");
    orderedIds.forEach((id, index) => {
      stmt.run(index + 1, id);
    });
    stmt.finalize((err) => {
      if (err) {
        db.run("ROLLBACK");
        return res.status(500).json({ error: "เกิดข้อผิดพลาดในการจัดลำดับยศ" });
      }
      db.run("COMMIT", () => {
        res.json({ success: true, message: "บันทึกลำดับยศเรียบร้อยแล้ว" });
      });
    });
  });
});
app.put('/api/ranks/:id', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "กรุณาระบุชื่อยศ" });
  db.run(`UPDATE ranks SET name = ? WHERE id = ?`, [name.trim(), req.params.id], function (err) {
    if (err) return res.status(400).json({ error: "เกิดข้อผิดพลาดหรือชื่อยศซ้ำ" });
    res.json({ success: true, id: req.params.id, name: name.trim() });
  });
});
app.delete('/api/ranks/:id', (req, res) => {
  db.run(`DELETE FROM ranks WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

// APIs - Employees (เรียงตามลำดับยศ และชื่อตามตัวอักษร ก-ฮ)
app.get('/api/employees', (req, res) => {
  const { department } = req.query;
  let sql = `
    SELECT e.*, COALESCE(r.order_index, 999999) AS rank_order
    FROM employees e
    LEFT JOIN ranks r ON e.rank = r.name
  `;
  let params = [];
  if (department && department !== 'all') {
    sql += ` WHERE e.department = ? `;
    params.push(department);
  }

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: "Database error" });
    const employees = rows || [];
    employees.sort((a, b) => {
      // 1. เรียงตามลำดับยศ (rank_order)
      const orderA = a.rank_order !== undefined && a.rank_order !== null ? a.rank_order : 999999;
      const orderB = b.rank_order !== undefined && b.rank_order !== null ? b.rank_order : 999999;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      // 2. ถ้าลำดับยศเท่ากัน ให้เรียงตามชื่อตามตัวอักษรไทย (ก-ฮ)
      const firstNameA = (a.first_name || a.name || '').trim();
      const firstNameB = (b.first_name || b.name || '').trim();
      const compFirst = firstNameA.localeCompare(firstNameB, 'th', { sensitivity: 'base' });
      if (compFirst !== 0) {
        return compFirst;
      }
      // 3. ถ้าชื่อเหมือนกัน ให้เรียงตามนามสกุลตามตัวอักษรไทย
      const lastNameA = (a.last_name || '').trim();
      const lastNameB = (b.last_name || '').trim();
      return lastNameA.localeCompare(lastNameB, 'th', { sensitivity: 'base' });
    });
    res.json(employees);
  });
});

// ตรวจสอบชื่อซ้ำ
app.get('/api/employees/check-duplicate', (req, res) => {
  const { first_name, last_name, name } = req.query;
  const cleanFirst = (first_name || '').trim();
  const cleanLast = (last_name || '').trim();
  const rawName = (name || '').trim();

  if (!cleanFirst && !cleanLast && !rawName) {
    return res.json({ exists: false });
  }

  let query = `
    SELECT id, emp_code, name, department 
    FROM employees 
    WHERE (first_name IS NOT NULL AND first_name != '' AND TRIM(first_name) = ? AND TRIM(last_name) = ?)
       OR TRIM(name) = ?
       OR TRIM(name) = ?
  `;
  let params = [cleanFirst, cleanLast, `${cleanFirst} ${cleanLast}`.trim(), rawName || cleanFirst];

  db.get(query, params, (err, row) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (row) {
      return res.json({ exists: true, employee: row });
    }
    return res.json({ exists: false });
  });
});

app.post('/api/employees', (req, res) => {
  let { name, department, rank, first_name, last_name } = req.body;
  
  first_name = (first_name || '').trim();
  last_name = (last_name || '').trim();
  rank = (rank || '').trim();

  if (!name && first_name && last_name) {
    name = rank ? `${rank} ${first_name} ${last_name}` : `${first_name} ${last_name}`;
  }
  name = (name || '').trim();

  if (!name && !first_name) {
    return res.status(400).json({ error: "กรุณาระบุชื่อ-นามสกุล" });
  }

  // ตรวจสอบชื่อซ้ำในระบบ
  let checkQuery = `
    SELECT id, emp_code, name, department 
    FROM employees 
    WHERE (first_name IS NOT NULL AND first_name != '' AND TRIM(first_name) = ? AND TRIM(last_name) = ?)
       OR TRIM(name) = ?
       OR TRIM(name) = ?
  `;
  let checkParams = [first_name, last_name, `${first_name} ${last_name}`.trim(), name];

  db.get(checkQuery, checkParams, (err, existing) => {
    if (err) return res.status(500).json({ error: "เกิดข้อผิดพลาดในการตรวจสอบข้อมูล" });
    if (existing) {
      return res.status(400).json({ 
        error: `รายชื่อนี้ (${existing.name}) ได้ลงทะเบียนไปแล้วในสังกัด "${existing.department}" (รหัส: ${existing.emp_code}) ไม่สามารถลงทะเบียนซ้ำได้` 
      });
    }

    // สุ่มเลขรหัส 5 หลัก (เช่น 49215)
    const randomCode = Math.floor(10000 + Math.random() * 90000).toString();
    const emp_code = `EMP-${randomCode}`;

    db.run(`INSERT INTO employees (emp_code, name, department, rank, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)`, 
      [emp_code, name, department, rank || null, first_name || null, last_name || null], 
      function (err) {
        if (err) return res.status(400).json({ error: "เกิดข้อผิดพลาดในการบันทึกข้อมูล" });
        res.json({ id: this.lastID, emp_code, name, department, rank, first_name, last_name, status: 'eligible' });
    });
  });
});
app.delete('/api/employees/:id', (req, res) => {
  db.run(`DELETE FROM employees WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.get('/api/prizes', (req, res) => {
  const { all } = req.query;
  if (all === 'true') {
    db.all("SELECT * FROM prizes ORDER BY (remaining_amount > 0) DESC, id ASC", [], (err, rows) => res.json(rows || []));
  } else {
    db.all("SELECT * FROM prizes WHERE remaining_amount > 0 ORDER BY id ASC", [], (err, rows) => res.json(rows || []));
  }
});
app.get('/api/admin/prizes', (req, res) => {
  db.all("SELECT * FROM prizes ORDER BY id DESC", [], (err, rows) => res.json(rows || []));
});
app.post('/api/prizes', (req, res) => {
  const { name, total_amount } = req.body;
  db.run(`INSERT INTO prizes (name, total_amount, remaining_amount) VALUES (?, ?, ?)`, [name, total_amount, total_amount], function (err) {
    res.json({ id: this.lastID, name, total_amount, remaining_amount: total_amount });
  });
});
app.delete('/api/prizes/:id', (req, res) => {
  db.run(`DELETE FROM prizes WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

// นับจำนวนผู้มีสิทธิ์จับฉลากตามสังกัดที่เลือก
app.get('/api/eligible-count', (req, res) => {
  const { departments } = req.query;
  let query = "SELECT COUNT(*) as count FROM employees WHERE status = 'eligible'";
  let params = [];

  if (departments && departments !== 'all') {
    const deptList = departments.split(',').map(d => d.trim()).filter(Boolean);
    if (deptList.length > 0) {
      const placeholders = deptList.map(() => '?').join(',');
      query += ` AND department IN (${placeholders})`;
      params = deptList;
    }
  }

  db.get(query, params, (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ count: row ? row.count : 0 });
  });
});

app.post('/api/draw', (req, res) => {
  let { prize_id, departments, count } = req.body;
  const drawCount = Math.max(1, Math.min(10, parseInt(count) || 1));
  
  let empQuery = "SELECT * FROM employees WHERE status = 'eligible'";
  let empParams = [];

  if (departments && departments !== 'all') {
    const deptList = Array.isArray(departments) 
      ? departments 
      : departments.split(',').map(d => d.trim()).filter(Boolean);
    
    if (deptList.length > 0) {
      const placeholders = deptList.map(() => '?').join(',');
      empQuery += ` AND department IN (${placeholders})`;
      empParams = deptList;
    }
  }

  db.all(empQuery, empParams, (err, employees) => {
    if (err) return res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูลผู้มีสิทธิ์" });
    if (!employees || employees.length === 0) {
      return res.status(400).json({ error: "ไม่มีผู้มีสิทธิ์เหลือแล้วในเงื่อนไขสังกัดที่เลือก" });
    }

    if (employees.length < drawCount) {
      return res.status(400).json({ 
        error: `มีผู้มีสิทธิ์เหลือเพียง ${employees.length} คน (ต้องการสุ่ม ${drawCount} คน) กรุณาลดจำนวนที่ต้องการสุ่ม` 
      });
    }

    db.get("SELECT * FROM prizes WHERE id = ? AND remaining_amount > 0", [prize_id], (err, prize) => {
      if (err || !prize) return res.status(400).json({ error: "ของรางวัลนี้หมดแล้ว หรือไม่พบข้อมูล" });

      if (prize.remaining_amount < drawCount) {
        return res.status(400).json({ 
          error: `ของรางวัลเหลือเพียง ${prize.remaining_amount} รางวัล (ต้องการสุ่ม ${drawCount} คน) กรุณาลดจำนวนที่ต้องการสุ่ม` 
        });
      }

      // สุ่มเลือกผู้โชคดีแบบไม่ซ้ำกันจำนวน drawCount คน (Fisher-Yates shuffle)
      const shuffled = [...employees];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const pickedWinners = shuffled.slice(0, drawCount);

      db.serialize(() => {
        const winnerIds = [];
        const updateEmpStmt = db.prepare("UPDATE employees SET status = 'won' WHERE id = ?");
        const insertWinnerStmt = db.prepare("INSERT INTO winners (prize_id, employee_id) VALUES (?, ?)");

        pickedWinners.forEach(winner => {
          updateEmpStmt.run(winner.id);
          insertWinnerStmt.run(prize_id, winner.id, function() {
            winnerIds.push({ winner_id: this.lastID, employee_id: winner.id, employee: winner });
          });
        });

        updateEmpStmt.finalize();
        insertWinnerStmt.finalize();

        db.run("UPDATE prizes SET remaining_amount = remaining_amount - ? WHERE id = ?", [drawCount, prize_id], (err) => {
          if (err) return res.status(500).json({ error: "เกิดข้อผิดพลาดในการปรับปรุงยอดรางวัล" });

          res.json({
            success: true,
            count: drawCount,
            winners: pickedWinners,
            winner_ids: winnerIds,
            prize: {
              ...prize,
              remaining_amount: prize.remaining_amount - drawCount
            },
            // สำหรับ backward compatibility
            winner: pickedWinners[0]
          });
        });
      });
    });
  });
});

// ยกเลิกผลรางวัล / สละสิทธิ์ (กรณีไม่อยู่ในงาน หรือโมฆะ)
app.post('/api/winners/:id/cancel', (req, res) => {
  const winnerId = req.params.id;
  const { new_status } = req.body; // 'absent' (ไม่อยู่ในงาน) หรือ 'eligible' (คืนสิทธิ์)
  const empStatus = new_status === 'eligible' ? 'eligible' : 'absent';

  db.get("SELECT * FROM winners WHERE id = ?", [winnerId], (err, winner) => {
    if (err || !winner) return res.status(404).json({ error: "ไม่พบประวัติรางวัลนี้" });

    db.serialize(() => {
      // คืนของรางวัลกลับเข้าระบบ
      db.run("UPDATE prizes SET remaining_amount = remaining_amount + 1 WHERE id = ?", [winner.prize_id]);
      // ปรับสถานะพนักงาน
      db.run("UPDATE employees SET status = ? WHERE id = ?", [empStatus, winner.employee_id]);
      // ลบจากรายการผู้ได้รับรางวัล
      db.run("DELETE FROM winners WHERE id = ?", [winnerId]);

      res.json({ 
        success: true, 
        message: "ยกเลิกผลรางวัลเรียบร้อย",
        prize_id: winner.prize_id,
        employee_id: winner.employee_id,
        status: empStatus
      });
    });
  });
});

// รายชื่อผู้ได้รับรางวัลทั้งหมด พร้อมรายละเอียดครบถ้วน
app.get('/api/winners', (req, res) => {
  const query = `
    SELECT 
      winners.id, 
      winners.prize_id,
      winners.employee_id,
      winners.won_at,
      employees.name as employee_name, 
      employees.rank,
      employees.first_name,
      employees.last_name,
      employees.emp_code,
      employees.department, 
      prizes.name as prize_name
    FROM winners 
    JOIN employees ON winners.employee_id = employees.id 
    JOIN prizes ON winners.prize_id = prizes.id 
    ORDER BY winners.id DESC
  `;
  db.all(query, [], (err, rows) => res.json(rows || []));
});

// Helper: ดึง IPv4 ของเครื่องในวง LAN สำหรับการเข้าถึงผ่านอุปกรณ์อื่น
function getNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ iface: name, address: iface.address });
      }
    }
  }
  return addresses;
}

// API - ดึงข้อมูลเซิร์ฟเวอร์และ IP สำหรับสร้าง QR Code ข้ามแพลตฟอร์ม
app.get('/api/server-info', (req, res) => {
  const addresses = getNetworkAddresses();
  res.json({
    port: PORT,
    hostname: os.hostname(),
    addresses: addresses,
    defaultIp: addresses.length > 0 ? addresses[0].address : 'localhost'
  });
});

// API - ตรวจสอบสถานะการได้รับรางวัล (สำหรับผู้ใช้ตรวจสอบบนมือถือ)
app.get('/api/employees/check-status', (req, res) => {
  const { code, search } = req.query;
  const cleanCode = (code || '').trim();
  const cleanSearch = (search || '').trim();

  if (!cleanCode && !cleanSearch) {
    return res.status(400).json({ error: "กรุณาระบุรหัส หรือชื่อ-สกุล" });
  }

  let sql = `
    SELECT e.id, e.emp_code, e.name, e.rank, e.first_name, e.last_name, e.department, e.status,
           w.won_at, p.name as prize_name
    FROM employees e
    LEFT JOIN winners w ON e.id = w.employee_id
    LEFT JOIN prizes p ON w.prize_id = p.id
  `;
  let params = [];

  if (cleanCode) {
    sql += ` WHERE UPPER(e.emp_code) = UPPER(?) `;
    params.push(cleanCode);
  } else {
    sql += ` WHERE e.name LIKE ? OR (e.first_name LIKE ? OR e.last_name LIKE ?) `;
    const wild = `%${cleanSearch}%`;
    params.push(wild, wild, wild);
  }

  db.get(sql, params, (err, row) => {
    if (err) return res.status(500).json({ error: "เกิดข้อผิดพลาดในการดึงข้อมูล" });
    if (!row) return res.status(404).json({ error: "ไม่พบข้อมูลผู้เข้าร่วมงาน" });
    res.json(row);
  });
});

// API - ล้างผลรางวัลทั้งหมด และคืนสิทธิ์พนักงานทุกคนเป็น eligible (สำหรับเริ่มจับฉลากใหม่)
app.post('/api/admin/reset-winners', (req, res) => {
  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    // 1. คืนยอดรางวัลคงเหลือให้เท่ากับ total_amount
    db.run("UPDATE prizes SET remaining_amount = total_amount", (err) => {
      if (err) {
        db.run("ROLLBACK");
        return res.status(500).json({ error: "เกิดข้อผิดพลาดในการคืนยอดรางวัล" });
      }
      // 2. ปรับสถานะพนักงานทุกคนเป็น eligible
      db.run("UPDATE employees SET status = 'eligible'", (err2) => {
        if (err2) {
          db.run("ROLLBACK");
          return res.status(500).json({ error: "เกิดข้อผิดพลาดในการปรับสถานะพนักงาน" });
        }
        // 3. ลบข้อมูลในตาราง winners ทั้งหมด
        db.run("DELETE FROM winners", (err3) => {
          if (err3) {
            db.run("ROLLBACK");
            return res.status(500).json({ error: "เกิดข้อผิดพลาดในการล้างประวัติรางวัล" });
          }
          db.run("COMMIT", () => {
            res.json({ success: true, message: "ล้างผลรางวัลและคืนสิทธิ์พนักงานเรียบร้อยแล้ว" });
          });
        });
      });
    });
  });
});

// API - เพิ่มพนักงานทีละหลายคน (Bulk Import)
app.post('/api/admin/bulk-employees', (req, res) => {
  const { employees } = req.body;
  if (!Array.isArray(employees) || employees.length === 0) {
    return res.status(400).json({ error: "กรุณาส่งข้อมูลพนักงานเป็น Array" });
  }

  let insertedCount = 0;
  let skippedCount = 0;

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    const insertStmt = db.prepare(
      "INSERT INTO employees (emp_code, name, department, rank, first_name, last_name, status) VALUES (?, ?, ?, ?, ?, ?, 'eligible')"
    );

    employees.forEach((item) => {
      let rank = (item.rank || '').trim();
      let first_name = (item.first_name || '').trim();
      let last_name = (item.last_name || '').trim();
      let department = (item.department || '').trim() || 'ทั่วไป';
      let name = (item.name || '').trim();

      if (!name && first_name) {
        name = rank ? `${rank} ${first_name} ${last_name}`.trim() : `${first_name} ${last_name}`.trim();
      }

      if (!name && !first_name) {
        skippedCount++;
        return;
      }

      const randomCode = Math.floor(10000 + Math.random() * 90000).toString();
      const emp_code = `EMP-${randomCode}`;

      insertStmt.run(emp_code, name, department, rank || null, first_name || null, last_name || null, function (err) {
        if (err) {
          skippedCount++;
        } else {
          insertedCount++;
        }
      });
    });

    insertStmt.finalize((err) => {
      if (err) {
        db.run("ROLLBACK");
        return res.status(500).json({ error: "เกิดข้อผิดพลาดในการนำเข้าข้อมูล" });
      }
      db.run("COMMIT", () => {
        res.json({
          success: true,
          message: `นำเข้าพนักงานสำเร็จ ${insertedCount} คน (ข้าม ${skippedCount} คน)`,
          insertedCount,
          skippedCount
        });
      });
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  const addresses = getNetworkAddresses();
  console.log(`\n======================================================`);
  console.log(`🚀 Lucky Draw Server started successfully on port ${PORT}!`);
  console.log(`------------------------------------------------------`);
  console.log(`📍 Local:   http://localhost:${PORT}`);
  addresses.forEach(addr => {
    console.log(`🌐 Network: http://${addr.address}:${PORT} (${addr.iface})`);
  });
  console.log(`======================================================\n`);
});