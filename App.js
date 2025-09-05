const express = require('express');
const cors = require('cors');
const config = require('./Config/config');
const downloaderRoutes = require('./Routes/downloaderRoutes');
const notificationRoutes = require('./Routes/notificationRoutes');
const adminRoutes = require('./Routes/adminRoutes');
const userRoutes = require('./Routes/userRoutes');
const pool = require('./db');

const app = express();
app.use(express.json());

app.use(cors({
  origin: ['https://savedownloader.vercel.app','https://savedownloaderweb.vercel.app','http://localhost:5173'],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

app.use('/api', downloaderRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);

if (process.env.DATABASE_URL) {
  pool.query('SELECT 1').then(() => console.log('DB ready')).catch(e => console.error('DB init error:', e.message));
} else {
  console.warn('DATABASE_URL not set — notifications disabled');
}

app.listen(config.PORT, () => console.log(`Server on :${config.PORT}`));
