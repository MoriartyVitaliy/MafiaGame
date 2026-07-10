// Звуковые эффекты, синтезированные через Web Audio API — без внешних файлов.

const Sfx = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('mafia:muted') === '1'; } catch (e) { /* ignore */ }

  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Разблокируем AudioContext по первому жесту (требование браузеров)
  ['click', 'touchstart', 'keydown'].forEach((evt) => {
    window.addEventListener(evt, () => { try { ensureCtx(); } catch (e) { /* ignore */ } }, { once: true, passive: true });
  });

  function tone(freq, duration, { type = 'sine', gain = 0.15, delay = 0, glideTo = null } = {}) {
    if (muted) return;
    const c = ensureCtx();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime + delay);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, c.currentTime + delay + duration);
    g.gain.setValueAtTime(0, c.currentTime + delay);
    g.gain.linearRampToValueAtTime(gain, c.currentTime + delay + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + delay + duration);
    osc.connect(g).connect(c.destination);
    osc.start(c.currentTime + delay);
    osc.stop(c.currentTime + delay + duration + 0.05);
  }

  function noise(duration, { gain = 0.12, delay = 0 } = {}) {
    if (muted) return;
    const c = ensureCtx();
    const bufferSize = c.sampleRate * duration;
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const src = c.createBufferSource();
    src.buffer = buffer;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime + delay);
    src.connect(g).connect(c.destination);
    src.start(c.currentTime + delay);
  }

  return {
    isMuted: () => muted,
    setMuted(val) {
      muted = val;
      try { localStorage.setItem('mafia:muted', val ? '1' : '0'); } catch (e) { /* ignore */ }
    },
    click() { tone(660, 0.06, { type: 'square', gain: 0.05 }); },
    pop() { tone(520, 0.08, { type: 'sine', gain: 0.08 }); },
    nightStart() {
      tone(160, 1.4, { type: 'sine', gain: 0.12, glideTo: 90 });
      tone(80, 1.6, { type: 'sine', gain: 0.08, delay: 0.1 });
    },
    dayStart() {
      tone(523, 0.18, { type: 'triangle', gain: 0.12 });
      tone(659, 0.2, { type: 'triangle', gain: 0.1, delay: 0.14 });
      tone(784, 0.3, { type: 'triangle', gain: 0.1, delay: 0.28 });
    },
    votingStart() {
      tone(220, 0.5, { type: 'square', gain: 0.1 });
      tone(220, 0.5, { type: 'square', gain: 0.1, delay: 0.55 });
    },
    elimination() {
      noise(0.25, { gain: 0.2 });
      tone(90, 0.35, { type: 'sine', gain: 0.2, delay: 0.02 });
    },
    victory() {
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.35, { type: 'triangle', gain: 0.12, delay: i * 0.14 }));
    },
    defeat() {
      [220, 196, 165, 130].forEach((f, i) => tone(f, 0.5, { type: 'sawtooth', gain: 0.1, delay: i * 0.18 }));
    },
  };
})();