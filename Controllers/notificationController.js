const { Client } = require('pg');
const fetch = require('node-fetch');
require('dotenv').config();
const config = require('../Config/config');

// Set up the connection to NeonDB
const client = new Client({
  connectionString: config.NEONDB.CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
});

client.connect()
  .then(() => console.log("Connected to the database successfully!"))
  .catch(err => {
    console.error("Failed to connect to the database:", err);
    setTimeout(connectToDatabase, 5000); // Retry after 5 seconds
  });

// Reconnect function
function connectToDatabase() {
  client.connect()
    .then(() => console.log("Reconnected to the database"))
    .catch(err => {
      console.error("Failed to reconnect:", err);
      setTimeout(connectToDatabase, 5000); // Retry after 5 seconds
    });
}


// Store the push token in NeonDB
module.exports.storeToken = async (req, res) => {
  const { token } = req.body;  // Get the token from the request body

  try {
    // Insert the token into the database if it does not already exist
    const result = await client.query(
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
    // Insert the notification into the database
    const result = await client.query(
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
    const { title, body } = req.body;  // Get the title and body of the notification
  
    try {
      // Retrieve all stored tokens from NeonDB
      const result = await client.query('SELECT token FROM push_tokens');
      const tokens = result.rows.map((row) => row.token);  // Extract tokens from database result
  
      // Define the notification message with icon property
      const message = {
        to: tokens,  // Send to all stored tokens
        sound: 'default',
        title: title || 'Reminder',  // Default title
        body: body || 'This is a reminder to use the app.',  // Default body
        data: { extraData: 'Any data you want to send' },
        // Set the icon property to the URL of your logo image
        android: {
          icon: 'https://firebasestorage.googleapis.com/v0/b/toa-site.appspot.com/o/prod%2FsiteImages%2F1737239676849_SAVE%20LOGO%20Red%20all-01.png?alt=media&token=deb92c69-c44f-4df6-8009-5794eba1a9f8',  // Replace with your logo URL
        },
        ios: {
          // Optionally, you can also set the icon for iOS
          icon: 'https://firebasestorage.googleapis.com/v0/b/toa-site.appspot.com/o/prod%2FsiteImages%2F1737239676849_SAVE%20LOGO%20Red%20all-01.png?alt=media&token=deb92c69-c44f-4df6-8009-5794eba1a9f8',
        }
      };
  
      // Send the notification using Expo push notification service
      const response = await fetch('https://exp.host/--/api/v2/push/send', {  // Correct API endpoint for Expo
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
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
  