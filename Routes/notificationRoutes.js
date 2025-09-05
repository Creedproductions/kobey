const express = require('express');
const router = express.Router();
const c = require('../Controllers/notificationController');

router.post('/store-token', c.storeToken);
router.post('/send-notification', c.sendNotification);
router.post('/schedule-notification', c.storeScheduledNotification);
router.get('/scheduled-notifications', c.getScheduledNotifications);

// optional maintenance endpoints
router.post('/run-due', c.runDueNotifications);
router.get('/health', c.health);

module.exports = router;
