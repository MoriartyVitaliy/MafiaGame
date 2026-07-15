const { SWEEP_INTERVAL_MS, TURN_ANNOUNCE } = require('./game/constants');

function startScheduler({ io, store, phaseManager, roomLifecycle }) {
  async function handleScheduledEvent(ev) {
    await roomLifecycle.withRoom(ev.code, async (room) => {
      switch (ev.action) {
        case 'nightTurnExpire':
          if (room.phase === 'night' && room.night?.currentTurn === ev.role) {
            io.to(room.code).emit('announce', TURN_ANNOUNCE[`${ev.role}End`]);
            await phaseManager.advanceNightTurn(room);
          }
          break;
        case 'dayExpire':
          if (room.phase !== 'day') break;
          if (ev.introDay) {
            room.introDay = false;
            await phaseManager.startNight(room);
          } else {
            await phaseManager.startVoting(room);
          }
          break;
        case 'votingExpire':
          if (room.phase === 'voting') await phaseManager.resolveVoting(room);
          break;
        case 'lastwordExpire':
          if (room.phase === 'lastword') await phaseManager.finalizeElimination(room);
          break;
        case 'disconnectGrace':
          await roomLifecycle.removePlayer(room, ev.sessionId);
          break;
        default:
          console.warn('Неизвестный тип отложенного события:', ev.action);
      }
    });
  }

  const sweepTimer = setInterval(async () => {
    try {
      const due = await store.popDueEvents();
      for (const ev of due) {
        handleScheduledEvent(ev).catch((err) => console.error('Ошибка обработки отложенного события:', ev, err));
      }
    } catch (err) {
      console.error('Ошибка sweep-цикла расписания:', err);
    }
  }, SWEEP_INTERVAL_MS);

  return sweepTimer;
}

module.exports = { startScheduler };