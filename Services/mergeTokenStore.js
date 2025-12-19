const crypto = require('crypto');

const store = new Map();
const TTL_MS = 10 * 60 * 1000; // 10 minutes

function createToken(payload) {
    const token = crypto.randomBytes(16).toString('hex');
    store.set(token, { payload, createdAt: Date.now() });
    return token;
}

function getToken(token) {
    const item = store.get(token);
    if (!item) return null;

    if (Date.now() - item.createdAt > TTL_MS) {
        store.delete(token);
        return null;
    }
    return item.payload;
}

function deleteToken(token) {
    store.delete(token);
}

module.exports = { createToken, getToken, deleteToken };
