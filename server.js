require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { connectAll } = require('./redis/redis-client');
const { makeStore } = require('./redis/room-store');

const NIGHT_DURATION = parseInt(process.env.NIGHT_DURATION, 10) || 35;
const DAY_DURATION = parseInt(process.env.DAY_DURATION, 10) || 75;
const VOTING_DURATION = parseInt(process.env.VOTING_DURATION, 10) || 30;
const LAST_WORD_DURATION = parseInt(process.env.LAST_WORD_DURATION, 10) || 25;
const DISCONNECT_GRACE_MS = parseInt(process.env.DISCONNECT_GRACE_MS, 10) || 45000;
const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_MS, 10) || 1000;
const MAX_PLAYERS_PER_ROOM = parseInt(process.env.MAX_PLAYERS_PER_ROOM, 10) || 15;
const MIN_PLAYERS_TO_START = parseInt(process.env.MIN_PLAYERS_TO_START, 10) || 4;

const TURN_ANNOUNCE = {
  courtesanStart: 'Путана, откройте глаза и выберите, кого навестить этой ночью.',
  courtesanEnd: 'Путана, закройте глаза.',
  mafiaStart: 'Город засыпает. Мафия, откройте глаза и выберите жертву.',
  mafiaEnd: 'Мафия, закройте глаза.',
  donStart: 'Дон, откройте глаза и укажите, кого хотите проверить на детектива.',
  donEnd: 'Дон, закройте глаза.',
  detectiveStart: 'Детектив, откройте глаза и укажите на подозреваемого.',
  detectiveEnd: 'Детектив, закройте глаза.',
  doctorStart: 'Доктор, откройте глаза и выберите, кого спасти.',
  doctorEnd: 'Доктор, закройте глаза.',
  maniacStart: 'Маньяк, откройте глаза и выберите свою жертву.',
  maniacEnd: 'Маньяк, закройте глаза.',
  nightEnd: 'Город просыпается.',
};

const MAFIA_FACTION_ROLES = ['mafia', 'don'];

function clampNum(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function main() {
  const { dataClient, pubClient, subClient } = await connectAll();
  const store = makeStore(dataClient);

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { adapter: createAdapter(pubClient, subClient) });

  app.use(express.static(path.join(__dirname, 'public')));

  // ---------- Чистые функции над объектом комнаты (без побочных эффектов на Redis) ----------
  function alivePlayers(room) {
    return room.players.filter((p) => p.alive);
  }
  function aliveByRole(room, role) {
    return alivePlayers(room).filter((p) => p.role === role);
  }
  function aliveMafiaFaction(room) {
    return alivePlayers(room).filter((p) => MAFIA_FACTION_ROLES.includes(p.role));
  }
  function publicPlayerList(room) {
    return room.players.map((p) => ({
      id: p.sessionId,
      name: p.name,
      alive: p.alive,
      caseNumber: p.caseNumber,
      isHost: p.sessionId === room.hostId,
      connected: p.connected !== false,
    }));
  }
  function pushLog(room, text) {
    room.log.push(text);
  }
  function findPlayerBySession(room, sessionId) {
    return room.players.find((p) => p.sessionId === sessionId);
  }
  function findPlayerBySocket(room, socketId) {
    return room.players.find((p) => p.socketId === socketId);
  }
  function isHostSocket(room, socketId) {
    const player = findPlayerBySocket(room, socketId);
    return !!player && player.sessionId === room.hostId;
  }

  function broadcastRoom(room, extra = {}) {
    io.to(room.code).emit('roomUpdate', {
      code: room.code,
      phase: room.phase,
      round: room.round,
      introDay: !!room.introDay,
      hostId: room.hostId,
      players: publicPlayerList(room),
      log: room.log.slice(-30),
      phaseEndsAt: room.phaseEndsAt || null,
      nightTurn: room.phase === 'night' && room.night ? room.night.currentTurn || null : null,
      settings: room.settings,
      dayVotes: room.dayVotes || {},
      voteCandidates: room.voteCandidates || null,
      voteRound: room.voteRound || 1,
      lastWordTarget: room.phase === 'lastword' ? room.lastWordTarget : null,
      speakOrder: room.speakOrder || null,
      ...extra,
    });
  }

  function assignRoles(room) {
    const n = room.players.length;
    const shuffled = [...room.players].sort(() => Math.random() - 0.5);

    const cfg = room.settings;
    let mafiaCount, doctorOn, detectiveOn, courtesanOn, donOn, maniacOn;

    if (cfg) {
      const maxMafia = Math.max(1, Math.floor(n / 3));
      mafiaCount = Math.min(Math.max(1, cfg.mafiaCount || 1), maxMafia);
      doctorOn = !!cfg.roles?.doctor;
      detectiveOn = !!cfg.roles?.detective;
      courtesanOn = !!cfg.roles?.courtesan;
      donOn = !!cfg.roles?.don;
      maniacOn = !!cfg.roles?.maniac;
    } else {
      mafiaCount = Math.max(1, Math.floor(n / 4));
      doctorOn = n >= 5;
      detectiveOn = n >= 5;
      courtesanOn = false;
      donOn = false;
      maniacOn = false;
      if (n >= 9) mafiaCount = Math.max(mafiaCount, 2);
    }

    let uniqueSpecial = (doctorOn ? 1 : 0) + (detectiveOn ? 1 : 0) + (courtesanOn ? 1 : 0) + (donOn ? 1 : 0) + (maniacOn ? 1 : 0);
    if (mafiaCount + uniqueSpecial > n) {
      mafiaCount = Math.max(0, n - uniqueSpecial);
    }

    if (uniqueSpecial > n) {
      const priority = ['don', 'doctor', 'detective', 'courtesan', 'maniac'];
      const flags = { don: donOn, doctor: doctorOn, detective: detectiveOn, courtesan: courtesanOn, maniac: maniacOn };
      let overflow = uniqueSpecial - n;
      for (let i = priority.length - 1; i >= 0 && overflow > 0; i--) {
        if (flags[priority[i]]) { flags[priority[i]] = false; overflow -= 1; }
      }
      doctorOn = flags.doctor; detectiveOn = flags.detective; courtesanOn = flags.courtesan;
      donOn = flags.don; maniacOn = flags.maniac;
      mafiaCount = 0;
    }

    let idx = 0;
    for (let i = 0; i < mafiaCount && idx < n; i++) shuffled[idx++].role = 'mafia';
    if (donOn && idx < n) shuffled[idx++].role = 'don';
    if (doctorOn && idx < n) shuffled[idx++].role = 'doctor';
    if (detectiveOn && idx < n) shuffled[idx++].role = 'detective';
    if (courtesanOn && idx < n) shuffled[idx++].role = 'courtesan';
    if (maniacOn && idx < n) shuffled[idx++].role = 'maniac';
    for (; idx < n; idx++) shuffled[idx].role = 'civilian';

    room.players.forEach((p) => {
      p.alive = true;
      p.caseNumber = String(Math.floor(100 + Math.random() * 900));
    });
  }

  function checkWinCondition(room) {
    const alive = alivePlayers(room);
    const aliveManiac = alive.filter((p) => p.role === 'maniac').length;
    const aliveMafia = aliveMafiaFaction(room).length;
    const aliveTown = alive.length - aliveManiac - aliveMafia;

    if (aliveManiac > 0 && alive.length === aliveManiac) return 'maniac';
    if (aliveMafia === 0 && aliveManiac === 0) return 'town';
    if (aliveMafia > 0 && aliveMafia >= aliveTown + aliveManiac) return 'mafia';
    return null;
  }

  async function endGame(room, winner) {
    room.phase = 'ended';
    await store.cancelEvent(`phase:${room.code}`);
    const revealed = room.players.map((p) => ({ id: p.sessionId, name: p.name, role: p.role, alive: p.alive }));
    const winText = winner === 'mafia'
      ? 'Мафия захватила город. Игра окончена.'
      : winner === 'maniac'
        ? 'Маньяк остался в городе один. Игра окончена.'
        : 'Мирные жители победили. Игра окончена.';
    pushLog(room, winText);
    io.to(room.code).emit('gameOver', { winner, revealed });
    broadcastRoom(room);
  }

  function nightOrder(room) {
    const order = [];
    if (aliveByRole(room, 'courtesan').length) order.push('courtesan');
    if (aliveByRole(room, 'mafia').length || aliveByRole(room, 'don').length) order.push('mafia');
    if (aliveByRole(room, 'don').length) order.push('don');
    if (aliveByRole(room, 'detective').length) order.push('detective');
    if (aliveByRole(room, 'doctor').length) order.push('doctor');
    if (aliveByRole(room, 'maniac').length) order.push('maniac');
    return order;
  }

  function phaseDurationSeconds(room, key, fallbackSeconds) {
    if (room.settings && room.settings.timer && typeof room.settings.timer[key] === 'number') {
      return room.settings.timer[key];
    }
    return fallbackSeconds;
  }

  function isAutoTimer(room) {
    return !!(room.settings && room.settings.timer && room.settings.timer.mode === 'auto');
  }

  function computeSpeakOrder(room) {
    const alive = alivePlayers(room);
    if (alive.length === 0) return [];
    const offset = (room.round - 1) % alive.length;
    const ordered = alive.slice(offset).concat(alive.slice(0, offset));
    return ordered.map((p) => p.sessionId);
  }

  // ---------- Планирование фазовых таймеров (замена setTimeout на отложенные события в Redis) ----------
  async function scheduleAutoAdvance(room, key, extraData = {}) {
    await store.cancelEvent(`phase:${room.code}`);
    const auto = isAutoTimer(room);
    const fallback = { day: DAY_DURATION, voting: VOTING_DURATION }[key];
    const seconds = phaseDurationSeconds(room, key, fallback);
    room.phaseEndsAt = auto ? Date.now() + seconds * 1000 : null;
    if (auto) {
      const action = key === 'day' ? 'dayExpire' : 'votingExpire';
      await store.scheduleEvent(`phase:${room.code}`, { code: room.code, action, ...extraData }, seconds * 1000);
    }
  }

  async function startNight(room) {
    room.phase = 'night';
    room.introDay = false;
    room.dayVotes = {};
    room.voteCandidates = null;
    room.lastWordTarget = null;
    room.night = {
      mafiaVotes: {},
      doctorSave: null,
      blockedSessionId: null,
      maniacTarget: null,
      order: nightOrder(room),
      turnIndex: -1,
      currentTurn: null,
    };
    pushLog(room, `— Ночь ${room.round}. Город засыпает. —`);
    broadcastRoom(room);
    await advanceNightTurn(room);
  }

  function roleHasActiveActor(room, role) {
    const actors = role === 'mafia' ? aliveMafiaFaction(room) : aliveByRole(room, role);
    return actors.some((p) => p.sessionId !== room.night.blockedSessionId);
  }

  async function advanceNightTurn(room) {
    if (room.phase !== 'night') return;
    await store.cancelEvent(`phase:${room.code}`);
    room.night.turnIndex += 1;
    let role = room.night.order[room.night.turnIndex];

    while (role && !roleHasActiveActor(room, role)) {
      io.to(room.code).emit('announce', TURN_ANNOUNCE[`${role}Start`]);
      io.to(room.code).emit('announce', 'Кто-то этой ночью не смог встать с постели...');
      room.night.turnIndex += 1;
      role = room.night.order[room.night.turnIndex];
    }

    if (!role) {
      room.night.currentTurn = null;
      io.to(room.code).emit('announce', TURN_ANNOUNCE.nightEnd);
      return resolveNight(room);
    }

    const auto = isAutoTimer(room);
    const turnSeconds = phaseDurationSeconds(room, 'night', NIGHT_DURATION);
    const turnDuration = turnSeconds * 1000;

    room.night.currentTurn = role;
    room.phaseEndsAt = auto ? Date.now() + turnDuration : null;
    io.to(room.code).emit('announce', TURN_ANNOUNCE[`${role}Start`]);
    broadcastRoom(room);

    if (auto) {
      await store.scheduleEvent(`phase:${room.code}`, { code: room.code, action: 'nightTurnExpire', role }, turnDuration);
    }
  }

  async function resolveNight(room) {
    if (room.phase !== 'night') return;

    const votes = Object.values(room.night.mafiaVotes);
    let mafiaVictimId = null;
    if (votes.length > 0) {
      const tally = {};
      votes.forEach((v) => { tally[v] = (tally[v] || 0) + 1; });
      const max = Math.max(...Object.values(tally));
      const top = Object.keys(tally).filter((k) => tally[k] === max);
      mafiaVictimId = top[Math.floor(Math.random() * top.length)];
    }
    if (mafiaVictimId && mafiaVictimId === room.night.doctorSave) {
      mafiaVictimId = 'SAVED';
    }

    let maniacVictimId = room.night.maniacTarget || null;
    if (maniacVictimId && maniacVictimId === room.night.doctorSave) {
      maniacVictimId = 'SAVED';
    }

    let anyoneDied = false;

    if (mafiaVictimId === 'SAVED') {
      pushLog(room, 'Доктор спас подозреваемого этой ночью.');
    } else if (mafiaVictimId) {
      const victim = findPlayerBySession(room, mafiaVictimId);
      if (victim && victim.alive) {
        victim.alive = false;
        anyoneDied = true;
        pushLog(room, `Найдено тело: ${victim.name} (дело №${victim.caseNumber}). Похоже на почерк мафии.`);
      }
    }

    if (maniacVictimId === 'SAVED') {
      pushLog(room, 'Доктор успел спасти ещё одного подозреваемого этой ночью.');
    } else if (maniacVictimId && maniacVictimId !== mafiaVictimId) {
      const victim = findPlayerBySession(room, maniacVictimId);
      if (victim && victim.alive) {
        victim.alive = false;
        anyoneDied = true;
        pushLog(room, `Ещё одно тело найдено этой ночью: ${victim.name} (дело №${victim.caseNumber}). Почерк убийства другой — явно не мафия.`);
      }
    }

    if (!anyoneDied) {
      pushLog(room, 'Эта ночь прошла без жертв.');
    }

    room.round += 1;
    const winner = checkWinCondition(room);
    if (winner) { await endGame(room, winner); return; }
    await startDay(room);
  }

  async function startDay(room) {
    room.phase = 'day';
    room.introDay = false;
    room.speakOrder = computeSpeakOrder(room);
    pushLog(room, '— День. Город обсуждает случившееся. —');
    await scheduleAutoAdvance(room, 'day', { introDay: false });
    broadcastRoom(room);
  }

  async function startIntroDay(room) {
    room.phase = 'day';
    room.introDay = true;
    room.speakOrder = computeSpeakOrder(room);
    pushLog(room, '— Первый день. Познакомьтесь и обсудите стратегию — сегодня без голосования. —');
    await scheduleAutoAdvance(room, 'day', { introDay: true });
    broadcastRoom(room);
  }

  async function startVoting(room, opts = {}) {
    room.phase = 'voting';
    room.introDay = false;
    room.dayVotes = {};

    if (opts.revote) {
      room.voteRound = (room.voteRound || 1) + 1;
      room.voteCandidates = opts.candidates || [];
      const names = room.voteCandidates
        .map((id) => findPlayerBySession(room, id)?.name)
        .filter(Boolean)
        .join(', ');
      pushLog(room, `— Ничья голосов. Переголосование среди: ${names}. —`);
    } else {
      room.voteRound = 1;
      room.voteCandidates = alivePlayers(room).map((p) => p.sessionId);
      pushLog(room, '— Голосование началось. —');
    }

    await scheduleAutoAdvance(room, 'voting');
    broadcastRoom(room);
  }

  async function startLastWord(room, targetSessionId) {
    const target = findPlayerBySession(room, targetSessionId);
    room.phase = 'lastword';
    room.lastWordTarget = targetSessionId;
    pushLog(room, `Город указал на ${target ? target.name : 'подозреваемого'}. Даём последнее слово перед решением.`);

    await store.cancelEvent(`phase:${room.code}`);
    const auto = isAutoTimer(room);
    room.phaseEndsAt = auto ? Date.now() + LAST_WORD_DURATION * 1000 : null;
    broadcastRoom(room);

    if (auto) {
      await store.scheduleEvent(`phase:${room.code}`, { code: room.code, action: 'lastwordExpire' }, LAST_WORD_DURATION * 1000);
    }
  }

  async function finalizeElimination(room) {
    if (room.phase !== 'lastword') return;
    await store.cancelEvent(`phase:${room.code}`);
    const target = findPlayerBySession(room, room.lastWordTarget);
    if (target) {
      target.alive = false;
      const roleText = target.role === 'mafia' ? 'Он оказался мафиози!' : 'Он оказался мирным жителем.';
      pushLog(room, `Город изгнал ${target.name} (дело №${target.caseNumber}). ${roleText}`);
    }
    room.lastWordTarget = null;
    room.dayVotes = {};
    room.voteCandidates = null;

    const winner = checkWinCondition(room);
    if (winner) { await endGame(room, winner); return; }
    await startNight(room);
  }

  async function resolveVoting(room) {
    if (room.phase !== 'voting') return;
    await store.cancelEvent(`phase:${room.code}`);

    const entries = Object.entries(room.dayVotes).filter(([, v]) => v && v !== 'skip');
    const tally = {};
    entries.forEach(([, v]) => { tally[v] = (tally[v] || 0) + 1; });

    let eliminatedSessionId = null;
    let tie = false;
    let tiedIds = [];

    if (Object.keys(tally).length > 0) {
      const max = Math.max(...Object.values(tally));
      const top = Object.keys(tally).filter((k) => tally[k] === max);
      if (top.length === 1) {
        eliminatedSessionId = top[0];
      } else {
        tie = true;
        tiedIds = top;
      }
    }

    if (tie) {
      if ((room.voteRound || 1) >= 2) {
        pushLog(room, 'Повторная ничья голосов — город так и не пришёл к решению.');
        room.dayVotes = {};
        room.voteCandidates = null;
        const winner = checkWinCondition(room);
        if (winner) { await endGame(room, winner); return; }
        await startNight(room);
        return;
      }
      await startVoting(room, { revote: true, candidates: tiedIds });
      return;
    }

    if (eliminatedSessionId) {
      await startLastWord(room, eliminatedSessionId);
      return;
    }

    pushLog(room, 'Город не пришёл к решению — большинство воздержалось.');
    room.dayVotes = {};
    room.voteCandidates = null;
    const winner = checkWinCondition(room);
    if (winner) { await endGame(room, winner); return; }
    await startNight(room);
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
      if (winner) { await endGame(room, winner); return; }
      await startNight(room);
      return;
    }
    if (room.phase !== 'lobby' && room.phase !== 'ended') {
      const winner = checkWinCondition(room);
      if (winner) { await endGame(room, winner); return; }
    }
    broadcastRoom(room);
  }

  // ---------- Обёртка socket-хендлеров: лок + загрузка из Redis + сохранение обратно ----------
  // Возвращает true, если комната была найдена и обработчик реально выполнился —
  // это нужно там, где отсутствие комнаты — самостоятельная ошибка для клиента (join/rejoin).
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

  // ---------- Socket handlers ----------
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
          settings: {
            mafiaCount: 1,
            roles: { doctor: true, detective: true, courtesan: false, don: false, maniac: false },
            timer: { mode: 'manual', night: 60, day: 90, voting: 45 },
          },
        };
        await store.saveRoom(room);
        await store.setSocketRoom(socket.id, code);
        socket.join(code);
        socket.emit('roomJoined', { code });
        broadcastRoom(room);
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
          broadcastRoom(room);
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
        broadcastRoom(room);
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
        broadcastRoom(room);
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
        pushLog(room, 'Дело открыто. Роли распределены. Да начнётся расследование.');

        room.players.forEach((p) => {
          io.to(p.socketId).emit('roleAssigned', { role: p.role, caseNumber: p.caseNumber });
        });

        await startIntroDay(room);
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
        broadcastRoom(room);
      });
    });

    socket.on('nightAction', ({ code, targetId }) => {
      withRoom(code, async (room) => {
        if (room.phase !== 'night') return;
        const player = findPlayerBySocket(room, socket.id);
        if (!player || !player.alive) return;

        const turnKeyForRole = player.role === 'don' && room.night.currentTurn === 'mafia' ? 'mafia' : player.role;
        if (room.night.currentTurn !== turnKeyForRole) return;

        if (room.night.blockedSessionId === player.sessionId) {
          socket.emit('actionAck', { message: 'Этой ночью кто-то помешал вам действовать...' });
          return;
        }

        if (player.role === 'mafia' || (player.role === 'don' && room.night.currentTurn === 'mafia')) {
          room.night.mafiaVotes[player.sessionId] = targetId;
          // NEW: не ждём отключившегося игрока — иначе голосование мафии зависает
          // до конца грейс-периода реконнекта, даже если остальные уже выбрали.
          const activeVoters = aliveMafiaFaction(room)
            .filter((p) => p.sessionId !== room.night.blockedSessionId && p.connected !== false)
            .map((p) => p.sessionId);
          const allVoted = activeVoters.every((sid) => room.night.mafiaVotes[sid]);
          broadcastRoom(room);
          if (allVoted) {
            io.to(room.code).emit('announce', TURN_ANNOUNCE.mafiaEnd);
            await advanceNightTurn(room);
          }
        } else if (player.role === 'don' && room.night.currentTurn === 'don') {
          const target = findPlayerBySession(room, targetId);
          if (target) socket.emit('donResult', { targetId, name: target.name, isDetective: target.role === 'detective' });
          io.to(room.code).emit('announce', TURN_ANNOUNCE.donEnd);
          await advanceNightTurn(room);
        } else if (player.role === 'doctor') {
          room.night.doctorSave = targetId;
          socket.emit('actionAck', { message: 'Вы выбрали, кого спасти этой ночью.' });
          io.to(room.code).emit('announce', TURN_ANNOUNCE.doctorEnd);
          await advanceNightTurn(room);
        } else if (player.role === 'detective') {
          const target = findPlayerBySession(room, targetId);
          if (target) socket.emit('detectiveResult', { targetId, name: target.name, isMafia: MAFIA_FACTION_ROLES.includes(target.role) });
          io.to(room.code).emit('announce', TURN_ANNOUNCE.detectiveEnd);
          await advanceNightTurn(room);
        } else if (player.role === 'courtesan') {
          room.night.blockedSessionId = targetId;
          socket.emit('actionAck', { message: 'Вы навестили выбранного участника этой ночью.' });
          io.to(room.code).emit('announce', TURN_ANNOUNCE.courtesanEnd);
          await advanceNightTurn(room);
        } else if (player.role === 'maniac') {
          room.night.maniacTarget = targetId;
          socket.emit('actionAck', { message: 'Вы выбрали свою жертву этой ночью.' });
          io.to(room.code).emit('announce', TURN_ANNOUNCE.maniacEnd);
          await advanceNightTurn(room);
        }
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
        broadcastRoom(room);

        const aliveIds = alivePlayers(room).map((p) => p.sessionId);
        const allVoted = aliveIds.every((sid) => room.dayVotes[sid]);
        if (allVoted) await resolveVoting(room);
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
        await finalizeElimination(room);
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
          await advanceNightTurn(room);
        } else if (room.phase === 'day') {
          if (room.introDay) {
            room.introDay = false;
            await startNight(room);
          } else {
            await startVoting(room);
          }
        } else if (room.phase === 'voting') {
          await resolveVoting(room);
        } else if (room.phase === 'lastword') {
          await finalizeElimination(room);
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
        broadcastRoom(room);

        await store.scheduleEvent(
          `disconnect:${room.code}:${player.sessionId}`,
          { code: room.code, action: 'disconnectGrace', sessionId: player.sessionId },
          DISCONNECT_GRACE_MS,
        );
      });
    });
  });

  // ---------- Обработка отложенных событий (общая для всех инстансов) ----------
  async function handleScheduledEvent(ev) {
    await withRoom(ev.code, async (room) => {
      switch (ev.action) {
        case 'nightTurnExpire':
          if (room.phase === 'night' && room.night?.currentTurn === ev.role) {
            io.to(room.code).emit('announce', TURN_ANNOUNCE[`${ev.role}End`]);
            await advanceNightTurn(room);
          }
          break;
        case 'dayExpire':
          if (room.phase !== 'day') break;
          if (ev.introDay) {
            room.introDay = false;
            await startNight(room);
          } else {
            await startVoting(room);
          }
          break;
        case 'votingExpire':
          if (room.phase === 'voting') await resolveVoting(room);
          break;
        case 'lastwordExpire':
          if (room.phase === 'lastword') await finalizeElimination(room);
          break;
        case 'disconnectGrace':
          await removePlayer(room, ev.sessionId);
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