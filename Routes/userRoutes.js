const express = require('express');
const router = express.Router();
const userController = require('../Controllers/userController');

// Route to get user details (for authenticated user)
router.get('/profile', userController.getUserDetails);

// Route to update user details
router.put('/profile', userController.updateUserDetails);

module.exports = router;
