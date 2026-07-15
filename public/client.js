const socket = io();

let previousAliveById = {};
let notesTargetId = null;
let ttsVoice = null;

const ROLE_INFO = {
  mafia: {
    label: 'МАФИЯ',
    css: 'role-mafia',
    desc: 'Каждую ночь вы выбираете жертву вместе с другими мафиози (и доном). Ваша цель — остаться незамеченными и устранить город.',
  },
  don: {
    label: 'ДОН',
    css: 'role-mafia',
    desc: 'Вы — глава мафии. Голосуете за жертву вместе с мафией, а также отдельно можете проверить, не детектив ли выбранный вами подозреваемый.',
  },
  doctor: {
    label: 'ДОКТОР',
    css: 'role-town',
    desc: 'Каждую ночь вы можете спасти одного человека (включая себя) от расправы.',
  },
  detective: {
    label: 'ДЕТЕКТИВ',
    css: 'role-town',
    desc: 'Каждую ночь вы проверяете одного подозреваемого и узнаёте, состоит ли он в мафии.',
  },
  courtesan: {
    label: 'ПУТАНА',
    css: 'role-town',
    desc: 'Каждую ночь вы навещаете одного из участников — он не сможет применить свою способность этой ночью.',
  },
  maniac: {
    label: 'МАНЬЯК',
    css: 'role-maniac',
    desc: 'Вы играете сами за себя. Каждую ночь выбираете жертву. Вы побеждаете, если остаётесь единственным выжившим в городе.',
  },
  civilian: {
    label: 'МИРНЫЙ ЖИТЕЛЬ',
    css: 'role-town',
    desc: 'У вас нет особых способностей. Внимательно следите за поведением других и голосуйте разумно.',
  },
};

const DEFAULT_SETTINGS = {
  mafiaCount: 1,
  roles: { doctor: true, detective: true, courtesan: false, don: false, maniac: false },
  timer: { mode: 'manual', night: 60, day: 90, voting: 45 },
};

function loadAllNotes() {
  try { return JSON.parse(localStorage.getItem('mafia:notes') || '{}'); }
  catch (e) { return {}; }
}

function saveNote(targetId, text) {
  try {
    const notes = loadAllNotes();
    if (text) notes[targetId] = text;
    else delete notes[targetId];
    localStorage.setItem('mafia:notes', JSON.stringify(notes));
  } catch (e) { /* ignore */ }
}

function openNotesFor(player) {
  notesTargetId = player.id;
  document.getElementById('notes-subject-name').textContent = player.name;
  document.getElementById('notes-subject-avatar').innerHTML = renderAvatar(player.id, player.name);
  const notes = loadAllNotes();
  document.getElementById('notes-textarea').value = notes[player.id] || '';
  openModal('notes-modal');
  document.getElementById('notes-textarea').focus();
}

document.getElementById('notes-textarea').addEventListener('input', (e) => {
  if (!notesTargetId) return;
  saveNote(notesTargetId, e.target.value.trim());
});

document.getElementById('btn-notes-clear').addEventListener('click', () => {
  document.getElementById('notes-textarea').value = '';
  if (notesTargetId) saveNote(notesTargetId, '');
});

document.getElementById('btn-close-notes').addEventListener('click', () => {
  closeModal('notes-modal');
  notesTargetId = null;
});

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  ttsVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('ru')) || voices[0] || null;
}

if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

function speakAnnounce(text) {
  if (!text || !('speechSynthesis' in window)) return;
  if (Sfx.isMuted && Sfx.isMuted()) return;
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ru-RU';
  if (ttsVoice) utter.voice = ttsVoice;
  utter.rate = 0.95;
  utter.pitch = 0.85;
  speechSynthesis.speak(utter);
}

function showAnnounceToast(text) {
  const toast = document.createElement('div');
  toast.className = 'announce-toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('on'));
  setTimeout(() => {
    toast.classList.remove('on');
    setTimeout(() => toast.remove(), 400);
  }, 3400);
}

socket.on('announce', (text) => {
  showAnnounceToast(text);
  speakAnnounce(text);
});

// ---------- устойчивая сессия для переживания перезагрузки ----------
function getSessionId() {
  try {
    let sid = localStorage.getItem('mafia:sessionId');
    if (!sid) {
      sid = (crypto.randomUUID ? crypto.randomUUID() : 'sid-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      localStorage.setItem('mafia:sessionId', sid);
    }
    return sid;
  } catch (e) {
    return 'sid-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
}

function saveSession(code) {
  try { localStorage.setItem('mafia:session', JSON.stringify({ code, name: myName })); } catch (e) { /* ignore */ }
}

function clearSession() {
  try { localStorage.removeItem('mafia:session'); } catch (e) { /* ignore */ }
}

function readSavedSession() {
  try {
    const raw = localStorage.getItem('mafia:session');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

const mySessionId = getSessionId();
// ----------------------------------------------------------------------

let myId = null;
let myRoomCode = null;
let myName = '';
let myRole = null;
let myCaseNumber = null;
let latestState = null;
let hasActedThisPhase = false;
let countdownInterval = null;
let lastDetectiveResult = null;
let lastDonResult = null;
let lastMafiaChoiceName = null;

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function openModal(id) { document.getElementById(id).classList.add('on'); }
function closeModal(id) { document.getElementById(id).classList.remove('on'); }

socket.on('connect', () => {
  myId = socket.id;
  const saved = readSavedSession();
  if (saved && saved.code) {
    myRoomCode = saved.code;
    myName = saved.name || myName;
    socket.emit('rejoinRoom', { code: saved.code, sessionId: mySessionId });
  }
});

socket.on('rejoinFailed', () => {
  clearSession();
});

// ---------- Lobby ----------
document.getElementById('btn-create').addEventListener('click', () => {
  myName = document.getElementById('input-name').value.trim() || 'Инспектор';
  socket.emit('createRoom', { name: myName, sessionId: mySessionId });
});

document.getElementById('btn-join').addEventListener('click', () => {
  myName = document.getElementById('input-name').value.trim() || 'Инспектор';
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!code) {
    document.getElementById('lobby-error').textContent = 'Введите код дела.';
    return;
  }
  socket.emit('joinRoom', { code, name: myName, sessionId: mySessionId });
});

document.getElementById('btn-leave-game').addEventListener('click', () => {
  const confirmed = confirm('Покинуть расследование? Вернуться в эту игру будет нельзя.');
  if (!confirmed) return;
  clearSession();
  socket.emit('leaveRoom', { code: myRoomCode });
  location.reload();
});

socket.on('errorMsg', (msg) => {
  const waitingVisible = document.getElementById('screen-waiting').classList.contains('active');
  document.getElementById(waitingVisible ? 'waiting-error' : 'lobby-error').textContent = msg;
});

socket.on('roomJoined', ({ code }) => {
  myRoomCode = code;
  saveSession(code);
  document.getElementById('lobby-error').textContent = '';
  document.getElementById('room-code-display').textContent = code;
  if (!document.getElementById('screen-game').classList.contains('active')) {
    showScreen('screen-waiting');
  }
});

document.getElementById('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard?.writeText(myRoomCode || '');
});

document.getElementById('btn-leave-waiting').addEventListener('click', () => {
  clearSession();
  socket.emit('leaveRoom', { code: myRoomCode });
  location.reload();
});

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('startGame', { code: myRoomCode });
});

// ---------- Room state updates ----------
socket.on('roomUpdate', (state) => {
  latestState = state;

  if (state.phase === 'lobby') {
    renderWaitingRoom(state);
  } else {
    showScreen('screen-game');
    renderGameScreen(state);
  }
});

function renderWaitingRoom(state) {
  const grid = document.getElementById('waiting-players');
  grid.innerHTML = '';
  state.players.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'suspect-card' + (p.alive ? '' : ' is-dead');
    card.innerHTML = `
      <div class="suspect-avatar">${renderAvatar(p.id, p.name)}</div>
      <div class="suspect-name">${escapeHtml(p.name)}</div>
      ${p.isHost ? '<div class="suspect-host-tag">Ведущий</div>' : ''}
      ${p.connected === false ? '<div class="suspect-offline-tag">Нет связи</div>' : ''}
    `;
    grid.appendChild(card);
  });

  const isHost = state.hostId === mySessionId;
  document.getElementById('btn-start').style.display = isHost ? 'block' : 'none';
  if (!isHost) {
    document.getElementById('waiting-error').textContent = '';
  }
  if (isHost && state.players.length < 4) {
    document.getElementById('btn-start').disabled = true;
    document.getElementById('waiting-error').textContent = `Ждём игроков: ${state.players.length}/4 минимум.`;
  } else {
    document.getElementById('btn-start').disabled = false;
    if (isHost) document.getElementById('waiting-error').textContent = '';
  }

  renderSettings(state, isHost);
}

// ---------- Room settings ----------
function renderSettings(state, isHost) {
  const settings = state.settings || DEFAULT_SETTINGS;
  const roles = settings.roles || {};
  const playerCount = state.players.length;
  const maxMafia = Math.max(1, Math.floor(playerCount / 3));

  const mafiaSlider = document.getElementById('mafia-count');
  mafiaSlider.max = maxMafia;
  const mafiaCount = Math.min(settings.mafiaCount, maxMafia);
  mafiaSlider.value = mafiaCount;
  document.getElementById('mafia-count-label').textContent = mafiaCount;

  document.getElementById('role-doctor').checked = !!roles.doctor;
  document.getElementById('role-detective').checked = !!roles.detective;
  document.getElementById('role-courtesan').checked = !!roles.courtesan;
  document.getElementById('role-don').checked = !!roles.don;
  document.getElementById('role-maniac').checked = !!roles.maniac;

  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === settings.timer.mode);
  });
  document.getElementById('timer-durations').classList.toggle('is-visible', settings.timer.mode === 'auto');
  document.getElementById('dur-night').value = settings.timer.night;
  document.getElementById('dur-day').value = settings.timer.day;
  document.getElementById('dur-voting').value = settings.timer.voting;

  const rolesUsed = mafiaCount
    + (roles.don ? 1 : 0)
    + (roles.doctor ? 1 : 0)
    + (roles.detective ? 1 : 0)
    + (roles.courtesan ? 1 : 0)
    + (roles.maniac ? 1 : 0);
  const civilians = playerCount - rolesUsed;

  const summary = document.getElementById('settings-summary');
  summary.textContent =
    `Мафия: ${mafiaCount}${roles.don ? ' + Дон' : ''} · Доктор: ${roles.doctor ? 'да' : 'нет'} · ` +
    `Детектив: ${roles.detective ? 'да' : 'нет'} · Путана: ${roles.courtesan ? 'да' : 'нет'} · ` +
    `Маньяк: ${roles.maniac ? 'да' : 'нет'} · Мирные: ${Math.max(civilians, 0)} · ` +
    `Таймер: ${settings.timer.mode === 'auto' ? 'автоматический' : 'ручной'}`;

  const box = document.getElementById('host-settings');
  box.classList.toggle('read-only', !isHost);
  box.querySelectorAll('input, button').forEach((el) => { el.disabled = !isHost; });
  document.getElementById('settings-badge').style.display = isHost ? 'none' : 'inline-block';

  if (isHost) {
    document.getElementById('btn-start').disabled = document.getElementById('btn-start').disabled || civilians < 0;
    if (civilians < 0) {
      document.getElementById('waiting-error').textContent = 'Слишком много ролей для текущего числа игроков.';
    }
  }
}

function readSettingsFromForm() {
  const mode = document.querySelector('.mode-btn.active')?.dataset.mode || 'manual';
  return {
    mafiaCount: parseInt(document.getElementById('mafia-count').value, 10) || 1,
    roles: {
      doctor: document.getElementById('role-doctor').checked,
      detective: document.getElementById('role-detective').checked,
      courtesan: document.getElementById('role-courtesan').checked,
      don: document.getElementById('role-don').checked, 
      maniac: document.getElementById('role-maniac').checked,
    },
    timer: {
      mode,
      night: clampNum(document.getElementById('dur-night').value, 10, 600, 60),
      day: clampNum(document.getElementById('dur-day').value, 10, 600, 90),
      voting: clampNum(document.getElementById('dur-voting').value, 10, 300, 45),
    },
  };
}

function clampNum(val, min, max, fallback) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function emitSettings() {
  if (!myRoomCode) return;
  socket.emit('updateSettings', { code: myRoomCode, settings: readSettingsFromForm() });
}

document.getElementById('mafia-count').addEventListener('input', () => {
  document.getElementById('mafia-count-label').textContent = document.getElementById('mafia-count').value;
});
document.getElementById('mafia-count').addEventListener('change', emitSettings);

document.getElementById('role-doctor').addEventListener('change', emitSettings);
document.getElementById('role-detective').addEventListener('change', emitSettings);
document.getElementById('role-courtesan').addEventListener('change', emitSettings); // NEW
document.getElementById('role-don').addEventListener('change', emitSettings); // NEW
document.getElementById('role-maniac').addEventListener('change', emitSettings); // NEW

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('timer-durations').classList.toggle('is-visible', btn.dataset.mode === 'auto');
    emitSettings();
  });
});

['dur-night', 'dur-day', 'dur-voting'].forEach((id) => {
  document.getElementById(id).addEventListener('change', emitSettings);
});

function pluralizeVotes(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'голос';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'голоса';
  return 'голосов';
}

function renderGameScreen(state) {
  const labels = {
    night: 'НОЧЬ',
    day: 'ДЕНЬ',
    voting: 'ГОЛОСОВАНИЕ',
    lastword: 'ПОСЛЕДНЕЕ СЛОВО',
    ended: 'ДЕЛО ЗАКРЫТО',
  };
  const labelEl = document.getElementById('phase-label');
  labelEl.textContent = state.phase === 'day' && state.introDay ? 'ЗНАКОМСТВО' : (labels[state.phase] || state.phase);
  labelEl.className = 'phase-label ' + (state.phase === 'night' ? 'night' : state.phase === 'voting' ? 'voting' : state.phase === 'lastword' ? 'lastword' : '');

  const roundBase = state.introDay ? 'Перед первой ночью' : `Раунд ${state.round}`;
  document.getElementById('phase-round').textContent =
    (state.phase === 'voting' && state.voteRound > 1) ? `${roundBase} · Переголосование ${state.voteRound - 1}` : roundBase;

  document.getElementById('night-overlay').classList.toggle('on', state.phase === 'night');

  clearInterval(countdownInterval);
  const timerMode = state.settings ? state.settings.timer.mode : 'manual';
  const isHost = state.hostId === mySessionId;
  const advanceBtn = document.getElementById('btn-advance-phase');

  if (timerMode === 'auto' && state.phaseEndsAt) {
    advanceBtn.style.display = 'none';
    countdownInterval = setInterval(() => {
      const remaining = Math.max(0, state.phaseEndsAt - Date.now());
      const s = Math.ceil(remaining / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      document.getElementById('phase-timer').textContent = `${mm}:${ss}`;
      if (remaining <= 0) clearInterval(countdownInterval);
    }, 250);
  } else {
    document.getElementById('phase-timer').textContent = '--:--';
    advanceBtn.style.display = isHost && state.phase !== 'ended' ? 'inline-flex' : 'none';
  }

  if (renderGameScreen.lastPhase !== state.phase || renderGameScreen.lastNightTurn !== state.nightTurn) {
    hasActedThisPhase = false;
    if (renderGameScreen.lastPhase !== state.phase) {
      if (state.phase === 'night') { lastDetectiveResult = null; lastDonResult = null; lastMafiaChoiceName = null; Sfx.nightStart(); }
      else if (state.phase === 'day') Sfx.dayStart();
      else if (state.phase === 'voting') Sfx.votingStart();
    }
    renderGameScreen.lastPhase = state.phase;
    renderGameScreen.lastNightTurn = state.nightTurn;
  }

  const newlyEliminated = new Set();
  state.players.forEach((p) => {
    if (previousAliveById[p.id] === true && p.alive === false) newlyEliminated.add(p.id);
    previousAliveById[p.id] = p.alive;
  });
  if (newlyEliminated.size > 0) Sfx.elimination();

  renderSpeakOrder(state);

  const grid = document.getElementById('game-players');
  grid.innerHTML = '';
  state.players.forEach((p) => {
    const card = document.createElement('div');
    const isLastWordTarget = state.phase === 'lastword' && p.id === state.lastWordTarget;
    card.className = 'suspect-card'
      + (p.alive ? '' : ' is-dead')
      + (newlyEliminated.has(p.id) ? ' just-eliminated' : '')
      + (isLastWordTarget ? ' is-last-word' : '');
    card.dataset.id = p.id;

    let voteBadge = '';
    let voteForTag = '';
    if (state.phase === 'voting' && state.dayVotes) {
      const votesForThis = Object.values(state.dayVotes).filter((v) => v === p.id).length;
      if (votesForThis > 0) {
        voteBadge = `<div class="vote-count-badge">${votesForThis} ${pluralizeVotes(votesForThis)}</div>`;
      }
      const chosen = state.dayVotes[p.id];
      if (chosen) {
        const chosenName = chosen === 'skip' ? 'пропуск' : (state.players.find((x) => x.id === chosen)?.name || '?');
        voteForTag = `<div class="vote-for-tag">→ ${escapeHtml(chosenName)}</div>`;
      }
    }

    card.innerHTML = `
      ${voteBadge}
      <div class="suspect-avatar">${renderAvatar(p.id, p.name)}</div>
      <div class="suspect-name">${escapeHtml(p.name)}${p.id === mySessionId ? ' (вы)' : ''}</div>
      <div class="suspect-case">дело №${p.caseNumber || '---'}</div>
      ${voteForTag}
      ${isLastWordTarget ? '<div class="last-word-badge">ПОСЛЕДНЕЕ СЛОВО</div>' : ''}
      ${!p.alive ? '<div class="eliminated-stamp">УСТРАНЁН</div>' : ''}
      ${p.alive && p.connected === false ? '<div class="suspect-offline-tag">Нет связи</div>' : ''}
    `;
    grid.appendChild(card);
    card.addEventListener('click', () => {
      if (!p.alive) return;
      openNotesFor(p);
    });
  });

  const me = state.players.find((p) => p.id === mySessionId);
  const chatInput = document.getElementById('chat-input');
  const iAmAlive = me ? me.alive : true;
  const inLastWord = state.phase === 'lastword'; // NEW
  const isLastWordSpeaker = inLastWord && me && me.id === state.lastWordTarget; // NEW

  chatInput.disabled = state.phase === 'night' || !iAmAlive || (inLastWord && !isLastWordSpeaker);
  chatInput.placeholder = state.phase === 'night'
    ? 'Ночью город молчит...'
    : (!iAmAlive
      ? 'Вы устранены — только наблюдение'
      : inLastWord
        ? (isLastWordSpeaker ? 'Ваше последнее слово...' : 'Слушаем последнее слово...')
        : 'Сказать городу...');

  const logEl = document.getElementById('event-log');
  logEl.innerHTML = state.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  logEl.scrollTop = logEl.scrollHeight;

  renderActionPanel(state, me);
}

function renderSpeakOrder(state) {
  const bar = document.getElementById('speak-order-bar');
  if (!bar) return;
  const hideOn = ['night', 'lastword', 'ended', 'lobby'];
  if (!state.speakOrder || !state.speakOrder.length || hideOn.includes(state.phase)) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = '<span class="speak-order-label">Порядок выступления:</span>' + state.speakOrder.map((id, i) => {
    const p = state.players.find((x) => x.id === id);
    if (!p) return '';
    const cls = 'speak-order-chip' + (p.alive ? '' : ' is-dead') + (id === mySessionId ? ' is-me' : '');
    return `<span class="${cls}">${i + 1}. ${escapeHtml(p.name)}</span>`;
  }).join('');
}

document.getElementById('btn-advance-phase').addEventListener('click', () => {
  socket.emit('advancePhase', { code: myRoomCode });
});

function renderActionPanel(state, me) {
  const panel = document.getElementById('action-panel');
  panel.innerHTML = '';

  if (!me) return;

  if (!me.alive) {
    panel.innerHTML = '<h3>Вы устранены</h3><p>Наблюдайте за расследованием в тишине.</p>';
    return;
  }

  // NEW: фаза последнего слова
  if (state.phase === 'lastword') {
    const target = state.players.find((p) => p.id === state.lastWordTarget);
    if (me.id === state.lastWordTarget) {
      panel.innerHTML = '<h3>Ваше последнее слово</h3><p>Скажите городу всё, что считаете нужным, прежде чем решение вступит в силу.</p>';
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.marginTop = '12px';
      btn.textContent = 'Я сказал всё';
      btn.addEventListener('click', () => socket.emit('finishLastWord', { code: myRoomCode }));
      panel.appendChild(btn);
    } else {
      panel.innerHTML = `<h3>Последнее слово</h3><p><strong>${escapeHtml(target ? target.name : '')}</strong> обращается к городу перед вынесением решения.</p>`;
    }
    return;
  }

  if (state.phase === 'night') {
    if (myRole === 'civilian') {
      panel.innerHTML = '<h3>Ночь</h3><p>У вас нет ночных действий. Спите спокойно... или нет.</p>';
      return;
    }

    // NEW: определяем, чей сейчас ход относительно роли игрока (у дона два разных хода)
    const myTurnKey = (myRole === 'don' && state.nightTurn === 'mafia') ? 'mafia'
      : (myRole === 'don' && state.nightTurn === 'don') ? 'don'
      : myRole;

    if (hasActedThisPhase) {
      if (myRole === 'detective' && state.nightTurn === 'detective' && lastDetectiveResult) {
        const { name, isMafia } = lastDetectiveResult;
        panel.innerHTML = `<h3>Результат проверки</h3><p><strong>${escapeHtml(name)}</strong> — ${isMafia ? '<span style="color:var(--rose-bright)">состоит в мафии!</span>' : 'не связан с мафией.'}</p>`;
      } else if (myRole === 'don' && state.nightTurn === 'don' && lastDonResult) {
        const { name, isDetective } = lastDonResult;
        panel.innerHTML = `<h3>Результат проверки</h3><p><strong>${escapeHtml(name)}</strong> — ${isDetective ? '<span style="color:var(--rose-bright)">это детектив!</span>' : 'не детектив.'}</p>`;
      } else if ((myRole === 'mafia' || myRole === 'don') && state.nightTurn === 'mafia' && lastMafiaChoiceName) {
        panel.innerHTML = `<h3>Выбор сделан</h3><p>Вы указали на <strong>${escapeHtml(lastMafiaChoiceName)}</strong>. Ждём остальных мафиози.</p>`;
      } else {
        panel.innerHTML = '<h3>Действие принято</h3><p>Ждём остальных участников ночи.</p>';
      }
      return;
    }

    if (state.nightTurn !== myTurnKey) {
      const waitingInfo = ROLE_INFO[state.nightTurn];
      const waitingLabel = state.nightTurn === 'mafia' ? 'Мафия'
        : waitingInfo ? waitingInfo.label : 'следующего участника';
      panel.innerHTML = `<h3>Ночь</h3><p>Сейчас ход: <strong>${waitingLabel}</strong>. Дождитесь своей очереди.</p>`;
      return;
    }

    const heading = (myRole === 'mafia' || (myRole === 'don' && state.nightTurn === 'mafia')) ? 'Выберите жертву'
      : (myRole === 'don' && state.nightTurn === 'don') ? 'Кого проверить на детектива?'
      : myRole === 'doctor' ? 'Выберите, кого спасти'
      : myRole === 'detective' ? 'Выберите, кого проверить'
      : myRole === 'courtesan' ? 'Кого навестить этой ночью?'
      : myRole === 'maniac' ? 'Выберите жертву'
      : 'Выберите цель';
    panel.innerHTML = `<h3>${heading}</h3>`;
    const list = document.createElement('div');
    list.className = 'suspects-grid';
    state.players.filter((p) => p.alive).forEach((p) => {
      if ((myRole === 'mafia' || myRole === 'don') && state.nightTurn === 'mafia' && p.id === me.id) return;
      if (myRole === 'maniac' && p.id === me.id) return;
      if (myRole === 'courtesan' && p.id === me.id) return;
      if (myRole === 'doctor' && state.doctorLastSaveId && p.id === state.doctorLastSaveId) {
        const lastName = state.players.find((p) => p.id === state.doctorLastSaveId)?.name;
        if (lastName) {
          const hint = document.createElement('p');
          hint.className = 'hint-text';
          hint.style.margin = '0 0 10px';
          hint.textContent = `Прошлой ночью вы спасли ${lastName} — сегодня его нельзя выбрать снова.`;
          panel.appendChild(hint);
        }}
      const el = document.createElement('div');
      el.className = 'suspect-card is-selectable';
      el.innerHTML = `<div class="suspect-avatar">${renderAvatar(p.id, p.name)}</div><div class="suspect-name">${escapeHtml(p.name)}</div>`;
      el.addEventListener('click', () => {
        socket.emit('nightAction', { code: myRoomCode, targetId: p.id });
        const isGroupKillTurn = (myRole === 'mafia' || myRole === 'don') && state.nightTurn === 'mafia';
        hasActedThisPhase = true;
        if (isGroupKillTurn) lastMafiaChoiceName = p.name;
        renderActionPanel(state, me);
      });
      list.appendChild(el);
    });
    panel.appendChild(list);
    return;
  }

  if (state.phase === 'day') {
    panel.innerHTML = state.introDay
      ? '<h3>Знакомство</h3><p>Первый день без голосования — присмотритесь друг к другу и обсудите стратегию.</p>'
      : '<h3>Обсуждение</h3><p>Обсудите подозрения в стенограмме справа. Голосование начнётся автоматически.</p>';
    return;
  }

  if (state.phase === 'voting') {
    if (hasActedThisPhase) {
      panel.innerHTML = '<h3>Голос принят</h3><p>Ждём остальных.</p>';
      return;
    }
    panel.innerHTML = state.voteRound > 1
      ? '<h3>Переголосование — за кого голосуем?</h3><p class="hint-text" style="margin:0 0 10px">Выбирайте среди тех, кто набрал поровну голосов.</p>'
      : '<h3>За кого голосуем?</h3>';
    const list = document.createElement('div');
    list.className = 'suspects-grid';
    const candidates = state.voteCandidates && state.voteCandidates.length
      ? state.players.filter((p) => p.alive && state.voteCandidates.includes(p.id))
      : state.players.filter((p) => p.alive);
    candidates.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'suspect-card is-selectable';
      el.innerHTML = `<div class="suspect-avatar">${renderAvatar(p.id, p.name)}</div><div class="suspect-name">${escapeHtml(p.name)}${p.id === me.id ? ' (вы)' : ''}</div>`;
      el.addEventListener('click', () => {
        socket.emit('dayVote', { code: myRoomCode, targetId: p.id });
        hasActedThisPhase = true;
        renderActionPanel(state, me);
      });
      list.appendChild(el);
    });
    panel.appendChild(list);
    return;
  }
}

// ---------- Role reveal ----------
function applyRoleInfo(role, caseNumber, open) {
  myRole = role;
  myCaseNumber = caseNumber;
  const info = ROLE_INFO[role] || ROLE_INFO.civilian;
  const stampEl = document.getElementById('role-stamp');
  stampEl.textContent = info.label;
  stampEl.className = 'stamp' + (info.css === 'role-town' ? ' role-town' : info.css === 'role-maniac' ? ' role-maniac' : '');
  document.getElementById('role-desc').textContent = info.desc;
  document.getElementById('role-case-number').textContent = caseNumber;
  document.getElementById('btn-my-role').textContent = info.label[0];
  if (open) {
    stampEl.style.animation = 'none';
    requestAnimationFrame(() => { stampEl.style.animation = ''; });
    openModal('role-modal');
  }
}

socket.on('roleAssigned', ({ role, caseNumber }) => applyRoleInfo(role, caseNumber, true));
socket.on('roleSync', ({ role, caseNumber }) => applyRoleInfo(role, caseNumber, false));

document.getElementById('btn-close-role').addEventListener('click', () => closeModal('role-modal'));
document.getElementById('btn-my-role').addEventListener('click', () => {
  if (!myRole) return;
  openModal('role-modal');
});

// ---------- Detective / Don results ----------
socket.on('detectiveResult', ({ name, isMafia }) => {
  hasActedThisPhase = true;
  lastDetectiveResult = { name, isMafia };
  const panel = document.getElementById('action-panel');
  panel.innerHTML = `<h3>Результат проверки</h3><p><strong>${escapeHtml(name)}</strong> — ${isMafia ? '<span style="color:var(--rose-bright)">состоит в мафии!</span>' : 'не связан с мафией.'}</p>`;
});

socket.on('donResult', ({ name, isDetective }) => {
  hasActedThisPhase = true;
  lastDonResult = { name, isDetective };
  const panel = document.getElementById('action-panel');
  panel.innerHTML = `<h3>Результат проверки</h3><p><strong>${escapeHtml(name)}</strong> — ${isDetective ? '<span style="color:var(--rose-bright)">это детектив!</span>' : 'не детектив.'}</p>`;
});

socket.on('actionAck', ({ message }) => {
  hasActedThisPhase = true;
  document.getElementById('action-panel').innerHTML = `<h3>Действие принято</h3><p>${escapeHtml(message)}</p>`;
});

// ---------- Chat ----------
document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chatMessage', { code: myRoomCode, text });
  input.value = '';
});

socket.on('chatMessage', ({ name, text, alive }) => {
  const chatLog = document.getElementById('chat-log');
  const div = document.createElement('div');
  if (!alive) div.classList.add('chat-line-dead');
  if (name === myName) div.classList.add('chat-line-self');
  else Sfx.pop();
  div.innerHTML = `<span class="chat-line-name">${escapeHtml(name)}:</span> ${escapeHtml(text)}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;

  const panel = document.getElementById('transcript-panel');
  if (panel.classList.contains('collapsed') && name !== myName) {
    const handle = document.getElementById('btn-toggle-chat');
    handle.classList.add('has-new');
    setTimeout(() => handle.classList.remove('has-new'), 1500);
  }
});

// ---------- Night spotlight follows the cursor ----------
const nightOverlay = document.getElementById('night-overlay');
let targetLightX = window.innerWidth / 2;
let targetLightY = window.innerHeight * 0.4;
let currentLightX = targetLightX;
let currentLightY = targetLightY;

window.addEventListener('mousemove', (e) => {
  targetLightX = e.clientX;
  targetLightY = e.clientY;
});
window.addEventListener('touchmove', (e) => {
  if (e.touches && e.touches[0]) {
    targetLightX = e.touches[0].clientX;
    targetLightY = e.touches[0].clientY;
  }
}, { passive: true });

function animateNightLight() {
  currentLightX += (targetLightX - currentLightX) * 0.12;
  currentLightY += (targetLightY - currentLightY) * 0.12;
  nightOverlay.style.setProperty('--mx', `${currentLightX}px`);
  nightOverlay.style.setProperty('--my', `${currentLightY}px`);
  requestAnimationFrame(animateNightLight);
}
requestAnimationFrame(animateNightLight);

// ---------- Collapsible transcript panel ----------
const transcriptPanel = document.getElementById('transcript-panel');
const toggleChatBtn = document.getElementById('btn-toggle-chat');
const transcriptBackdrop = document.getElementById('transcript-backdrop');

function setChatCollapsed(collapsed) {
  transcriptPanel.classList.toggle('collapsed', collapsed);
  document.body.classList.toggle('chat-collapsed', collapsed);
  toggleChatBtn.setAttribute('aria-expanded', String(!collapsed));
  if (transcriptBackdrop) transcriptBackdrop.classList.toggle('on', !collapsed);
  try { localStorage.setItem('mafia:chatCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
}

toggleChatBtn.addEventListener('click', () => {
  setChatCollapsed(!transcriptPanel.classList.contains('collapsed'));
});

// тап по затемнённому фону тоже закрывает панель
transcriptBackdrop?.addEventListener('click', () => setChatCollapsed(true));

try {
  const saved = localStorage.getItem('mafia:chatCollapsed');
  if (saved === '1') {
    setChatCollapsed(true);
  } else if (saved === null && window.matchMedia('(max-width: 859px)').matches) {
    // на мобильных по умолчанию свёрнуто — иначе при первом входе панель
    // сразу перекроет весь экран затемнением
    setChatCollapsed(true);
  }
} catch (e) { /* ignore */ }

// ---------- Game over ----------
socket.on('gameOver', ({ winner, revealed }) => {
  if (winner === 'town') Sfx.victory();
  else if (winner === 'maniac') Sfx.defeat();
  else Sfx.defeat();

  const stampEl = document.getElementById('verdict-stamp');
  const verdictText = winner === 'mafia' ? 'МАФИЯ ПОБЕДИЛА'
    : winner === 'maniac' ? 'ПОБЕДИЛ МАНЬЯК'
    : 'ГОРОД СПАСЁН';
  stampEl.textContent = verdictText;
  stampEl.className = 'stamp' + (winner === 'town' ? ' role-town' : winner === 'maniac' ? ' role-maniac' : '');
  stampEl.style.animation = 'none';
  requestAnimationFrame(() => { stampEl.style.animation = ''; });

  const listEl = document.getElementById('reveal-list');
  listEl.innerHTML = revealed.map((p) => {
    const info = ROLE_INFO[p.role] || ROLE_INFO.civilian;
    const cls = (p.role === 'mafia' || p.role === 'don') ? 'reveal-role-mafia'
      : p.role === 'maniac' ? 'reveal-role-maniac'
      : 'reveal-role-town';
    return `<div>${escapeHtml(p.name)} — <span class="${cls}">${info.label}</span>${p.alive ? '' : ' (устранён)'}</div>`;
  }).join('');

  openModal('gameover-modal');
});

document.getElementById('btn-new-game').addEventListener('click', () => {
  clearSession();
  location.reload();
});

socket.on('nightActionError', ({ message }) => {
  hasActedThisPhase = false;
  if (!latestState) return;
  const me = latestState.players.find((p) => p.id === mySessionId);
  renderActionPanel(latestState, me);
  const panel = document.getElementById('action-panel');
  const warn = document.createElement('div');
  warn.className = 'hint-text';
  warn.style.color = 'var(--rose-bright)';
  warn.style.margin = '0 0 10px';
  warn.textContent = message;
  panel.prepend(warn);
});

// ---------- Utils ----------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const muteBtn = document.getElementById('btn-mute');
function syncMuteButton() {
  muteBtn.textContent = Sfx.isMuted() ? '🔇' : '🔊';
  muteBtn.classList.toggle('is-muted', Sfx.isMuted());
}
muteBtn.addEventListener('click', () => {
  Sfx.setMuted(!Sfx.isMuted());
  syncMuteButton();
});
syncMuteButton();