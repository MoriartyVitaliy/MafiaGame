const { MAFIA_FACTION_ROLES, TURN_ANNOUNCE } = require('./constants');
const { findPlayerBySession } = require('./roomQueries');

function turnKeyForPlayer(player, currentTurn) {
  return player.role === 'don' && currentTurn === 'mafia' ? 'mafia' : player.role;
}

const mafiaKillCommand = {
  matchesRole: (role) => role === 'mafia' || role === 'don',
  execute(ctx) {
    const { room, player, targetId, io, broadcastRoom, aliveMafiaFaction, advanceNightTurn } = ctx;
    room.night.mafiaVotes[player.sessionId] = targetId;
    
    const activeVoters = aliveMafiaFaction(room)
      .filter((p) => p.sessionId !== room.night.blockedSessionId && p.connected !== false)
      .map((p) => p.sessionId);
    const allVoted = activeVoters.every((sid) => room.night.mafiaVotes[sid]);

    broadcastRoom(room);
    if (allVoted) {
      io.to(room.code).emit('announce', TURN_ANNOUNCE.mafiaEnd);
      return advanceNightTurn(room);
    }
  },
};

const donCheckCommand = {
  matchesRole: (role) => role === 'don',
  execute(ctx) {
    const { room, targetId, socket, io, advanceNightTurn } = ctx;
    const target = findPlayerBySession(room, targetId);
    if (target) socket.emit('donResult', { targetId, name: target.name, isDetective: target.role === 'detective' });
    io.to(room.code).emit('announce', TURN_ANNOUNCE.donEnd);
    return advanceNightTurn(room);
  },
};

const doctorSaveCommand = {
  matchesRole: (role) => role === 'doctor',
  execute(ctx) {
    const { room, targetId, socket, io, advanceNightTurn } = ctx;
    if (room.doctorLastSaveId === targetId) {
      socket.emit('actionAck', { message: 'Вы не можете спасти одного и того же участника в двух ночах подряд.' });
      return;
    }
    room.night.doctorSave = targetId;
    room.doctorLastSaveId = targetId;
    socket.emit('actionAck', { message: 'Вы выбрали, кого спасти этой ночью.' });
    io.to(room.code).emit('announce', TURN_ANNOUNCE.doctorEnd);
    return advanceNightTurn(room);
  },
};

const detectiveCheckCommand = {
  matchesRole: (role) => role === 'detective',
  execute(ctx) {
    const { room, targetId, socket, io, advanceNightTurn } = ctx;
    const target = findPlayerBySession(room, targetId);
    if (target) socket.emit('detectiveResult', { targetId, name: target.name, isMafia: MAFIA_FACTION_ROLES.includes(target.role) });
    io.to(room.code).emit('announce', TURN_ANNOUNCE.detectiveEnd);
    return advanceNightTurn(room);
  },
};

const courtesanBlockCommand = {
  matchesRole: (role) => role === 'courtesan',
  execute(ctx) {
    const { room, targetId, socket, io, advanceNightTurn } = ctx;
    room.night.blockedSessionId = targetId;
    socket.emit('actionAck', { message: 'Вы навестили выбранного участника этой ночью.' });
    io.to(room.code).emit('announce', TURN_ANNOUNCE.courtesanEnd);
    return advanceNightTurn(room);
  },
};

const maniacKillCommand = {
  matchesRole: (role) => role === 'maniac',
  execute(ctx) {
    const { room, targetId, socket, io, advanceNightTurn } = ctx;
    room.night.maniacTarget = targetId;
    socket.emit('actionAck', { message: 'Вы выбрали свою жертву этой ночью.' });
    io.to(room.code).emit('announce', TURN_ANNOUNCE.maniacEnd);
    return advanceNightTurn(room);
  },
};

const NIGHT_COMMANDS_BY_TURN = {
  mafia: mafiaKillCommand,
  don: donCheckCommand,
  doctor: doctorSaveCommand,
  detective: detectiveCheckCommand,
  courtesan: courtesanBlockCommand,
  maniac: maniacKillCommand,
};

function handleNightAction(ctx) {
  const { room, player } = ctx;
  if (room.phase !== 'night' || !player || !player.alive) return;

  const turnKey = turnKeyForPlayer(player, room.night.currentTurn);
  if (room.night.currentTurn !== turnKey) return;

  const command = NIGHT_COMMANDS_BY_TURN[room.night.currentTurn];
  if (!command || !command.matchesRole(player.role)) return;

  if (room.night.blockedSessionId === player.sessionId) {
    ctx.socket.emit('actionAck', { message: 'Этой ночью кто-то помешал вам действовать...' });
    return;
  }

  return command.execute(ctx);
}

module.exports = {
  handleNightAction,
  turnKeyForPlayer,
  NIGHT_COMMANDS_BY_TURN,
};