const {
  DAY_DURATION,
  VOTING_DURATION,
  NIGHT_DURATION,
  LAST_WORD_DURATION,
  TURN_ANNOUNCE,
} = require('./constants');
const {
  alivePlayers,
  aliveByRole,
  aliveMafiaFaction,
  publicPlayerList,
  pushLog,
  findPlayerBySession,
  computeSpeakOrder,
  checkWinCondition,
} = require('./roomQueries');


function createPhaseManager({ io, store }) {
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
      doctorLastSaveId: room.doctorLastSaveId || null,
      ...extra,
    });
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

  function roleHasActiveActor(room, role) {
    const actors = role === 'mafia' ? aliveMafiaFaction(room) : aliveByRole(room, role);
    return actors.some((p) => p.sessionId !== room.night.blockedSessionId);
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

  return {
    broadcastRoom,
    nightOrder,
    roleHasActiveActor,
    phaseDurationSeconds,
    isAutoTimer,
    scheduleAutoAdvance,
    startNight,
    advanceNightTurn,
    resolveNight,
    startDay,
    startIntroDay,
    startVoting,
    startLastWord,
    finalizeElimination,
    resolveVoting,
    endGame,
  };
}

module.exports = { createPhaseManager };