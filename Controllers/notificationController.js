const { Pool } = require('pg');
const fetch = require('node-fetch');
const cron = require('node-cron');
require('dotenv').config();
const config = require('../Config/config');

const pool = new Pool({
  connectionString: config.NEONDB.CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2300000,
});

// **Reusable Query Execution**
async function executeQuery(query, params = []) {
  try {
    const result = await pool.query(query, params);
    return result;
  } catch (error) {
    console.error(`Database Query Error: ${error.message}`);
    throw error;
  }
}

// **Store Push Token**
module.exports.storeToken = async (req, res) => {
  const { token } = req.body;
  try {
    const result = await executeQuery(
      `INSERT INTO push_tokens (token) VALUES ($1) ON CONFLICT (token) DO NOTHING RETURNING id`,
      [token]
    );
    res.status(200).send(result.rowCount > 0 ? 'Token stored successfully' : 'Token already exists');
  } catch (error) {
    res.status(500).send('Error storing token');
  }
};

// **Store Notification**
module.exports.storeNotification = async (req, res) => {
  const { title, body, scheduled_time, token } = req.body;
  try {
    const result = await executeQuery(
      `INSERT INTO notifications (title, body, scheduled_time, token) VALUES ($1, $2, $3, $4) RETURNING id`,
      [title, body, scheduled_time, token]
    );
    res.status(200).send('Notification scheduled successfully');
  } catch (error) {
    res.status(500).send('Error scheduling notification');
  }
};

// **Send Notifications in Chunks**
async function sendPushNotifications(tokens, title, body) {
  const chunkSize = 100;
  for (let i = 0; i < tokens.length; i += chunkSize) {
    const chunk = tokens.slice(i, i + chunkSize);
    const message = chunk.map((token) => ({
      to: token,
      sound: 'default',
      title,
      body,
      data: { extraData: 'Any data you want to send' },
    }));

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    const result = await response.json();
    console.log('Expo Push Response:', result);

    // Remove invalid tokens
    if (result.data) {
      result.data.forEach(async (resp, index) => {
        if (resp.status === 'error' && resp.details?.error === 'DeviceNotRegistered') {
          await executeQuery('DELETE FROM push_tokens WHERE token = $1', [chunk[index]]);
        }
      });
    }
  }
}

// **Send Notification to All Tokens**
module.exports.sendNotification = async (req, res) => {
  const { title, body } = req.body;
  try {
    const result = await executeQuery('SELECT token FROM push_tokens');
    const tokens = result.rows.map((row) => row.token);
    if (tokens.length === 0) return res.status(400).send('No tokens found');

    await sendPushNotifications(tokens, title, body);
    res.status(200).send('Notifications sent successfully');
  } catch (error) {
    res.status(500).send('Error sending notification');
  }
};

// **Store Scheduled Notifications for All Tokens**
module.exports.storeScheduledNotification = async (req, res) => {
  const { title, body, scheduled_time } = req.body;
  try {
    const result = await executeQuery('SELECT token FROM push_tokens');
    if (result.rows.length === 0) return res.status(400).send('No tokens found');

    const insertPromises = result.rows.map(({ token }) =>
      executeQuery(
        `INSERT INTO scheduled_notifications (title, body, scheduled_time, token) VALUES ($1, $2, $3, $4) RETURNING id`,
        [title, body, scheduled_time, token]
      )
    );

    await Promise.all(insertPromises);
    res.status(200).send('Scheduled notifications stored successfully');
  } catch (error) {
    res.status(500).send('Error scheduling notifications');
  }
};

// **Fetch Scheduled Notifications**
module.exports.getScheduledNotifications = async (req, res) => {
  try {
    const result = await executeQuery(
      `SELECT id, title, body, scheduled_time, token FROM scheduled_notifications ORDER BY scheduled_time ASC`
    );
    res.status(200).json(result.rows.length > 0 ? result.rows : 'No scheduled notifications found');
  } catch (error) {
    res.status(500).send('Error fetching scheduled notifications');
  }
};

// **Cron Job to Send Scheduled Notifications**
cron.schedule('* * * * *', async () => {
  try {
    console.log('Checking for scheduled notifications...');
    const result = await executeQuery(
      `SELECT id, title, body, scheduled_time, token FROM scheduled_notifications WHERE scheduled_time <= NOW()`
    );

    if (result.rows.length > 0) {
      console.log(`Sending ${result.rows.length} scheduled notifications...`);
      for (const { id, title, body, token } of result.rows) {
        await sendPushNotifications([token], title, body);
        await executeQuery('DELETE FROM scheduled_notifications WHERE id = $1', [id]);
      }
    } else {
      console.log('No scheduled notifications to send.');
    }
  } catch (error) {
    console.error('Error sending scheduled notifications:', error);
  }
});
