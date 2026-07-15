const { MAFIA_FACTION_ROLES } = require('./constants');

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

function computeSpeakOrder(room) {
  const alive = alivePlayers(room);
  if (alive.length === 0) return [];
  const offset = (room.round - 1) % alive.length;
  const ordered = alive.slice(offset).concat(alive.slice(0, offset));
  return ordered.map((p) => p.sessionId);
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

module.exports = {
  alivePlayers,
  aliveByRole,
  aliveMafiaFaction,
  publicPlayerList,
  pushLog,
  findPlayerBySession,
  findPlayerBySocket,
  isHostSocket,
  computeSpeakOrder,
  checkWinCondition,
};