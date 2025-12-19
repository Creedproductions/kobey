const crypto = require('crypto');

const store = new Map();

// tokens expire fast so you don't leak memory
const TTL_MS = 10 * 60 * 1000; // 10 minutes

function create(videoUrl, audioUrl) {
    const token = crypto.randomBytes(16).toString('hex');
    store.set(token, { videoUrl, audioUrl, createdAt: Date.now() });
    return token;
}

function get(token) {
    const data = store.get(token);
    if (!data) return null;

    if (Date.now() - data.createdAt > TTL_MS) {
        store.delete(token);
        return null;
    }

    return data;
}

function del(token) {
    store.delete(token);
}

module.exports = {
    create,
    get,
    delete: del
};
