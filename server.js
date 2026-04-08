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
      capacity INTEGER NOT NULL DEFAULT 10,
      leave_slots INTEGER NOT NULL DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      leave_code TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS leave_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      activity_id INTEGER NOT NULL,
      used_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(member_id, activity_id)
    );
  `);

  // 為舊有資料庫補上欄位（若不存在）
  try { await db.execute('ALTER TABLE tiers ADD COLUMN leave_slots INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
  try { await db.execute('ALTER TABLE tiers ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0'); } catch (e) {}

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

  // 根據 settings 的 tier1_name 來標記不對外公開的 tier（名稱比對，比 ID 排序更可靠）
  const tier1Name = await getSetting('tier1_name');
  const tier2Name = await getSetting('tier2_name');
  if (tier1Name) {
    await db.execute({ sql: 'UPDATE tiers SET hidden = 1 WHERE name = ?', args: [tier1Name] });
  }
  if (tier2Name) {
    await db.execute({ sql: 'UPDATE tiers SET hidden = 0 WHERE name = ?', args: [tier2Name] });
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
  await db.execute({ sql: 'INSERT INTO tiers (activity_id, name, price, capacity, hidden) VALUES (?, ?, ?, ?, 1)', args: [actId, settings.tier1_name, parseInt(settings.tier1_price) || 0, parseInt(settings.tier1_capacity) || 10] });
  await db.execute({ sql: 'INSERT INTO tiers (activity_id, name, price, capacity, hidden) VALUES (?, ?, ?, ?, 0)', args: [actId, settings.tier2_name, parseInt(settings.tier2_price) || 0, parseInt(settings.tier2_capacity) || 10] });
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
      const effectiveCapacity = tier.capacity + (tier.leave_slots || 0);
      return { ...tier, confirmed_count: confirmed, waitlist_count: waitlist, available: Math.max(0, effectiveCapacity - confirmed), effective_capacity: effectiveCapacity };
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
    if (tier.hidden) return res.status(403).json({ error: '此報名類型不開放直接報名' });

    const dup = one(await db.execute({ sql: 'SELECT id FROM registrations WHERE activity_id = ? AND phone = ?', args: [activity_id, cleanPhone] }));
    if (dup) return res.status(400).json({ error: '此電話號碼已報名此次活動' });

    const confirmedCount = Number(one(await db.execute({ sql: "SELECT COUNT(*) as c FROM registrations WHERE tier_id = ? AND status = 'confirmed'", args: [tier_id] })).c);
    const effectiveCapacity = tier.capacity + (tier.leave_slots || 0);

    if (confirmedCount < effectiveCapacity) {
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

// 季繳會員請假解鎖
app.post('/api/leave-unlock', async (req, res) => {
  try {
    const { activity_id, leave_code } = req.body;
    if (!activity_id || !leave_code) return res.status(400).json({ error: '資料不完整' });

    // 驗證會員代碼
    const member = one(await db.execute({ sql: 'SELECT * FROM members WHERE leave_code = ? AND active = 1', args: [leave_code.trim()] }));
    if (!member) return res.status(403).json({ error: '代碼錯誤或會員資格無效' });

    // 確認活動存在且報名中
    const activity = one(await db.execute({ sql: 'SELECT * FROM activities WHERE id = ?', args: [activity_id] }));
    if (!activity) return res.status(404).json({ error: '活動不存在' });
    if (new Date() >= new Date(activity.deadline)) return res.status(400).json({ error: '報名已截止，無法新增請假名額' });

    // 確認此會員本次活動尚未請假
    const alreadyUsed = one(await db.execute({ sql: 'SELECT id FROM leave_logs WHERE member_id = ? AND activity_id = ?', args: [member.id, activity_id] }));
    if (alreadyUsed) return res.status(400).json({ error: `${member.name} 本次活動已請假過，每次活動限請假一次` });

    // 取得補季繳請假 tier（hidden = 1）
    const tier = one(await db.execute({ sql: 'SELECT * FROM tiers WHERE activity_id = ? AND hidden = 1 LIMIT 1', args: [activity_id] }));
    if (!tier) return res.status(404).json({ error: '找不到補季繳請假類型' });

    // +1 請假名額 + 記錄 log
    await db.execute({ sql: 'UPDATE tiers SET leave_slots = leave_slots + 1 WHERE id = ?', args: [tier.id] });
    await db.execute({ sql: 'INSERT INTO leave_logs (member_id, activity_id) VALUES (?, ?)', args: [member.id, activity_id] });

    const updated = one(await db.execute({ sql: 'SELECT * FROM tiers WHERE id = ?', args: [tier.id] }));
    console.log(`[請假] ${member.name} 請假，活動 ${activity_id}，${tier.name} leave_slots=${updated.leave_slots}`);

    // 自動將一般散打（hidden = 0）最早報名的確認者移至補季繳請假
    const tier2 = one(await db.execute({ sql: 'SELECT * FROM tiers WHERE activity_id = ? AND hidden = 0 LIMIT 1', args: [activity_id] }));
    let movedPerson = null;
    let promotedPerson = null;

    if (tier2) {
      const firstTier2Reg = one(await db.execute({
        sql: "SELECT * FROM registrations WHERE tier_id = ? AND status = 'confirmed' ORDER BY registered_at ASC LIMIT 1",
        args: [tier2.id]
      }));
      if (firstTier2Reg) {
        // 將此人移至補季繳請假 tier
        await db.execute({ sql: 'UPDATE registrations SET tier_id = ? WHERE id = ?', args: [tier.id, firstTier2Reg.id] });
        movedPerson = firstTier2Reg;
        console.log(`[請假] ${firstTier2Reg.name} 從${tier2.name}移至${tier.name}`);

        // 一般散打空出名額，自動遞補候補名單
        const waitlistFirst = one(await db.execute({
          sql: "SELECT * FROM registrations WHERE tier_id = ? AND status = 'waitlist' ORDER BY waitlist_position ASC LIMIT 1",
          args: [tier2.id]
        }));
        if (waitlistFirst) {
          await db.execute({ sql: "UPDATE registrations SET status = 'confirmed', waitlist_position = NULL WHERE id = ?", args: [waitlistFirst.id] });
          await db.execute({ sql: "UPDATE registrations SET waitlist_position = waitlist_position - 1 WHERE tier_id = ? AND status = 'waitlist'", args: [tier2.id] });
          promotedPerson = waitlistFirst;
          console.log(`[請假] ${waitlistFirst.name} 從${tier2.name}候補升格`);
        }
      }
    }

    let message = `${member.name} 請假成功`;
    if (movedPerson) message += `，${movedPerson.name} 已移至「${tier.name}」`;
    if (promotedPerson) message += `，${promotedPerson.name} 從候補升格`;
    res.json({ success: true, member_name: member.name, leave_slots: updated.leave_slots, tier_name: tier.name, moved_person: movedPerson?.name || null, promoted_person: promotedPerson?.name || null, message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ==================== 會員管理 API ====================
app.get('/api/admin/members', requireAdmin, async (req, res) => {
  try {
    const memberList = rows(await db.execute('SELECT * FROM members ORDER BY id ASC'));
    res.json({ members: memberList });
  } catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.post('/api/admin/members', requireAdmin, async (req, res) => {
  try {
    const { name, leave_code } = req.body;
    if (!name || !leave_code) return res.status(400).json({ error: '姓名和代碼為必填' });
    const dup = one(await db.execute({ sql: 'SELECT id FROM members WHERE leave_code = ?', args: [leave_code.trim()] }));
    if (dup) return res.status(400).json({ error: '此代碼已被使用，請換一個' });
    const result = await db.execute({ sql: 'INSERT INTO members (name, leave_code) VALUES (?, ?)', args: [name.trim(), leave_code.trim()] });
    res.json({ success: true, id: Number(result.lastInsertRowid) });
  } catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.put('/api/admin/members/:id', requireAdmin, async (req, res) => {
  try {
    const { name, leave_code, active } = req.body;
    if (leave_code) {
      const dup = one(await db.execute({ sql: 'SELECT id FROM members WHERE leave_code = ? AND id != ?', args: [leave_code.trim(), req.params.id] }));
      if (dup) return res.status(400).json({ error: '此代碼已被使用' });
    }
    await db.execute({ sql: 'UPDATE members SET name = COALESCE(?, name), leave_code = COALESCE(?, leave_code), active = COALESCE(?, active) WHERE id = ?', args: [name || null, leave_code?.trim() || null, active ?? null, req.params.id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.delete('/api/admin/members/:id', requireAdmin, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM members WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '伺服器錯誤' }); }
});

// 公開取消報名（需驗證電話）
app.delete('/api/register/:id', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: '請提供電話號碼以驗證身份' });

    const cleanPhone = phone.replace(/[\s\-]/g, '');
    const reg = one(await db.execute({ sql: 'SELECT * FROM registrations WHERE id = ?', args: [req.params.id] }));
    if (!reg) return res.status(404).json({ error: '找不到報名記錄' });
    if (reg.phone !== cleanPhone) return res.status(403).json({ error: '電話號碼不符，無法取消' });

    // 確認取消截止時間：活動當週三 12:00
    const activity = one(await db.execute({ sql: 'SELECT * FROM activities WHERE id = ?', args: [reg.activity_id] }));
    if (!activity) return res.status(404).json({ error: '找不到活動' });

    const cancelDeadline = new Date(`${activity.activity_date} 12:00:00`);
    if (new Date() >= cancelDeadline) {
      return res.status(400).json({ error: '已超過取消截止時間（週三中午 12:00），如需取消請聯繫管理員' });
    }

    // 執行取消
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

    res.json({ success: true, message: '已成功取消報名' });
  } catch (err) {
    console.error(err);
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
