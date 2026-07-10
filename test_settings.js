const { io } = require("socket.io-client");
const N = 5;
let hostCode = null;
const sockets = [];
let gameEnded = false;

function log(...a){ console.log(...a); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  for (let i = 0; i < N; i++) {
    const s = io("http://localhost:3000");
    s.idx = i;
    sockets.push(s);
    s.on("roleAssigned", (r) => { s.myRole = r.role; log(`Player${i} role:`, r.role); });
    s.on("roomUpdate", (state) => { s.lastState = state; });
    s.on("gameOver", (g) => { gameEnded = true; log("=== GAME OVER:", g.winner, "==="); });
    s.on("detectiveResult", (r) => log(`Player${s.idx} detective:`, r));
    s.on("errorMsg", (m) => log(`Player${s.idx} ERROR:`, m));
    await new Promise((res) => s.on("connect", res));
  }

  sockets[0].emit("createRoom", { name: "Host" });
  await new Promise((res) => sockets[0].once("roomJoined", ({code}) => { hostCode = code; res(); }));
  log("room code", hostCode);

  for (let i = 1; i < N; i++) {
    sockets[i].emit("joinRoom", { code: hostCode, name: "Player"+i });
    await new Promise((res) => sockets[i].once("roomJoined", res));
  }
  await wait(300);

  log("--- default settings (should auto-scale to 5 players) ---");
  log(sockets[0].lastState.settings);

  log("--- host updates settings: manualTimer=true, custom roles/durations ---");
  sockets[0].emit("updateSettings", { code: hostCode, settings: {
    mafiaCount: 1, doctorCount: 1, detectiveCount: 1,
    nightDuration: 6, dayDuration: 6, votingDuration: 6,
    manualTimer: true,
  }});
  await wait(300);
  log(sockets[0].lastState.settings);

  // Non-host tries to change settings -> should be rejected
  sockets[1].emit("updateSettings", { code: hostCode, settings: { mafiaCount: 5 } });
  await wait(200);

  sockets[0].emit("startGame", { code: hostCode });
  await wait(400);

  let state = sockets[0].lastState;
  log("Phase after start:", state.phase, "phaseEndsAt:", state.phaseEndsAt, "(should be null - manual timer)");

  // Everyone with a night role acts -> should auto-resolve WITHOUT host starting timer
  for (const s of sockets) {
    const st = s.lastState;
    const me = st.players.find(p => p.id === s.id);
    if (!me.alive || !s.myRole || s.myRole === 'civilian') continue;
    const target = st.players.find(p => p.id !== s.id && p.alive);
    s.emit("nightAction", { code: hostCode, targetId: target.id });
  }
  await wait(400);
  state = sockets[0].lastState;
  log("Phase after all night actions submitted:", state.phase, "(expect 'day' even without timer)");
  log("phaseEndsAt on day (manual mode):", state.phaseEndsAt, "(should be null)");

  // Host force-resolves the day phase immediately instead of waiting
  sockets[0].emit("forceResolvePhase", { code: hostCode });
  await wait(300);
  state = sockets[0].lastState;
  log("Phase after forceResolvePhase during day:", state.phase, "(expect 'voting')");

  // Host explicitly starts a short timer for voting phase
  sockets[0].emit("startPhaseTimer", { code: hostCode, durationSeconds: 5 });
  await wait(100);
  state = sockets[0].lastState;
  log("Voting phaseEndsAt after host starts timer:", state.phaseEndsAt !== null);

  await wait(5300); // let the 5s (clamped minimum) voting timer expire on its own
  state = sockets[0].lastState;
  log("Phase after voting timer expired with nobody voting:", state.phase, "(expect 'night', round 2, no elimination)");
  log("round:", state.round);
  log(state.log.slice(-4));

  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });