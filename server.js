const express = require('express');
const { createClient } = require('@libsql/client');
const session = require('express-session');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== DATABASE (Turso) ====================
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

async function initDB() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_date TEXT NOT NULL UNIQUE,
      start_time TEXT NOT NULL DEFAULT '20:00',
      end_time TEXT NOT NULL DEFAULT '22:00',
      deadline TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      capacity INTEGER NOT NULL DEFAULT 10
    );
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER NOT NULL,
      tier_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      waitlist_position INTEGER,
      registered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const defaults = [
    ['admin_password', 'admin123'],
    ['tier1_name', '補季繳請假'],
    ['tier1_price', '0'],
    ['tier1_capacity', '10'],
    ['tier2_name', '一般散打'],
    ['tier2_price', '0'],
    ['tier2_capacity', '10'],
  ];
  for (const [k, v] of defaults) {
    await db.execute({ sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', args: [k, v] });
  }
}

// ==================== HELPERS ====================
function row(r) {
  // 將 libsql row 轉為普通物件，數字欄位轉為 Number
  const obj = {};
  for (const [k, v] of Object.entries(r)) {
    obj[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return obj;
}

function rows(result) {
  return result.rows.map(row);
}

function one(result) {
  return result.rows[0] ? row(result.rows[0]) : null;
}

async function getSetting(key) {
  const r = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  return r.rows[0]?.value;
}

async function getSettings() {
  const result = await db.execute('SELECT key, value FROM settings');
  return Object.fromEntries(result.rows.map(r => [r.key, r.value]));
}

function formatDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 給 cron job 用：永遠返回下個週三（若今天是週三則7天後）
function getNextWednesdayDate(fromDate = new Date()) {
  const d = new Date(fromDate);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 3 ? 7 : (3 - day + 7) % 7));
  return formatDateStr(d);
}

// 給初始化 / 管理員用：若今天是週三且未過截止時間 → 今天，否則 → 下個週三
function getUpcomingWednesdayDate(fromDate = new Date()) {
  const d = new Date(fromDate);
  const day = d.getDay();
  if (day === 3) {
    const todayStr = formatDateStr(d);
    if (d < new Date(`${todayStr} 18:00:00`)) return todayStr;
    d.setDate(d.getDate() + 7);
    return formatDateStr(d);
  }
  d.setDate(d.getDate() + (3 - day + 7) % 7);
  return formatDateStr(d);
}

async function createActivity(dateStr) {
  const existing = one(await db.execute({ sql: 'SELECT id FROM activities WHERE activity_date = ?', args: [dateStr] }));
  if (existing) return existing.id;

  const settings = await getSettings();
  const deadline = `${dateStr} 18:00:00`;

  const result = await db.execute({
    sql: 'INSERT INTO activities (activity_date, start_time, end_time, deadline) VALUES (?, ?, ?, ?)',
    args: [dateStr, '20:00', '22:00', deadline]
  });

  const actId = Number(result.lastInsertRowid);
  await db.execute({ sql: 'INSERT INTO tiers (activity_id, name, price, capacity) VALUES (?, ?, ?, ?)', args: [actId, settings.tier1_name, parseInt(settings.tier1_price) || 0, parseInt(settings.tier1_capacity) || 10] });
  await db.execute({ sql: 'INSERT INTO tiers (activity_id, name, price, capacity) VALUES (?, ?, ?, ?)', args: [actId, settings.tier2_name, parseInt(settings.tier2_price) || 0, parseInt(settings.tier2_capacity) || 10] });
  console.log(`[系統] 建立活動：${dateStr}`);
  return actId;
}

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'badminton-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ==================== PUBLIC API ====================

app.get('/api/activity/current', async (req, res) => {
  try {
    const todayStr = formatDateStr(new Date());
    let activity = one(await db.execute({ sql: 'SELECT * FROM activities WHERE activity_date >= ? ORDER BY activity_date ASC LIMIT 1', args: [todayStr] }));
    if (!activity) activity = one(await db.execute('SELECT * FROM activities ORDER BY activity_date DESC LIMIT 1'));
    if (!activity) return res.json({ activity: null });

    const tierList = rows(await db.execute({ sql: 'SELECT * FROM tiers WHERE activity_id = ?', args: [activity.id] }));
    const isOpen = new Date() < new Date(`${activity.deadline}`);

    const tiersWithCounts = await Promise.all(tierList.map(async tier => {
      const confirmed = Number(one(await db.execute({ sql: "SELECT COUNT(*) as c FROM registrations WHERE tier_id = ? AND status = 'confirmed'", args: [tier.id] })).c);
      const waitlist = Number(one(await db.execute({ sql: "SELECT COUNT(*) as c FROM registrations WHERE tier_id = ? AND status = 'waitlist'", args: [tier.id] })).c);
      return { ...tier, confirmed_count: confirmed, waitlist_count: waitlist, available: Math.max(0, tier.capacity - confirmed) };
    }));

    res.json({ activity: { ...activity, is_open: isOpen, tiers: tiersWithCounts } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { activity_id, tier_id, name, phone } = req.body;
    if (!activity_id || !tier_id || !name || !phone) return res.status(400).json({ error: '請填寫所有欄位' });

    const cleanPhone = phone.replace(/[\s\-]/g, '');
    if (!/^[0-9]{8,12}$/.test(cleanPhone)) return res.status(400).json({ error: '電話格式不正確（請輸入8-12位數字）' });
    if (name.trim().length < 2) return res.status(400).json({ error: '姓名至少需要2個字' });

    const activity = one(await db.execute({ sql: 'SELECT * FROM activities WHERE id = ?', args: [activity_id] }));
    if (!activity) return res.status(404).json({ error: '活動不存在' });
    if (new Date() >= new Date(activity.deadline)) return res.status(400).json({ error: '報名已截止' });

    const tier = one(await db.execute({ sql: 'SELECT * FROM tiers WHERE id = ? AND activity_id = ?', args: [tier_id, activity_id] }));
    if (!tier) return res.status(404).json({ error: '報名類型不存在' });

    const dup = one(await db.execute({ sql: 'SELECT id FROM registrations WHERE activity_id = ? AND phone = ?', args: [activity_id, cleanPhone] }));
    if (dup) return res.status(400).json({ error: '此電話號碼已報名此次活動' });

    const confirmedCount = Number(one(await db.execute({ sql: "SELECT COUNT(*) as c FROM registrations WHERE tier_id = ? AND status = 'confirmed'", args: [tier_id] })).c);

    if (confirmedCount < tier.capacity) {
      await db.execute({ sql: 'INSERT INTO registrations (activity_id, tier_id, name, phone, status) VALUES (?, ?, ?, ?, ?)', args: [activity_id, tier_id, name.trim(), cleanPhone, 'confirmed'] });
      res.json({ success: true, status: 'confirmed', message: '報名成功！' });
    } else {
      const waitlistCount = Number(one(await db.execute({ sql: "SELECT COUNT(*) as c FROM registrations WHERE tier_id = ? AND status = 'waitlist'", args: [tier_id] })).c);
      const position = waitlistCount + 1;
      await db.execute({ sql: 'INSERT INTO registrations (activity_id, tier_id, name, phone, status, waitlist_position) VALUES (?, ?, ?, ?, ?, ?)', args: [activity_id, tier_id, name.trim(), cleanPhone, 'waitlist', position] });
      res.json({ success: true, status: 'waitlist', waitlist_position: position, message: `已加入候補名單，目前是第 ${position} 位候補` });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.get('/api/registration', async (req, res) => {
  try {
    const cleanPhone = (req.query.phone || '').replace(/[\s\-]/g, '');
    if (!cleanPhone) return res.status(400).json({ error: '請輸入電話號碼' });

    const result = await db.execute({
      sql: `SELECT r.id, r.status, r.waitlist_position, r.registered_at,
             a.activity_date, a.start_time, a.end_time, a.deadline,
             t.name as tier_name, t.price
           FROM registrations r
           JOIN activities a ON r.activity_id = a.id
           JOIN tiers t ON r.tier_id = t.id
           WHERE r.phone = ?
           ORDER BY a.activity_date DESC`,
      args: [cleanPhone]
    });
    res.json({ registrations: rows(result) });
  } catch (err) {
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ==================== ADMIN API ====================
function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: '請先登入' });
  next();
}

app.get('/api/admin/check', (req, res) => res.json({ isAdmin: !!req.session.isAdmin }));

app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    const settings = await getSettings();
    if (password === settings.admin_password) { req.session.isAdmin = true; res.json({ success: true }); }
    else res.status(401).json({ error: '密碼錯誤' });
  } catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try { res.json(await getSettings()); }
  catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const allowed = ['admin_password', 'tier1_name', 'tier1_price', 'tier1_capacity', 'tier2_name', 'tier2_price', 'tier2_capacity'];
    for (const [key, value] of Object.entries(req.body)) {
      if (allowed.includes(key) && value !== '') await db.execute({ sql: 'UPDATE settings SET value = ? WHERE key = ?', args: [String(value), key] });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.get('/api/admin/activities', requireAdmin, async (req, res) => {
  try {
    const actList = rows(await db.execute('SELECT * FROM activities ORDER BY activity_date DESC'));
    const result = await Promise.all(actList.map(async act => {
      const confirmed = Number(one(await db.execute({ sql: "SELECT COUNT(*) as c FROM registrations WHERE activity_id = ? AND status = 'confirmed'", args: [act.id] })).c);
      const waitlist = Number(one(await db.execute({ sql: "SELECT COUNT(*) as c FROM registrations WHERE activity_id = ? AND status = 'waitlist'", args: [act.id] })).c);
      return { ...act, total_confirmed: confirmed, total_waitlist: waitlist };
    }));
    res.json({ activities: result });
  } catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.get('/api/admin/activity/:id', requireAdmin, async (req, res) => {
  try {
    const activity = one(await db.execute({ sql: 'SELECT * FROM activities WHERE id = ?', args: [req.params.id] }));
    if (!activity) return res.status(404).json({ error: '找不到活動' });

    const tierList = rows(await db.execute({ sql: 'SELECT * FROM tiers WHERE activity_id = ?', args: [activity.id] }));
    const tiersWithRegs = await Promise.all(tierList.map(async tier => {
      const confirmed = rows(await db.execute({ sql: "SELECT * FROM registrations WHERE tier_id = ? AND status = 'confirmed' ORDER BY registered_at ASC", args: [tier.id] }));
      const waitlist = rows(await db.execute({ sql: "SELECT * FROM registrations WHERE tier_id = ? AND status = 'waitlist' ORDER BY waitlist_position ASC", args: [tier.id] }));
      return { ...tier, confirmed, waitlist };
    }));

    res.json({ activity: { ...activity, tiers: tiersWithRegs } });
  } catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.put('/api/admin/activity/:id/tiers', requireAdmin, async (req, res) => {
  try {
    for (const t of req.body.tiers) {
      await db.execute({ sql: 'UPDATE tiers SET name = ?, price = ?, capacity = ? WHERE id = ? AND activity_id = ?', args: [t.name, parseInt(t.price) || 0, parseInt(t.capacity) || 0, t.id, req.params.id] });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.post('/api/admin/activity', requireAdmin, async (req, res) => {
  try {
    const dateStr = req.body.date || getUpcomingWednesdayDate();
    const id = await createActivity(dateStr);
    res.json({ success: true, id });
  } catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.delete('/api/admin/registration/:id', requireAdmin, async (req, res) => {
  try {
    const reg = one(await db.execute({ sql: 'SELECT * FROM registrations WHERE id = ?', args: [req.params.id] }));
    if (!reg) return res.status(404).json({ error: '找不到報名記錄' });

    await db.execute({ sql: 'DELETE FROM registrations WHERE id = ?', args: [reg.id] });

    if (reg.status === 'confirmed') {
      const first = one(await db.execute({ sql: "SELECT * FROM registrations WHERE tier_id = ? AND status = 'waitlist' ORDER BY waitlist_position ASC LIMIT 1", args: [reg.tier_id] }));
      if (first) {
        await db.execute({ sql: "UPDATE registrations SET status = 'confirmed', waitlist_position = NULL WHERE id = ?", args: [first.id] });
        await db.execute({ sql: "UPDATE registrations SET waitlist_position = waitlist_position - 1 WHERE tier_id = ? AND status = 'waitlist'", args: [reg.tier_id] });
      }
    } else if (reg.status === 'waitlist') {
      await db.execute({ sql: "UPDATE registrations SET waitlist_position = waitlist_position - 1 WHERE tier_id = ? AND status = 'waitlist' AND waitlist_position > ?", args: [reg.tier_id, reg.waitlist_position] });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

// ==================== START ====================
async function start() {
  await initDB();

  // 確保本週活動存在
  const upcomingDate = getUpcomingWednesdayDate();
  const existing = one(await db.execute({ sql: 'SELECT id FROM activities WHERE activity_date = ?', args: [upcomingDate] }));
  if (!existing) await createActivity(upcomingDate);

  // 每週三 22:00 自動建立下週活動
  cron.schedule('0 22 * * 3', async () => {
    await createActivity(getNextWednesdayDate());
  }, { timezone: 'Asia/Taipei' });

  app.listen(PORT, () => {
    console.log(`羽球報名系統已啟動：http://localhost:${PORT}`);
    console.log(`管理後台：http://localhost:${PORT}/admin.html`);
  });
}

start().catch(err => { console.error('啟動失敗:', err); process.exit(1); });
