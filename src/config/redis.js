const Redis = require('ioredis');

let redisClient = null;
const memoryStore = new Map();

try {
  redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 200, 2000);
    }
  });

  redisClient.on('connect', () => {
    console.log('✅ Redis connected successfully.');
  });

  redisClient.on('error', (err) => {
    console.warn('⚠️ Redis error (falling back to memory cache):', err.message);
  });
} catch (e) {
  console.warn('⚠️ Could not initialize Redis client, using in-memory store:', e.message);
}

// Wrapper with in-memory fallback
const cache = {
  async get(key) {
    if (redisClient && redisClient.status === 'ready') {
      try {
        return await redisClient.get(key);
      } catch (err) {
        return memoryStore.get(key) || null;
      }
    }
    return memoryStore.get(key) || null;
  },

  async set(key, value, expirySeconds = 3600) {
    const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (redisClient && redisClient.status === 'ready') {
      try {
        if (expirySeconds) {
          return await redisClient.set(key, strVal, 'EX', expirySeconds);
        }
        return await redisClient.set(key, strVal);
      } catch (err) {
        memoryStore.set(key, strVal);
      }
    } else {
      memoryStore.set(key, strVal);
    }
    return 'OK';
  },

  async del(key) {
    if (redisClient && redisClient.status === 'ready') {
      try {
        return await redisClient.del(key);
      } catch (err) {}
    }
    memoryStore.delete(key);
    return 1;
  },

  async rpush(key, value) {
    const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (redisClient && redisClient.status === 'ready') {
      try {
        return await redisClient.rpush(key, strVal);
      } catch (err) {}
    }
    const list = memoryStore.get(key) ? JSON.parse(memoryStore.get(key)) : [];
    list.push(strVal);
    memoryStore.set(key, JSON.stringify(list));
    return list.length;
  },

  async lpop(key) {
    if (redisClient && redisClient.status === 'ready') {
      try {
        return await redisClient.lpop(key);
      } catch (err) {}
    }
    const list = memoryStore.get(key) ? JSON.parse(memoryStore.get(key)) : [];
    const item = list.shift();
    memoryStore.set(key, JSON.stringify(list));
    return item || null;
  }
};

module.exports = { redisClient, cache };
