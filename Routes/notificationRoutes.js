// routes/notificationRoutes.js

const express = require('express');
const router = express.Router();
const notificationController = require('../Controllers/notificationController');

// Route to store the push token
router.post('/store-token', notificationController.storeToken);

// Route to send a push notification
router.post('/send-notification', notificationController.sendNotification);

module.exports = router;

