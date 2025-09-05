const axios = require('axios');
const pool = require('../db');

const notificationsEnabled = !!process.env.DATABASE_URL;
const fcmEnabled = !!process.env.FCM_SERVER_KEY;

const q = async (sql, params = []) => {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
};

const sendToTokens = async (tokens, title, body, data) => {
  if (!fcmEnabled || !tokens.length) return { success: 0, failure: tokens.length };
  const res = await axios.post(
    'https://fcm.googleapis.com/fcm/send',
    { registration_ids: tokens, notification: { title, body }, data: data || {} },
    { headers: { Authorization: `key=${process.env.FCM_SERVER_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 }
  );
  return { success: res.data.success || 0, failure: res.data.failure || 0 };
};

// POST /store-token
exports.storeToken = async (req, res) => {
  if (!notificationsEnabled) return res.status(503).json({ error: 'Notifications disabled' });
  const { user_id = null, token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  await q(`
    CREATE TABLE IF NOT EXISTS device_tokens(
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await q(`INSERT INTO device_tokens(user_id, token)
           VALUES ($1,$2)
           ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id`, [user_id, token]);
  res.json({ ok: true });
};

// POST /send-notification
exports.sendNotification = async (req, res) => {
  if (!notificationsEnabled) return res.status(503).json({ error: 'Notifications disabled' });
  const { user_id = null, token = null, title, body, data = {} } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'title/body required' });

  let tokens = [];
  if (token) tokens = [token];
  else if (user_id) {
    const r = await q(`SELECT token FROM device_tokens WHERE user_id=$1`, [user_id]);
    tokens = r.rows.map(x => x.token);
  }
  const result = await sendToTokens(tokens, title, body, data);
  res.json({ sent: result.success, failed: result.failure });
};

// POST /schedule-notification
exports.storeScheduledNotification = async (req, res) => {
  if (!notificationsEnabled) return res.status(503).json({ error: 'Notifications disabled' });
  const { user_id = null, token = null, title, body, data = {}, scheduled_at } = req.body;
  if (!title || !body || !scheduled_at) return res.status(400).json({ error: 'title/body/scheduled_at required' });

  await q(`
    CREATE TABLE IF NOT EXISTS scheduled_notifications(
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      token TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      data JSONB DEFAULT '{}'::jsonb,
      scheduled_at TIMESTAMPTZ NOT NULL,
      sent BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  const r = await q(
    `INSERT INTO scheduled_notifications(user_id, token, title, body, data, scheduled_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [user_id, token, title, body, data, scheduled_at]
  );
  res.json({ id: r.rows[0].id });
};

// GET /scheduled-notifications
exports.getScheduledNotifications = async (_req, res) => {
  if (!notificationsEnabled) return res.status(503).json({ error: 'Notifications disabled' });
  const r = await q(`SELECT id, user_id, token, title, body, data, scheduled_at, sent, created_at
                     FROM scheduled_notifications
                     ORDER BY scheduled_at DESC LIMIT 500`);
  res.json(r.rows);
};

// POST /run-due  (optional cron/manual trigger)
exports.runDueNotifications = async (_req, res) => {
  if (!notificationsEnabled) return res.status(503).json({ error: 'Notifications disabled' });

  const due = await q(
    `SELECT id, user_id, token, title, body, data
     FROM scheduled_notifications
     WHERE sent=false AND scheduled_at <= NOW()
     ORDER BY scheduled_at ASC
     LIMIT 200`
  );

  let totalSent = 0, totalFailed = 0;

  for (const row of due.rows) {
    let tokens = [];
    if (row.token) tokens = [row.token];
    else if (row.user_id) {
      const r = await q(`SELECT token FROM device_tokens WHERE user_id=$1`, [row.user_id]);
      tokens = r.rows.map(x => x.token);
    }
    const result = await sendToTokens(tokens, row.title, row.body, row.data);
    totalSent += result.success;
    totalFailed += result.failure;
    await q(`UPDATE scheduled_notifications SET sent=true WHERE id=$1`, [row.id]);
  }

  res.json({ processed: due.rows.length, sent: totalSent, failed: totalFailed });
};

// GET /health (optional)
exports.health = (_req, res) => {
  res.json({ notificationsEnabled, fcmEnabled });
};
