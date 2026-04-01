const express = require('express');
const Database = require('better-sqlite3');
const session = require('express-session');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== DATABASE SETUP ====================
const db = new Database(process.env.DB_PATH || 'badminton.db');
db.pragma('journal_mode = WAL');

db.exec(`
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
    capacity INTEGER NOT NULL DEFAULT 10,
    FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL,
    tier_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    waitlist_position INTEGER,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
    FOREIGN KEY (tier_id) REFERENCES tiers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Default settings
const defaults = {
  admin_password: 'admin123',
  tier1_name: '補季繳請假',
  tier1_price: '0',
  tier1_capacity: '10',
  tier2_name: '一般散打',
  tier2_price: '0',
  tier2_capacity: '10',
};
const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) insertDefault.run(k, v);

// ==================== HELPERS ====================
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function formatDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 給 cron job 用：永遠返回 7 天後的週三
function getNextWednesdayDate(fromDate = new Date()) {
  const d = new Date(fromDate);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 3 ? 7 : (3 - day + 7) % 7));
  return formatDateStr(d);
}

// 給初始化 / 管理員建立用：
// 若今天是週三且還沒過截止時間(18:00) → 返回今天
// 否則 → 返回下個週三
function getUpcomingWednesdayDate(fromDate = new Date()) {
  const d = new Date(fromDate);
  const day = d.getDay();
  if (day === 3) {
    const todayStr = formatDateStr(d);
    const deadline = new Date(`${todayStr} 18:00:00`);
    if (d < deadline) return todayStr;
    d.setDate(d.getDate() + 7);
    return formatDateStr(d);
  }
  d.setDate(d.getDate() + (3 - day + 7) % 7);
  return formatDateStr(d);
}

function createActivity(dateStr) {
  const existing = db.prepare('SELECT id FROM activities WHERE activity_date = ?').get(dateStr);
  if (existing) return existing.id;

  const settings = getSettings();
  const deadline = `${dateStr} 18:00:00`; // 週三晚上6點截止（台灣時間）

  const result = db.prepare(
    'INSERT INTO activities (activity_date, start_time, end_time, deadline) VALUES (?, ?, ?, ?)'
  ).run(dateStr, '20:00', '22:00', deadline);

  const actId = result.lastInsertRowid;
  db.prepare('INSERT INTO tiers (activity_id, name, price, capacity) VALUES (?, ?, ?, ?)').run(
    actId, settings.tier1_name, parseInt(settings.tier1_price) || 0, parseInt(settings.tier1_capacity) || 10
  );
  db.prepare('INSERT INTO tiers (activity_id, name, price, capacity) VALUES (?, ?, ?, ?)').run(
    actId, settings.tier2_name, parseInt(settings.tier2_price) || 0, parseInt(settings.tier2_capacity) || 10
  );
  console.log(`[系統] 建立活動：${dateStr}`);
  return actId;
}

// 確保本週/當前活動存在（每次啟動都檢查）
const upcomingDate = getUpcomingWednesdayDate();
if (!db.prepare('SELECT id FROM activities WHERE activity_date = ?').get(upcomingDate)) {
  createActivity(upcomingDate);
}

// ==================== SCHEDULER ====================
// 每週三 22:00（台灣時間）自動建立下週活動
cron.schedule('0 22 * * 3', () => {
  const nextWed = getNextWednesdayDate(); // 週三時呼叫，回傳7天後
  createActivity(nextWed);
}, { timezone: 'Asia/Taipei' });

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

// 取得當前活動
app.get('/api/activity/current', (req, res) => {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  let activity = db.prepare(
    'SELECT * FROM activities WHERE activity_date >= ? ORDER BY activity_date ASC LIMIT 1'
  ).get(todayStr);

  if (!activity) {
    activity = db.prepare('SELECT * FROM activities ORDER BY activity_date DESC LIMIT 1').get();
  }

  if (!activity) return res.json({ activity: null });

  const tiers = db.prepare('SELECT * FROM tiers WHERE activity_id = ?').all(activity.id);
  const now = new Date();
  // 截止時間為台灣時間 YYYY-MM-DD 18:00:00，server需設定TZ=Asia/Taipei
  const deadlineLocal = new Date(activity.deadline);
  const isOpen = now < deadlineLocal;

  const tiersWithCounts = tiers.map(tier => {
    const confirmed = db.prepare("SELECT COUNT(*) as c FROM registrations WHERE tier_id = ? AND status = 'confirmed'").get(tier.id).c;
    const waitlist = db.prepare("SELECT COUNT(*) as c FROM registrations WHERE tier_id = ? AND status = 'waitlist'").get(tier.id).c;
    return { ...tier, confirmed_count: confirmed, waitlist_count: waitlist, available: Math.max(0, tier.capacity - confirmed) };
  });

  res.json({ activity: { ...activity, is_open: isOpen, tiers: tiersWithCounts } });
});

// 報名
app.post('/api/register', (req, res) => {
  const { activity_id, tier_id, name, phone } = req.body;
  if (!activity_id || !tier_id || !name || !phone) {
    return res.status(400).json({ error: '請填寫所有欄位' });
  }

  const cleanPhone = phone.replace(/[\s\-]/g, '');
  if (!/^[0-9]{8,12}$/.test(cleanPhone)) {
    return res.status(400).json({ error: '電話格式不正確（請輸入8-12位數字）' });
  }
  if (name.trim().length < 2) {
    return res.status(400).json({ error: '姓名至少需要2個字' });
  }

  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(activity_id);
  if (!activity) return res.status(404).json({ error: '活動不存在' });

  const deadlineLocal = new Date(activity.deadline);
  if (new Date() >= deadlineLocal) {
    return res.status(400).json({ error: '報名已截止' });
  }

  const tier = db.prepare('SELECT * FROM tiers WHERE id = ? AND activity_id = ?').get(tier_id, activity_id);
  if (!tier) return res.status(404).json({ error: '報名類型不存在' });

  const duplicate = db.prepare('SELECT id FROM registrations WHERE activity_id = ? AND phone = ?').get(activity_id, cleanPhone);
  if (duplicate) return res.status(400).json({ error: '此電話號碼已報名此次活動' });

  const confirmedCount = db.prepare("SELECT COUNT(*) as c FROM registrations WHERE tier_id = ? AND status = 'confirmed'").get(tier_id).c;

  if (confirmedCount < tier.capacity) {
    db.prepare('INSERT INTO registrations (activity_id, tier_id, name, phone, status) VALUES (?, ?, ?, ?, ?)').run(
      activity_id, tier_id, name.trim(), cleanPhone, 'confirmed'
    );
    res.json({ success: true, status: 'confirmed', message: '報名成功！' });
  } else {
    const waitlistCount = db.prepare("SELECT COUNT(*) as c FROM registrations WHERE tier_id = ? AND status = 'waitlist'").get(tier_id).c;
    const position = waitlistCount + 1;
    db.prepare('INSERT INTO registrations (activity_id, tier_id, name, phone, status, waitlist_position) VALUES (?, ?, ?, ?, ?, ?)').run(
      activity_id, tier_id, name.trim(), cleanPhone, 'waitlist', position
    );
    res.json({ success: true, status: 'waitlist', waitlist_position: position, message: `已加入候補名單，目前是第 ${position} 位候補` });
  }
});

// 查詢報名狀態
app.get('/api/registration', (req, res) => {
  const cleanPhone = (req.query.phone || '').replace(/[\s\-]/g, '');
  if (!cleanPhone) return res.status(400).json({ error: '請輸入電話號碼' });

  const registrations = db.prepare(`
    SELECT r.id, r.status, r.waitlist_position, r.registered_at,
           a.activity_date, a.start_time, a.end_time, a.deadline,
           t.name as tier_name, t.price
    FROM registrations r
    JOIN activities a ON r.activity_id = a.id
    JOIN tiers t ON r.tier_id = t.id
    WHERE r.phone = ?
    ORDER BY a.activity_date DESC
  `).all(cleanPhone);

  res.json({ registrations });
});

// ==================== ADMIN API ====================
function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: '請先登入' });
  next();
}

app.get('/api/admin/check', (req, res) => res.json({ isAdmin: !!req.session.isAdmin }));

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const settings = getSettings();
  if (password === settings.admin_password) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: '密碼錯誤' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => res.json(getSettings()));

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const allowed = ['admin_password', 'tier1_name', 'tier1_price', 'tier1_capacity', 'tier2_name', 'tier2_price', 'tier2_capacity'];
  const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key) && value !== '') update.run(String(value), key);
  }
  res.json({ success: true });
});

app.get('/api/admin/activities', requireAdmin, (req, res) => {
  const activities = db.prepare('SELECT * FROM activities ORDER BY activity_date DESC').all();
  const result = activities.map(act => {
    const confirmed = db.prepare("SELECT COUNT(*) as c FROM registrations WHERE activity_id = ? AND status = 'confirmed'").get(act.id).c;
    const waitlist = db.prepare("SELECT COUNT(*) as c FROM registrations WHERE activity_id = ? AND status = 'waitlist'").get(act.id).c;
    return { ...act, total_confirmed: confirmed, total_waitlist: waitlist };
  });
  res.json({ activities: result });
});

app.get('/api/admin/activity/:id', requireAdmin, (req, res) => {
  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
  if (!activity) return res.status(404).json({ error: '找不到活動' });

  const tiers = db.prepare('SELECT * FROM tiers WHERE activity_id = ?').all(activity.id);
  const tiersWithRegs = tiers.map(tier => {
    const confirmed = db.prepare("SELECT * FROM registrations WHERE tier_id = ? AND status = 'confirmed' ORDER BY registered_at ASC").all(tier.id);
    const waitlist = db.prepare("SELECT * FROM registrations WHERE tier_id = ? AND status = 'waitlist' ORDER BY waitlist_position ASC").all(tier.id);
    return { ...tier, confirmed, waitlist };
  });

  res.json({ activity: { ...activity, tiers: tiersWithRegs } });
});

app.put('/api/admin/activity/:id/tiers', requireAdmin, (req, res) => {
  const { tiers } = req.body;
  const update = db.prepare('UPDATE tiers SET name = ?, price = ?, capacity = ? WHERE id = ? AND activity_id = ?');
  for (const t of tiers) {
    update.run(t.name, parseInt(t.price) || 0, parseInt(t.capacity) || 0, t.id, req.params.id);
  }
  res.json({ success: true });
});

app.post('/api/admin/activity', requireAdmin, (req, res) => {
  const dateStr = req.body.date || getUpcomingWednesdayDate();
  const id = createActivity(dateStr);
  res.json({ success: true, id });
});

app.delete('/api/admin/registration/:id', requireAdmin, (req, res) => {
  const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(req.params.id);
  if (!reg) return res.status(404).json({ error: '找不到報名記錄' });

  db.prepare('DELETE FROM registrations WHERE id = ?').run(reg.id);

  if (reg.status === 'confirmed') {
    // 升補候補第一位
    const first = db.prepare("SELECT * FROM registrations WHERE tier_id = ? AND status = 'waitlist' ORDER BY waitlist_position ASC LIMIT 1").get(reg.tier_id);
    if (first) {
      db.prepare("UPDATE registrations SET status = 'confirmed', waitlist_position = NULL WHERE id = ?").run(first.id);
      db.prepare("UPDATE registrations SET waitlist_position = waitlist_position - 1 WHERE tier_id = ? AND status = 'waitlist'").run(reg.tier_id);
    }
  } else if (reg.status === 'waitlist') {
    db.prepare("UPDATE registrations SET waitlist_position = waitlist_position - 1 WHERE tier_id = ? AND status = 'waitlist' AND waitlist_position > ?").run(reg.tier_id, reg.waitlist_position);
  }

  res.json({ success: true });
});

// ==================== START ====================
app.listen(PORT, () => {
  console.log(`羽球報名系統已啟動：http://localhost:${PORT}`);
  console.log(`管理後台：http://localhost:${PORT}/admin.html`);
});
