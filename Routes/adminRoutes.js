const express = require('express');
const router = express.Router();
const authController = require('../Controllers/authController');

// User registration route
router.post('/register', authController.register);

// User login route
router.post('/login', authController.login);

// Password reset request route
router.post('/request-password-reset', authController.requestPasswordReset);

// Reset password route
router.post('/reset-password', authController.resetPassword);

module.exports = router;
