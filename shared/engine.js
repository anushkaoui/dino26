// Integer-only, deterministic rules for DinoSwords edition.
// Authoritative simulation used for client rendering and server replay.
export const RULES = Object.freeze({
  version: 1,
  hz: 60,
  durationMs: 180000,
  chunkFrames: 120,
  totalFrames: 10800,
  lateMs: 6000,
  width: 900,
  height: 240
});

export const ARMORY = Object.freeze({
  Q: { key: 'Q', name: 'Sword', uses: -1, desc: 'Slice Slice!', action: 5 },
  W: { key: 'W', name: 'Handgun', uses: 12, desc: 'One shot; One kill.', action: 6 },
  E: { key: 'E', name: 'Flip Flop', uses: 2, desc: "Grandma's weapon of choice", action: 7 },
  R: { key: 'R', name: 'Flamethrower', uses: 10, desc: 'Burn baby, burn!', action: 8 },
  T: { key: 'T', name: 'Shuriken', uses: 24, desc: 'Nani?!', action: 9 },
  Y: { key: 'Y', name: 'Scream', uses: -1, desc: 'AAHHHHH', action: 10 },
  U: { key: 'U', name: 'Chainsaw', uses: 10, desc: 'Revs continuously', action: 11 },
  I: { key: 'I', name: 'Helicopter', uses: 1, desc: 'Get to da choppa!', action: 12 },
  O: { key: 'O', name: 'Halberd', uses: -1, desc: "If it's good enough for the Swiss Guard, it's good enough for you.", action: 13 },
  P: { key: 'P', name: 'Flying Kick', uses: -1, desc: 'Hiyahhh!', action: 14 },
  A: { key: 'A', name: 'Cigarette', uses: 11, desc: 'WARNING: smoking may be hazardous for your health', action: 15 },
  S: { key: 'S', name: 'Rifle', uses: 30, desc: 'Pew pew!', action: 16 },
  D: { key: 'D', name: 'Double-Edged Sword', uses: -1, desc: 'So sharp you might cut yourself', action: 17 },
  F: { key: 'F', name: 'Pay Respects', uses: -1, desc: '"press f to pay respects"', action: 18 },
  G: { key: 'G', name: 'Holy Water', uses: 10, desc: 'Get raptured', action: 19 },
  H: { key: 'H', name: 'Portal Gun', uses: 16, desc: 'The cake is a lie', action: 20 },
  J: { key: 'J', name: 'Grenade Launcher', uses: 6, desc: '*fwoomp*', action: 21 },
  K: { key: 'K', name: 'Downers', uses: -1, desc: 'Get Sloowwwwww', action: 22 },
  L: { key: 'L', name: 'Uppers', uses: -1, desc: 'Gotta Go Fast!', action: 23 },
  Z: { key: 'Z', name: 'Meteor', uses: 1, desc: 'It’s a meteor. And what do meteors do?', action: 24 },
  X: { key: 'X', name: 'Laser Gun', uses: 10, desc: 'A concentrated beam of light.', action: 25 },
  C: { key: 'C', name: 'Chemical Warfare', uses: 1, desc: 'Illegal under multiple international treaties', action: 26 },
  V: { key: 'V', name: 'Home Run Bat', uses: -1, desc: 'Batter up!', action: 27 },
  B: { key: 'B', name: 'Bow and Arrow', uses: 12, desc: 'An oldie but goodie.', action: 28 },
  N: { key: 'N', name: 'Tank', uses: 1, desc: 'Ready to roll out!', action: 29 },
  M: { key: 'M', name: 'Hammer', uses: -1, desc: "We'd tell you whose hammer this is but copyright would kill us", action: 30 }
});

export const ACTION = Object.freeze({
  JUMP: 1,
  DUCK: 2,
  RELEASE: 3,
  RESTART: 4,
  USE_Q: 5,
  USE_W: 6,
  USE_E: 7,
  USE_R: 8,
  USE_T: 9,
  USE_Y: 10,
  USE_U: 11,
  USE_I: 12,
  USE_O: 13,
  USE_P: 14,
  USE_A: 15,
  USE_S: 16,
  USE_D: 17,
  USE_F: 18,
  USE_G: 19,
  USE_H: 20,
  USE_J: 21,
  USE_K: 22,
  USE_L: 23,
  USE_Z: 24,
  USE_X: 25,
  USE_C: 26,
  USE_V: 27,
  USE_B: 28,
  USE_N: 29,
  USE_M: 30
});

export const ACTION_TO_KEY = Object.freeze(
  Object.fromEntries(Object.entries(ARMORY).map(([k, v]) => [v.action, k]))
);

export function rulesFor(minutes = 3) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 5) throw new Error('Duration must be 1–5 whole minutes');
  return { ...RULES, durationMs: minutes * 60000, totalFrames: minutes * 3600 };
}

const SCALE = 100;

export function initialState(frame = 0) {
  return {
    frame,
    running: false,
    run: 0,
    age: 0,
    distance: 0,
    y: 0,
    vy: 0,
    duck: false,
    obstacles: [],
    nextObstacle: 80,
    obstacleNo: 0,
    crates: [],
    nextCrate: 140,
    crateNo: 0,
    inventory: { Q: -1 }, // Start with sword by default
    activeWeapon: 'Q',
    projectiles: [],
    effects: [],
    speedMod: 100, // percentage (100 = 1.0x)
    speedModUntil: 0,
    smokeCount: 0, // 0..11 for cigarette
    vehicle: null, // null | 'heli' | 'tank'
    vehicleUntil: 0,
    kickUntil: 0,
    respectUntil: 0,
    batEquipped: false,
    best: 0,
    bestAt: RULES.totalFrames,
    crashAt: -1
  };
}

function mix(n) {
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}

export function course(seed, n) {
  return mix((seed ^ Math.imul(n + 1, 2654435761)) >>> 0);
}

export function runScore(state) {
  return Math.floor(state.distance / 1000);
}

export function rankValue(state) {
  return state.best ? state.best * 20000 + (20000 - state.bestAt) : 0;
}

export function decodeRank(value) {
  const score = Math.floor(value / 20000);
  return { score, achievedFrame: score ? 20000 - (value % 20000) : null };
}

const ALL_WEAPON_KEYS = Object.keys(ARMORY);

export function step(s, actions, seed) {
  // Ensure inventory exists for backwards compatibility
  if (!s.inventory) s.inventory = { Q: -1 };
  if (!s.projectiles) s.projectiles = [];
  if (!s.crates) s.crates = [];
  if (!s.effects) s.effects = [];
  if (s.speedMod === undefined) s.speedMod = 100;
  if (s.smokeCount === undefined) s.smokeCount = 0;

  for (const action of actions) {
    if (action === ACTION.RESTART && !s.running &&
      (s.crashAt < 0 || s.frame - s.crashAt >= 30)) {
      const saved = { best: s.best, bestAt: s.bestAt, frame: s.frame, run: s.run + 1 };
      Object.assign(s, initialState(s.frame), saved, { running: true });
    }

    if (!s.running) continue;

    if (action === ACTION.JUMP && s.y === 0 && !s.duck) {
      s.vy = 1150;
    }
    if (action === ACTION.DUCK) s.duck = true;
    if (action === ACTION.RELEASE) s.duck = false;

    // Handle Weapon Usages (Actions 5 - 30)
    if (action >= 5 && action <= 30) {
      const key = ACTION_TO_KEY[action];
      if (key && s.inventory[key] !== undefined && (s.inventory[key] === -1 || s.inventory[key] > 0)) {
        s.activeWeapon = key;
        const arm = ARMORY[key];
        if (s.inventory[key] > 0) s.inventory[key]--;
        if (s.inventory[key] === 0) delete s.inventory[key];

        // Execute Weapon-Specific Logic
        switch (key) {
          case 'Q': { // Sword (melee slice)
            s.effects.push({ type: 'slice', x: (82 + 28) * SCALE, y: s.y + 15 * SCALE, ttl: 12 });
            const rangeMin = 75 * SCALE, rangeMax = 190 * SCALE;
            s.obstacles = s.obstacles.filter(o => !(o.x >= rangeMin && o.x <= rangeMax && Math.abs(o.y - (s.y / SCALE)) < 40));
            break;
          }
          case 'W': { // Handgun (bullet)
            s.projectiles.push({ type: 'bullet', x: (82 + 28) * SCALE, y: s.y + 24 * SCALE, vx: 2200, vy: 0, w: 12, h: 4, ttl: 45 });
            s.effects.push({ type: 'shot', x: (82 + 28) * SCALE, y: s.y + 24 * SCALE, ttl: 8 });
            break;
          }
          case 'E': { // Flip Flop (arced throw)
            s.projectiles.push({ type: 'flipflop', x: (82 + 24) * SCALE, y: s.y + 28 * SCALE, vx: 1100, vy: 480, grav: 30, w: 18, h: 10, ttl: 60 });
            break;
          }
          case 'R': { // Flamethrower
            s.effects.push({ type: 'flame', x: (82 + 28) * SCALE, y: s.y + 10 * SCALE, ttl: 20 });
            const rangeMin = 75 * SCALE, rangeMax = 250 * SCALE;
            s.obstacles = s.obstacles.filter(o => !(o.x >= rangeMin && o.x <= rangeMax));
            break;
          }
          case 'T': { // Shuriken
            s.projectiles.push({ type: 'shuriken', x: (82 + 26) * SCALE, y: s.y + 22 * SCALE, vx: 2400, vy: 0, w: 14, h: 14, ttl: 50 });
            break;
          }
          case 'Y': { // Scream (AAHHHH!)
            s.effects.push({ type: 'scream', x: (82 + 30) * SCALE, y: s.y + 28 * SCALE, ttl: 28 });
            // Clears any flying pterodactyls within range
            s.obstacles = s.obstacles.filter(o => !(o.bird && o.x < 420 * SCALE && o.x > 60 * SCALE));
            break;
          }
          case 'U': { // Chainsaw
            s.effects.push({ type: 'chainsaw', x: (82 + 28) * SCALE, y: s.y + 12 * SCALE, ttl: 18 });
            const rangeMin = 75 * SCALE, rangeMax = 180 * SCALE;
            s.obstacles = s.obstacles.filter(o => !(o.x >= rangeMin && o.x <= rangeMax));
            break;
          }
          case 'I': { // Helicopter
            s.vehicle = 'heli';
            s.vehicleUntil = s.frame + 300; // 5 seconds
            s.effects.push({ type: 'heli_spawn', x: 80 * SCALE, y: 70 * SCALE, ttl: 25 });
            break;
          }
          case 'O': { // Halberd
            s.effects.push({ type: 'halberd', x: (82 + 28) * SCALE, y: s.y + 18 * SCALE, ttl: 15 });
            const rangeMin = 75 * SCALE, rangeMax = 240 * SCALE;
            s.obstacles = s.obstacles.filter(o => !(o.x >= rangeMin && o.x <= rangeMax));
            break;
          }
          case 'P': { // Flying kick
            s.kickUntil = s.frame + 20;
            s.vy = Math.max(s.vy, 400);
            s.effects.push({ type: 'kick', x: (82 + 32) * SCALE, y: s.y + 18 * SCALE, ttl: 15 });
            const rangeMin = 75 * SCALE, rangeMax = 190 * SCALE;
            s.obstacles = s.obstacles.filter(o => !(o.x >= rangeMin && o.x <= rangeMax));
            break;
          }
          case 'A': { // Cigarette
            s.smokeCount++;
            s.effects.push({ type: 'smoke', x: (82 + 25) * SCALE, y: s.y + 30 * SCALE, ttl: 20 });
            const rangeMin = 75 * SCALE, rangeMax = 150 * SCALE;
            s.obstacles = s.obstacles.filter(o => !(o.x >= rangeMin && o.x <= rangeMax));
            if (s.smokeCount >= 11) {
              // Dies of lung cancer on final use
              s.running = false;
              s.crashAt = s.frame;
              return s;
            }
            break;
          }
          case 'S': { // Rifle
            s.projectiles.push({ type: 'rifle_bullet', x: (82 + 28) * SCALE, y: s.y + 24 * SCALE, vx: 3000, vy: 0, w: 16, h: 4, ttl: 40 });
            s.effects.push({ type: 'shot', x: (82 + 28) * SCALE, y: s.y + 24 * SCALE, ttl: 6 });
            break;
          }
          case 'D': { // Double-Edged Sword (50/50 self-behead)
            const r = course(seed, s.frame);
            if (r % 2 === 0) {
              // Self-behead!
              s.effects.push({ type: 'behead', x: 82 * SCALE, y: s.y + 35 * SCALE, ttl: 30 });
              s.running = false;
              s.crashAt = s.frame;
              return s;
            } else {
              // Slices enemy cleanly
              s.effects.push({ type: 'slice', x: (82 + 28) * SCALE, y: s.y + 15 * SCALE, ttl: 14 });
              const rangeMin = 75 * SCALE, rangeMax = 190 * SCALE;
              s.obstacles = s.obstacles.filter(o => !(o.x >= rangeMin && o.x <= rangeMax));
            }
            break;
          }
          case 'F': { // Pay respects
            s.respectUntil = s.frame + 35;
            s.effects.push({ type: 'respect', x: (82 + 20) * SCALE, y: s.y + 46 * SCALE, ttl: 35 });
            break;
          }
          case 'G': { // Holy Water
            s.projectiles.push({ type: 'holy_water', x: (82 + 26) * SCALE, y: s.y + 24 * SCALE, vx: 1200, vy: 350, grav: 25, w: 14, h: 18, ttl: 50 });
            break;
          }
          case 'H': { // Portal Gun
            s.projectiles.push({ type: 'portal_shot', x: (82 + 28) * SCALE, y: s.y + 24 * SCALE, vx: 2600, vy: 0, w: 18, h: 12, ttl: 45 });
            break;
          }
          case 'J': { // Grenade Launcher
            s.projectiles.push({ type: 'grenade', x: (82 + 28) * SCALE, y: s.y + 24 * SCALE, vx: 1300, vy: 400, grav: 24, w: 12, h: 12, ttl: 60 });
            break;
          }
          case 'K': { // Downers (slow speed)
            s.speedMod = 60;
            s.speedModUntil = s.frame + 240;
            s.effects.push({ type: 'status', text: 'SLOW', x: 82 * SCALE, y: s.y + 45 * SCALE, ttl: 30 });
            break;
          }
          case 'L': { // Uppers (boost speed)
            s.speedMod = 145;
            s.speedModUntil = s.frame + 240;
            s.effects.push({ type: 'status', text: 'FAST!', x: 82 * SCALE, y: s.y + 45 * SCALE, ttl: 30 });
            break;
          }
          case 'Z': { // Meteor (clears entire screen)
            s.effects.push({ type: 'meteor', x: 450 * SCALE, y: 0, ttl: 35 });
            s.obstacles = [];
            break;
          }
          case 'X': { // Laser Gun
            s.effects.push({ type: 'laser_beam', y: s.y + 24 * SCALE, ttl: 12 });
            const laserY = s.y;
            s.obstacles = s.obstacles.filter(o => Math.abs((o.y * SCALE) - laserY) > 28 * SCALE);
            break;
          }
          case 'C': { // Chemical Warfare (Plane drops gas)
            s.effects.push({ type: 'chemical_plane', x: 0, y: 190 * SCALE, ttl: 45 });
            // Clears upcoming obstacles ahead
            s.obstacles = s.obstacles.filter(o => o.x > 800 * SCALE);
            break;
          }
          case 'V': { // Home Run Bat
            s.batEquipped = true;
            s.effects.push({ type: 'bat_swing', x: (82 + 28) * SCALE, y: s.y + 15 * SCALE, ttl: 16 });
            const rangeMin = 75 * SCALE, rangeMax = 200 * SCALE;
            s.obstacles = s.obstacles.filter(o => !(o.x >= rangeMin && o.x <= rangeMax));
            break;
          }
          case 'B': { // Bow and Arrow
            s.projectiles.push({ type: 'arrow', x: (82 + 26) * SCALE, y: s.y + 24 * SCALE, vx: 2000, vy: 160, grav: 12, w: 22, h: 6, ttl: 50 });
            break;
          }
          case 'N': { // Tank
            s.vehicle = 'tank';
            s.vehicleUntil = s.frame + 300; // 5 seconds
            s.effects.push({ type: 'tank_spawn', x: 80 * SCALE, y: 0, ttl: 25 });
            break;
          }
          case 'M': { // Hammer
            s.effects.push({ type: 'hammer_smash', x: (82 + 28) * SCALE, y: s.y, ttl: 18 });
            const rangeMin = 75 * SCALE, rangeMax = 180 * SCALE;
            s.obstacles = s.obstacles.filter(o => !(o.x >= rangeMin && o.x <= rangeMax && o.y === 0));
            break;
          }
        }
      }
    }
  }

  s.frame++;
  if (!s.running) return s;
  s.age++;

  // Vehicle states
  if (s.vehicle && s.frame >= s.vehicleUntil) s.vehicle = null;
  if (s.speedMod !== 100 && s.frame >= s.speedModUntil) s.speedMod = 100;

  // Base speed modulated by downers/uppers
  const baseSpeed = Math.min(1200, 580 + Math.floor(s.age / 30));
  const speed = Math.floor(baseSpeed * s.speedMod / 100);

  // Jump physics
  if (s.vehicle === 'heli') {
    // Helicopter hovers at y = 50 and fires guns occasionally
    s.y = 50 * SCALE;
    s.vy = 0;
    if (s.frame % 12 === 0) {
      s.projectiles.push({ type: 'bullet', x: 120 * SCALE, y: 55 * SCALE, vx: 2400, vy: -120, w: 10, h: 4, ttl: 40 });
    }
  } else {
    s.vy -= 60;
    s.y = Math.max(0, s.y + s.vy);
    if (s.y === 0) s.vy = 0;
  }

  // --- 1. Spawn Obstacles & Enemies ---
  if (s.age >= s.nextObstacle) {
    const r = course(seed, s.obstacleNo++);
    const isBird = s.age > 1000 && r % 4 === 0;
    const isGolden = isBird && (r % 12 === 0); // Midas / Golden Pterodactyl!
    const flyY = isBird ? (r % 3 === 0 ? 15 : r % 3 === 1 ? 40 : 65) : 0;

    s.obstacles.push({
      id: s.obstacleNo,
      x: 940 * SCALE,
      w: isBird ? 44 : 18 + r % 3 * 9,
      h: isBird ? 24 : 34 + r % 3 * 8,
      y: flyY,
      bird: isBird,
      golden: isGolden
    });
    // Minimum spacing covers a complete jump at maximum speed.
    s.nextObstacle = s.age + 85 + r % 46;
  }

  // --- 2. Spawn Weapon Mystery Crates ---
  if (s.age >= s.nextCrate) {
    const r = course(seed, s.crateNo + 7777);
    const letter = ALL_WEAPON_KEYS[r % ALL_WEAPON_KEYS.length];
    s.crates.push({
      id: ++s.crateNo,
      x: 950 * SCALE,
      y: (r % 3 === 0 ? 10 : 35),
      w: 22,
      h: 22,
      letter
    });
    // Spawn a crate roughly every 160-260 frames (~3-4 seconds)
    s.nextCrate = s.age + 160 + (r % 100);
  }

  // Move obstacles
  for (const o of s.obstacles) o.x -= speed;
  s.obstacles = s.obstacles.filter(o => o.x + o.w * SCALE > 0);

  // Move crates
  for (const c of s.crates) c.x -= speed;
  s.crates = s.crates.filter(c => c.x + c.w * SCALE > 0);

  // --- 3. Update Projectiles & Collisions with Obstacles ---
  for (const p of s.projectiles) {
    p.x += Math.floor(p.vx * 100 / 60);
    p.y += Math.floor(p.vy * 100 / 60);
    if (p.grav) p.vy -= p.grav;
    p.ttl--;

    // Check collision with obstacles
    for (let i = s.obstacles.length - 1; i >= 0; i--) {
      const o = s.obstacles[i];
      const pLeft = p.x, pRight = p.x + p.w * SCALE;
      const pBottom = p.y, pTop = p.y + p.h * SCALE;
      const oLeft = o.x, oRight = o.x + o.w * SCALE;
      const oBottom = o.y * SCALE, oTop = (o.y + o.h) * SCALE;

      if (pRight > oLeft && pLeft < oRight && pTop > oBottom && pBottom < oTop) {
        // Hit! Destroy obstacle
        s.effects.push({
          type: o.golden ? 'golden_explosion' : 'hit',
          x: o.x + (o.w * SCALE / 2),
          y: o.y * SCALE + (o.h * SCALE / 2),
          ttl: 18
        });

        if (o.golden) {
          // Bonus distance for slaying golden pterodactyl
          s.distance += 25000;
        }

        s.obstacles.splice(i, 1);
        p.ttl = 0; // Destroy projectile
        break;
      }
    }
  }
  s.projectiles = s.projectiles.filter(p => p.ttl > 0 && p.x < 1100 * SCALE && p.y >= -10 * SCALE);

  // --- 4. Update Effects ---
  for (const ef of s.effects) ef.ttl--;
  s.effects = s.effects.filter(ef => ef.ttl > 0);

  // --- 5. Dino Crate Collection ---
  const playerH = s.vehicle === 'heli' ? 32 : (s.duck && s.y === 0 ? 20 : 43);
  const playerW = s.vehicle === 'tank' ? 52 : (s.duck && s.y === 0 ? 48 : 28);
  const left = 82 * SCALE, bottom = s.y + 3 * SCALE;
  const right = left + playerW * SCALE, top = bottom + (playerH - 3) * SCALE;

  for (let i = s.crates.length - 1; i >= 0; i--) {
    const c = s.crates[i];
    const cLeft = c.x, cRight = c.x + c.w * SCALE;
    const cBottom = c.y * SCALE, cTop = (c.y + c.h) * SCALE;

    if (right > cLeft && left < cRight && top > cBottom && bottom < cTop) {
      // Collected weapon crate!
      const arm = ARMORY[c.letter];
      s.inventory[c.letter] = arm.uses;
      s.activeWeapon = c.letter;
      s.effects.push({ type: 'pickup', letter: c.letter, x: c.x, y: c.y * SCALE, ttl: 25 });
      s.crates.splice(i, 1);
    }
  }

  // --- 6. Dino Hazard Collision ---
  // In a tank, dino crushes ground obstacles safely
  if (s.vehicle === 'tank') {
    for (let i = s.obstacles.length - 1; i >= 0; i--) {
      const o = s.obstacles[i];
      if (!o.bird && right > o.x && left < o.x + o.w * SCALE) {
        s.effects.push({ type: 'hit', x: o.x, y: 0, ttl: 14 });
        s.obstacles.splice(i, 1);
      }
    }
  }

  // Flying kick grants temporary invulnerability
  const isInvulnerable = s.kickUntil && s.frame < s.kickUntil;

  const hit = !isInvulnerable && s.obstacles.some(o =>
    left < o.x + (o.w - 2) * SCALE &&
    left + playerW * SCALE > o.x + 2 * SCALE &&
    bottom < (o.y + o.h - 2) * SCALE &&
    bottom + (playerH - 3) * SCALE > o.y * SCALE
  );

  if (hit) {
    s.running = false;
    s.crashAt = s.frame;
    return s;
  }

  s.distance += speed;
  const score = runScore(s);
  if (score > s.best) {
    s.best = score;
    s.bestAt = s.frame;
  }
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
