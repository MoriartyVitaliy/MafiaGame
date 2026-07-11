const ROOM_TTL_SECONDS = 6 * 60 * 60;
const LOCK_TTL_MS = 5000;
const EVENT_LOCK_TTL_MS = 10000;

const roomKey = (code) => `mafia:room:${code}`;
const lockKey = (code) => `mafia:lock:${code}`;
const socketRoomKey = (socketId) => `mafia:socket-room:${socketId}`;
const EVENTS_HASH = 'mafia:events';
const SCHEDULE_ZSET = 'mafia:schedule';

function makeStore(redis) {
  // ---------- Комнаты ----------
  async function roomExists(code) {
    return (await redis.exists(roomKey(code))) === 1;
  }

  async function loadRoom(code) {
    const raw = await redis.get(roomKey(code));
    return raw ? JSON.parse(raw) : null;
  }

  async function saveRoom(room) {
    await redis.set(roomKey(room.code), JSON.stringify(room), { EX: ROOM_TTL_SECONDS });
  }

  async function deleteRoom(code) {
    await redis.del(roomKey(code));
  }

  async function withRoomLock(code, fn) {
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let acquired = false;
    for (let i = 0; i < 40; i++) {
      const res = await redis.set(lockKey(code), token, { NX: true, PX: LOCK_TTL_MS });
      if (res === 'OK') { acquired = true; break; }
      await new Promise((r) => setTimeout(r, 40));
    }
    if (!acquired) {
      throw new Error(`Комната ${code} занята другой операцией, попробуйте ещё раз.`);
    }
    try {
      return await fn();
    } finally {
      const current = await redis.get(lockKey(code));
      if (current === token) await redis.del(lockKey(code));
    }
  }

  async function setSocketRoom(socketId, code) {
    await redis.set(socketRoomKey(socketId), code, { EX: ROOM_TTL_SECONDS });
  }
  async function getSocketRoom(socketId) {
    return redis.get(socketRoomKey(socketId));
  }
  async function clearSocketRoom(socketId) {
    await redis.del(socketRoomKey(socketId));
  }

  async function scheduleEvent(id, data, delayMs) {
    const fireAt = Date.now() + delayMs;
    const payload = JSON.stringify({ ...data, fireAt });
    await redis.multi()
      .hSet(EVENTS_HASH, id, payload)
      .zAdd(SCHEDULE_ZSET, [{ score: fireAt, value: id }])
      .exec();
  }

  async function cancelEvent(id) {
    await redis.multi()
      .hDel(EVENTS_HASH, id)
      .zRem(SCHEDULE_ZSET, id)
      .exec();
  }

  async function popDueEvents(now = Date.now()) {
    const ids = await redis.zRangeByScore(SCHEDULE_ZSET, 0, now);
    const events = [];
    for (const id of ids) {
      const lockRes = await redis.set(`mafia:evlock:${id}`, '1', { NX: true, PX: EVENT_LOCK_TTL_MS });
      if (lockRes !== 'OK') continue; // кто-то другой уже забрал это событие
      const raw = await redis.hGet(EVENTS_HASH, id);
      await redis.multi().hDel(EVENTS_HASH, id).zRem(SCHEDULE_ZSET, id).exec();
      if (raw) events.push({ id, ...JSON.parse(raw) });
    }
    return events;
  }

  // ---------- Генерация уникального кода комнаты ----------
  async function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      if (!(await roomExists(code))) return code;
    }
    throw new Error('Не удалось сгенерировать код комнаты.');
  }

  return {
    roomExists, loadRoom, saveRoom, deleteRoom,
    withRoomLock,
    setSocketRoom, getSocketRoom, clearSocketRoom,
    scheduleEvent, cancelEvent, popDueEvents,
    generateRoomCode,
  };
}

module.exports = { makeStore };