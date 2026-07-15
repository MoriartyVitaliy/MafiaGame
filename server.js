require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { connectAll } = require('./redis/redis-client');
const { makeStore } = require('./redis/room-store');

const { createPhaseManager } = require('./game/phaseManager');
const { createRoomLifecycle } = require('./game/roomLifecycle');
const { registerSocketHandlers } = require('./socketHandlers');
const { startScheduler } = require('./scheduler');

async function main() {
  const { dataClient, pubClient, subClient } = await connectAll();
  const store = makeStore(dataClient);

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { adapter: createAdapter(pubClient, subClient) });

  app.use(express.static(path.join(__dirname, 'public')));

  const phaseManager = createPhaseManager({ io, store });
  const roomLifecycle = createRoomLifecycle({ store, phaseManager });

  registerSocketHandlers(io, { store, phaseManager, roomLifecycle });
  const sweepTimer = startScheduler({ io, store, phaseManager, roomLifecycle });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Мафия онлайн запущена: http://localhost:${PORT}`);
  });

  async function shutdown() {
    console.log('Останавливаемся...');
    clearInterval(sweepTimer);
    server.close();
    await Promise.allSettled([dataClient.quit(), pubClient.quit(), subClient.quit()]);
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Не удалось запустить сервер:', err);
  process.exit(1);
});