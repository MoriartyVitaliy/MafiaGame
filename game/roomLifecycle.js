const { pushLog, checkWinCondition } = require('./roomQueries');

function createRoomLifecycle({ store, phaseManager }) {
  async function withRoom(code, handler) {
    if (!code) return false;
    let found = false;
    try {
      await store.withRoomLock(code, async () => {
        const room = await store.loadRoom(code);
        if (!room) return;
        found = true;
        await handler(room);
        if (room._deleted) {
          await store.deleteRoom(code);
        } else {
          await store.saveRoom(room);
        }
      });
    } catch (err) {
      console.error(`Ошибка обработки комнаты ${code}:`, err.message);
    }
    return found;
  }

  async function removePlayer(room, sessionId, logText) {
    const idx = room.players.findIndex((p) => p.sessionId === sessionId);
    if (idx === -1) return;
    const [left] = room.players.splice(idx, 1);
    await store.cancelEvent(`disconnect:${room.code}:${sessionId}`);
    pushLog(room, logText || `${left.name} покинул расследование.`);

    if (room.players.length === 0) {
      await store.cancelEvent(`phase:${room.code}`);
      room._deleted = true;
      return;
    }

    if (room.hostId === sessionId) {
      room.hostId = room.players[0].sessionId;
    }

    if (room.phase === 'lastword' && room.lastWordTarget === sessionId) {
      room.lastWordTarget = null;
      await store.cancelEvent(`phase:${room.code}`);
      room.dayVotes = {};
      room.voteCandidates = null;
      const winner = checkWinCondition(room);
      if (winner) { await phaseManager.endGame(room, winner); return; }
      await phaseManager.startNight(room);
      return;
    }
    if (room.phase !== 'lobby' && room.phase !== 'ended') {
      const winner = checkWinCondition(room);
      if (winner) { await phaseManager.endGame(room, winner); return; }
    }
    phaseManager.broadcastRoom(room);
  }

  return { withRoom, removePlayer };
}

module.exports = { createRoomLifecycle };