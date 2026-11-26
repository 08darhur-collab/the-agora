'use strict';
/* ═══════════════════════════════════════════════════════════════════
   THE AGORA — engine (pure; no DOM). Also loaded by the test scripts in node.
═══════════════════════════════════════════════════════════════════ */
if (typeof module !== 'undefined' && typeof AXES === 'undefined') {
  Object.assign(globalThis, require('./data.js'));
}

/* A hand-edited entry with a mistake is left out instead of stopping the whole page, and the page says which ones
   were left out and why (see the note that 20-util.js puts at the top of the page). */
const DATA_ISSUES = [];
(() => {
  const axes = new Set(AXES.map(a => a.k)), keyOk = k => typeof k === 'string' && k.trim() && k.trim().split(/\s+/).every(t => /^~?[a-z]{2}[+-]$/.test(t) && axes.has(t.replace('~', '').slice(0, 2)));
  const sift = (list, what, problem) => {
    const seen = new Set(), keep = [];
    list.forEach(e => {
      const name = e && (e.id || e.n) ? String(e.id || e.n) : 'an entry without an id';
      const why = !e || typeof e !== 'object' ? 'is not an entry' : typeof e.id !== 'string' || !e.id ? 'has no id' : seen.has(e.id) ? 'appears twice (the second copy is ignored)' : problem(e);
      if (why) DATA_ISSUES.push(`${what} ${name}: ${why}`); else { seen.add(e.id); keep.push(e); }
    });
    if (keep.length !== list.length) { list.length = 0; keep.forEach(e => list.push(e)); }
  };
  const profile = e => typeof e.n !== 'string' || !e.n ? 'has no name (n)'
    : !Array.isArray(e.a) || e.a.length !== 12 ? `needs exactly 12 positions in a:[…], found ${Array.isArray(e.a) ? e.a.length : 'none'}`
    : e.a.some(v => typeof v !== 'number' || !(v >= 0 && v <= 100)) ? 'has a position that is not a number from 0 to 100' : '';
  sift(QUESTIONS, 'Statement', q => q.ax === 'cr' ? (typeof q.q !== 'string' || !q.q ? 'has no text (q)' : '') : !axes.has(q.ax) ? `unknown axis "${q.ax}"` : !keyOk(q.k) ? `its key k:"${q.k}" is not valid`
    : !q.k.trim().split(/\s+/).some(t => t === q.ax + '+' || t === q.ax + '-') ? `its key must include ${q.ax}+ or ${q.ax}-` : typeof q.q !== 'string' || !q.q ? 'has no text (q)' : '');
  const lists = [[IDEOLOGIES, 'Ideology'], [PEOPLE, 'Person'], [COUNTRIES, 'Country or region'], [REGIMES, 'Regime']];
  // an ideology's core-belief stances ride along with its positions (e.a.cr), so any ranking from a profile can use them
  const attach = () => IDEOLOGIES.forEach(e => { if (e.cr && Array.isArray(e.a)) Object.defineProperty(e.a, 'cr', { value: e.cr, configurable: true, writable: true }); });
  globalThis.agoraCheckData = () => { lists.forEach(([list, what]) => sift(list, what, profile)); attach(); };
  globalThis.agoraCheckData();
})();

const Engine = (() => {
  const AX = AXES.map(a => a.k);                 // ['st','ru',…]
  const AXI = Object.fromEntries(AX.map((k, i) => [k, i]));
  const BLOCK_AXES = BLOCKS.map(b => AXES.map((a, i) => (a.b === b.k ? i : -1)).filter(i => i >= 0));
  const SE_FLOOR = 0.06, Z90 = 1.645;
  let CONF = 0.2;   // how strongly mixed answers on an axis reduce its weight in matching (see weights)

  /* The seven answers, as values: agreeing counts toward the direction a statement is keyed, disagreeing against it. */
  const SCALE = [
    { a: 3, n: 'Strongly agree' }, { a: 2, n: 'Agree' }, { a: 1, n: 'Slightly agree' }, { a: 0, n: 'Neutral' },
    { a: -1, n: 'Slightly disagree' }, { a: -2, n: 'Disagree' }, { a: -3, n: 'Strongly disagree' },
  ];
  const STAR_W = 2;   // a starred statement counts twice in its axis averages

  /* What agreeing with each statement does, parsed once: "ow- ~we-" →
     [{k: Ownership, s: −1, w: 1, b: 35}, {k: Welfare, s: −1, w: 0.5, b: 42}] (s = direction of agreement, w = weight,
     b = the statement's neutral point on that axis).

     Every statement has a neutral point b (0–100) on its own axis: the position at which a person would neither
     agree nor disagree with it. "The Internet should be banned" (keyed toward Precaution) sits near 97, because only
     people at the far end agree; a mild statement keyed the same way sits near 35, because everyone but the other
     side agrees. Without b a statement is treated as dividing the axis in the middle (50). On an axis a statement
     only pulls a little (~), it is half as far from the middle. */
  const locOf = q => (typeof q.b === 'number' ? q.b : 50);
  const WEAK_W = 0.6;   // a statement marked wk: 1 separates positions less sharply, so it counts for less
  const KEYS = Object.fromEntries(QUESTIONS.filter(q => q.ax !== 'cr').map(q => {
    const toks = q.k.split(/\s+/).filter(Boolean).map(tok => {
      const half = tok[0] === '~', t = half ? tok.slice(1) : tok;
      return { k: AXI[t.slice(0, 2)], s: t[2] === '+' ? 1 : -1, w: half ? 0.5 : 1 };
    });
    const own = toks.find(x => x.k === AXI[q.ax] && x.w === 1) || toks[0];
    const d = 50 + own.s * (locOf(q) - 50);   // how far toward the pole it is keyed to one must be to agree
    toks.forEach(x => { x.b = x === own ? locOf(q) : 50 + x.s * (d - 50) * 0.5; });
    return [q.id, toks];
  }));
  const ITEM_W = Object.fromEntries(QUESTIONS.map(q => [q.id, q.wk ? WEAK_W : 1]));

  /* ── core beliefs: named positions matched directly against each ideology's stance ── */
  const BQ = QUESTIONS.filter(q => q.ax === 'cr' && !q.x), BKEY = Object.fromEntries(QUESTIONS.filter(q => q.ax === 'cr').map(q => [q.id, q.cr]));
  const isBelief = id => id in BKEY;
  // an ideology's stance t (1, 0.5, 0) against an answer x (0 = strongly disagree … 1 = strongly agree):
  // 0 when they agree fully, 1 when they are opposite; a "divided" stance costs little either way
  const bgap = (x, t) => t === 0.5 ? 0.5 * Math.abs(x - 0.5) : Math.abs(x - t);
  let BW = 0.35, BHALF = 3;   // the share of the match that core beliefs can carry, reached as more of them are answered
  function setBeliefs(w, half) { BW = w; if (half) BHALF = half; }
  function beliefFit(A, cr) {
    if (!A || !cr) return null;
    let s = 0, n = 0;
    for (const k in A) { const t = cr[k], x = A[k]; if (t === null || t === undefined || x === null || x === undefined) continue; s += bgap(x, t); n++; }
    return n ? { m: 100 * (1 - s / n), n } : null;
  }
  function blend(m, A, cr) {
    const b = beliefFit(A, cr); if (!b) return m;
    const w = BW * b.n / (b.n + BHALF);
    return (1 - w) * m + w * b.m;
  }

  /* The answer a person at position t is expected to give to a statement keyed in direction s with neutral point b:
     from −3 (strongly disagree) to +3 (strongly agree). Someone TAU points past the neutral point "agrees" (≈2.3). */
  const TAU = 22;
  // tanh is looked up, not computed: positions and neutral points are whole or half numbers, so their differences are too
  const TANH = new Float64Array(561); for (let i = 0; i < 561; i++) TANH[i] = Math.tanh((i - 280) / 2 / TAU);
  const expect = (t, s, b) => { const j = (t - b) * 2 + 280; return 3 * s * (j >= 0 && j <= 560 && j === Math.floor(j) ? TANH[j] : Math.tanh((t - b) / TAU)); };

  /* One-sided statements (o: 1) can be disagreed with for opposite reasons, so only agreeing with them counts. */
  // o: 1 → only agreeing counts (people disagree for opposite reasons); o: -1 → only disagreeing counts
  const counts = (q, a) => !(q.o === 1 && a < 0) && !(q.o === -1 && a > 0);

  /* answers: { qid: −3…+3 } (+3 strongly agree, 0 neutral, −3 strongly disagree); stars: Set of qids marked "matters to me".

     For every axis, the test asks: at which position would a person most plausibly have given these answers? Each
     position t from the left pole to the right is scored by how well the answers it predicts (see expect) match the
     ones given, counting a starred statement twice and a half-pull (~) half. The result P is the average of all
     positions weighted by that fit, and the margin says how wide the range of well-fitting positions is. So strongly
     rejecting a far-out statement says only "not at that far end"; it no longer pushes a result to the opposite pole. */
  const GRID = []; for (let t = -20; t <= 120; t += 2) GRID.push(t);   // runs a little past the poles so 0 and 100 can be reached
  let SIGMA = 1.35, PRIOR_SD = 32;   // how far real answers scatter around the expected one; how strongly results lean to the middle when little is known
  const PRIOR = GRID.map(t => -((t - 50) ** 2) / (2 * PRIOR_SD * PRIOR_SD));
  function locate(obs) {   // obs: [{ a, s, b, w }] → { m: position, sd: uncertainty in points }
    const L = GRID.map((t, i) => {
      let e = 0;
      for (const o of obs) e -= o.w * (o.a - expect(t, o.s, o.b)) ** 2;
      return e / (2 * SIGMA * SIGMA) + PRIOR[i];
    });
    const mx = Math.max(...L); let Z = 0, m = 0, v = 0;
    L.forEach((e, i) => { const p = Math.exp(e - mx); L[i] = p; Z += p; m += p * GRID[i]; }); m /= Z;
    L.forEach((p, i) => { v += p * (GRID[i] - m) ** 2; });
    // the poles are ideals: even the most consistent answers top out at 98, so a result never reads as a perfect 0 or 100
    m = 50 + (Math.max(0, Math.min(100, m)) - 50) * 0.96;
    return { m, sd: Math.sqrt(v / Z) };
  }
  function score(answers, stars) {
    const vals = AX.map(() => []), facet = AX.map(() => ({}));
    const asked = AX.map(() => 0), starred = AX.map(() => 0);
    let answered = 0;
    const beliefs = {};
    QUESTIONS.forEach(q => {
      const a = answers[q.id];
      if (typeof a !== 'number') return;
      if (q.ax === 'cr') { answered++; beliefs[q.cr] = (a + 3) / 6; return; }
      const k0 = AXI[q.ax], st = !!(stars && stars.has(q.id)), m = (st ? STAR_W : 1) * ITEM_W[q.id];
      answered++; asked[k0]++; if (st) starred[k0]++;
      if (!counts(q, a)) return;   // a one-sided statement you disagreed with leaves your result unchanged
      KEYS[q.id].forEach(({ k, s, w, b }) => {
        const o = { a, s, b, w: w * m, v: s * a / 3, q: q.id };
        vals[k].push(o);
        if (q.f && k === k0) (facet[k][q.f] = facet[k][q.f] || []).push(o);
      });
    });
    const P = [], n = [], se = [], margin = [], sal = [], fac = [];
    vals.forEach((list, k) => {
      const W = list.reduce((t, x) => t + x.w, 0);
      n[k] = W;
      sal[k] = asked[k] ? starred[k] / asked[k] : 0;
      if (!W) { P[k] = 50; se[k] = 1; margin[k] = 50; fac[k] = null; return; }
      const est = locate(list);
      P[k] = Math.round(est.m * 10) / 10;
      se[k] = Math.max(SE_FLOOR, est.sd / 50);
      margin[k] = Math.round(Z90 * se[k] * 50);
      const f = facet[k], keys = Object.keys(f);
      fac[k] = keys.length === 2 && keys.every(x => f[x].length >= 2)
        ? Object.fromEntries(keys.map(x => [x, locate(f[x]).m]))
        : null;
    });
    P.cr = Object.keys(beliefs).length ? beliefs : null;
    return { P, n, se, margin, sal, fac, vals, answered, beliefs: P.cr };
  }
  function tuneScore(o) { if (o.sigma) SIGMA = o.sigma; if (o.prior) { PRIOR_SD = o.prior; GRID.forEach((t, i) => { PRIOR[i] = -((t - 50) ** 2) / (2 * PRIOR_SD * PRIOR_SD); }); } }

  // weight of each axis when comparing the user (or any profile) with an entity
  function weights(user, entity) {
    const core = new Set(((entity && entity.core) || '').split(/\s+/).filter(Boolean).map(k => AXI[k]));
    return AX.map((_, k) => {
      let w = 1;
      if (user) {
        if (user.n[k] === 0) return 0;
        if (user.n[k] < 2) w *= 0.5;
        w *= 1 + user.sal[k];   // an axis counts up to twice as much in matching as the share of its statements you starred
        if (CONF) w *= 1 / (1 + (user.se[k] / CONF) ** 2);   // mixed answers on an axis make its position less certain, so it counts less
      }
      if (core.has(k)) w *= 1.5;
      return w;
    });
  }

  /* match = 100 − SPREAD × the typical gap, where the typical gap is a weighted power mean (p = POW) of the
     gaps on each axis, in points on the 0–100 scales. A power above 2 makes one large gap count for more than
     several small ones; SPREAD stretches the scale so that close results are easier to tell apart. */
  let POW = 3, SPREAD = 1.5;
  function match(P, E, w, axes) {
    let s = 0, t = 0;
    (axes || AX.map((_, k) => k)).forEach(k => { const wk = w ? w[k] : 1; s += wk * Math.abs(P[k] - E[k]) ** POW; t += wk; });
    if (!t) return 0;
    const g = (s / t) ** (1 / POW);   // the typical gap in points
    // steep near the top, so close results are easy to tell apart; gentler further down, so distant profiles are not crushed
    return Math.max(0, g <= 10 ? 100 - SPREAD * g : 100 - SPREAD * 10 - 0.9 * (g - 10));
  }
  function setMatch(p, sp) { POW = p; SPREAD = sp; }

  // rank a list of entities against profile P. user = score() result or null (entity-vs-entity)
  function rank(P, list, user, opts) {
    opts = opts || {};
    return list.filter(e => !opts.skip || e.id !== opts.skip).map(e => {
      const w = weights(user, opts.symmetric ? null : e);
      const m = match(P, e.a, w, opts.axes);
      return { e, m: opts.axes || opts.noBeliefs ? m : blend(m, P.cr, e.cr) };
    }).sort((x, y) => y.m - x.m);
  }

  // agreement: axes within 15 points
  function setConf(c) { CONF = c; }

  /* The closest entity on each block (Power, World, Economy, Culture). A pick has to be close on that block AND
     reasonably close overall, so a figure who happens to share three middling positions but is far from you on
     everything else is not shown: picks are ranked by the average of the block match and the overall match.
     Each block gets a different entity, and none repeats the overall top match. */
  function blockPicks(P, list, user, opts) {
    opts = opts || {};
    const all = rank(P, list, user, { skip: opts.skip }), overall = new Map(all.map(x => [x.e.id, x.m]));
    const used = new Set(opts.exclude || []);
    return BLOCK_AXES.map(axes => {
      const r = rank(P, list, user, { skip: opts.skip, axes })
        .map(x => ({ e: x.e, m: x.m, s: (x.m + overall.get(x.e.id)) / 2 }))
        .filter(x => !used.has(x.e.id)).sort((a, b) => b.s - a.s);
      const pick = r[0]; if (pick) used.add(pick.e.id);
      return pick;
    });
  }
  function agree(P, E) { return E.reduce((c, v, k) => c + (Math.abs(P[k] - v) <= 15 ? 1 : 0), 0); }

  /* small seeded random number generator (xorshift), so a draw can be repeated in tests */
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  /* ── where a profile sits relative to a population ── */
  function stats(list) {
    return AX.map((_, k) => {
      const v = list.map(e => e.a[k]).sort((a, b) => a - b);
      const q = p => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
      return { v, med: q(0.5), q1: q(0.25), q3: q(0.75) };
    });
  }
  function apart(E, st, self) {
    const rows = E.map((x, k) => {
      const s = st[k], others = self ? s.v.length - 1 : s.v.length;
      const below = s.v.filter(y => y < x).length, above = s.v.filter(y => y > x).length;
      const iqr = Math.max(10, s.q3 - s.q1);
      return { k, x, med: s.med, z: Math.abs(x - s.med) / iqr, beyondL: below ? 0 : 0,
        pctL: Math.round(100 * above / Math.max(1, others)),   // share further toward the RIGHT pole than E → E is more left than them
        pctR: Math.round(100 * below / Math.max(1, others)) };
    });
    const unusual = rows.slice().sort((a, b) => b.z - a.z || Math.abs(b.x - 50) - Math.abs(a.x - 50))[0];
    const typical = rows.slice().sort((a, b) => a.z - b.z)[0];
    return { unusual, typical, rows };
  }

  /* ── the two versions: each attempt draws its statements from the bank ── */
  const MODES = {
    full:  { k: 'full',  ch: 'f', n: 84, b: 12, name: 'Full test',  mins: 13, adaptive: true },
    quick: { k: 'quick', ch: 'q', n: 48, b: 8, name: 'Quick test', mins: 7, adaptive: true },
  };
  const QB = Object.fromEntries(QUESTIONS.map(q => [q.id, q]));
  // direction of agreement on the statement's own axis: +1 toward the right-hand pole, −1 toward the left
  const SIGN = Object.fromEntries(QUESTIONS.filter(q => q.ax !== 'cr').map(q => [q.id, KEYS[q.id].find(x => x.k === AXI[q.ax] && x.w === 1).s]));

  function shuffle(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  const halves = (n, r) => { const a = Math.floor(n / 2), b = n - a; return r() < 0.5 ? [a, b] : [b, a]; };

  /* draw(mode, seen): the same number of statements on every axis (84 = 7 each, 36 = 3 each). Within an axis the
     statements are split as evenly as possible between those worded toward each pole and, where an axis has two halves
     (Migration, Force, Ownership), between the halves. Their neutral points are spread evenly from one end of the axis
     to the other, so the mild middle and both far ends are all measured. Statements sharing a topic (t) are never
     drawn together, and retired statements (x: 1) are never drawn at all (they only keep old result links working).
     seen = { id: times drawn before }: the least-seen statements are preferred, so repeat attempts bring new ones. */
  const LIVE = QUESTIONS.filter(q => !q.x && q.ax !== 'cr');
  function draw(mode, seen, seed) {
    const M = MODES[mode] || MODES.full;
    const r = rng(seed || ((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0));
    seen = seen || {};
    const base = Math.floor(M.n / AX.length), quota = AX.map(() => base);
    shuffle(AX.map((_, k) => k), r).slice(0, M.n - base * AX.length).forEach(k => { quota[k]++; });
    const topics = new Set(), picked = [];
    shuffle(AX.map((_, k) => k), r).forEach(k => {
      const m = quota[k], fa = AXES[k].fa ? Object.keys(AXES[k].fa) : null;
      const pool = shuffle(LIVE.filter(q => q.ax === AX[k]), r);
      const [toPlus, toMinus] = halves(m, r), fh = halves(m, r);
      const facT = fa ? { [fa[0]]: fh[0], [fa[1]]: fh[1] } : null;
      const got = new Set(), dir = { 1: 0, '-1': 0 }, fc = {};
      const targets = shuffle(Array.from({ length: m }, (_, i) => 14 + 72 * (i + 0.5) / m), r);
      targets.forEach(target => {
        let best = null, bv = Infinity;
        // strict 2: direction and halves balanced; 1: direction only; 0: anything left (never breaks a topic)
        for (const strict of [2, 1, 0]) {
          for (const q of pool) {
            if (got.has(q.id) || (q.t && topics.has(q.t))) continue;
            const d = SIGN[q.id];
            if (strict >= 1 && dir[d] >= (d > 0 ? toPlus : toMinus)) continue;
            if (strict >= 2 && facT && (fc[q.f] || 0) >= facT[q.f]) continue;
            const cost = Math.abs(locOf(q) - target) + 14 * (seen[q.id] || 0) + (q.wk ? 10 : 0) + 8 * r();
            if (cost < bv) { bv = cost; best = q; }
          }
          if (best) break;
        }
        if (!best) return;
        got.add(best.id); if (best.t) topics.add(best.t);
        dir[SIGN[best.id]]++; if (best.f) fc[best.f] = (fc[best.f] || 0) + 1;
      });
      picked.push(...got);
    });
    return { mode: M.k, order: arrange(picked, r) };
  }

  /* order: rounds that each pass once through the axes, never asking the same axis twice in a row */
  function arrange(ids, r) {
    const pools = AX.map(k => shuffle(ids.filter(id => QB[id].ax === k), r));
    const order = []; let last = -1;
    const rounds = Math.max(...pools.map(p => p.length));
    for (let round = 0; round < rounds; round++) {
      const axes = shuffle(AX.map((_, k) => k).filter(k => pools[k].length), r);
      if (axes[0] === last && axes.length > 1) [axes[0], axes[1]] = [axes[1], axes[0]];
      axes.forEach(k => order.push(pools[k].pop()));
      last = axes[axes.length - 1];
    }
    return order;
  }

  /* ── adaptive draw (quick test): after every answer, the rest of the test is planned again.
     The ideologies are treated as hypotheses about you: each predicts how you would answer every statement, and the
     ones whose predictions match your answers so far gain weight. The next statement is the one on which the
     ideologies still in the running disagree most, so each answer does the most to separate them. Every axis is still
     asked at least MIN and at most MAX times, the two directions of wording stay balanced within an axis, and a topic
     is never repeated. ── */
  const AD = { quick: { min: 2, max: 4, warm: 1 }, full: { min: 5, max: 9, warm: 2 } };
  let FISHER = 2;                 // weight of "pins down your own position" next to "separates the ideologies still in the running"
  let PICK_BAND = 0.8;            // statements worth at least this share of the best one are all candidates for the next slot
  let WEAK_PICK = 0.7;            // weak statements are asked less readily
  let NOISE2 = 2 * 2.2 * 2.2;   // assumed spread of real answers around an ideology's prediction (answer units, squared ×2)
  const PRED = {};                // PRED[qid] = predicted answer (−3…+3) for each ideology, computed once
  function predOf(id) {
    if (PRED[id]) return PRED[id];
    if (isBelief(id)) { const k = BKEY[id]; return (PRED[id] = Float64Array.from(IDEOLOGIES, e => { const t = e.cr && e.cr[k]; return t === null || t === undefined ? NaN : 6 * t - 3; })); }
    const keys = KEYS[id], tw = keys.reduce((t, x) => t + x.w, 0);
    return (PRED[id] = Float64Array.from(IDEOLOGIES, e => keys.reduce((t, x) => t + x.w * expect(e.a[x.k], x.s, x.b), 0) / tw));
  }
  // what the planner needs to know about each statement, worked out once
  const FA = AXES.map(a => (a.fa ? Object.keys(a.fa) : null));
  const META = LIVE.map(q => { const k = AXI[q.ax]; return { q, id: q.id, k, s: SIGN[q.id] > 0 ? 1 : 0, f: FA[k] && q.f ? Math.max(0, FA[k].indexOf(q.f)) : 0, t: q.t || null }; });
  function warm() { LIVE.forEach(q => predOf(q.id)); BQ.forEach(q => predOf(q.id)); }   // fills the table of predicted answers ahead of the first question
  function tuneAdaptive(o) { if (o.noise) NOISE2 = 2 * o.noise * o.noise; if (o.quick) Object.assign(AD.quick, o.quick); if (o.full) Object.assign(AD.full, o.full); if (o.fisher !== undefined) FISHER = o.fisher; if (o.band) PICK_BAND = o.band; }
  function plan(mode, fixed, answers, seen, seed, opt) {
    opt = opt || {};
    const M = MODES[mode] || MODES.quick, lim = AD[M.k];
    const r = rng(seed || ((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0));
    seen = seen || {};
    // weight of each ideology given the answers so far
    const logp = new Float64Array(IDEOLOGIES.length);
    fixed.forEach(id => {
      const a = answers[id]; if (typeof a !== 'number' || !counts(QB[id], a)) return;
      const pr = predOf(id);
      for (let i = 0; i < logp.length; i++) { const p = pr[i]; if (p === p) logp[i] -= (a - p) ** 2 / NOISE2; }
    });
    let mx = -Infinity, Z = 0; for (let i = 0; i < logp.length; i++) if (logp[i] > mx) mx = logp[i];
    for (let i = 0; i < logp.length; i++) { logp[i] = Math.exp(logp[i] - mx); Z += logp[i]; }
    const li = [], lp = []; for (let i = 0; i < logp.length; i++) { const p = logp[i] / Z; if (p > 1e-4) { li.push(i); lp.push(p); } }
    const nL = li.length;
    // how much the ideologies still in the running disagree about a statement
    const info = id => {
      const pr = predOf(id); let m = 0, v = 0, z = 0;
      for (let j = 0; j < nL; j++) { const p = pr[li[j]]; if (p === p) { m += lp[j] * p; z += lp[j]; } }
      if (!z) return 0; m /= z;
      for (let j = 0; j < nL; j++) { const p = pr[li[j]]; if (p === p) { const d = p - m; v += lp[j] * d * d; } }
      return v * Math.min(1, z * 1.5);   // a belief few of the likely ideologies have a stance on tells less
    };
    // share of the ideologies still in the running that take any stance on a belief
    const cover = id => { const pr = predOf(id); let z = 0; for (let j = 0; j < nL; j++) if (pr[li[j]] === pr[li[j]]) z += lp[j]; return z; };
    // …and a statement also earns its place by pinning down your own position: it tells most when its neutral point
    // lies near where you seem to stand on an axis that is still uncertain
    const now = FISHER ? score(Object.fromEntries(fixed.map(id => [id, answers[id]])), null) : null;
    const pin = id => {
      if (!now) return 0;
      let f = 0;
      KEYS[id].forEach(x => { const sd = Math.min(30, now.se[x.k] * 50), c = 1 - (expect(now.P[x.k], 1, x.b) / 3) ** 2; f += x.w * c * c * (sd / 15) ** 2; });
      return FISHER * f;
    };
    const cnt = AX.map(() => 0), dir = AX.map(() => [0, 0]), fac = AX.map(() => [0, 0]);
    const used = new Set(fixed.concat(opt.excl || [])), topics = new Set();
    const NB = Math.min(M.b || 0, BQ.length), NA = M.n - NB;
    let bAsked = fixed.filter(isBelief).length, aAsked = fixed.length - bAsked;
    // core beliefs are asked early: all of them within the first half of the test, one in every few statements
    const beliefDue = pos => bAsked < NB && (aAsked >= NA || bAsked < Math.ceil(NB * Math.min(1, (pos + 1) / (M.n * 0.5))) && pos >= 1);
    const bOrder = shuffle(BQ.map(q => q.id).filter(id => !used.has(id)), r)
      .map(id => ({ id, v: (info(id) + 0.002 + 0.03 * cover(id) ** 2) / (1 + 0.5 * (seen[id] || 0)) })).sort((x, y) => y.v - x.v);
    const nextBelief = () => {
      const free = bOrder.filter(c => !used.has(c.id)); if (!free.length) return null;
      const top = free.filter(c => c.v >= PICK_BAND * free[0].v);
      let x = r() * top.reduce((t, c) => t + c.v, 0);
      for (const c of top) { x -= c.v; if (x <= 0) return c.id; }
      return top[0].id;
    };
    fixed.forEach(id => { if (isBelief(id)) return; const q = QB[id], k = AXI[q.ax]; cnt[k]++; dir[k][SIGN[id] > 0 ? 1 : 0]++; if (FA[k] && q.f) fac[k][Math.max(0, FA[k].indexOf(q.f))]++; if (q.t) topics.add(q.t); });
    // every statement still available gets a value; within each axis they are sorted, best first, into four lists
    // (worded toward the left or the right pole × the axis's first or second half), so each step only looks at the heads
    const lists = AX.map(() => [[], [], [], []]);
    shuffle(META.slice(), r).forEach(m => {
      if (used.has(m.id)) return;
      lists[m.k][m.s * 2 + m.f].push({ m, v: (info(m.id) + pin(m.id) + 0.05) * (m.q.wk ? WEAK_PICK : 1) / (1 + 0.5 * (seen[m.id] || 0)) });
    });
    lists.forEach(four => four.forEach(l => l.sort((x, y) => y.v - x.v)));
    const ptr = AX.map(() => [0, 0, 0, 0]), gone = c => used.has(c.m.id) || (c.m.t !== null && topics.has(c.m.t));
    const out = []; let last = fixed.length ? AXI[QB[fixed[fixed.length - 1]].ax] : -1;
    const planned = AX.map(() => 0);
    while (fixed.length + out.length < M.n) {
      if (beliefDue(fixed.length + out.length)) {
        const id = nextBelief();
        if (id) { out.push(id); used.add(id); bAsked++; continue; }
      }
      if (aAsked >= NA && bAsked >= NB) break;
      const left = NA - aAsked, minC = Math.min(...cnt);
      let need = 0; for (let k = 0; k < AX.length; k++) need += Math.max(0, lim.min - cnt[k]);
      const warm = minC < lim.warm, force = need >= left;
      const cands = []; let bv = -1;
      for (let k = 0; k < AX.length; k++) {
        if (cnt[k] >= lim.max) continue;
        if (warm && cnt[k] > minC) continue;            // the first rounds ask every axis in turn
        if (force && cnt[k] >= lim.min) continue;      // keep room for every axis to reach its minimum
        const axisMul = (k === last ? 0.5 : 1) / (1 + planned[k]);
        for (let b = 0; b < 4; b++) {
          const list = lists[k][b]; if (!list.length) continue;
          const s = b >> 1, f = b & 1;
          let mul = axisMul;
          if (dir[k][s] > dir[k][1 - s]) mul *= 0.6;            // prefer the direction asked less on this axis
          if (FA[k] && fac[k][f] > fac[k][1 - f]) mul *= 0.8;   // and the half asked less
          let i = ptr[k][b]; while (i < list.length && gone(list[i])) i++;
          ptr[k][b] = i;
          for (let taken = 0; i < list.length && taken < 6; i++) {
            const c = list[i]; if (gone(c)) continue;
            const v = c.v * mul; if (v < PICK_BAND * bv) break;
            cands.push([v, c.m]); if (v > bv) bv = v; taken++;
          }
        }
      }
      // among the statements that would tell nearly as much as the best one, pick at random, so two people (or two
      // attempts) with the same answers so far don't always get the same next statement
      const top = cands.filter(c => c[0] >= PICK_BAND * bv);
      let best = top.length ? top[top.length - 1][1] : null, x = r() * top.reduce((t, c) => t + c[0], 0);
      for (const c of top) { x -= c[0]; if (x <= 0) { best = c[1]; break; } }
      if (!best) break;
      out.push(best.id); used.add(best.id); if (best.t !== null) topics.add(best.t); aAsked++;
      cnt[best.k]++; planned[best.k]++; dir[best.k][best.s]++; if (FA[best.k]) fac[best.k][best.f]++; last = best.k;
    }
    return out;
  }


  /* ── result code: 'b' + f (full) or q (quick), then each answered statement as its id and one letter:
     A–G = strongly agree … strongly disagree, a–g the same answer starred. e.g. bfst3Cru12a…
     Links from the first version ('a3' + one letter per statement for the original 96) still open. ── */
  const UP = 'ABCDEFG', LO = 'abcdefg';
  const LEGACY = AX.flatMap(k => [1, 2, 3, 4, 5, 6, 7, 8].map(i => k + i));
  function encode(answers, stars, mode) {
    const M = MODES[mode] || MODES.full;
    return 'b' + M.ch + QUESTIONS.filter(q => typeof answers[q.id] === 'number')
      .map(q => q.id + (stars && stars.has(q.id) ? LO : UP)[3 - answers[q.id]]).join('');
  }
  function decode(code) {
    if (!code || typeof code !== 'string') return null;
    const answers = {}, stars = new Set();
    const put = (id, ch) => {
      let d = UP.indexOf(ch);
      if (d < 0) { d = LO.indexOf(ch); if (d >= 0) stars.add(id); }
      if (d < 0) return false;
      answers[id] = 3 - d; return true;
    };
    if (code.slice(0, 2) === 'a3') {
      if (code.length !== 2 + LEGACY.length) return null;
      for (let i = 0; i < LEGACY.length; i++) {
        const ch = code[2 + i];
        if (ch !== 'x' && !put(LEGACY[i], ch)) return null;
      }
      return { answers, stars, mode: 'legacy' };
    }
    const mode = code[0] === 'b' && (code[1] === 'f' ? 'full' : code[1] === 'q' ? 'quick' : null);
    if (!mode) return null;
    const re = /([a-z]{2}\d{1,3})([A-Ga-g])/y;
    let pos = 2;
    while (pos < code.length) {
      re.lastIndex = pos;
      const m = re.exec(code);
      if (!m || !QB[m[1]] || m[1] in answers) return null;
      put(m[1], m[2]); pos = re.lastIndex;
    }
    return { answers, stars, mode };
  }

  function strength(p) {
    const d = Math.abs(p - 50);
    return d < 10 ? 'Balanced' : d < 25 ? 'Leaning' : d < 40 ? 'Strong' : 'Very strong';
  }

  return { BQ, isBelief, beliefFit, blend, setBeliefs, AX, AXI, KEYS, SIGN, SCALE, STAR_W, BLOCK_AXES, MODES, score, tuneScore, locate, expect, locOf, warm, counts, weights, match, setMatch, plan, tuneAdaptive, rank, agree, setConf, blockPicks, stats, apart,
    encode, decode, draw, arrange, strength, rng, shuffle };
})();

if (typeof module !== 'undefined') module.exports = Engine;

/* ═══════════════════════════════════════════════════════════════════
   Page code. Everything below needs a browser.
═══════════════════════════════════════════════════════════════════ */
if (typeof document !== 'undefined') (function () {

const E = Engine;
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('agora.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('agora.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('agora.' + k); } catch (e) {} },
};
const pad2 = n => String(n).padStart(2, '0');
const pct = m => Math.round(m) + '%';

/* ── catalogue index ── */
// COUNTRIES holds sovereign states and, marked with `sub`, regions inside them (sub = parent id) and the EU (sub = 'union')
let NATIONS = [], SUBNATS = [];
const KINDS = {
  ideology: { label: 'Ideology', plural: 'Ideologies', path: 'i', list: IDEOLOGIES },
  person:   { label: 'Person', plural: 'People', path: 'p', list: PEOPLE },
  country:  { label: 'Country', plural: 'Countries', path: 'c', list: NATIONS },
  region:   { label: 'Region', plural: 'Regions and unions', path: 'c', list: SUBNATS },
  regime:   { label: 'Historical regime', plural: 'Historical regimes', path: 'c', list: REGIMES },
};
const BY = new Map();
const FAM = Object.fromEntries(FAMILIES.map(f => [f.k, f]));
const FLD = Object.fromEntries(FIELDS.map(f => [f.k, f]));
const RGN = Object.fromEntries(REGIONS.map(r => [r.k, r]));
const ERA = Object.fromEntries(ERAS.map(r => [r.k, r]));
const BLK = Object.fromEntries(BLOCKS.map(b => [b.k, b]));
const STATS = {};
/* People, countries and regimes arrive in a second file after the page has appeared (see data-more.js);
   indexData() is run once at start and again when they arrive. */
const DATA = { more: PEOPLE.length > 0 };
function indexData() {
  if (typeof agoraCheckData === 'function') agoraCheckData();   // leaves out entries with mistakes (again, once the second file has arrived)
  NATIONS = COUNTRIES.filter(e => !e.sub); SUBNATS = COUNTRIES.filter(e => e.sub);
  KINDS.country.list = NATIONS; KINDS.region.list = SUBNATS;
  BY.clear();
  Object.entries(KINDS).forEach(([kind, K]) => K.list.forEach(e => BY.set(e.id, { e, kind })));
  Object.entries(KINDS).forEach(([kind, K]) => { if (K.list.length) STATS[kind] = E.stats(K.list); });
}
indexData();
/* a note at the top of the page when entries were left out because of mistakes in the data files */
function dataNote() {
  let box = $('#data-note');
  if (!DATA_ISSUES.length) { if (box) box.remove(); return; }
  if (!box) { box = document.createElement('div'); box.id = 'data-note'; box.className = 'data-note'; box.setAttribute('role', 'status'); const m = $('#main'); m.parentNode.insertBefore(box, m); }
  if (box.dataset.n === String(DATA_ISSUES.length)) return;
  box.dataset.n = DATA_ISSUES.length;
  box.innerHTML = `<details><summary><b>${DATA_ISSUES.length} ${DATA_ISSUES.length === 1 ? 'entry in the data files has a mistake and was' : 'entries in the data files have mistakes and were'} left out.</b> Show ${DATA_ISSUES.length === 1 ? 'it' : 'them'}</summary>
    <ul>${DATA_ISSUES.slice(0, 40).map(t => `<li>${esc(t)}</li>`).join('')}${DATA_ISSUES.length > 40 ? `<li>…and ${DATA_ISSUES.length - 40} more</li>` : ''}</ul></details>
    <button type="button" aria-label="Hide this note" onclick="this.parentNode.remove()">✕</button>`;
}
/* The first sentence of a description. A full stop after an initial ("G. D. H. Cole") or a short abbreviation
   ("St. Augustine", "c. 1850") does not end the sentence. */
function firstSentence(t) {
  t = String(t || '');
  const re = /[.!?](?=\s+\S)/g; let m;
  while ((m = re.exec(t))) {
    const before = t.slice(0, m.index), word = (/([\w.]+)$/.exec(before) || [''])[0];
    if (t[m.index] === '.' && (/^(?:[A-Z]|[A-Z]\.[A-Z]|[A-Z][a-z]|Dr|Mr|Mrs|Ms|St|Jr|Sr|vs|c|ca|cf|No|e\.g|i\.e|U\.S|approx)$/.test(word) || /^[a-z0-9(]/.test(t.slice(m.index + 1).trimStart()))) continue;
    return t.slice(0, m.index + 1);
  }
  return t;
}
const hrefOf = (e, kind) => '#/' + KINDS[kind].path + '/' + e.id;
const isPlace = kind => kind === 'country' || kind === 'region' || kind === 'regime';
const parentOf = e => (e.sub && e.sub !== 'union' && BY.get(e.sub)) ? BY.get(e.sub).e : null;
const regionsOf = id => SUBNATS.filter(r => r.sub === id);
const kindLabel = (e, kind) => kind === 'region' && e.sub === 'union' ? 'Union' : KINDS[kind].label;
const fmtN = n => n >= 1000 ? Math.floor(n / 1000) + ',' + String(n % 1000).padStart(3, '0') : String(n);

function groupLabel(e, kind) {
  if (kind === 'ideology') return (FAM[e.f] || {}).n || '';
  if (kind === 'person') return (FLD[e.f] || {}).n || '';
  if (kind === 'country' || kind === 'region') return (RGN[e.reg] || {}).n || '';
  if (kind === 'regime') return (ERA[e.e] || {}).n || '';
  return '';
}
function subLabel(e, kind) {
  if (kind === 'ideology') return groupLabel(e, kind);
  if (kind === 'person') return [e.r, e.y].filter(Boolean).join(' · ');
  if (kind === 'country') return e.g || '';
  if (kind === 'region') { const p = parentOf(e); return [e.g, p && p.n].filter(Boolean).join(' · '); }
  if (kind === 'regime') return [e.g, e.y].filter(Boolean).join(' · ');
  return '';
}
// how a person's `y` reads: "1818–1883" lived, "1953–" born, "d. 71 BC" died, "active 2008–2011" active
function yearsMeta(y) {
  if (!y) return null;
  if (/^active\b/i.test(y)) return ['Active', y.replace(/^active\s*/i, '')];
  if (/^d\.\s/.test(y)) return ['Died', y.replace(/^d\.\s*/, '')];
  if (/[–-]$/.test(y.trim())) return ['Born', y.trim().replace(/[–-]$/, '')];
  return ['Lived', y];
}

/* ── pictures: an `img:` field is tried first (a file in the site folder, e.g. img:"images/marx.jpg", or a link), falling back if it fails; flags of countries and regions with an `iso` code come from
   flagcdn.com; everything else (and any flag that fails) uses the lead image of a Wikipedia article,
   looked up in batches and cached. Every remote image is requested with CORS so the share card can draw it. ── */
const Pics = (() => {
  const API = 'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&redirects=1&prop=pageimages&piprop=thumbnail&pithumbsize=320&titles=';
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem('agora.pics') || '{}') || {}; } catch (e) { cache = {}; }
  const waiting = new Map(); let queue = new Set(), timer = null, saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const keys = Object.keys(cache);
        if (keys.length > 2500) keys.slice(0, keys.length - 2500).forEach(k => delete cache[k]);
        localStorage.setItem('agora.pics', JSON.stringify(cache));
      } catch (e) {}
    }, 400);
  }
  function titleOf(e, kind) {
    if (kind === 'country' || kind === 'region') return e.w || ('Flag of ' + e.n);
    if (kind === 'ideology') return null;
    return e.w || e.n;
  }
  const directOf = (e, kind) => (kind === 'country' || kind === 'region') && e.iso ? `https://flagcdn.com/w320/${e.iso}.png` : null;
  function flush() {
    timer = null;
    const titles = [...queue]; queue = new Set();
    for (let i = 0; i < titles.length; i += 45) {
      const batch = titles.slice(i, i + 45);
      fetch(API + encodeURIComponent(batch.join('|')))
        .then(r => r.json())
        .then(j => {
          const q = j.query || {}, map = {};
          batch.forEach(t => { map[t] = t; });
          (q.normalized || []).forEach(n => Object.keys(map).forEach(t => { if (map[t] === n.from) map[t] = n.to; }));
          (q.redirects || []).forEach(n => Object.keys(map).forEach(t => { if (map[t] === n.from) map[t] = n.to; }));
          const pages = {}; (q.pages || []).forEach(p => { pages[p.title] = p.thumbnail ? p.thumbnail.source : ''; });
          batch.forEach(t => { const u = pages[map[t]] || ''; cache[t] = u; resolve(t, u); });
          save();
        })
        .catch(() => batch.forEach(t => resolve(t, null)));
    }
  }
  function resolve(t, u) { (waiting.get(t) || []).forEach(f => f(u)); waiting.delete(t); }
  function get(title) {
    if (!title) return Promise.resolve(null);
    if (title in cache) return Promise.resolve(cache[title] || null);
    return new Promise(res => {
      if (!waiting.has(title)) waiting.set(title, []);
      waiting.get(title).push(res);
      queue.add(title);
      if (!timer) timer = setTimeout(flush, 60);
    });
  }
  function initials(n) {
    const w = String(n).replace(/\(.*?\)/g, '').split(/[\s-]+/).filter(x => /^[A-ZÀ-ÖØ-Þ]/.test(x));
    return ((w[0] || n)[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
  }
  function html(e, kind, cls) {
    const t = titleOf(e, kind), src = directOf(e, kind), flag = isPlace(kind);
    const c = `pic ${flag ? 'flag' : 'face'} ${cls || ''}`, ini = `<b aria-hidden="true">${esc(initials(e.n))}</b>`;
    if (!e.img && !t && !src) return `<span class="${c}">${ini}</span>`;
    // a custom picture is tried first; if its host blocks or drops it, the flag and then Wikipedia take over
    return `<span class="${c}"${e.img ? ` data-img="${esc(e.img)}"` : ''}${src ? ` data-src="${esc(src)}"` : ''}${t ? ` data-wt="${esc(t)}"` : ''}>${ini}</span>`;
  }
  let io = null;
  // put image u into el; if it fails (or u is empty), run onfail
  function place(el, u, onfail, plain) {
    el.dataset.done = '1';
    if (!u) { if (onfail) onfail(); return; }
    if (el.querySelector('img')) return;
    const im = new Image(); im.alt = ''; im.decoding = 'async'; if (!plain) im.crossOrigin = 'anonymous';
    if (plain) im.referrerPolicy = 'no-referrer';   // many picture hosts refuse requests that name another site as the referrer
    im.onerror = () => { im.remove(); if (onfail) onfail(); };
    im.src = u; el.appendChild(im);
  }
  function wiki(el) { const t = el.dataset.wt; if (!t) return; if (t in cache) place(el, cache[t]); else get(t).then(u => place(el, u)); }
  function flagOrWiki(el) { if (el.dataset.src) place(el, el.dataset.src, () => wiki(el)); else wiki(el); }
  function load(el) { if (el.dataset.img) place(el, el.dataset.img, () => flagOrWiki(el), true); else flagOrWiki(el); }
  function scan(root) {
    const els = $$('.pic[data-wt]:not([data-done]), .pic[data-src]:not([data-done]), .pic[data-img]:not([data-done])', root || document);
    if (!('IntersectionObserver' in window)) { els.forEach(load); return; }
    if (!io) io = new IntersectionObserver(ents => ents.forEach(en => { if (en.isIntersecting) { io.unobserve(en.target); load(en.target); } }), { rootMargin: '300px' });
    els.forEach(el => { if (!el.dataset.img && !el.dataset.src && el.dataset.wt in cache) place(el, cache[el.dataset.wt]); else io.observe(el); });
  }
  // an image the share card can draw: tries the override, then flagcdn, then Wikipedia; `load` returns a drawable image or null
  async function image(e, kind, load) {
    if (e.img) { const im = await load(e.img); if (im) return im; }
    const s = directOf(e, kind);
    if (s) { const im = await load(s); if (im) return im; }
    const t = titleOf(e, kind), u = t ? await get(t) : null;
    return u ? load(u) : null;
  }
  async function url(e, kind) { return e.img || directOf(e, kind) || (await get(titleOf(e, kind))); }
  return { html, scan, url, image, initials, titleOf };
})();

/* ── components ── */

/* Line icons (24 × 24, drawn with the current text colour). One per axis and per block, plus a few for the interface. */
const ICONS = {
  // axes
  st: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M12 3.5v6M12 14.5v6M3.5 12h6M14.5 12h6"/><circle cx="12" cy="12" r="2.4"/>',
  ru: '<path d="M8.5 10.5V3.5h7v7"/><path d="M10.6 6.9l1.1 1.1 2-2.2"/><rect x="3.5" y="10.5" width="17" height="10" rx="1.5"/><path d="M8 14h8"/>',
  li: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.7-1.6"/><path d="M12 14.5v2.5"/>',
  mi: '<path d="M12 3v18" stroke-dasharray="2.2 2.6"/><path d="M3.5 12h15"/><path d="M15 8.5l3.5 3.5-3.5 3.5"/>',
  na: '<path d="M5.5 21V3.5"/><path d="M5.5 4.5h12l-2.5 4 2.5 4h-12"/>',
  fo: '<path d="M12 3.2l7.5 2.8v5.6c0 4.6-3.2 7.9-7.5 9.3-4.3-1.4-7.5-4.7-7.5-9.3V6z"/><path d="M12 8v8M8.5 11.5h7"/>',
  ow: '<path d="M3.5 20.5V11l5 3V11l5 3V5.5h3V3.5h2.5v17z"/><path d="M2.5 20.5h19"/><path d="M7 17.5h1.5M11.5 17.5H13"/>',
  we: '<path d="M12 20s-7.5-4.5-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.5 12 20 12 20z"/><path d="M12 10v5.5M9.3 12.7h5.4"/>',
  tr: '<path d="M4 8.5h14.5"/><path d="M15 5l3.5 3.5L15 12"/><path d="M20 15.5H5.5"/><path d="M9 12l-3.5 3.5L9 19"/>',
  re: '<path d="M12 3c1.7 1.9 2 3.5 0 5.1-2-1.6-1.7-3.2 0-5.1z"/><rect x="9" y="10" width="6" height="10.5" rx="1"/><path d="M5.5 20.5h13"/>',
  mo: '<path d="M6.5 3.5h11M6.5 20.5h11"/><path d="M7.5 3.5c0 4.6 4.5 5.6 4.5 8.5s-4.5 3.9-4.5 8.5M16.5 3.5c0 4.6-4.5 5.6-4.5 8.5s4.5 3.9 4.5 8.5"/><path d="M9.8 18.2h4.4"/>',
  te: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><rect x="10" y="10" width="4" height="4" rx=".5"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>',
  // blocks
  power: '<path d="M3.5 9L12 4l8.5 5z"/><path d="M6.5 11v7M10 11v7M14 11v7M17.5 11v7"/><path d="M4.5 20.5h15"/>',
  world: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.5 3.7 5.4 3.7 8.5s-1.2 6-3.7 8.5c-2.5-2.5-3.7-5.4-3.7-8.5S9.5 6 12 3.5z"/>',
  economy: '<ellipse cx="12" cy="6.5" rx="7" ry="2.6"/><path d="M5 6.5v4.5c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6.5"/><path d="M5 11v4.5c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V11"/>',
  culture: '<path d="M5 4h14v6.8a7 7 0 0 1-14 0z"/><path d="M8.6 8.7h2M13.4 8.7h2"/><path d="M9 13.2c1.8 1.6 4.2 1.6 6 0"/>',
  // interface
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.6v.1" stroke-width="2.6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cross: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bolt: '<path d="M13 3L5.5 13.5H12L11 21l7.5-10.5H12z"/>',
  layers: '<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M3.5 12l8.5 4.5 8.5-4.5"/><path d="M3.5 16l8.5 4.5 8.5-4.5"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5"/><circle cx="16.5" cy="9.5" r="2.6"/><path d="M15.6 14.6c2.6-.3 4.6 1.2 5 4.4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  shuffle: '<path d="M3.5 7h3c4 0 6 10 10 10h4"/><path d="M3.5 17h3c1.6 0 2.9-1.6 4-3.6M13.5 10.6c1.1-2 2.4-3.6 4-3.6h3"/><path d="M18 4.5L20.5 7 18 9.5M18 14.5l2.5 2.5-2.5 2.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.4L3.5 9"/><path d="M3.5 4v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.4l1.9-2.4"/><path d="M20.5 20v-5h-5"/>',
  skip: '<path d="M5 5l8 7-8 7z"/><path d="M17 5v14"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
};
function icon(name, cls) {
  const p = ICONS[name];
  return p ? `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${p}</svg>` : '';
}

// 12-bar signature: up = right pole, down = left pole; grouped by block
function glyph(a, opt) {
  opt = opt || {};
  const bw = opt.bw || 5, gap = opt.gap || 2, gg = opt.gg || 6, h = opt.h || 30, mid = h / 2, amp = mid - 1.5;
  let x = 0, bars = '';
  AXES.forEach((ax, k) => {
    if (k && k % 3 === 0) x += gg - gap;
    const d = (a[k] - 50) / 50, len = Math.max(1, Math.abs(d) * amp);
    const y = d >= 0 ? mid - len : mid;
    bars += `<rect class="g-${ax.b}" x="${x}" y="${y.toFixed(1)}" width="${bw}" height="${len.toFixed(1)}"/>`;
    x += bw + gap;
  });
  const w = x - gap;
  const label = AXES.map((ax, k) => `${ax.n} ${a[k] < 50 ? ax.L : ax.R} ${Math.round(Math.max(a[k], 100 - a[k]))}`).join(', ');
  return `<svg class="glyph ${opt.cls || ''}" viewBox="0 0 ${w} ${h}" width="${opt.w || w}" height="${opt.hh || h}" role="img" aria-label="${esc(label)}"><line x1="0" x2="${w}" y1="${mid}" y2="${mid}"/>${bars}</svg>`;
}


// one axis row. p = main position; o = { margin, star, other (second marker), otherLabel, facet }
function axisRow(k, p, o) {
  o = o || {};
  const ax = AXES[k], s = E.strength(p), side = p < 50 ? ax.L : ax.R;
  const r = Math.round(p), l = 100 - r;   // the two always add up to 100
  const lo = Math.min(p, 50), hi = Math.max(p, 50);
  const band = o.margin ? `<i class="band" style="left:${Math.max(0, p - o.margin)}%;width:${Math.min(100, p + o.margin) - Math.max(0, p - o.margin)}%"></i>` : '';
  const other = o.other != null ? `<i class="dot2" style="left:${o.other}%" title="${esc(o.otherLabel || '')}: ${Math.round(o.other)}"></i>` : '';
  return `<div class="axrow b-${ax.b}${o.star ? ' starred' : ''}">
    <div class="ax-name"><span class="ax-no">${pad2(k + 1)}</span><span class="ax-ic">${icon(ax.k)}</span><b>${esc(ax.n)}</b>${o.star ? '<span class="ax-star" title="You marked questions here as important">★</span>' : ''}
      <button class="ax-help" type="button" aria-label="What ${esc(ax.n)} measures" data-help="${k}">?</button></div>
    <div class="ax-pole L${p < 50 ? ' on' : ''}"><span>${esc(ax.L)}</span><b class="num">${l}</b></div>
    <div class="ax-track" aria-hidden="true"><i class="mid"></i><i class="fill" style="left:${lo}%;width:${hi - lo}%"></i>${band}${other}<i class="dot" style="left:${p}%"></i></div>
    <div class="ax-pole R${p > 50 ? ' on' : ''}"><b class="num">${r}</b><span>${esc(ax.R)}</span></div>
    <div class="ax-tag">${s === 'Balanced' ? 'Balanced' : `${s} · ${esc(side)}`}${o.margin ? `<small>±${o.margin}</small>` : ''}</div>
    ${o.facet ? `<p class="ax-facet">${o.facet}</p>` : ''}
  </div>`;
}

function axisTable(a, o) {
  o = o || {};
  return BLOCKS.map((b, bi) => `<div class="axblock b-${b.k}">
      <div class="axblock-head"><span class="blk-name">${icon(b.k)}${esc(b.n)}</span><span class="blk-poles"><span>${esc(b.L)}</span><span>${esc(b.R)}</span></span></div>
      ${E.BLOCK_AXES[bi].map(k => axisRow(k, a[k], {
        margin: o.margin ? o.margin[k] : 0, star: o.sal ? o.sal[k] > 0 : false,
        other: o.other ? o.other[k] : null, otherLabel: o.otherLabel, facet: o.facets ? o.facets[k] : '' })).join('')}
    </div>`).join('');
}

function secHead(no, title, sub, id, ic) {
  return `<header class="sec-head"${id ? ` id="${id}"` : ''}><span class="sec-no">${ic ? icon(ic) : ''}${pad2(no)}</span><div><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ''}</div></header>`;
}

function card(e, kind, m, o) {
  o = o || {};
  const tag = o.tag ? `<span class="c-tag">${esc(o.tag)}</span>` : '';
  const sub = kind === 'ideology' && o.tag && FAM[e.f] && o.tag === FAM[e.f].n ? (e.y || '') : subLabel(e, kind);
  return `<a class="card ${o.cls || ''}${kind === 'ideology' ? ' nopic' : ''}" href="${hrefOf(e, kind)}">
    ${kind === 'ideology' ? '' : Pics.html(e, kind, 'c-pic')}
    <span class="c-body">${tag}<b class="c-name">${esc(e.n)}</b><span class="c-sub">${esc(sub)}</span></span>
    ${m != null ? `<span class="c-m num">${Math.round(m)}<small>%</small></span>` : ''}
  </a>`;
}

function bigCard(e, kind, m, label, extra) {
  let pic = '';
  if (kind === 'ideology') { const k = e.k && BY.get(e.k); if (k) pic = Pics.html(k.e, 'person', 'bc-pic'); }
  else pic = Pics.html(e, kind, 'bc-pic');
  return `<a class="bigcard${pic ? '' : ' nopic'}" href="${hrefOf(e, kind)}">
    ${pic}
    <span class="bc-body"><span class="kicker">${esc(label)}</span><b class="bc-name">${esc(e.n)}</b>
      <span class="bc-sub">${esc(subLabel(e, kind))}</span>${e.d ? `<span class="bc-d">${esc(e.d)}</span>` : ''}${extra || ''}</span>
    ${m != null ? `<span class="bc-m num">${Math.round(m)}<small>%</small></span>` : ''}
  </a>`;
}

function rowItem(e, kind, m) {
  return `<a class="rowitem" href="${hrefOf(e, kind)}"><span><b>${esc(e.n)}</b><small>${esc(subLabel(e, kind))}</small></span>${glyph(e.a, { cls: 'sm' })}<span class="num">${Math.round(m)}%</span></a>`;
}

// a full "closest X" block for a target set
function closestBlock(P, user, list, kind, o) {
  o = o || {};
  if (!list.length) return `<p class="muted">Nothing here yet.</p>`;
  const r = E.rank(P, list, user, { skip: o.skip });
  if (!r.length) return '';
  const top = r[0];
  const byBlock = E.blockPicks(P, list, user, { skip: o.skip, exclude: [top.e.id] })
    .map((x, bi) => x ? card(x.e, kind, x.m, { tag: 'On ' + BLOCKS[bi].n.toLowerCase(), cls: 'b-' + BLOCKS[bi].k }) : '').join('');
  const far = r.slice(-3).reverse().map(x => `<a href="${hrefOf(x.e, kind)}">${esc(x.e.n)}<b class="num">${Math.round(x.m)}%</b></a>`).join('');
  return `${bigCard(top.e, kind, top.m, o.topLabel || 'Closest match')}
    <h3 class="sub-h">Closest on each part of the map</h3>
    <div class="grid g4 picks">${byBlock}</div>
    <p class="distant"><span>Most distant</span>${far}</p>`;
}

function apartBlock(E2, kind, who, self) {
  const st = STATS[kind]; if (!st) return '';
  const ap = E.apart(E2, st, self), u = ap.unusual, t = ap.typical;
  const cnt = KINDS[kind].list.length;
  const sideTxt = row => {
    const ax = AXES[row.k];
    if (row.x < row.med) return `further toward <b>${esc(ax.L)}</b> than ${row.pctL}% of the ${cnt} ${esc(KINDS[kind].plural.toLowerCase())}`;
    if (row.x > row.med) return `further toward <b>${esc(ax.R)}</b> than ${row.pctR}% of the ${cnt} ${esc(KINDS[kind].plural.toLowerCase())}`;
    return `right at the middle of the ${cnt} ${esc(KINDS[kind].plural.toLowerCase())}`;
  };
  const mini = row => `<div class="mini-track b-${AXES[row.k].b}"><i class="mid"></i><i class="med" style="left:${row.med}%" title="Median ${row.med}"></i><i class="dot" style="left:${row.x}%"></i>
    <span class="mt-l">${esc(AXES[row.k].L)}</span><span class="mt-r">${esc(AXES[row.k].R)}</span></div>`;
  return `<div class="apart">
    <div class="ap-cell"><span class="kicker">Most unusual position</span><h3>${esc(AXES[u.k].n)}</h3>${mini(u)}<p>${esc(who)} ${who === 'You' ? 'sit' : 'sits'} ${sideTxt(u)}.</p></div>
    <div class="ap-cell"><span class="kicker">Most common position</span><h3>${esc(AXES[t.k].n)}</h3>${mini(t)}<p>${esc(who)} ${who === 'You' ? 'sit' : 'sits'} close to the middle of the catalogue here (median ${t.med}).</p></div>
  </div>`;
}

function tabs(id, items, active) {
  return `<div class="tabs" role="tablist" data-tabs="${id}">${items.map(([k, label]) =>
    `<button role="tab" type="button" data-tab="${k}" aria-selected="${k === active}">${esc(label)}</button>`).join('')}</div>`;
}

/* ── glossary: wrap the first use of each defined term; a floating tip shows the definition on hover ── */
const GL = (() => {
  const forms = [];
  GLOSSARY.forEach((g, i) => g.k.forEach(f => forms.push([f, i])));
  forms.sort((a, b) => b[0].length - a[0].length);
  const re = new RegExp('\\b(' + forms.map(f => f[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'gi');
  return { re, idx: new Map(forms.map(([f, i]) => [f.toLowerCase(), i])) };
})();
function gloss(text, used) {
  return esc(text).replace(GL.re, m => {
    const i = GL.idx.get(m.toLowerCase());
    if (i == null || used.has(i)) return m;
    used.add(i);
    return `<span class="gl" data-g="${i}">${m}</span>`;
  });
}
const GlTip = (() => {
  let tip = null, cur = null;
  function show(el) {
    if (!tip) { tip = document.createElement('div'); tip.className = 'gl-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    const g = GLOSSARY[+el.dataset.g]; if (!g) return;
    cur = el;
    tip.innerHTML = `<b>${esc(g.k[0])}</b>${esc(g.d)}`;
    tip.style.display = 'block';
    const r = el.getBoundingClientRect(), w = Math.min(300, window.innerWidth - 24);
    tip.style.width = w + 'px';
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2));
    const h = tip.offsetHeight, above = r.top - h - 10;
    tip.style.left = left + 'px';
    tip.style.top = (above > 8 ? above : r.bottom + 10) + window.scrollY + 'px';
  }
  function hide() { if (tip) tip.style.display = 'none'; cur = null; }
  document.addEventListener('mouseover', e => { const el = e.target.closest && e.target.closest('.gl'); if (el) show(el); else if (cur) hide(); });
  document.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('hashchange', hide);
  return { show, hide };
})();

/* ── the classic two-axis compass, derived from the twelve axes ──
   economic: Ownership 55% + Welfare 45%; social: Rule 40% + Liberty 40% + Morality 20% (authoritarian = up) */
function compassXY(a) {
  const I = E.AXI;
  return { x: 0.55 * a[I.ow] + 0.45 * a[I.we], y: 0.4 * a[I.ru] + 0.4 * a[I.li] + 0.2 * a[I.mo] };
}
const COMPASS_REFS = ['karl-marx', 'joseph-stalin', 'mao-zedong', 'peter-kropotkin', 'mahatma-gandhi', 'olof-palme', 'barack-obama',
  'margaret-thatcher', 'friedrich-hayek', 'ayn-rand', 'murray-rothbard', 'adolf-hitler', 'augusto-pinochet', 'vladimir-putin', 'bernie-sanders', 'donald-trump'];
function compassQuad(c) {
  return (c.y >= 50 ? 'Authoritarian' : 'Libertarian') + ' ' + (c.x < 50 ? 'left' : 'right');
}
const cfmt = v => { const s = ((v - 50) / 5).toFixed(1); return s === '-0.0' ? '0.0' : (v > 50 ? '+' : '') + s; };
// marks: [{a, label, kind: 'you'|'top'|'ref', href}]. Labels are placed to avoid each other; a reference label that can't fit is dropped (its dot keeps a tooltip).
function compassSVG(marks, aria) {
  const SZ = { you: 4, top: 3, ref: 2.7 }, R = { you: 2.4, top: 1.7, ref: 1.05 };
  const pts = marks.map(m => { const c = compassXY(m.a); return { m, x: c.x, y: 100 - c.y }; });
  const boxes = pts.map(p => ({ x1: p.x - R[p.m.kind], y1: p.y - R[p.m.kind], x2: p.x + R[p.m.kind], y2: p.y + R[p.m.kind] }));
  const hit = b => boxes.some(o => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
  const order = ['you', 'top', 'ref'];
  const labels = new Map();
  order.forEach(k => pts.filter(p => p.m.kind === k).forEach(p => {
    const fs = SZ[k], w = p.m.label.length * fs * 0.56, h = fs * 1.05, gap = R[k] + 0.9;
    const tries = [['start', p.x + gap, p.y + fs * 0.35], ['end', p.x - gap, p.y + fs * 0.35],
      ['middle', p.x, p.y - gap - fs * 0.15], ['middle', p.x, p.y + gap + fs * 0.85]];
    for (const [anchor, tx, ty] of tries) {
      const x1 = anchor === 'start' ? tx : anchor === 'end' ? tx - w : tx - w / 2;
      const b = { x1, y1: ty - fs * 0.85, x2: x1 + w, y2: ty - fs * 0.85 + h };
      if (b.x1 < -1 || b.x2 > 101 || b.y1 < -1 || b.y2 > 101) continue;
      if (!hit(b)) { boxes.push(b); labels.set(p, { anchor, tx, ty }); return; }
    }
    if (k !== 'ref') { const [anchor, tx, ty] = p.x < 70 ? tries[0] : tries[1]; labels.set(p, { anchor, tx, ty }); }
  }));
  let grid = '';
  for (let i = 10; i < 100; i += 10) grid += `<line class="cp-grid" x1="${i}" y1="0" x2="${i}" y2="100"/><line class="cp-grid" x1="0" y1="${i}" x2="100" y2="${i}"/>`;
  const body = order.map(k => pts.filter(p => p.m.kind === k).map(p => {
    const lab = esc(p.m.label), L = labels.get(p);
    const dot = `<circle class="cp-${k}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${R[k]}"/>`;
    const text = L ? `<text class="cp-t ${k}" x="${L.tx.toFixed(1)}" y="${L.ty.toFixed(1)}" text-anchor="${L.anchor}">${lab}</text>` : '';
    const g = `<g class="cp-m"><title>${esc(p.m.title || p.m.label)}</title>${dot}${text}</g>`;
    return p.m.href ? `<a href="${p.m.href}">${g}</a>` : g;
  }).join('')).join('');
  return `<svg class="compass" viewBox="-15 -8 130 116" role="group" aria-label="${esc(aria)}">
    <rect class="cp-q al" x="0" y="0" width="50" height="50"/><rect class="cp-q ar" x="50" y="0" width="50" height="50"/>
    <rect class="cp-q ll" x="0" y="50" width="50" height="50"/><rect class="cp-q lr" x="50" y="50" width="50" height="50"/>
    ${grid}<rect class="cp-frame" x="0" y="0" width="100" height="100"/>
    <line class="cp-axis" x1="50" y1="0" x2="50" y2="100"/><line class="cp-axis" x1="0" y1="50" x2="100" y2="50"/>
    <text class="cp-lab" x="50" y="-2.6" text-anchor="middle">Authoritarian</text>
    <text class="cp-lab" x="50" y="105.6" text-anchor="middle">Libertarian</text>
    <text class="cp-lab" x="-2" y="51.2" text-anchor="end">Left</text>
    <text class="cp-lab" x="102" y="51.2" text-anchor="start">Right</text>
    ${body}
  </svg>`;
}
const SHORT = { 'mao-zedong': 'Mao', 'karl-marx': 'Marx', 'mahatma-gandhi': 'Gandhi', 'barack-obama': 'Obama', 'donald-trump': 'Trump' };
// a full compass block: the chart plus a short reading
function compassBlock(a, who, tops, skip) {
  const c = compassXY(a), refs = COMPASS_REFS.map(id => BY.get(id)).filter(Boolean).filter(r => r.e.id !== skip && !tops.some(t => t.e.id === r.e.id));
  const marks = [
    ...refs.map(r => ({ a: r.e.a, label: SHORT[r.e.id] || r.e.n.split(' ').slice(-1)[0], title: r.e.n, kind: 'ref', href: hrefOf(r.e, r.kind) })),
    ...tops.map(t => ({ a: t.e.a, label: t.e.n.replace(/\s*\(.*\)$/, ''), title: t.e.n, kind: 'top', href: hrefOf(t.e, t.kind) })),
    { a, label: who, kind: 'you' },
  ];
  const near = E.rank(a, PEOPLE, null, { skip, axes: [E.AXI.ow, E.AXI.we, E.AXI.ru, E.AXI.li, E.AXI.mo] }).slice(0, 3);
  return `<div class="cp-wrap">
    <div class="cp-chart">${compassSVG(marks, `${who} on the classic compass: economic ${cfmt(c.x)}, social ${cfmt(c.y)}`)}</div>
    <div class="cp-read">
      <p class="cp-q-name">${esc(compassQuad(c))}</p>
      <div class="cp-nums"><div><span class="kicker">Economic</span><b class="num">${cfmt(c.x)}</b><small>left −10 · right +10</small></div>
        <div><span class="kicker">Social</span><b class="num">${cfmt(c.y)}</b><small>libertarian −10 · authoritarian +10</small></div></div>
      <p class="fine">The familiar two-axis compass, worked out from the twelve axes: economic left–right from Ownership and Welfare, authoritarian–libertarian from Rule, Liberty and Morality. It leaves out the other seven axes, so two people in the same spot can still differ a lot.</p>
      <p class="fine">Closest people on these five axes: ${near.map(x => `<a class="link" href="${hrefOf(x.e, 'person')}">${esc(x.e.n)}</a>`).join(', ')}.</p>
    </div>
  </div>`;
}

/* ── Drawings and graphs ─────────────────────────────────────────────────────────────────────────
   Small line drawings for the two poles of every axis, and the graphs used on the result, home, axes
   and method pages. Everything is drawn here as SVG, so there are no picture files to keep track of.

   A drawing is the inside of a 64 × 64 SVG. Lines take the text colour; shapes with class "a" are tinted
   with the colour of the axis's block (--bc); shapes with class "f" are filled with the text colour. ── */
const POLE_ART = {
  // Structure: three equal centres linked to each other · one centre with everything attached to it
  st: ['<path d="M28.7 22.2 19.3 39.8M35.3 22.2l9.4 17.6M23 46h18"/><circle class="a" cx="32" cy="16" r="7"/><circle class="a" cx="16" cy="46" r="7"/><circle class="a" cx="48" cy="46" r="7"/>',
       '<path d="M24.9 24.9 15 15M39.1 24.9 49 15M24.9 39.1 15 49M39.1 39.1 49 49"/><circle class="a" cx="32" cy="32" r="10"/><circle cx="12" cy="12" r="4"/><circle cx="52" cy="12" r="4"/><circle cx="12" cy="52" r="4"/><circle cx="52" cy="52" r="4"/>'],
  // Rule: a ballot going into the box · a crown
  ru: ['<rect class="a" x="12" y="30" width="40" height="24" rx="3"/><path d="M26 30V10h12v20M29.5 18l2.5 2.5 4-5"/><path d="M22 30h20" stroke-width="3.4"/>',
       '<path class="a" d="M12 46V22l10 10 10-16 10 16 10-10v24z"/><path d="M12 53h40"/><circle class="f" cx="32" cy="38" r="2.4"/>'],
  // Liberty: an open padlock · a shield with a watching eye
  li: ['<path d="M24 30V19a8 8 0 0 1 16-1"/><rect class="a" x="16" y="30" width="32" height="24" rx="4"/><circle class="f" cx="32" cy="42" r="2.6"/>',
       '<path class="a" d="M32 8 52 15v15c0 13-8 21-20 26-12-5-20-13-20-26V15z"/><path d="M22 30c3-5 7-7 10-7s7 2 10 7c-3 5-7 7-10 7s-7-2-10-7z"/><circle class="f" cx="32" cy="30" r="2.6"/>'],
  // Migration: an open gateway · a wall
  mi: ['<path class="a" d="M12 54V27C12 16 21 9 32 9s20 7 20 18v27h-9V28c0-6-5-10-11-10s-11 4-11 10v26z"/><path d="M32 54V34m-6 6 6-6 6 6"/>',
       '<rect class="a" x="10" y="16" width="44" height="34" rx="2"/><path d="M10 27h44M10 39h44M26 16v11M42 16v11M18 27v12M34 27v12M48 27v12M26 39v11M42 39v11"/>'],
  // Nation: the globe · a flag
  na: ['<circle class="a" cx="32" cy="32" r="22"/><path d="M10 32h44M32 10c-13 8-13 36 0 44M32 10c13 8 13 36 0 44M14.5 19h35M14.5 45h35"/>',
       '<path d="M16 8v50"/><path class="a" d="M16 12h34l-7 10 7 10H16z"/>'],
  // Force: the peace sign · crossed swords
  fo: ['<circle class="a" cx="32" cy="32" r="22"/><path d="M32 10v44M32 32 16.5 47.500M32 32l15.5 15.5"/>',
       '<path d="M14 50 50 12M50 50 14 12" stroke-width="3"/><path d="m17 37 10 10M47 37 37 47"/><circle class="a" cx="12.5" cy="51.5" r="3"/><circle class="a" cx="51.5" cy="51.5" r="3"/>'],
  // Ownership: a works flying a common flag · a key
  ow: ['<path class="a" d="M8 54V34l14-8v8l14-8v8l14-8v28z"/><path d="M50 26V8M27 54V44h8v10"/><path class="a" d="M50 8H39v8h11"/>',
       '<circle class="a" cx="20" cy="32" r="12"/><circle cx="20" cy="32" r="3.5"/><path d="M32 32h25M48 32v8M56 32v6"/>'],
  // Welfare: level scales · a ladder to climb yourself
  we: ['<path d="M32 12v40M21 53h22M12 20h40M12 20 6 36M12 20l6 16M52 20l-6 16M52 20l6 16"/><path class="a" d="M4 36h16a8 8 0 0 1-16 0zM44 36h16a8 8 0 0 1-16 0z"/>',
       '<path d="M21 58 26 18M43 58 38 18M22.3 47h19.400M23.6 37h16.800M24.9 27h14.2"/><path class="a" d="m32 2 2.3 4.7 5.2.7-3.8 3.6.9 5.100L32 13.700l-4.6 2.4.9-5.1-3.8-3.6 5.2-.700z"/>'],
  // Trade: a wall that stops goods at the border · a ship stacked with containers
  tr: ['<rect class="a" x="34" y="10" width="9" height="44" rx="1.5"/><rect x="9" y="34" width="18" height="18" rx="1.5"/><path d="M9 34l18 18M27 34 9 52M60 28H49m5-5-5 5 5 5"/>',
       '<path class="a" d="M5 40h54l-7 12H12z"/><path d="M14 28h11v12H14zM27 28h11v12H27zM40 28h11v12H40zM27 16h11v12H27zM5 58c4-3 6-3 9 0s6 3 9 0 6-3 9 0 6 3 9 0 6-3 9 0 6 3 9 0"/>'],
  // Religion: a civic hall · a domed house of worship
  re: ['<path class="a" d="M8 26 32 10l24 16z"/><path d="M10 31h44M15 31v19M26 31v19M38 31v19M49 31v19M8 54h48"/>',
       '<path class="a" d="M14 34a18 18 0 0 1 36 0z"/><path d="M14 34v20M50 34v20M9 54h46M27 54V45a5 5 0 0 1 10 0v9M32 16V9"/><circle class="f" cx="32" cy="7" r="2.2"/>'],
  // Morality: a new shoot · an old tree with deep roots
  mo: ['<path d="M12 54h40M32 54V28"/><path class="a" d="M32 36c-2-10-10-14-19-13 0 9 8 15 19 13zM32 28c1-10 8-15 18-15 0 10-7 16-18 15z"/>',
       '<circle class="a" cx="32" cy="21" r="15"/><path d="M32 36v10M9 46h46M32 46c0 6-6 7-13 11M32 46c0 6 6 7 13 11M32 46v12"/>'],
  // Technology: a rocket · a leaf kept under a sheltering arc
  te: ['<path class="a" d="M32 5c9 8 11 21 8 35H24c-3-14-1-27 8-35z"/><circle cx="32" cy="21" r="4"/><path d="M24.5 31 16 42l9-2M39.5 31 48 42l-9-2M28 45c0 5 2 9 4 13 2-4 4-8 4-13"/>',
       '<path d="M7 38a25 25 0 0 1 50 0"/><path class="a" d="M21 56c0-13 8-21 23-23 0 15-8 23-23 23z"/><path d="M21 56c6-9 12-13 18-17"/>'],
};
/* Three drawings for "How it works" on the home page: the seven-step answer scale, a starred statement, a fresh set of cards. */
const STEP_ART = [
  '<circle class="no" cx="6" cy="32" r="5"/><circle class="no" cx="16.6" cy="32" r="4"/><circle class="no" cx="25.2" cy="32" r="3"/><circle cx="32" cy="32" r="2.2"/><circle class="yes" cx="38.8" cy="32" r="3"/><circle class="yes on" cx="47.4" cy="32" r="4"/><circle class="yes" cx="58" cy="32" r="5"/><path d="M47.4 20v-7m-3 3 3-3 3 3"/>',
  '<rect class="a" x="8" y="16" width="48" height="36" rx="5"/><path d="M16 30h20M16 40h30"/><path class="f" d="m46 6 3.1 6.4 7 .9-5.1 4.9 1.3 7L46 21.8l-6.3 3.4 1.3-7-5.1-4.9 7-.9z"/>',
  '<rect x="10" y="20" width="30" height="36" rx="4" transform="rotate(-10 25 38)"/><rect class="a" x="24" y="18" width="30" height="36" rx="4"/><path d="M31 30h16M31 38h11M44 10a9 9 0 0 0-15-3m0-5v5h5"/>',
];
function stepArt(i) { return `<svg class="art step-art" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${STEP_ART[i]}</svg>`; }

/* poleArt('ow', 0) → the drawing for the left-hand pole of Ownership (1 = the right-hand pole) */
function poleArt(k, side, cls) {
  const art = POLE_ART[k] && POLE_ART[k][side];
  return art ? `<svg class="art ${cls || ''}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${art}</svg>` : '';
}

/* ── graphs ─────────────────────────────────────────────────────────────────────────────────────── */

/* One small label that follows the pointer over any mark carrying data-tip="…" (works on every page). */
(() => {
  let el = null;
  const hide = () => { if (el) el.hidden = true; };
  const show = (text, x, y) => {
    if (!el) { el = document.createElement('div'); el.className = 'figtip'; el.setAttribute('role', 'tooltip'); document.body.appendChild(el); }
    el.textContent = text; el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, x - w / 2)) + 'px';
    el.style.top = (y - h - 14 < 6 ? y + 18 : y - h - 14) + 'px';
  };
  const over = e => { const m = e.target.closest ? e.target.closest('[data-tip]') : null; if (m) show(m.dataset.tip, e.clientX, e.clientY); else hide(); };
  document.addEventListener('pointermove', over, { passive: true });
  document.addEventListener('pointerdown', over, { passive: true });
  document.addEventListener('scroll', hide, { passive: true, capture: true });
  window.addEventListener('hashchange', hide);
  // a dot in a graph opens the entry it stands for (the same entries are reachable by keyboard from the lists)
  document.addEventListener('click', e => { const g = e.target.closest ? e.target.closest('[data-go]') : null; if (g) location.hash = g.dataset.go.replace(/^#/, ''); });
})();

const leanOf = (k, v) => `${v < 50 ? AXES[k].L : AXES[k].R} ${Math.round(Math.max(v, 100 - v))}`;

/* How the answers were spread over the seven steps of the scale. */
function answersFig(R, mine) {
  const cnt = [0, 0, 0, 0, 0, 0, 0]; let n = 0;
  Object.values(R.answers).forEach(a => { if (typeof a === 'number') { cnt[a + 3]++; n++; } });
  if (!n) return '';
  const names = ['Strongly disagree', 'Disagree', 'Slightly disagree', 'Neutral', 'Slightly agree', 'Agree', 'Strongly agree'];
  const agree = cnt[4] + cnt[5] + cnt[6], dis = cnt[0] + cnt[1] + cnt[2], strong = cnt[0] + cnt[6], stars = R.stars ? R.stars.size : 0;
  const you = mine ? 'You' : 'This person';
  return `<figure class="fig answers">
    <div class="an-bar" role="img" aria-label="${esc(names.map((t, i) => `${t}: ${cnt[i]}`).join(', '))}">${cnt.map((c, i) => c ? `<i class="an-${i}" style="flex:${c}" data-tip="${esc(names[i])}: ${c}">${c / n > 0.055 ? c : ''}</i>` : '').join('')}</div>
    <div class="an-ends" aria-hidden="true"><span>Strongly disagree</span><span>Neutral</span><span>Strongly agree</span></div>
    <figcaption><span class="fig-note">${you} agreed with <b>${agree}</b> of the ${n} statements, disagreed with <b>${dis}</b> and stayed neutral on <b>${cnt[3]}</b>. ${strong} of the answers were at the far ends of the scale${stars ? `, and ${stars} ${stars === 1 ? 'statement was' : 'statements were'} starred` : ''}.</span></figcaption>
  </figure>`;
}

/* Where the ideologies of the catalogue stand on one axis, in twenty steps of five points, with your own position if you have a result. */
function axisHist(k, me) {
  const bins = new Array(20).fill(0);
  IDEOLOGIES.forEach(e => { bins[Math.min(19, Math.floor(e.a[k] / 5))]++; });
  const mx = Math.max(...bins), ax = AXES[k];
  return `<figure class="fig ahist">
    <div class="ah-plot">
      <div class="ah-bars" role="img" aria-label="${esc(`How the ${IDEOLOGIES.length} ideologies are spread along ${ax.n}, from ${ax.L} on the left to ${ax.R} on the right.`)}">${bins.map((c, i) => `<i style="height:${(100 * c / mx).toFixed(0)}%" data-tip="${i * 5}–${i * 5 + 5}: ${c} ${c === 1 ? 'ideology' : 'ideologies'}"></i>`).join('')}</div>
      ${me != null ? `<span class="ah-you" style="left:${me.toFixed(1)}%" data-tip="Your position: ${esc(leanOf(k, me))}"><b>You</b></span>` : ''}
    </div>
    <div class="ah-ends" aria-hidden="true"><span>0 · ${esc(ax.L)}</span><span>50</span><span>${esc(ax.R)} · 100</span></div>
    <figcaption><span class="fig-note">Where the ${IDEOLOGIES.length} ideologies in the catalogue stand on this axis.</span></figcaption>
  </figure>`;
}

/* A small line chart. series: [{ name, cls, pts: [[x, y]…], label: [x, y, text], dash }] in data units. */
function lineFig(o) {
  const W = 560, H = 270, L = 52, Rm = 16, T = 14, B = 44, pw = W - L - Rm, ph = H - T - B;
  const X = v => L + pw * (v - o.x[0]) / (o.x[1] - o.x[0]), Y = v => T + ph * (1 - (v - o.y[0]) / (o.y[1] - o.y[0]));
  const grid = o.yt.map(([v, t]) => `<line class="lf-grid${v === (o.zero || 0) && o.zero !== undefined ? ' zero' : ''}" x1="${L}" x2="${W - Rm}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="lf-t" x="${L - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${esc(t)}</text>`).join('');
  const xt = o.xt.map(v => `<text class="lf-t" x="${X(v).toFixed(1)}" y="${H - B + 18}" text-anchor="middle">${v}</text>`).join('');
  const lines = o.series.map(s => `<path class="lf-line ${s.cls}" d="M${s.pts.map(p => X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('L')}"/>` +
    (s.marks || []).map(m => `<circle class="lf-mark ${s.cls}" cx="${X(m[0]).toFixed(1)}" cy="${Y(m[1]).toFixed(1)}" r="5" data-tip="${esc(m[2])}"/>`).join('') +
    (s.label ? `<text class="lf-lab" x="${X(s.label[0]).toFixed(1)}" y="${Y(s.label[1]).toFixed(1)}" text-anchor="${s.label[3] || 'start'}">${esc(s.label[2])}</text>` : '')).join('');
  // an invisible strip per x step, so pointing anywhere over the plot reads off the values there
  const strips = o.read ? o.read.map(([x0, x1, tip]) => `<rect class="lf-hit" x="${X(x0).toFixed(1)}" y="${T}" width="${(X(x1) - X(x0)).toFixed(1)}" height="${ph}" data-tip="${esc(tip)}"/>`).join('') : '';
  return `<figure class="fig linefig">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria)}">${grid}${xt}
      <text class="lf-ax" x="${L + pw / 2}" y="${H - 6}" text-anchor="middle">${esc(o.xl)}</text>${lines}${strips}</svg>
    <figcaption>${o.series.length > 1 ? o.series.map(s => `<span class="lg"><i class="lg-line ${s.cls}"></i>${esc(s.name)}</span>`).join('') : ''}<span class="fig-note">${o.note}</span></figcaption>
  </figure>`;
}
/* Method page: how a statement's neutral point shapes the expected answer, and how a gap turns into a match. */
function methodCurves() {
  const mild = QUESTIONS.find(q => q.id === 'te6'), hard = QUESTIONS.find(q => q.id === 'te37'); if (!mild || !hard) return '';
  const bm = E.locOf(mild), bh = E.locOf(hard), xs = []; for (let t = 0; t <= 100; t += 2) xs.push(t);
  const say = v => (v > 2.5 ? 'strongly agree' : v > 1.5 ? 'agree' : v > 0.5 ? 'slightly agree' : v > -0.5 ? 'neutral' : v > -1.5 ? 'slightly disagree' : v > -2.5 ? 'disagree' : 'strongly disagree');
  return lineFig({
    x: [0, 100], y: [-3.2, 3.2], zero: 0, xt: [0, 25, 50, 75, 100], yt: [[3, 'Strongly agree'], [0, 'Neutral'], [-3, 'Strongly disagree']].map(([v, t]) => [v, t.replace('Strongly ', 'Str. ')]),
    xl: 'Position on Technology: 0 = Technology, 100 = Precaution',
    aria: `Line chart of the answer expected from a person at each position on the Technology axis, for a mild statement with its neutral point at ${bm} and a radical one with its neutral point at ${bh}.`,
    series: [
      { name: `“Some forests should never be cut down” (neutral point ${bm})`, cls: 's1', pts: xs.map(t => [t, E.expect(t, 1, bm)]), marks: [[bm, 0, `Neutral point ${bm}`]] },
      { name: `“The Internet should be banned” (neutral point ${bh})`, cls: 's2', pts: xs.map(t => [t, E.expect(t, 1, bh)]), marks: [[bh, 0, `Neutral point ${bh}`]] },
    ],
    read: xs.filter(t => t % 4 === 0 && t < 100).map(t => [t, t + 4, `At ${t + 2}: forests → ${say(E.expect(t + 2, 1, bm))}; Internet ban → ${say(E.expect(t + 2, 1, bh))}`]),
    note: 'Both statements point toward Precaution. Almost everyone but the far Technology end agrees with the first, so agreeing says little and disagreeing says a lot; with the second it is the other way round.',
  });
}
function matchCurve() {
  const base = AXES.map(() => 20), at = g => E.match(base, base.map(v => v + g)), gs = []; for (let g = 0; g <= 60; g += 2) gs.push(g);
  return lineFig({
    x: [0, 60], y: [30, 102], xt: [0, 10, 20, 30, 40, 50, 60], yt: [[100, '100%'], [85, '85%'], [70, '70%'], [55, '55%'], [40, '40%']],
    xl: 'Typical gap between two profiles, in points',
    aria: 'Line chart of the match percentage against the typical gap between two profiles: 100% at no gap, 85% at a gap of 10 points, then falling more gently.',
    series: [{ name: 'Match', cls: 's1', pts: gs.map(g => [g, at(g)]), marks: [[10, at(10), `A typical gap of 10 points gives ${Math.round(at(10))}%`], [30, at(30), `A typical gap of 30 points gives ${Math.round(at(30))}%`]],
      label: [12, at(10) + 5, `${Math.round(at(10))}% at a gap of 10`] }],
    read: gs.filter(g => g < 60).map(g => [g, g + 2, `Gap ${g + 1}: ${Math.round(at(g + 1))}%`]),
    note: 'The line is steep at the top, so close matches are easy to tell apart, and gentler further down.',
  });
}

/* Home page: all the ideologies on the two-axis compass. Picking a family lights up its dots. */
const MAP_LABELS = ['marxism-leninism', 'anarcho-communism', 'social-democracy', 'liberalism', 'conservatism', 'libertarianism', 'fascism', 'anarcho-capitalism', 'green-politics', 'christian-democracy', 'nazism', 'neoliberalism'];
function politicsMap(me) {
  const S = 560, M = 26, P0 = S - 2 * M, X = v => M + P0 * v / 100, Y = v => M + P0 * (100 - v) / 100;
  const pts = IDEOLOGIES.map(e => { const c = compassXY(e.a); return { e, x: X(c.x), y: Y(c.y) }; });
  const boxes = [], labels = [];
  MAP_LABELS.forEach(id => {
    const p = pts.find(q => q.e.id === id); if (!p) return;
    const w = p.e.n.length * 6.3 + 6, left = p.x > S * 0.62, bx = left ? p.x - 9 - w : p.x + 9, box = [bx, p.y - 8, bx + w, p.y + 7];
    if (box[0] < M || box[2] > S - M || boxes.some(b => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) return;
    boxes.push(box); p.lab = true;
    labels.push(`<text class="pm-lab" x="${(left ? p.x - 9 : p.x + 9).toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="${left ? 'end' : 'start'}">${esc(p.e.n)}</text>`);
  });
  const mine = me ? compassXY(me) : null;
  return `<figure class="fig pmap">
    <div class="pm-plot"><svg viewBox="0 0 ${S} ${S}" role="img" aria-label="${esc(`All ${IDEOLOGIES.length} ideologies placed on the two-axis compass: economic left to right across, libertarian to authoritarian upward. The Ideologies page lists them all.`)}">
      <rect class="pm-q q1" x="${M}" y="${M}" width="${P0 / 2}" height="${P0 / 2}"/><rect class="pm-q q2" x="${S / 2}" y="${M}" width="${P0 / 2}" height="${P0 / 2}"/>
      <rect class="pm-q q3" x="${M}" y="${S / 2}" width="${P0 / 2}" height="${P0 / 2}"/><rect class="pm-q q4" x="${S / 2}" y="${S / 2}" width="${P0 / 2}" height="${P0 / 2}"/>
      <path class="pm-ax" d="M${M} ${S / 2}H${S - M}M${S / 2} ${M}V${S - M}"/>
      <text class="pm-end" x="${S / 2}" y="${M - 9}" text-anchor="middle">Authoritarian</text><text class="pm-end" x="${S / 2}" y="${S - 7}" text-anchor="middle">Libertarian</text>
      <text class="pm-end" x="${M - 9}" y="${S / 2}" text-anchor="middle" transform="rotate(-90 ${M - 9} ${S / 2})">Left</text><text class="pm-end" x="${S - M + 9}" y="${S / 2}" text-anchor="middle" transform="rotate(90 ${S - M + 9} ${S / 2})">Right</text>
      ${pts.map(p => `<circle class="pm-d${p.lab ? ' lab' : ''}" data-f="${p.e.f}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.6" data-go="${hrefOf(p.e, 'ideology')}" data-tip="${esc(p.e.n)}"/>`).join('')}
      ${labels.join('')}
      ${mine ? `<circle class="pm-you" cx="${X(mine.x).toFixed(1)}" cy="${Y(mine.y).toFixed(1)}" r="8" data-tip="Your result"/><text class="pm-youl" x="${X(mine.x).toFixed(1)}" y="${(Y(mine.y) - 13).toFixed(1)}" text-anchor="middle">You</text>` : ''}
    </svg></div>
    <div class="pm-side">
      <p class="pm-say" aria-live="polite">Point at a dot for its name, or pick a family to see where it lives.</p>
      <div class="pm-fams">${FAMILIES.map(f => { const n = IDEOLOGIES.filter(e => e.f === f.k).length; return n ? `<button type="button" class="pm-fam" data-fam="${f.k}" data-say="${esc(`${f.n}: ${n} ideologies`)}" aria-pressed="false">${esc(f.n)}</button>` : ''; }).join('')}</div>
    </div>
  </figure>`;
}
/* picking a family on the map: hover or focus previews it, a click keeps it (click again to let go) */
(() => {
  const set = (fig, fam) => {
    fig.classList.toggle('pick', !!fam);
    fig.querySelectorAll('.pm-d').forEach(d => d.classList.toggle('on', d.dataset.f === fam));
    const b = fam && fig.querySelector(`.pm-fam[data-fam="${fam}"]`), say = fig.querySelector('.pm-say');
    if (say) say.textContent = b ? b.dataset.say : 'Point at a dot for its name, or pick a family to see where it lives.';
  };
  const btn = e => (e.target.closest ? e.target.closest('.pm-fam') : null);
  document.addEventListener('click', e => { const b = btn(e); if (!b) return; const fig = b.closest('.pmap'), was = b.getAttribute('aria-pressed') === 'true';
    fig.querySelectorAll('.pm-fam').forEach(x => x.setAttribute('aria-pressed', 'false')); if (!was) b.setAttribute('aria-pressed', 'true');
    fig.dataset.kept = was ? '' : b.dataset.fam; set(fig, fig.dataset.kept); });
  document.addEventListener('pointerover', e => { const b = btn(e); if (b && e.pointerType === 'mouse') set(b.closest('.pmap'), b.dataset.fam); });
  document.addEventListener('pointerout', e => { const b = btn(e); if (b && e.pointerType === 'mouse') { const fig = b.closest('.pmap'); set(fig, fig.dataset.kept || ''); } });
  document.addEventListener('focusin', e => { const b = btn(e); if (b) set(b.closest('.pmap'), b.dataset.fam); });
  document.addEventListener('focusout', e => { const b = btn(e); if (b) { const fig = b.closest('.pmap'); set(fig, fig.dataset.kept || ''); } });
})();

/* ── views: home, catalogue lists, axes guide, method ── */
const view = () => $('#view');
function setTitle(t) { document.title = t ? `${t} — The Agora` : 'The Agora — a twelve-axis political test'; }

/* a short statement from the bank that changes every few seconds under the home headline */
let heroTick = null;
function heroQuestions() {
  const el = $('.hero-q .hq-text'); if (!el) return;
  const pool = QUESTIONS.filter(q => !q.x && q.ax !== 'cr' && q.q.length < 95);
  let i = Math.floor(Math.random() * pool.length);
  const btns = [...document.querySelectorAll('.hq-b')];
  const show = () => { const q = pool[i % pool.length]; el.classList.remove('in'); void el.offsetWidth; el.textContent = q.q; el.classList.add('in'); btns.forEach(b => { b.dataset.id = q.id; }); i += 7; };
  // pause while the visitor is about to answer
  let hold = false; const box = el.closest('.hero-q');
  box.addEventListener('mouseenter', () => { hold = true; }); box.addEventListener('mouseleave', () => { hold = false; });
  box.addEventListener('focusin', () => { hold = true; }); box.addEventListener('focusout', () => { hold = false; });
  show(); clearInterval(heroTick);
  heroTick = setInterval(() => { if (!document.body.contains(el)) return clearInterval(heroTick); if (!hold) show(); }, 5000);
}
/* Example results on the home page: real share images, drawn for famous figures as if they had taken the test,
   fanned out like a hand of cards. The front card moves to the back every few seconds. */
/* a broad pool of well-known figures; each visit shuffles it, so the cards are rarely the same twice */
const EXAMPLES = ['olof-palme', 'margaret-thatcher', 'che-guevara', 'greta-thunberg', 'elon-musk', 'mahatma-gandhi', 'jordan-peterson', 'karl-marx', 'ayn-rand', 'pope-francis', 'vladimir-putin', 'bernie-sanders', 'donald-trump', 'barack-obama', 'nelson-mandela', 'martin-luther-king-jr', 'malcolm-x', 'winston-churchill', 'abraham-lincoln', 'franklin-d-roosevelt', 'mao-zedong', 'vladimir-lenin', 'leon-trotsky', 'fidel-castro', 'simon-bolivar', 'napoleon-bonaparte', 'otto-von-bismarck', 'charles-de-gaulle', 'angela-merkel', 'emmanuel-macron', 'xi-jinping', 'volodymyr-zelensky', 'recep-tayyip-erdogan', 'narendra-modi', 'lee-kuan-yew', 'john-f-kennedy', 'ronald-reagan', 'alexandria-ocasio-cortez', 'kamala-harris', 'javier-milei', 'luiz-inacio-lula-da-silva', 'hugo-chavez', 'noam-chomsky', 'slavoj-zizek', 'friedrich-hayek', 'milton-friedman', 'john-maynard-keynes', 'adam-smith', 'john-stuart-mill', 'jean-jacques-rousseau', 'thomas-hobbes', 'john-locke', 'niccolo-machiavelli', 'plato', 'aristotle', 'confucius', 'friedrich-nietzsche', 'simone-de-beauvoir', 'hannah-arendt', 'george-orwell', 'albert-einstein', 'dalai-lama', 'taylor-swift', 'kanye-west', 'joe-rogan', 'andrew-tate', 'pewdiepie', 'zlatan-ibrahimovic', 'cristiano-ronaldo', 'lebron-james', 'muhammad-ali', 'bob-marley', 'john-lennon', 'stephen-hawking', 'malala-yousafzai', 'jesus', 'buddha', 'astrid-lindgren', 'dag-hammarskjold', 'magdalena-andersson', 'jimmie-akesson', 'ulf-kristersson', 'mark-zuckerberg', 'bill-gates', 'steve-jobs', 'gustav-vasa', 'julius-caesar', 'alexander-the-great', 'elizabeth-ii', 'marie-curie'];
let exTick = null;
async function exampleImage(e) {
  const P = e.a.slice(), u = { answered: E.MODES.full.n };
  const d = { R: { P, u, mode: 'full' }, rk: E.rank(P, IDEOLOGIES, null), people: E.rank(P, PEOPLE, null).slice(0, 4),
    countries: E.rank(P, NATIONS, null).slice(0, 3), regimes: [] };
  d.bg = FAM_BG[d.rk[0].e.f] || '#2b2b30';
  const c = document.createElement('canvas'); c.width = 1080; c.height = 1920;
  const ctx = c.getContext('2d');
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (err) {}
  await drawCard(ctx, 1080, 1920, 'story', ShareCard.help, d);
  try { return c.toDataURL('image/jpeg', 0.86); } catch (err) { return null; }   // a portrait from a host that blocks reuse
}
function examples() {
  const fan = $('.ex-fan'); if (!fan || !window.ShareCard) return;
  const list = EXAMPLES.map(id => BY.get(id)).filter(x => x && x.kind === 'person').map(x => x.e);
  if (!list.length) { fan.closest('.sec').hidden = true; return; }
  for (let k = list.length - 1; k > 0; k--) { const r = Math.floor(Math.random() * (k + 1)); [list[k], list[r]] = [list[r], list[k]]; }
  const cards = list.map((e, k) => { const f = document.createElement('figure'); f.className = 'ex-c'; f.dataset.k = k;
    f.innerHTML = `<div class="ex-ph"><span>${esc(Pics.initials(e.n))}</span></div><figcaption class="sr">${esc(e.n)}</figcaption>`; fan.appendChild(f); return f; });
  const drawn = new Set();
  const draw = async k => { if (drawn.has(k)) return; drawn.add(k);
    const url = await exampleImage(list[k]); if (url) cards[k].innerHTML = `<img src="${url}" alt="Example result for ${esc(list[k].n)}">`; };
  const dots = $('.ex-dots');
  let front = 0, hold = false;
  const place = () => {
    cards.forEach((c, k) => { const pos = (k - front + list.length) % list.length; c.dataset.pos = pos < 3 ? pos : 'hide'; });
    [0, 1, 2].forEach(o => draw((front + o) % list.length));
    if (dots) dots.innerHTML = list.map((e, k) => `<button type="button" class="ex-dot${k === front ? ' on' : ''}" data-ex="${k}" aria-label="${esc(e.n)}"></button>`).join('');
  };
  place();
  fan.addEventListener('mouseenter', () => { hold = true; }); fan.addEventListener('mouseleave', () => { hold = false; });
  fan.addEventListener('click', ev => { const c = ev.target.closest('.ex-c'); if (!c) return;
    const k = +c.dataset.k; if (c.dataset.pos === '0') location.hash = hrefOf(list[k], 'person'); else { front = k; place(); } });
  if (dots) dots.addEventListener('click', ev => { const b = ev.target.closest('[data-ex]'); if (b) { front = +b.dataset.ex; place(); } });
  clearInterval(exTick);
  exTick = setInterval(() => { if (!document.body.contains(fan)) return clearInterval(exTick); if (!hold) { front = (front + 1) % list.length; place(); } }, 6000);
}
function homeView() {
  setTitle('');
  const prog = savedQuiz(), code = store.get('code', null);
  const PM = prog ? E.MODES[prog.mode] : null, answered = prog ? Object.keys(prog.answers || {}).length : 0;
  const per = M => M.adaptive ? 'adapts to your answers' : M.n % 12 ? `${Math.floor(M.n / 12)} or ${Math.ceil(M.n / 12)} per axis` : `${M.n / 12} per axis`;
  const mode = (M, main) => `<a class="mode${main ? ' main' : ''}" href="#/test?m=${M.k}" data-act="restart" data-mode="${M.k}">
      <span class="mode-ic">${icon(M.k === 'quick' ? 'bolt' : 'layers')}</span>
      <span class="mode-t"><b>${esc(M.name)}</b><span>${M.n} statements · ${M.mins} min</span><small>${per(M)}${M.k === 'full' ? ' · the more precise result' : ' · a first look'}</small></span>
      <span class="mode-go" aria-hidden="true">→</span></a>`;
  view().innerHTML = `
  <section class="hero">
    <div class="hero-text">
      <p class="kicker">A twelve-axis political test</p>
      <h1>Find <em>your place</em> on the map of politics.</h1>
      <p class="lede">React to sharp statements, from nuclear power to the monarchy, and see which ideology, famous figure and country think most like you.</p>
      <ul class="hero-stats">
        <li><b class="num">${IDEOLOGIES.length}</b><span>ideologies</span></li>
        <li><b class="num">${fmtN(PEOPLE.length)}</b><span>people</span></li>
        <li><b class="num">${NATIONS.length + REGIMES.length}</b><span>states in history</span></li>
      </ul>
      <div class="hero-q"><span class="hq-tag">Agree or disagree?</span><p class="hq-text"></p>
        <span class="hq-acts"><button type="button" class="hq-b" data-act="seed" data-a="-2">Disagree</button><button type="button" class="hq-b" data-act="seed" data-a="2">Agree</button><small class="muted">and continue in the quick test</small></span></div>
      ${PM && answered ? `<div class="cta">
          <a class="btn primary" href="#/test?m=${PM.k}">Continue the ${esc(PM.name.toLowerCase())} · question ${Math.min(answered + 1, prog.order.length)} of ${prog.order.length}</a>
          <button class="btn ghost" type="button" data-act="restart" data-mode="${PM.k}">Start again</button>
          ${code ? `<a class="btn text" href="#/result">Your last result</a>` : ''}
        </div>
        <p class="fine">Or start a new <a class="link" href="#/test?m=${PM.k === 'full' ? 'quick' : 'full'}" data-act="restart" data-mode="${PM.k === 'full' ? 'quick' : 'full'}">${PM.k === 'full' ? `quick test (${E.MODES.quick.n})` : `full test (${E.MODES.full.n})`}</a> instead. Your answers stay in your browser.</p>`
      : `<div class="modes">${mode(E.MODES.full, true)}${mode(E.MODES.quick, false)}</div>
        <p class="fine bank">${icon('shuffle')}<span>Every attempt draws a new set from a bank of ${QUESTIONS.filter(q => !q.x).length} statements, so taking it again brings new ones. Your answers stay in your browser.${code ? ` <a class="link" href="#/result">Your last result</a>.` : ''}</span></p>`}
    </div>
    <div class="hero-ex">
      <p class="ex-kicker"><i></i>Example result</p>
      <div class="ex-fan"></div>
      <div class="ex-dots"></div>
    </div>
  </section>

  <section class="sec">
    ${secHead(1, 'The twelve axes', 'Four parts of political life, three questions each. On every axis the left-hand pole is the one listed first.')}
    <div class="axgrid">${BLOCKS.map((b, bi) => `<div class="axcol b-${b.k}">
      <div class="axcol-head"><b>${icon(b.k)}${esc(b.n)}</b><span>${esc(b.q)}</span></div>
      ${E.BLOCK_AXES[bi].map(k => `<a class="axtile" href="#/axes#ax-${AXES[k].k}"><span class="ax-badge">${icon(AXES[k].k)}</span><b><span class="ax-no">${pad2(k + 1)}</span>${esc(AXES[k].n)}</b><span class="poles"><span>${esc(AXES[k].L)}</span><i></i><span>${esc(AXES[k].R)}</span></span></a>`).join('')}
    </div>`).join('')}</div>
  </section>

  <section class="sec">
    ${secHead(2, 'The map so far', `All ${IDEOLOGIES.length} ideologies on the familiar two-axis compass, worked out from their twelve positions.${myResult() ? ' The ring is your own result.' : ''}`)}
    ${politicsMap(myResult() ? myResult().P : null)}
  </section>

  <section class="sec">
    ${secHead(3, 'The catalogue', 'Every profile carries the same twelve positions, so anything can be compared with anything.')}
    <div class="catgrid">
      ${catTile('#/ideologies', IDEOLOGIES.length, 'Ideologies', `${FAMILIES.length} families, from council communism to neoreaction`)}
      ${catTile('#/people', PEOPLE.length, 'People', `${FIELDS.length} fields: rulers, theorists, economists, activists, clergy, business leaders, entertainers and athletes`)}
      ${catTile('#/countries', NATIONS.length, 'Countries', 'Every UN member, plus Kosovo, Palestine, Taiwan and the Vatican, as governed in October 2026')}
      ${catTile('#/countries?t=regions', SUBNATS.length, 'Regions and unions', 'The EU, the UK\'s four nations, US, Brazilian and Indian states, and autonomous regions')}
      ${catTile('#/countries?t=hist', REGIMES.length, 'Historical regimes', 'From pharaonic Egypt to governments that ended in 2026')}
    </div>
  </section>

  <section class="sec">
    ${secHead(4, 'How it works')}
    <ol class="steps">
      <li class="b-power">${stepArt(0)}<b>Agree or disagree, by degrees.</b> Seven answers, from strongly agree to strongly disagree. Not sure what an answer means? “About this question” shows what agreeing and disagreeing stand for, each with a real example.</li>
      <li class="b-culture">${stepArt(1)}<b>Mark what matters.</b> Star the statements you care about most. Each starred statement counts double in your position, and axes you star count more when you're matched.</li>
      <li class="b-economy">${stepArt(2)}<b>Something new each time.</b> Each attempt draws its own balanced set from the bank. Retake it for new statements, or send your result to a friend and see where you agree and where you split.</li>
    </ol>
    <p class="more"><a class="link" href="#/method">Read the full method</a></p>
  </section>`;
  heroQuestions();
  if (DATA.more) examples();
}
function catTile(href, n, label, sub) {
  return `<a class="cattile" href="${href}"><span class="ct-n num">${n}</span><b>${esc(label)}</b><span>${esc(sub)}</span></a>`;
}

/* ── catalogue lists ── */
const TABKEY = { country: 'modern', region: 'regions', regime: 'hist' };
/* ready-made collections on the people page */
const COLLECTIONS = [
  { k: 'swedes', n: 'All Swedes', f: e => e.o === 'sweden' },
  { k: 'presidents', n: 'US presidents', f: e => /^(?!vice).*\bpresident of the United States/i.test(e.r || '') },
  { k: 'revolutionaries', n: 'Revolutionaries', f: e => /revolution|guerrilla/i.test((e.r || '') + ' ' + (e.d || '').slice(0, 160)) },
  { k: 'musicians', n: 'Musicians', f: e => /singer|rapper|musician|songwriter|band|DJ|composer|guitarist/i.test(e.r || '') },
  { k: 'athletes', n: 'Athletes', f: e => /footballer|boxer|basketball|tennis|sprinter|athlete|fighter|player|racing|cricketer|skier|swimmer|golfer/i.test(e.r || '') && !/actor/i.test(e.r || '') },
  { k: 'internet', n: 'Streamers and internet', f: e => /streamer|youtuber|influencer|podcaster|content creator|internet/i.test(e.r || '') },
  { k: 'nobel', n: 'Nobel Peace laureates', f: e => /Nobel Peace/.test(e.d || '') },
];
function listView(kind, params) {
  const isC = isPlace(kind);
  const K = KINDS[kind];
  const groups = kind === 'ideology' ? FAMILIES.map(f => [f.k, f.n]) : kind === 'person' ? FIELDS.map(f => [f.k, f.n])
    : kind === 'regime' ? ERAS.map(r => [r.k, r.n]) : REGIONS.map(r => [r.k, r.n]);
  const gkey = kind === 'ideology' || kind === 'person' ? 'f' : kind === 'regime' ? 'e' : 'reg';
  const me = myResult();
  const g = params.get('g') || '', q = (params.get('q') || '').toLowerCase();
  const sorts = [me && ['me', 'Closest to me'], kind === 'regime' && ['yr', 'By date'], ['az', 'A–Z']].filter(Boolean);
  const sort = sorts.some(x => x[0] === params.get('s')) ? params.get('s') : sorts[0][0];
  setTitle(K.plural);
  const col = kind === 'person' ? COLLECTIONS.find(c => c.k === params.get('col')) : null;
  let items = K.list.filter(e => (!g || e[gkey] === g) && (!col || col.f(e)) && (!q || (e.n + ' ' + (e.d || '') + ' ' + subLabel(e, kind)).toLowerCase().includes(q)));
  const ms = me ? new Map(E.rank(me.P, K.list, me.u).map(x => [x.e.id, x.m])) : null;
  if (sort === 'me' && ms) items.sort((a, b) => ms.get(b.id) - ms.get(a.id));
  else if (sort === 'yr') items.sort((a, b) => startYear(a.y) - startYear(b.y) || a.n.localeCompare(b.n));
  else items.sort((a, b) => a.n.localeCompare(b.n));
  const counts = {}; K.list.forEach(e => { counts[e[gkey]] = (counts[e[gkey]] || 0) + 1; });
  const base = isC ? '#/countries' : kind === 'ideology' ? '#/ideologies' : '#/people';
  const link = (o) => { const p = new URLSearchParams(params); Object.entries(o).forEach(([k, v]) => v ? p.set(k, v) : p.delete(k)); if (isC) p.set('t', TABKEY[kind]); const s = p.toString(); return base + (s ? '?' + s : ''); };
  const FIRST = 'IntersectionObserver' in window ? 60 : items.length;
  const cards = (from, to) => items.slice(from, to).map(e => listCard(e, kind, ms ? ms.get(e.id) : null)).join('');
  view().innerHTML = `
  <section class="page-head">
    <p class="kicker">Catalogue</p>
    <h1>${esc(K.plural)}</h1>
    <p class="lede">${listIntro(kind)}</p>
    ${isC ? `<div class="seg">${['country', 'region', 'regime'].map(k =>
      `<a href="#/countries?t=${TABKEY[k]}" class="${k === kind ? 'on' : ''}">${esc(KINDS[k].plural)} <span class="num">${KINDS[k].list.length}</span></a>`).join('')}</div>` : ''}
  </section>
  <div class="toolbar">
    <label class="search"><span class="sr">Search</span><input type="search" id="list-q" placeholder="Search ${esc(K.plural.toLowerCase())}…" value="${esc(params.get('q') || '')}"></label>
    ${sorts.length > 1 ? `<div class="seg sm" aria-label="Sort">${sorts.map(([k, l]) => `<a href="${link({ s: k })}" class="${sort === k ? 'on' : ''}">${l}</a>`).join('')}</div>` : ''}
  </div>
  <div class="chips"><a href="${link({ g: '', col: '' })}" class="${!g && !col ? 'on' : ''}">All <span class="num">${K.list.length}</span></a>${groups.filter(([k]) => counts[k]).map(([k, l]) =>
    `<a href="${link({ g: g === k ? '' : k, col: '' })}" class="${g === k ? 'on' : ''}">${esc(l)} <span class="num">${counts[k]}</span></a>`).join('')}${kind === 'person' ? COLLECTIONS.map(c => { const n = K.list.filter(c.f).length;
    return n ? `<a href="${link({ col: col && col.k === c.k ? '' : c.k, g: '' })}" class="${col && col.k === c.k ? 'on' : ''}">${esc(c.n)} <span class="num">${n}</span></a>` : ''; }).join('') : ''}</div>
  ${g && kind === 'ideology' ? `<p class="group-d">${esc(FAM[g].d)}</p>` : ''}
  ${g && kind === 'person' ? `<p class="group-d">${esc(FLD[g].d)}</p>` : ''}
  <p class="count">${items.length} shown${q ? ` for “${esc(q)}”` : ''}</p>
  <div class="grid g3 list" id="list-grid">${cards(0, FIRST) || '<p class="muted">Nothing matches.</p>'}</div>
  ${items.length > FIRST ? '<div id="list-more" aria-hidden="true"></div>' : ''}`;
  // the rest of a long list is added as you scroll toward it, so a list of a thousand people appears at once
  const more = $('#list-more'), grid = $('#list-grid');
  if (more) {
    let shown = FIRST;
    const io = new IntersectionObserver(en => {
      if (!more.isConnected) return io.disconnect();
      if (!en.some(x => x.isIntersecting)) return;
      grid.insertAdjacentHTML('beforeend', cards(shown, shown + 120)); shown += 120; Pics.scan(grid);
      if (shown >= items.length) { io.disconnect(); more.remove(); } else { io.unobserve(more); io.observe(more); }   // look again: the end may still be in view
    }, { rootMargin: '1500px' });
    io.observe(more);
  }
  const inp = $('#list-q');
  let t = null;
  inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { const p = new URLSearchParams(params); inp.value ? p.set('q', inp.value) : p.delete('q'); if (isC) p.set('t', TABKEY[kind]); history.replaceState(null, '', base + (p.toString() ? '?' + p : '')); listView(kind, p); const i2 = $('#list-q'); i2.focus(); i2.setSelectionRange(i2.value.length, i2.value.length); }, 180); });
}
function listIntro(kind) {
  if (kind === 'ideology') return 'Political traditions, movements and doctrines, each placed on the twelve axes. Positions are judgements drawn from each movement\'s own writings and its record in power.';
  if (kind === 'person') return 'Rulers, thinkers and activists, placed by what they argued and, for those who held power, what they did with it. Entertainers and athletes are placed by the causes and candidates they have publicly backed.';
  if (kind === 'country') return 'Today\'s sovereign states, placed by how they are governed in practice as of October 2026, not by what their constitutions promise.';
  if (kind === 'region') return 'Regions, devolved nations, federal states and one supranational union. Each is placed by what its own government does with the powers it holds; on matters decided nationally, such as defence or trade, by the stance its elected leaders take.';
  return 'Past states and regimes, placed by how they were governed in the years named.';
}
// first year of a span such as "c. 3100–30 BC", "206 BC–AD 220" or "1997–2007" (BC as negative)
function startYear(y) {
  const s = String(y || ''), first = s.split('–')[0], m = first.match(/\d+/);
  if (!m) return 9999;
  const n = +m[0];
  return /BC/.test(first) || (/BC/.test(s) && !/AD/.test(s)) ? -n : n;
}
function listCard(e, kind, m) {
  return `<a class="lcard" href="${hrefOf(e, kind)}">
    ${kind === 'ideology' ? '' : Pics.html(e, kind, 'lc-pic')}
    <span class="lc-body"><b>${esc(e.n)}</b><span class="lc-sub">${esc(subLabel(e, kind))}</span>${kind === 'ideology' ? `<span class="lc-d">${esc(e.d)}</span>` : ''}</span>
    <span class="lc-foot">${glyph(e.a, { cls: 'sm' })}${m != null ? `<span class="num lc-m">${Math.round(m)}%</span>` : ''}</span>
  </a>`;
}

/* ── axes guide ── */
function axesView() {
  setTitle('The twelve axes');
  const mine = myResult();
  view().innerHTML = `
  <section class="page-head"><p class="kicker">Guide</p><h1>The twelve axes</h1>
    <p class="lede">What each axis measures, what its poles mean in practice, and who stands at the ends. Every profile in the catalogue is placed with these anchors.</p></section>
  ${AXES.map((ax, k) => {
    const ext = (list, kind) => {
      if (!list.length) return '';
      const s = list.slice().sort((a, b) => a.a[k] - b.a[k]);
      const one = e => `<a href="${hrefOf(e, kind)}">${esc(e.n)}</a>`;
      return `<div class="ext"><span class="kicker">${esc(KINDS[kind].plural)}</span><p><b>${esc(ax.L)}:</b> ${s.slice(0, 3).map(one).join(', ')}</p><p><b>${esc(ax.R)}:</b> ${s.slice(-3).reverse().map(one).join(', ')}</p></div>`;
    };
    return `<section class="axsec b-${ax.b}" id="ax-${ax.k}">
      <header><span class="ax-no">${icon(ax.k)}${pad2(k + 1)}</span><div><span class="kicker">${icon(ax.b)}${esc(BLK[ax.b].n)}</span><h2>${esc(ax.n)}: ${esc(ax.L)} ↔ ${esc(ax.R)}</h2><p>${esc(ax.q)}</p></div></header>
      <div class="poles2"><div>${poleArt(ax.k, 0)}<b>${esc(ax.L)}</b><p>${esc(ax.Ld)}</p></div><div>${poleArt(ax.k, 1)}<b>${esc(ax.R)}</b><p>${esc(ax.Rd)}</p></div></div>
      <ol class="anchors">${ax.an.map((t, i) => `<li><span class="num">${i * 25}</span><p>${esc(t)}</p></li>`).join('')}</ol>
      ${axisHist(k, mine ? mine.P[k] : null)}
      ${ax.fa ? `<p class="fine">This axis combines two related questions: ${Object.values(ax.fa).map(esc).join(' and ')}. If your answers on the two differ a lot, your result says so.</p>` : ''}
      <div class="exts">${ext(IDEOLOGIES, 'ideology')}${ext(PEOPLE, 'person')}${ext(NATIONS, 'country')}</div>
    </section>`;
  }).join('')}`;
  const h = location.hash.split('#')[2];
  if (h) { const el = document.getElementById(h); if (el) setTimeout(() => el.scrollIntoView(), 30); }
}

/* ── method ── */
function methodView() {
  setTitle('Method');
  view().innerHTML = `
  <section class="page-head"><p class="kicker">Method</p><h1>How the test works</h1>
    <p class="lede">What is measured, how answers become positions, how matches are calculated, and where the limits are.</p></section>
  <article class="prose">
    <h2>Twelve axes in four parts</h2>
    <p>The axes are grouped into Power (who holds it and how far it reaches), World (openness to people, institutions and force beyond the border), Economy (who owns, plans and shares) and Culture (faith, family and technology). Within each part the left-hand pole follows one idea: power spread out, open and cooperative, the state steering, change. Two axes, Trade and Technology, split both left and right, so their sides carry no left–right meaning.</p>
    <h2>The statements</h2>
    <p>The test draws from a bank of ${QUESTIONS.filter(q => !q.x).length} statements, between ${Math.min(...AXES.map(a => QUESTIONS.filter(q => !q.x && q.ax === a.k).length))} and ${Math.max(...AXES.map(a => QUESTIONS.filter(q => !q.x && q.ax === a.k).length))} for each axis. Some are classic lines from other well-known political tests and famous quotations; the rest were written for The Agora. You answer each on a seven-point scale: strongly agree, agree, slightly agree, neutral, slightly disagree, disagree, strongly disagree. If you don't know enough about a statement to judge it, you can skip it instead.</p>
    <h2>Two versions, a new draw every time</h2>
    <p>The <b>full test</b> asks ${E.MODES.full.n} statements and the <b>quick test</b> ${E.MODES.quick.n}. Both adapt as you go. The first rounds pass through all twelve axes; after that, each next statement is chosen from your answers so far, for two reasons at once. Every ideology predicts how you would answer each statement, the ideologies whose predictions match your answers gain weight, and a statement is useful when the ideologies still in the running disagree about it. A statement is also useful when its neutral point (explained below) lies close to where you seem to stand on an axis that is still uncertain. In both versions:</p>
    <ul>
      <li>No part of the map is skipped: every axis gets between five and nine statements in the full test and between two and four in the quick test.</li>
      <li>Within an axis, statements worded so that agreeing pulls toward one pole are balanced against those pulling toward the other, so a general habit of agreeing, or of disagreeing, cancels out. On Migration, Force and Ownership the two halves of the axis are balanced as well.</li>
      <li>Statements that ask nearly the same thing, such as several on the death penalty or on national pride, share a topic, and only one from each topic is asked.</li>
      <li>Statements you have been given before are less likely to come up again, and among statements that are about equally useful the next one is picked at random, so two attempts rarely look alike.</li>
    </ul>
    <p>Alongside the statements on the twelve axes, every test asks a few <b>core beliefs</b>: named positions such as “Capitalism can only be ended by revolution, not by winning elections” or “A king or queen should hold real political power”. They don't move you on the axes. Your answer is compared directly with where each ideology stands on that belief (holds it, rejects it, or is divided), and together the core beliefs can count for up to a third of each match with an ideology. They are what tells apart ideologies with almost the same shape but different doctrines, such as Trotskyism and Luxemburgism. The full test asks 12 of them and the quick test 8, chosen for how well they separate the ideologies still in the running. People, countries and regimes are matched on the twelve axes only.</p>
    <p>We tested the method on simulated people. Each one stands near one of the ideologies, answers with some random noise and a personal habit of answering strongly or mildly, reads every statement a little differently from the neutral point the test assumes, and gives a random answer to one core belief in four. For people standing right next to an ideology, the full test put that ideology first nearly every time and the quick test about nine times in ten. For people standing further from any ideology, their own ideology was among the top three about nine times in ten in the full test and four times in five in the quick test. When the top ideologies are within two and a half points of each other, the result says it is a near tie rather than crowning one.</p>
    <p>Every statement has an <b>About this question</b> note: what agreeing means and what disagreeing means, each with a real example of the view in practice. The examples were checked against public sources; they describe, they don't argue. Words that may be unfamiliar are underlined with dots: hover over them for a definition, or open “Words explained” below the statement.</p>
    <p>A few statements can be rejected for opposite reasons. “Homosexuality is wrong, but lesbianism is okay”, for example, is disagreed with both by people who accept both and by people who reject both. For these, only agreeing moves you; disagreeing leaves your result unchanged, and the About note says so.</p>
    <h2>From answers to positions</h2>
    <p>Each answer is a number from +3 (strongly agree) to −3 (strongly disagree), with neutral at 0. Every statement has a direction, the pole that agreeing points toward, and a <b>neutral point</b>: the position on the axis, from 0 to 100, at which a person would neither agree nor disagree with it. A radical statement has its neutral point close to the pole it points toward, because only people at that end agree. A mild one has its neutral point on the far side, because everyone but the other end agrees. “The Internet should be banned” points toward Precaution and has its neutral point at 97; “Some forests should never be cut down, whatever the economic gain” points the same way and has it at 28. The neutral points were set by judgement, against the same anchors as the profiles.</p>
    <p>A person at position <b>t</b> is expected to answer a statement with <b>3 × tanh((t − neutral point) ÷ 22)</b>, with the sign reversed for a statement that points toward the left-hand pole: neutral at the neutral point, “agree” about 22 points past it, and close to “strongly agree” from about 40 points past it. For each axis the test goes through every position from one pole to the other and measures how well the answers that position predicts fit the answers you gave. Your position <b>P</b> is the average of all positions, each weighted by how well it fits. This means that strongly rejecting a radical statement says only that you are not at that far end; it does not push you to the opposite pole.</p>
    ${methodCurves()}
    <p>A statement counts fully on its own axis and half on a second axis it also touches (agreeing that fee-paying schools should be abolished counts fully toward public ownership and half toward equality). A starred statement counts twice. A few statements that separate positions less sharply count 0.6. A skipped statement is left out entirely, so it doesn't pull you toward the middle; an axis where you skipped everything is left out of the matching.</p>
    <p>Each position also has an uncertainty: how widely the positions that fit your answers are spread. It is usually larger in the quick test, and an axis with a large uncertainty counts less when matches are calculated.</p>
    <p>Three axes combine two related questions: Migration (how many should come, and how they should fit in), Force (defending the country, and using force abroad) and Ownership (who owns, and how far the state plans and regulates). When you answered at least two statements on each half and the two differ by 30 points or more, the result points it out.</p>
    <h2>The classic compass</h2>
    <p>The result also places you on the familiar two-axis compass. The economic axis is 55% Ownership and 45% Welfare; the social axis is 40% Rule, 40% Liberty and 20% Morality, with authoritarian at the top. Both run from −10 to +10. The compass is a summary: it drops seven of the twelve axes, including Migration, Nation, Force and Religion.</p>
    <h2>Matching</h2>
    <p>A match is worked out from the typical gap between two profiles, measured as a weighted cubic mean of the gaps on the twelve axes. Each point of gap costs 1.5 percentage points up to a gap of 10, which gives 85%, and 0.9 after that: a 20-point gap gives 76%, a 30-point gap 67%. The cubic mean makes one large gap count for more than several small ones, so a profile that agrees with you everywhere but on one axis where it is far away drops noticeably; the steeper start spreads the top of the scale so close results are easier to tell apart. Four things change the weights: an ideology's defining axes count 1.5 times; an axis counts more the more of its statements you starred, up to twice as much if you starred all of them; an axis with almost no answers counts half; and an axis where your position is less certain counts less. In symbols, with gap = ∛(Σ w·|you − profile|³ ÷ Σw): match = 100 − 1.5 × gap up to a gap of 10, and 85 − 0.9 × (gap − 10) beyond it.</p>
    ${matchCurve()}
    <p>“Closest on each part of the map” repeats the calculation using only the three axes of Power, World, Economy or Culture. To keep out figures who happen to share three positions but are far from you on everything else, the picks are ranked by the average of that part's match and the overall match, and each part shows a different name from your overall closest match. The percentage shown is the match on that part.</p>
    <h2>Comparing with a friend</h2>
    <p>Your result has its own link, which holds your answers in coded form and nothing else. Paste a friend's link on your result page to see both profiles side by side. Because each attempt draws its own statements, you will usually share some but not all of them; the comparison lists the ones you both answered, the biggest disagreements first, while the match itself uses your positions on all twelve axes.</p>
    <h2>How profiles were placed</h2>
    <p>Every ideology, person, country, region and regime was placed by judgement against the anchors on the <a class="link" href="#/axes">axes page</a>. Ideologies are placed by their founding texts and by what their movements did in power. People are placed by what they argued; those who held power are placed mainly by what they did with it, and rulers who left no writings by their record alone. Entertainers and athletes are placed by the causes and candidates they have publicly backed; where they have said little about an axis, they sit near its middle. Countries are placed by how they are actually governed as of October 2026 — a constitution that promises free elections does not earn a democratic score if the elections are not free — drawing on the picture given by sources such as V-Dem, Freedom House, the OECD and SIPRI. Regions are placed by what their own governments do with the powers they hold and, on matters decided nationally, by the stance their elected leaders take. Historical regimes are placed by how they were governed in the years named.</p>
    <p>Countries, regions and historical regimes are ranked separately, so a US state never pushes a country off your list.</p>
    <h2>Limits worth knowing</h2>
    <ul>
      <li>Placements are informed judgements, not measurements. Followers of any movement would argue about where it belongs.</li>
      <li>Positions are whole numbers from 0 to 100. They were first set in steps of five, then refined: each value was moved up to two points toward what the entry's other eleven positions suggest, based on how the axes go together across the whole catalogue. A deliberate 0 or 100 was left as it is, and no two entries share exactly the same profile.</li>
      <li>Twelve axes are still a simplification. They leave out, among much else, how change should happen and whom “the people” includes.</li>
      <li>Some axes mean different things in different eras: “Technology” in 300 BC is not AI policy. Old regimes and thinkers are placed by the nearest equivalent of their views.</li>
      <li>A match describes a set of positions, not a moral verdict. Several movements in the catalogue are tied to mass violence, and their profiles say so.</li>
      <li>Countries change. Country and region profiles describe October 2026, living people their record up to then, and some will date quickly.</li>
    </ul>
    <h2>Pictures</h2>
    <p>Flags of countries, and of regions that have a standard code, come from flagcdn.com, Flagpedia's free flag service. Portraits and the remaining flags and emblems are the lead images of Wikipedia articles and stay under their original licences; a flag that fails to load from flagcdn is taken from Wikipedia instead. If no image can be found, a lettered tile is shown.</p>
  </article>`;
}

/* ── the test ── */
const QBY = Object.fromEntries(QUESTIONS.map(q => [q.id, q]));
let quiz = null, quizBusy = false;

/* progress v4: { v, mode, order, pos, answers, stars, t }. A new attempt draws its statements from the bank;
   'seen' counts how often each statement has been drawn, so the next attempt starts with the least-seen ones. */
function savedQuiz() {
  const p = store.get('progress', null);
  return p && p.v === 4 && E.MODES[p.mode] && Array.isArray(p.order) && p.order.length && p.order.every(id => QBY[id]) ? p : null;
}
function startQuiz(mode, fresh) {
  let p = fresh ? null : savedQuiz();
  if (!p || (mode && E.MODES[mode] && p.mode !== mode)) {
    const m = E.MODES[mode] ? mode : 'full', seen = store.get('seen', {}) || {};
    let order, pos = 0, answers = {};
    const seed = store.get('seed', null); store.del('seed');
    if (E.MODES[m].adaptive && seed && QBY[seed.id] && typeof seed.a === 'number') {
      // the statement answered on the home page counts as the first answer
      answers[seed.id] = seed.a; pos = 1;
      order = [seed.id].concat(E.plan(m, [seed.id], answers, seen));
    } else if (E.MODES[m].adaptive) order = E.plan(m, [], {}, seen);   // planned again after every answer; counted as seen when finished
    else {
      order = E.draw(m, seen).order;
      order.forEach(id => { seen[id] = (seen[id] || 0) + 1; });
      store.set('seen', seen);
    }
    p = { v: 4, mode: m, order, pos, answers, stars: [], t: Date.now() };
  }
  quiz = p; saveQuiz(); quizView();
}
function saveQuiz() { store.set('progress', quiz); }

/* core beliefs share the test with the axis statements; this stands in for an axis when one is shown */
const CR_AX = { k: 'cr', n: 'Core belief', b: 'cr', L: 'Matched against what each ideology holds', R: '' };
const CR_BLK = { k: 'cr', n: 'Doctrine' };
const axOf = q => q.ax === 'cr' ? CR_AX : AXES[E.AXI[q.ax]];
function quizView() {
  setTitle('The test');
  if (!quiz) return startQuiz(null, false);
  if (quiz.country === undefined) { if (Object.keys(quiz.answers).length) quiz.country = ''; else return countryPickView(); }
  const total = quiz.order.length;
  if (quiz.pos >= total) return finishQuiz();
  const id = quiz.order[quiz.pos], q = QBY[id], ax = axOf(q), blk = BLK[ax.b] || CR_BLK;
  const cur = quiz.answers[id], starred = quiz.stars.includes(id), used = new Set();
  const text = gloss(q.q, used);
  const words = [...used].map(g => `<dt>${esc(GLOSSARY[g].k[0])}</dt><dd>${esc(GLOSSARY[g].d)}</dd>`).join('');
  view().innerHTML = `
  <section class="quiz b-${ax.b}">
    <div class="q-top">
      <button class="btn text" type="button" data-act="back">← ${quiz.pos ? 'Back' : 'Home'}</button>
      <span class="q-meta">${icon(quiz.mode === 'quick' ? 'bolt' : 'layers')}${esc(E.MODES[quiz.mode].name)} <span class="num">· ${quiz.pos + 1} / ${total}</span></span>
    </div>
    ${progressBoard()}
    <div class="q-axis" data-key="${q.id}">
      <span class="q-badge">${icon(ax.k)}</span>
      <span class="q-axis-t"><b>${esc(ax.n)}</b><span>${ax.k === 'cr' ? esc(ax.L) : `${esc(ax.L)} ↔ ${esc(ax.R)}`}</span></span>
      <span class="q-block">${icon(ax.k === 'cr' ? 'layers' : ax.b)}${esc(blk.n)}</span>
    </div>
    <h1 class="q-text" id="q-text">${text}</h1>
    <div class="likert" role="radiogroup" aria-labelledby="q-text">
      ${E.SCALE.map((o, n) => `<button type="button" class="lk lk${o.a < 0 ? 'd' : o.a > 0 ? 'a' : 'n'}${Math.abs(o.a)}${cur === o.a ? ' picked' : ''}" data-a="${o.a}" role="radio" aria-checked="${cur === o.a}" aria-label="${o.n}"><i></i><span>${o.n}</span><kbd>${n + 1}</kbd></button>`).join('')}
    </div>
    <div class="lk-ends" aria-hidden="true"><span>Agree</span><span>Disagree</span></div>
    <div class="q-skip"><button type="button" class="btn text skipq${cur === 'skip' ? ' on' : ''}" data-act="skip">${cur === 'skip' ? 'Skipped' : 'Skip'} <span class="muted">— I don't know enough to answer</span> <kbd>S</kbd></button></div>
    <div class="q-actions">
      <button type="button" class="btn ghost about" data-act="about" aria-haspopup="dialog">${icon('info')}About this question <kbd>A</kbd></button>
      <button type="button" class="btn ghost star${starred ? ' on' : ''}" data-act="star" aria-pressed="${starred}">${icon('star')}This matters to me <kbd>M</kbd></button>
      <button type="button" class="btn ghost swap" data-act="swap" title="Get a different statement on the same axis">${icon('refresh')}<span class="sw-t">Swap question</span> <kbd>W</kbd></button>
      <span class="fine">Starred statements count double.</span>
    </div>
    ${words ? `<details class="world"><summary>Words explained</summary><dl class="gl-list">${words}</dl></details>` : ''}
    <p class="fine keys">Keys <kbd>1</kbd>–<kbd>7</kbd> answer, from strongly agree to strongly disagree · <kbd>S</kbd> skip · <kbd>W</kbd> swap · <kbd>A</kbd> about this question · <kbd>M</kbd> mark as important · <kbd>←</kbd> back</p>
  </section>`;
}

function progressBoard() {
  const total = quiz.order.length, rowOf = {}, seen = {};
  let nb = 0;
  quiz.order.forEach(id => { if (QBY[id].ax === 'cr') { rowOf[id] = nb++; return; } const k = E.AXI[QBY[id].ax]; seen[k] = (seen[k] || 0) + 1; rowOf[id] = seen[k]; });
  const cells = quiz.order.map((id, n) => {
    const a = quiz.answers[id];
    const st = n === quiz.pos ? ' cur' : typeof a === 'number' ? ' on' : a === 'skip' ? ' skip' : '';
    if (QBY[id].ax === 'cr') return `<i class="b-cr${st}" style="grid-column:${17 + rowOf[id] % 2};grid-row:${1 + Math.floor(rowOf[id] / 2)}"></i>`;
    const k = E.AXI[QBY[id].ax];
    return `<i class="b-${AXES[k].b}${st}" style="grid-column:${k + 1 + Math.floor(k / 3)};grid-row:${rowOf[id]}"></i>`;
  }).join('');
  const done = Object.keys(quiz.answers).length;
  return `<div class="q-progress"><div class="board" role="img" aria-label="${done} of ${total} answered">${cells}</div>
    <div class="q-bar"><i style="width:${(100 * done / total).toFixed(1)}%"></i></div></div>`;
}

/* for a core belief: how many ideologies hold it, and some of the best known */
function beliefHolders(q) {
  const hold = IDEOLOGIES.filter(e => e.cr && e.cr[q.cr] === 1), rej = IDEOLOGIES.filter(e => e.cr && e.cr[q.cr] === 0);
  const some = l => l.slice().sort((a, b) => a.n.length - b.n.length).slice(0, 3).map(e => esc(e.n)).join(', ');
  return `Held by ${hold.length} of the ${IDEOLOGIES.length} ideologies${hold.length ? ` (among them ${some(hold)})` : ''}, rejected by ${rej.length}.`;
}
/* "About this question": what agreeing and disagreeing mean, each with a real example, and how the answer moves you */
function aboutQ(id) {
  const q = QBY[id || (quiz && quiz.order[quiz.pos])], dlg = $('#qabout');
  if (!q || !dlg) return;
  const ax = axOf(q);
  const pulls = (E.KEYS[q.id] || []).map(x => `${x.w < 1 ? 'a little ' : ''}toward <b>${esc(x.s > 0 ? AXES[x.k].R : AXES[x.k].L)}</b> on ${esc(AXES[x.k].n)}`);
  const box = (cls, ic, label, [t, ex]) => `<div class="qa-card ${cls}">
      <p class="qa-h">${icon(ic)}<span>${label}</span></p>
      <p class="qa-t">${esc(t)}</p>
      <p class="qa-ex">Example: ${esc(ex)}</p>
    </div>`;
  $('.dlg-body', dlg).innerHTML = `
    <p class="kicker qa-k b-${ax.b}">${icon(ax.k === 'cr' ? 'layers' : ax.k)}${esc(ax.n)}${ax.k === 'cr' ? '' : ` · ${esc(ax.L)} ↔ ${esc(ax.R)}`}</p>
    <h2 id="qa-h">About this question</h2>
    <p class="qa-q">${esc(q.q)}</p>
    ${box('agree', 'check', 'If you agree', q.y)}
    ${box('disagree', 'cross', 'If you disagree', q.n)}
    <p class="fine qa-pull">${q.ax === 'cr' ? `This is a core belief. It doesn't move you on the twelve axes: your answer is compared directly with what each ideology holds, and together the core beliefs can count for up to a third of each match. ${beliefHolders(q)}` : q.o === -1
      ? `Disagreeing moves you ${pulls.map(x => x.replace('toward <b>', 'away from <b>')).join(', and ')}; agreeing leaves your result unchanged, because people on both sides agree with this.`
      : `Agreeing moves you ${pulls.join(', and ')}; ${q.o ? 'disagreeing leaves your result unchanged, because people disagree with this for opposite reasons' : 'disagreeing moves you the other way'}.`}${q.ax === 'cr' ? '' : ' Stronger answers move you further.'}</p>`;
  if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
}

/* Skip: for statements you can't judge. Unlike Neutral, which places you in the middle, a skipped statement
   is left out of your result altogether. */
/* adaptive mode: once you move past the furthest statement answered so far, plan the rest again from your answers */
function replan() {
  if (!E.MODES[quiz.mode].adaptive) return;
  if (quiz.order.slice(quiz.pos).some(id => id in quiz.answers)) return;
  const fixed = quiz.order.slice(0, quiz.pos);
  quiz.order = fixed.concat(E.plan(quiz.mode, fixed, quiz.answers, store.get('seen', {}) || {}, null, { excl: quiz.swapped || [] }));
}
/* Swap: trade the statement on screen for another one on the same axis, preferring one keyed the same way.
   The swapped statement is not asked again in this attempt. */
function swapFor(id) {
  const q = QBY[id], inOrder = new Set(quiz.order), out = new Set(quiz.swapped || []), seen = store.get('seen', {}) || {};
  if (q.ax === 'cr') {
    const b = QUESTIONS.filter(x => x.ax === 'cr' && !x.x && !inOrder.has(x.id) && !out.has(x.id) && !(x.id in quiz.answers));
    return b.length ? b[Math.floor(Math.random() * b.length)].id : null;
  }
  const pool = QUESTIONS.filter(x => !x.x && x.ax === q.ax && x.id !== id && !inOrder.has(x.id) && !out.has(x.id) && !(x.id in quiz.answers) && !(q.t && x.t === q.t));
  if (!pool.length) return null;
  const sign = E.SIGN[id];
  pool.sort((a, b) => ((E.SIGN[a.id] === sign ? 0 : 1) - (E.SIGN[b.id] === sign ? 0 : 1)) || ((seen[a.id] || 0) - (seen[b.id] || 0)) || (Math.random() - 0.5));
  const same = pool.filter(x => E.SIGN[x.id] === sign && (seen[x.id] || 0) === (seen[pool[0].id] || 0));
  return (same.length ? same[Math.floor(Math.random() * same.length)] : pool[0]).id;
}
function swapQ() {
  if (quizBusy || !quiz || quiz.country === undefined) return;
  const id = quiz.order[quiz.pos], nid = swapFor(id);
  if (!nid) { const b = $('[data-act="swap"]'); if (b) { b.disabled = true; b.querySelector('.sw-t').textContent = 'No other statement on this axis'; } return; }
  quiz.swapped = (quiz.swapped || []).concat(id);
  delete quiz.answers[id]; quiz.stars = quiz.stars.filter(x => x !== id);
  quiz.order[quiz.pos] = nid;
  saveQuiz(); quizView();
  const t = $('#q-text'); if (t) t.classList.add('swapped');
}
function skipQ() {
  if (quizBusy || !quiz || quiz.country === undefined) return;
  const id = quiz.order[quiz.pos];
  quiz.answers[id] = 'skip'; quiz.stars = quiz.stars.filter(x => x !== id);
  quiz.pos++; replan(); saveQuiz(); quizView();
}
function choose(a) {
  if (quizBusy || !quiz || quiz.country === undefined) return;
  const id = quiz.order[quiz.pos];
  quiz.answers[id] = a; quizBusy = true;
  $$('.lk').forEach(x => { const on = +x.dataset.a === a; x.classList.toggle('picked', on); x.setAttribute('aria-checked', String(on)); });
  setTimeout(() => { quizBusy = false; quiz.pos++; replan(); saveQuiz(); quizView(); }, 160);
}
function backQ() { if (!quiz || quiz.pos === 0) { location.hash = '#/'; return; } quiz.pos--; saveQuiz(); quizView(); }
function starQ() {
  const id = quiz.order[quiz.pos], i = quiz.stars.indexOf(id);
  if (i >= 0) quiz.stars.splice(i, 1); else quiz.stars.push(id);
  saveQuiz();
  const b = $('[data-act="star"]'); if (b) { b.classList.toggle('on', i < 0); b.setAttribute('aria-pressed', String(i < 0)); }
}
/* ── the country question, asked before the first statement ──
   It changes no position and no match. The result shows how you compare with your own country and with the figures
   from it in the catalogue. */
function countryPickView() {
  setTitle('Your country');
  const list = NATIONS.slice().sort((a, b) => a.n.localeCompare(b.n));
  const ready = list.length > 0;
  view().innerHTML = `<section class="page-head country-head"><p class="kicker">Before you start</p>
    <h1>Which country do you live in?</h1>
    <p class="lede">This doesn't change where you stand on anything. Your result will show how close you are to your own country as it is governed today, and which figures from it think most like you. When a statement says "your country", think of this one.</p></section>
  <form class="country-pick" data-country>
    <label><span>Country</span><select name="c" required${ready ? '' : ' disabled'}>
      <option value="">${ready ? 'Choose your country…' : 'Loading the list of countries…'}</option>
      ${list.map(c => `<option value="${esc(c.id)}">${esc(c.n)}</option>`).join('')}
    </select></label>
    <div class="cta"><button class="btn primary" type="submit">Start the test</button><button class="btn ghost" type="button" data-nocountry>Prefer not to say</button></div>
  </form>`;
  const form = view().querySelector('[data-country]');
  const go = id => { quiz.country = id; saveQuiz(); quizView(); window.scrollTo(0, 0); };
  form.addEventListener('submit', ev => { ev.preventDefault(); const v = form.elements.c.value; if (v) go(v); else form.elements.c.focus(); });
  view().querySelector('[data-nocountry]').addEventListener('click', () => go(''));
  if (ready) form.elements.c.focus();
}
function finishQuiz() {
  if (!Object.values(quiz.answers).some(a => typeof a === 'number')) { quiz.pos = 0; saveQuiz(); toastSkip(); return quizView(); }
  if (E.MODES[quiz.mode].adaptive) {
    const seen = store.get('seen', {}) || {};
    quiz.order.forEach(id => { if (id in quiz.answers) seen[id] = (seen[id] || 0) + 1; });
    store.set('seen', seen);
  }
  const code = E.encode(quiz.answers, new Set(quiz.stars), quiz.mode) + (quiz.country ? '.' + quiz.country : '');
  store.set('code', code); remember(code, quiz.mode); store.del('progress'); quiz = null;
  view().innerHTML = '';
  location.hash = '#/result';
}

function toastSkip() { setTimeout(() => { const v = view(); if (v) v.insertAdjacentHTML('afterbegin', '<p class="banner">You skipped every statement, so there is nothing to score yet. Answer at least a few to see a result.</p>'); }, 0); }

/* ── result, profile and compare views ── */
const resCache = new Map();
function resultFrom(code) {
  if (resCache.has(code)) return resCache.get(code);
  // a result code may end in .country, the country the person said they live in (it changes nothing in the scoring)
  const [base, cid] = String(code).split('.');
  const d = E.decode(base); if (!d) return null;
  const u = E.score(d.answers, d.stars);
  if (u.answered < 12) return null;
  const c = cid && BY.get(cid), country = c && c.kind === 'country' ? c.e : null;
  const R = { code, answers: d.answers, stars: d.stars, mode: d.mode, u, P: u.P, country };
  resCache.set(code, R); return R;
}
function myResult() { const c = store.get('code', null); return c ? resultFrom(c) : null; }
const modeName = R => R.mode === 'quick' ? 'quick test' : R.mode === 'full' ? 'full test' : 'first version of the test';
const modeIcon = R => icon(R.mode === 'quick' ? 'bolt' : 'layers');
// a result link or a bare code, as pasted: returns the code or null
function codeFrom(text) {
  const t = String(text || '').trim(), m = t.match(/#\/r\/([A-Za-z0-9.-]+)/);
  const c = m ? m[1] : t;
  return /^(a3[A-Ga-gx]+|b[fq][a-z0-9A-G]+)(\.[a-z0-9-]+)?$/.test(c) && resultFrom(c) ? c : null;
}

function facetNotes(u) {
  return AXES.map((ax, k) => {
    const f = u.fac[k]; if (!f || !ax.fa) return '';
    const [a, b] = Object.keys(ax.fa), d = f[a] - f[b];
    if (Math.abs(d) < 30) return '';
    const side = v => (v < 50 ? ax.L : ax.R) + ' ' + Math.round(Math.max(v, 100 - v));
    return `Split view: on ${esc(ax.fa[a])} you lean <b>${esc(side(f[a]))}</b>, on ${esc(ax.fa[b])} <b>${esc(side(f[b]))}</b>.`;
  });
}

/* The result's signature: the twelve bars of the test's own mark, drawn from this result. A bar rises toward the
   right-hand pole of its axis and falls toward the left-hand pole; the further from the middle, the longer. */
function signature(P) {
  const say = k => `${AXES[k].n}: ${P[k] < 50 ? AXES[k].L : AXES[k].R} ${Math.round(Math.max(P[k], 100 - P[k]))}`;
  // the figure is only as tall as the longest bars on each side of the line, so a one-sided result leaves no empty half
  const up = Math.max(8, ...P.map(v => v - 50)), dn = Math.max(8, ...P.map(v => 50 - v)), T = up + dn, pc = v => (100 * v / T).toFixed(1) + '%';
  return `<figure class="rh-sig">
    <div class="sig" role="img" aria-label="${esc(AXES.map((_, k) => say(k)).join(', '))}" style="--t:${T.toFixed(0)};--line:${pc(up)}">${BLOCKS.map((b, bi) => `<div class="sig-g b-${b.k}">
      <div class="sig-bars">${E.BLOCK_AXES[bi].map(k => { const d = P[k] - 50, len = pc(Math.max(1.5, Math.abs(d)));
        return `<i class="${d >= 0 ? 'up' : 'dn'}" style="--h:${len}" title="${esc(say(k))}"></i>`; }).join('')}</div>
      <span aria-hidden="true">${esc(b.n)}</span></div>`).join('')}</div>
    <figcaption>One bar per axis. Up leans toward its right-hand pole, down toward its left-hand pole.</figcaption>
  </figure>`;
}

/* When even the closest country matches poorly, say why: on some axes the result lies beyond where any country
   stands today (real countries all have mixed economies, some welfare state and so on), so no country can come close. */
function countryNote(P, u, mine) {
  const top = E.rank(P, NATIONS, u)[0]; if (!top || top.m >= 82) return '';
  const beyond = AXES.map((ax, k) => {
    const v = NATIONS.map(c => c.a[k]).sort((a, b) => a - b), lo = v[Math.floor(v.length * 0.03)], hi = v[Math.ceil(v.length * 0.97) - 1];
    const out = P[k] < lo ? lo - P[k] : P[k] > hi ? P[k] - hi : 0;
    return { k, out, pole: P[k] < 50 ? ax.L : ax.R };
  }).filter(x => x.out >= 8).sort((a, b) => b.out - a.out).slice(0, 3);
  if (!beyond.length) return '';
  const list = beyond.map(x => x.pole === AXES[x.k].n ? `<b>${esc(x.pole)}</b>` : `<b>${esc(x.pole)}</b> on ${esc(AXES[x.k].n)}`);
  const said = list.length === 1 ? list[0] : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  return `<p class="cnote">${mine ? 'You lean' : 'This result leans'} further toward ${said} than any country does today, so even the closest country is only a ${Math.round(top.m)}% match. The historical regimes, in the last tab below, often come closer.</p>`;
}

/* How close the result is to the country the person lives in, and the figures from it closest to them. */
function homeCountry(R, mine) {
  const c = R.country; if (!c) return '';
  const r = E.rank(R.P, NATIONS, R.u), pos = r.findIndex(x => x.e.id === c.id); if (pos < 0) return '';
  const gaps = AXES.map((ax, k) => ({ ax, k, g: R.P[k] - c.a[k] })).sort((a, b) => Math.abs(b.g) - Math.abs(a.g)).slice(0, 2);
  const say = x => `on ${esc(x.ax.n)} ${mine ? 'you lean' : 'they lean'} further toward <b>${esc(x.g < 0 ? x.ax.L : x.ax.R)}</b> (${Math.round(Math.abs(x.g))} points)`;
  const ppl = E.rank(R.P, PEOPLE.filter(p => p.o === c.id), R.u).slice(0, 3);
  return `<div class="home-c">
    ${Pics.html(c, 'country', 'hc-pic')}
    <div><p class="kicker">${mine ? 'Your country' : 'Their country'}</p>
      <p class="hc-line"><a href="${hrefOf(c, 'country')}"><b>${esc(c.n)}</b></a>: <b class="num">${Math.round(r[pos].m)}%</b> match, #${pos + 1} of ${NATIONS.length} countries. Compared with how it is governed, ${gaps.map(say).join(', and ')}.</p>
      ${ppl.length ? `<p class="fine">Closest figures from ${esc(c.n)}: ${ppl.map(x => `<a class="link" href="${hrefOf(x.e, 'person')}">${esc(x.e.n)}</a> <span class="num">${Math.round(x.m)}%</span>`).join(', ')}.</p>` : ''}
      <a class="link" href="#/compare/${mine ? 'me' : '@' + R.code}/${c.id}">Compare in detail</a></div>
  </div>`;
}
function resultView(code) {
  const shared = !!code;
  const R = code ? resultFrom(code) : myResult();
  if (!R) {
    setTitle('Result');
    view().innerHTML = `<section class="page-head"><p class="kicker">Result</p><h1>${shared ? 'This result link is incomplete' : 'No result yet'}</h1>
      <p class="lede">${shared ? 'The link may have been cut short when it was copied.' : 'Take the test to see where you stand.'}</p>
      <div class="cta"><a class="btn primary" href="#/test?m=full" data-act="restart" data-mode="full">Begin the full test</a><a class="btn ghost" href="#/test?m=quick" data-act="restart" data-mode="quick">Quick test</a></div></section>`;
    return;
  }
  const u = R.u, P = R.P;
  const rk = E.rank(P, IDEOLOGIES, u), top = rk[0];
  const fam = FAM[top.e.f], answered = u.answered;
  const mine = store.get('code', null) === R.code, me = mine ? null : myResult();
  setTitle(mine ? 'Your result' : 'A shared result');
  const people = E.rank(P, PEOPLE, u), countries = E.rank(P, NATIONS, u), regimes = E.rank(P, REGIMES, u);
  const fn = facetNotes(u);
  const retake = R.mode === 'quick' ? 'quick' : 'full';
  let secNo = 0; const N = () => ++secNo;
  const prev = mine ? previousResult(R.code) : null;
  view().innerHTML = `
  ${!mine ? `<p class="banner">You're looking at someone else's result. ${me ? `<a href="#/compare/me/@${R.code}">Compare it with yours</a> or <a href="#/test" data-act="restart">take the test again</a>.` : `<a href="#/test" data-act="restart">Take the test yourself</a>, then compare.`}</p>` : ''}
  <section class="res-hero fam-hero">
    <div class="rh-main">
      <p class="kicker">${mine ? 'Your closest ideology' : 'Closest ideology'} · ${esc(fam.n)}</p>
      <h1>${esc(top.e.n)}</h1>
      <p class="lede">${esc(top.e.d)}</p>
      ${top.e.c ? `<blockquote class="credo">${esc(top.e.c)}</blockquote>` : ''}
      <div class="cta">
        <button class="btn primary" type="button" data-act="share">Share as image</button>
        <a class="btn ghost" href="${hrefOf(top.e, 'ideology')}">Read the full profile</a>
        <a class="btn ghost" href="#/compare/${mine ? 'me' : '@' + R.code}">Compare with…</a>
        ${mine ? `<button class="btn text" type="button" data-act="restart" data-mode="${retake}">Retake</button>` : ''}
      </div>
    </div>
    <aside class="rh-side">
      <div class="ring" style="--p:${Math.round(top.m)}"><span class="num">${Math.round(top.m)}<small>%</small></span><small class="ring-l">match</small></div>
      <p class="rh-mode">${modeIcon(R)}<span>${esc(modeName(R).replace(/^./, c => c.toUpperCase()))} · ${answered} statements</span></p>
      <ol class="runners">${rk.slice(1, 5).map(x => `<li><a href="${hrefOf(x.e, 'ideology')}">${esc(x.e.n)}</a><span class="num">${Math.round(x.m)}%</span></li>`).join('')}</ol>
    </aside>
    ${signature(P)}
  </section>

  <section class="sec">
    ${secHead(N(), 'Your profile across the twelve axes', `Based on ${mine ? 'your' : 'these'} ${answered} answers in the ${esc(modeName(R))}. ★ marks axes with starred statements, which count double.`)}
    <div class="axtable">${axisTable(P, { sal: u.sal, facets: fn })}</div>
    ${answersFig(R, mine)}
  </section>

  <section class="sec">
    ${secHead(N(), 'On the classic compass', 'Where your twelve positions put you on the familiar left–right, authoritarian–libertarian chart, next to your closest ideologies and some well-known figures.')}
    ${compassBlock(P, mine ? 'You' : 'This result', rk.slice(0, 3).map(x => ({ e: x.e, kind: 'ideology' })))}
  </section>

  <section class="sec">
    ${secHead(N(), 'Closest ideologies', `Your three nearest out of ${IDEOLOGIES.length}, and below them the closest on each area of politics.`)}
    ${tieNote(rk, mine)}
    ${resultIdeologies(P, u, rk, top, mine)}
    <h3 class="sub-h">Closest on each area of politics</h3>
    ${valuesBlock(P, u, rk)}
  </section>

  ${u.beliefs ? `<section class="sec">
    ${secHead(N(), 'Your core beliefs', `What ${mine ? 'you' : 'this result'} said about the beliefs that divide the ideologies, set beside what ${esc(top.e.n)} holds.`)}
    ${beliefBlock(u.beliefs, top.e, mine)}
  </section>` : ''}

  <section class="sec">${secHead(N(), 'Closest people', `Out of ${PEOPLE.length} rulers, thinkers, activists, clergy, business figures, entertainers and athletes.`)}${closestBlock(P, u, PEOPLE, 'person', { topLabel: mine ? 'Your closest figure' : 'Closest figure' })}</section>

  <section class="sec">${secHead(N(), 'Closest countries, regions and regimes', 'Today\'s countries, the regions within them and historical regimes are ranked separately.')}
    ${countryNote(P, u, mine)}
    ${homeCountry(R, mine)}
    ${placeTabs(P, u, 'modern')}
  </section>



  ${mine ? `<section class="sec">
    ${secHead(N(), 'Compare', 'Send your result link to a friend who has taken the test, or paste theirs here. You will see both profiles side by side and the statements you both answered.' + (prev ? ' You can also look back at your earlier results.' : ''), 'friend', 'users')}
    ${friendBlock(R)}
    ${prev ? changedBlock(R, prev) : ''}
  </section>` : ''}

  <section class="sec">
    ${secHead(N(), 'Read next', 'Key texts of the ideologies and figures closest to you, in order of closeness.')}
    ${readNext(rk, people)}
  </section>

  <section class="sec note-sec">
    <p>Matches measure distance on twelve axes, not agreement with a whole worldview, and every placement in the catalogue is a judgement. <a class="link" href="#/method">How this works</a>.</p>
  </section>`;
  $('[data-act="share"]').addEventListener('click', () => shareResult(R, rk, people, countries, regimes));
}

/* ── how you've changed: earlier results are kept in this browser (newest last) ── */
function resultHistory() {
  let h = store.get('history', []) || [];
  if (!Array.isArray(h)) h = [];
  const cur = store.get('code', null);
  if (cur && !h.some(x => x.c === cur)) { h.push({ c: cur, t: 0 }); store.set('history', h); }   // a result from before history was kept
  return h.filter(x => x && resultFrom(x.c));
}
function remember(code, mode) {
  const h = (store.get('history', []) || []).filter(x => x && x.c !== code);
  h.push({ c: code, t: Date.now(), m: mode });
  store.set('history', h.slice(-20));
}
function previousResult(code) {
  const h = resultHistory(), i = h.findIndex(x => x.c === code);
  const p = i > 0 ? h[i - 1] : null;
  return p ? { ...p, R: resultFrom(p.c) } : null;
}
const whenOf = t => t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : 'an earlier test';
function changedBlock(R, prev) {
  const A = prev.R.P, B = R.P;
  const oldTop = E.rank(A, IDEOLOGIES, prev.R.u)[0], newTop = E.rank(B, IDEOLOGIES, R.u)[0];
  const moves = AXES.map((ax, k) => ({ ax, k, d: B[k] - A[k] })).filter(x => Math.abs(x.d) >= 5).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const same = oldTop.e.id === newTop.e.id;
  const moveTxt = moves.slice(0, 4).map(x => `<li class="b-${x.ax.b}"><span class="ax-ic">${icon(x.ax.k)}</span><b>${esc(x.ax.n)}</b> moved <b class="num">${Math.round(Math.abs(x.d))}</b> points toward <b>${esc(x.d > 0 ? x.ax.R : x.ax.L)}</b> <small class="muted num">(${Math.round(A[x.k])} → ${Math.round(B[x.k])})</small></li>`).join('');
  const earlier = resultHistory().filter(x => x.c !== R.code).slice(-5).reverse()
    .map(x => { const r = resultFrom(x.c), t = E.rank(r.P, IDEOLOGIES, r.u)[0]; return `<li><a href="#/r/${x.c}">${esc(whenOf(x.t))}</a> · ${esc(t.e.n)} <span class="num muted">${Math.round(t.m)}%</span> <a class="link" href="#/compare/@${x.c}/me?n=${encodeURIComponent('You, ' + whenOf(x.t))}">Compare</a></li>`; }).join('');
  return `<div class="earlier" id="changed">
    <div class="earlier-head">
      <h3>${icon('refresh')}Your earlier results</h3>
      <p class="chg-ideo">${same ? `Since ${esc(whenOf(prev.t))} your closest ideology is still <b>${esc(newTop.e.n)}</b>.` : `Since ${esc(whenOf(prev.t))}: <span class="muted">${esc(oldTop.e.n)}</span> <span class="chg-arrow" aria-label="became">→</span> <b>${esc(newTop.e.n)}</b>`}</p>
      <a class="btn primary" href="#/compare/@${prev.c}/me?n=${encodeURIComponent('You, ' + whenOf(prev.t))}">Compare with your last result</a>
    </div>
    <details class="earlier-more">
      <summary>See how you've changed</summary>
      ${moves.length ? `<ul class="chg-moves">${moveTxt}</ul>` : '<p class="muted">No axis has moved by more than five points. You\'re consistent.</p>'}
      ${driftBlock(R)}
      ${earlier ? `<h4 class="sub-h">All earlier results</h4><ul class="chg-list">${earlier}</ul>` : ''}
    </details>
  </div>`;
}

/* Over time: one small line per axis through every saved result up to this one (shown from three results on). */
function driftBlock(R) {
  const h = resultHistory(), i = h.findIndex(x => x.c === R.code);
  const series = (i < 0 ? h.concat([{ c: R.code, t: Date.now() }]) : h.slice(0, i + 1)).slice(-12);
  if (series.length < 3) return '';
  const Ps = series.map(x => x.c === R.code ? R.P : resultFrom(x.c).P);
  const W = 160, H = 46, pad = 5, n = Ps.length;
  const X = j => pad + j * (W - 2 * pad) / (n - 1), Y = v => pad + (100 - v) * (H - 2 * pad) / 100;
  const cells = AXES.map((ax, k) => {
    const v = Ps.map(P => P[k]), pts = v.map((y, j) => `${X(j).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
    const d = v[n - 1] - v[0], dir = Math.abs(d) < 5 ? 'steady' : `${Math.round(Math.abs(d))} toward ${d > 0 ? ax.R : ax.L}`;
    return `<figure class="drift-cell b-${ax.b}">
      <figcaption><b>${esc(ax.n)}</b><small class="muted">${esc(dir)}</small></figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ax.n)} across ${n} results: ${v.map(x => Math.round(x)).join(', ')}">
        <line class="mid" x1="${pad}" x2="${W - pad}" y1="${Y(50)}" y2="${Y(50)}"/>
        <polyline points="${pts}"/>
        ${v.map((y, j) => `<circle cx="${X(j).toFixed(1)}" cy="${Y(y).toFixed(1)}" r="${j === n - 1 ? 3.6 : 2.2}"${j === n - 1 ? ' class="now"' : ''}><title>${esc(whenOf(series[j].t))}: ${Math.round(y)}</title></circle>`).join('')}
      </svg>
      <div class="drift-ends num muted"><span>${Math.round(v[0])}</span><span>${Math.round(v[n - 1])}</span></div>
    </figure>`;
  }).join('');
  return `<h3 class="sub-h">Over time</h3>
    <p class="fine muted">Your last ${n} results, oldest on the left. The dashed line is the middle of each axis; up means toward the right-hand pole.</p>
    <div class="drift">${cells}</div>`;
}

/* ── comparing with a friend ── */
function resultLink(R) { return location.href.split('#')[0] + '#/r/' + R.code; }
function friendBlock(R, formOnly) {
  return `<div class="friend${formOnly ? ' solo' : ''}">
    ${formOnly ? '' : `<div class="fr-cell">
      <h3>${icon('link')}Your link</h3>
      <p>Anyone who opens it sees your result and can compare it with their own.</p>
      <div class="fr-copy"><input type="text" readonly value="${esc(resultLink(R))}" aria-label="Your result link"><button class="btn primary" type="button" data-act="copylink">Copy link</button></div>
      <p class="fine fr-status" aria-live="polite"></p>
    </div>`}
    <form class="fr-cell" data-friend>
      <h3>${icon('users')}Your friend's result</h3>
      <label><span>Their result link or code</span><input name="code" type="text" required autocomplete="off" spellcheck="false" placeholder="Paste the link they sent you"></label>
      <label><span>Their name <small>(optional)</small></span><input name="name" type="text" maxlength="30" autocomplete="off"></label>
      <button class="btn primary" type="submit">Compare</button>
      <p class="fine fr-err" aria-live="polite"></p>
    </form>
  </div>`;
}
function copyLink(btn) {
  const R = myResult(); if (!R) return;
  const box = btn.closest('.fr-cell'), inp = box && $('input', box), out = box && $('.fr-status', box), link = resultLink(R);
  const done = ok => { if (out) out.textContent = ok ? 'Copied. Send it to your friend.' : 'Copy the link above by hand.'; if (!ok && inp) inp.select(); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(() => done(true), () => done(false));
  else done(false);
}
function friendSubmit(form) {
  const code = codeFrom(form.elements.code.value), name = form.elements.name.value.trim().slice(0, 30), err = $('.fr-err', form);
  if (!code) { err.textContent = "That doesn't look like a result link from The Agora. Ask your friend to copy it again from their result page."; return; }
  if (code === store.get('code', null)) { err.textContent = 'That is your own result.'; return; }
  location.hash = `#/compare/me/@${code}${name ? '?n=' + encodeURIComponent(name) : ''}`;
}

/* Your opposites: the three least similar ideologies and people, each with the two axes where the gap is widest. */

/* Where you sit inside your closest ideology's family: the axes on which you stand furthest from the family's
   middle, as "further toward X than N of the M ideologies in the family". */
function familyLean(P, top, mine) {
  const fam = FAM[top.e.f], list = IDEOLOGIES.filter(e => e.f === top.e.f);
  if (list.length < 5) return '';
  const ap = E.apart(P, E.stats(list), false);
  const rows = ap.rows.filter(r => r.z >= 0.5 && Math.abs(r.x - r.med) >= 8).sort((a, b) => b.z - a.z).slice(0, 2);
  const who = mine ? 'You stand' : 'This result stands';
  if (!rows.length) return `<p class="fam-lean">${icon('users')}<span>${who} close to the middle of the ${list.length} ${esc(fam.n.toLowerCase())} ideologies on every axis.</span></p>`;
  const txt = rows.map(r => {
    const ax = AXES[r.k], left = r.x < r.med, n = list.filter(e => left ? e.a[r.k] > r.x : e.a[r.k] < r.x).length;
    const sideName = left ? ax.L : ax.R;
    return n === list.length ? `further toward <b>${esc(sideName)}</b> on ${esc(ax.n)} than every one of them`
      : `further toward <b>${esc(sideName)}</b> on ${esc(ax.n)} than ${n} of them`;
  });
  return `<p class="fam-lean">${icon('users')}<span>Among the ${list.length} ${esc(fam.n.toLowerCase())} ideologies, ${mine ? 'you lean' : 'this result leans'} ${txt.join(', and ')}.</span></p>`;
}

/* When the top ideologies are within a few points of each other, say so instead of crowning one. */
function tieNote(rk, mine) {
  const near = rk.slice(1, 3).filter(x => rk[0].m - x.m < 2.5);
  if (!near.length) return '';
  const names = [rk[0], ...near].map(x => `<a class="link" href="${hrefOf(x.e, 'ideology')}">${esc(x.e.n)}</a>`);
  const list = names.length === 2 ? names.join(' and ') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  return `<p class="tie">${icon('info')}<span>A near tie: ${mine ? 'you sit' : 'this result sits'} between ${list}, less than three points apart. ${mine ? 'Your' : 'These'} answers fit ${near.length > 1 ? 'all of them' : 'both'} about equally well${rk[0].e.f === near[0].e.f ? '' : ', even though they come from different families'}.</span></p>`;
}
function resultIdeologies(P, u, rk, top, mine) {
  const cards = rk.slice(0, 3).map((x, n) => {
    const f = FAM[x.e.f], first = firstSentence(x.e.d);
    return `<a class="ideo-card fam-${esc(x.e.f)}${n === 0 ? ' lead' : ''}" href="${hrefOf(x.e, 'ideology')}" style="--fc:${FAM_BG[x.e.f] || '#555'}">
      <span class="ic-top"><span class="ic-pill">${esc(f.n)}</span><span class="ic-m num">${Math.round(x.m)}<small>%</small></span></span>
      <b class="ic-name">${esc(x.e.n)}</b>
      <span class="ic-d">${esc(first)}</span>
      <span class="ic-more"><i>+</i>Learn more about ${esc(x.e.n)}</span>
    </a>`;
  }).join('');
  const far = rk[rk.length - 1];
  const who = mine ? 'You' : 'This result';
  return `${familyLean(P, top, mine)}<div class="ideo-cards">${cards}</div>
    <a class="ideo-far" href="${hrefOf(far.e, 'ideology')}" style="--fc:${FAM_BG[far.e.f] || '#555'}"><small>The ideology furthest from ${mine ? 'you' : 'this result'}</small>
      <b>${esc(far.e.n)}</b><span class="ic-pill">${esc(FAM[far.e.f].n)}</span><span class="num muted">${Math.round(far.m)}%</span></a>`;
}

/* Your values: the closest ideology on each area of politics, using only that area's axes (with a little weight
   on the overall match, so a pick is never far away on everything else). Each area gets a different ideology. */
const AREAS = [
  { n: 'Politics', ic: 'ru', ax: [0, 1, 2] }, { n: 'Foreign policy', ic: 'world', ax: [4, 5] }, { n: 'Immigration', ic: 'mi', ax: [3] },
  { n: 'Economy', ic: 'economy', ax: [6, 7, 8] }, { n: 'Society', ic: 'mo', ax: [9, 10] }, { n: 'Technology', ic: 'te', ax: [11] },
];
function valuesBlock(P, u, rk) {
  const overall = new Map(rk.map(x => [x.e.id, x.m])), used = new Set([rk[0].e.id]);
  const tiles = AREAS.map(a => {
    const r = E.rank(P, IDEOLOGIES, u, { axes: a.ax }).map(x => ({ e: x.e, s: 0.7 * x.m + 0.3 * overall.get(x.e.id) }))
      .filter(x => !used.has(x.e.id)).sort((x, y) => y.s - x.s);
    const pick = r[0]; used.add(pick.e.id);
    return `<a class="val-tile" href="${hrefOf(pick.e, 'ideology')}" style="--fc:${FAM_BG[pick.e.f] || '#555'}">
      <span class="val-ic">${icon(a.ic)}</span><small>${esc(a.n)}</small><b>${esc(pick.e.n)}</b></a>`;
  }).join('');
  return `<div class="val-grid">${tiles}</div>`;
}

const ANS = Object.fromEntries(E.SCALE.map(o => [o.a, o.n]));

/* Your core beliefs set beside your closest ideology's: where it agrees with you, where it parts ways, and how many
   ideologies share each belief you hold firmly. */
const BEL = Object.fromEntries((typeof BELIEFS !== 'undefined' ? BELIEFS : []).map(b => [b.k, b]));
const stanceWord = t => t === null || t === undefined ? 'takes no clear stance' : t >= 0.75 ? 'holds it' : t <= 0.25 ? 'rejects it' : 'is divided';
function beliefBlock(B, top, mine) {
  const ans = x => x >= 0.84 ? 'Strongly agree' : x >= 0.66 ? 'Agree' : x > 0.5 ? 'Slightly agree' : x === 0.5 ? 'Neutral' : x > 0.34 ? 'Slightly disagree' : x > 0.16 ? 'Disagree' : 'Strongly disagree';
  const rows = Object.entries(B).filter(([k]) => BEL[k]).map(([k, x]) => {
    const t = top.cr ? top.cr[k] : null, gap = t === null || t === undefined ? null : t === 0.5 ? 0.25 : Math.abs(x - t);
    const firm = Math.abs(x - 0.5) >= 0.3;
    const share = firm ? IDEOLOGIES.filter(e => e.cr && e.cr[k] !== null && e.cr[k] !== undefined && Math.abs(e.cr[k] - (x > 0.5 ? 1 : 0)) < 0.3) : [];
    return { k, x, t, gap, share };
  }).sort((a, b) => (b.gap === null ? -1 : b.gap) - (a.gap === null ? -1 : a.gap));
  if (!rows.length) return '';
  const row = r => `<li class="bel ${r.gap === null ? 'na' : r.gap <= 0.34 ? 'agree' : r.gap >= 0.5 ? 'differ' : 'part'}">
      <p class="bel-q">${esc(BEL[r.k].q)}</p>
      <p class="bel-a"><span class="ans-chip ${r.x > 0.5 ? 'agree' : r.x < 0.5 ? 'disagree' : 'neutral'}">${mine ? 'You' : 'Answer'}: ${ans(r.x)}</span>
        <span class="bel-t">${esc(top.n)} ${stanceWord(r.t)}</span></p>
      ${r.share.length ? `<p class="bel-s">${r.x > 0.5 ? 'Held' : 'Rejected'} by ${r.share.length} of the ${IDEOLOGIES.length} ideologies${r.share.length <= 6 ? `: ${r.share.map(e => `<a class="link" href="${hrefOf(e, 'ideology')}">${esc(e.n)}</a>`).join(', ')}` : ''}.</p>` : ''}
    </li>`;
  const differ = rows.filter(r => r.gap !== null && r.gap >= 0.5).length;
  return `<p class="bel-sum">${differ ? `${esc(top.n)} parts ways with ${mine ? 'you' : 'this result'} on <b class="num">${differ}</b> of the ${rows.length} core beliefs ${mine ? 'you' : 'it'} answered. It is still the closest overall, because the twelve axes count too.` : `${esc(top.n)} agrees with ${mine ? 'you' : 'this result'} on every core belief ${mine ? 'you' : 'it'} answered.`}</p>
    <ul class="bels">${rows.map(row).join('')}</ul>`;
}

/* ── entity profile ── */
function profileView(id) {
  const rec = BY.get(id);
  if (!rec) { setTitle('Not found'); view().innerHTML = `<section class="page-head"><h1>Not found</h1><p class="lede">There is no profile called “${esc(id)}”.</p></section>`; return; }
  const { e, kind } = rec; setTitle(e.n);
  const me = myResult();
  let side = '';
  if (kind === 'ideology') {
    const kf = e.k && BY.get(e.k), rc = e.r && BY.get(e.r);
    side = `${kf ? miniRef(kf.e, kf.kind, 'Key figure') : ''}${rc ? miniRef(rc.e, rc.kind, rc.kind === 'regime' ? 'Reference regime' : 'Reference country') : ''}`;
  } else {
    const ci = E.rank(e.a, IDEOLOGIES, null)[0];
    side = miniRef(ci.e, 'ideology', 'Closest ideology', ci.m);
    if (kind === 'person') { const cc = E.rank(e.a, NATIONS, null)[0]; side += miniRef(cc.e, 'country', 'Closest country today', cc.m); }
    else { const cp = E.rank(e.a, PEOPLE, null)[0]; side += miniRef(cp.e, 'person', 'Closest person', cp.m); }
    if (kind === 'person' && e.o && BY.get(e.o)) { const o = BY.get(e.o); side += miniRef(o.e, o.kind, 'Country'); }
    const par = kind === 'region' && parentOf(e);
    if (par) side += miniRef(par, 'country', 'Part of', E.match(e.a, par.a));
  }
  let mine = '';
  if (me) {
    const list = KINDS[kind].list, r = E.rank(me.P, list, me.u), pos = r.findIndex(x => x.e.id === e.id);
    const gaps = AXES.map((ax, k) => ({ ax, k, g: Math.abs(me.P[k] - e.a[k]) }));
    const chip = x => `<span class="far-ax b-${x.ax.b}">${icon(x.ax.k)}${esc(x.ax.n)} <b class="num">${Math.round(x.g)}</b></span>`;
    const near = gaps.slice().sort((a, b) => a.g - b.g).slice(0, 3), far = gaps.slice().sort((a, b) => b.g - a.g).slice(0, 3);
    mine = `<div class="you-match"><p>You: <b class="num">${Math.round(r[pos].m)}%</b> match, #${pos + 1} of ${list.length} ${esc(KINDS[kind].plural.toLowerCase())}. <a class="link" href="#/compare/me/${e.id}">Compare in detail</a></p>
      <p class="ym-axes"><small class="muted">Closest on</small> ${near.map(chip).join('')}</p>
      <p class="ym-axes"><small class="muted">Furthest on</small> ${far.map(chip).join('')}</p></div>`;
  }
  const meta = [];
  if (kind === 'ideology') { if (e.y) meta.push(['Origins', e.y]); if (e.t) meta.push(['Key texts', e.t]); }
  if (kind === 'person') { if (e.r) meta.push(['Role', e.r]); const ym = yearsMeta(e.y); if (ym) meta.push(ym); if (e.t) meta.push(['Key work', e.t]); }
  if (kind === 'country' || kind === 'region') { if (e.g) meta.push(['System', e.g]); meta.push(['Region', RGN[e.reg].n]); meta.push(['Described as of', 'October 2026']); }
  if (kind === 'regime') { if (e.g) meta.push(['System', e.g]); if (e.y) meta.push(['Years', e.y]); meta.push(['Era', ERA[e.e].n]); }
  view().innerHTML = `
  <section class="prof-head">
    <div class="ph-main">
      <p class="kicker">${esc(kindLabel(e, kind))} · <a href="${listHref(e, kind)}">${esc(groupLabel(e, kind))}</a></p>
      <h1>${esc(e.n)}</h1>
      <p class="lede">${esc(e.d || '')}</p>
      ${e.c ? `<blockquote class="credo"><span class="kicker">In one sentence</span>${esc(e.c)}</blockquote>` : ''}
      <dl class="meta">${meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${e.x ? `<p class="crit"><span class="kicker">Main criticism</span>${esc(e.x)}</p>` : ''}
      ${mine}
      <div class="cta"><a class="btn ghost" href="#/compare/${e.id}">Compare with…</a></div>
    </div>
    <aside class="ph-side">
      ${kind !== 'ideology' ? Pics.html(e, kind, 'ph-pic') : ''}
      ${glyph(e.a, { w: 240, hh: 72, bw: 14, gap: 4, gg: 12, h: 60, cls: 'big' })}
      <div class="refs">${side}</div>
    </aside>
  </section>
  <section class="sec">${secHead(1, 'Profile across the twelve axes')}<div class="axtable">${axisTable(e.a)}</div></section>
  <section class="sec">${secHead(2, 'On the classic compass')}${compassBlock(e.a, e.n.replace(/\s*\(.*\)$/, ''), kind === 'ideology' ? [] : E.rank(e.a, IDEOLOGIES, null).slice(0, 2).map(x => ({ e: x.e, kind: 'ideology' })), e.id)}</section>
  <section class="sec">${secHead(3, `What sets ${e.n} apart`, kind === 'region' ? `Compared with the ${NATIONS.length} countries.` : `Compared with the other ${KINDS[kind].list.length - 1} ${esc(KINDS[kind].plural.toLowerCase())}.`)}${kind === 'region' ? apartBlock(e.a, 'country', e.n, false) : apartBlock(e.a, kind, e.n, true)}</section>
  ${partsBlock(e, kind)}
  ${kind === 'ideology' ? stanceBlock(e) : ''}
  <section class="sec">${secHead(nextNo(), 'Closest ideologies')}${closestBlock(e.a, null, IDEOLOGIES, 'ideology', { skip: e.id })}</section>
  <section class="sec">${secHead(nextNo(), 'Closest people')}${closestBlock(e.a, null, PEOPLE, 'person', { skip: e.id })}</section>
  <section class="sec">${secHead(nextNo(), 'Closest countries, regions and regimes')}
    ${placeTabs(e.a, null, kind === 'regime' ? 'hist' : kind === 'region' ? 'regions' : 'modern', e.id)}
  </section>`;
}
let secNo = 3;
const nextNo = () => ++secNo;
// what an ideology holds on the core beliefs, on its profile page
function stanceBlock(e) {
  if (!e.cr) return '';
  const groups = [['Holds', t => t >= 0.75], ['Divided or in part', t => t > 0.25 && t < 0.75], ['Rejects', t => t <= 0.25]];
  const items = Object.entries(e.cr).filter(([k, t]) => t !== null && t !== undefined && BEL[k]);
  if (!items.length) return '';
  return `<section class="sec">${secHead(nextNo(), 'Core beliefs', 'Where this ideology stands on the named positions asked in the test. Beliefs on which it takes no clear stance are left out.')}
    <div class="stances">${groups.map(([h, f]) => { const l = items.filter(([, t]) => f(t)); return l.length ? `<div><h3 class="sub-h">${h}</h3><ul>${l.map(([k]) => `<li>${esc(BEL[k].q)}</li>`).join('')}</ul></div>` : ''; }).join('')}</div></section>`;
}
// the regions of a country in the catalogue, or the member states of the EU, ranked by closeness to the whole
const EU_MEMBERS = ['austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czechia', 'denmark', 'estonia', 'finland', 'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg', 'malta', 'netherlands', 'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden'];
function partsBlock(e, kind) {
  secNo = 3;
  let parts = [], title = '', sub = '', pk = 'region';
  if (kind === 'country') { parts = regionsOf(e.id); title = `Regions of ${e.n} in the catalogue`; sub = `How closely each matches ${e.n} as a whole.`; }
  else if (kind === 'region' && e.sub === 'union') { parts = EU_MEMBERS.map(id => BY.get(id)).filter(Boolean).map(r => r.e); pk = 'country'; title = 'Member states'; sub = `The ${parts.length} member states, ranked by how closely each matches the Union's own profile.`; }
  if (!parts.length) return '';
  const r = parts.map(p => ({ e: p, m: E.match(e.a, p.a) })).sort((a, b) => b.m - a.m);
  return `<section class="sec">${secHead(nextNo(), title, sub)}<div class="grid g4">${r.map(x => card(x.e, pk, x.m)).join('')}</div></section>`;
}
// three ranked tabs: countries, regions and unions, historical regimes
function placeTabs(P, user, active, skip) {
  const T = [['modern', 'country', 'Closest country'], ['regions', 'region', 'Closest region or union'], ['hist', 'regime', 'Closest historical regime']];
  return `${tabs('ctab', T.map(([t, k]) => [t, `${KINDS[k].plural} (${KINDS[k].list.length})`]), active)}
    ${T.map(([t, k, lbl]) => `<div class="tabpanel" data-panel="ctab:${t}"${t === active ? '' : ' hidden'}>${closestBlock(P, user, KINDS[k].list, k, { skip, topLabel: lbl })}</div>`).join('')}`;
}
function listHref(e, kind) {
  if (kind === 'ideology') return '#/ideologies?g=' + e.f;
  if (kind === 'person') return '#/people?g=' + e.f;
  if (kind === 'country') return '#/countries?t=modern&g=' + e.reg;
  if (kind === 'region') return '#/countries?t=regions&g=' + e.reg;
  return '#/countries?t=hist&g=' + e.e;
}
function miniRef(e, kind, label, m) {
  return `<a class="miniref" href="${hrefOf(e, kind)}">${kind === 'ideology' ? '' : Pics.html(e, kind, 'mr-pic')}<span><span class="kicker">${esc(label)}</span><b>${esc(e.n)}</b><small>${esc(subLabel(e, kind))}</small></span>${m != null ? `<span class="num mr-m">${Math.round(m)}%</span>` : ''}</a>`;
}

/* ── compare ── */
function profileOf(id, params) {
  if (id === 'me') { const R = myResult(); return R ? { id: 'me', n: 'You', a: R.P, kind: 'me', href: '#/result', R } : null; }
  if (id && id[0] === '@') {
    const R = resultFrom(id.slice(1)); if (!R) return null;
    const nm = params && params.get('n') ? params.get('n').trim().slice(0, 30) : '';
    return { id, n: nm || 'Your friend', a: R.P, kind: 'friend', href: '#/r/' + R.code, R };
  }
  const rec = BY.get(id); return rec ? { id, n: rec.e.n, a: rec.e.a, kind: rec.kind, e: rec.e, href: hrefOf(rec.e, rec.kind) } : null;
}
function compareView(a, b, params) {
  const A = profileOf(a, params), B = b ? profileOf(b, params) : null;
  setTitle('Compare');
  if (!A) { view().innerHTML = `<section class="page-head"><h1>Nothing to compare</h1><p class="lede">${a === 'me' ? 'Take the test first.' : a && a[0] === '@' ? 'That result link is incomplete.' : 'That profile does not exist.'}</p></section>`; return; }
  if (b && !B) { view().innerHTML = `<section class="page-head"><h1>Nothing to compare</h1><p class="lede">${b[0] === '@' ? "Your friend's result link is incomplete. Ask them to copy it again." : 'That profile does not exist.'}</p></section>`; return; }
  if (!B) {
    const me = A.kind === 'me';
    view().innerHTML = `<section class="page-head"><p class="kicker">Compare</p><h1>Compare ${esc(me ? 'yourself' : A.n)} with…</h1><p class="lede">Pick any ideology, person, country or regime${me ? ', or paste a friend\'s result link' : ''}.</p></section>
      ${me ? `<section class="sec fr-pick">${friendBlock(A.R, true)}</section>` : ''}<div id="pick-inline"></div>`;
    picker($('#pick-inline'), id => { location.hash = `#/compare/${a}/${id}`; }, a);
    return;
  }
  const m = E.match(A.a, B.a), diffs = AXES.map((ax, k) => ({ k, d: Math.abs(A.a[k] - B.a[k]) })).sort((x, y) => y.d - x.d);
  const near = diffs.filter(x => x.d <= 10).map(x => AXES[x.k].n);
  const side = (v, ax) => `${v < 50 ? ax.L : v > 50 ? ax.R : 'the middle'} (${Math.round(v)})`;
  const plural = P => P.kind === 'me';
  const who = P => P.e ? Pics.html(P.e, P.kind, 'cmp-pic') : `<span class="pic cmp-pic none cmp-ic">${icon(P.kind === 'me' ? 'star' : 'users')}</span>`;
  const topOf = P => P.R ? E.rank(P.a, IDEOLOGIES, P.R.u)[0] : null;
  const ta = topOf(A), tb = topOf(B);
  const tops = ta || tb ? `<p class="cmp-tops">${[[A, ta], [B, tb]].filter(([, t]) => t).map(([P, t]) => `<span>${esc(P.n)}: closest to <a href="${hrefOf(t.e, 'ideology')}">${esc(t.e.n)}</a> <span class="num">${Math.round(t.m)}%</span></span>`).join('')}</p>` : '';
  const qs = qsBoth(A, B);
  view().innerHTML = `
  <section class="page-head cmp-head">
    <p class="kicker">Compare</p>
    <div class="cmp-names">
      <a class="cmp-a" href="${A.href}">${who(A)}<span><i class="key-dot"></i><b>${esc(A.n)}</b></span></a>
      <span class="cmp-m"><span class="num">${Math.round(m)}%</span><small>match</small></span>
      <a class="cmp-b" href="${B.href}">${who(B)}<span><i class="key-ring"></i><b>${esc(B.n)}</b></span></a>
    </div>
    <p class="lede">${near.length ? `Within 10 points on ${near.length} of 12 axes: ${near.map(esc).join(', ')}.` : 'More than 10 points apart on every axis.'}</p>
    ${tops}
    <div class="cta"><a class="btn ghost" href="#/compare/${a}">Change the second profile</a><a class="btn text" href="#/compare/${b}/${a}${params && params.get('n') ? '?n=' + encodeURIComponent(params.get('n')) : ''}">Swap</a></div>
  </section>
  <section class="sec">${secHead(1, 'Side by side', `Filled dot: ${esc(A.n)} · Ring: ${esc(B.n)}`)}<div class="axtable">${axisTable(A.a, { other: B.a, otherLabel: B.n })}</div></section>
  <section class="sec">${secHead(2, 'Where they differ most')}
    <div class="diffs">${diffs.slice(0, 4).map(x => { const ax = AXES[x.k]; return `<div class="diff b-${ax.b}"><span class="num">${Math.round(x.d)}</span><p><span class="ax-ic">${icon(ax.k)}</span><b>${esc(ax.n)}</b>: ${esc(A.n)} ${plural(A) ? 'lean' : 'leans'} toward ${esc(side(A.a[x.k], ax))}, ${esc(B.n)} toward ${esc(side(B.a[x.k], ax))}.</p></div>`; }).join('')}</div>
  </section>
  ${qs}`;
}

// when both sides took the test: the statements both were asked, biggest disagreements first
function qsBoth(A, B) {
  if (!A.R || !B.R) return '';
  const rows = QUESTIONS.filter(q => typeof A.R.answers[q.id] === 'number' && typeof B.R.answers[q.id] === 'number')
    .map(q => ({ q, a: A.R.answers[q.id], b: B.R.answers[q.id] }));
  const head = secHead(3, 'Statements you both answered', '', 'both', 'users');
  if (!rows.length) return `<section class="sec">${head}<p class="muted">Each test draws its own statements from the bank, and these two attempts had none in common. The comparison above uses the positions on the twelve axes.</p></section>`;
  const same = rows.filter(r => r.a === r.b).length, opp = rows.filter(r => r.a * r.b < 0).length;
  const chip = a => `<span class="ans-chip ${a > 0 ? 'agree' : a < 0 ? 'disagree' : 'neutral'}">${esc(ANS[a])}</span>`;
  const line = r => { const ax = axOf(r.q); return `<div class="both-row b-${ax.b}">
      <p class="both-q"><span class="ax-ic" title="${esc(ax.n)}">${icon(ax.k === 'cr' ? 'layers' : ax.k)}</span>${esc(r.q.q)}</p>
      <div class="both-a"><span class="both-who"><i class="key-dot"></i>${esc(A.n)}</span>${chip(r.a)}</div>
      <div class="both-a"><span class="both-who"><i class="key-ring"></i>${esc(B.n)}</span>${chip(r.b)}</div>
    </div>`; };
  const far = rows.filter(r => r.a !== r.b).sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b)).slice(0, 8);
  const close = rows.filter(r => r.a === r.b && r.a !== 0).sort((x, y) => Math.abs(y.a) - Math.abs(x.a)).slice(0, 4);
  return `<section class="sec">${head}
    <p class="both-sum">The two attempts shared <b class="num">${rows.length}</b> statements. Same answer on <b class="num">${same}</b>; opposite sides on <b class="num">${opp}</b>.</p>
    ${far.length ? `<h3 class="sub-h">Furthest apart</h3><div class="both">${far.map(line).join('')}</div>` : ''}
    ${close.length ? `<h3 class="sub-h">Exactly the same answer</h3><div class="both">${close.map(line).join('')}</div>` : ''}
  </section>`;
}

// search-and-pick list (inline)
function picker(root, onPick, exclude) {
  const all = [];
  if (myResult() && exclude !== 'me') all.push({ id: 'me', n: 'You (your result)', kind: 'me', sub: 'Your latest result' });
  Object.entries(KINDS).forEach(([kind, K]) => K.list.forEach(e => { if (e.id !== exclude) all.push({ id: e.id, n: e.n, kind, sub: kindLabel(e, kind) + ' · ' + subLabel(e, kind), e }); }));
  root.innerHTML = `<label class="search wide"><span class="sr">Search</span><input type="search" placeholder="Type a name: Marxism, Sweden, Churchill…" autofocus></label><div class="pick-list"></div>`;
  const inp = $('input', root), out = $('.pick-list', root);
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    const hits = (q ? all.filter(x => x.n.toLowerCase().includes(q)) : all.filter(x => x.kind === 'me' || x.kind === 'ideology')).slice(0, 40);
    out.innerHTML = hits.map(x => `<button type="button" class="pick" data-id="${esc(x.id)}">${x.e && x.kind !== 'ideology' ? Pics.html(x.e, x.kind, 'pk-pic') : '<span class="pic pk-pic none"></span>'}<span><b>${esc(x.n)}</b><small>${esc(x.sub)}</small></span></button>`).join('') || '<p class="muted">No matches.</p>';
    Pics.scan(out);
  };
  inp.addEventListener('input', draw);
  out.addEventListener('click', ev => { const b = ev.target.closest('.pick'); if (b) onPick(b.dataset.id); });
  draw();
}

/* ── library: the key texts named in ideology and people profiles, merged into one reading list ── */
function buildLib() { return (() => {
  const norm = t => t.toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  // "Title — Author, 1848" · "Title (1867)" · "Title, c. 400 BC" · "Title"
  function parse(s) {
    s = s.trim();
    let m = s.match(/^(.*?)\s+—\s+(.*)$/);
    if (m) {
      const rest = m[2], c = rest.indexOf(',');
      return c < 0 ? { ti: m[1], au: rest } : { ti: m[1], au: rest.slice(0, c).trim(), yr: rest.slice(c + 1).trim() };
    }
    m = s.match(/^(.*?)\s*\(([^()]*\d[^()]*)\)\s*$/);
    if (m) { const w = m[2].split(/,\s*with\s+/); return { ti: m[1], yr: w[0], co: w[1] }; }
    m = s.match(/^(.*),\s*((?:c\.\s*)?\d[^,]*)$/);
    if (m) return { ti: m[1], yr: m[2] };
    return { ti: s };
  }
  // a sortable year: BC negative, "3rd century BC" → −250
  function yearNum(s) {
    if (!s) return null;
    const first = s.split('–')[0], bc = /BC/.test(first) || (/BC/.test(s) && !/AD/.test(s));
    let m = s.match(/(\d+)(?:st|nd|rd|th)\b/);
    if (m && /centur/i.test(s)) { const c = (+m[1] - 1) * 100 + 50; return bc ? -c : c; }
    m = s.match(/\d{1,4}/);
    return m ? (bc ? -m[0] : +m[0]) : null;
  }
  const byKey = new Map(), byRef = new Map();
  function add(raw, e, kind) {
    const p = parse(raw), key = norm(p.ti);
    if (!key) return;
    let x = byKey.get(key);
    if (!x) { x = { key, ti: p.ti, au: '', yr: '', yn: null, refs: [] }; byKey.set(key, x); }
    if (!x.au) x.au = p.au || (kind === 'person' ? e.n + (p.co ? ' with ' + p.co : '') : '');
    if (!x.yr && p.yr) { x.yr = p.yr; x.yn = yearNum(p.yr); }
    if (x.yn == null) {
      const inTitle = p.ti.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
      if (inTitle) x.yn = +inTitle[1];
      else if (kind === 'person' && e.y) { const y = yearNum(e.y); if (y != null) x.yn = /^d\./.test(e.y) ? y : y + 40; }
    }
    if (!x.refs.some(r => r.e.id === e.id)) x.refs.push({ e, kind });
    if (!byRef.has(e.id)) byRef.set(e.id, []);
    if (!byRef.get(e.id).includes(x)) byRef.get(e.id).push(x);
  }
  IDEOLOGIES.forEach(e => { if (e.t) e.t.split(/;\s+/).forEach(s => add(s, e, 'ideology')); });
  PEOPLE.forEach(e => { if (e.t) e.t.split(/;\s+/).forEach(s => add(s, e, 'person')); });
  const all = [...byKey.values()].sort((a, b) => (a.yn ?? 9999) - (b.yn ?? 9999) || a.ti.localeCompare(b.ti));
  const eraOf = x => x.yn == null ? null : x.yn < 500 ? 'anc' : x.yn < 1500 ? 'med' : x.yn < 1800 ? 'early' : x.yn < 1914 ? 'c19' : x.yn < 2000 ? 'c20' : 'c21';
  all.forEach(x => { x.era = eraOf(x); });
  return { all, byRef };
})(); }
let LIB = buildLib();

// one text: year, title and author, and the profiles it belongs to (with your match when given)
function libRow(x, ms) {
  const refs = x.refs.map(r => `<a href="${hrefOf(r.e, r.kind)}">${esc(r.e.n)}${ms && ms.has(r.e.id) ? ` <span class="num">${Math.round(ms.get(r.e.id))}%</span>` : ''}</a>`).join('');
  return `<div class="lib-row"><span class="lib-yr num">${esc(x.yr || '')}</span>
    <span class="lib-main"><cite>${esc(x.ti)}</cite>${x.au ? `<span class="lib-au">${esc(x.au)}</span>` : ''}</span>
    <span class="lib-refs">${refs}</span></div>`;
}

// result page: key texts of your closest ideologies and closest figures
function readNext(rk, people) {
  const pick = (ranked, n) => {
    const seen = new Set(), out = [];
    for (const r of ranked) {
      for (const x of (LIB.byRef.get(r.e.id) || [])) { if (!seen.has(x.key)) { seen.add(x.key); out.push(x); break; } }
      if (out.length >= n) break;
    }
    return out;
  };
  const ms = new Map([...rk.map(x => [x.e.id, x.m]), ...people.map(x => [x.e.id, x.m])]);
  const a = pick(rk, 5), keys = new Set(a.map(x => x.key));
  const b = pick(people.filter(p => !(LIB.byRef.get(p.e.id) || []).every(x => keys.has(x.key))), 5);
  const col = (title, list) => `<div><h3 class="sub-h">${title}</h3><div class="lib">${list.map(x => libRow(x, ms)).join('') || '<p class="muted">None listed.</p>'}</div></div>`;
  return `<div class="read2">${col('From your closest ideologies', a)}${col('By your closest figures', b)}</div>
    <p class="more"><a class="link" href="#/library">Browse the library of ${LIB.all.length} texts</a></p>`;
}

/* ── library page ── */
function libraryView(params) {
  setTitle('Library');
  const me = myResult(), q = (params.get('q') || '').toLowerCase(), g = params.get('g') || '';
  const sort = me && params.get('s') === 'me' ? 'me' : 'yr';
  const ms = me ? new Map([...E.rank(me.P, IDEOLOGIES, me.u), ...E.rank(me.P, PEOPLE, me.u)].map(x => [x.e.id, x.m])) : null;
  const best = x => Math.max(...x.refs.map(r => ms.get(r.e.id) || 0));
  const hit = x => !q || (x.ti + ' ' + x.au + ' ' + x.refs.map(r => r.e.n).join(' ')).toLowerCase().includes(q);
  const link = o => { const p = new URLSearchParams(params); Object.entries(o).forEach(([k, v]) => v ? p.set(k, v) : p.delete(k)); const s = p.toString(); return '#/library' + (s ? '?' + s : ''); };
  const counts = {}; LIB.all.forEach(x => { counts[x.era] = (counts[x.era] || 0) + 1; });
  let body;
  if (sort === 'me') {
    const list = LIB.all.filter(hit).sort((a, b) => best(b) - best(a)).slice(0, 60);
    body = `<p class="count">The ${list.length} texts whose profiles are closest to your result</p><div class="lib">${list.map(x => libRow(x, ms)).join('')}</div>`;
  } else {
    const list = LIB.all.filter(x => hit(x) && (!g || x.era === g));
    const groups = [...ERAS.map(er => [er.n, er.y, list.filter(x => x.era === er.k)]), ['Undated', '', list.filter(x => !x.era)]].filter(gr => gr[2].length);
    body = `<p class="count">${list.length} texts${q ? ` for “${esc(q)}”` : ''}</p>` + (groups.map(([n, y, rows]) =>
      `<h2 class="lib-era">${esc(n)}${y ? ` <span>${esc(y)}</span>` : ''}</h2><div class="lib">${rows.map(x => libRow(x, ms)).join('')}</div>`).join('') || '<p class="muted">Nothing matches.</p>');
  }
  view().innerHTML = `
  <section class="page-head"><p class="kicker">Library</p><h1>Key texts</h1>
    <p class="lede">The founding texts and key works named in the profiles of ideologies and people, from ancient China and Greece to the present. Each links to the profiles it belongs to; the year is that of first publication unless stated.</p></section>
  <div class="toolbar">
    <label class="search"><span class="sr">Search</span><input type="search" id="lib-q" placeholder="Search titles, authors or profiles…" value="${esc(params.get('q') || '')}"></label>
    ${me ? `<div class="seg sm" aria-label="Sort"><a href="${link({ s: '' })}" class="${sort === 'yr' ? 'on' : ''}">By date</a><a href="${link({ s: 'me', g: '' })}" class="${sort === 'me' ? 'on' : ''}">Closest to me</a></div>` : ''}
  </div>
  ${sort === 'yr' ? `<div class="chips"><a href="${link({ g: '' })}" class="${!g ? 'on' : ''}">All <span class="num">${LIB.all.length}</span></a>${ERAS.filter(er => counts[er.k]).map(er =>
    `<a href="${link({ g: er.k })}" class="${g === er.k ? 'on' : ''}">${esc(er.n)} <span class="num">${counts[er.k]}</span></a>`).join('')}</div>` : ''}
  ${body}`;
  const inp = $('#lib-q');
  let t = null;
  inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { const p = new URLSearchParams(params); inp.value ? p.set('q', inp.value) : p.delete('q'); history.replaceState(null, '', '#/library' + (p.toString() ? '?' + p : '')); libraryView(p); const i2 = $('#lib-q'); i2.focus(); i2.setSelectionRange(i2.value.length, i2.value.length); }, 180); });
}

/* ── #/pictures: a maintenance page, not linked from the menu. It tries every picture you set yourself with img:
   and lists the ones that no longer load, plus the links on hosts whose addresses tend to expire. An entry with a
   broken link still falls back to its flag, its Wikipedia picture or a lettered tile, so nothing breaks. ── */
const PIC_RISKY = [
  [/fbcdn\.net|cdninstagram\.com/, 'Instagram link: these stop working after a few days'],
  [/encrypted-tbn\d\.gstatic\.com/, 'Google search thumbnail: small, and can disappear without warning'],
  [/preview\.redd\.it|external-preview\.redd\.it/, 'Reddit preview link: stops working if the post is removed'],
  [/wixmp\.com.*token=/, 'DeviantArt link with an access token'],
  [/licdn\.com/, 'LinkedIn profile picture link'],
];
function picturesView() {
  setTitle('Picture check');
  const all = [...BY.values()].filter(x => x.e.img);
  const risky = all.map(x => ({ x, why: (PIC_RISKY.find(r => r[0].test(x.e.img)) || [])[1] })).filter(r => r.why);
  const row = (x, note) => `<li><a class="link" href="${hrefOf(x.e, x.kind)}">${esc(x.e.n)}</a> <span class="muted">· ${esc(note)}</span><br><code>${esc(x.e.img.length > 90 ? x.e.img.slice(0, 90) + '…' : x.e.img)}</code></li>`;
  view().innerHTML = `<section class="page-head"><p class="kicker">Maintenance</p><h1>Picture check</h1>
    <p class="lede">This page tries all ${all.length} pictures set with <code>img:</code> in the data files and lists the ones that don't load. An entry with a broken link still shows its flag, its Wikipedia picture or a lettered tile.</p></section>
  <div class="wrap pc">
    <h2>Links that failed just now</h2>
    <p id="pc-status" class="muted" aria-live="polite">${DATA.more ? 'Checking…' : 'Waiting for the rest of the data…'}</p>
    <ul id="pc-bad" class="pc-list"></ul>
    <h2>Links likely to break later</h2>
    <p class="muted">${risky.length ? 'These work today, but come from places whose addresses change or expire. A file saved in the site folder (like <code>img:"samed.png"</code>) or a link from upload.wikimedia.org is safer.' : 'None.'}</p>
    <ul class="pc-list">${risky.map(r => row(r.x, r.why)).join('')}</ul>
  </div>`;
  if (!DATA.more) return;
  let left = all.length, bad = 0;
  const done = (x, ok) => {
    if (!ok) { bad++; const ul = $('#pc-bad'); if (ul) ul.insertAdjacentHTML('beforeend', row(x, 'did not load')); }
    left--; const s = $('#pc-status');
    if (s) s.textContent = left ? `Checking… ${all.length - left} of ${all.length}` : bad ? `${bad} of ${all.length} pictures did not load.` : `All ${all.length} pictures loaded.`;
  };
  all.forEach(x => {
    const im = new Image(); let settled = false;
    const end = ok => { if (settled) return; settled = true; done(x, ok); };
    im.referrerPolicy = 'no-referrer'; im.onload = () => end(im.naturalWidth > 0); im.onerror = () => end(false);
    setTimeout(() => end(false), 15000);
    im.src = x.e.img;
  });
}

/* ── share image (canvas): a poster in the colour of your ideology's family ──
   Header · family and ideology · closest person as a large portrait beside your twelve axes ·
   other close people and countries · footer with the site's address. Drawn for 'post' (4:5) and 'story' (9:16). */
const FONT = '"Archivo", "Helvetica Neue", Arial, sans-serif';
// one deep background colour per ideology family, light enough for white text to read well
const FAM_BG = {
  marx: '#8c1420', soc: '#9b2a2a', anar: '#26262b', lib: '#1f4f8a', cons: '#173a63', libt: '#8a6a0a',
  nat: '#4d2a73', auth: '#5a3218', fasc: '#2e2e33', rel: '#4a3080', green: '#1b5c3a', tech: '#0f4a66', phil: '#5c4a2a',
};
// lighter block colours that stay readable on a dark background
const SHARE_COL = { power: '#ff7a5c', world: '#8ea4ff', economy: '#46d39a', culture: '#ec8ad8' };

function shareResult(R, rk, people, countries, regimes) {
  const top = rk[0];
  const bg = FAM_BG[top.e.f] || '#2b2b30';
  ShareCard.open({
    filename: 'the-agora-' + top.e.id,
    title: 'The Agora',
    text: `My closest ideology on The Agora: ${top.e.n}, ${Math.round(top.m)}% match.`,
    theme: { bg: '#141416', surface: '#1e1e22', ink: '#f2f2f2', muted: '#a8a8a8', line: '#3a3a40', accent: bg, accentInk: '#ffffff' },
    draw: (ctx, W, H, format, h) => drawCard(ctx, W, H, format, h, { R, rk, people, countries, regimes, bg }),
  });
}

// axis icons as images: the same line icons as on the site, stroked in white
const iconCache = {};
function iconImage(name) {
  if (iconCache[name]) return iconCache[name];
  const p = ICONS[name] || '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  return (iconCache[name] = new Promise(res => {
    const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null);
    im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }));
}

async function drawCard(ctx, W, H, format, h, d) {
  const story = format === 'story', M = 60;
  const f = (wt, sz, st) => { ctx.font = `${wt} ${sz}px ${FONT}`; if ('fontStretch' in ctx) ctx.fontStretch = st || 'normal'; };
  const track = (t, x, y, sp, align) => {        // letter-spaced uppercase label
    let w = 0; for (const ch of t) w += ctx.measureText(ch).width + sp; w -= sp;
    let cx = align === 'right' ? x - w : x;
    for (const ch of t) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + sp; }
    return w;
  };
  const panel = (x, y, w, hh, r) => { h.round(ctx, x, y, w, hh, r || 22); ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 2; ctx.stroke(); };
  const WHITE = '#ffffff', SOFT = 'rgba(255,255,255,0.72)', FAINT = 'rgba(255,255,255,0.5)';
  const top = d.rk[0], P = d.R.P;
  const person = d.people[0], others = d.people.slice(1, 4), nations = d.countries.slice(0, 3);

  // background: family colour, a soft light circle in the corner and a gentle darkening toward the bottom
  ctx.fillStyle = d.bg; ctx.fillRect(0, 0, W, H);
  // the Agora's motif: four little columns of squares, one per part of the map, filled to your average lean there
  const cs = story ? 26 : 20, gp = story ? 8 : 7, rows = 6, gx = W - M - 12 * (cs + gp) + gp - (story ? 6 : 0), gy = story ? 150 : 124;
  {
    AXES.forEach((ax, k) => {
      const lean = Math.abs(d.R.P[k] - 50) / 50, fill = Math.max(1, Math.round(lean * rows)), x = gx + (k + Math.floor(k / 3) * 0.6) * (cs + gp) - Math.floor(k / 3) * gp * 0.4;
      for (let r = 0; r < rows; r++) {
        const y = gy + (rows - 1 - r) * (cs + gp); h.round(ctx, x, y, cs, cs, 5);
        ctx.fillStyle = r < fill ? hexA(SHARE_COL[ax.b], 0.55) : 'rgba(255,255,255,0.06)'; ctx.fill();
      }
    }); }
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // header
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  let y = story ? 104 : 88;
  // logo: four coloured bars, as in the site's header
  const lg = story ? 34 : 28, lw0 = Math.round(lg * 0.2);
  [[0.55, 'power'], [0.95, 'world'], [0.45, 'economy'], [0.75, 'culture']].forEach(([hh, b], i) => {
    h.round(ctx, M + i * (lw0 + 4), y - lg * hh, lw0, lg * hh, 2); ctx.fillStyle = SHARE_COL[b]; ctx.fill();
  });
  const lx = M + 4 * (lw0 + 4) + 10;
  f(800, story ? 40 : 34, 'expanded'); ctx.fillStyle = WHITE; ctx.fillText('The Agora', lx, y);
  const bw = ctx.measureText('The Agora').width + (lx - M);
  f(700, story ? 20 : 17); ctx.fillStyle = SOFT;
  const rw = track('MY RESULT', W - M, y - 4, 3, 'right');
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(M + bw + 28, y - 13, W - 2 * M - bw - rw - 56, 2);

  // family and ideology
  y += story ? 92 : 70;
  f(700, story ? 24 : 21); ctx.fillStyle = SOFT; track(FAM[top.e.f].n.toUpperCase(), M, y, 3);
  let size = story ? 92 : 74, lines;
  const titleW = gx - M - 28;   // keep the title clear of the square motif
  for (;; size -= 2) { f(800, size, 'expanded'); lines = wrapLines(ctx, top.e.n, titleW); if ((lines.length <= 2 && lines.every(l => ctx.measureText(l).width <= titleW)) || size <= 36) break; }
  ctx.fillStyle = WHITE; lines.slice(0, 2).forEach(l => { y += size * 1.02; ctx.fillText(l, M, y); });
  f(600, story ? 24 : 21); ctx.fillStyle = SOFT; y += story ? 50 : 44;
  ctx.fillText(`${Math.round(top.m)}% match · ${d.R.u.answered} statements${d.R.mode === 'quick' ? ' · quick test' : d.R.mode === 'full' ? ' · full test' : ''}`, M, y);

  // main row: closest person (left) and the twelve axes (right)
  const foot = story ? 120 : 92, botH = story ? 400 : 286, gap = 22;
  const mainTop = y + (story ? 40 : 30), mainH = H - foot - botH - gap - mainTop;
  const lw = Math.round((W - 2 * M - gap) * 0.43), rx = M + lw + gap, rwid = W - M - rx;

  // portrait panel
  h.round(ctx, M, mainTop, lw, mainH, 22); ctx.save(); ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(M, mainTop, lw, mainH);
  const img = person ? await Pics.image(person.e, 'person', u => h.loadImage(u, null)) : null;
  if (img) {
    const sc = Math.max(lw / img.naturalWidth, mainH / img.naturalHeight), iw = img.naturalWidth * sc, ih = img.naturalHeight * sc;
    ctx.drawImage(img, M + (lw - iw) / 2, mainTop + Math.min(0, (mainH - ih) * 0.2), iw, ih);
  } else if (person) {
    f(800, 120, 'expanded'); ctx.fillStyle = FAINT; ctx.textAlign = 'center'; ctx.fillText(Pics.initials(person.e.n), M + lw / 2, mainTop + mainH * 0.45); ctx.textAlign = 'left';
  }
  // tint toward the family colour at the bottom, so the text sits on colour
  const pg = ctx.createLinearGradient(0, mainTop + mainH * 0.35, 0, mainTop + mainH);
  pg.addColorStop(0, hexA(d.bg, 0)); pg.addColorStop(0.55, hexA(d.bg, 0.82)); pg.addColorStop(1, hexA(d.bg, 0.97));
  ctx.fillStyle = pg; ctx.fillRect(M, mainTop, lw, mainH);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 2; h.round(ctx, M, mainTop, lw, mainH, 22); ctx.stroke();
  if (person) {
    // from the bottom up: role, name (one or two lines), label, percentage
    const px = M + 28, tw = lw - 56;
    let py = mainTop + mainH - (story ? 34 : 26);
    const role = person.e.r || '';
    f(500, story ? 22 : 18); ctx.fillStyle = SOFT;
    let rl = role; while (rl.length > 3 && ctx.measureText(rl).width > tw) rl = rl.slice(0, -2);
    if (rl !== role) rl = rl.replace(/[\s,;:]+$/, '') + '…';
    ctx.fillText(rl, px, py);
    const ns = story ? 38 : 30, lh = ns * 1.1;
    f(800, ns); ctx.fillStyle = WHITE;
    const nl = wrapLines(ctx, person.e.n, tw).slice(0, 2);
    py -= (story ? 34 : 28);
    for (let i = nl.length - 1; i >= 0; i--) { ctx.fillText(nl[i], px, py, tw); py -= lh; }
    py -= (story ? 6 : 4);
    f(700, story ? 18 : 15); ctx.fillStyle = SOFT; track('CLOSEST PERSON', px, py, 2.5);
    py -= (story ? 32 : 26);
    f(800, story ? 84 : 64, 'expanded'); ctx.fillStyle = WHITE; ctx.fillText(Math.round(person.m) + '%', px - 2, py);
  }

  // twelve axes panel, grouped by the four parts of the map; bars run from the centre toward the side you lean to
  panel(rx, mainTop, rwid, mainH);
  const ip = story ? 26 : 22;
  f(700, story ? 18 : 15); ctx.fillStyle = SOFT; track('YOUR 12 AXES', rx + ip, mainTop + (story ? 46 : 38), 2.5);
  const headH = story ? 34 : 26, rowsTop = mainTop + (story ? 66 : 52);
  const rowH = (mainH - (rowsTop - mainTop) - (story ? 14 : 10) - headH * 4) / 12;
  const icons = await Promise.all(AXES.map(a => iconImage(a.k)));
  const IS = Math.min(story ? 40 : 30, rowH - 8), barW = story ? 132 : 100, valW = story ? 70 : 56;
  let cy0 = rowsTop;
  BLOCKS.forEach((bl, bi) => {
    const col = SHARE_COL[bl.k];
    f(800, story ? 16 : 13); ctx.fillStyle = col; track(bl.n.toUpperCase(), rx + ip, cy0 + headH * 0.68, 2.5);
    ctx.fillStyle = hexA(col, 0.35); ctx.fillRect(rx + ip + ctx.measureText(bl.n.toUpperCase()).width + 2.5 * bl.n.length + 10, cy0 + headH * 0.5, rwid - ip * 2 - ctx.measureText(bl.n.toUpperCase()).width - 2.5 * bl.n.length - 10, 2);
    cy0 += headH;
    AXES.filter(ax => ax.b === bl.k).forEach(ax => {
      const k = AXES.indexOf(ax), cy = cy0 + rowH / 2, p = P[k];
      const side = p < 50 ? ax.L : p > 50 ? ax.R : 'Centre', pct = Math.round(Math.max(p, 100 - p));
      h.round(ctx, rx + ip, cy - IS / 2, IS, IS, 8); ctx.fillStyle = hexA(col, 0.3); ctx.fill();
      if (icons[k]) ctx.drawImage(icons[k], rx + ip + IS * 0.18, cy - IS * 0.32, IS * 0.64, IS * 0.64);
      const tx = rx + ip + IS + 14, tmax = rwid - ip * 2 - IS - 14 - barW - valW - 18;
      let fs = story ? 24 : 19; f(600, fs); while (fs > 13 && ctx.measureText(side).width > tmax) { fs -= 1; f(600, fs); }
      ctx.fillStyle = WHITE; ctx.fillText(side, tx, cy + fs * 0.36);
      // two-way bar: track, centre tick, and a fill from the centre to your position
      const bx = rx + rwid - ip - valW - barW - 10, mid = bx + barW / 2, px = bx + barW * p / 100;
      h.round(ctx, bx, cy - 3, barW, 6, 3); ctx.fillStyle = 'rgba(255,255,255,0.13)'; ctx.fill();
      ctx.fillStyle = col; ctx.fillRect(Math.min(mid, px), cy - 3, Math.max(2, Math.abs(px - mid)), 6);
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(mid - 1, cy - 8, 2, 16);
      ctx.beginPath(); ctx.arc(px, cy, story ? 7 : 6, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = d.bg; ctx.stroke();
      f(800, story ? 25 : 20); ctx.fillStyle = col; ctx.textAlign = 'right'; ctx.fillText(pct + '%', rx + rwid - ip, cy + (story ? 9 : 7)); ctx.textAlign = 'left';
      cy0 += rowH;
    });
  });

  // bottom row: other people and nearest countries
  const by = mainTop + mainH + gap, half = (W - 2 * M - gap) / 2;
  const listPanel = async (x, title, items, kind) => {
    panel(x, by, half, botH);
    f(700, story ? 18 : 15); ctx.fillStyle = SOFT; track(title, x + ip, by + (story ? 46 : 38), 2.5);
    const t0 = by + (story ? 72 : 56), rh = (botH - (t0 - by) - (story ? 14 : 10)) / 3;
    for (let i = 0; i < items.length; i++) {
      const it = items[i], cy = t0 + rh * i + rh / 2, flag = kind !== 'person';
      const ih = Math.min(story ? 72 : 52, rh - 14), iw = flag ? Math.round(ih * 1.45) : ih;
      const im = await Pics.image(it.e, kind, u => h.loadImage(u, null));
      ctx.save();
      if (flag) h.round(ctx, x + ip, cy - ih / 2, iw, ih, 6); else { ctx.beginPath(); ctx.arc(x + ip + ih / 2, cy, ih / 2, 0, Math.PI * 2); }
      ctx.clip(); ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(x + ip, cy - ih / 2, iw, ih);
      if (im) { const sc = Math.max(iw / im.naturalWidth, ih / im.naturalHeight), w = im.naturalWidth * sc, hh = im.naturalHeight * sc; ctx.drawImage(im, x + ip + (iw - w) / 2, flag ? cy - hh / 2 : cy - ih / 2, w, hh); }
      else { f(800, ih * 0.38); ctx.fillStyle = WHITE; ctx.textAlign = 'center'; ctx.fillText(Pics.initials(it.e.n), x + ip + iw / 2, cy + ih * 0.13); ctx.textAlign = 'left'; }
      ctx.restore();
      const nx = x + ip + iw + 16, pw = story ? 84 : 66, nmax = half - ip * 2 - iw - 16 - pw;
      let fs = story ? 26 : 21; f(700, fs);
      let nl = wrapLines(ctx, it.e.n, nmax);
      while (nl.length > 2 && fs > 15) { fs -= 1; f(700, fs); nl = wrapLines(ctx, it.e.n, nmax); }
      nl = nl.slice(0, 2); ctx.fillStyle = WHITE;
      const lh = fs * 1.15, sy = cy - (nl.length - 1) * lh / 2 + fs * 0.36;
      nl.forEach((l, j) => ctx.fillText(l, nx, sy + j * lh, nmax));
      f(800, story ? 28 : 22); ctx.textAlign = 'right'; ctx.fillText(Math.round(it.m) + '%', x + half - ip, cy + (story ? 10 : 8)); ctx.textAlign = 'left';
    }
  };
  await listPanel(M, 'OTHER PEOPLE', others, 'person');
  await listPanel(M + half + gap, 'NEAREST COUNTRIES', nations, 'country');

  // footer
  const fy = H - foot / 2 + 8;
  ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(M, H - foot + 6, W - 2 * M, 2);
  f(700, story ? 20 : 17); ctx.fillStyle = SOFT; track('FIND YOUR PLACE', M, fy, 3);
  const site = /^https?:/.test(location.protocol) && location.host ? location.host.replace(/^www\./, '') : 'The Agora';
  f(800, story ? 24 : 20); ctx.fillStyle = WHITE; track(site.toUpperCase(), W - M, fy, 2, 'right');
}

// a hex colour with transparency
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function wrapLines(ctx, text, maxW) {
  const words = String(text).split(/\s+/), out = []; let line = '';
  words.forEach(w => { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; });
  if (line) out.push(line);
  return out;
}

/* ── router, events, theme ── */
function route() {
  const raw = (location.hash || '#/').slice(1);
  const [pathQ] = raw.split('#');
  const [path, qs] = pathQ.split('?');
  const parts = path.split('/').filter(Boolean), params = new URLSearchParams(qs || '');
  const head = parts[0] || '';
  document.body.dataset.view = head || 'home';
  $$('.mast nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === (head === 'i' ? 'ideologies' : head === 'p' ? 'people' : head === 'c' ? 'countries' : head)));
  if (head !== 'test') quiz = null;
  if (head === '') homeView();
  else if (head === 'test') { const m = params.get('m'); if (quiz && (!m || quiz.mode === m)) quizView(); else startQuiz(m, false); }
  else if (head === 'result') resultView(null);
  else if (head === 'r') resultView(parts[1]);
  else if (head === 'ideologies') listView('ideology', params);
  else if (head === 'people') listView('person', params);
  else if (head === 'countries') listView(params.get('t') === 'hist' ? 'regime' : params.get('t') === 'regions' ? 'region' : 'country', params);
  else if (head === 'library') libraryView(params);
  else if (head === 'i' || head === 'p' || head === 'c') profileView(parts[1]);
  else if (head === 'compare') compareView(parts[1], parts[2], params);
  else if (head === 'axes') axesView();
  else if (head === 'method') methodView();
  else if (head === 'pictures') picturesView();
  else homeView();
  if (!(head === 'axes' && raw.includes('#'))) window.scrollTo(0, 0);
  Pics.scan(view());
  dataNote();
  pageToc(head === 'result' || head === 'r');
  const h1 = $('h1', view()); if (h1 && head !== 'test') { h1.setAttribute('tabindex', '-1'); }
}

/* "On this page": a numbered list of the result page's sections that follows you as you scroll and marks
   where you are. Shown beside the page on wide screens only. */
const TOC_SHORT = { 'Your profile across the twelve axes': '12 axes', "How you've changed": 'Changes', 'On the classic compass': 'Compass',
  'Closest ideologies': 'Ideologies', 'Your core beliefs': 'Beliefs', 'Closest people': 'People', 'Closest countries, regions and regimes': 'Countries',
  'Compare': 'Compare', 'Read next': 'Books' };
let tocObs = null;
function pageToc(on) {
  let nav = $('#toc'); if (tocObs) { tocObs.disconnect(); tocObs = null; }
  if (!on) { if (nav) nav.remove(); return; }
  const heads = $$('.sec-head', view()); if (!heads.length) { if (nav) nav.remove(); return; }
  const secs = heads.map(h => h.closest('.sec') || h);
  secs.forEach((el, i) => { if (!el.id) el.id = 'sec-' + (i + 1); });
  if (!nav) { nav = document.createElement('nav'); nav.id = 'toc'; nav.className = 'toc'; nav.setAttribute('aria-label', 'On this page'); document.body.appendChild(nav); }
  nav.innerHTML = `<p class="toc-h">On this page</p><ol>${heads.map((h, i) => { const t = $('h2', h).textContent;
    return `<li><a href="#" data-toc="${secs[i].id}"><span class="num">${pad2(i + 1)}</span>${esc(TOC_SHORT[t] || t)}</a></li>`; }).join('')}</ol>`;
  nav.onclick = ev => { const a = ev.target.closest('[data-toc]'); if (!a) return; ev.preventDefault();
    const el = document.getElementById(a.dataset.toc); if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); };
  const links = $$('[data-toc]', nav);
  // the current section is the last one whose top has passed a third of the way down the window
  const mark = () => { let cur = 0; secs.forEach((el, k) => { if (el.getBoundingClientRect().top < innerHeight * 0.35) cur = k; });
    links.forEach((a, k) => a.classList.toggle('on', k === cur)); };
  let raf = 0; const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; mark(); }); };
  window.addEventListener('scroll', onScroll, { passive: true });
  tocObs = { disconnect: () => window.removeEventListener('scroll', onScroll) };
  mark();
}

document.addEventListener('click', ev => {
  const t = ev.target.closest('[data-act],[data-tab],[data-help],.lk');
  if (!t) return;
  if (t.classList.contains('lk')) { choose(+t.dataset.a); return; }
  if (t.dataset.tab) {
    const bar = t.closest('[data-tabs]'), id = bar.dataset.tabs;
    $$('[role="tab"]', bar).forEach(b => b.setAttribute('aria-selected', String(b === t)));
    $$(`[data-panel^="${id}:"]`).forEach(p => { p.hidden = p.dataset.panel !== `${id}:${t.dataset.tab}`; });
    Pics.scan(view()); return;
  }
  if (t.dataset.help != null) { axisHelp(+t.dataset.help); return; }
  const act = t.dataset.act;
  if (act === 'restart') {
    ev.preventDefault();
    const p = savedQuiz(), m = E.MODES[t.dataset.mode] ? t.dataset.mode : (quiz && quiz.mode) || (p && p.mode) || 'full';
    store.del('progress'); quiz = null;
    const h = '#/test?m=' + m;
    if (location.hash === h) startQuiz(m, true); else location.hash = h;
  }
  else if (act === 'seed') {
    // answer the home page statement and continue in the quick test
    store.set('seed', { id: t.dataset.id, a: Number(t.dataset.a) }); store.del('progress'); quiz = null;
    if (location.hash === '#/test?m=quick') startQuiz('quick', true); else location.hash = '#/test?m=quick';
  }
  else if (act === 'about') aboutQ();
  else if (act === 'copylink') copyLink(t);
  else if (act === 'back') backQ();
  else if (act === 'star') starQ();
  else if (act === 'swap') swapQ();
  else if (act === 'skip') skipQ();
  else if (act === 'theme') toggleTheme();
  else if (act === 'find') openFinder();
});

document.addEventListener('keydown', ev => {
  if (ev.target.matches('input, textarea, select') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (document.body.dataset.view !== 'test' || !quiz || quiz.country === undefined || $('dialog[open]')) return;
  if (/^[1-7]$/.test(ev.key)) { ev.preventDefault(); choose(E.SCALE[+ev.key - 1].a); }
  else if (ev.key === 'm' || ev.key === 'M') { ev.preventDefault(); starQ(); }
  else if (ev.key === 's' || ev.key === 'S') { ev.preventDefault(); skipQ(); }
  else if (ev.key === 'a' || ev.key === 'A') { ev.preventDefault(); aboutQ(); }
  else if (ev.key === 'w' || ev.key === 'W') { ev.preventDefault(); swapQ(); }
  else if (ev.key === 'ArrowLeft' || ev.key === 'Backspace') { ev.preventDefault(); backQ(); }
});

function axisHelp(k) {
  const ax = AXES[k], dlg = $('#axhelp');
  $('.dlg-body', dlg).innerHTML = `<p class="kicker">${esc(BLK[ax.b].n)} · axis ${pad2(k + 1)}</p><h2>${esc(ax.n)}</h2><p>${esc(ax.q)}</p>
    <div class="poles2 b-${ax.b}"><div>${poleArt(ax.k, 0)}<b>${esc(ax.L)}</b><p>${esc(ax.Ld)}</p></div><div>${poleArt(ax.k, 1)}<b>${esc(ax.R)}</b><p>${esc(ax.Rd)}</p></div></div>
    <p><a class="link" href="#/axes#ax-${ax.k}" data-close>Anchors and examples</a></p>`;
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
}
['#axhelp', '#qabout'].forEach(sel => {
  const d = $(sel); if (!d) return;
  d.addEventListener('click', ev => { if (ev.target === d || ev.target.closest('[data-close]')) d.close(); });
});

// comparing with a friend: the form takes their result link or code
document.addEventListener('submit', ev => {
  const f = ev.target.closest('form[data-friend]');
  if (!f) return;
  ev.preventDefault(); friendSubmit(f);
});
document.addEventListener('input', ev => {
  const f = ev.target.closest('form[data-friend]'), e = f && $('.fr-err', f);
  if (e) e.textContent = '';
});

function applyTheme(t) { document.documentElement.dataset.theme = t; const b = $('[data-act="theme"]'); if (b) b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'); }
function toggleTheme() { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('theme', t); applyTheme(t); }
applyTheme(store.get('theme', null) || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

/* People, countries and regimes load in the background. Pages that need them wait; the home and method pages
   show at once and are drawn again when the numbers are known. */
const NEEDS_MORE = new Set(['result', 'r', 'people', 'countries', 'library', 'i', 'p', 'c', 'compare', 'pictures']);
function routeWhenReady() {
  const head = ((location.hash || '#/').slice(1).split(/[?#]/)[0].split('/').filter(Boolean)[0]) || '';
  if (!DATA.more && NEEDS_MORE.has(head)) {
    document.body.dataset.view = head;
    view().innerHTML = '<div class="wrap loading-more"><p>Loading people, countries and regimes…</p></div>';
    return;
  }
  route();
}
window.agoraMore = () => {
  DATA.more = true; indexData(); LIB = buildLib();
  const head = document.body.dataset.view;
  if (head === 'home' || head === 'method' || NEEDS_MORE.has(head)) route();
  else if (head === 'test' && quiz && quiz.country === undefined) countryPickView();
};
window.addEventListener('hashchange', routeWhenReady);
routeWhenReady();
// work out the table of predicted answers while the visitor reads the page, so the first question appears at once
(window.requestIdleCallback || (f => setTimeout(f, 600)))(() => E.warm());
if (!DATA.more) {
  const s = document.createElement('script'); s.src = 'data-more.js'; s.async = true;
  s.onerror = () => { view().insertAdjacentHTML('afterbegin', '<p class="wrap">Part of the data could not be loaded. Check that data-more.js is next to index.html.</p>'); };
  document.head.appendChild(s);
}

/* search everything: one box for every ideology, person, country, region and regime; '/' opens it */
function openFinder() {
  const d = $('#finder'); if (!d) return;
  const body = $('.dlg-body', d);
  picker(body, id => { d.close(); const hit = BY.get(id); location.hash = id === 'me' ? '#/result' : hit ? hrefOf(hit.e, hit.kind) : '#/'; });
  if (!d.open) d.showModal();
  const inp = $('input', body); if (inp) inp.focus();
}
(() => {
  const d = $('#finder');
  if (d) d.addEventListener('click', ev => { if (ev.target === d || ev.target.closest('[data-close]')) d.close(); });
  document.addEventListener('keydown', ev => {
    if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('dialog[open]')) return;
    ev.preventDefault(); openFinder();
  });
})();

})();
