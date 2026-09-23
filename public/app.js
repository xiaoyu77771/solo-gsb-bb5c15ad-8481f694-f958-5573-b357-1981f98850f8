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
  const COMPARE_APP = 'stage-blocking-report-comparison';
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
   * 对齐口径：按「共同演员」(id 同时出现在两份报告中) 与「共同拍次」
   * (两边拍次范围的交集) 对齐；不重叠的部分只给出提示，绝不生成
   * 看起来成立的差异结果。
   * ============================================================ */

  const COMPARE_KINDS = ['collision', 'swap', 'blocked'];
  const COMPARE_KIND_RANK = { collision: 0, swap: 1, blocked: 2 };

  // 紧凑拍次标签：连续段合并为 "a-b"，零拍写作 "起点"
  function compactBeatLabels(beats) {
    const list = beats.slice().sort((x, y) => x - y);
    if (!list.length) return '无';
    const ranges = [];
    let start = list[0];
    let prev = list[0];
    const emit = (lo, hi) => {
      if (lo === hi) ranges.push(lo === 0 ? '起点' : String(lo));
      else ranges.push((lo === 0 ? '起点' : String(lo)) + '-' + hi);
    };
    for (let i = 1; i < list.length; i++) {
      if (list[i] === prev + 1) { prev = list[i]; continue; }
      emit(start, prev);
      start = prev = list[i];
    }
    emit(start, prev);
    return ranges.join('、');
  }

  // 冲突匹配签名：同格按 (拍, 格, 全部当事人)，互换按 (拍, 双方)，
  // 越界按 (拍, 演员)。当事人 id 全部排序，保证两边顺序不同也能匹配。
  function compareConflictKey(cf) {
    const ids = cf.actorIds.slice().map(String).sort();
    if (cf.kind === 'collision') {
      return 'collision:' + cf.beat + ':' + (cf.cells[0] || '') + ':' + ids.join('~');
    }
    if (cf.kind === 'swap') return 'swap:' + cf.beat + ':' + ids.join('~');
    return 'blocked:' + cf.beat + ':' + ids.join('~');
  }

  // 核心对比计算。返回 null 表示输入不是两份不同的有效报告；
  // status 为 'no-common-actors' / 'no-common-beats' / 'ok'。
  function analyzeReports(reportA, reportB) {
    if (!reportA || !reportB ||
      reportA.app !== REPORT_APP || reportB.app !== REPORT_APP ||
      !reportA.id || !reportB.id || reportA.id === reportB.id) return null;

    const mapA = new Map(reportA.actors.map((a) => [a.id, a]));
    const mapB = new Map(reportB.actors.map((a) => [a.id, a]));
    // 共同演员以 A 的顺序为准（UI 下拉顺序即报告存档顺序）
    const commonActors = reportA.actors.filter((a) => mapB.has(a.id))
      .map((a) => ({
        id: a.id,
        nameA: a.name,
        nameB: mapB.get(a.id).name
      }));
    const onlyA = reportA.actors.filter((a) => !mapB.has(a.id)).map((a) => a.name);
    const onlyB = reportB.actors.filter((a) => !mapA.has(a.id)).map((a) => a.name);

    const lo = Math.max(reportA.fromBeat, reportB.fromBeat);
    const hi = Math.min(reportA.toBeat, reportB.toBeat);
    const beatsA = [];
    const beatsB = [];
    for (let b = reportA.fromBeat; b <= reportA.toBeat; b++) beatsA.push(b);
    for (let b = reportB.fromBeat; b <= reportB.toBeat; b++) beatsB.push(b);
    const beatsOnlyA = beatsA.filter((b) => b < lo || b > hi);
    const beatsOnlyB = beatsB.filter((b) => b < lo || b > hi);

    if (!commonActors.length) {
      return { status: 'no-common-actors', commonActors: [], onlyA, onlyB };
    }
    if (lo > hi) {
      return {
        status: 'no-common-beats', commonActors, onlyA, onlyB,
        rangeA: { lo: reportA.fromBeat, hi: reportA.toBeat },
        rangeB: { lo: reportB.fromBeat, hi: reportB.toBeat }
      };
    }

    const commonIds = new Set(commonActors.map((a) => a.id));
    // 仅保留：发生在共同拍次内、且至少涉及一位共同演员的冲突。
    // 其余冲突不进入对比，只统计数量并在提示中说明，避免误导。
    const inScope = (cf) => cf.beat >= lo && cf.beat <= hi &&
      cf.actorIds.some((id) => commonIds.has(id));
    const listA = reportA.conflicts.filter(inScope);
    const listB = reportB.conflicts.filter(inScope);
    const excludedA = reportA.conflicts.length - listA.length;
    const excludedB = reportB.conflicts.length - listB.length;

    const byKeyA = new Map(listA.map((cf) => [compareConflictKey(cf), cf]));
    const byKeyB = new Map(listB.map((cf) => [compareConflictKey(cf), cf]));
    const allKeys = new Set([...byKeyA.keys(), ...byKeyB.keys()]);

    const changes = [];
    for (const sig of allKeys) {
      const a = byKeyA.get(sig) || null;
      const b = byKeyB.get(sig) || null;
      const ref = b || a;
      // 当事人姓名优先取 B（对照），缺失时回退 A
      const names = (b || a).actors;
      changes.push({
        kind: ref.kind,
        beat: ref.beat,
        status: b && a ? 'kept' : (b ? 'added' : 'removed'),
        keyA: a ? a.key : null,
        keyB: b ? b.key : null,
        cells: ref.cells.slice(),
        actors: names.slice(),
        textA: a ? a.text : '',
        textB: b ? b.text : ''
      });
    }
    changes.sort((x, y) => (x.beat - y.beat) ||
      COMPARE_KIND_RANK[x.kind] - COMPARE_KIND_RANK[y.kind] ||
      (x.kind + '|' + x.cells.join('~') + '|' + x.actors.join('~'))
        .localeCompare(y.kind + '|' + y.cells.join('~') + '|' + y.actors.join('~')));

    const countOf = (status, kind) =>
      changes.filter((ch) => ch.status === status && ch.kind === kind).length;
    const summary = { collision: { added: 0, removed: 0, kept: 0 },
      swap: { added: 0, removed: 0, kept: 0 },
      blocked: { added: 0, removed: 0, kept: 0 } };
    for (const kind of COMPARE_KINDS) {
      summary[kind].added = countOf('added', kind);
      summary[kind].removed = countOf('removed', kind);
      summary[kind].kept = countOf('kept', kind);
    }

    // 逐拍、逐共同演员：坐标 / 动作差异
    const beatIndexA = new Map(reportA.beats.map((bk) => [bk.beat, bk]));
    const beatIndexB = new Map(reportB.beats.map((bk) => [bk.beat, bk]));
    const findRow = (index, beat, id) => {
      const bk = index.get(beat);
      return bk && bk.rows.find((row) => row.actorId === id) || null;
    };
    const beatsDiff = [];
    let coordChanged = 0;
    let moveChanged = 0;
    for (let beat = lo; beat <= hi; beat++) {
      const rows = [];
      for (const actor of commonActors) {
        const rowA = findRow(beatIndexA, beat, actor.id);
        const rowB = findRow(beatIndexB, beat, actor.id);
        const coordA = rowA && rowA.coord ? rowA.coord : null;
        const coordB = rowB && rowB.coord ? rowB.coord : null;
        const moveA = beat === 0 ? null : (rowA && DIRS[rowA.move] ? rowA.move : null);
        const moveB = beat === 0 ? null : (rowB && DIRS[rowB.move] ? rowB.move : null);
        const coordDiff = coordA !== coordB;
        const moveDiff = moveA !== moveB;
        if (coordDiff) coordChanged += 1;
        if (moveDiff) moveChanged += 1;
        rows.push({
          actorId: actor.id,
          nameA: actor.nameA,
          nameB: actor.nameB,
          coordA, coordB, moveA, moveB, coordDiff, moveDiff
        });
      }
      const changed = rows.filter((r) => r.coordDiff || r.moveDiff).length;
      beatsDiff.push({ beat, changed, rows });
    }

    // 明确列出未纳入对比的内容，UI 会原样展示
    const notices = [];
    if (onlyA.length) {
      notices.push('仅「' + reportA.title + '」包含的演员（' + onlyA.length +
        ' 位：' + onlyA.join('、') + '）不参与逐拍对比；仅涉及其本人的冲突不计入下方变化统计。');
    }
    if (onlyB.length) {
      notices.push('仅「' + reportB.title + '」包含的演员（' + onlyB.length +
        ' 位：' + onlyB.join('、') + '）不参与逐拍对比；仅涉及其本人的冲突不计入下方变化统计。');
    }
    if (beatsOnlyA.length) {
      notices.push('拍次 ' + compactBeatLabels(beatsOnlyA) + ' 只存在于「' + reportA.title +
        '」，不在共同范围内，未纳入对比。');
    }
    if (beatsOnlyB.length) {
      notices.push('拍次 ' + compactBeatLabels(beatsOnlyB) + ' 只存在于「' + reportB.title +
        '」，不在共同范围内，未纳入对比。');
    }
    if (excludedA) {
      notices.push('「' + reportA.title + '」有 ' + excludedA +
        ' 条冲突只涉及非共同演员或发生在共同范围之外，未计入下方统计。');
    }
    if (excludedB) {
      notices.push('「' + reportB.title + '」有 ' + excludedB +
        ' 条冲突只涉及非共同演员或发生在共同范围之外，未计入下方统计。');
    }

    return {
      status: 'ok',
      commonActors, onlyA, onlyB,
      lo, hi,
      beatsOnlyA, beatsOnlyB,
      beats: beatsDiff,
      changes,
      summary,
      excludedA, excludedB,
      notices,
      totals: {
        added: changes.filter((c) => c.status === 'added').length,
        removed: changes.filter((c) => c.status === 'removed').length,
        kept: changes.filter((c) => c.status === 'kept').length
      },
      diffCounts: { coord: coordChanged, move: moveChanged }
    };
  }

  // 生成可存档的对比对象（深拷贝分析结果与所需报告元信息）
  function buildComparison(opts) {
    const reportA = opts && opts.reportA;
    const reportB = opts && opts.reportB;
    const result = analyzeReports(reportA, reportB);
    if (!result) return null;
    const title = (opts && typeof opts.title === 'string' && opts.title.trim())
      ? opts.title.trim().slice(0, 80)
      : '报告对比：' + reportA.title + ' → ' + reportB.title;
    const clone = JSON.parse(JSON.stringify(result));
    return {
      app: COMPARE_APP,
      version: COMPARE_VERSION,
      id: (opts && typeof opts.id === 'string' && opts.id) ? opts.id : uid('cmp'),
      title,
      createdAt: new Date().toISOString(),
      a: { id: reportA.id, title: reportA.title, createdAt: reportA.createdAt },
      b: { id: reportB.id, title: reportB.title, createdAt: reportB.createdAt },
      grid: { cols: COLS, rows: ROWS },
      ...clone
    };
  }

  // 校验 / 规整一份已存档的对比；非法时返回 null（加载存档时丢弃坏条目）
  function normalizeComparison(raw) {
    if (!raw || typeof raw !== 'object' || raw.app !== COMPARE_APP) return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 60) : uid('cmp');
    const title = typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.trim().slice(0, 80) : '报告对比';
    const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
      ? raw.createdAt : new Date().toISOString();
    const sideOf = (x) => (x && typeof x === 'object' && typeof x.id === 'string' && x.id)
      ? { id: x.id.slice(0, 60),
        title: typeof x.title === 'string' ? x.title : '已删除报告',
        createdAt: typeof x.createdAt === 'string' ? x.createdAt : null }
      : null;
    const a = sideOf(raw.a);
    const b = sideOf(raw.b);
    if (!a || !b) return null;

    const status = raw.status === 'ok' || raw.status === 'no-common-actors' ||
      raw.status === 'no-common-beats' ? raw.status : null;
    if (!status) return null;

    // 非可对比状态：只保留提示性信息
    if (status !== 'ok') {
      const rangeOf = (x) => {
        if (!x || typeof x !== 'object') return null;
        const lo = Math.trunc(Number(x.lo));
        const hi = Math.trunc(Number(x.hi));
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || lo < 0 || hi > 100) return null;
        return { lo, hi };
      };
      return {
        app: COMPARE_APP, version: COMPARE_VERSION, id, title, createdAt, a, b,
        grid: { cols: COLS, rows: ROWS },
        status,
        commonActors: [],
        onlyA: Array.isArray(raw.onlyA) ? raw.onlyA.map(String).slice(0, 50) : [],
        onlyB: Array.isArray(raw.onlyB) ? raw.onlyB.map(String).slice(0, 50) : [],
        rangeA: status === 'no-common-beats' ? rangeOf(raw.rangeA) : null,
        rangeB: status === 'no-common-beats' ? rangeOf(raw.rangeB) : null
      };
    }

    const lo = Math.trunc(Number(raw.lo));
    const hi = Math.trunc(Number(raw.hi));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || lo < 0 || hi > 100) return null;

    const seen = new Set();
    const commonActors = [];
    for (const ca of Array.isArray(raw.commonActors) ? raw.commonActors : []) {
      if (!ca || typeof ca !== 'object' || typeof ca.id !== 'string' || !ca.id || seen.has(ca.id)) continue;
      seen.add(ca.id);
      commonActors.push({
        id: ca.id,
        nameA: typeof ca.nameA === 'string' && ca.nameA ? ca.nameA.slice(0, 20) : '演员',
        nameB: typeof ca.nameB === 'string' && ca.nameB ? ca.nameB.slice(0, 20) : '演员'
      });
    }
    if (!commonActors.length) return null;

    const validChangeStatus = (s) => s === 'added' || s === 'removed' || s === 'kept';
    const changes = [];
    for (const ch of Array.isArray(raw.changes) ? raw.changes : []) {
      if (!ch || typeof ch !== 'object' || !COMPARE_KINDS.includes(ch.kind) ||
        !validChangeStatus(ch.status)) continue;
      const beat = Math.trunc(Number(ch.beat));
      if (!Number.isFinite(beat) || beat < lo || beat > hi) continue;
      const actors = Array.isArray(ch.actors)
        ? ch.actors.slice(0, 12).map(String).filter(Boolean) : [];
      if (!actors.length) continue;
      const cells = Array.isArray(ch.cells)
        ? ch.cells.filter((x) => /^\d+-\d+$/.test(String(x))).map(String).slice(0, 2) : [];
      changes.push({
        kind: ch.kind, beat, status: ch.status,
        keyA: typeof ch.keyA === 'string' ? ch.keyA : null,
        keyB: typeof ch.keyB === 'string' ? ch.keyB : null,
        cells,
        actors,
        textA: typeof ch.textA === 'string' ? ch.textA : '',
        textB: typeof ch.textB === 'string' ? ch.textB : '',
        sig: ch.kind + ':' + beat + ':' + cells.join('~') + ':' + actors.join('~')
      });
    }
    changes.sort((x, y) => (x.beat - y.beat) ||
      COMPARE_KIND_RANK[x.kind] - COMPARE_KIND_RANK[y.kind] ||
      x.sig.localeCompare(y.sig));

    const beats = [];
    for (const braw of Array.isArray(raw.beats) ? raw.beats : []) {
      if (!braw || typeof braw !== 'object') continue;
      const beat = Math.trunc(Number(braw.beat));
      if (!Number.isFinite(beat) || beat < lo || beat > hi) continue;
      const rows = [];
      for (const rraw of Array.isArray(braw.rows) ? braw.rows : []) {
        if (!rraw || typeof rraw !== 'object' || !seen.has(rraw.actorId)) continue;
        const ca = commonActors.find((x) => x.id === rraw.actorId);
        const coordOk = (v) => typeof v === 'string' && /^\d+-\d+$/.test(v) ? v : null;
        rows.push({
          actorId: rraw.actorId,
          nameA: ca.nameA,
          nameB: ca.nameB,
          coordA: coordOk(rraw.coordA),
          coordB: coordOk(rraw.coordB),
          moveA: DIRS[rraw.moveA] ? rraw.moveA : null,
          moveB: DIRS[rraw.moveB] ? rraw.moveB : null,
          coordDiff: !!rraw.coordDiff,
          moveDiff: !!rraw.moveDiff
        });
      }
      if (!rows.length) continue;
      // 差异标记以两边实际值重新派生，防止存档标记被篡改后误导
      rows.forEach((r) => {
        r.coordDiff = r.coordA !== r.coordB;
        r.moveDiff = r.moveA !== r.moveB;
      });
      beats.push({ beat, changed: rows.filter((r) => r.coordDiff || r.moveDiff).length, rows });
    }
    if (!beats.length) return null;

    const numList = (x) => Array.isArray(x) ? x.map(Number).filter((n) => Number.isFinite(n)) : [];
    const coordChanged = beats.reduce((n, bk) =>
      n + bk.rows.filter((r) => r.coordDiff).length, 0);
    const moveChanged = beats.reduce((n, bk) =>
      n + bk.rows.filter((r) => r.moveDiff).length, 0);

    const summary = { collision: { added: 0, removed: 0, kept: 0 },
      swap: { added: 0, removed: 0, kept: 0 },
      blocked: { added: 0, removed: 0, kept: 0 } };
    for (const ch of changes) summary[ch.kind][ch.status] += 1;

    return {
      app: COMPARE_APP, version: COMPARE_VERSION, id, title, createdAt, a, b,
      grid: { cols: COLS, rows: ROWS },
      status: 'ok',
      commonActors,
      onlyA: Array.isArray(raw.onlyA) ? raw.onlyA.map(String).slice(0, 50) : [],
      onlyB: Array.isArray(raw.onlyB) ? raw.onlyB.map(String).slice(0, 50) : [],
      lo, hi,
      beatsOnlyA: numList(raw.beatsOnlyA),
      beatsOnlyB: numList(raw.beatsOnlyB),
      beats,
      changes,
      summary,
      excludedA: Math.max(0, Math.trunc(Number(raw.excludedA)) || 0),
      excludedB: Math.max(0, Math.trunc(Number(raw.excludedB)) || 0),
      notices: Array.isArray(raw.notices) ? raw.notices.map(String).slice(0, 20) : [],
      totals: {
        added: changes.filter((c) => c.status === 'added').length,
        removed: changes.filter((c) => c.status === 'removed').length,
        kept: changes.filter((c) => c.status === 'kept').length
      },
      diffCounts: { coord: coordChanged, move: moveChanged }
    };
  }

  /* ============================================================
   * 以下为浏览器 UI 层
   * ============================================================ */
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = {
        simulate, normalizeState, buildReport, normalizeReport,
        analyzeReports, buildComparison, normalizeComparison,
        compactBeatLabels, compareConflictKey,
        DIRS, DIR_ORDER, COLS, ROWS, cellKey, fmtCoord, coordToKey, reportConflictKey
      };
    }
    return;
  }

  /* ---------------- 运行时状态 ---------------- */
  let state = freshState();
  let reports = [];            // 已生成的排练场记报告（只读快照）
  let comparisons = [];        // 已保存的报告对比（两份快照的差异）
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
        // 旧版本存档没有 comparisons 字段：按空列表处理，保持向后兼容
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
    $('newCompareBtn').disabled = reports.length < 2;
    $('newCompareBtn').title = reports.length < 2
      ? '至少需要两份已保存的报告才能对比' : '选择两份报告进行对比';
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
        '<button type="button" class="row-btn rr-dl" title="下载报告 JSON" aria-label="下载报告 JSON">⬇</button>' +
        '<button type="button" class="row-btn rr-del" title="删除报告" aria-label="删除报告">✕</button>';
      li.querySelector('.rr-title').textContent = r.title;
      li.querySelector('.report-open').addEventListener('click', () => viewReport(r.id));
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
    document.body.classList.remove('printing-report', 'print-mode-report');
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
    document.body.classList.add('printing-report', 'print-mode-report');
    const done = () => document.body.classList.remove('printing-report', 'print-mode-report');
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    // 部分浏览器不触发 afterprint：兜底恢复
    setTimeout(done, 1500);
  }

  function downloadJson(obj, fileBase, okMsg) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    a.href = URL.createObjectURL(blob);
    a.download = fileBase + '-' + stamp + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    if (okMsg) toast(okMsg, 'ok');
  }

  function downloadReport(id) {
    const r = reportById(id);
    if (!r) return;
    downloadJson(r, 'stage-blocking-report', '已下载报告 JSON 快照');
  }

  function deleteReport(id) {
    const r = reportById(id);
    if (!r) return;
    const used = comparisons.filter((cmp) => cmp.a.id === id || cmp.b.id === id).length;
    const hint = used ? '（有 ' + used + ' 份已保存的报告对比引用它；对比视图内嵌了完整结果，删除报告后仍可查看）' : '';
    if (!confirm('确定删除报告「' + r.title + '」吗？此操作只影响本浏览器的本地存档。' + hint)) return;
    reports = reports.filter((x) => x.id !== id);
    save();
    renderReports();
    renderComparisons();
    closeViewer();
    toast('已删除报告');
  }

  /* ============================================================
   * 报告对比（两份只读快照的差异）
   * ============================================================ */
  const comparisonById = (id) => comparisons.find((x) => x.id === id) || null;

  function renderComparisons() {
    const box = $('compareList');
    if (!box) return;
    box.innerHTML = '';
    if (!comparisons.length) {
      box.innerHTML = '<li class="empty-hint">还没有对比：勾选两份报告后生成，差异随本地存档保留。</li>';
      return;
    }
    comparisons.slice().reverse().forEach((cmp) => {
      const missing = (!reportById(cmp.a.id) ? 'a' : '') + (!reportById(cmp.b.id) ? 'b' : '');
      const li = document.createElement('li');
      li.className = 'report-row compare-row';
      li.dataset.cmpid = cmp.id;
      let summary;
      if (cmp.status === 'ok') {
        const t = cmp.totals;
        summary = '共同 ' + (cmp.hi - cmp.lo + 1) + ' 拍 / ' + cmp.commonActors.length + ' 人 · ' +
          '＋' + t.added + ' －' + t.removed + ' ＝' + t.kept;
      } else if (cmp.status === 'no-common-actors') {
        summary = '⚠ 演员不重叠，无可对比内容';
      } else {
        summary = '⚠ 拍次不重叠，无可对比内容';
      }
      li.innerHTML =
        '<button type="button" class="report-open compare-open" title="查看报告对比">' +
        '<span class="rr-title"></span>' +
        '<span class="rr-meta cmp-meta"></span>' +
        '<span class="rr-time">' + fmtDateTime(cmp.createdAt) + '</span>' +
        '</button>' +
        '<button type="button" class="row-btn rr-dl" title="下载对比 JSON" aria-label="下载对比 JSON">⬇</button>' +
        '<button type="button" class="row-btn rr-del" title="删除对比" aria-label="删除对比">✕</button>';
      li.querySelector('.rr-title').textContent = cmp.title;
      li.querySelector('.cmp-meta').textContent = summary;
      if (missing) li.querySelector('.compare-open').classList.add('src-missing');
      li.querySelector('.compare-open').addEventListener('click', () => viewComparison(cmp.id));
      li.querySelector('.rr-dl').addEventListener('click', () => downloadComparison(cmp.id));
      li.querySelector('.rr-del').addEventListener('click', () => deleteComparison(cmp.id));
      box.appendChild(li);
    });
  }

  /* ---------- 选择两份报告的弹窗 ---------- */
  function compareOptionHtml(r, side) {
    return '<option value="' + escapeHtml(r.id) + '">' +
      (side === 'A' ? 'A 基准 · ' : 'B 对照 · ') +
      escapeHtml(r.title) + '（' + rangeLabel(r.fromBeat, r.toBeat) + ' · ' +
      r.actors.length + '人 · ' + fmtDateTime(r.createdAt) + '）</option>';
  }

  function fillCompareForm() {
    const selA = $('cmpA');
    const selB = $('cmpB');
    selA.innerHTML = reports.map((r) => compareOptionHtml(r, 'A')).join('');
    selB.innerHTML = reports.map((r) => compareOptionHtml(r, 'B')).join('');
    if (reports.length >= 2) {
      const n = reports.length;
      selA.value = reports[n - 2].id;
      selB.value = reports[n - 1].id;
    }
    updateComparePreview();
  }

  function openCompareModal() {
    if (reports.length < 2) {
      toast('至少需要两份已保存的报告才能对比', 'error');
      return;
    }
    fillCompareForm();
    $('compareModal').classList.remove('hidden');
    $('cmpA').focus();
  }
  function closeCompareModal() {
    const el = $('compareModal');
    if (el) el.classList.add('hidden');
  }

  function currentCompareSelection() {
    const a = reportById($('cmpA').value);
    const b = reportById($('cmpB').value);
    return { a, b };
  }

  // 实时预览：共同演员 / 共同拍次 / 不重叠提示，避免生成误导结果
  function updateComparePreview() {
    const box = $('cmpPreview');
    const { a, b } = currentCompareSelection();
    if (!a || !b) {
      box.innerHTML = '<p class="cmp-pv-warn">请在两侧各选择一份报告。</p>';
      return;
    }
    if (a.id === b.id) {
      box.innerHTML = '<p class="cmp-pv-warn">不能与自身对比，请选择两份不同的报告。</p>';
      return;
    }
    const result = analyzeReports(a, b);
    if (result.status === 'no-common-actors') {
      box.innerHTML =
        '<p class="cmp-pv-warn">⚠ 两份报告的演员完全不重叠：' +
        '「' + escapeHtml(a.title) + '」为 ' + a.actors.map((x) => x.name).join('、') +
        '；「' + escapeHtml(b.title) + '」为 ' + b.actors.map((x) => x.name).join('、') +
        '。无法按演员对齐，<b>不会生成逐拍差异</b>，仅保存一条提示性对比。</p>';
      return;
    }
    const names = result.commonActors
      .map((ca) => ca.nameA === ca.nameB ? ca.nameA : ca.nameA + '→' + ca.nameB).join('、');
    let html = '<p class="cmp-pv-ok">共同演员 <b>' + result.commonActors.length +
      '</b> 位：' + escapeHtml(names) + '</p>';
    if (result.status === 'no-common-beats') {
      html += '<p class="cmp-pv-warn">⚠ 拍次范围不重叠：「' + escapeHtml(a.title) + '」覆盖 ' +
        rangeLabel(result.rangeA.lo, result.rangeA.hi) + '，「' + escapeHtml(b.title) +
        '」覆盖 ' + rangeLabel(result.rangeB.lo, result.rangeB.hi) +
        '。<b>不会生成逐拍差异</b>，仅保存一条提示性对比。</p>';
      if (result.onlyA.length) {
        html += '<p class="cmp-pv-note">仅 A 含演员：' + result.onlyA.map(escapeHtml).join('、') + '</p>';
      }
      if (result.onlyB.length) {
        html += '<p class="cmp-pv-note">仅 B 含演员：' + result.onlyB.map(escapeHtml).join('、') + '</p>';
      }
      box.innerHTML = html;
      return;
    }
    html += '<p class="cmp-pv-ok">共同拍次 <b>' + rangeLabel(result.lo, result.hi) + '</b>' +
      '（' + (result.hi - result.lo + 1) + ' 个拍次）</p>';
    const t = result.totals;
    html += '<p class="cmp-pv-stats">冲突变化：新增 <b class="cmp-add">＋' + t.added +
      '</b>　消除 <b class="cmp-rm">－' + t.removed +
      '</b>　保持 <b class="cmp-keep">＝' + t.kept +
      '</b>；逐拍坐标差异 ' + result.diffCounts.coord +
      ' 处、动作差异 ' + result.diffCounts.move + ' 处</p>';
    if (result.notices.length) {
      html += '<ul class="cmp-pv-notes">' +
        result.notices.map((n) => '<li>' + escapeHtml(n) + '</li>').join('') + '</ul>';
    }
    box.innerHTML = html;
  }

  function swapCompareSides() {
    const selA = $('cmpA');
    const selB = $('cmpB');
    const v = selA.value;
    selA.value = selB.value;
    selB.value = v;
    updateComparePreview();
  }

  function submitComparison() {
    const { a, b } = currentCompareSelection();
    if (!a || !b) { toast('所选报告已不存在，请重新选择', 'error'); return; }
    if (a.id === b.id) { toast('不能与自身对比', 'error'); return; }
    const title = $('cmpTitle').value.trim() || undefined;
    const cmp = buildComparison({ reportA: a, reportB: b, title });
    if (!cmp) { toast('对比失败：报告数据异常', 'error'); return; }
    comparisons.push(cmp);
    save();
    renderComparisons();
    closeCompareModal();
    if (cmp.status === 'ok') toast('已保存报告对比', 'ok');
    else toast(cmp.status === 'no-common-actors'
      ? '演员不重叠：已保存提示性对比，未生成逐拍差异'
      : '拍次不重叠：已保存提示性对比，未生成逐拍差异', 'error');
    viewComparison(cmp.id);
  }

  /* ---------- 对比查看器 ---------- */
  function viewComparison(id) {
    const cmp = comparisonById(id);
    if (!cmp) return;
    renderCompareSheet(cmp);
    $('cmpViewerOverlay').dataset.cmpid = cmp.id;
    $('cmpViewerOverlay').classList.remove('hidden');
    $('cmpViewerOverlay').scrollTop = 0;
  }
  function closeCompareViewer() {
    const ov = $('cmpViewerOverlay');
    if (ov) ov.classList.add('hidden');
    document.body.classList.remove('printing-report', 'print-mode-compare');
  }

  function cmpSideName(cmp, side) {
    const r = reportById(cmp[side].id);
    return r ? r.title : cmp[side].title + '（原报告已删除）';
  }

  function renderCompareSheet(cmp) {
    $('cmpSheetHead').textContent = cmp.title;
    const nameA = cmpSideName(cmp, 'a');
    const nameB = cmpSideName(cmp, 'b');
    $('cmpSheetMeta').innerHTML =
      '生成时间：' + fmtDateTime(cmp.createdAt) + '　|　A 基准：' + escapeHtml(nameA) +
      '（' + fmtDateTime(cmp.a.createdAt) + '）　|　B 对照：' + escapeHtml(nameB) +
      '（' + fmtDateTime(cmp.b.createdAt) + '）';
    $('cmpSheetFrozenNote').textContent =
      '本对比基于两份只读快照生成，差异已固化；之后再编辑走位或删除报告，都不会改变本对比内容。';

    const dirBox = $('cmpSheetDirection');
    dirBox.innerHTML =
      '<span class="cmp-side-tag side-a">A 基准</span><span class="cmp-side-title"></span>' +
      '<span class="cmp-arrow">→</span>' +
      '<span class="cmp-side-tag side-b">B 对照</span><span class="cmp-side-title"></span>';
    const titles = dirBox.querySelectorAll('.cmp-side-title');
    titles[0].textContent = nameA;
    titles[1].textContent = nameB;

    const noticesBox = $('cmpNotices');
    if (cmp.status !== 'ok') {
      noticesBox.innerHTML = '';
      const warn = document.createElement('p');
      warn.className = 'cmp-warn-box';
      if (cmp.status === 'no-common-actors') {
        warn.textContent = '⚠ 两份报告的演员完全不重叠，无法按共同演员对齐，因此未生成逐拍差异。' +
          '请确认是否选择了同一次排练的不同快照；本对比仅保留此提示，不提供可能产生误导的比较结果。';
      } else {
        const rA = cmp.rangeA || { lo: 0, hi: 0 };
        const rB = cmp.rangeB || { lo: 0, hi: 0 };
        warn.textContent = '⚠ 两份报告的拍次范围不重叠（A：' +
          rangeLabel(rA.lo, rA.hi) + '；B：' +
          rangeLabel(rB.lo, rB.hi) +
          '），无法按拍次对齐，因此未生成逐拍差异。本对比仅保留此提示，不提供可能产生误导的比较结果。';
      }
      noticesBox.appendChild(warn);
      $('cmpSummary').innerHTML = '';
      $('cmpChanges').innerHTML = '<p class="sheet-empty">未生成冲突变化统计。</p>';
      $('cmpBeats').innerHTML = '<p class="sheet-empty">未生成逐拍差异。</p>';
      return;
    }

    // 对齐说明 / 排除提示
    noticesBox.innerHTML = cmp.notices.length
      ? '<ul class="cmp-notice-list">' +
        cmp.notices.map((n) => '<li>' + escapeHtml(n) + '</li>').join('') + '</ul>'
      : '<p class="cmp-notice-ok">两份报告的共同演员与共同拍次全部纳入对比，无排除内容。</p>';

    // 汇总
    const t = cmp.totals;
    const s = cmp.summary;
    $('cmpSummary').innerHTML =
      '<span class="ss-item"><b>' + (cmp.hi - cmp.lo + 1) + '</b> 个共同拍次</span>' +
      '<span class="ss-item"><b>' + cmp.commonActors.length + '</b> 位共同演员</span>' +
      '<span class="ss-item cmp-add">新增冲突 <b>＋' + t.added + '</b></span>' +
      '<span class="ss-item cmp-rm">消除冲突 <b>－' + t.removed + '</b></span>' +
      '<span class="ss-item cmp-keep">保持冲突 <b>＝' + t.kept + '</b></span>' +
      '<span class="ss-item">坐标差异 <b>' + cmp.diffCounts.coord + '</b> 处</span>' +
      '<span class="ss-item">动作差异 <b>' + cmp.diffCounts.move + '</b> 处</span>' +
      '<span class="ss-item ss-col">🔴 ' + s.collision.added + '/' + s.collision.removed + '/' + s.collision.kept + '</span>' +
      '<span class="ss-item ss-swp">🔁 ' + s.swap.added + '/' + s.swap.removed + '/' + s.swap.kept + '</span>' +
      '<span class="ss-item ss-blk">⛔ ' + s.blocked.added + '/' + s.blocked.removed + '/' + s.blocked.kept + '</span>' +
      '<span class="ss-item ss-detail-hint">末三项格式为 新增/消除/保持</span>';

    // 冲突变化
    const chBox = $('cmpChanges');
    chBox.innerHTML = '';
    if (!cmp.changes.length) {
      chBox.innerHTML = '<p class="sheet-empty">共同范围内两份报告均无冲突，也无冲突变化 🎉</p>';
    } else {
      const icon = { collision: '🔴', swap: '🔁', blocked: '⛔' };
      const stMeta = {
        added: { cls: 'chg-added', tag: '新增', sign: '＋' },
        removed: { cls: 'chg-removed', tag: '消除', sign: '－' },
        kept: { cls: 'chg-kept', tag: '保持', sign: '＝' }
      };
      cmp.changes.forEach((ch) => {
        const meta = stMeta[ch.status];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cmp-change ' + meta.cls;
        btn.innerHTML =
          '<span class="chg-sign">' + meta.sign + '</span>' +
          '<span class="chg-tag">' + meta.tag + '</span>' +
          '<span class="sc-icon">' + icon[ch.kind] + '</span>' +
          '<span class="sc-beat">' + beatLabel(ch.beat) + '</span>' +
          '<span class="chg-texts"><span class="chg-text-a"></span><span class="chg-text-b"></span></span>' +
          '<span class="sc-cells"></span>' +
          '<span class="sc-jump">↗ 跳回此拍</span>';
        const ta = btn.querySelector('.chg-text-a');
        const tb = btn.querySelector('.chg-text-b');
        const txtA = ch.textA, txtB = ch.textB;
        ta.textContent = ch.status === 'added' ? '（A 无）' : txtA;
        tb.textContent = ch.status === 'removed' ? '（B 无，已消除）' : txtB;
        ta.classList.toggle('chg-na', ch.status === 'added');
        tb.classList.toggle('chg-na', ch.status === 'removed');
        btn.querySelector('.sc-cells').textContent =
          ch.cells.length ? '(' + ch.cells.join(')、(') + ')' : '';
        btn.addEventListener('click', () => jumpCompareConflict(cmp, ch));
        chBox.appendChild(btn);
      });
    }

    // 逐拍差异
    const beatsBox = $('cmpBeats');
    beatsBox.innerHTML = '';
    cmp.beats.forEach((bk) => {
      const sec = document.createElement('section');
      sec.className = 'sheet-beat';
      let html =
        '<h3 class="sb-title"><span class="sb-beat">' + beatLabel(bk.beat) + '</span>' +
        '<span class="sb-note">' + (bk.changed
          ? bk.changed + ' 位共同演员的坐标或动作有变化' : '本拍无差异') + '</span>' +
        '<button type="button" class="btn btn-sm cmp-beat-jump no-print" data-beat="' +
        bk.beat + '">↗ 在编辑器中打开此拍</button></h3>' +
        '<table class="cmp-table"><thead><tr>' +
        '<th>共同演员</th><th>A 坐标</th><th>B 坐标</th>' +
        (bk.beat === 0 ? '<th>起点</th>' : '<th>A 动作 → B 动作</th>') +
        '</tr></thead><tbody>';
      const moveCell = (row) => {
        if (bk.beat === 0) return '<td class="cmp-move-cell">起点</td>';
        const mv = (m, side) => m === null
          ? '<span class="rs-na">—</span>'
          : '<span class="mv-glyph">' + DIRS[m].glyph + '</span> ' +
            '<span class="mv-label">' + DIRS[m].label + '</span>';
        return '<td class="cmp-move-cell' + (row.moveDiff ? ' diff' : '') + '">' +
          mv(row.moveA, 'a') + '<span class="cmp-to">→</span>' + mv(row.moveB, 'b') + '</td>';
      };
      bk.rows.forEach((row) => {
        const nm = row.nameA === row.nameB ? row.nameA : row.nameA + ' → ' + row.nameB;
        const coordCell = (v, diff) =>
          '<td class="cmp-coord' + (diff ? ' diff' : '') + '">' +
          (v ? '(' + escapeHtml(v) + ')' : '<span class="rs-na">未记录</span>') + '</td>';
        html += '<tr' + (row.coordDiff || row.moveDiff ? ' class="row-diff"' : '') + '>' +
          '<td class="cell-actor">' + escapeHtml(nm) + '</td>' +
          coordCell(row.coordA, row.coordDiff) +
          coordCell(row.coordB, row.coordDiff) +
          moveCell(row) + '</tr>';
      });
      html += '</tbody></table>';
      sec.innerHTML = html;
      sec.querySelector('.cmp-beat-jump').addEventListener('click', () => jumpCompareBeat(bk.beat));
      beatsBox.appendChild(sec);
    });
  }

  // 差异 / 冲突条目 → 关闭对比视图并在编辑器跳到对应拍次；
  // 快照内嵌的跳转键只用于在「当前走位」中尝试定位同一条冲突，
  // 定位不到（已被改没）时只切拍并明确提示，绝不假装定位成功。
  function jumpCompareBeat(beat) {
    closeCompareViewer();
    stopPlay();
    settingActorId = null;
    const target = Math.min(Math.max(beat, 0), state.beats);
    currentBeat = target;
    focusKey = null;
    save();
    renderAll();
    if (target !== beat) {
      toast('当前走位只有 ' + state.beats + ' 拍，已停在第 ' + target + ' 拍');
      return;
    }
    toast('已跳回 ' + beatLabel(beat), 'ok');
    $('stage').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function jumpCompareConflict(cmp, ch) {
    closeCompareViewer();
    stopPlay();
    settingActorId = null;
    const target = Math.min(ch.beat, state.beats);
    currentBeat = target;
    focusKey = null;
    save();
    renderAll();
    // 优先用 B（对照）侧的键定位；新增条目没有 A 键，消除条目没有 B 键
    const key = ch.keyB || ch.keyA;
    const live = key ? findConflict(key) : null;
    if (live) {
      focusConflict(key);
      toast('已跳回 ' + beatLabel(ch.beat) + ' 定位该冲突（对照快照侧）', 'ok');
    } else {
      toast('已跳到 ' + beatLabel(target) +
        '；该冲突在当前走位中已不存在（当前走位相对快照已有改动，或它只存在于被消除的一侧）');
    }
  }

  function printCompare() {
    if ($('cmpViewerOverlay').classList.contains('hidden')) return;
    document.body.classList.add('printing-report', 'print-mode-compare');
    const done = () => document.body.classList.remove('printing-report', 'print-mode-compare');
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    setTimeout(done, 1500);
  }

  function downloadComparison(id) {
    const cmp = comparisonById(id);
    if (!cmp) return;
    downloadJson(cmp, 'stage-blocking-comparison', '已下载对比 JSON');
  }

  function deleteComparison(id) {
    const cmp = comparisonById(id);
    if (!cmp) return;
    if (!confirm('确定删除报告对比「' + cmp.title + '」吗？此操作只影响本浏览器的本地存档。')) return;
    comparisons = comparisons.filter((x) => x.id !== id);
    save();
    renderComparisons();
    closeCompareViewer();
    toast('已删除报告对比');
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
    $('newCompareBtn').addEventListener('click', openCompareModal);
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
    $('cmpCloseX').addEventListener('click', closeCompareModal);
    $('cmpCancel').addEventListener('click', closeCompareModal);
    $('cmpSubmit').addEventListener('click', submitComparison);
    $('cmpSwap').addEventListener('click', swapCompareSides);
    $('cmpA').addEventListener('change', updateComparePreview);
    $('cmpB').addEventListener('change', updateComparePreview);
    $('compareModal').addEventListener('click', (e) => {
      if (e.target === $('compareModal')) closeCompareModal();
    });
    $('cmpViewerPrint').addEventListener('click', printCompare);
    $('cmpViewerDownload').addEventListener('click', () => {
      const id = $('cmpViewerOverlay').dataset.cmpid;
      if (id) downloadComparison(id);
    });
    $('cmpViewerClose').addEventListener('click', closeCompareViewer);
    $('cmpViewerOverlay').addEventListener('click', (e) => {
      if (e.target === $('cmpViewerOverlay')) closeCompareViewer();
    });

    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (e.key === 'Escape') {
        if (!$('cmpViewerOverlay').classList.contains('hidden')) { closeCompareViewer(); return; }
        if (!$('viewerOverlay').classList.contains('hidden')) { closeViewer(); return; }
        if (!$('compareModal').classList.contains('hidden')) { closeCompareModal(); return; }
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
