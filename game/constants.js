const NIGHT_DURATION = parseInt(process.env.NIGHT_DURATION, 10) || 35;
const DAY_DURATION = parseInt(process.env.DAY_DURATION, 10) || 75;
const VOTING_DURATION = parseInt(process.env.VOTING_DURATION, 10) || 30;
const LAST_WORD_DURATION = parseInt(process.env.LAST_WORD_DURATION, 10) || 25;
const DISCONNECT_GRACE_MS = parseInt(process.env.DISCONNECT_GRACE_MS, 10) || 45000;
const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_MS, 10) || 1000;
const MAX_PLAYERS_PER_ROOM = parseInt(process.env.MAX_PLAYERS_PER_ROOM, 10) || 15;
const MIN_PLAYERS_TO_START = parseInt(process.env.MIN_PLAYERS_TO_START, 10) || 4;

const MAFIA_FACTION_ROLES = ['mafia', 'don'];

const ROLE_PRIORITY = ['don', 'doctor', 'detective', 'courtesan', 'maniac'];

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

module.exports = {
  NIGHT_DURATION,
  DAY_DURATION,
  VOTING_DURATION,
  LAST_WORD_DURATION,
  DISCONNECT_GRACE_MS,
  SWEEP_INTERVAL_MS,
  MAX_PLAYERS_PER_ROOM,
  MIN_PLAYERS_TO_START,
  MAFIA_FACTION_ROLES,
  ROLE_PRIORITY,
  TURN_ANNOUNCE,
};