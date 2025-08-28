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
  const { first_name, last_name, email, telephone_number, password } = req.body;

  try {
    console.log('User registration attempt for:', email);  // Log when registration is attempted

    // Check if email or phone number already exists
    const existingUser = await pool.query('SELECT * FROM users WHERE email = $1 OR telephone_number = $2', [email, telephone_number]);
    if (existingUser.rows.length > 0) {
      console.log('User already exists:', email);  // Log if user already exists
      return res.status(400).send('User already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (first_name, last_name, email, telephone_number, password) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [first_name, last_name, email, telephone_number, hashedPassword]
    );

    const token = generateToken(result.rows[0]);  // Generate JWT for the user
    console.log('User registered successfully:', email);  // Log when registration is successful

    res.status(201).send({ message: 'User registered successfully', token });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).send('Failed to register user');
  }
};

// User login
module.exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    console.log('User login attempt for:', email); // Log when login is attempted

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      console.log('User not found:', email); // Log if user is not found
      return res.status(400).send('User not found');
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);

    if (match) {
      const token = generateToken(user);  // Generate JWT for the user
      console.log('User logged in successfully:', email);  // Log successful login
      res.status(200).send({ message: 'Login successful', token, user: { first_name: user.first_name, last_name: user.last_name, email: user.email } });
    } else {
      console.log('Incorrect password for user:', email);  // Log if password is incorrect
      res.status(400).send('Incorrect password');
    }
  } catch (error) {
    console.error('Error logging in for user:', email, error);
    res.status(500).send('Failed to login');
  }
};

// Request password reset
module.exports.requestPasswordReset = async (req, res) => {
  const { email } = req.body;

  try {
    console.log('Password reset request for user:', email); // Log when password reset request is made

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      console.log('User not found for password reset:', email);  // Log if user is not found
      return res.status(400).send('User not found');
    }

    const user = result.rows[0];

    // Generate a password reset token
    const resetToken = Math.random().toString(36).substring(2, 15);

    // Update the reset token in the database
    await pool.query('UPDATE users SET reset_token = $1 WHERE id = $2', [resetToken, user.id]);

    console.log('Password reset token generated for user:', email);  // Log when the token is generated

    // Send email with reset link
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: 'Password Reset Request',
      text: `You requested a password reset. Use this token to reset your password: ${resetToken}`
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error('Error sending password reset email:', err);
        return res.status(500).send('Failed to send reset email');
      }
      console.log('Password reset email sent to:', email);  // Log when the email is sent
      res.status(200).send('Password reset link has been sent to your email');
    });
  } catch (error) {
    console.error('Error requesting password reset for user:', email, error);
    res.status(500).send('Failed to request password reset');
  }
};

// Reset password
module.exports.resetPassword = async (req, res) => {
  const { resetToken, newPassword } = req.body;

  try {
    console.log('Password reset attempt with token:', resetToken); // Log when password reset is attempted

    const result = await pool.query('SELECT * FROM users WHERE reset_token = $1', [resetToken]);

    if (result.rows.length === 0) {
      console.log('Invalid or expired reset token:', resetToken);  // Log if the token is invalid or expired
      return res.status(400).send('Invalid or expired reset token');
    }

    const user = result.rows[0];
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update the password in the database and clear the reset token
    await pool.query('UPDATE users SET password = $1, reset_token = NULL WHERE id = $2', [hashedPassword, user.id]);

    console.log('Password reset successfully for user:', user.email);  // Log when password is successfully reset
    res.status(200).send('Password reset successfully');
  } catch (error) {
    console.error('Error resetting password for user:', resetToken, error);
    res.status(500).send('Failed to reset password');
  }
};

module.exports.logout = async (req, res) => {
  try {
    const userEmail = req.user ? req.user.email : "unknown user"; // Fallback if req.user is undefined
    console.log('User logged out:', userEmail); // Log user email if available
    res.status(200).send('Logout successful');
  } catch (error) {
    console.error('Error during logout:', error);
    res.status(500).send('Logout failed');
  }
};
