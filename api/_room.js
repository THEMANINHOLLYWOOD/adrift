// One shared world for everyone playing Adrift. Plain JSON over a WebSocket.
//
// The world is an endless sea. Positions travel as a 10x10 chunk (cx, cz, any integer) plus a local x, z. The platform sits at
// the origin and the shared camp island 10 units east; every player gets a home island of their own in a ring around them
// (`homes`, up to 64), and beyond that the procedural frontier, which every page generates the same way from a fixed seed.
//
// The room is the authority for what everyone must agree on:
//  - the day: a long calm (day, dusk, night) in which people gather, build and are supplied, then dawn, then the morning fight;
//  - the kraken: health scaled to the crew in the platform chunk, its slams, ink, rams, drags and attacks on the platform;
//  - things in the water: survivors and salvage near the platform, driftwood and junk washing up anywhere, MAST's supply crates,
//    and the labelled wreckage of anyone whose boat goes down, which washes up on the island;
//  - what has been built: everyone's blocks (each labelled with its builder) and the four camp structures on the island,
//    which earn bigger supply drops.
// Clients steer their own boats and walkers and judge hits on themselves; the room checks what they claim against simple limits.
//
// Persistence: the shared world goes through a small storage adapter (`store`). The default keeps it in this instance's memory,
// so it lasts as long as the instance does; switch `makeStore()` to a real store and the world survives restarts. Each player also
// keeps their own inventory and builds in localStorage and offers their builds back on hello, so a fresh room is rebuilt by
// whoever comes back. When nobody is online the day starts again from dawn; everything built and found stays.
import { WebSocketServer } from 'ws';

const MAX_PEERS = 40, NAME_MAX = 18, POS_MS = 80, SIM_MS = 200, MAX_BLOCKS = 6000, MAX_ITEMS = 160, MAX_HOMES = 64, MAX_DISC = 6000, FAR = 1e5;
const CENTRE_ISLE = { x: 10, z: 0 }, REEF_R = { x0: 5, x1: 14.6, z0: -14.6, z1: -5 }; // the shared camp island; the reef corner that opens with the signal tower
const homeH = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
export const COLORS = ['#ee8f7c', '#78bcb8', '#f1d074', '#a99be0', '#8fcdb9', '#f2a3c0', '#7fb2e5', '#f6c49b'];
export const MATS = ['wood', 'metal', 'rope', 'plastic', 'glass'];
const LIM = 4.55, RIG = { x: -1.2, z: -1.15 }, K0 = { x: 2.05, z: -2.35 }, ISLAND = [1, 0];
const DUR = { first: 45000, calm: 150000, warn: 10000, fight: 150000, retreat: 9000 };
// the camp: four sites on the island; what each costs and what it adds to MAST's drops
export const SITES = {
  signal: { name: 'signal tower', x: 0.4, z: -0.9, cost: { wood: 6, rope: 2 } },
  helipad: { name: 'helipad', x: -1.3, z: 0.5, cost: { wood: 4, metal: 4 } },
  beacon: { name: 'beacon', x: 1.6, z: 1.2, cost: { metal: 3, glass: 2, plastic: 1 } },
  storage: { name: 'storage', x: -0.2, z: 1.5, cost: { wood: 6, plastic: 2 } },
};
const WASH = [['wood', 'driftwood'], ['wood', 'a plank'], ['metal', 'a sheet of tin'], ['rope', 'a coil of rope'], ['plastic', 'a barrel'], ['glass', 'a bottle'], ['metal', 'a bent rail'], ['wood', 'a crate lid']];

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, NAME_MAX);
// ---------- names other people see: island names (and sailors' names) pass a small abuse filter ----------
// The lists are rot13 so the source does not spell them out. Text is lowercased, accents dropped and leetspeak undone; whole words are
// checked against the short list, and every word (and any run of one- or two-letter pieces, "f u c k") against the substring list,
// also with repeated letters squeezed. The page runs the same check for instant feedback; the room's answer is the one that counts.
const rot13 = (t) => t.replace(/[a-z]/g, (c) => String.fromCharCode((c.charCodeAt(0) - 97 + 13) % 26 + 97));
const ABUSE_S = rot13('avttre avttn avtte snttbg sntbg xvxr jrgonpx genaal ergneq ornare enturnq gbjryurnq wvtnobb cbepuzbaxrl puvax shpx phag fuvg ovgpu juber fyhg chffl encvfg anmv uvgyre cbea cravf intvan gjng jnax xvyylbhefrys qvyqb zbyrfg cnrqb fcnfgvp xlxr tlcb urvyuvgyre fvrturvy zbgures pbpxfhpx wvmm frzra abapr').split(' ');
const ABUSE_W = new Set(rot13('snt sntf pbba pbbaf fcvp fcvpf tbbx tbbxf qlxr qlxrf cnxv cnxvf xxx pbpx pbpxf qvpx qvpxf encr encrq encrf nany phz xlf ubzb wnc wncf avt avtf crqb crqbf gvgf frk nff nefr nffubyr jbt jbtf fvrt urvy').split(' '));
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't' };
const squeeze = (w) => w.replace(/(.)\1+/g, '$1'), squeeze2 = (w) => w.replace(/(.)\1{2,}/g, '$1$1');
export function abusive(text) {
  const low = [...String(text ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')].map((c) => LEET[c] || c).join('');
  const toks = low.split(/[^a-z]+/).filter(Boolean), runs = []; let run = '';
  for (const w of toks) { if (w.length <= 2) run += w; else { if (run.length > 2) runs.push(run); run = ''; } } if (run.length > 2) runs.push(run);
  if (toks.some((w) => ABUSE_W.has(w) || ABUSE_W.has(squeeze(w)))) return true;
  for (const w of [...toks, ...runs]) { const a = squeeze(w), b = squeeze2(w); for (const bad of ABUSE_S) if (w.includes(bad) || b.includes(bad) || (bad === squeeze(bad) && a.includes(bad))) return true; }
  return false;
}
export const ISLE_NAME_MAX = 22;
export function isleNameCheck(raw) { // { ok, name } or { ok: false, why }
  const s = String(raw ?? '').normalize('NFC').replace(/[\u0000-\u001f<>&"\\`{}[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 2) return { ok: false, why: 'too short' };
  if (s.length > ISLE_NAME_MAX) return { ok: false, why: `at most ${ISLE_NAME_MAX} letters` };
  if (!/^[\p{L}\p{N} '’.-]+$/u.test(s)) return { ok: false, why: 'letters, numbers, spaces and \' - . only' };
  if ((s.match(/\p{L}/gu) || []).length < 2) return { ok: false, why: 'it needs a few letters' };
  if (/https?|www|\.(com|net|org|io|gg)\b/i.test(s)) return { ok: false, why: 'no links' };
  if (abusive(s)) return { ok: false, why: 'not that name: others will see it' };
  return { ok: true, name: s };
}
const safeName = (s) => { const n = clean(s); return n && !abusive(n) ? n : ''; };
// ---------- treasure: the room decides what is out there and who gets it ----------
// Kinds: 'float' (a crate or a bottle in the water, or washed up), 'dig' (buried on a beach: dig it up), 'sunk' (a chest at an
// underwater ruin or wreck), 'x' (what a map fragment points at). The contents are rolled when it spawns and only told to whoever
// takes it; the first claim the room hears wins, so two people can never both open the same one.
export const GEAR = ['harpoon2', 'spear', 'flare', 'lantern', 'coat', 'longrope', 'frag', 'flares'];
const LOOT_MAX = 90, LOOT_NEAR = 3;
const LOOT_TABLE = { // [gear chance, gear pool, materials rolls, food]
  float: [0.32, ['frag', 'flares', 'longrope', 'lantern', 'spear'], 2, 0],
  dig: [0.9, ['harpoon2', 'spear', 'lantern', 'coat', 'longrope', 'frag', 'flare'], 2, 1],
  sunk: [1, ['flare', 'harpoon2', 'coat', 'frag', 'lantern', 'spear'], 3, 0],
  x: [1, ['harpoon2', 'flare', 'coat', 'lantern'], 3, 2],
};
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const int = (v, lo, hi) => { const n = num(v, lo, hi); return n == null ? null : Math.round(n); };
const r2 = (v) => Math.round(v * 100) / 100;
const rnd = (a) => (Math.random() - 0.5) * a;
const hyp = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const isHome = (cx, cz) => cx === 0 && cz === 0;
const W10 = (c, v) => c * 10 + v; // chunk + local -> world
const islandR = (a) => 3.2 * (1 + 0.12 * Math.sin(3 * a + 1) + 0.07 * Math.sin(5 * a + 2.3)); // the island's outline (the page draws the same; the shore is at about 0.93 of it)

// ---------- storage adapter ----------
// memoryStore keeps the world in this instance only; redisStore (below) keeps it across restarts and redeploys, and lets
// separate instances pick up each other's saves. makeStore() picks Redis when its variables are set, memory otherwise.
export function memoryStore() { let data = null; return { kind: 'memory', async load() { return data; }, async save(d) { data = d; } }; }
// Upstash Redis over its REST API (the Vercel Marketplace integration sets the variables). The secret never leaves the server.
// One key holds the world as JSON; writes are already throttled by the room (at most one every 15 s, only when something changed).
// If Redis cannot be reached the room keeps working from memory and tries again on the next save.
export function redisStore(url, token, key = 'adrift:world:v1') {
  const mem = memoryStore(); let ok = true;
  const call = async (cmd) => { const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('redis ' + r.status); const j = await r.json(); if (j.error) throw new Error(j.error); return j.result; };
  return {
    get kind() { return ok ? 'redis' : 'redis-unreachable'; },
    async load() { try { const v = await call(['GET', key]); ok = true; return v ? JSON.parse(v) : await mem.load(); } catch { ok = false; return mem.load(); } },
    async save(d) { await mem.save(d); try { await call(['SET', key, JSON.stringify(d)]); ok = true; } catch { ok = false; } },
  };
}
export function makeStore(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL, token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? redisStore(url.replace(/\/$/, ''), token) : memoryStore();
}

export function attach(server, { dev = process.env.ADRIFT_DEV === '1', store = makeStore() } = {}) {
  const wss = new WebSocketServer({ server, maxPayload: 8192 });
  const peers = new Map();
  let n = 0, speed = 1, itemN = 0, last = Date.now(), emptySince = 0, dirty = false;
  const C = { stage: 1, day: 1, phase: 'calm', dur: DUR.first, until: Date.now() + DUR.first, hp: 0, maxHp: 1, kx: K0.x, kz: K0.z, rig: 1, saved: 0, lost: 0, n: 0, round: { saved: 0, lost: 0 }, outcome: '', log: [], pilot: '', supplyAt: 0, supply: null };
  const S = { nextSlam: 0, nextInk: 0, nextRam: 0, nextDrag: 0, nextRig: 0, drag: null, arms: [], nextWash: Date.now() + 8000 };
  const items = new Map();   // id -> { id, cx, cz, x, z, k, m, n, lbl } ; k: p survivor, c salvage, d driftwood/junk, s supply crate, w wreckage
  const blocks = new Map();  // 'cx,cz,i,j,k' -> { t (material index), o (builder), s (shape: block, slab, ramp), r (quarter turns) }
  const sites = Object.fromEntries(Object.keys(SITES).map((id) => [id, { have: Object.fromEntries(MATS.map((m) => [m, 0])), done: false, by: [] }]));
  const homes = new Map();   // home id -> { id, pid, name, seed, x, z, born, seen, visits, bornDay, mem }
  // the colossal one: one health for all of it, lasting from night to night; arms up at the islands while it attacks
  const boss = { gen: 1, max: 1800, hp: 1800, dead: false, final: false, deaths: 0, crews: {}, respawnAt: 0, last: [] };
  const warms = new Map(); let armN = 0; const pendingSlams = [];
  const bossOut = () => ({ gen: boss.gen, hp: Math.round(boss.hp), max: Math.round(boss.max), dead: boss.dead, final: boss.final, last: boss.last });
  const chests = new Map();  // 'camp' or a home id -> { wood, metal, ... }
  const disc = new Map();    // 'rx,rz' (32-unit regions of the frontier) -> who sailed there first
  const loot = new Map();    // id -> { id, x, z (world), k: float|dig|sunk|x, tier, g: { gear or material: n }, at, slot }
  let lootN = 0, lootGap = 55000, lootScatterAt = 0;
  let homeN = 0;
  const emptyChest = () => Object.fromEntries(MATS.map((m) => [m, 0]));
  chests.set('camp', emptyChest());
  const homeOut = (h) => [h.id, h.name, h.seed, h.x, h.z, h.mem || 0, h.iname || '']; // (iname: the name its owner gave the island)
  // a free spot for a new home island: rings around the middle, a good sail from every neighbour, clear of the camp and the reef
  function freeSpot(pid) {
    const a0 = (homeH(pid) % 6283) / 1000;
    for (const r of [18, 30, 42, 54, 66, 76]) { const n = Math.floor(2 * Math.PI * r / 12);
      for (let i = 0; i < n; i++) { const a = a0 + i * 2 * Math.PI / n, x = Math.round(Math.cos(a) * r * 10) / 10, z = Math.round(Math.sin(a) * r * 10) / 10;
        if (hyp(x, z, 0, 0) < 12 || hyp(x, z, CENTRE_ISLE.x, CENTRE_ISLE.z) < 14) continue;
        if (x > REEF_R.x0 - 5 && x < REEF_R.x1 + 5 && z > REEF_R.z0 - 5 && z < REEF_R.z1 + 5) continue;
        if ([...homes.values()].some((h) => hyp(h.x, h.z, x, z) < 12)) continue;
        return [x, z]; } }
    return null;
  }
  function claimHome(pid, name, offer) { // returning: theirs; new: a free spot (or the one their page remembers, if still free)
    let h = [...homes.values()].find((q) => q.pid === pid);
    if (h) { h.name = name; h.seen = Date.now(); h.visits++; return { h, fresh: false }; }
    let spot = null, seed = (homeH(pid) ^ (++homeN * 2654435761)) >>> 0;
    if (offer && num(offer.x, -90, 90) != null && num(offer.z, -90, 90) != null && Number.isInteger(offer.seed) && ![...homes.values()].some((q) => hyp(q.x, q.z, offer.x, offer.z) < 11)) { spot = [offer.x, offer.z]; seed = offer.seed >>> 0; }
    if (!spot) spot = freeSpot(pid);
    if (!spot && homes.size >= MAX_HOMES) { // full: the oldest island whose owner never came back makes room
      const old = [...homes.values()].filter((q) => q.visits <= 1).sort((a, b) => a.born - b.born)[0];
      if (old) { homes.delete(old.id); chests.delete(old.id); all({ t: 'islgone', id: old.id }); spot = [old.x, old.z]; } }
    if (!spot) return { h: null, fresh: false };
    const nm = offer && typeof offer.iname === 'string' && offer.iname ? isleNameCheck(offer.iname) : null; // (a fresh room: the name your page remembers for it comes back too)
    h = { id: 'h' + (homeN).toString(36) + (homeH(pid) % 1296).toString(36), pid, name, seed, x: spot[0], z: spot[1], born: Date.now(), seen: Date.now(), visits: 1, bornDay: C.day, mem: 0, iname: nm && nm.ok ? nm.name : '' };
    homes.set(h.id, h); chests.set(h.id, emptyChest()); dirty = true; return { h, fresh: true };
  }
  const chestOut = () => Object.fromEntries([...chests.entries()]);
  const W10x = (p) => W10(p.s[8], (p.s[4] & 16) ? p.s[10] : p.s[0]), W10z = (p) => W10(p.s[9], (p.s[4] & 16) ? p.s[12] : p.s[1]);
  const chestAt = (id) => id === 'camp' ? CENTRE_ISLE : homes.get(id);
  function feedSites() { // the camp chest pays for the camp: whatever a site still needs comes straight out of it
    const ch = chests.get('camp'); let moved = false;
    for (const [id, site] of Object.entries(sites)) { if (site.done) continue; const cost = SITES[id].cost; let any = false;
      for (const mat of Object.keys(cost)) { const g = Math.min(ch[mat] || 0, cost[mat] - site.have[mat]); if (g > 0) { ch[mat] -= g; site.have[mat] += g; any = true; } }
      if (any) { moved = true; if (!site.by.includes('the camp chest')) site.by.push('the camp chest'); site.done = Object.keys(cost).every((mat) => site.have[mat] >= cost[mat]); all({ t: 'site', id, have: site.have, done: site.done, by: 'the camp chest' }); } }
    if (moved) { all({ t: 'chest', id: 'camp', c: ch }); pushC(); }
  }

  // ----- treasure -----
  const lootOut = (o) => [o.id, r2(o.x), r2(o.z), o.k, o.tier];
  function lootRoll(k) { const [gc, pool, rolls, food] = LOOT_TABLE[k] || LOOT_TABLE.float, g = {};
    for (let i = 0; i < rolls; i++) { const mat = MATS[(Math.random() * MATS.length) | 0]; g[mat] = (g[mat] || 0) + 1 + ((Math.random() * (k === 'float' ? 2 : 3)) | 0); }
    if (food) g.food = food + ((Math.random() * 2) | 0);
    if (Math.random() < gc) { const it = pool[(Math.random() * pool.length) | 0]; g[it] = (g[it] || 0) + 1; if (it === 'flare') g.flares = (g.flares || 0) + 3; if (it === 'frag' && k !== 'float') g.frag = 1; }
    return g; }
  function lootAdd(k, x, z, o = {}) {
    if (loot.size >= LOOT_MAX) { const old = [...loot.values()].filter((q) => q.k === 'float').sort((a, b) => a.at - b.at)[0] || [...loot.values()].sort((a, b) => a.at - b.at)[0]; if (old) { loot.delete(old.id); all({ t: 'lootgone', id: old.id }); } }
    const it = { id: 'L' + (++lootN).toString(36) + Math.random().toString(36).slice(2, 4), x: r2(x), z: r2(z), k, tier: k === 'x' ? 3 : k === 'sunk' ? 2 : k === 'dig' ? 2 : 1, g: o.g || lootRoll(k), at: Date.now(), slot: o.slot || '', for: o.for || '' };
    loot.set(it.id, it); dirty = true; all({ t: 'loot', a: [lootOut(it)] }); return it; }
  const lootNear = (x, z, r) => { let n = 0; for (const o of loot.values()) if (hyp(o.x, o.z, x, z) < r) n++; return n; };
  // near each sailor: a few things to find, placed where their page says there is a beach or a ruin (it can only point near itself),
  // or out in the water around them
  function lootFor(p, t, force) {
    const x = W10x(p), z = W10z(p); if (!force && (t < (p.lootNext || 0) || lootNear(x, z, 24) >= LOOT_NEAR)) return null;
    p.lootNext = t + lootGap * (0.75 + Math.random() * 0.5) / speed;
    const sp = p.spots && t - p.spots.t < 30000 ? p.spots : { b: [], u: [] }, r = Math.random(), want = force && force !== true ? force : '';
    const freeU = sp.u.filter(([ux, uz, slot]) => ![...loot.values()].some((o) => o.slot === slot) && hyp(ux, uz, x, z) > 1.5 && hyp(ux, uz, x, z) < 30); // (only near where they are now)
    const freeB = sp.b.filter(([bx, bz]) => lootNear(bx, bz, 2) === 0 && hyp(bx, bz, x, z) > 1.2 && hyp(bx, bz, x, z) < 30);
    if ((want === 'sunk' || (!want && r < 0.35)) && freeU.length) { const [ux, uz, slot] = freeU[(Math.random() * freeU.length) | 0]; return lootAdd('sunk', ux, uz, { slot, for: p.id }); }
    if ((want === 'dig' || (!want && r < 0.75)) && freeB.length) { const [bx, bz] = freeB[(Math.random() * freeB.length) | 0]; return lootAdd('dig', bx, bz, { for: p.id }); }
    if (want && want !== 'float') return null;
    const a = Math.random() * 6.28, d = 4 + Math.random() * 9; return lootAdd('float', x + Math.cos(a) * d, z + Math.sin(a) * d, { for: p.id }); }
  function lootTick(t) {
    for (const p of peers.values()) if (p.sea && !(p.s[4] & (64 | 128))) lootFor(p, t, false);
    // and some scattered around the middle of the world, for anyone
    if (t > lootScatterAt) { lootScatterAt = t + 180000 / speed; let n = 0; for (const o of loot.values()) if (o.k === 'float' && !o.for) n++;
      for (let i = n; i < 12; i++) { const a = Math.random() * 6.28, d = 14 + Math.random() * 64; lootAdd('float', Math.cos(a) * d, Math.sin(a) * d); } }
    for (const o of [...loot.values()]) if (t - o.at > (o.k === 'float' ? 2400000 : 7200000) / speed) { loot.delete(o.id); all({ t: 'lootgone', id: o.id }); }
  }
  const send = (ws, m) => { if (ws.readyState === 1) ws.send(typeof m === 'string' ? m : JSON.stringify(m)); };
  const all = (m, except) => { const s = JSON.stringify(m); for (const p of peers.values()) if (p !== except) send(p.ws, s); };
  const pub = (p) => ({ id: p.id, name: p.name, color: p.color, s: p.s, home: p.home || '', days: p.days || 0 }); // (days: the days they have lived through, scratched on their hull) // (home: where their first-day wreck lies, for anyone passing to help)
  const atHome = (p) => p.sea && p.s[8] === 0 && p.s[9] === 0;
  const crew = () => { let k = 0; const t = Date.now(); for (const p of peers.values()) if (atHome(p) && t - p.seen < 15000) k++; return Math.max(1, k); };
  const fighters = () => [...peers.values()].filter((p) => atHome(p) && !(p.s[4] & 2) && !(p.s[4] & 16));
  const builtN = () => Object.values(sites).filter((s) => s.done).length;
  const snap = () => ({ stage: C.stage, day: C.day, phase: C.phase, dur: C.dur, until: C.until, hp: Math.round(C.hp * 10) / 10, maxHp: Math.round(C.maxHp), kx: r2(C.kx), kz: r2(C.kz), rig: r2(C.rig), saved: C.saved, lost: C.lost, n: C.n,
    round: C.round, outcome: C.outcome, log: C.log.slice(-8), pilot: C.pilot, supply: C.supply, boss: bossOut(), hunt: HUNT.on ? HUNT.tid : '', final: boss.final, bossDead: boss.dead, sites: Object.fromEntries(Object.entries(sites).map(([k, s]) => [k, { have: s.have, done: s.done, by: s.by.slice(-4) }])), store: store.kind });
  const pushC = () => { all({ t: 'c', c: snap(), now: Date.now() }); dirty = true; };
  const itemOut = (o) => [o.id, o.cx, o.cz, o.x, o.z, o.k, o.m || '', o.n || 0, o.lbl || ''];
  const baseHp = () => 60 * (1 + 0.45 * (C.stage - 1));
  const scaleOf = (k) => 0.15 + 0.6 * k;
  const armsUp = () => Math.min(8, 1 + C.n + Math.floor(C.stage / 2));
  const slamGap = () => Math.max(900, 3300 / (0.6 + 0.4 * C.n) * Math.pow(0.93, C.stage - 1));
  const set = (phase, ms) => { C.phase = phase; C.dur = ms; C.until = Date.now() + ms / speed; };

  function addItem(o) {
    if (items.size >= MAX_ITEMS) { const old = [...items.values()].find((q) => q.k === 'd'); if (old) { items.delete(old.id); all({ t: 'gone', ids: [old.id], quiet: 1 }); } else return null; }
    const id = (++itemN).toString(36); const it = { id, cx: o.cx ?? 0, cz: o.cz ?? 0, x: r2(Math.max(-LIM, Math.min(LIM, o.x))), z: r2(Math.max(-LIM, Math.min(LIM, o.z))), k: o.k, m: o.m, n: o.n, lbl: o.lbl, at: Date.now() };
    items.set(id, it); dirty = true; return it;
  }
  const announce = (list) => { const add = list.filter(Boolean); if (add.length) all({ t: 'sv', add: add.map(itemOut) }); };
  function openWater() { for (let i = 0; i < 30; i++) { const x = rnd(8.6), z = rnd(8.6); if (hyp(x, z, RIG.x, RIG.z) > 2.3 && hyp(x, z, C.kx, C.kz) > 2) return [x, z]; } return [3, 3]; }
  // the island's beach: a ring of sand around its middle (the page has the same shape)
  function beach() { const a = Math.random() * 6.28, r = islandR(a) * (0.8 + Math.random() * 0.1); return [Math.cos(a) * r * 1.05, Math.sin(a) * r * 0.9]; }
  function spawnCalm() {
    const add = [], people = 2 + 2 * C.n, crates = 2 + C.n;
    for (let i = 0; i < people; i++) { const [x, z] = openWater(); add.push(addItem({ x, z, k: 'p' })); }
    for (let i = 0; i < crates; i++) { const [x, z] = openWater(); const m = MATS[(Math.random() * 2) | 0]; add.push(addItem({ x, z, k: 'c', m, n: 2, lbl: 'salvage' })); }
    announce(add);
  }
  function washUp() { // something new drifts in, somewhere in the world
    const cx = ((Math.random() * 3) | 0) - 1, cz = ((Math.random() * 3) | 0) - 1, [m, lbl] = WASH[(Math.random() * WASH.length) | 0];
    let x, z; if (cx === ISLAND[0] && cz === ISLAND[1]) [x, z] = beach(); else [x, z] = [rnd(8.4), rnd(8.4)];
    if (isHome(cx, cz) && hyp(x, z, RIG.x, RIG.z) < 2) return;
    announce([addItem({ cx, cz, x, z, k: 'd', m, n: 1 + ((Math.random() * 2) | 0), lbl })]);
  }
  function supplyDrop() { // MAST flies crates to the island: more for every camp structure, onto the helipad once there is one
    const k = builtN(), crates = 1 + k + (sites.storage.done ? 1 : 0), pad = sites.helipad.done, add = [];
    for (let i = 0; i < crates; i++) {
      const [x, z] = pad ? [SITES.helipad.x + rnd(0.7), SITES.helipad.z + rnd(0.7)] : (() => { const a = 3.3 + rnd(0.3), b = -0.3 + rnd(1.6); return [-a, b]; })();
      add.push(addItem({ cx: ISLAND[0], cz: ISLAND[1], x, z, k: 's', m: 'food', n: 2 + (sites.storage.done ? 1 : 0), lbl: "MAST's drop" }));
    }
    C.supply = { at: Date.now(), n: crates, pad }; announce(add); pushC();
  }
  // ---------- the hunter: at night the colossal one knows where everyone is, and comes for whoever is out in open water ----------
  // The room picks the prey (nobody can lie their way into being hunted; a page only says when it is sheltered: on land, at a dock,
  // in the lee of an island), moves the body faster than any boat, and strikes with telegraphed slams aimed where you will be:
  // one leading slam, a pair (where you are, then where you dodge to), or a sweep of three across your course. Each strike shows its
  // ring first ('aslam' with the landing time), so a quick turn takes you out of it. Its striking arm is a real arm: harpoon it
  // and the whole of it bleeds (the boss's health); cut it off and it recoils for a few seconds. Land and docks are safe.
  // Off in a dev room unless a test turns it on ({ t: 'dev', hunt: 1 }), so the other suites' fights are not interrupted.
  const HUNT = { enabled: !dev, on: false, x: 0, z: 0, tid: '', since: 0, next: 0, arm: '', stun: 0, sentAt: 0, gap: 0, log: [] };
  const isNight = (t) => C.phase === 'warn' || C.phase === 'fight' || (C.phase === 'calm' && 1 - (C.until - t) * speed / Math.max(1, C.dur) > 0.72);
  function preyOK(p) { const f = p.s[4], f2 = p.s[13] || 0;
    if (!p.sea || (f & (4 | 64 | 128)) || (f2 & (4 | 8))) return false; // (flying, on the first day, dead, sheltered: no; swamped: yes)
    if ((f & 16) && !(f2 & 1)) return false; if (atHome(p)) return false; // (on foot on land; the platform has its own fight)
    const x = W10x(p), z = W10z(p); if (hyp(x, z, CENTRE_ISLE.x, CENTRE_ISLE.z) < 6.2) return false; for (const h of homes.values()) if (hyp(x, z, h.x, h.z) < 5.2) return false;
    return true; }
  function huntOff() { if (!HUNT.on) return; HUNT.on = false; HUNT.tid = ''; if (HUNT.arm && warms.has(HUNT.arm)) { warms.delete(HUNT.arm); all({ t: 'arms', a: armsOut() }); } HUNT.arm = ''; all({ t: 'hunt', on: 0 }); }
  function huntTick(t, dt) {
    if (!HUNT.enabled || boss.dead || !isNight(t)) { huntOff(); return; }
    const prey = [...peers.values()].filter(preyOK);
    let cur = peers.get(HUNT.tid); if (cur && !prey.includes(cur)) cur = null;
    if (!prey.length) { if (HUNT.on && t - HUNT.sentAt > 1000) { HUNT.sentAt = t; HUNT.tid = ''; all({ t: 'hunt', on: 1, x: r2(HUNT.x), z: r2(HUNT.z), id: '' }); } return; } // (nobody out there: it waits)
    if (!HUNT.on) { HUNT.on = true; const p = prey[0], a = Math.random() * 6.28; HUNT.x = W10x(p) + Math.cos(a) * 14; HUNT.z = W10z(p) + Math.sin(a) * 14; HUNT.next = t + 2500 / speed; HUNT.tid = ''; }
    const near = (p) => hyp(W10x(p), W10z(p), HUNT.x, HUNT.z);
    if (!cur || (t - HUNT.since > 12000 && prey.some((p) => near(p) < near(cur) - 6))) { cur = prey.sort((a, b) => near(a) - near(b))[0]; HUNT.tid = cur.id; HUNT.since = t; HUNT.next = Math.max(HUNT.next, t + 1600 / speed); }
    const px = W10x(cur), pz = W10z(cur), d = hyp(px, pz, HUNT.x, HUNT.z);
    // the body: straight for where they will be, faster than any boat; it holds off a little to strike from beside
    { const lead = Math.min(1.4, d / 4), gx = px + (cur.vx || 0) * lead, gz = pz + (cur.vz || 0) * lead, gd = hyp(gx, gz, HUNT.x, HUNT.z), sp = (t < HUNT.stun ? 0.7 : 3.2 + 0.15 * (boss.gen - 1)) * speed * dt / 1000;
      if (gd > 1.7) { const k = Math.min(sp, gd - 1.7) / gd; HUNT.x += (gx - HUNT.x) * k; HUNT.z += (gz - HUNT.z) * k; } }
    if (d < 3.4 && t > HUNT.next && t > HUNT.stun) huntStrike(cur, t);
    if (t - HUNT.sentAt > 400) { HUNT.sentAt = t; all({ t: 'hunt', on: 1, x: r2(HUNT.x), z: r2(HUNT.z), id: cur.id }); }
  }
  function huntStrike(p, t) {
    const px = W10x(p), pz = W10z(p), vx = p.vx || 0, vz = p.vz || 0, sp = Math.hypot(vx, vz), tele = Math.max(850, 1250 - 60 * (boss.gen - 1)) / speed;
    let a = HUNT.arm && warms.get(HUNT.arm);
    const dx = px - HUNT.x, dz = pz - HUNT.z, dl = Math.hypot(dx, dz) || 1, ax = r2(px - dx / dl * 1.5), az = r2(pz - dz / dl * 1.5);
    if (!a) { const hp = Math.round(24 * (1 + 0.35 * (boss.gen - 1))); a = { id: 'h' + (++armN).toString(36), x: ax, z: az, tx: px, tz: pz, at: 'hunt', hp, max: hp, next: Infinity, burn: 0, hunt: true }; warms.set(a.id, a); HUNT.arm = a.id; all({ t: 'arms', a: armsOut() }); }
    else { a.x = ax; a.z = az; all({ t: 'amove', id: a.id, x: ax, z: az }); }
    const lead = (k) => [r2(px + vx * k), r2(pz + vz * k)], hx = sp > 0.1 ? vx / sp : dx / dl, hz = sp > 0.1 ? vz / sp : dz / dl, side = Math.random() < 0.5 ? 1 : -1;
    const r = Math.random(), kind = sp < 0.15 ? (r < 0.6 ? 'slam' : 'pair') : r < 0.5 ? 'slam' : r < 0.75 ? 'pair' : 'sweep', out = [];
    if (kind === 'slam') out.push([...lead(tele / 1000 * 0.9), t + tele]);
    else if (kind === 'pair') { out.push([r2(px), r2(pz), t + tele]); const [qx, qz] = lead((tele + 450 / speed) / 1000 * 0.8); out.push([r2(qx - hz * 0.9 * side), r2(qz + hx * 0.9 * side), t + tele + 450 / speed]); } // (where you are, then where you swerve to)
    else { const [cx, cz] = lead(tele / 1000 * 0.9); for (let i = -1; i <= 1; i++) out.push([r2(cx - hz * 0.95 * i), r2(cz + hx * 0.95 * i), t + tele + (i + 1) * 140 / speed]); } // (a line across your course)
    for (const [x, z, at] of out) { all({ t: 'aslam', id: a.id, x, z, at, hunt: p.id }); pendingSlams.push({ x, z, at, a }); }
    HUNT.next = t + (HUNT.gap || (tele + 1500 + Math.random() * 1300)) / speed; HUNT.log.push([kind, t, p.id]); if (HUNT.log.length > 20) HUNT.log.shift();
  }
  function startFight() {
    set('fight', DUR.fight); if (!boss.dead) spawnArms(); C.n = crew(); C.maxHp = baseHp() * scaleOf(C.n); C.hp = C.maxHp; C.round = { saved: 0, lost: 0 }; C.outcome = '';
    const t = Date.now(); S.nextSlam = t + 2600 / speed; S.nextInk = t + 9000 / speed; S.nextRam = t + 14000 / speed; S.nextDrag = t + 12000 / speed; S.nextRig = t + 9000 / speed; S.drag = null;
    S.arms = Array.from({ length: 10 }, () => ({ busy: 0, stun: 0 }));
    { const P = [K0, { x: 2.5, z: 2.4 }, { x: -3.0, z: 2.5 }, { x: 0.9, z: 3.1 }][(C.stage - 1) % 4]; C.kx = r2(P.x + rnd(0.6)); C.kz = r2(P.z + rnd(0.6)); } // it surfaces somewhere new each time
    pushC();
  }
  function endFight(won) {
    C.outcome = won ? 'driven' : 'left';
    if (!won) C.rig = Math.max(0, C.rig - 0.1);
    C.log.push([C.stage, C.outcome, C.round.saved, C.round.lost, r2(C.rig)]); if (C.log.length > 30) C.log.shift();
    if (S.drag) { all({ t: 'ev', e: 'freed', id: S.drag.id }); S.drag = null; }
    clearArms(); if (won && boss.final) bossDie();
    C.pilot = ''; set('retreat', DUR.retreat); pushC();
  }
  function newDay(fresh) { C.day++; set('calm', fresh ? DUR.first : DUR.calm); C.supplyAt = Date.now() + (fresh ? 20000 : 45000) / speed; C.supply = null; spawnCalm(); pushC(); }
  function rescale() {
    const k = crew(); if (k === C.n) return;
    const dir = k > C.n ? 1 : -1; C.n = k;
    if (C.phase === 'fight') { const f = C.hp / C.maxHp; C.maxHp = baseHp() * scaleOf(k); C.hp = Math.max(1, C.maxHp * f); }
    if (C.phase === 'calm' && dir > 0) announce([addItem({ ...(([x, z]) => ({ x, z }))(openWater()), k: 'p' }), addItem({ ...(([x, z]) => ({ x, z }))(openWater()), k: 'p' })]);
    all({ t: 'scale', n: k, dir, arms: armsUp() }); pushC();
  }
  const armsOut = () => [...warms.values()].map((a) => [a.id, a.x, a.z, Math.round(a.hp), Math.round(a.max)]);
  const toChunk = (x, z) => { const cx = Math.round(x / 10), cz = Math.round(z / 10); return { cx, cz, x: x - cx * 10, z: z - cz * 10 }; };
  function spawnArms() { // one up at each home island with someone aboard, the camp, anyone far out; fewer for a lone sailor
    warms.clear(); const T = [{ x: CENTRE_ISLE.x, z: CENTRE_ISLE.z, at: 'camp' }], seen = new Set();
    for (const p of peers.values()) { if (!p.sea) continue; const h = p.home && homes.get(p.home); if (h && !seen.has(h.id)) { seen.add(h.id); T.push({ x: h.x, z: h.z, at: h.id }); }
      const px = W10x(p), pz = W10z(p); if (!T.some((q) => hyp(q.x, q.z, px, pz) < 20)) T.push({ x: px, z: pz, at: 'far' }); }
    const n = peers.size, hp = 30 * (1 + 0.35 * (boss.gen - 1)) * (0.8 + 0.2 * Math.min(6, n)), extra = n >= 3 ? 1 + Math.floor((boss.gen - 1) / 2) : 0;
    for (let i = 0; i < T.length + extra && warms.size < 12; i++) { const q = T[i % T.length], toMid = Math.atan2(-q.z, -q.x) + rnd(1.4) + (i >= T.length ? Math.PI : 0), r = q.at === 'far' ? 2.2 : 4.2;
      const a = { id: 'a' + (++armN).toString(36), x: r2(q.x + Math.cos(toMid) * r), z: r2(q.z + Math.sin(toMid) * r), tx: q.x, tz: q.z, at: q.at, hp, max: hp, next: Date.now() + (2500 + Math.random() * 3000) / speed, burn: 0 };
      warms.set(a.id, a); }
    all({ t: 'arms', a: armsOut() });
  }
  function clearArms() { if (!warms.size) return; warms.clear(); pendingSlams.length = 0; all({ t: 'arms', a: [] }); }
  function blocksNear(x, z, r, test) { const out = []; for (const [k, b] of blocks) { const [cx, cz, i, j, kk] = k.split(',').map(Number); const bx = cx * 10 + i * 0.12, bz = cz * 10 + kk * 0.12; if (hyp(bx, bz, x, z) < r && (!test || test(b, j))) out.push([k, b, j, bx, bz]); } return out; }
  function severArm(a, by) { warms.delete(a.id); const add = []; if (a.hunt) { HUNT.arm = ''; HUNT.stun = Date.now() + 6000 / speed; } // (cut off the one hunting you: it recoils, then comes again)
    for (let i = 0; i < 3; i++) { const c = toChunk(a.x + rnd(1.2), a.z + rnd(1.2)); add.push(addItem({ ...c, k: 'k', m: 'food', n: 3, lbl: 'a chunk of it' })); }
    announce(add); all({ t: 'asev', id: a.id, by }); }
  function hurtBoss(d, by) { if (boss.dead) return; boss.hp = Math.max(0, boss.hp - d); boss.crews[by] = (boss.crews[by] || 0) + d; dirty = true;
    if (boss.hp <= 0 && !boss.final) { boss.final = true; all({ t: 'boss', boss: bossOut() }); // it rises at the middle for the last fight
      if (C.phase !== 'fight') startFight(); C.maxHp = Math.max(C.maxHp, 140 * boss.gen * scaleOf(Math.max(1, C.n))); C.hp = C.maxHp; pushC(); } }
  function bossDie() { boss.dead = true; boss.final = false; boss.deaths++; boss.last = Object.entries(boss.crews).sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]); boss.crews = {};
    boss.respawnAt = Date.now() + 360000 / speed; clearArms(); all({ t: 'bossdead', by: boss.last, boss: bossOut() }); dirty = true; }
  function armsTick(t) {
    for (const a of warms.values()) {
      // defences built near it: metal towers (four bricks high) wear it down, glass lights hold it off
      if (t - (a.scanAt || 0) > 1000) { a.scanAt = t; const near = blocksNear(a.x, a.z, 2.6); const cols = new Set(near.filter(([, b, j]) => b.t === 1 && j >= 3).map(([k]) => k.split(',').slice(0, 3).join(',') + ',' + k.split(',')[4]));
        a.towers = cols.size; a.lights = near.filter(([, b]) => b.t === 4).length; if (a.towers) { a.hp -= a.towers * 1.2; hurtBoss(a.towers * 1.2, 'the towers'); all({ t: 'ahp', id: a.id, hp: Math.round(a.hp), boss: bossOut() }); if (a.hp <= 0) { severArm(a, 'the towers'); continue; } } }
      if (a.hunt || t < a.next) continue; a.next = t + (Math.max(2200, 5200 - 500 * boss.gen) * (a.lights >= 3 ? 2 : 1) * (0.8 + Math.random() * 0.4)) / speed;
      const dx = a.tx - a.x, dz = a.tz - a.z, l = Math.hypot(dx, dz) || 1, k = 1.2 + Math.random() * 1.6, x = r2(a.x + dx / l * k + rnd(0.9)), z = r2(a.z + dz / l * k + rnd(0.9)), at = t + 1000 / speed;
      all({ t: 'aslam', id: a.id, x, z, at }); pendingSlams.push({ x, z, at, a });
    }
    for (let i = pendingSlams.length - 1; i >= 0; i--) { const q = pendingSlams[i]; if (t < q.at) continue; pendingSlams.splice(i, 1);
      // what it lands on breaks: bricks first (a wall takes the blow), then a chest close by spills
      const hit = blocksNear(q.x, q.z, 0.55).sort((p, r) => hyp(p[3], p[4], q.x, q.z) - hyp(r[3], r[4], q.x, q.z)).slice(0, 4);
      if (hit.length) { for (const [k] of hit) blocks.delete(k); all({ t: 'blk', r: hit.map((h) => h[0]), by: 'it' }); dirty = true; continue; }
      for (const [id, ch] of chests) { const at = chestAt(id); if (!at || hyp(at.x, at.z, q.x, q.z) > 3.4) continue; const add = [];
        for (const mat of MATS) { const g = Math.floor((ch[mat] || 0) * 0.15); if (g > 0 && add.length < 3) { ch[mat] -= g; const c = toChunk(q.x + rnd(1), q.z + rnd(1)); add.push(addItem({ ...c, k: 'w', m: mat, n: g, lbl: id === 'camp' ? 'from the camp chest' : `from ${homes.get(id) ? homes.get(id).name : 'a'}'s chest` })); } }
        if (add.length) { announce(add); all({ t: 'chest', id, c: ch }); dirty = true; } break; }
    }
  }
  function fightTick(t) {
    armsTick(t);
    const boats = fighters(), A = armsUp();
    if (t > S.nextSlam && boats.length) {
      S.nextSlam = t + slamGap() / speed * (0.85 + Math.random() * 0.3);
      const b = boats[(Math.random() * boats.length) | 0], s = b.s;
      const a = (() => { for (let k = 0; k < 12; k++) { const i = (Math.random() * A) | 0; if (S.arms[i].busy < t && S.arms[i].stun < t && (!S.drag || S.drag.a !== i)) return i; } return -1; })();
      if (a >= 0) { const x = Math.max(-LIM, Math.min(LIM, s[0] + Math.sin(s[2]) * s[3] * 1.1)), z = Math.max(-LIM, Math.min(LIM, s[1] + Math.cos(s[2]) * s[3] * 1.1)); S.arms[a].busy = t + 2300 / speed; all({ t: 'ev', e: 'slam', a, x: r2(x), z: r2(z) }); }
    }
    if ((C.stage >= 2 || C.n >= 3) && t > S.nextInk && boats.length) { S.nextInk = t + (17000 + Math.random() * 6000) / speed; const b = boats[(Math.random() * boats.length) | 0]; all({ t: 'ev', e: 'ink', x: r2(b.s[0] + rnd(1.4)), z: r2(b.s[1] + rnd(1.4)) }); }
    if ((C.stage >= 3 || C.n >= 4) && t > S.nextRam) {
      S.nextRam = t + (22000 + Math.random() * 8000) / speed;
      let x = 0, z = 0; for (let i = 0; i < 20; i++) { x = rnd(6.4); z = rnd(6.4); if (hyp(x, z, RIG.x, RIG.z) > 2.6 && hyp(x, z, C.kx, C.kz) > 2.5) break; }
      all({ t: 'ev', e: 'ram', fx: C.kx, fz: C.kz, x: r2(x), z: r2(z) }); C.kx = r2(x); C.kz = r2(z); pushC();
    }
    if (C.stage >= 4 && !S.drag && t > S.nextDrag && boats.length) {
      S.nextDrag = t + (20000 + Math.random() * 8000) / speed;
      const b = boats[(Math.random() * boats.length) | 0], a = (Math.random() * A) | 0;
      S.drag = { id: b.id, a, until: t + 5500 / speed, hits: 0 }; S.arms[a].busy = t + 6000 / speed; all({ t: 'ev', e: 'drag', id: b.id, a });
    }
    if (S.drag && t > S.drag.until) S.drag = null;
    if (C.stage >= 2 && t > S.nextRig && C.rig > 0.05) {
      S.nextRig = t + (25000 + Math.random() * 7000) / speed;
      C.rig = Math.max(0, C.rig - 0.04); all({ t: 'ev', e: 'rig', v: C.rig }); announce([addItem({ x: RIG.x + rnd(2.6), z: RIG.z + 1.6 + rnd(1), k: 'p' })]); pushC();
    }
  }
  const sim = setInterval(() => {
    const t = Date.now(), dt = t - last; last = t;
    if (!peers.size) { // nobody online: after a while the day starts again from dawn; what was built and found stays
      if (!emptySince) emptySince = t;
      if (t - emptySince > 30000 && !(C.phase === 'calm' && C.until - t > DUR.first * 0.9)) { C.pilot = ''; S.drag = null; C.day = Math.max(0, C.day - 1); newDay(true); }
      C.until += dt; for (const o of items.values()) o.at += dt; return;
    }
    emptySince = 0;
    rescale();
    const gone = []; for (const o of items.values()) if (o.k === 'p' && t - o.at > 180000 / speed) { items.delete(o.id); gone.push(o.id); C.lost++; C.round.lost++; }
    if (gone.length) { all({ t: 'gone', ids: gone }); pushC(); }
    if (t > S.nextWash) { S.nextWash = t + (9000 + Math.random() * 9000) / speed; washUp(); }
    if (t - (S.fedAt || 0) > 1000) { S.fedAt = t; feedSites(); }
    if (boss.dead && t > boss.respawnAt) { boss.gen++; boss.max = Math.round(1800 * Math.pow(1.45, boss.gen - 1)); boss.hp = boss.max; boss.dead = false; all({ t: 'bossback', boss: bossOut() }); pushC(); } // stronger, with more arms
    if (C.phase === 'calm' && C.supplyAt && t > C.supplyAt) { C.supplyAt = sites.beacon.done ? t + (C.until - t) * 0.6 : 0; supplyDrop(); }
    huntTick(t, dt); if (t - (S.lootAt || 0) > 2000) { S.lootAt = t; lootTick(t); }
    if (C.phase === 'fight') { fightTick(t); if (t > C.until) endFight(false); }
    else if (t > C.until) {
      if (C.phase === 'calm') { if (boss.dead) newDay(false); else { set('warn', DUR.warn); pushC(); } } // while it lies dead the nights are quiet
      else if (C.phase === 'warn') startFight();
      else if (C.phase === 'retreat') { C.stage++; newDay(false); }
    }
  }, SIM_MS);
  const pos = setInterval(() => {
    const moved = []; for (const p of peers.values()) if (p.dirty) { p.dirty = false; moved.push([p.id, ...p.s]); }
    if (moved.length) all({ t: 's', s: moved, now: Date.now() });
    const t = Date.now(); for (const p of peers.values()) if (t - p.seen > 25000) { try { p.ws.terminate(); } catch { /* gone */ } } // connections that went quiet
  }, POS_MS);
  const hpT = setInterval(() => { let d = false; for (const p of peers.values()) if (p.hpDirty) { p.hpDirty = false; d = true; } if (d) all({ t: 'hp', hp: Math.round(C.hp * 10) / 10, maxHp: Math.round(C.maxHp) }); }, 200);
  let savedAt = 0; // when this instance last wrote (or read) the stored world
  const saveNow = () => { if (!dirty) return; dirty = false; const w = worldOut(); savedAt = w.t; store.save(w).catch(() => {}); };
  const saveT = setInterval(saveNow, 15000);
  for (const iv of [sim, pos, hpT, saveT]) iv.unref?.();
  // the world as one object, for the store
  function worldOut() { return { v: 1, t: Date.now(), homes: [...homes.values()], chests: chestOut(), disc: [...disc.entries()], homeN, boss: { gen: boss.gen, max: boss.max, hp: boss.hp, dead: boss.dead, deaths: boss.deaths, respawnAt: boss.respawnAt, last: boss.last }, C: { stage: C.stage, day: C.day, rig: C.rig, saved: C.saved, lost: C.lost, log: C.log }, sites, blocks: [...blocks.entries()].map(([k, b]) => [k, b.t, b.o, b.s || 0, b.r || 0]), items: [...items.values()].filter((o) => o.k !== 'p').map((o) => [o.cx, o.cz, o.x, o.z, o.k, o.m, o.n, o.lbl]), loot: [...loot.values()].map((o) => [o.x, o.z, o.k, o.g, o.slot || '']) }; }
  function worldIn(w, replace) {
    if (!w || w.v !== 1) return false;
    if (replace) { blocks.clear(); items.clear(); } savedAt = w.t || Date.now();
    Object.assign(C, { stage: w.C.stage || 1, day: w.C.day || 1, rig: w.C.rig ?? 1, saved: w.C.saved || 0, lost: w.C.lost || 0, log: w.C.log || [] });
    for (const id of Object.keys(sites)) if (w.sites && w.sites[id]) sites[id] = w.sites[id];
    for (const [k, t, o, sh, ro, c] of w.blocks || []) blocks.set(k, { t, o, s: sh || 0, r: ro || 0, c: c ?? -1 });
    for (const [cx, cz, x, z, k, m, nn, lbl] of w.items || []) addItem({ cx, cz, x, z, k, m, n: nn, lbl });
    if (replace) { homes.clear(); disc.clear(); }
    for (const h of w.homes || []) if (h && h.id) homes.set(h.id, h);
    for (const [id, c] of Object.entries(w.chests || {})) chests.set(id, Object.assign(emptyChest(), c));
    for (const [k, v] of w.disc || []) disc.set(k, v);
    if (replace) loot.clear(); for (const [x, z, k, g, slot] of w.loot || []) if (LOOT_TABLE[k] && g && typeof g === 'object') { const it = { id: 'L' + (++lootN).toString(36) + Math.random().toString(36).slice(2, 4), x, z, k, tier: k === 'x' ? 3 : k === 'float' ? 1 : 2, g, at: Date.now(), slot: slot || '', for: '' }; loot.set(it.id, it); }
    homeN = Math.max(homeN, w.homeN || 0); if (w.boss) Object.assign(boss, w.boss, { final: false, crews: {} });
    dirty = false; return true;
  }
  // the first sailor into an empty room: another instance (or the last deploy) may have saved since; take the newer world (what
  // this instance changed while people were here was saved when the last one left, so only unattended drift is dropped)
  let ready = Promise.resolve();
  const refresh = () => store.load().then((w) => { if (w && w.v === 1 && (w.t || 0) > savedAt && !peers.size) worldIn(w, true); }).catch(() => {});
  ready = store.load().then((w) => { worldIn(w); }).catch(() => {}).finally(() => { if (!items.size) spawnCalm(); C.supplyAt = Date.now() + 20000; });

  wss.on('connection', (ws) => {
    if (peers.size >= MAX_PEERS) { ws.close(1013, 'full'); return; }
    if (!peers.size && store.kind !== 'memory') ready = ready.then(refresh);
    const gate = ready;
    let me = null, budget = 50, refill = Date.now();
    const ok = () => { const t = Date.now(); budget = Math.min(50, budget + (t - refill) * 0.05); refill = t; return budget-- > 0; };
    ws.on('message', (data) => gate.then(() => onMsg(data)));
    const onMsg = (data) => {
      if (!ok()) return;
      let m; try { m = JSON.parse(data); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      const t = Date.now();
      if (me) me.seen = t;
      if (m.t === 'ping') { send(ws, { t: 'pong', c: m.c, now: t }); return; }
      if (m.t === 'hello' && !me) {
        const id = (++n).toString(36) + Math.random().toString(36).slice(2, 5);
        me = { ws, id, name: safeName(m.name) || 'Boat', color: COLORS.includes(m.color) ? m.color : COLORS[(n * 3) % COLORS.length], s: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], sea: false, seen: t, dirty: false, carry: { p: 0, c: 0 }, dmg: 0, dmgT: t, placed: 0, placedT: t, days: int(m.days, 0, 9999) || 0 };
        const st = num(m.stage, 1, 999); if (st && st > C.stage && C.phase === 'calm') { C.stage = st | 0; const rg = num(m.rig, 0, 1); if (rg != null && C.log.length === 0) C.rig = rg; }
        // a returning player offers back the blocks they built; any the world has lost (a fresh room) go back where they were
        if (Array.isArray(m.builds)) { let k = 0; for (const b of m.builds.slice(0, 800)) { if (!Array.isArray(b)) continue; const [cx, cz, i, j, kk, ty, sh, ro, c0] = b.map((v) => int(v, -FAR, FAR)); if ([cx, cz, i, j, kk, ty].some((v) => v == null) || Math.abs(i) > 45 || Math.abs(kk) > 45 || ty < 0 || ty >= MATS.length) continue; const key = `${cx},${cz},${i},${j},${kk}`; if (!blocks.has(key) && blocks.size < MAX_BLOCKS) { blocks.set(key, { t: ty, o: me.name, s: Math.min(2, Math.max(0, sh || 0)), r: Math.min(3, Math.max(0, ro || 0)), c: c0 == null ? -1 : Math.min(7, Math.max(-1, c0)) }); k++; } } if (k) dirty = true; }
        const pid = typeof m.pid === 'string' && /^[a-z0-9]{6,24}$/.test(m.pid) ? m.pid : null; let home = null;
        if (pid) { const r = claimHome(pid, me.name, m.home); home = r.h; if (home && r.fresh) all({ t: 'isl', a: [homeOut(home)] }); else if (home) all({ t: 'isl', a: [homeOut(home)] }); }
        me.pid = pid; me.home = home ? home.id : '';
        peers.set(id, me);
        send(ws, { t: 'welcome', you: id, color: me.color, now: t, peers: [...peers.values()].filter((p) => p !== me).map(pub), c: snap(), sv: [...items.values()].map(itemOut), blocks: [...blocks.entries()].map(([k, b]) => [k, b.t, b.o, b.s || 0, b.r || 0, b.c ?? -1]), arms: armsOut(),
          isl: [...homes.values()].map(homeOut), home: me.home, chests: chestOut(), disc: [...disc.entries()].slice(-MAX_DISC), loot: [...loot.values()].map(lootOut) });
        all({ t: 'join', p: pub(me) }, me);
        return;
      }
      if (!me) return;
      if (m.t === 's' && Array.isArray(m.s)) { // x, z, heading, speed, flags (1 at sea, 2 down, 4 flying, 8 towing, 16 on foot), heli x y z, chunk cx cz, walker x y z
        const v = m.s, x = num(v[0], -6, 6), z = num(v[1], -6, 6), h = num(v[2], -50, 50), sp = num(v[3], -3, 3), f = num(v[4], 0, 255);
        if (x == null || z == null || h == null || sp == null || f == null) return;
        const cx = int(v[8], -FAR, FAR) ?? 0, cz = int(v[9], -FAR, FAR) ?? 0;
        me.s = [r2(x), r2(z), r2(h), r2(sp), f | 0, r2(num(v[5], -FAR * 10, FAR * 10) ?? 0), r2(num(v[6], -2, 20) ?? 0), r2(num(v[7], -FAR * 10, FAR * 10) ?? 0), cx, cz, r2(num(v[10], -6, 6) ?? 0), r2(num(v[11], -2, 6) ?? 0), r2(num(v[12], -6, 6) ?? 0), int(v[13], 0, 1023) || 0];
        { const wx = W10x(me), wz = W10z(me); if (me.lp) { const d = (t - me.lp[2]) / 1000; if (d > 0.05 && d < 2) { const k = Math.min(1, d * 3); me.vx = (me.vx || 0) + ((wx - me.lp[0]) / d - (me.vx || 0)) * k; me.vz = (me.vz || 0) + ((wz - me.lp[1]) / d - (me.vz || 0)) * k; } } me.lp = [wx, wz, t]; } // (how they are moving: the hunter aims where they will be)
        me.sea = !!(f & 1); me.dirty = true; return;
      }
      if (m.t === 'hit') {
        if (C.phase !== 'fight' || !atHome(me)) return;
        const d = num(m.d, 0, 12); if (!d) return;
        me.dmg = Math.max(0, me.dmg - (t - me.dmgT) * ((me.s[4] & 4) ? 0.03 : 0.018)); me.dmgT = t;
        if (me.dmg > 40) return; me.dmg += d;
        C.hp = Math.max(0, C.hp - d); if (!boss.final) hurtBoss(d, me.name); else boss.crews[me.name] = (boss.crews[me.name] || 0) + d;
        const a0 = num(m.a, 0, 9);
        if (a0 != null) { const a = a0 | 0;
          if (S.drag && S.drag.a === a && ++S.drag.hits >= 3) { all({ t: 'ev', e: 'freed', id: S.drag.id, by: me.id }); S.drag = null; }
          else if (m.k === 'stun' && S.arms[a] && S.arms[a].stun < t) { S.arms[a].stun = t + 3500 / speed; S.arms[a].busy = 0; all({ t: 'ev', e: 'stun', a, by: me.id }); } }
        if (C.hp <= 0) endFight(true); else me.hpDirty = true;
        return;
      }
      if (m.t === 'shot') { const v = [m.x1, m.z1, m.x2, m.y2, m.z2].map((q) => num(q, -20, 20)); if (v.some((q) => q == null)) return; all({ t: 'shot', by: me.id, v: v.map(r2), g: m.g ? 1 : 0, cx: me.s[8], cz: me.s[9] }, me); return; }
      if (m.t === 'pick') {
        const o = items.get(String(m.id)); if (!o) return;
        const ox = W10(o.cx, o.x), oz = W10(o.cz, o.z), mx = W10(me.s[8], (me.s[4] & 16) ? me.s[10] : me.s[0]), mz = W10(me.s[9], (me.s[4] & 16) ? me.s[12] : me.s[1]);
        const near = hyp(ox, oz, mx, mz) < 1.1 || ((me.s[4] & 4) && hyp(ox, oz, me.s[5], me.s[7]) < 1.2);
        if (!near) return;
        if (o.k === 'p' || o.k === 'c') { if (me.carry.p + me.carry.c >= 4) return; me.carry[o.k]++; }
        items.delete(o.id); dirty = true; all({ t: 'picked', id: o.id, by: me.id, name: me.name }); return;
      }
      if (m.t === 'deliver') {
        const nearRig = atHome(me) && hyp(me.s[0], me.s[1], RIG.x, RIG.z) < 2.6, toHeli = !!m.heli;
        if ((!nearRig && !toHeli) || me.carry.p + me.carry.c === 0) return;
        const { p, c } = me.carry; me.carry = { p: 0, c: 0 };
        C.saved += p; C.round.saved += p; C.rig = Math.min(1, C.rig + 0.03 * c);
        all({ t: 'delivered', by: me.id, p, c }); pushC(); return;
      }
      if (m.t === 'down') { // a boat goes down: what it carried washes up on the island, labelled with whose it was
        me.carry = { p: 0, c: 0 };
        const add = []; const drop = m.drop && typeof m.drop === 'object' ? m.drop : {};
        for (const mat of MATS) { let k = int(drop[mat], 0, 20) || 0; while (k > 0 && add.length < 8) { const nn = Math.min(k, 3); k -= nn; const [x, z] = beach(); add.push(addItem({ cx: ISLAND[0], cz: ISLAND[1], x, z, k: 'w', m: mat, n: nn, lbl: `from ${me.name}'s boat` })); } }
        if (!add.length) { const [x, z] = beach(); add.push(addItem({ cx: ISLAND[0], cz: ISLAND[1], x, z, k: 'w', m: 'wood', n: 1, lbl: `from ${me.name}'s boat` })); }
        announce(add); all({ t: 'down', id: me.id }); return;
      }
      if (m.t === 'tow') { const p = peers.get(String(m.id)); if (p && hyp(W10(p.s[8], p.s[0]), W10(p.s[9], p.s[1]), W10(me.s[8], me.s[0]), W10(me.s[9], me.s[1])) < 1.6) all({ t: 'tow', id: p.id, by: me.id }); return; }
      if (m.t === 'up') { const by = peers.get(String(m.by)); all({ t: 'up', id: me.id, by: by ? by.id : '' }); return; }
      if (m.t === 'heli') { if (m.on && !C.pilot && C.phase === 'fight' && atHome(me)) C.pilot = me.id; else if (!m.on && C.pilot === me.id) C.pilot = ''; all({ t: 'heli', pilot: C.pilot }); return; }
      if (m.t === 'free') { if (S.drag && S.drag.id === me.id) { all({ t: 'ev', e: 'freed', id: me.id, by: me.id }); S.drag = null; } return; }
      if (m.t === 'block') { // place (ty >= 0) or remove (ty = -1) one block on the grid of a chunk
        const cx = int(m.cx, -FAR, FAR), cz = int(m.cz, -FAR, FAR), i = int(m.i, -45, 45), j = int(m.j, 0, 40), k = int(m.k, -45, 45), ty = int(m.ty, -1, MATS.length - 1), sh = int(m.s, 0, 2) || 0, ro = int(m.r, 0, 3) || 0;
        if ([cx, cz, i, j, k, ty].some((v) => v == null)) return;
        me.placed = Math.max(0, me.placed - (t - me.placedT) * 0.012); me.placedT = t; if (me.placed > 30) return; me.placed++; // ~12 a second
        const key = `${cx},${cz},${i},${j},${k}`; dirty = true; // blocks are part of the saved world
        if (ty >= 0) { if (blocks.has(key) || blocks.size >= MAX_BLOCKS) return; const c = int(m.c, -1, 7) ?? -1; blocks.set(key, { t: ty, o: me.name, s: sh, r: ro, c }); all({ t: 'blk', a: [[key, ty, me.name, sh, ro, c]] }); }
        else { const b = blocks.get(key); if (!b) return; blocks.delete(key); all({ t: 'blk', r: [key], by: me.name, ty: b.t }); }
        dirty = true; return;
      }
      if (m.t === 'give') { // materials toward a camp structure on the island
        const site = sites[m.site]; if (!site || site.done) return;
        const cost = SITES[m.site].cost; let any = false;
        for (const mat of Object.keys(cost)) { const k = int(m.m && m.m[mat], 0, 50) || 0, room = cost[mat] - site.have[mat]; const g = Math.min(k, room); if (g > 0) { site.have[mat] += g; any = true; } }
        if (!any) return; dirty = true;
        if (!site.by.includes(me.name)) site.by.push(me.name);
        site.done = Object.keys(cost).every((mat) => site.have[mat] >= cost[mat]);
        all({ t: 'site', id: m.site, have: site.have, done: site.done, by: me.name }); pushC(); return;
      }
      if (m.t === 'ahit') { const a = warms.get(String(m.id || '')), d = num(m.d, 0, 6); if (!a || !d) return;
        if (hyp(W10x(me), W10z(me), a.x, a.z) > 9) return; me.dmg = Math.max(0, me.dmg - (t - me.dmgT) * 0.02); me.dmgT = t; if (me.dmg > 40) return; me.dmg += d;
        a.hp -= d; hurtBoss(d, me.name); if (a.hp <= 0) severArm(a, me.name); else all({ t: 'ahp', id: a.id, hp: Math.round(a.hp), boss: bossOut() }); return; }
      if (m.t === 'pvp') { const q = peers.get(String(m.id || '')); if (!q || q === me) return; const no = (why) => send(ws, { t: 'raidno', why });
        if (!(me.s[4] & 32) || !(q.s[4] & 32)) return no('only raiders fight raiders');
        if (C.phase === 'warn' || C.phase === 'fight') return no('not now: it is here, everyone is needed');
        if (t - (me.raidAt || 0) < 2500) return; if (hyp(W10x(me), W10z(me), W10x(q), W10z(q)) > 9) return;
        const qh = q.home && homes.get(q.home); if (qh && hyp(W10x(q), W10z(q), qh.x, qh.z) < 7) return no(`${q.name} is home: safe there`);
        if (!qh || C.day - (qh.bornDay ?? -99) < 3) return no(`${q.name} is new out here: leave them be`);
        me.raidAt = t; send(q.ws, { t: 'raided', by: me.name }); send(ws, { t: 'raidok', id: q.id, name: q.name }); all({ t: 'pvpev', a: me.name, b: q.name }); return; }
      if (m.t === 'spill') { const add = []; for (const mat of MATS) { const k = int(m.m && m.m[mat], 0, 200) || 0; if (k > 0 && add.length < 4) { const ang = Math.random() * 6.28, rr = 1.0 + Math.random() * 0.5, c = toChunk(W10x(me) + Math.cos(ang) * rr, W10z(me) + Math.sin(ang) * rr); /* over the side, a little way off */ add.push(addItem({ ...c, k: 'w', m: mat, n: k, lbl: `from ${me.name}'s hold` })); } } announce(add); return; }
      if (m.t === 'died') { all({ t: 'died', id: me.id, name: me.name, why: m.why === 'cold' ? 'cold' : 'kraken' }, me); if (HUNT.tid === me.id) HUNT.tid = ''; return; } // (drowned or taken: everyone near hears)
      if (m.t === 'lost') { // a boat broken up under someone at sea: half its hold floats where it went down, labelled with whose it was
        const add = []; const drop = m.drop && typeof m.drop === 'object' ? m.drop : {}; const x0 = W10x(me), z0 = W10z(me);
        for (const mat of MATS) { const k = int(drop[mat], 0, 20) || 0; if (k > 0 && add.length < 4) { const a = Math.random() * 6.28, c = toChunk(x0 + Math.cos(a) * 0.6, z0 + Math.sin(a) * 0.6); add.push(addItem({ ...c, k: 'w', m: mat, n: Math.min(k, 6), lbl: `from ${me.name}'s boat` })); } }
        announce(add); all({ t: 'lost', id: me.id }); return; }
      if (m.t === 'help') { // a piece of someone's wrecked boat carried off their beach (by them, or by a passer-by who brings it to their dock)
        const q = peers.get(String(m.id || '')), n0 = int(m.n, 0, 5); if (!q || n0 == null) return;
        if (q !== me && !(me.s[4] & 16)) return; // (helpers are on foot)
        all({ t: 'help', id: q.id, by: me.id, n: n0 }); return; }
      if (m.t === 'mem') { const h = me.home && homes.get(me.home); const n0 = int(m.n, 0, 20); if (h && n0 != null) { h.mem = n0; if (m.end) h.end = 1; dirty = true; all({ t: 'isl', a: [homeOut(h)] }); } return; }
      if (m.t === 'blocks' && Array.isArray(m.a)) { const add = [];
        me.placed = Math.max(0, me.placed - (t - me.placedT) * 0.012); me.placedT = t;
        for (const b of m.a.slice(0, 60)) { if (!Array.isArray(b) || me.placed > 90) break; const [cx, cz, i, j, k] = [int(b[0], -FAR, FAR), int(b[1], -FAR, FAR), int(b[2], -45, 45), int(b[3], 0, 40), int(b[4], -45, 45)], ty = int(b[5], 0, MATS.length - 1), sh = int(b[6], 0, 2) || 0, ro = int(b[7], 0, 3) || 0, c = int(b[8], -1, 7) ?? -1;
          if ([cx, cz, i, j, k, ty].some((v) => v == null)) continue; const key = `${cx},${cz},${i},${j},${k}`; if (blocks.has(key) || blocks.size >= MAX_BLOCKS) continue;
          me.placed++; blocks.set(key, { t: ty, o: me.name, s: sh, r: ro, c }); add.push([key, ty, me.name, sh, ro, c]); }
        if (add.length) { dirty = true; all({ t: 'blk', a: add }); } return; }
      if (m.t === 'dep' || m.t === 'wd') { // a chest: put everything in, or take everything out (only your own, or the camp's)
        const id = String(m.id || ''), ch = chests.get(id), at = chestAt(id); if (!ch || !at) return;
        if (hyp(W10x(me), W10z(me), at.x, at.z) > 7) return;
        if (m.t === 'dep') { let any = false; for (const mat of MATS) { const k = int(m.m && m.m[mat], 0, 500) || 0; if (k > 0) { ch[mat] = Math.min(9999, ch[mat] + k); any = true; } }
          if (!any) return; dirty = true; all({ t: 'chest', id, c: ch, by: me.name }); if (id === 'camp') feedSites(); return; }
        if (id !== 'camp' && id !== me.home) { send(ws, { t: 'took', id, m: {}, no: 1 }); return; }
        const out = {}; for (const mat of MATS) if (ch[mat] > 0) { out[mat] = ch[mat]; ch[mat] = 0; }
        dirty = true; send(ws, { t: 'took', id, m: out }); all({ t: 'chest', id, c: ch, by: me.name }); return;
      }
      if (m.t === 'disc') { const rx = int(m.rx, -FAR, FAR), rz = int(m.rz, -FAR, FAR); if (rx == null || rz == null) return;
        const k = rx + ',' + rz; if (disc.has(k)) return;
        if (Math.abs(Math.round(W10x(me) / 32) - rx) > 1 || Math.abs(Math.round(W10z(me) / 32) - rz) > 1) return; // only where you are
        if (disc.size >= MAX_DISC) disc.delete(disc.keys().next().value);
        disc.set(k, me.name); dirty = true; all({ t: 'disc', a: [[k, me.name]] }); return; }
      if (m.t === 'name') { me.name = safeName(m.name) || me.name; if (me.home && homes.get(me.home)) { homes.get(me.home).name = me.name; all({ t: 'isl', a: [homeOut(homes.get(me.home))] }); } all({ t: 'name', id: me.id, name: me.name }); return; }
      if (m.t === 'days') { const d = int(m.d, 0, 9999); if (d != null && d !== me.days) { me.days = d; all({ t: 'days', id: me.id, d }); } return; }
      if (m.t === 'color') { if (COLORS.includes(m.color)) { me.color = m.color; all({ t: 'color', id: me.id, color: me.color }); } return; }
      if (m.t === 'iname') { // naming your own island: checked here, then everyone sees it (on the chart, the sign, the discovery card)
        const h = me.home && homes.get(me.home); if (!h) { send(ws, { t: 'inamed', ok: 0, why: 'you have no island yet' }); return; }
        if (t - (me.inameAt || 0) < 1500) { send(ws, { t: 'inamed', ok: 0, why: 'a moment' }); return; } me.inameAt = t;
        const v = m.name === '' ? { ok: true, name: '' } : isleNameCheck(m.name); if (!v.ok) { send(ws, { t: 'inamed', ok: 0, why: v.why }); return; }
        h.iname = v.name; dirty = true; send(ws, { t: 'inamed', ok: 1, name: v.name }); all({ t: 'isl', a: [homeOut(h)] }); return; }
      if (m.t === 'spots') { // where this page says it has beaches and ruins near it (only ones near where it is count)
        const x0 = W10x(me), z0 = W10z(me), ok = (q) => Array.isArray(q) && num(q[0], -FAR * 10, FAR * 10) != null && num(q[1], -FAR * 10, FAR * 10) != null && hyp(q[0], q[1], x0, z0) < 30;
        me.spots = { t, b: (Array.isArray(m.b) ? m.b : []).slice(0, 16).filter(ok).map((q) => [q[0], q[1]]), u: (Array.isArray(m.u) ? m.u : []).slice(0, 8).filter(ok).map((q) => [q[0], q[1], String(q[2] || '').slice(0, 40)]) }; return; }
      if (m.t === 'dig') { const o = loot.get(String(m.id || '')); if (!o || o.k !== 'dig' || hyp(o.x, o.z, W10x(me), W10z(me)) > 1.3) return; me.digging = { id: o.id, t }; return; }
      if (m.t === 'open') { // take it: the first one the room hears gets it
        const id = String(m.id || ''), o = loot.get(id); if (!o) { send(ws, { t: 'lootno', id, why: 'gone' }); return; }
        const d = hyp(o.x, o.z, W10x(me), W10z(me)); if (d > (o.k === 'sunk' ? 1.8 : 1.4)) { send(ws, { t: 'lootno', id, why: 'too far' }); return; }
        if (o.k === 'dig' && !(me.digging && me.digging.id === id && t - me.digging.t >= 1000 / Math.max(1, speed))) { send(ws, { t: 'lootno', id, why: 'dig first' }); return; }
        loot.delete(id); dirty = true; me.digging = null; const g = { ...o.g }; let frag = null;
        if (g.frag) { const a = Math.random() * 6.28, dd = 45 + Math.random() * 60, fx = W10x(me) + Math.cos(a) * dd, fz = W10z(me) + Math.sin(a) * dd, x = lootAdd('x', fx, fz); frag = [r2(fx), r2(fz), x.id]; } // (a map fragment shows where something better is)
        send(ws, { t: 'got', id, k: o.k, g, frag }); all({ t: 'lootgone', id, by: me.id, name: me.name }, me); return; }
      if (m.t === 'flare') { const x = num(m.x, -FAR * 10, FAR * 10), z = num(m.z, -FAR * 10, FAR * 10); if (x == null || z == null || hyp(x, z, W10x(me), W10z(me)) > 3) return;
        if (t - (me.flareAt || 0) < 2500) return; me.flareAt = t; let scared = false;
        if (HUNT.on && hyp(HUNT.x, HUNT.z, x, z) < 9) { scared = true; HUNT.stun = t + 7000 / speed; const dx = HUNT.x - x, dz = HUNT.z - z, l = Math.hypot(dx, dz) || 1; HUNT.x = x + dx / l * 10; HUNT.z = z + dz / l * 10; HUNT.next = t + 7000 / speed; HUNT.tid = ''; HUNT.since = t; all({ t: 'hunt', on: 1, x: r2(HUNT.x), z: r2(HUNT.z), id: '' }); }
        all({ t: 'flare', id: me.id, x: r2(x), z: r2(z), scared: scared ? 1 : 0 }); return; }
      if (m.t === 'dev' && dev) {
        if (num(m.speed, 0.1, 50)) { const k = m.speed; C.until = t + (C.until - t) * speed / k; speed = k; }
        if (m.phase === 'fight') startFight(); else if (m.phase === 'calm') { set('calm', DUR.calm); C.supplyAt = t + 20000 / speed; spawnCalm(); pushC(); } else if (m.phase === 'warn') { set('warn', DUR.warn); pushC(); }
        if (num(m.hp, 0, 1e5) != null && C.phase === 'fight') { C.hp = m.hp; if (C.hp <= 0) endFight(true); else pushC(); }
        if (num(m.until, 0, 1e6) != null) { C.until = t + m.until; pushC(); }
        if (m.wash) { const cx = int(m.cx, -1, 1) ?? 0, cz = int(m.cz, -1, 1) ?? 0; announce([addItem({ cx, cz, x: num(m.x, -4.5, 4.5) ?? 2, z: num(m.z, -4.5, 4.5) ?? 2, k: 'd', m: MATS.includes(m.m) ? m.m : 'wood', n: 2, lbl: 'driftwood' })]); }
        if (m.supply) supplyDrop();
        if (int(m.islands, 1, 64)) { const add = []; for (let i = 0; i < m.islands; i++) { const r = claimHome('test' + Math.random().toString(36).slice(2, 10), 'Isle ' + (homes.size + 1)); if (r.h) add.push(homeOut(r.h)); } if (add.length) all({ t: 'isl', a: add }); }
        if (num(m.boss, 0, 1e6) != null) { boss.hp = m.boss; if (boss.hp <= 0) hurtBoss(1, me.name); all({ t: 'boss', boss: bossOut() }); pushC(); }
        if (m.respawn) { boss.respawnAt = 0; }
        if (m.arms) spawnArms();
        if (m.hunt !== undefined) { HUNT.enabled = !!m.hunt; if (!HUNT.enabled) huntOff(); } if (m.huntNow) HUNT.next = 0; if (m.huntInfo) send(ws, { t: 'huntinfo', h: { on: HUNT.on, x: r2(HUNT.x), z: r2(HUNT.z), tid: HUNT.tid, next: HUNT.next - t, stun: HUNT.stun - t, log: HUNT.log.slice(-5) }, night: isNight(t), peers: [...peers.values()].map((p) => ({ id: p.id, x: r2(W10x(p)), z: r2(W10z(p)), vx: r2(p.vx || 0), vz: r2(p.vz || 0), f: p.s[4], f2: p.s[13] || 0, prey: preyOK(p) })) }); if (num(m.huntGap, 0, 1e5) != null) HUNT.gap = m.huntGap;
        if (m.night) { set('calm', DUR.calm); C.until = t + DUR.calm * 0.14 / speed; C.supplyAt = 0; pushC(); } // (late in the calm: dark)
        if (m.old && me.home && homes.get(me.home)) homes.get(me.home).bornDay = C.day - 10;
        if (m.chest && chests.has(m.chest.id)) { Object.assign(chests.get(m.chest.id), m.chest.c); all({ t: 'chest', id: m.chest.id, c: chests.get(m.chest.id) }); }
        if (num(m.lootGap, 0, 1e7) != null) { lootGap = m.lootGap; for (const p of peers.values()) p.lootNext = Math.min(p.lootNext || 0, t + lootGap); }
        if (m.loot) { const k = LOOT_TABLE[m.loot] ? m.loot : 'float'; if (num(m.x, -FAR * 10, FAR * 10) != null && num(m.z, -FAR * 10, FAR * 10) != null) lootAdd(k, m.x, m.z, m.g ? { g: m.g } : {}); else lootFor(me, t, k); }
        if (m.lootClear) { for (const id of loot.keys()) all({ t: 'lootgone', id }); loot.clear(); }
        if (m.lootInfo) send(ws, { t: 'lootinfo', a: [...loot.values()].map((o) => ({ ...o })), spots: me.spots || null });
        return;
      }
    };
    ws.on('close', () => { if (me) { peers.delete(me.id); if (C.pilot === me.id) { C.pilot = ''; all({ t: 'heli', pilot: '' }); } all({ t: 'leave', id: me.id }); if (!peers.size) saveNow(); } }); // the last one out: save now
    ws.on('error', () => {});
  });
  return wss;
}
