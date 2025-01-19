const { Pool } = require('pg');
require('dotenv').config(); // Load environment variables

// Set up the connection pool to NeonDB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Fetch user details by ID
module.exports.getUserDetails = async (req, res) => {
  const userId = req.userId;  // Assuming the user ID is stored in the JWT token

  try {
    const result = await pool.query('SELECT id, username, created_at FROM users WHERE id = $1', [userId]);

    if (result.rows.length === 0) {
      return res.status(404).send('User not found');
    }

    res.status(200).send(result.rows[0]);
  } catch (error) {
    console.error('Error fetching user details:', error);
    res.status(500).send('Failed to fetch user details');
  }
};

// Update user details
module.exports.updateUserDetails = async (req, res) => {
  const userId = req.userId;  // Assuming the user ID is stored in the JWT token
  const { username, password } = req.body;

  try {
    // If password is provided, hash it
    let query = 'UPDATE users SET username = $1';
    const params = [username];

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      query += ', password = $2';
      params.push(hashedPassword);
    }

    query += ' WHERE id = $3 RETURNING id';
    params.push(userId);

    const result = await pool.query(query, params);

    if (result.rowCount > 0) {
      res.status(200).send('User details updated successfully');
    } else {
      res.status(404).send('User not found');
    }
  } catch (error) {
    console.error('Error updating user details:', error);
    res.status(500).send('Failed to update user details');
  }
};
