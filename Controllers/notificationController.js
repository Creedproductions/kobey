// Import necessary modules
const { Client } = require('pg'); // Import Pool instead of Client
const fetch = require('node-fetch');
require('dotenv').config(); // Load environment variables
const config = require('../Config/config'); // Import config for your database connection string

// Set up the connection to NeonDB using Pool
const { Pool } = require('pg'); // Pool is used to manage connections efficiently
const pool = new Pool({
  connectionString: config.NEONDB.CONNECTION_STRING,  // Database connection string
  ssl: {
    rejectUnauthorized: false,  // Adjust based on your SSL settings
  },
  max: 20,  // Maximum number of connections in the pool (adjust based on your needs)
  idleTimeoutMillis: 30000, // Time to wait before closing idle connections (in ms)
  connectionTimeoutMillis: 2000, // Time to wait before failing to connect (in ms)
});

// Function to execute a query using the pool
async function executeQuery(query, params) {
  const client = await pool.connect();  // Get a connection from the pool
  try {
    const result = await client.query(query, params); // Execute the query
    return result; // Return the result
  } catch (error) {
    
    console.error('Query error:', error); // Log query errors
    throw error; // Rethrow the error to be handled by the caller
  } finally {
    client.release(); // Release the connection back to the pool
  }
}

// Store the push token in NeonDB
module.exports.storeToken = async (req, res) => {
  const { token } = req.body;  // Get the token from the request body

  try {
    // Insert the token into the database if it does not already exist
    const result = await executeQuery(
      'INSERT INTO push_tokens (token) VALUES ($1) ON CONFLICT (token) DO NOTHING RETURNING id',
      [token]
    );

    if (result.rowCount > 0) {
      console.log('Push token stored:', token);
      res.status(200).send('Token stored successfully');
    } else {
      // If the token already exists, you can return a 200 status to indicate no changes
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

    const message = {
      to: tokens,
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
    res.status(200).send('Notification sent');
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).send('Failed to send notification');
  }
};
