const { Pool } = require('pg');
const fetch = require('node-fetch');
const cron = require('node-cron');
require('dotenv').config();
const config = require('../Config/config');

const pool = new Pool({
  connectionString: config.NEONDB.CONNECTION_STRING,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2300000,
});

// Function to execute a query using the pool
async function executeQuery(query, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(query, params);
    return result;
  } catch (error) {
    console.error('Query error:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Store the push token in NeonDB
module.exports.storeToken = async (req, res) => {
  const { token } = req.body;

  try {
    const result = await executeQuery(
      'INSERT INTO push_tokens (token) VALUES ($1) ON CONFLICT (token) DO NOTHING RETURNING id',
      [token]
    );

    if (result.rowCount > 0) {
      console.log('Push token stored:', token);
      res.status(200).send('Token stored successfully');
    } else {
      res.status(200).send('Token already exists, no changes made');
    }
  } catch (error) {
    console.error('Error storing token:', error);
    res.status(500).send('Failed to store token');
  }
};

// Store the notification in the database
module.exports.storeNotification = async (req, res) => {
  const { title, body, scheduled_time, token } = req.body;

  try {
    const result = await executeQuery(
      'INSERT INTO notifications (title, body, scheduled_time, token) VALUES ($1, $2, $3, $4) RETURNING id',
      [title, body, scheduled_time, token]
    );

    if (result.rowCount > 0) {
      console.log('Notification scheduled:', result.rows[0].id);
      res.status(200).send('Notification scheduled successfully');
    } else {
      res.status(500).send('Failed to schedule notification');
    }
  } catch (error) {
    console.error('Error scheduling notification:', error);
    res.status(500).send('Failed to schedule notification');
  }
};

// Send a notification to all stored tokens
module.exports.sendNotification = async (req, res) => {
  const { title, body } = req.body;

  try {
    const result = await executeQuery('SELECT token FROM push_tokens');
    const tokens = result.rows.map((row) => row.token);

    // Send notifications in chunks
    const chunkSize = 100;
    for (let i = 0; i < tokens.length; i += chunkSize) {
      const chunk = tokens.slice(i, i + chunkSize);

      const message = {
        to: chunk,
        sound: 'default',
        title: title || 'Reminder',
        body: body || 'This is a reminder to use the app.',
        data: { extraData: 'Any data you want to send' },
      };

      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });

      const notificationResult = await response.json();
      console.log('Notification result:', notificationResult);

      // Handle invalid tokens
      if (notificationResult.data) {
        notificationResult.data.forEach((response, index) => {
          if (response.status === 'error' && response.details?.error === 'DeviceNotRegistered') {
            const tokenToRemove = chunk[index];
            console.log('Removing invalid token:', tokenToRemove);
            executeQuery('DELETE FROM push_tokens WHERE token = $1', [tokenToRemove])
              .catch((err) => console.error('Error removing token:', err));
          }
        });
      }
    }

    res.status(200).send('Notifications sent successfully');
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).send('Failed to send notification');
  }
};

// Store scheduled notification for all tokens
module.exports.storeScheduledNotification = async (req, res) => {
  const { title, body, scheduled_time } = req.body;

  try {
    // Fetch all tokens from the push_tokens table
    const result = await executeQuery('SELECT token FROM push_tokens');

    // If no tokens are found, return an error
    if (result.rows.length === 0) {
      return res.status(400).send('No tokens found in the push_tokens table');
    }

    // Loop through all tokens and store the scheduled notification for each token
    for (const row of result.rows) {
      const token = row.token;

      // Store the scheduled notification for each token
      const scheduledResult = await executeQuery(
        'INSERT INTO scheduled_notifications (title, body, scheduled_time, token) VALUES ($1, $2, $3, $4) RETURNING id',
        [title, body, scheduled_time, token]
      );

      if (scheduledResult.rowCount > 0) {
        console.log(`Scheduled notification stored for token: ${token}`);
      } else {
        console.error(`Failed to store scheduled notification for token: ${token}`);
      }
    }

    res.status(200).send('Scheduled notifications stored successfully for all tokens');
  } catch (error) {
    console.error('Error scheduling notifications:', error);
    res.status(500).send('Failed to schedule notifications');
  }
};

// Fetch all scheduled notifications
module.exports.getScheduledNotifications = async (req, res) => {
  try {
    // Query the database for scheduled notifications
    const result = await executeQuery(
      'SELECT id, title, body, scheduled_time, token FROM scheduled_notifications ORDER BY scheduled_time ASC'
    );

    if (result.rows.length > 0) {
      res.status(200).json(result.rows);
    } else {
      res.status(404).send('No scheduled notifications found');
    }
  } catch (error) {
    console.error('Error fetching scheduled notifications:', error);
    res.status(500).send('Failed to fetch scheduled notifications');
  }
};

// Set up a cron job to check for scheduled notifications every minute
cron.schedule('* * * * *', async () => {
  try {
    // Query for notifications that are due to be sent
    const result = await executeQuery(
      'SELECT id, title, body, scheduled_time, token FROM scheduled_notifications WHERE scheduled_time <= NOW()'
    );

    if (result.rows.length > 0) {
      console.log('Sending scheduled notifications...');

      // Loop through the notifications and send them
      for (const notification of result.rows) {
        const { title, body, token } = notification;

        // Send notification to the token (use your existing sendNotification logic)
        const message = {
          to: token,
          sound: 'default',
          title: title || 'Reminder',
          body: body || 'This is a reminder to use the app.',
          data: { extraData: 'Any data you want to send' },
        };

        const response = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
        });

        const notificationResult = await response.json();
        console.log('Notification sent:', notificationResult);

        // If the notification was successfully sent, remove it from the scheduled_notifications table
        if (notificationResult.status === 'ok') {
          await executeQuery('DELETE FROM scheduled_notifications WHERE id = $1', [notification.id]);
        }
      }
    } else {
      console.log('No notifications to send at this time');

    }
  } catch (error) {
    console.error('Error sending scheduled notifications:', error);
  }
});
