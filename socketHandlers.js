const { MAX_PLAYERS_PER_ROOM, MIN_PLAYERS_TO_START, DISCONNECT_GRACE_MS, TURN_ANNOUNCE } = require('./game/constants');
const {
  findPlayerBySession,
  findPlayerBySocket,
  isHostSocket,
  pushLog,
  aliveMafiaFaction,
} = require('./game/roomQueries');
const { assignRoles } = require('./game/roleAssignment');
const { handleNightAction } = require('./game/nightActions');

function clampNum(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function defaultSettings() {
  return {
    mafiaCount: 1,
    roles: { doctor: true, detective: true, courtesan: false, don: false, maniac: false },
    timer: { mode: 'manual', night: 60, day: 90, voting: 45 },
  };
}

function registerSocketHandlers(io, { store, phaseManager, roomLifecycle }) {
  const { withRoom, removePlayer } = roomLifecycle;

  io.on('connection', (socket) => {
    socket.on('createRoom', async ({ name, sessionId }) => {
      if (!sessionId) return socket.emit('errorMsg', 'Не удалось создать сессию. Обновите страницу.');
      try {
        const code = await store.generateRoomCode();
        const player = {
          sessionId,
          socketId: socket.id,
          name: (name || 'Игрок').slice(0, 20),
          role: null,
          alive: true,
          caseNumber: null,
          connected: true,
        };
        const room = {
          code,
          hostId: sessionId,
          players: [player],
          phase: 'lobby',
          introDay: false,
          round: 1,
          log: [],
          night: {},
          dayVotes: {},
          voteCandidates: null,
          voteRound: 1,
          lastWordTarget: null,
          speakOrder: null,
          doctorLastSaveId: null,
          settings: defaultSettings(),
        };
        await store.saveRoom(room);
        await store.setSocketRoom(socket.id, code);
        socket.join(code);
        socket.emit('roomJoined', { code });
        phaseManager.broadcastRoom(room);
      } catch (err) {
        console.error('Ошибка создания комнаты:', err);
        socket.emit('errorMsg', 'Не удалось создать комнату, попробуйте ещё раз.');
      }
    });

    socket.on('joinRoom', async ({ code, name, sessionId }) => {
      if (!sessionId) return socket.emit('errorMsg', 'Не удалось создать сессию. Обновите страницу.');
      const upperCode = (code || '').toUpperCase();
      const found = await withRoom(upperCode, async (room) => {
        const existing = findPlayerBySession(room, sessionId);
        if (existing) {
          await store.cancelEvent(`disconnect:${room.code}:${sessionId}`);
          existing.socketId = socket.id;
          existing.connected = true;
          await store.setSocketRoom(socket.id, room.code);
          socket.join(room.code);
          socket.emit('roomJoined', { code: room.code });
          if (room.phase !== 'lobby' && room.phase !== 'ended' && existing.role) {
            socket.emit('roleSync', { role: existing.role, caseNumber: existing.caseNumber });
          }
          phaseManager.broadcastRoom(room);
          return;
        }

        if (room.phase !== 'lobby') return socket.emit('errorMsg', 'Игра уже началась в этой комнате.');
        if (room.players.length >= MAX_PLAYERS_PER_ROOM) return socket.emit('errorMsg', 'Комната заполнена.');
        room.players.push({
          sessionId,
          socketId: socket.id,
          name: (name || 'Игрок').slice(0, 20),
          role: null,
          alive: true,
          caseNumber: null,
          connected: true,
        });
        await store.setSocketRoom(socket.id, room.code);
        socket.join(room.code);
        socket.emit('roomJoined', { code: room.code });
        pushLog(room, `${name || 'Игрок'} присоединился к расследованию.`);
        phaseManager.broadcastRoom(room);
      });
      if (!found) socket.emit('errorMsg', 'Комната не найдена. Проверьте код.');
    });

    socket.on('rejoinRoom', async ({ code, sessionId }) => {
      const upperCode = (code || '').toUpperCase();
      const found = await withRoom(upperCode, async (room) => {
        const player = findPlayerBySession(room, sessionId);
        if (!player) return;

        await store.cancelEvent(`disconnect:${room.code}:${sessionId}`);
        player.socketId = socket.id;
        player.connected = true;
        await store.setSocketRoom(socket.id, room.code);
        socket.join(room.code);
        socket.emit('roomJoined', { code: room.code });

        if (room.phase !== 'lobby' && room.phase !== 'ended' && player.role) {
          socket.emit('roleSync', { role: player.role, caseNumber: player.caseNumber });
        }
        pushLog(room, `${player.name} снова на связи.`);
        phaseManager.broadcastRoom(room);
      });
      if (!found) socket.emit('rejoinFailed');
    });

    socket.on('startGame', ({ code }) => {
      withRoom(code, async (room) => {
        if (!isHostSocket(room, socket.id)) return socket.emit('errorMsg', 'Только ведущий может начать игру.');
        if (room.players.length < MIN_PLAYERS_TO_START) return socket.emit('errorMsg', 'Нужно минимум 4 игрока.');

        assignRoles(room);
        room.round = 1;
        room.log = [];
        room.dayVotes = {};
        room.voteCandidates = null;
        room.voteRound = 1;
        room.lastWordTarget = null;
        room.doctorLastSaveId = null;
        pushLog(room, 'Дело открыто. Роли распределены. Да начнётся расследование.');

        room.players.forEach((p) => {
          io.to(p.socketId).emit('roleAssigned', { role: p.role, caseNumber: p.caseNumber });
        });

        await phaseManager.startIntroDay(room);
      });
    });

    socket.on('updateSettings', ({ code, settings }) => {
      withRoom(code, async (room) => {
        if (!isHostSocket(room, socket.id) || room.phase !== 'lobby') return;

        const playerCount = room.players.length;
        const maxMafia = Math.max(1, Math.floor(playerCount / 3));

        room.settings = {
          mafiaCount: Math.min(Math.max(1, parseInt(settings?.mafiaCount, 10) || 1), maxMafia),
          roles: {
            doctor: !!settings?.roles?.doctor,
            detective: !!settings?.roles?.detective,
            courtesan: !!settings?.roles?.courtesan,
            don: !!settings?.roles?.don,
            maniac: !!settings?.roles?.maniac,
          },
          timer: {
            mode: settings?.timer?.mode === 'auto' ? 'auto' : 'manual',
            night: clampNum(settings?.timer?.night, 10, 600, 60),
            day: clampNum(settings?.timer?.day, 10, 600, 90),
            voting: clampNum(settings?.timer?.voting, 10, 300, 45),
          },
        };
        phaseManager.broadcastRoom(room);
      });
    });

    // Здесь раньше был длинный if/else по всем ролям; теперь диспетчеризация
    // делегирована реестру команд в game/nightActions.js (Strategy/Command).
    socket.on('nightAction', ({ code, targetId }) => {
      withRoom(code, async (room) => {
        const player = findPlayerBySocket(room, socket.id);
        await handleNightAction({
          room,
          player,
          targetId,
          socket,
          io,
          broadcastRoom: phaseManager.broadcastRoom,
          advanceNightTurn: phaseManager.advanceNightTurn,
          aliveMafiaFaction,
        });
      });
    });

    socket.on('dayVote', ({ code, targetId }) => {
      withRoom(code, async (room) => {
        if (room.phase !== 'voting') return;
        const player = findPlayerBySocket(room, socket.id);
        if (!player || !player.alive) return;
        if (room.voteCandidates && room.voteCandidates.length && targetId !== 'skip' && !room.voteCandidates.includes(targetId)) {
          return;
        }
        room.dayVotes[player.sessionId] = targetId;
        socket.emit('actionAck', { message: 'Ваш голос учтён.' });
        phaseManager.broadcastRoom(room);

        const aliveIds = room.players.filter((p) => p.alive).map((p) => p.sessionId);
        const allVoted = aliveIds.every((sid) => room.dayVotes[sid]);
        if (allVoted) await phaseManager.resolveVoting(room);
      });
    });

    socket.on('chatMessage', ({ code, text }) => {
      withRoom(code, async (room) => {
        if (!text) return;
        const player = findPlayerBySocket(room, socket.id);
        if (!player) return;
        if (room.phase === 'night') return;
        if (room.phase === 'lastword' && player.sessionId !== room.lastWordTarget) return;
        const clean = String(text).slice(0, 300);
        io.to(room.code).emit('chatMessage', {
          name: player.name,
          text: clean,
          alive: player.alive,
          ts: Date.now(),
        });
      });
    });

    socket.on('finishLastWord', ({ code }) => {
      withRoom(code, async (room) => {
        if (room.phase !== 'lastword') return;
        const player = findPlayerBySocket(room, socket.id);
        if (!player || player.sessionId !== room.lastWordTarget) return;
        await phaseManager.finalizeElimination(room);
      });
    });

    socket.on('advancePhase', ({ code }) => {
      withRoom(code, async (room) => {
        if (!isHostSocket(room, socket.id)) {
          return socket.emit('errorMsg', 'Только ведущий может пропустить фазу.');
        }
        if (room.phase === 'lobby' || room.phase === 'ended') return;

        await store.cancelEvent(`phase:${room.code}`);

        if (room.phase === 'night') {
          const role = room.night.currentTurn;
          if (role) io.to(room.code).emit('announce', TURN_ANNOUNCE[`${role}End`]);
          await phaseManager.advanceNightTurn(room);
        } else if (room.phase === 'day') {
          if (room.introDay) {
            room.introDay = false;
            await phaseManager.startNight(room);
          } else {
            await phaseManager.startVoting(room);
          }
        } else if (room.phase === 'voting') {
          await phaseManager.resolveVoting(room);
        } else if (room.phase === 'lastword') {
          await phaseManager.finalizeElimination(room);
        }
      });
    });

    socket.on('leaveRoom', ({ code }) => {
      withRoom(code, async (room) => {
        const player = findPlayerBySocket(room, socket.id);
        if (!player) return;
        socket.leave(code);
        await store.clearSocketRoom(socket.id);
        await removePlayer(room, player.sessionId);
      });
    });

    socket.on('disconnect', async () => {
      const code = await store.getSocketRoom(socket.id);
      if (!code) return;
      await store.clearSocketRoom(socket.id);
      await withRoom(code, async (room) => {
        const player = findPlayerBySocket(room, socket.id);
        // если сокет уже переехал (например, игрок успел переподключиться под новым
        // socket.id раньше, чем сюда добралось это событие) — ничего не делаем
        if (!player || player.socketId !== socket.id) return;

        player.connected = false;
        pushLog(room, `${player.name} потерял связь...`);
        phaseManager.broadcastRoom(room);

        await store.scheduleEvent(
          `disconnect:${room.code}:${player.sessionId}`,
          { code: room.code, action: 'disconnectGrace', sessionId: player.sessionId },
          DISCONNECT_GRACE_MS,
        );
      });
    });
  });
}

module.exports = { registerSocketHandlers };