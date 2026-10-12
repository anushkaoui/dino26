// Integer-only, deterministic rules. Used for rendering and authoritative replay.
export const RULES = Object.freeze({ version: 1, hz: 60, durationMs: 180000,
  chunkFrames: 120, totalFrames: 10800, lateMs: 6000, width: 900, height: 240 });
export const ACTION = Object.freeze({ JUMP: 1, DUCK: 2, RELEASE: 3, RESTART: 4 });
export function rulesFor(minutes = 3) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 5) throw new Error('Duration must be 1–5 whole minutes');
  return { ...RULES, durationMs: minutes * 60000, totalFrames: minutes * 3600 };
}
const SCALE = 100;
export function initialState(frame = 0) {
  return { frame, running: false, run: 0, age: 0, distance: 0, y: 0, vy: 0,
    duck: false, obstacles: [], nextObstacle: 80, obstacleNo: 0,
    best: 0, bestAt: RULES.totalFrames, crashAt: -1 };
}
function mix(n) {
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}
export function course(seed, n) { return mix((seed ^ Math.imul(n + 1, 2654435761)) >>> 0); }
export function runScore(state) { return Math.floor(state.distance / 1000); }
export function rankValue(state) {
  return state.best ? state.best * 20000 + (20000 - state.bestAt) : 0;
}
export function decodeRank(value) {
  const score = Math.floor(value / 20000);
  return { score, achievedFrame: score ? 20000 - (value % 20000) : null };
}
export function step(s, actions, seed) {
  for (const action of actions) {
    if (action === ACTION.RESTART && !s.running &&
      (s.crashAt < 0 || s.frame - s.crashAt >= 30)) {
      const saved = { best: s.best, bestAt: s.bestAt, frame: s.frame, run: s.run + 1 };
      Object.assign(s, initialState(s.frame), saved, { running: true });
    }
    if (action === ACTION.JUMP && s.running && s.y === 0 && !s.duck) s.vy = 1150;
    if (action === ACTION.DUCK) s.duck = true;
    if (action === ACTION.RELEASE) s.duck = false;
  }
  s.frame++;
  if (!s.running) return s;
  s.age++;
  const speed = Math.min(1200, 580 + Math.floor(s.age / 30));
  s.vy -= 60;
  s.y = Math.max(0, s.y + s.vy);
  if (s.y === 0) s.vy = 0;
  if (s.age >= s.nextObstacle) {
    const r = course(seed, s.obstacleNo++);
    const bird = s.age > 1000 && r % 5 === 0;
    s.obstacles.push({ x: 940 * SCALE, w: bird ? 44 : 18 + r % 3 * 9,
      h: bird ? 24 : 34 + r % 3 * 8, y: bird ? 38 : 0, bird });
    // Minimum spacing covers a complete jump at maximum speed.
    s.nextObstacle = s.age + 85 + r % 46;
  }
  for (const o of s.obstacles) o.x -= speed;
  s.obstacles = s.obstacles.filter(o => o.x + o.w * SCALE > 0);
  const playerH = s.duck && s.y === 0 ? 20 : 43;
  const playerW = s.duck && s.y === 0 ? 48 : 28;
  const left = 82 * SCALE, bottom = s.y + 3 * SCALE;
  const hit = s.obstacles.some(o => left < o.x + (o.w - 2) * SCALE &&
    left + playerW * SCALE > o.x + 2 * SCALE &&
    bottom < (o.y + o.h - 2) * SCALE && bottom + (playerH - 3) * SCALE > o.y * SCALE);
  if (hit) { s.running = false; s.crashAt = s.frame; return s; }
  s.distance += speed;
  const score = runScore(s);
  if (score > s.best) { s.best = score; s.bestAt = s.frame; }
  return s;
}
export function replay(state, endFrame, inputs, seed) {
  const result = structuredClone(state);
  let at = 0;
  while (result.frame < endFrame) {
    const actions = [];
    while (at < inputs.length && inputs[at][0] === result.frame) actions.push(inputs[at++][1]);
    step(result, actions, seed);
  }
  return result;
}
