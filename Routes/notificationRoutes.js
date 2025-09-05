// routes/notificationRoutes.js

const express = require('express');
const router = express.Router();
const notificationController = require('../Controllers/notificationController');

// Route to store the push token
router.post('/store-token', notificationController.storeToken);

// Route to send a push notification
router.post('/send-notification', notificationController.sendNotification);

// schedule a notification
router.post('/schedule-notification', notificationController.storeScheduledNotification);

// Route to get all scheduled notifications
router.get('/scheduled-notifications', notificationController.getScheduledNotifications);



module.exports = router;

