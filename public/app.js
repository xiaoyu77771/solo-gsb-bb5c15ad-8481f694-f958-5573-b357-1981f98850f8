'use strict';

/* ============================================================
 * 剧场排练走位工具
 * 纯前端逻辑：8×6 网格、逐拍推演、碰撞/互换/越界检测、本地保存
 * ============================================================ */
(function () {
  const COLS = 8;
  const ROWS = 6;

  // r 坐标：1 为靠近观众席（舞台下方），6 为上场方向（舞台上方）
  const DIRS = {
    U: { dc: 0, dr: 1, label: '上', glyph: '△' },
    D: { dc: 0, dr: -1, label: '下', glyph: '▽' },
    L: { dc: -1, dr: 0, label: '左', glyph: '◁' },
    R: { dc: 1, dr: 0, label: '右', glyph: '▷' },
    S: { dc: 0, dr: 0, label: '原地', glyph: '·' }
  };
  const DIR_ORDER = ['U', 'D', 'L', 'R', 'S'];
  const STORAGE_KEY = 'stage-blocking:v1';
  const REPORT_APP = 'stage-blocking-report';
  const REPORT_VERSION = 1;
  const COMPARE_APP = 'stage-blocking-compare';
  const COMPARE_VERSION = 1;

  const PALETTE = [
    '#5b8def', '#e5484d', '#3ecf8e', '#f5a623', '#a78bfa',
    '#22b8cf', '#f783ac', '#8ce99a', '#ffa94d', '#63e6be'
  ];

  let idSeq = 0;
  function uid(prefix) {
    idSeq += 1;
    return prefix + '_' + Date.now().toString(36) + '_' + idSeq.toString(36) +
      Math.random().toString(36).slice(2, 6);
  }

  function cellKey(c, r) { return c + ',' + r; }
  function parseKey(key) {
    const parts = String(key).split(',');
    return { c: Number(parts[0]), r: Number(parts[1]) };
  }
  function inBounds(c, r) { return c >= 1 && c <= COLS && r >= 1 && r <= ROWS; }
  function moveAt(actor, beat) {
    const d = actor.moves[String(beat)];
    return DIRS[d] ? d : 'S';
  }

  /* ---------------- 示例走位（首次打开自动载入） ---------------- */
  function demoState() {
    return {
      beats: 4,
      nextActorNum: 5,
      actors: [
        { id: 'demo_a', name: '阿甲', start: { c: 4, r: 2 }, moves: { '1': 'L', '2': 'R', '3': 'R', '4': 'R' } },
        { id: 'demo_b', name: '阿乙', start: { c: 5, r: 2 }, moves: { '1': 'L', '2': 'L', '3': 'R', '4': 'U' } },
        { id: 'demo_c', name: '阿丙', start: { c: 4, r: 5 }, moves: { '1': 'D', '2': 'D', '3': 'D', '4': 'L' } },
        { id: 'demo_d', name: '阿丁', start: { c: 8, r: 6 }, moves: { '1': 'R', '2': 'S', '3': 'S', '4': 'U' } }
      ]
    };
  }

  function freshState() {
    return { beats: 4, nextActorNum: 1, actors: [] };
  }

  /* ---------------- 数据校验 / 规整 ---------------- */
  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bad state');
    let beats = Math.trunc(Number(raw.beats));
    if (!Number.isFinite(beats) || beats < 1 || beats > 100) beats = 4;

    const actors = [];
    const rawActors = Array.isArray(raw.actors) ? raw.actors : [];
    let nextActorNum = Math.trunc(Number(raw.nextActorNum)) || rawActors.length + 1;

    for (const ra of rawActors) {
      if (!ra || typeof ra !== 'object') continue;
      const name = (typeof ra.name === 'string' && ra.name.trim()) ? ra.name.trim().slice(0, 20) : '演员';
      let start = null;
      if (ra.start && typeof ra.start === 'object') {
        const c = Math.trunc(Number(ra.start.c));
        const r = Math.trunc(Number(ra.start.r));
        if (inBounds(c, r)) start = { c, r };
      }
      const moves = {};
      if (ra.moves && typeof ra.moves === 'object') {
        for (const k of Object.keys(ra.moves)) {
          const b = Math.trunc(Number(k));
          if (b >= 1 && b <= beats && DIRS[ra.moves[k]]) moves[String(b)] = ra.moves[k];
        }
      }
      actors.push({
        id: (typeof ra.id === 'string' && ra.id) ? ra.id.slice(0, 60) : uid('a'),
        name, start, moves
      });
    }
    return { beats, nextActorNum: Math.max(nextActorNum, actors.length + 1), actors };
  }

  /* ---------------- 核心推演（纯函数，供测试调用） ----------------
   * 返回:
   *  positions[b]: { actorId: "c,r" }  —— 每拍各演员所在格
   *  blocked:      [{beat, actorId, dir, from}] 被拦截的越界动作
   *  collisions:   [{beat, key, ids}] 同拍同格
   *  swaps:        [{beat, a, b, keyA, keyB}] 相邻两拍互换
   * ------------------------------------------------------------- */
  function simulate(actors, beats) {
    const positions = [];
    const blocked = [];

    // 第 0 拍：起点
    const pos0 = {};
    for (const actor of actors) {
      if (actor.start) pos0[actor.id] = cellKey(actor.start.c, actor.start.r);
    }
    positions.push(pos0);

    for (let beat = 1; beat <= beats; beat++) {
      const prev = positions[beat - 1];
      const cur = Object.assign({}, prev);
      for (const actor of actors) {
        const from = prev[actor.id];
        if (!from) continue; // 未设起点的演员不参与推演
        const dir = moveAt(actor, beat);
        if (dir === 'S') continue;
        const { c, r } = parseKey(from);
        const nc = c + DIRS[dir].dc;
        const nr = r + DIRS[dir].dr;
        if (!inBounds(nc, nr)) {
          blocked.push({ beat, actorId: actor.id, dir, from }); // 拦截：原地不动
          continue;
        }
        cur[actor.id] = cellKey(nc, nr);
      }
      positions.push(cur);
    }

    const collisions = [];
    const swaps = [];
    for (let beat = 0; beat <= beats; beat++) {
      // 同拍同格
      const occupied = new Map();
      for (const [id, key] of Object.entries(positions[beat])) {
        if (!occupied.has(key)) occupied.set(key, []);
        occupied.get(key).push(id);
      }
      for (const [key, ids] of occupied) {
        if (ids.length > 1) collisions.push({ beat, key, ids: ids.slice() });
      }

      // 相邻两拍互换：A: X→Y 且 B: Y→X
      if (beat >= 1) {
        const cur = positions[beat];
        const prev = positions[beat - 1];
        for (const idA of Object.keys(cur)) {
          const keyA = cur[idA];
          const keyFromA = prev[idA];
          if (!keyFromA || keyFromA === keyA) continue;
          for (const idB of Object.keys(cur)) {
            if (idB <= idA) continue;
            if (cur[idB] === keyFromA && prev[idB] === keyA) {
              swaps.push({ beat, a: idA, b: idB, keyA, keyB: keyFromA });
            }
          }
        }
      }
    }

    return { positions, blocked, collisions, swaps };
  }

  /* ============================================================
   * 排练场记报告：只读快照（纯函数，供测试调用）
   *
   * 报告在生成那一刻深拷贝所需的全部数据（演员 / 起点 / 动作 /
   * 逐拍坐标 / 冲突），之后走位再怎么编辑，已生成的报告都不会变。
   * ============================================================ */

  function fmtCoord(c, r) { return c + '-' + r; }
  function coordToKey(coord) { return String(coord).replace('-', ','); }

  // 生成冲突条目的跳转键，与 UI 层 collisionKey/swapKey/blockedKey 一致
  // cellKey 为内部 "c,r" 格式（仅同格冲突以格子为键）
  function reportConflictKey(kind, beat, ids, cellKey) {
    if (kind === 'collision') return 'col-' + beat + '-' + cellKey;
    if (kind === 'blocked') return 'blk-' + beat + '-' + ids[0];
    return 'swp-' + beat + '-' + ids.slice().sort().join('-');
  }

  function buildReport(opts) {
    const src = normalizeState(opts && opts.state ? opts.state : {});
    const nameById = new Map(src.actors.map((a) => [a.id, a.name]));

    let rawFrom = Number.isFinite(Number(opts && opts.fromBeat))
      ? Math.trunc(Number(opts.fromBeat)) : 0;
    let rawTo = Number.isFinite(Number(opts && opts.toBeat))
      ? Math.trunc(Number(opts.toBeat)) : src.beats;
    if (rawFrom > rawTo) [rawFrom, rawTo] = [rawTo, rawFrom]; // 起止反转时自动交换
    const lo = Math.min(Math.max(rawFrom, 0), src.beats);
    const hi = Math.min(Math.max(rawTo, lo), src.beats);

    let selected = Array.isArray(opts && opts.actorIds) ? opts.actorIds : null;
    if (selected) {
      const wanted = new Set(selected.map(String));
      selected = src.actors.filter((a) => wanted.has(a.id)).map((a) => a.id);
    }
    if (!selected || !selected.length) selected = src.actors.map((a) => a.id);
    const chosen = new Set(selected);

    const sim = simulate(src.actors, src.beats);
    const namesOf = (ids) => ids.map((id) => nameById.get(id) || '已删除演员');

    // 冲突汇总：只要涉及至少一位被选演员即记录，并保留全部当事人姓名
    // （场记需要知道被选演员与谁同格 / 互换，哪怕对方不在本次报告范围）
    const conflicts = [];
    sim.collisions.forEach((c) => {
      if (c.beat < lo || c.beat > hi) return;
      if (!c.ids.some((id) => chosen.has(id))) return;
      const ids = c.ids.slice();
      const coord = fmtCoord(parseKey(c.key).c, parseKey(c.key).r);
      conflicts.push({
        key: reportConflictKey('collision', c.beat, ids, c.key),
        kind: 'collision',
        beat: c.beat,
        actorIds: ids,
        actors: namesOf(ids),
        cells: [coord],
        text: namesOf(ids).join('、') + ' 同在 (' + coord + ')'
      });
    });
    sim.swaps.forEach((s) => {
      if (s.beat < lo || s.beat > hi) return;
      if (!chosen.has(s.a) && !chosen.has(s.b)) return;
      const ids = [s.a, s.b];
      const coordA = fmtCoord(parseKey(s.keyA).c, parseKey(s.keyA).r);
      const coordB = fmtCoord(parseKey(s.keyB).c, parseKey(s.keyB).r);
      conflicts.push({
        key: reportConflictKey('swap', s.beat, ids),
        kind: 'swap',
        beat: s.beat,
        actorIds: ids,
        actors: namesOf(ids),
        cells: [coordA, coordB],
        text: namesOf(ids).join(' ⇄ ') + ' 互换格子 (' + coordA + ')↔(' + coordB + ')'
      });
    });
    sim.blocked.forEach((b) => {
      if (b.beat < lo || b.beat > hi || !chosen.has(b.actorId)) return;
      const ids = [b.actorId];
      const coord = fmtCoord(parseKey(b.from).c, parseKey(b.from).r);
      conflicts.push({
        key: reportConflictKey('blocked', b.beat, ids),
        kind: 'blocked',
        beat: b.beat,
        actorIds: ids,
        actors: namesOf(ids),
        cells: [coord],
        text: namesOf(ids)[0] + ' 向「' + DIRS[b.dir].label + '」移动越界，自 (' + coord + ') 被拦截'
      });
    });
    const rank = { collision: 0, swap: 1, blocked: 2 };
    conflicts.sort((x, y) => (x.beat - y.beat) || rank[x.kind] - rank[y.kind] ||
      x.actors.join('').localeCompare(y.actors.join('')));

    const counts = {
      collision: conflicts.filter((x) => x.kind === 'collision').length,
      swap: conflicts.filter((x) => x.kind === 'swap').length,
      blocked: conflicts.filter((x) => x.kind === 'blocked').length
    };
    counts.total = conflicts.length;

    // 逐拍记录：行标记 / 越界标记 / 本拍计数全部派生自上面的筛选后冲突，
    // 保证「逐拍」与「冲突汇总」对未选演员、拍次范围的口径完全一致。
    const conflictsByBeat = new Map();
    for (const cf of conflicts) {
      if (!conflictsByBeat.has(cf.beat)) conflictsByBeat.set(cf.beat, []);
      conflictsByBeat.get(cf.beat).push(cf);
    }
    const beatsOut = [];
    for (let beat = lo; beat <= hi; beat++) {
      const here = conflictsByBeat.get(beat) || [];
      const marksFor = (actorId) => {
        const set = new Set(here.filter((cf) => cf.actorIds.includes(actorId)).map((cf) => cf.kind));
        return ['collision', 'swap', 'blocked'].filter((k) => set.has(k));
      };
      const rows = [];
      for (const actor of src.actors) {
        if (!chosen.has(actor.id)) continue;
        const key = sim.positions[beat][actor.id];
        const coord = key ? fmtCoord(parseKey(key).c, parseKey(key).r) : null;
        const marks = marksFor(actor.id);
        rows.push({
          actorId: actor.id,
          name: actor.name,
          start: actor.start ? { c: actor.start.c, r: actor.start.r } : null,
          coord,
          move: beat >= 1 ? moveAt(actor, beat) : null,
          blocked: marks.includes('blocked'),
          marks
        });
      }
      beatsOut.push({
        beat,
        collisionCount: here.filter((cf) => cf.kind === 'collision').length,
        swapCount: here.filter((cf) => cf.kind === 'swap').length,
        blockedCount: here.filter((cf) => cf.kind === 'blocked').length,
        rows
      });
    }

    return {
      app: REPORT_APP,
      version: REPORT_VERSION,
      id: (opts && typeof opts.id === 'string' && opts.id) ? opts.id : uid('rpt'),
      title: (opts && typeof opts.title === 'string' && opts.title.trim())
        ? opts.title.trim().slice(0, 60) : '排练场记报告',
      createdAt: new Date().toISOString(),
      fromBeat: lo,
      toBeat: hi,
      actorIds: selected,
      actors: selected.map((id) => {
        const a = src.actors.find((x) => x.id === id);
        return { id, name: a ? a.name : '已删除演员' };
      }),
      grid: { cols: COLS, rows: ROWS },
      counts,
      beats: beatsOut,
      conflicts,
      // 生成时的完整走位快照（深拷贝），与后续编辑彻底隔离
      source: JSON.parse(JSON.stringify(src))
    };
  }

  // 校验 / 规整一份已存档的报告；非法时返回 null（加载存档时丢弃坏条目）
  function normalizeReport(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.app !== REPORT_APP) return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 60) : uid('rpt');
    const title = typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.trim().slice(0, 60) : '排练场记报告';
    const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
      ? raw.createdAt : new Date().toISOString();
    const fromBeat = Math.trunc(Number(raw.fromBeat));
    const toBeat = Math.trunc(Number(raw.toBeat));
    if (!Number.isFinite(fromBeat) || !Number.isFinite(toBeat) ||
      fromBeat < 0 || toBeat < fromBeat || toBeat > 100) return null;

    const actorSeen = new Set();
    const actors = [];
    const actorIds = [];
    for (const a of Array.isArray(raw.actors) ? raw.actors : []) {
      if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id) continue;
      if (actorSeen.has(a.id)) continue;
      actorSeen.add(a.id);
      const name = (typeof a.name === 'string' && a.name.trim())
        ? a.name.trim().slice(0, 20) : '演员';
      actors.push({ id: a.id, name });
      actorIds.push(a.id);
    }
    if (!actors.length) return null;

    const validKind = (k) => k === 'collision' || k === 'swap' || k === 'blocked';
    const conflicts = [];
    for (const cf of Array.isArray(raw.conflicts) ? raw.conflicts : []) {
      if (!cf || typeof cf !== 'object' || !validKind(cf.kind)) continue;
      const beat = Math.trunc(Number(cf.beat));
      if (!Number.isFinite(beat) || beat < fromBeat || beat > toBeat) continue;
      const ids = Array.isArray(cf.actorIds)
        ? cf.actorIds.filter((x) => actorSeen.has(x)) : [];
      if (!ids.length) continue;
      const cells = Array.isArray(cf.cells)
        ? cf.cells.filter((x) => /^\d+-\d+$/.test(String(x))).map(String) : [];
      const fallbackKey = cf.kind === 'collision' && cells[0]
        ? reportConflictKey(cf.kind, beat, ids, coordToKey(cells[0]))
        : reportConflictKey(cf.kind, beat, ids);
      const key = typeof cf.key === 'string' && cf.key ? cf.key : fallbackKey;
      conflicts.push({
        key, kind: cf.kind, beat,
        actorIds: ids,
        actors: Array.isArray(cf.actors) && cf.actors.length === ids.length
          ? cf.actors.map(String) : ids.map((x) => actors.find((a) => a.id === x).name),
        cells,
        text: typeof cf.text === 'string' && cf.text ? cf.text : ''
      });
    }
    const rank = { collision: 0, swap: 1, blocked: 2 };
    conflicts.sort((x, y) => (x.beat - y.beat) || rank[x.kind] - rank[y.kind]);

    const beats = [];
    for (const braw of Array.isArray(raw.beats) ? raw.beats : []) {
      if (!braw || typeof braw !== 'object') continue;
      const beat = Math.trunc(Number(braw.beat));
      if (!Number.isFinite(beat) || beat < fromBeat || beat > toBeat) continue;
      const rows = [];
      for (const rraw of Array.isArray(braw.rows) ? braw.rows : []) {
        if (!rraw || typeof rraw !== 'object' || !actorSeen.has(rraw.actorId)) continue;
        let coord = null;
        if (typeof rraw.coord === 'string' && /^\d+-\d+$/.test(rraw.coord)) coord = rraw.coord;
        rows.push({
          actorId: rraw.actorId,
          name: typeof rraw.name === 'string' && rraw.name
            ? rraw.name : actors.find((a) => a.id === rraw.actorId).name,
          start: rraw.start && typeof rraw.start === 'object' &&
            Number.isFinite(Number(rraw.start.c)) && Number.isFinite(Number(rraw.start.r))
            ? { c: Number(rraw.start.c), r: Number(rraw.start.r) } : null,
          coord,
          move: DIRS[rraw.move] ? rraw.move : null,
          blocked: !!rraw.blocked,
          marks: Array.isArray(rraw.marks) ? rraw.marks.filter(validKind) : []
        });
      }
      if (!rows.length) continue;
      beats.push({
        beat,
        collisionCount: Math.max(0, Math.trunc(Number(braw.collisionCount)) || 0),
        swapCount: Math.max(0, Math.trunc(Number(braw.swapCount)) || 0),
        blockedCount: Math.max(0, Math.trunc(Number(braw.blockedCount)) || 0),
        rows
      });
    }

    let source = null;
    try {
      source = normalizeState(raw.source);
    } catch (err) { source = null; }

    return {
      app: REPORT_APP,
      version: REPORT_VERSION,
      id, title, createdAt, fromBeat, toBeat,
      actorIds, actors,
      grid: { cols: COLS, rows: ROWS },
      counts: {
        collision: conflicts.filter((x) => x.kind === 'collision').length,
        swap: conflicts.filter((x) => x.kind === 'swap').length,
        blocked: conflicts.filter((x) => x.kind === 'blocked').length,
        total: conflicts.length
      },
      beats,
      conflicts,
      source
    };
  }

  /* ============================================================
   * 报告对比（两份只读快照之间的差异，纯函数，供测试调用）
   *
   * 对齐规则：
   *  - 按演员 id 求交集作为「共同演员」，按拍次编号求交集作为「共同拍次」
   *  - 只有交集范围内才产生差异结果；任一方独有的演员 / 拍次只做提示，
   *    绝不混入差异统计（避免「拍次错位」造成误导）
   *  - 演员或拍次完全不重叠时 comparable=false，不生成差异表
   *
   * 冲突口径：同格按「拍次+格子」、互换按「拍次+两名共同演员」、
   * 越界按「拍次+共同演员」归并，再分为 新增 / 消除 / 保持 三类。
   * ============================================================ */

  // 把报告内一条冲突归一成只依赖交集范围的稳定身份键
  function comparisonConflictCanon(kind, cf, commonActors) {
    if (kind === 'collision') return 'col:' + cf.beat + ':' + cf.cells[0];
    if (kind === 'swap') return 'swp:' + cf.beat + ':' + cf.actorIds.slice().sort().join('-');
    return 'blk:' + cf.beat + ':' + cf.actorIds[0];
  }

  // 判断报告冲突是否落在「共同演员 × 共同拍次」范围内
  function conflictInCompareScope(cf, commonActorSet, loBeat, hiBeat) {
    if (cf.beat < loBeat || cf.beat > hiBeat) return false;
    if (cf.kind === 'blocked') return commonActorSet.has(cf.actorIds[0]);
    if (cf.kind === 'swap') return cf.actorIds.every((id) => commonActorSet.has(id));
    return cf.actorIds.some((id) => commonActorSet.has(id)); // 同格：任一当事人在交集内即可
  }

  function buildComparison(opts) {
    const aRaw = opts && opts.a;
    const bRaw = opts && opts.b;
    let a = null;
    let b = null;
    try { a = normalizeReport(aRaw); } catch (err) { a = null; }
    try { b = normalizeReport(bRaw); } catch (err) { b = null; }
    if (!a || !b) throw new Error('bad report');
    if (a.id === b.id) throw new Error('same report');

    const title = (opts && typeof opts.title === 'string' && opts.title.trim())
      ? opts.title.trim().slice(0, 80) : '报告对比 · ' + a.title + ' ⇄ ' + b.title;

    const aActors = new Map(a.actors.map((x) => [x.id, x.name]));
    const bActors = new Map(b.actors.map((x) => [x.id, x.name]));
    const commonActorIds = [];
    const aOnlyActors = [];
    for (const [id, name] of aActors) {
      if (bActors.has(id)) {
        commonActorIds.push({ id, nameA: name, nameB: bActors.get(id) });
      } else {
        aOnlyActors.push({ id, name });
      }
    }
    const bOnlyActors = [];
    for (const [id, name] of bActors) {
      if (!aActors.has(id)) bOnlyActors.push({ id, name });
    }

    const lo = Math.max(a.fromBeat, b.fromBeat);
    const hi = Math.min(a.toBeat, b.toBeat);
    const aOnlyBeats = [];
    for (let beat = a.fromBeat; beat <= a.toBeat; beat++) {
      if (beat < b.fromBeat || beat > b.toBeat) aOnlyBeats.push(beat);
    }
    const bOnlyBeats = [];
    for (let beat = b.fromBeat; beat <= b.toBeat; beat++) {
      if (beat < a.fromBeat || beat > a.toBeat) bOnlyBeats.push(beat);
    }

    const reasonNoActors = commonActorIds.length === 0;
    const reasonNoBeats = lo > hi;
    const comparable = !reasonNoActors && !reasonNoBeats;

    const base = {
      app: COMPARE_APP,
      version: COMPARE_VERSION,
      id: (opts && typeof opts.id === 'string' && opts.id) ? opts.id : uid('cmp'),
      title,
      createdAt: new Date().toISOString(),
      a: { id: a.id, title: a.title, createdAt: a.createdAt },
      b: { id: b.id, title: b.title, createdAt: b.createdAt },
      commonActorIds: commonActorIds.map((x) => x.id),
      actors: commonActorIds.map((x) => ({
        id: x.id,
        nameA: x.nameA,
        nameB: x.nameB,
        renamed: x.nameA !== x.nameB
      })),
      aOnlyActors,
      bOnlyActors,
      commonBeats: comparable ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [],
      aOnlyBeats,
      bOnlyBeats,
      overlap: comparable ? { fromBeat: lo, toBeat: hi } : null
    };

    if (!comparable) {
      return Object.assign(base, {
        comparable: false,
        reason: reasonNoActors ? 'no-common-actors' : 'no-common-beats',
        beats: [],
        deltas: [],
        counts: {
          added: { collision: 0, swap: 0, blocked: 0, total: 0 },
          removed: { collision: 0, swap: 0, blocked: 0, total: 0 },
          kept: { collision: 0, swap: 0, blocked: 0, total: 0 },
          total: 0
        },
        diffRowCount: 0
      });
    }

    const commonSet = new Set(base.commonActorIds);

    // 逐拍索引：beat -> actorId -> 报告行
    const indexRows = (report) => {
      const map = new Map();
      for (const bk of report.beats) {
        map.set(bk.beat, new Map(bk.rows.map((row) => [row.actorId, row])));
      }
      return map;
    };
    const aRows = indexRows(a);
    const bRows = indexRows(b);

    const beatsOut = [];
    let diffRowCount = 0;
    for (let beat = lo; beat <= hi; beat++) {
      const at = aRows.get(beat) || new Map();
      const bt = bRows.get(beat) || new Map();
      const rows = [];
      for (const ca of commonActorIds) {
        const ra = at.get(ca.id) || null;
        const rb = bt.get(ca.id) || null;
        const coordA = ra ? ra.coord : null;
        const coordB = rb ? rb.coord : null;
        const moveA = ra ? ra.move : null;
        const moveB = rb ? rb.move : null;
        const coordChanged = coordA !== coordB;
        const moveChanged = moveA !== moveB;
        const changed = coordChanged || moveChanged;
        if (changed) diffRowCount += 1;
        rows.push({
          actorId: ca.id,
          nameA: ca.nameA,
          nameB: ca.nameB,
          renamed: ca.nameA !== ca.nameB,
          coordA, coordB, moveA, moveB,
          coordChanged, moveChanged, changed
        });
      }
      beatsOut.push({
        beat,
        rows,
        changedCount: rows.filter((x) => x.changed).length
      });
    }

    // 冲突差异：先按范围筛选，再按规范键归并
    const scoped = (report) => {
      const m = new Map();
      for (const cf of report.conflicts) {
        if (!conflictInCompareScope(cf, commonSet, lo, hi)) continue;
        m.set(comparisonConflictCanon(cf.kind, cf, commonSet), cf);
      }
      return m;
    };
    const aMap = scoped(a);
    const bMap = scoped(b);
    const canonSet = new Set([...aMap.keys(), ...bMap.keys()]);
    const parseCanon = (canon) => {
      const p = canon.split(':');
      return { kind: p[0] === 'col' ? 'collision' : p[0] === 'swp' ? 'swap' : 'blocked', beat: Number(p[1]) };
    };
    const deltas = [];
    for (const canon of canonSet) {
      const cfA = aMap.get(canon) || null;
      const cfB = bMap.get(canon) || null;
      const meta = parseCanon(canon);
      deltas.push({
        key: canon,
        kind: meta.kind,
        beat: meta.beat,
        status: cfA && cfB ? 'kept' : cfB ? 'added' : 'removed',
        actorIds: cfA ? cfA.actorIds.slice() : cfB.actorIds.slice(),
        textA: cfA ? cfA.text : '',
        textB: cfB ? cfB.text : '',
        cellsA: cfA ? cfA.cells.slice() : [],
        cellsB: cfB ? cfB.cells.slice() : []
      });
    }
    const rankKind = { collision: 0, swap: 1, blocked: 2 };
    const rankStatus = { added: 0, removed: 1, kept: 2 };
    deltas.sort((x, y) =>
      (x.beat - y.beat) || rankStatus[x.status] - rankStatus[y.status] ||
      rankKind[x.kind] - rankKind[y.kind] || x.key.localeCompare(y.key));

    const emptyCount = () => ({ collision: 0, swap: 0, blocked: 0, total: 0 });
    const counts = { added: emptyCount(), removed: emptyCount(), kept: emptyCount(), total: deltas.length };
    for (const d of deltas) {
      counts[d.status][d.kind] += 1;
      counts[d.status].total += 1;
    }

    return Object.assign(base, {
      comparable: true,
      reason: null,
      beats: beatsOut,
      deltas,
      counts,
      diffRowCount
    });
  }

  // 校验 / 规整一份已存档的对比；非法时返回 null（加载存档时丢弃坏条目）
  function normalizeComparison(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.app !== COMPARE_APP) return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 60) : uid('cmp');
    const title = typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.trim().slice(0, 80) : '报告对比';
    const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
      ? raw.createdAt : new Date().toISOString();
    const sideOf = (s) => (s && typeof s === 'object' && typeof s.id === 'string' && s.id &&
      typeof s.title === 'string')
      ? { id: s.id.slice(0, 60), title: s.title.slice(0, 60),
        createdAt: typeof s.createdAt === 'string' ? s.createdAt : '' }
      : null;
    const a = sideOf(raw.a);
    const b = sideOf(raw.b);
    if (!a || !b || a.id === b.id) return null;

    const actorSeen = new Set();
    const actors = [];
    const commonActorIds = [];
    for (const x of Array.isArray(raw.actors) ? raw.actors : []) {
      if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id || actorSeen.has(x.id)) continue;
      actorSeen.add(x.id);
      const nameA = typeof x.nameA === 'string' && x.nameA.trim() ? x.nameA.trim().slice(0, 20) : '演员';
      const nameB = typeof x.nameB === 'string' && x.nameB.trim() ? x.nameB.trim().slice(0, 20) : nameA;
      actors.push({ id: x.id, nameA, nameB, renamed: nameA !== nameB });
      commonActorIds.push(x.id);
    }
    const onlyActors = (arr) => (Array.isArray(arr) ? arr : [])
      .filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && x.id)
      .map((x) => ({ id: String(x.id).slice(0, 60),
        name: typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 20) : '演员' }));
    const aOnlyActors = onlyActors(raw.aOnlyActors);
    const bOnlyActors = onlyActors(raw.bOnlyActors);

    const validBeat = (n) => Number.isInteger(n) && n >= 0 && n <= 100;
    const commonBeats = (Array.isArray(raw.commonBeats) ? raw.commonBeats : [])
      .map(Number).filter(validBeat);
    const lo = commonBeats.length ? Math.min.apply(null, commonBeats) : 0;
    const hi = commonBeats.length ? Math.max.apply(null, commonBeats) : 0;
    const aOnlyBeats = (Array.isArray(raw.aOnlyBeats) ? raw.aOnlyBeats : []).map(Number).filter(validBeat);
    const bOnlyBeats = (Array.isArray(raw.bOnlyBeats) ? raw.bOnlyBeats : []).map(Number).filter(validBeat);
    const overlap = raw.overlap && validBeat(Number(raw.overlap.fromBeat)) &&
      validBeat(Number(raw.overlap.toBeat)) && Number(raw.overlap.toBeat) >= Number(raw.overlap.fromBeat)
      ? { fromBeat: Number(raw.overlap.fromBeat), toBeat: Number(raw.overlap.toBeat) } : null;

    const base = {
      app: COMPARE_APP,
      version: COMPARE_VERSION,
      id, title, createdAt, a, b,
      commonActorIds, actors,
      aOnlyActors, bOnlyActors,
      commonBeats, aOnlyBeats, bOnlyBeats,
      overlap
    };

    // 不可比对比：仅允许在生成时出现，不允许作为存档恢复（避免误导性记录）
    if (raw.comparable === false || !commonActorIds.length || !commonBeats.length || !overlap) return null;

    const validKind = (k) => k === 'collision' || k === 'swap' || k === 'blocked';
    const validStatus = (s) => s === 'added' || s === 'removed' || s === 'kept';
    const deltas = [];
    for (const d of Array.isArray(raw.deltas) ? raw.deltas : []) {
      if (!d || typeof d !== 'object' || !validKind(d.kind) || !validStatus(d.status)) continue;
      const beat = Number(d.beat);
      if (!validBeat(beat) || beat < lo || beat > hi) continue;
      const actorIds = Array.isArray(d.actorIds)
        ? d.actorIds.filter((x) => actorSeen.has(String(x))).map(String) : [];
      if (!actorIds.length) continue;
      if (d.kind === 'swap' && actorIds.length < 2) continue;
      const cellsOf = (v) => (Array.isArray(v) ? v : [])
        .filter((x) => /^\d+-\d+$/.test(String(x))).map(String);
      deltas.push({
        key: typeof d.key === 'string' && d.key ? d.key :
          comparisonConflictCanon(d.kind, { beat, actorIds, cells: cellsOf(d.cellsB || d.cellsA) }, null),
        kind: d.kind, beat, status: d.status, actorIds,
        textA: typeof d.textA === 'string' ? d.textA : '',
        textB: typeof d.textB === 'string' ? d.textB : '',
        cellsA: cellsOf(d.cellsA),
        cellsB: cellsOf(d.cellsB)
      });
    }
    const rankKind = { collision: 0, swap: 1, blocked: 2 };
    const rankStatus = { added: 0, removed: 1, kept: 2 };
    deltas.sort((x, y) =>
      (x.beat - y.beat) || rankStatus[x.status] - rankStatus[y.status] ||
      rankKind[x.kind] - rankKind[y.kind] || x.key.localeCompare(y.key));

    const validMove = (m) => m === null || !!DIRS[m];
    const beats = [];
    let diffRowCount = 0;
    for (const bkraw of Array.isArray(raw.beats) ? raw.beats : []) {
      if (!bkraw || typeof bkraw !== 'object') continue;
      const beat = Number(bkraw.beat);
      if (!validBeat(beat) || beat < lo || beat > hi) continue;
      const rows = [];
      for (const rraw of Array.isArray(bkraw.rows) ? bkraw.rows : []) {
        if (!rraw || typeof rraw !== 'object' || !actorSeen.has(rraw.actorId)) continue;
        const info = actors.find((x) => x.id === rraw.actorId);
        const coordOf = (v) => (typeof v === 'string' && /^\d+-\d+$/.test(v)) ? v : null;
        const coordA = coordOf(rraw.coordA);
        const coordB = coordOf(rraw.coordB);
        const moveA = validMove(rraw.moveA) ? rraw.moveA : null;
        const moveB = validMove(rraw.moveB) ? rraw.moveB : null;
        const coordChanged = coordA !== coordB;
        const moveChanged = moveA !== moveB;
        const changed = coordChanged || moveChanged;
        if (changed) diffRowCount += 1;
        rows.push({
          actorId: info.id, nameA: info.nameA, nameB: info.nameB, renamed: info.renamed,
          coordA, coordB, moveA, moveB, coordChanged, moveChanged, changed
        });
      }
      if (!rows.length) continue;
      beats.push({ beat, rows, changedCount: rows.filter((x) => x.changed).length });
    }
    beats.sort((x, y) => x.beat - y.beat);

    const emptyCount = () => ({ collision: 0, swap: 0, blocked: 0, total: 0 });
    const counts = { added: emptyCount(), removed: emptyCount(), kept: emptyCount(), total: deltas.length };
    for (const d of deltas) {
      counts[d.status][d.kind] += 1;
      counts[d.status].total += 1;
    }

    return Object.assign(base, {
      comparable: true,
      reason: null,
      beats,
      deltas,
      counts,
      diffRowCount
    });
  }

  /* ============================================================
   * 以下为浏览器 UI 层
   * ============================================================ */
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        simulate, normalizeState, buildReport, normalizeReport,
        buildComparison, normalizeComparison,
        DIRS, DIR_ORDER, COLS, ROWS, cellKey, fmtCoord, coordToKey, reportConflictKey
      };
    }
    return;
  }

  /* ---------------- 运行时状态 ---------------- */
  let state = freshState();
  let reports = [];            // 已生成的排练场记报告（只读快照）
  let comparisons = [];        // 已保存的报告对比记录
  let currentBeat = 0;
  let sim = simulate(state.actors, state.beats);
  let settingActorId = null;   // 正在设置起点的演员
  let focusKey = null;         // 当前定位的冲突 key
  let playing = false;
  let playTimer = null;
  let toastTimer = null;

  const $ = (id) => document.getElementById(id);
  const actorById = (id) => state.actors.find((a) => a.id === id);
  const actorColor = (actor) => PALETTE[state.actors.indexOf(actor) % PALETTE.length];
  const beatName = (b) => (b === 0 ? '起点' : '第 ' + b + ' 拍');

  /* ---------------- 本地保存 / 读取 ---------------- */
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1, savedAt: new Date().toISOString(), currentBeat, state, reports, comparisons
      }));
    } catch (err) { /* 隐私模式等场景下静默失败 */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = normalizeState(parsed.state);
        currentBeat = Math.min(Math.max(Number(parsed.currentBeat) || 0, 0), state.beats);
        // 旧版本存档没有 reports 字段：按空列表处理，保持向后兼容
        reports = (Array.isArray(parsed.reports) ? parsed.reports : [])
          .map(normalizeReport)
          .filter(Boolean)
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        comparisons = (Array.isArray(parsed.comparisons) ? parsed.comparisons : [])
          .map(normalizeComparison)
          .filter(Boolean)
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        return true;
      }
    } catch (err) { /* 损坏数据：回退示例 */ }
    state = demoState();
    reports = [];
    comparisons = [];
    currentBeat = 0;
    return false;
  }

  function resim() { sim = simulate(state.actors, state.beats); }

  function commit(gotoBeat) {
    resim();
    save();
    if (gotoBeat !== undefined && gotoBeat !== currentBeat) currentBeat = gotoBeat;
    if (currentBeat > state.beats) currentBeat = state.beats;
    renderAll();
  }

  /* ---------------- Toast ---------------- */
  function toast(msg, type) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast ' + (type || '');
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
  }

  /* ---------------- 舞台构建（格子只建一次） ---------------- */
  function buildStage() {
    const colLabels = document.querySelector('.col-labels');
    const rowLabels = document.querySelector('.row-labels');
    colLabels.innerHTML = '<span class="cl"></span>' +
      Array.from({ length: COLS }, (_, i) => '<span class="cl">' + (i + 1) + '</span>').join('');
    // 视觉最上方是第 6 行（远离观众），最下方是第 1 行
    rowLabels.innerHTML = Array.from({ length: ROWS }, (_, vr) =>
      '<span class="rl">' + (ROWS - vr) + '</span>').join('');

    const grid = $('stageGrid');
    grid.innerHTML = '<svg class="swap-arrows" aria-hidden="true"></svg>';
    for (let vr = 0; vr < ROWS; vr++) {
      for (let vc = 0; vc < COLS; vc++) {
        const c = vc + 1;
        const r = ROWS - vr;
        const cell = document.createElement('div');
        cell.className = 'cell' + ((vr + vc) % 2 ? ' dark' : '');
        cell.dataset.key = cellKey(c, r);
        cell.innerHTML = '<span class="coord">' + c + '-' + r + '</span>';
        grid.appendChild(cell);
      }
    }
  }

  /* ---------------- 舞台渲染 ---------------- */
  function renderStage() {
    const grid = $('stageGrid');
    grid.querySelectorAll('.cell').forEach((cell) => {
      cell.classList.remove('collision', 'swap-cell', 'blocked-cell', 'focus-cell');
      cell.querySelectorAll('.chip, .ban').forEach((n) => n.remove());
    });
    const svg = grid.querySelector('.swap-arrows');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', '0 0 ' + (COLS * 10) + ' ' + (ROWS * 10));

    const pos = sim.positions[currentBeat] || {};

    // 按格分组演员（同格时错开显示）
    const groups = new Map();
    for (const actor of state.actors) {
      const key = pos[actor.id];
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(actor);
    }
    for (const [key, actors] of groups) {
      const cell = grid.querySelector('.cell[data-key="' + key + '"]');
      if (!cell) continue;
      actors.forEach((actor, idx) => {
        const chip = document.createElement('span');
        chip.className = 'chip c' + idx;
        chip.style.backgroundColor = actorColor(actor);
        chip.textContent = actor.name.slice(0, 2);
        chip.title = actor.name + ' @ (' + key + ')';
        if (focusKey) {
          const cf = findConflict(focusKey);
          if (cf && cf.actorIds.includes(actor.id)) chip.classList.add('attention');
        }
        cell.appendChild(chip);
      });
    }

    const swapsHere = sim.swaps.filter((s) => s.beat === currentBeat);
    swapsHere.forEach((s) => {
      const a = parseKey(s.keyA);
      const b = parseKey(s.keyB);
      const focused = focusKey === swapKey(s);
      const color = focused ? '#6ea8fe' : '#f5a623';
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const u = 10;
      const x1 = (a.c - 0.5) * u, y1 = (ROWS - a.r + 0.5) * u;
      const x2 = (b.c - 0.5) * u, y2 = (ROWS - b.r + 0.5) * u;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const inset = Math.min(2.4, len / 4);
      const ux = dx / len, uy = dy / len;
      line.setAttribute('x1', x1 + ux * inset);
      line.setAttribute('y1', y1 + uy * inset);
      line.setAttribute('x2', x2 - ux * inset);
      line.setAttribute('y2', y2 - uy * inset);
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', '0.9');
      line.setAttribute('stroke-dasharray', '1.6 1.2');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      line.setAttribute('marker-start', 'url(#' + (focused ? 'ahBlueStart' : 'ahStart') + ')');
      line.setAttribute('marker-end', 'url(#' + (focused ? 'ahBlueEnd' : 'ahEnd') + ')');
      svg.appendChild(line);
      grid.querySelector('.cell[data-key="' + s.keyA + '"]')?.classList.add('swap-cell');
      grid.querySelector('.cell[data-key="' + s.keyB + '"]')?.classList.add('swap-cell');
    });
    if (swapsHere.length) {
      const ns = 'http://www.w3.org/2000/svg';
      const defs = document.createElementNS(ns, 'defs');
      defs.innerHTML =
        '<marker id="ahEnd" markerWidth="4" markerHeight="4" refX="2.6" refY="2" orient="auto">' +
        '<path d="M0,0 L4,2 L0,4 z" fill="#f5a623"/></marker>' +
        '<marker id="ahStart" markerWidth="4" markerHeight="4" refX="1.4" refY="2" orient="auto">' +
        '<path d="M4,0 L0,2 L4,4 z" fill="#f5a623"/></marker>' +
        '<marker id="ahBlueEnd" markerWidth="4" markerHeight="4" refX="2.6" refY="2" orient="auto">' +
        '<path d="M0,0 L4,2 L0,4 z" fill="#6ea8fe"/></marker>' +
        '<marker id="ahBlueStart" markerWidth="4" markerHeight="4" refX="1.4" refY="2" orient="auto">' +
        '<path d="M4,0 L0,2 L4,4 z" fill="#6ea8fe"/></marker>';
      svg.insertBefore(defs, svg.firstChild);
    }

    sim.collisions.filter((c) => c.beat === currentBeat).forEach((c) => {
      grid.querySelector('.cell[data-key="' + c.key + '"]')?.classList.add('collision');
    });
    sim.blocked.filter((b) => b.beat === currentBeat).forEach((b) => {
      const key = pos[b.actorId];
      const cell = key && grid.querySelector('.cell[data-key="' + key + '"]');
      if (cell) {
        cell.classList.add('blocked-cell');
        const ban = document.createElement('span');
        ban.className = 'ban';
        ban.textContent = '⛔';
        ban.title = (actorById(b.actorId)?.name || '') + ' 向' + DIRS[b.dir].label + '越界被拦截';
        cell.appendChild(ban);
      }
    });

    if (focusKey) {
      const cf = findConflict(focusKey);
      if (cf && cf.beat === currentBeat) {
        cf.cellKeys.forEach((key) => {
          grid.querySelector('.cell[data-key="' + key + '"]')?.classList.add('focus-cell');
        });
      }
    }

    $('stage').classList.toggle('start-mode', settingActorId !== null);
  }

  /* ---------------- 冲突汇总 ---------------- */
  function collisionKey(c) { return 'col-' + c.beat + '-' + c.key; }
  function swapKey(s) { return 'swp-' + s.beat + '-' + [s.a, s.b].sort().join('-'); }
  function blockedKey(b) { return 'blk-' + b.beat + '-' + b.actorId; }

  function allConflicts() {
    const items = [];
    sim.collisions.forEach((c) => {
      items.push({
        key: collisionKey(c), kind: 'collision', beat: c.beat,
        actorIds: c.ids, cellKeys: [c.key],
        text: c.ids.map((id) => actorById(id)?.name || '?').join('、') + ' 同在 (' + c.key + ')'
      });
    });
    sim.swaps.forEach((s) => {
      items.push({
        key: swapKey(s), kind: 'swap', beat: s.beat,
        actorIds: [s.a, s.b], cellKeys: [s.keyA, s.keyB],
        text: (actorById(s.a)?.name || '?') + ' ⇄ ' + (actorById(s.b)?.name || '?') + ' 互换格子'
      });
    });
    sim.blocked.forEach((b) => {
      items.push({
        key: blockedKey(b), kind: 'blocked', beat: b.beat,
        actorIds: [b.actorId], cellKeys: [b.from],
        text: (actorById(b.actorId)?.name || '?') + ' 向「' + DIRS[b.dir].label + '」移动越界'
      });
    });
    const rank = { collision: 0, swap: 1, blocked: 2 };
    items.sort((x, y) => (x.beat - y.beat) || rank[x.kind] - rank[y.kind]);
    return items;
  }
  function findConflict(key) { return allConflicts().find((cf) => cf.key === key) || null; }

  /* ---------------- 演员列表渲染 ---------------- */
  function renderActors() {
    const ul = $('actorList');
    if (!state.actors.length) {
      ul.innerHTML = '<li class="empty-hint">还没有演员，点击右上角「添加演员」开始。</li>';
      return;
    }
    ul.innerHTML = '';
    state.actors.forEach((actor) => {
      const li = document.createElement('li');
      li.className = 'actor-row';
      const pos = sim.positions[currentBeat]?.[actor.id];
      const posHtml = actor.start
        ? '<span class="actor-pos">(' + (pos || actor.start.c + ',' + actor.start.r) + ')</span>'
        : '<span class="actor-pos unset">未设起点</span>';
      li.innerHTML =
        '<span class="actor-dot" style="background:' + actorColor(actor) + '"></span>' +
        '<input class="actor-name-input" value="" maxlength="20" aria-label="演员名">' +
        posHtml +
        '<button type="button" class="row-btn set-btn" title="设置起点" aria-label="设置起点">◎</button>' +
        '<button type="button" class="row-btn del-btn" title="删除演员" aria-label="删除演员">✕</button>';
      li.querySelector('.actor-name-input').value = actor.name;
      if (settingActorId === actor.id) li.querySelector('.set-btn').classList.add('active');

      li.querySelector('.actor-name-input').addEventListener('change', (e) => {
        const v = e.target.value.trim();
        actor.name = v || actor.name;
        commit();
      });
      li.querySelector('.set-btn').addEventListener('click', () => toggleStartSetting(actor.id));
      li.querySelector('.del-btn').addEventListener('click', () => {
        if (!confirm('确定删除演员「' + actor.name + '」及其全部走位吗？')) return;
        state.actors = state.actors.filter((a) => a.id !== actor.id);
        if (settingActorId === actor.id) settingActorId = null;
        toast('已删除 ' + actor.name, 'ok');
        commit();
      });
      ul.appendChild(li);
    });
  }

  /* ---------------- 冲突列表渲染 ---------------- */
  function renderConflicts() {
    const box = $('conflictList');
    const items = allConflicts();
    const badge = $('conflictBadge');
    badge.textContent = String(items.length);
    badge.classList.toggle('hidden', items.length === 0);

    box.innerHTML = '';
    if (!items.length) {
      box.innerHTML = '<div class="empty-hint">当前走位无冲突 🎉</div>';
      return;
    }
    const icon = { collision: '🔴', swap: '🔁', blocked: '⛔' };
    items.forEach((cf) => {
      const div = document.createElement('div');
      div.className = 'conflict-item ' + cf.kind + '-item' + (focusKey === cf.key ? ' focused' : '');
      div.dataset.cf = cf.key;
      div.innerHTML =
        '<span class="ci-icon">' + icon[cf.kind] + '</span>' +
        '<span class="ci-text"></span>' +
        '<span class="ci-beat">' + beatName(cf.beat) + '</span>';
      div.querySelector('.ci-text').textContent = cf.text;
      div.title = '点击定位到' + beatName(cf.beat) + ' · (' + cf.cellKeys.join(')、(') + ')';
      div.addEventListener('click', () => focusConflict(cf.key));
      box.appendChild(div);
    });
  }

  /* ---------------- 走位表渲染 ---------------- */
  function renderTable() {
    const head = $('tableHead');
    const body = $('tableBody');

    let head1 = '<tr><th class="th-actor" rowspan="2">演员 / 拍</th>';
    let head2 = '<tr>';
    for (let b = 0; b <= state.beats; b++) {
      if (b === 0) {
        head1 += '<th class="th-beat" data-beat="0">起点</th>';
        head2 += '<th>坐标</th>';
      } else {
        head1 += '<th class="th-beat' + (b === currentBeat ? ' current' : '') + '" data-beat="' + b + '">第 ' + b + ' 拍</th>';
        head2 += '<th>动作</th>';
      }
    }
    head1 += '<th class="th-add" rowspan="2"><button type="button" class="btn btn-sm" id="thAddBeat">＋</button></th>';
    head.innerHTML = head1 + '</tr>' + head2 + '</tr>';

    body.innerHTML = '';
    state.actors.forEach((actor) => {
      const tr = document.createElement('tr');
      let html = '<td class="actor-cell"><span class="ac-dot" style="background:' + actorColor(actor) + '"></span>' +
        escapeHtml(actor.name) + '</td>';
      html += '<td>' + (actor.start ? '(' + actor.start.c + ', ' + actor.start.r + ')' :
        '<span class="unset">—</span>') + '</td>';
      for (let b = 1; b <= state.beats; b++) {
        const cur = currentBeat === b ? ' current' : '';
        if (!actor.start) {
          html += '<td class="move-cell no-start' + cur + '" data-aid="' + actor.id + '" data-beat="' + b + '">—</td>';
          continue;
        }
        const dir = moveAt(actor, b);
        const isBlocked = sim.blocked.some((x) => x.beat === b && x.actorId === actor.id);
        html += '<td class="move-cell' + cur + (isBlocked ? ' blocked' : '') +
          '" data-aid="' + actor.id + '" data-beat="' + b + '">' +
          '<select class="move-select" data-aid="' + actor.id + '" data-beat="' + b +
          '" title="第 ' + b + ' 拍动作">' +
          DIR_ORDER.map((d) => '<option value="' + d + '"' + (d === dir ? ' selected' : '') + '>' +
            DIRS[d].glyph + ' ' + DIRS[d].label + '</option>').join('') +
          '</select></td>';
      }
      html += '<td class="row-spacer"></td>';
      tr.innerHTML = html;
      body.appendChild(tr);
    });

    body.querySelectorAll('.move-select').forEach((sel) => {
      sel.addEventListener('change', onMoveChange);
    });
    head.querySelectorAll('.th-beat').forEach((th) => {
      th.addEventListener('click', () => gotoBeat(Number(th.dataset.beat)));
    });
    $('thAddBeat')?.addEventListener('click', addBeat);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  /* ---------------- 顶部控件渲染 ---------------- */
  function renderToolbar() {
    $('beatLabel').textContent = beatName(currentBeat);
    $('beatCounter').textContent = '共 ' + state.beats + ' 拍';
    const slider = $('beatSlider');
    slider.max = String(state.beats);
    slider.value = String(currentBeat);
    slider.disabled = settingActorId !== null;
    $('prevBeat').disabled = currentBeat === 0 || settingActorId !== null;
    $('nextBeat').disabled = currentBeat === state.beats || settingActorId !== null;
    $('playBtn').classList.toggle('active', playing);
    $('editStartBtn').classList.toggle('active', settingActorId !== null);
    $('editStartBtn').textContent = settingActorId
      ? '✚ 退出起点模式（' + (actorById(settingActorId)?.name || '') + '）'
      : '✚ 设置起点模式';
    const banner = $('startBanner');
    banner.classList.toggle('hidden', settingActorId === null);
    if (settingActorId) $('startActorName').textContent = actorById(settingActorId)?.name || '';
  }

  function renderAll() {
    renderStage();
    renderActors();
    renderConflicts();
    renderTable();
    renderToolbar();
    renderReports();
    renderComparisons();
  }

  /* ---------------- 动作编辑（越界拦截） ---------------- */
  function onMoveChange(e) {
    const actor = actorById(e.target.dataset.aid);
    const beat = Number(e.target.dataset.beat);
    const dir = e.target.value;
    if (!actor) return;

    actor.moves[String(beat)] = dir;
    const trial = simulate(state.actors, state.beats);
    const hit = trial.blocked.find((b) => b.beat === beat && b.actorId === actor.id && b.dir === dir);
    if (hit) {
      // 立即拦截：不保存该动作
      delete actor.moves[String(beat)];
      const { c, r } = parseKey(hit.from);
      toast('⛔ 第 ' + beat + ' 拍：' + actor.name + ' 向「' + DIRS[dir].label +
        '」会从 (' + c + ',' + r + ') 走出舞台，动作已拦截', 'error');
      resim();
      renderTable();
      return;
    }
    commit();
    const downstream = trial.blocked.filter((b) => b.actorId === actor.id).length;
    if (downstream > 0) toast('已保存，但该演员后续有 ' + downstream + ' 个越界动作被标记', 'error');
  }

  /* ---------------- 起点设置 ---------------- */
  function toggleStartSetting(id) {
    settingActorId = settingActorId === id ? null : id;
    if (settingActorId && currentBeat !== 0) currentBeat = 0;
    stopPlay();
    commit();
  }

  function onStageClick(e) {
    if (!settingActorId) return;
    const cellEl = e.target.closest('.cell');
    if (!cellEl) return;
    const actor = actorById(settingActorId);
    if (!actor) { settingActorId = null; renderAll(); return; }
    const { c, r } = parseKey(cellEl.dataset.key);
    if (actor.start && actor.start.c === c && actor.start.r === r) {
      actor.start = null;
      toast('已取消 ' + actor.name + ' 的起点');
    } else {
      actor.start = { c, r };
      const trial = simulate(state.actors, state.beats);
      const blockedN = trial.blocked.filter((b) => b.actorId === actor.id).length;
      toast('已将 ' + actor.name + ' 起点设为 (' + c + ', ' + r + ')' +
        (blockedN ? '；有 ' + blockedN + ' 个越界动作被拦截' : ''), blockedN ? 'error' : 'ok');
    }
    commit();
  }

  /* ---------------- 拍 / 播放 ---------------- */
  function gotoBeat(b) {
    const next = Math.min(Math.max(b, 0), state.beats);
    if (next === currentBeat) return;
    currentBeat = next;
    focusKey = null;
    stopPlay();
    save();
    renderAll();
  }
  function stopPlay() {
    playing = false;
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
  }
  function togglePlay() {
    if (settingActorId) return;
    if (playing) { stopPlay(); renderToolbar(); return; }
    if (currentBeat === state.beats) currentBeat = 0;
    playing = true;
    renderToolbar();
    playTimer = setInterval(() => {
      if (currentBeat >= state.beats) { stopPlay(); renderToolbar(); return; }
      currentBeat += 1;
      focusKey = null;
      save();
      renderAll();
    }, 800);
  }

  /* ---------------- 演员 / 拍增删 ---------------- */
  function addActor() {
    const actor = {
      id: uid('a'),
      name: '演员' + state.nextActorNum++,
      start: null,
      moves: {}
    };
    state.actors.push(actor);
    settingActorId = actor.id;
    currentBeat = 0;
    stopPlay();
    commit();
    toast('已添加 ' + actor.name + '，请在舞台上点击格子设置起点');
  }

  function addBeat() {
    if (state.beats >= 100) { toast('最多支持 100 拍', 'error'); return; }
    state.beats += 1;
    commit(state.beats);
  }

  function removeBeat() {
    if (state.beats <= 1) { toast('至少保留 1 拍', 'error'); return; }
    const dead = state.beats;
    state.beats -= 1;
    state.actors.forEach((a) => delete a.moves[String(dead)]);
    if (currentBeat > state.beats) currentBeat = state.beats;
    commit();
  }

  /* ---------------- 冲突定位 ---------------- */
  function focusConflict(key) {
    const cf = findConflict(key);
    if (!cf) return;
    stopPlay();
    settingActorId = null;
    currentBeat = cf.beat;
    focusKey = key;
    save();
    renderAll();

    // 走位表对应格闪烁
    cf.actorIds.forEach((id) => {
      if (cf.beat === 0) return;
      const td = document.querySelector('.move-cell[data-aid="' + id + '"][data-beat="' + cf.beat + '"]');
      if (td) {
        td.classList.remove('flash');
        void td.offsetWidth; // 重置动画
        td.classList.add('flash');
        setTimeout(() => td.classList.remove('flash'), 1100);
      }
    });
    const item = document.querySelector('.conflict-item[data-cf="' + key + '"]');
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('stage').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function focusNextConflict() {
    const items = allConflicts();
    if (!items.length) { toast('当前没有冲突'); return; }
    let target = items.find((cf) => cf.beat > currentBeat) ||
      items.find((cf) => cf.beat === currentBeat && cf.key > (focusKey || '')) ||
      items[0];
    focusConflict(target.key);
  }

  /* ---------------- 导入 / 导出 / 清空 ---------------- */
  function exportJson() {
    const payload = {
      app: 'stage-blocking-tool', version: 1,
      savedAt: new Date().toISOString(),
      state
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const stamp = '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = 'stage-blocking-' + stamp + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        state = normalizeState(parsed.state || parsed);
        currentBeat = 0;
        focusKey = null;
        stopPlay();
        commit();
        toast('导入成功：' + state.actors.length + ' 位演员，' + state.beats + ' 拍', 'ok');
      } catch (err) {
        toast('导入失败：文件格式不正确', 'error');
      }
    };
    reader.readAsText(file);
  }

  function resetAll() {
    if (!confirm('确定清空全部演员与走位表吗？此操作只影响本浏览器的本地存档。')) return;
    state = freshState();
    reports = [];
    comparisons = [];
    currentBeat = 0;
    focusKey = null;
    settingActorId = null;
    stopPlay();
    closeViewer();
    closeCompareViewer();
    closeCreateReport();
    closeCompareModal();
    commit();
    toast('已清空，可重新开始排练', 'ok');
  }

  /* ============================================================
   * 排练场记报告（只读快照）
   * ============================================================ */
  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  const beatLabel = (b) => (b === 0 ? '起点' : '第 ' + b + ' 拍');
  const rangeLabel = (lo, hi) => beatLabel(lo) + ' — ' + beatLabel(hi);
  const reportById = (id) => reports.find((r) => r.id === id) || null;

  function renderReports() {
    const box = $('reportList');
    box.innerHTML = '';
    if (!reports.length) {
      box.innerHTML = '<li class="empty-hint">还没有报告：选择拍次范围与演员后可生成只读快照。</li>';
      return;
    }
    reports.slice().reverse().forEach((r) => {
      const li = document.createElement('li');
      li.className = 'report-row';
      li.dataset.rid = r.id;
      const c = r.counts;
      const summary = c.total === 0 ? '无冲突' :
        '🔴' + c.collision + ' 🔁' + c.swap + ' ⛔' + c.blocked;
      li.innerHTML =
        '<button type="button" class="report-open" title="查看只读报告">' +
        '<span class="rr-title"></span>' +
        '<span class="rr-meta">' + rangeLabel(r.fromBeat, r.toBeat) + ' · ' +
        r.actors.length + ' 人 · ' + summary + '</span>' +
        '<span class="rr-time">' + fmtDateTime(r.createdAt) + '</span>' +
        '</button>' +
        '<button type="button" class="row-btn rr-cmp" title="与另一份报告对比" aria-label="与另一份报告对比">⚖</button>' +
        '<button type="button" class="row-btn rr-dl" title="下载报告 JSON" aria-label="下载报告 JSON">⬇</button>' +
        '<button type="button" class="row-btn rr-del" title="删除报告" aria-label="删除报告">✕</button>';
      li.querySelector('.rr-title').textContent = r.title;
      li.querySelector('.report-open').addEventListener('click', () => viewReport(r.id));
      li.querySelector('.rr-cmp').addEventListener('click', () => openCompareModal(r.id));
      li.querySelector('.rr-dl').addEventListener('click', () => downloadReport(r.id));
      li.querySelector('.rr-del').addEventListener('click', () => deleteReport(r.id));
      box.appendChild(li);
    });
  }

  /* ---------- 生成报告弹窗 ---------- */
  function fillCreateForm() {
    const select = $('rpFrom');
    select.innerHTML = '';
    for (let b = 0; b <= state.beats; b++) {
      const opt = document.createElement('option');
      opt.value = String(b);
      opt.textContent = beatLabel(b);
      select.appendChild(opt);
    }
    const toSelect = $('rpTo');
    toSelect.innerHTML = '';
    for (let b = 0; b <= state.beats; b++) {
      const opt = document.createElement('option');
      opt.value = String(b);
      opt.textContent = beatLabel(b);
      if (b === state.beats) opt.selected = true;
      toSelect.appendChild(opt);
    }
    $('rpTitle').value = '场记报告 ' + fmtDateTime(new Date().toISOString());

    const list = $('rpActors');
    list.innerHTML = '';
    if (!state.actors.length) {
      list.innerHTML = '<li class="empty-hint">还没有演员，请先添加演员。</li>';
      return;
    }
    state.actors.forEach((actor, idx) => {
      const li = document.createElement('li');
      li.innerHTML =
        '<label class="rp-actor-label">' +
        '<input type="checkbox" class="rp-actor-cb" value="' + escapeHtml(actor.id) + '" checked>' +
        '<span class="actor-dot" style="background:' + PALETTE[idx % PALETTE.length] + '"></span>' +
        '<span class="rp-actor-name"></span></label>';
      li.querySelector('.rp-actor-name').textContent =
        actor.name + (actor.start ? '（' + actor.start.c + '-' + actor.start.r + '）' : '（未设起点）');
      list.appendChild(li);
    });
  }

  function openCreateReport() {
    if (!state.actors.length) { toast('请先添加演员再生成报告', 'error'); return; }
    fillCreateForm();
    $('reportModal').classList.remove('hidden');
    $('rpTitle').focus();
  }
  function closeCreateReport() {
    $('reportModal').classList.add('hidden');
  }

  function submitCreateReport() {
    const actorIds = Array.from($('reportModal').querySelectorAll('.rp-actor-cb:checked'))
      .map((cb) => cb.value);
    if (!actorIds.length) { toast('请至少选择一位演员', 'error'); return; }
    const title = $('rpTitle').value;
    let fromBeat = Number($('rpFrom').value);
    let toBeat = Number($('rpTo').value);
    if (fromBeat > toBeat) { [fromBeat, toBeat] = [toBeat, fromBeat]; }

    let report;
    try {
      report = buildReport({ state, actorIds, fromBeat, toBeat, title });
    } catch (err) {
      toast('生成失败：走位数据异常', 'error');
      return;
    }
    reports.push(report);
    save();
    renderReports();
    closeCreateReport();
    toast('已生成只读报告快照，后续编辑走位不会改变它', 'ok');
    viewReport(report.id);
  }

  /* ---------- 报告查看器 ---------- */
  function viewReport(id) {
    const r = reportById(id);
    if (!r) return;
    renderReportSheet(r);
    $('viewerOverlay').dataset.rid = r.id;
    $('viewerOverlay').classList.remove('hidden');
    $('viewerOverlay').scrollTop = 0;
  }
  function closeViewer() {
    const ov = $('viewerOverlay');
    if (ov) ov.classList.add('hidden');
    document.body.classList.remove('printing-report');
  }

  function renderReportSheet(r) {
    const head = $('sheetHead');
    head.textContent = r.title;
    $('sheetMeta').textContent =
      '生成时间：' + fmtDateTime(r.createdAt) + '　|　拍次范围：' +
      rangeLabel(r.fromBeat, r.toBeat) + '　|　演员：' +
      r.actors.map((a) => a.name).join('、') + '　|　舞台：' +
      r.grid.cols + '×' + r.grid.rows;
    $('sheetFrozenNote').textContent =
      '本报告为只读快照，生成时的走位已固化；之后在主界面编辑走位不会改变本报告内容。';

    const c = r.counts;
    $('sheetSummary').innerHTML =
      '<span class="ss-item"><b>' + (r.toBeat - r.fromBeat + 1) + '</b> 个拍次</span>' +
      '<span class="ss-item"><b>' + r.actors.length + '</b> 位演员</span>' +
      '<span class="ss-item ss-total">冲突合计 <b>' + c.total + '</b></span>' +
      '<span class="ss-item ss-col">🔴 同格 <b>' + c.collision + '</b></span>' +
      '<span class="ss-item ss-swp">🔁 互换 <b>' + c.swap + '</b></span>' +
      '<span class="ss-item ss-blk">⛔ 越界 <b>' + c.blocked + '</b></span>';

    // 逐拍：每人坐标与动作
    const beatsBox = $('sheetBeats');
    beatsBox.innerHTML = '';
    const markGlyph = { collision: '🔴', swap: '🔁', blocked: '⛔' };
    const markLabel = { collision: '同格', swap: '互换', blocked: '越界' };
    r.beats.forEach((bk) => {
      const sec = document.createElement('section');
      sec.className = 'sheet-beat';
      const beatConflicts = bk.collisionCount + bk.swapCount + bk.blockedCount;
      const note = beatConflicts === 0 ? '本拍无冲突' :
        '🔴 ' + bk.collisionCount + '　🔁 ' + bk.swapCount + '　⛔ ' + bk.blockedCount;
      let html =
        '<h3 class="sb-title"><span class="sb-beat"></span>' +
        '<span class="sb-note">' + note + '</span></h3>' +
        '<table class="sheet-table"><thead><tr>' +
        '<th>演员</th><th>坐标</th>' + (bk.beat === 0 ? '<th>起点</th>' : '<th>动作</th>') +
        '<th>状态</th></tr></thead><tbody>';
      bk.rows.forEach((row) => {
        let status;
        if (!row.coord) status = '<span class="rs-na">未参与推演（无起点）</span>';
        else if (!row.marks.length) status = '<span class="rs-ok">正常</span>';
        else status = row.marks.map((m) =>
          '<span class="rs-mark rs-' + m + '">' + markGlyph[m] + ' ' + markLabel[m] + '</span>').join(' ');
        const move = bk.beat === 0 ? '起点' :
          '<span class="mv-glyph">' + DIRS[row.move === null ? 'S' : row.move].glyph + '</span> ' +
          '<span class="mv-label">' + DIRS[row.move === null ? 'S' : row.move].label + '</span>' +
          (row.blocked ? ' <span class="mv-intercept">（已拦截，原地）</span>' : '');
        html += '<tr' + (row.marks.length ? ' class="row-conflict"' : '') + '>' +
          '<td class="cell-actor">' + escapeHtml(row.name) + '</td>' +
          '<td>' + (row.coord ? '(' + escapeHtml(row.coord) + ')' : '<span class="rs-na">—</span>') + '</td>' +
          '<td>' + move + '</td>' +
          '<td class="cell-status">' + status + '</td></tr>';
      });
      html += '</tbody></table>';
      sec.innerHTML = html;
      sec.querySelector('.sb-beat').textContent = beatLabel(bk.beat);
      beatsBox.appendChild(sec);
    });

    // 冲突汇总：可跳回对应拍次
    const cfBox = $('sheetConflicts');
    if (!r.conflicts.length) {
      cfBox.innerHTML = '<p class="sheet-empty">所选范围内没有冲突 🎉</p>';
    } else {
      cfBox.innerHTML = '';
      const icon = { collision: '🔴', swap: '🔁', blocked: '⛔' };
      r.conflicts.forEach((cf) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sheet-conflict sc-' + cf.kind;
        btn.dataset.cfkey = cf.key;
        btn.dataset.beat = String(cf.beat);
        btn.innerHTML =
          '<span class="sc-icon">' + icon[cf.kind] + '</span>' +
          '<span class="sc-beat">' + beatLabel(cf.beat) + '</span>' +
          '<span class="sc-text"></span>' +
          '<span class="sc-cells">(' + cf.cells.map(escapeHtml).join(')、(') + ')</span>' +
          '<span class="sc-jump">↗ 跳回此拍</span>';
        btn.querySelector('.sc-text').textContent = cf.text;
        btn.addEventListener('click', () => jumpToReportConflict(r, cf));
        cfBox.appendChild(btn);
      });
    }
  }

  // 报告中的冲突条目 → 关闭只读视图并在编辑器中跳到对应拍次定位
  function jumpToReportConflict(r, cf) {
    closeViewer();
    stopPlay();
    settingActorId = null;
    const targetBeat = Math.min(cf.beat, state.beats);
    currentBeat = targetBeat;
    focusKey = null;
    save();
    renderAll();
    const live = findConflict(cf.key);
    if (live) {
      focusConflict(cf.key);
      toast('已跳回 ' + beatLabel(cf.beat) + ' 定位冲突', 'ok');
    } else {
      toast('已跳到 ' + beatLabel(targetBeat) +
        '；该冲突在当前走位中已不存在（走位相对报告快照有改动）');
    }
  }

  function printReport() {
    if ($('viewerOverlay').classList.contains('hidden')) return;
    document.body.classList.add('printing-report');
    const done = () => document.body.classList.remove('printing-report');
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    // 部分浏览器不触发 afterprint：兜底恢复
    setTimeout(done, 1500);
  }

  function downloadReport(id) {
    const r = reportById(id);
    if (!r) return;
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    a.href = URL.createObjectURL(blob);
    a.download = 'stage-blocking-report-' + stamp + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已下载报告 JSON 快照', 'ok');
  }

  function deleteReport(id) {
    const r = reportById(id);
    if (!r) return;
    if (!confirm('确定删除报告「' + r.title + '」吗？此操作只影响本浏览器的本地存档。\n' +
      '（已保存的报告对比记录不会被删除，仍可查看，但其中引用的报告将标记为已删除。）')) return;
    reports = reports.filter((x) => x.id !== id);
    save();
    renderReports();
    closeViewer();
    toast('已删除报告');
  }

  /* ============================================================
   * 报告对比 UI
   * ============================================================ */
  const compareById = (id) => comparisons.find((x) => x.id === id) || null;
  let compareOnlyDiffs = false;   // 对比视图「仅看差异」开关（不进存档）

  /* ---------- 已保存对比列表 ---------- */
  function renderComparisons() {
    const box = $('compareList');
    if (!box) return;
    box.innerHTML = '';
    if (!comparisons.length) {
      box.innerHTML = '<li class="empty-hint">还没有对比记录：先选择两份已保存报告再生成对比。</li>';
      return;
    }
    comparisons.slice().reverse().forEach((cmp) => {
      const li = document.createElement('li');
      li.className = 'report-row compare-row';
      li.dataset.cid = cmp.id;
      const missingA = !reportById(cmp.a.id);
      const missingB = !reportById(cmp.b.id);
      const c = cmp.counts;
      const summary = '新增' + c.added.total + ' · 消除' + c.removed.total + ' · 保持' + c.kept.total;
      li.innerHTML =
        '<button type="button" class="report-open" title="查看报告对比">' +
        '<span class="rr-title"></span>' +
        '<span class="rr-meta">' + summary + (cmp.diffRowCount ? ' · 走位差异 ' + cmp.diffRowCount + ' 行' : '') + '</span>' +
        '<span class="rr-time">' + fmtDateTime(cmp.createdAt) + '</span>' +
        '</button>' +
        '<button type="button" class="row-btn rr-dl" title="下载对比 JSON" aria-label="下载对比 JSON">⬇</button>' +
        '<button type="button" class="row-btn rr-del" title="删除对比记录" aria-label="删除对比记录">✕</button>';
      li.querySelector('.rr-title').textContent =
        '⚖ ' + cmp.a.title + (missingA ? '（已删除）' : '') +
        ' ⇄ ' + cmp.b.title + (missingB ? '（已删除）' : '');
      li.querySelector('.report-open').addEventListener('click', () => viewComparison(cmp.id));
      li.querySelector('.rr-dl').addEventListener('click', () => downloadComparison(cmp.id));
      li.querySelector('.rr-del').addEventListener('click', () => deleteComparison(cmp.id));
      box.appendChild(li);
    });
  }

  /* ---------- 选择两份报告的弹窗 ---------- */
  function fillSelect(selId, otherSelId, prevValue) {
    const sel = $(selId);
    sel.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— 请选择报告 —';
    sel.appendChild(blank);
    reports.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.title + '（' + rangeLabel(r.fromBeat, r.toBeat) +
        ' · ' + r.actors.length + ' 人 · ' + fmtDateTime(r.createdAt) + '）';
      sel.appendChild(opt);
    });
    sel.value = reports.some((r) => r.id === prevValue) ? prevValue : '';
    sel.onchange = () => {
      // 两份不能是同一份：自动把另一侧清开
      const other = $(otherSelId);
      if (sel.value && other.value === sel.value) other.value = '';
      updateComparePreview();
    };
  }

  function fillCompareForm(preselectId) {
    const valid = (id) => reports.some((r) => r.id === id) ? id : '';
    let aId = valid(preselectId);
    let bId = '';
    if (aId) {
      // 快捷入口：预选被点击的那份作为 A 侧，并挑一份相邻的不同报告作为 B 侧
      const idx = reports.findIndex((r) => r.id === aId);
      bId = (reports[idx + 1] || reports[idx - 1] || {}).id || '';
    } else if (reports.length >= 2) {
      // 从面板按钮进入：默认预选最新的两份，用户可改
      aId = reports[reports.length - 1].id;
      bId = reports[reports.length - 2].id;
    }
    fillSelect('cmpA', 'cmpB', aId);
    fillSelect('cmpB', 'cmpA', bId);
    $('cmpTitle').value = '';
    updateComparePreview();
  }

  function openCompareModal(preselectId) {
    if (reports.length < 2) {
      toast('需要至少两份已保存报告才能对比', 'error');
      return;
    }
    fillCompareForm(preselectId);
    $('compareModal').classList.remove('hidden');
    $('cmpA').focus();
  }
  function closeCompareModal() {
    const el = $('compareModal');
    if (el) el.classList.add('hidden');
  }

  function updateComparePreview() {
    const note = $('cmpNote');
    const aId = $('cmpA').value;
    const bId = $('cmpB').value;
    const rA = reportById(aId);
    const rB = reportById(bId);
    if (!rA || !rB) {
      note.className = 'rp-note cmp-note';
      note.textContent = '请在两侧各选择一份已保存的只读报告（不能是同一份）。';
      return;
    }
    const commonActors = rA.actors.filter((x) => rB.actors.some((y) => y.id === x.id));
    const lo = Math.max(rA.fromBeat, rB.fromBeat);
    const hi = Math.min(rA.toBeat, rB.toBeat);
    const aOnlyActors = rA.actors.filter((x) => !rB.actors.some((y) => y.id === x.id));
    const bOnlyActors = rB.actors.filter((x) => !rA.actors.some((y) => y.id === x.id));
    const aOnlyBeats = [];
    for (let b = rA.fromBeat; b <= rA.toBeat; b++) {
      if (b < rB.fromBeat || b > rB.toBeat) aOnlyBeats.push(b);
    }
    const bOnlyBeats = [];
    for (let b = rB.fromBeat; b <= rB.toBeat; b++) {
      if (b < rA.fromBeat || b > rA.toBeat) bOnlyBeats.push(b);
    }

    let html = '对齐范围：共同演员 <b>' + commonActors.length + '</b> 位' +
      (commonActors.length ? '（' + commonActors.map((x) => escapeHtml(x.name)).join('、') + '）' : '') +
      '；共同拍次 <b>' + (lo <= hi ? hi - lo + 1 : 0) + '</b> 个' +
      (lo <= hi ? '（' + rangeLabel(lo, hi) + '）' : '');
    if (aOnlyActors.length || bOnlyActors.length) {
      html += '<br>仅一方包含的演员（不参与对比，仅提示）：' +
        (aOnlyActors.length ? 'A 侧 ' + aOnlyActors.map((x) => escapeHtml(x.name)).join('、') : '') +
        (aOnlyActors.length && bOnlyActors.length ? '；' : '') +
        (bOnlyActors.length ? 'B 侧 ' + bOnlyActors.map((x) => escapeHtml(x.name)).join('、') : '');
    }
    if (aOnlyBeats.length || bOnlyBeats.length) {
      html += '<br>仅一方包含的拍次（不参与对比，仅提示）：' +
        (aOnlyBeats.length ? 'A 侧 ' + aOnlyBeats.map(beatLabel).join('、') : '') +
        (aOnlyBeats.length && bOnlyBeats.length ? '；' : '') +
        (bOnlyBeats.length ? 'B 侧 ' + bOnlyBeats.map(beatLabel).join('、') : '');
    }
    if (!commonActors.length) {
      html = '⚠ <b>两份报告没有共同演员，无法对比，且不会生成对比结果。</b><br>' + html;
    } else if (lo > hi) {
      html = '⚠ <b>两份报告的拍次范围完全不重叠，无法对比，且不会生成对比结果。</b><br>' + html;
    }
    note.className = 'rp-note cmp-note' + ((!commonActors.length || lo > hi) ? ' warn' : '');
    note.innerHTML = html;
  }

  function submitCompare() {
    const aId = $('cmpA').value;
    const bId = $('cmpB').value;
    const rA = reportById(aId);
    const rB = reportById(bId);
    if (!rA || !rB) { toast('请先在两侧各选择一份报告', 'error'); return; }
    if (aId === bId) { toast('不能把同一份报告与它自己对比', 'error'); return; }

    let cmp;
    try {
      cmp = buildComparison({ a: rA, b: rB, title: $('cmpTitle').value });
    } catch (err) {
      toast('对比失败：报告数据异常', 'error');
      return;
    }
    if (!cmp.comparable) {
      closeCompareModal();
      showIncomparable(cmp);
      return;
    }
    comparisons.push(cmp);
    save();
    renderComparisons();
    closeCompareModal();
    toast('已生成对比并随本地存档保留', 'ok');
    viewComparison(cmp.id);
  }

  // 不可比（无共同演员 / 无共同拍次）：只展示提示，不保存、不打印、不导出
  function showIncomparable(cmp) {
    const overlay = $('compareViewer');
    const sheet = $('cmpSheet');
    overlay.dataset.cid = '';
    $('cmpViewTitle').textContent = '⚖ 报告对比（无法对齐）';
    let html = '<div class="cmp-incomparable">' +
      '<h2>⚠ 无法生成对比结果</h2>' +
      '<p class="cmp-inc-reason">' +
      (cmp.reason === 'no-common-actors'
        ? '两份报告<b>没有任何共同演员</b>，无法按演员逐拍对齐。'
        : '两份报告的<b>拍次范围完全不重叠</b>，没有可对齐的共同拍次。') +
      '</p>' +
      '<table class="cmp-inc-table"><tbody>' +
      '<tr><th>A 侧报告</th><td>' + escapeHtml(cmp.a.title) + '</td>' +
      '<td>生成于 ' + fmtDateTime(cmp.a.createdAt) + '</td></tr>' +
      '<tr><th>B 侧报告</th><td>' + escapeHtml(cmp.b.title) + '</td>' +
      '<td>生成于 ' + fmtDateTime(cmp.b.createdAt) + '</td></tr>' +
      '</tbody></table><ul class="cmp-inc-list">';
    if (cmp.reason === 'no-common-actors') {
      html += '<li>仅 A 侧包含的演员（' + cmp.aOnlyActors.length + ' 位）：' +
        (cmp.aOnlyActors.map((x) => escapeHtml(x.name)).join('、') || '无') + '</li>';
      html += '<li>仅 B 侧包含的演员（' + cmp.bOnlyActors.length + ' 位）：' +
        (cmp.bOnlyActors.map((x) => escapeHtml(x.name)).join('、') || '无') + '</li>';
      html += '<li>两边演员 id 没有任何交集，无法判断「同一演员」在两份快照间的变化。</li>';
    } else {
      html += '<li>仅 A 侧报告覆盖的拍次：' +
        (cmp.aOnlyBeats.length ? cmp.aOnlyBeats.map(beatLabel).join('、') : '无') + '</li>';
      html += '<li>仅 B 侧报告覆盖的拍次：' +
        (cmp.bOnlyBeats.length ? cmp.bOnlyBeats.map(beatLabel).join('、') : '无') + '</li>';
      html += '<li>共同演员有 ' + cmp.actors.length + ' 位，但没有任何一个共同拍次可比较。</li>';
    }
    html += '</ul><p class="cmp-inc-foot">为避免拍次错位造成误导，未生成任何差异条目，本次结果也不会写入本地存档。</p></div>';
    sheet.innerHTML = html;
    $('cmpPrint').setAttribute('disabled', '');
    $('cmpDownload').setAttribute('disabled', '');
    $('cmpOnlyDiffs').classList.add('hidden');
    overlay.classList.remove('hidden');
    overlay.scrollTop = 0;
  }

  /* ---------- 对比查看器 ---------- */
  function viewComparison(id) {
    const cmp = compareById(id);
    if (!cmp) return;
    compareOnlyDiffs = false;
    renderComparisonSheet(cmp);
    const overlay = $('compareViewer');
    overlay.dataset.cid = cmp.id;
    $('cmpPrint').removeAttribute('disabled');
    $('cmpDownload').removeAttribute('disabled');
    const toggle = $('cmpOnlyDiffs');
    toggle.classList.remove('hidden');
    toggle.classList.remove('active');
    $('cmpViewTitle').textContent = '⚖ 报告对比（只读）';
    overlay.classList.remove('hidden');
    overlay.scrollTop = 0;
  }
  function closeCompareViewer() {
    const el = $('compareViewer');
    if (el) el.classList.add('hidden');
    document.body.classList.remove('printing-compare');
  }

  const CMP_ICON = { collision: '🔴', swap: '🔁', blocked: '⛔' };
  const CMP_KIND_LABEL = { collision: '同格', swap: '互换', blocked: '越界' };
  const CMP_STATUS_LABEL = { added: '新增', removed: '消除', kept: '保持' };

  function renderComparisonSheet(cmp) {
    const sheet = $('cmpSheet');
    const missingA = !reportById(cmp.a.id);
    const missingB = !reportById(cmp.b.id);

    let html = '<header class="sheet-header cmp-header">' +
      '<h1></h1>' +
      '<p class="sheet-meta">' +
      '对比生成时间：' + fmtDateTime(cmp.createdAt) +
      '　|　共同演员：<b>' + cmp.actors.length + '</b> 位' +
      '　|　共同拍次：<b>' + cmp.commonBeats.length + '</b> 个（' +
      rangeLabel(cmp.overlap.fromBeat, cmp.overlap.toBeat) + '）' +
      '</p>' +
      '<div class="cmp-sides">' +
      '<div class="cmp-side cmp-side-a"><span class="cmp-side-tag">A 侧</span><span class="cmp-side-title"></span>' +
      '<span class="cmp-side-missing"></span></div>' +
      '<div class="cmp-side cmp-side-b"><span class="cmp-side-tag">B 侧</span><span class="cmp-side-title"></span>' +
      '<span class="cmp-side-missing"></span></div>' +
      '</div>';

    // 独有演员 / 独有拍次提示（明确提示、不进差异统计）
    const notes = [];
    if (cmp.aOnlyActors.length) {
      notes.push('仅 A 侧包含的演员（不参与对比）：' +
        cmp.aOnlyActors.map((x) => escapeHtml(x.name)).join('、'));
    }
    if (cmp.bOnlyActors.length) {
      notes.push('仅 B 侧包含的演员（不参与对比）：' +
        cmp.bOnlyActors.map((x) => escapeHtml(x.name)).join('、'));
    }
    if (cmp.aOnlyBeats.length) {
      notes.push('仅 A 侧报告覆盖的拍次（不参与对比）：' +
        cmp.aOnlyBeats.map(beatLabel).join('、'));
    }
    if (cmp.bOnlyBeats.length) {
      notes.push('仅 B 侧报告覆盖的拍次（不参与对比）：' +
        cmp.bOnlyBeats.map(beatLabel).join('、'));
    }
    if (notes.length) html += '<div class="cmp-note-box">' + notes.map((n) => '<p>' + n + '</p>').join('') + '</div>';

    // 汇总卡：新增 / 消除 / 保持 × 同格 / 互换 / 越界
    const c = cmp.counts;
    const card = (cls, label, g) =>
      '<div class="cmp-card ' + cls + '"><span class="cc-label">' + label + '</span>' +
      '<span class="cc-total"><b>' + g.total + '</b></span>' +
      '<span class="cc-detail">🔴 ' + g.collision + '　🔁 ' + g.swap + '　⛔ ' + g.blocked + '</span></div>';
    html += '<div class="cmp-summary">' +
      '<span class="cs-base">共同范围内冲突变化</span>' +
      card('cc-added', 'A → B 新增', c.added) +
      card('cc-removed', 'B 相对 A 消除', c.removed) +
      card('cc-kept', '两侧保持', c.kept) +
      '<span class="cs-base">走位差异 <b>' + cmp.diffRowCount + '</b> 行（坐标或动作不同）</span>' +
      '</div></header>';

    // 逐拍差异
    html += '<section><h2 class="sheet-section-title">逐拍走位差异（按共同演员与共同拍次对齐）</h2>' +
      '<p class="sheet-sub-hint">每个共同拍次下列出全部共同演员的 A / B 两侧坐标与动作，坐标或动作不同的格子以 <b>≠</b> 与底色高亮；' +
      '每行可「↗ 跳回此拍」关闭对比并在走位编辑器中定位。</p><div class="cmp-beats">';
    cmp.beats.forEach((bk) => {
      const changed = bk.rows.filter((r) => r.changed);
      if (compareOnlyDiffs && !changed.length) return;
      html += '<section class="sheet-beat cmp-beat' + (changed.length ? '' : ' cmp-beat-same') + '">' +
        '<h3 class="sb-title"><span class="sb-beat">' + beatLabel(bk.beat) + '</span>' +
        '<span class="sb-note">' + (changed.length ? changed.length + ' 行有差异' : '本拍共同演员走位一致') +
        '</span></h3>';
      html += '<table class="sheet-table cmp-table"><thead><tr>' +
        '<th>演员</th><th>A 侧坐标</th><th>B 侧坐标</th><th>坐标差异</th>' +
        '<th>A 侧动作</th><th>B 侧动作</th><th>动作差异</th><th></th></tr></thead><tbody>';
      bk.rows.forEach((row) => {
        const showRow = !compareOnlyDiffs || row.changed;
        if (!showRow) return;
        const nameCell = row.renamed
          ? '<span title="同一演员在两份报告中姓名不同">' + escapeHtml(row.nameA) +
            ' <span class="cmp-rename">→ ' + escapeHtml(row.nameB) + '</span></span>'
          : escapeHtml(row.nameA);
        html += '<tr' + (row.changed ? ' class="row-conflict"' : '') + '>' +
          '<td class="cell-actor">' + nameCell + '</td>' +
          '<td class="cmp-coord' + (row.coordChanged ? ' diff' : '') + '">' +
          (row.coordA ? '(' + escapeHtml(row.coordA) + ')' : '<span class="rs-na">未参与</span>') + '</td>' +
          '<td class="cmp-coord' + (row.coordChanged ? ' diff' : '') + '">' +
          (row.coordB ? '(' + escapeHtml(row.coordB) + ')' : '<span class="rs-na">未参与</span>') + '</td>' +
          '<td>' + (row.coordChanged ? '<span class="cmp-flag flag-changed">≠</span>' : '<span class="cmp-flag flag-same">＝</span>') + '</td>' +
          '<td' + (row.moveChanged ? ' class="diff"' : '') + '>' + moveCellHtml(row.moveA) + '</td>' +
          '<td' + (row.moveChanged ? ' class="diff"' : '') + '>' + moveCellHtml(row.moveB) + '</td>' +
          '<td>' + (row.moveChanged ? '<span class="cmp-flag flag-changed">≠</span>' : '<span class="cmp-flag flag-same">＝</span>') + '</td>' +
          '<td><button type="button" class="cmp-jump-btn" data-beat="' + bk.beat + '">↗ 跳回此拍</button></td>' +
          '</tr>';
      });
      html += '</tbody></table></section>';
    });
    if (compareOnlyDiffs && cmp.beats.every((bk) => !bk.changedCount)) {
      html += '<p class="sheet-empty">共同范围内没有任何走位差异 🎉</p>';
    }
    html += '</div></section>';

    // 冲突变化汇总
    html += '<section><h2 class="sheet-section-title">冲突变化汇总（新增 / 消除 / 保持）</h2>' +
      '<p class="sheet-sub-hint">身份规则：同格按拍次与格子归并、互换按拍次与两名共同演员归并、越界按拍次与演员归并；' +
      '仅一方当事人涉及共同演员的条目不参与归并。点击条目可跳回编辑器对应拍次。</p>';
    const groups = [
      ['added', 'A → B 新增的冲突', c.added.total],
      ['removed', 'B 相对 A 消除的冲突', c.removed.total],
      ['kept', '两侧均存在（保持）的冲突', c.kept.total]
    ];
    groups.forEach(([status, label]) => {
      const items = cmp.deltas.filter((d) => d.status === status);
      html += '<h3 class="cmp-group-title cgt-' + status + '">' + label +
        ' <span class="cgt-count">(' + items.length + ')</span></h3>';
      if (!items.length) {
        html += '<p class="cmp-group-empty">无</p>';
      } else {
        html += '<div class="sheet-conflicts cmp-deltas">';
        items.forEach((d) => {
          const text = d.textA === d.textB ? (d.textA || d.textB || CMP_KIND_LABEL[d.kind])
            : (d.textA || '（A 侧无）') + '　→　' + (d.textB || '（B 侧无）');
          const cells = status === 'added' ? d.cellsB : status === 'removed' ? d.cellsA :
            (d.cellsB.length ? d.cellsB : d.cellsA);
          html += '<button type="button" class="sheet-conflict sc-' + d.kind + ' cmp-delta cd-' + status +
            '" data-beat="' + d.beat + '" data-canon="' + escapeHtml(d.key) + '">' +
            '<span class="sc-icon">' + CMP_ICON[d.kind] + '</span>' +
            '<span class="cd-status">' + CMP_STATUS_LABEL[status] + '</span>' +
            '<span class="sc-beat">' + beatLabel(d.beat) + '</span>' +
            '<span class="cd-kind">' + CMP_KIND_LABEL[d.kind] + '</span>' +
            '<span class="sc-text">' + escapeHtml(text) + '</span>' +
            '<span class="sc-cells">(' + cells.map(escapeHtml).join(')、(') + ')</span>' +
            '<span class="sc-jump">↗ 跳回此拍</span></button>';
        });
        html += '</div>';
      }
    });
    html += '</section>';

    sheet.innerHTML = html;
    sheet.querySelector('h1').textContent = cmp.title;
    sheet.querySelector('.cmp-side-a .cmp-side-title').textContent = cmp.a.title;
    sheet.querySelector('.cmp-side-b .cmp-side-title').textContent = cmp.b.title;
    const ma = sheet.querySelector('.cmp-side-a .cmp-side-missing');
    const mb = sheet.querySelector('.cmp-side-b .cmp-side-missing');
    ma.textContent = missingA ? '⚠ 原报告已从本地存档删除' : ('生成于 ' + fmtDateTime(cmp.a.createdAt));
    mb.textContent = missingB ? '⚠ 原报告已从本地存档删除' : ('生成于 ' + fmtDateTime(cmp.b.createdAt));
    if (missingA) ma.classList.add('missing');
    if (missingB) mb.classList.add('missing');

    // 跳回编辑器（逐拍差异行 & 冲突变化条目）
    sheet.querySelectorAll('.cmp-jump-btn').forEach((btn) => {
      btn.addEventListener('click', () => jumpToBeatFromCompare(Number(btn.dataset.beat)));
    });
    sheet.querySelectorAll('.cmp-delta').forEach((btn) => {
      btn.addEventListener('click', () =>
        jumpToBeatFromCompare(Number(btn.dataset.beat), btn.dataset.canon));
    });
  }

  function moveCellHtml(move) {
    if (move === null || move === undefined) return '<span class="rs-na">起点拍 / —</span>';
    return '<span class="mv-glyph">' + DIRS[move].glyph + '</span> ' +
      '<span class="mv-label">' + DIRS[move].label + '</span>';
  }

  // 对比视图 → 关闭覆盖层并在编辑器跳到对应拍次（不修改走位，不覆盖任何快照）
  function jumpToBeatFromCompare(beat, canon) {
    closeCompareViewer();
    stopPlay();
    settingActorId = null;
    const target = Math.min(Math.max(beat, 0), state.beats);
    currentBeat = target;
    focusKey = null;
    save();
    renderAll();
    if (beat !== target) {
      toast('已跳到第 ' + target + ' 拍；当前走位不足 ' + beat + ' 拍（编辑器数据与报告快照不同）');
      return;
    }
    // 若该冲突在当前走位中仍存在，则直接定位（与报告视图的跳转体验一致）
    if (canon) {
      const liveKey = canon.replace(/:/g, '-'); // col:1:3,2 → col-1-3,2，与实时冲突键同构
      if (findConflict(liveKey)) {
        focusConflict(liveKey);
        toast('已跳回 ' + beatLabel(target) + ' 并定位该冲突', 'ok');
        return;
      }
    }
    toast('已跳回 ' + beatLabel(target) + '，可在走位表中核对差异（该冲突在当前走位中已不存在）');
  }

  function printComparison() {
    if ($('compareViewer').classList.contains('hidden')) return;
    if ($('compareViewer').dataset.cid === '') return; // 不可比提示页不可打印
    document.body.classList.add('printing-compare');
    const done = () => document.body.classList.remove('printing-compare');
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    setTimeout(done, 1500);
  }

  function downloadComparison(id) {
    const cmp = compareById(id);
    if (!cmp) return;
    const blob = new Blob([JSON.stringify(cmp, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    a.href = URL.createObjectURL(blob);
    a.download = 'stage-blocking-comparison-' + stamp + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已下载对比 JSON', 'ok');
  }

  function deleteComparison(id) {
    const cmp = compareById(id);
    if (!cmp) return;
    if (!confirm('确定删除这条报告对比记录吗？此操作不会删除两侧的原报告。')) return;
    comparisons = comparisons.filter((x) => x.id !== id);
    save();
    renderComparisons();
    closeCompareViewer();
    toast('已删除对比记录');
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    $('stageGrid').addEventListener('click', onStageClick);
    $('addActorBtn').addEventListener('click', addActor);
    $('addBeatBtn').addEventListener('click', addBeat);
    $('removeBeatBtn').addEventListener('click', removeBeat);
    $('prevBeat').addEventListener('click', () => gotoBeat(currentBeat - 1));
    $('nextBeat').addEventListener('click', () => gotoBeat(currentBeat + 1));
    $('playBtn').addEventListener('click', togglePlay);
    $('editStartBtn').addEventListener('click', () => {
      if (settingActorId) toggleStartSetting(settingActorId);
      else if (state.actors[0]) toggleStartSetting(state.actors[0].id);
      else toast('请先添加演员');
    });
    $('focusNextBtn').addEventListener('click', focusNextConflict);
    $('beatSlider').addEventListener('input', (e) => gotoBeat(Number(e.target.value)));
    $('exportBtn').addEventListener('click', exportJson);
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', (e) => {
      if (e.target.files[0]) importJson(e.target.files[0]);
      e.target.value = '';
    });
    $('resetBtn').addEventListener('click', resetAll);

    // 排练场记报告
    $('newReportBtn').addEventListener('click', openCreateReport);
    $('rpCloseX').addEventListener('click', closeCreateReport);
    $('rpCancel').addEventListener('click', closeCreateReport);
    $('rpSubmit').addEventListener('click', submitCreateReport);
    $('rpSelectAll').addEventListener('click', () => {
      $('reportModal').querySelectorAll('.rp-actor-cb').forEach((cb) => { cb.checked = true; });
    });
    $('rpSelectNone').addEventListener('click', () => {
      $('reportModal').querySelectorAll('.rp-actor-cb').forEach((cb) => { cb.checked = false; });
    });
    $('rpTo').addEventListener('change', () => {
      if (Number($('rpFrom').value) > Number($('rpTo').value)) $('rpFrom').value = $('rpTo').value;
    });
    $('rpFrom').addEventListener('change', () => {
      if (Number($('rpFrom').value) > Number($('rpTo').value)) $('rpTo').value = $('rpFrom').value;
    });
    $('viewerPrint').addEventListener('click', printReport);
    $('viewerDownload').addEventListener('click', () => {
      const id = $('viewerOverlay').dataset.rid;
      if (id) downloadReport(id);
    });
    $('viewerClose').addEventListener('click', closeViewer);
    $('viewerOverlay').addEventListener('click', (e) => {
      if (e.target === $('viewerOverlay')) closeViewer();
    });
    $('reportModal').addEventListener('click', (e) => {
      if (e.target === $('reportModal')) closeCreateReport();
    });

    // 报告对比
    $('newCompareBtn').addEventListener('click', () => openCompareModal());
    $('cmpCloseX').addEventListener('click', closeCompareModal);
    $('cmpCancel').addEventListener('click', closeCompareModal);
    $('cmpSubmit').addEventListener('click', submitCompare);
    $('compareModal').addEventListener('click', (e) => {
      if (e.target === $('compareModal')) closeCompareModal();
    });
    $('cmpPrint').addEventListener('click', printComparison);
    $('cmpDownload').addEventListener('click', () => {
      const id = $('compareViewer').dataset.cid;
      if (id) downloadComparison(id);
    });
    $('cmpClose').addEventListener('click', closeCompareViewer);
    $('cmpOnlyDiffs').addEventListener('click', () => {
      const id = $('compareViewer').dataset.cid;
      const cmp = compareById(id);
      if (!cmp) return;
      compareOnlyDiffs = !compareOnlyDiffs;
      $('cmpOnlyDiffs').classList.toggle('active', compareOnlyDiffs);
      renderComparisonSheet(cmp);
    });
    $('compareViewer').addEventListener('click', (e) => {
      if (e.target === $('compareViewer')) closeCompareViewer();
    });

    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.key === 'Escape') {
        if (!$('compareViewer').classList.contains('hidden')) { closeCompareViewer(); return; }
        if (!$('compareModal').classList.contains('hidden')) { closeCompareModal(); return; }
        if (!$('viewerOverlay').classList.contains('hidden')) { closeViewer(); return; }
        if (!$('reportModal').classList.contains('hidden')) { closeCreateReport(); return; }
        if (settingActorId) {
          settingActorId = null;
          commit();
        }
      } else if (e.key === 'ArrowLeft') {
        gotoBeat(currentBeat - 1);
      } else if (e.key === 'ArrowRight') {
        gotoBeat(currentBeat + 1);
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    load();
    resim();
    buildStage();
    bindEvents();
    renderAll();
    save(); // 首次访问载入的示例数据也立即落盘，刷新后即为同一份可继续编辑
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
