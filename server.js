const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-memory game state ----------
// player = { sessionId, socketId, name, role, alive, caseNumber, connected, disconnectTimer }
// room.hostId хранит sessionId хоста (не socket.id!)
const rooms = {};
const NIGHT_DURATION = 35;
const DAY_DURATION = 75;
const VOTING_DURATION = 30;
const LAST_WORD_DURATION = 25;
const DISCONNECT_GRACE_MS = 45000;

const TURN_ANNOUNCE = {
  courtesanStart: 'Путана, откройте глаза и выберите, кого навестить этой ночью.',
  courtesanEnd:   'Путана, закройте глаза.',
  mafiaStart: 'Город засыпает. Мафия, откройте глаза и выберите жертву.',
  mafiaEnd:   'Мафия, закройте глаза.',
  donStart: 'Дон, откройте глаза и укажите, кого хотите проверить на детектива.',
  donEnd:   'Дон, закройте глаза.',
  detectiveStart: 'Детектив, откройте глаза и укажите на подозреваемого.',
  detectiveEnd:   'Детектив, закройте глаза.',
  doctorStart: 'Доктор, откройте глаза и выберите, кого спасти.',
  doctorEnd:   'Доктор, закройте глаза.',
  maniacStart: 'Маньяк, откройте глаза и выберите свою жертву.',
  maniacEnd:   'Маньяк, закройте глаза.',
  nightEnd: 'Город просыпается.',
};


const MAFIA_FACTION_ROLES = ['mafia', 'don'];

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

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
    courtesanOn = !!cfg.roles?.courtesan; // NEW
    donOn = !!cfg.roles?.don; // NEW
    maniacOn = !!cfg.roles?.maniac; // NEW
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

function endGame(room, winner) {
  room.phase = 'ended';
  clearTimeout(room.timer);
  const revealed = room.players.map((p) => ({ id: p.sessionId, name: p.name, role: p.role, alive: p.alive }));
  const winText = winner === 'mafia'
    ? 'Мафия захватила город. Игра окончена.'
    : winner === 'maniac'
      ? 'Маньяк остался в городе один. Игра окончена.' // NEW
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

function startNight(room) {
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
  advanceNightTurn(room);
}

function roleHasActiveActor(room, role) {
  const actors = role === 'mafia' ? aliveMafiaFaction(room) : aliveByRole(room, role);
  return actors.some((p) => p.sessionId !== room.night.blockedSessionId);
}

function advanceNightTurn(room) {
  if (room.phase !== 'night') return;
  clearTimeout(room.timer);
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
    room.timer = setTimeout(() => {
      io.to(room.code).emit('announce', TURN_ANNOUNCE[`${role}End`]);
      advanceNightTurn(room);
    }, turnDuration);
  }
}

function resolveNight(room) {
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
  if (winner) { endGame(room, winner); return; }
  startDay(room);
}

function startDay(room) {
  room.phase = 'day';
  room.introDay = false;
  room.speakOrder = computeSpeakOrder(room);
  pushLog(room, '— День. Город обсуждает случившееся. —');
  scheduleAutoAdvance(room, 'day', () => startVoting(room));
  broadcastRoom(room);
}

function startIntroDay(room) {
  room.phase = 'day';
  room.introDay = true;
  room.speakOrder = computeSpeakOrder(room);
  pushLog(room, '— Первый день. Познакомьтесь и обсудите стратегию — сегодня без голосования. —');
  scheduleAutoAdvance(room, 'day', () => {
    room.introDay = false;
    startNight(room);
  });
  broadcastRoom(room);
}

function startVoting(room, opts = {}) {
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

  scheduleAutoAdvance(room, 'voting', () => resolveVoting(room));
  broadcastRoom(room);
}

function scheduleAutoAdvance(room, key, onExpire) {
  clearTimeout(room.timer);
  const auto = isAutoTimer(room);
  const fallback = { day: DAY_DURATION, voting: VOTING_DURATION }[key];
  const seconds = phaseDurationSeconds(room, key, fallback);
  room.phaseEndsAt = auto ? Date.now() + seconds * 1000 : null;
  if (auto) {
    room.timer = setTimeout(onExpire, seconds * 1000);
  }
}

function startLastWord(room, targetSessionId) {
  const target = findPlayerBySession(room, targetSessionId);
  room.phase = 'lastword';
  room.lastWordTarget = targetSessionId;
  pushLog(room, `Город указал на ${target ? target.name : 'подозреваемого'}. Даём последнее слово перед решением.`);

  const auto = isAutoTimer(room);
  const seconds = LAST_WORD_DURATION;
  clearTimeout(room.timer);
  room.phaseEndsAt = auto ? Date.now() + seconds * 1000 : null;
  broadcastRoom(room);

  if (auto) {
    room.timer = setTimeout(() => finalizeElimination(room), seconds * 1000);
  }
}

function finalizeElimination(room) {
  if (room.phase !== 'lastword') return;
  clearTimeout(room.timer);
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
  if (winner) { endGame(room, winner); return; }
  startNight(room);
}

function resolveVoting(room) {
  if (room.phase !== 'voting') return;
  clearTimeout(room.timer);

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
      if (winner) { endGame(room, winner); return; }
      startNight(room);
      return;
    }
    startVoting(room, { revote: true, candidates: tiedIds });
    return;
  }

  if (eliminatedSessionId) {
    startLastWord(room, eliminatedSessionId);
    return;
  }

  pushLog(room, 'Город не пришёл к решению — большинство воздержалось.');
  room.dayVotes = {};
  room.voteCandidates = null;
  const winner = checkWinCondition(room);
  if (winner) { endGame(room, winner); return; }
  startNight(room);
}

function findRoomBySocket(socketId) {
  return Object.values(rooms).find((r) => r.players.some((p) => p.socketId === socketId));
}

function removePlayer(room, sessionId, logText) {
  const idx = room.players.findIndex((p) => p.sessionId === sessionId);
  if (idx === -1) return;
  const [left] = room.players.splice(idx, 1);
  clearTimeout(left.disconnectTimer);
  pushLog(room, logText || `${left.name} покинул расследование.`);

  if (room.players.length === 0) {
    clearTimeout(room.timer);
    delete rooms[room.code];
    return;
  }

  if (room.hostId === sessionId) {
    room.hostId = room.players[0].sessionId;
  }

  if (room.phase === 'lastword' && room.lastWordTarget === sessionId) {
    room.phase = 'day';
    room.phase = 'lastword';
    room.lastWordTarget = null;
    clearTimeout(room.timer);
    room.dayVotes = {};
    room.voteCandidates = null;
    const winner = checkWinCondition(room);
    if (winner) { endGame(room, winner); return; }
    startNight(room);
    return;
  }
  if (room.phase !== 'lobby' && room.phase !== 'ended') {
    const winner = checkWinCondition(room);
    if (winner) { endGame(room, winner); return; }
  }
  broadcastRoom(room);
}

// ---------- Socket handlers ----------
io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, sessionId }) => {
    if (!sessionId) return socket.emit('errorMsg', 'Не удалось создать сессию. Обновите страницу.');
    const code = genRoomCode();
    const player = {
      sessionId,
      socketId: socket.id,
      name: (name || 'Игрок').slice(0, 20),
      role: null,
      alive: true,
      caseNumber: null,
      connected: true,
      disconnectTimer: null,
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
    rooms[code] = room;
    socket.join(code);
    socket.emit('roomJoined', { code });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name, sessionId }) => {
    if (!sessionId) return socket.emit('errorMsg', 'Не удалось создать сессию. Обновите страницу.');
    const room = rooms[(code || '').toUpperCase()];
    if (!room) return socket.emit('errorMsg', 'Комната не найдена. Проверьте код.');

    const existing = findPlayerBySession(room, sessionId);
    if (existing) {
      clearTimeout(existing.disconnectTimer);
      existing.disconnectTimer = null;
      existing.socketId = socket.id;
      existing.connected = true;
      socket.join(room.code);
      socket.emit('roomJoined', { code: room.code });
      if (room.phase !== 'lobby' && room.phase !== 'ended' && existing.role) {
        socket.emit('roleSync', { role: existing.role, caseNumber: existing.caseNumber });
      }
      broadcastRoom(room);
      return;
    }

    if (room.phase !== 'lobby') return socket.emit('errorMsg', 'Игра уже началась в этой комнате.');
    if (room.players.length >= 15) return socket.emit('errorMsg', 'Комната заполнена.');
    room.players.push({
      sessionId,
      socketId: socket.id,
      name: (name || 'Игрок').slice(0, 20),
      role: null,
      alive: true,
      caseNumber: null,
      connected: true,
      disconnectTimer: null,
    });
    socket.join(room.code);
    socket.emit('roomJoined', { code: room.code });
    pushLog(room, `${name || 'Игрок'} присоединился к расследованию.`);
    broadcastRoom(room);
  });

  socket.on('rejoinRoom', ({ code, sessionId }) => {
    const room = rooms[(code || '').toUpperCase()];
    if (!room) return socket.emit('rejoinFailed');
    const player = findPlayerBySession(room, sessionId);
    if (!player) return socket.emit('rejoinFailed');

    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    player.socketId = socket.id;
    player.connected = true;
    socket.join(room.code);
    socket.emit('roomJoined', { code: room.code });

    if (room.phase !== 'lobby' && room.phase !== 'ended' && player.role) {
      socket.emit('roleSync', { role: player.role, caseNumber: player.caseNumber });
    }
    pushLog(room, `${player.name} снова на связи.`);
    broadcastRoom(room);
  });

  socket.on('startGame', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (!isHostSocket(room, socket.id)) return socket.emit('errorMsg', 'Только ведущий может начать игру.');
    if (room.players.length < 4) return socket.emit('errorMsg', 'Нужно минимум 4 игрока.');

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

    startIntroDay(room);
  });

  socket.on('updateSettings', ({ code, settings }) => {
    const room = rooms[code];
    if (!room || !isHostSocket(room, socket.id) || room.phase !== 'lobby') return;

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

  socket.on('nightAction', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'night') return;
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
      const activeVoters = aliveMafiaFaction(room).filter((p) => p.sessionId !== room.night.blockedSessionId).map((p) => p.sessionId);
      const allVoted = activeVoters.every((sid) => room.night.mafiaVotes[sid]);
      broadcastRoom(room); 
      if (allVoted) {
        io.to(room.code).emit('announce', TURN_ANNOUNCE.mafiaEnd);
        advanceNightTurn(room);
      }
    } else if (player.role === 'don' && room.night.currentTurn === 'don') {

      const target = findPlayerBySession(room, targetId);
      if (target) socket.emit('donResult', { targetId, name: target.name, isDetective: target.role === 'detective' });
      io.to(room.code).emit('announce', TURN_ANNOUNCE.donEnd);
      advanceNightTurn(room);

    } else if (player.role === 'doctor') {

      room.night.doctorSave = targetId;
      socket.emit('actionAck', { message: 'Вы выбрали, кого спасти этой ночью.' });
      io.to(room.code).emit('announce', TURN_ANNOUNCE.doctorEnd);
      advanceNightTurn(room);

    } else if (player.role === 'detective') {

      const target = findPlayerBySession(room, targetId);
      if (target) socket.emit('detectiveResult', { targetId, name: target.name, isMafia: MAFIA_FACTION_ROLES.includes(target.role) });
      io.to(room.code).emit('announce', TURN_ANNOUNCE.detectiveEnd);
      advanceNightTurn(room);

    } else if (player.role === 'courtesan') {

      room.night.blockedSessionId = targetId;
      socket.emit('actionAck', { message: 'Вы навестили выбранного участника этой ночью.' });
      io.to(room.code).emit('announce', TURN_ANNOUNCE.courtesanEnd);
      advanceNightTurn(room);

    } else if (player.role === 'maniac') {
      
      room.night.maniacTarget = targetId;
      socket.emit('actionAck', { message: 'Вы выбрали свою жертву этой ночью.' });
      io.to(room.code).emit('announce', TURN_ANNOUNCE.maniacEnd);
      advanceNightTurn(room);

    }
  });

  socket.on('dayVote', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'voting') return;
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
    if (allVoted) resolveVoting(room);
  });

  socket.on('chatMessage', ({ code, text }) => {
    const room = rooms[code];
    if (!room || !text) return;
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

  socket.on('finishLastWord', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'lastword') return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player || player.sessionId !== room.lastWordTarget) return;
    finalizeElimination(room);
  });

  socket.on('advancePhase', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (!isHostSocket(room, socket.id)) {
      return socket.emit('errorMsg', 'Только ведущий может пропустить фазу.');
    }
    if (room.phase === 'lobby' || room.phase === 'ended') return;

    clearTimeout(room.timer);

    if (room.phase === 'night') {
      const role = room.night.currentTurn;
      if (role) io.to(room.code).emit('announce', TURN_ANNOUNCE[`${role}End`]);
      advanceNightTurn(room);
    } else if (room.phase === 'day') {
      if (room.introDay) {
        room.introDay = false;
        startNight(room);
      } else {
        startVoting(room);
      }
    } else if (room.phase === 'voting') {
      resolveVoting(room);
    } else if (room.phase === 'lastword') {
      finalizeElimination(room);
    }
  });

  socket.on('leaveRoom', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;
    socket.leave(code);
    removePlayer(room, player.sessionId);
  });

  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const player = findPlayerBySocket(room, socket.id);
    if (!player) return;

    player.connected = false;
    pushLog(room, `${player.name} потерял связь...`);
    broadcastRoom(room);

    player.disconnectTimer = setTimeout(() => {
      removePlayer(room, player.sessionId);
    }, DISCONNECT_GRACE_MS);
  });
});

function clampNum(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Мафия онлайн запущена: http://localhost:${PORT}`);
});