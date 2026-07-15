const { ROLE_PRIORITY } = require('./constants');

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
    const flags = { don: donOn, doctor: doctorOn, detective: detectiveOn, courtesan: courtesanOn, maniac: maniacOn };
    let overflow = uniqueSpecial - n;
    for (let i = ROLE_PRIORITY.length - 1; i >= 0 && overflow > 0; i--) {
      if (flags[ROLE_PRIORITY[i]]) { flags[ROLE_PRIORITY[i]] = false; overflow -= 1; }
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

module.exports = { assignRoles };