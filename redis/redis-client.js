const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

function makeClient(label) {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (err) => console.error(`[redis:${label}] ошибка:`, err.message));
  client.on('reconnecting', () => console.warn(`[redis:${label}] переподключение...`));
  return client;
}

async function connectAll() {
  const dataClient = makeClient('data');
  const pubClient = makeClient('pub');
  const subClient = pubClient.duplicate();
  subClient.on('error', (err) => console.error('[redis:sub] ошибка:', err.message));

  await Promise.all([dataClient.connect(), pubClient.connect(), subClient.connect()]);

  return { dataClient, pubClient, subClient };
}

module.exports = { connectAll, REDIS_URL };