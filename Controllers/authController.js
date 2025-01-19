const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
require('dotenv').config();

// Set up the connection to the database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});


// Helper function to generate JWT
function generateToken(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// User registration
module.exports.register = async (req, res) => {
  const { username, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id', [username, hashedPassword]);

    const token = generateToken(result.rows[0]);  // Generate JWT for the user

    res.status(201).send({ message: 'User registered successfully', token });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).send('Failed to register user');
  }
};

// User login
module.exports.login = async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    if (result.rows.length === 0) {
      return res.status(400).send('User not found');
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);

    if (match) {
      const token = generateToken(user);  // Generate JWT for the user
      res.status(200).send({ message: 'Login successful', token });
    } else {
      res.status(400).send('Incorrect password');
    }
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).send('Failed to login');
  }
};

// Request password reset
module.exports.requestPasswordReset = async (req, res) => {
  const { username } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

    if (result.rows.length === 0) {
      return res.status(400).send('User not found');
    }

    const user = result.rows[0];

    // Generate a password reset token
    const resetToken = Math.random().toString(36).substring(2, 15);

    // Update the reset token in the database
    await pool.query('UPDATE users SET reset_token = $1 WHERE id = $2', [resetToken, user.id]);

    // Send email with reset link (you can use any email service)
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: user.username,
      subject: 'Password Reset Request',
      text: `You requested a password reset. Use this token to reset your password: ${resetToken}`
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.log(err);
        return res.status(500).send('Failed to send reset email');
      }
      res.status(200).send('Password reset link has been sent to your email');
    });
  } catch (error) {
    console.error('Error requesting password reset:', error);
    res.status(500).send('Failed to request password reset');
  }
};

// Reset password
module.exports.resetPassword = async (req, res) => {
  const { resetToken, newPassword } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE reset_token = $1', [resetToken]);

    if (result.rows.length === 0) {
      return res.status(400).send('Invalid or expired reset token');
    }

    const user = result.rows[0];
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update the password in the database and clear the reset token
    await pool.query('UPDATE users SET password = $1, reset_token = NULL WHERE id = $2', [hashedPassword, user.id]);

    res.status(200).send('Password reset successfully');
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).send('Failed to reset password');
  }
};
