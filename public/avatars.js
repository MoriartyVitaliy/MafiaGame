// ---------- Кастомные портреты ----------
// Ключ — никнейм в нижнем регистре (без пробелов по краям).
const CUSTOM_AVATARS = {
  // 'дядя толик': { hat: true, glasses: true, mustache: true, hue: 38, special: 'gold' },
  // 'марина': { svg: '<svg viewBox="0 0 100 100">...</svg>' },
};

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKIN_TONES = ['#e8c19a', '#d8a878', '#c48f66', '#a97650', '#8a5f3d'];

function buildFeatures(seedStr) {
  const rand = mulberry32(hashString(seedStr));
  return {
    hue: Math.floor(rand() * 360),
    skin: SKIN_TONES[Math.floor(rand() * SKIN_TONES.length)],
    hat: rand() > 0.35,
    glasses: rand() > 0.6,
    mustache: rand() > 0.55,
    browAngle: rand() > 0.5 ? 1 : -1,
    faceTilt: (rand() - 0.5) * 6,
  };
}

function buildAvatarSVG(features, special) {
  const { hue, skin, hat, glasses, mustache, browAngle, faceTilt } = features;
  const bg1 = `hsl(${hue}, 30%, 22%)`;
  const bg2 = `hsl(${hue}, 35%, 14%)`;
  const specialRing = special === 'gold'
    ? `<circle cx="50" cy="50" r="47" fill="none" stroke="#e2c17f" stroke-width="3"/>`
    : '';

  return `
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg-${hue}" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="${bg1}"/>
      <stop offset="100%" stop-color="${bg2}"/>
    </radialGradient>
  </defs>
  <circle cx="50" cy="50" r="49" fill="url(#bg-${hue})"/>
  ${specialRing}
  <g transform="rotate(${faceTilt} 50 55)">
    <rect x="40" y="66" width="20" height="14" rx="6" fill="${skin}"/>
    <ellipse cx="50" cy="52" rx="19" ry="22" fill="${skin}"/>
    <path d="M33 44 q8 ${-4 * browAngle} 14 0" stroke="#3a2a1a" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M53 44 q8 ${4 * browAngle} 14 0" stroke="#3a2a1a" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <circle cx="42" cy="50" r="2.3" fill="#241a10"/>
    <circle cx="58" cy="50" r="2.3" fill="#241a10"/>
    ${mustache ? '<path d="M40 61 q10 6 20 0 q-10 8 -20 0" fill="#2a2015"/>' : ''}
    <path d="M43 66 q7 4 14 0" stroke="#7a5a3a" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    ${glasses ? `
      <circle cx="42" cy="50" r="7" fill="none" stroke="#1a1a1a" stroke-width="2"/>
      <circle cx="58" cy="50" r="7" fill="none" stroke="#1a1a1a" stroke-width="2"/>
      <line x1="49" y1="50" x2="51" y2="50" stroke="#1a1a1a" stroke-width="2"/>
    ` : ''}
    ${hat ? `
      <path d="M28 38 q22 -20 44 0 q-4 -3 -44 0 z" fill="#211a12"/>
      <ellipse cx="50" cy="38" rx="26" ry="4.2" fill="#1a140d"/>
    ` : ''}
  </g>
</svg>`.trim();
}

// seed — стабильный id игрока (sessionId), name — ник
function renderAvatar(seed, name) {
  const key = String(name || '').trim().toLowerCase();
  const custom = CUSTOM_AVATARS[key];
  if (custom && custom.svg) return custom.svg;

  const features = buildFeatures(seed || key);
  if (custom) Object.assign(features, custom);
  return buildAvatarSVG(features, custom && custom.special);
}