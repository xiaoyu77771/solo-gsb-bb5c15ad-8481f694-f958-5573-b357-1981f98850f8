// 零依赖冒烟测试：直接验证核心推演逻辑
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { simulate, normalizeState, buildReport, normalizeReport, DIRS, cellKey,
  analyzeReports, buildComparison, normalizeComparison, compactBeatLabels, compareConflictKey
} = require('../public/app.js');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log('  ✓ ' + msg); }
  else { failed += 1; console.error('  ✗ ' + msg); }
}

console.log('1) 基本移动（上/下/左/右/原地）');
{
  const actors = [{
    id: 'a', name: 'A', start: { c: 4, r: 3 },
    moves: { '1': 'U', '2': 'R', '3': 'D', '4': 'L', '5': 'S' }
  }];
  const r = simulate(actors, 5);
  assert(r.positions[1].a === cellKey(4, 4), '上：r+1 → (4,4)');
  assert(r.positions[2].a === cellKey(5, 4), '右：c+1 → (5,4)');
  assert(r.positions[3].a === cellKey(5, 3), '下：r-1 → (5,3)');
  assert(r.positions[4].a === cellKey(4, 3), '左：c-1 → (4,3)');
  assert(r.positions[5].a === cellKey(4, 3), '原地：保持 (4,3)');
  assert(r.blocked.length === 0 && r.collisions.length === 0 && r.swaps.length === 0, '无冲突');
}

console.log('2) 越界拦截：原地不动并记录 blocked');
{
  const actors = [{
    id: 'a', name: 'A', start: { c: 8, r: 1 },
    moves: { '1': 'R', '2': 'D', '3': 'L' }
  }];
  const r = simulate(actors, 3);
  assert(r.blocked.length === 2, '记录 2 次越界');
  assert(r.blocked[0].beat === 1 && r.blocked[0].dir === 'R', '第 1 拍向右越界');
  assert(r.blocked[1].beat === 2 && r.blocked[1].dir === 'D', '第 2 拍向下越界');
  assert(r.positions[1].a === cellKey(8, 1), '拦截后原地 (8,1)');
  assert(r.positions[2].a === cellKey(8, 1), '再次拦截仍在 (8,1)');
  assert(r.positions[3].a === cellKey(7, 1), '第 3 拍向左成功 → (7,1)');
}

console.log('3) 同拍同格碰撞');
{
  const actors = [
    { id: 'a', name: 'A', start: { c: 2, r: 2 }, moves: { '1': 'R' } },
    { id: 'b', name: 'B', start: { c: 4, r: 2 }, moves: { '1': 'L' } }
  ];
  const r = simulate(actors, 1);
  assert(r.collisions.length === 1, '1 起碰撞');
  assert(r.collisions[0].beat === 1, '碰撞发生在第 1 拍');
  assert(r.collisions[0].key === cellKey(3, 2), '碰撞格 (3,2)');
  assert(r.collisions[0].ids.includes('a') && r.collisions[0].ids.includes('b'), '双方均在冲突记录中');
}

console.log('4) 相邻两拍互换格子（不算碰撞）');
{
  const actors = [
    { id: 'a', name: 'A', start: { c: 3, r: 2 }, moves: { '1': 'R' } },
    { id: 'b', name: 'B', start: { c: 4, r: 2 }, moves: { '1': 'L' } }
  ];
  const r = simulate(actors, 1);
  assert(r.swaps.length === 1, '识别 1 次互换');
  assert(r.swaps[0].beat === 1, '互换发生在第 1 拍');
  assert(r.swaps[0].keyA === cellKey(4, 2) && r.swaps[0].keyB === cellKey(3, 2), '互换两个格子正确');
  assert(r.collisions.length === 0, '互换不计为同拍碰撞');
}

console.log('5) 起点同格也算碰撞（第 0 拍）');
{
  const actors = [
    { id: 'a', name: 'A', start: { c: 1, r: 1 }, moves: {} },
    { id: 'b', name: 'B', start: { c: 1, r: 1 }, moves: {} }
  ];
  const r = simulate(actors, 1);
  assert(r.collisions.some((c) => c.beat === 0), '第 0 拍起点碰撞被标出');
}

console.log('6) 未设起点的演员不参与推演');
{
  const actors = [
    { id: 'a', name: 'A', start: null, moves: { '1': 'U' } },
    { id: 'b', name: 'B', start: { c: 1, r: 1 }, moves: {} }
  ];
  const r = simulate(actors, 1);
  assert(r.positions[1].a === undefined && r.positions[1].b === cellKey(1, 1), '无起点演员被忽略');
  assert(r.blocked.length === 0, '无越界记录');
}

console.log('7) 数据规整 normalizeState');
{
  const s = normalizeState({
    beats: 200, // 超限 → 4
    actors: [
      { name: '', start: { c: 99, r: 2 }, moves: { '1': 'X', '9': 'U' } },
      { name: '乙', start: { c: '2', r: '3' }, moves: { '1': 'up' } }
    ]
  });
  assert(s.beats === 4, '非法拍数回退为 4');
  assert(s.actors[0].start === null, '越界起点被清除');
  assert(Object.keys(s.actors[0].moves).length === 0, '非法/超范围动作被清除');
  assert(s.actors[0].name === '演员', '空名称回退');
  assert(s.actors[1].start.c === 2 && s.actors[1].start.r === 3, '数字字符串起点被接受');
}

console.log('8) buildReport 只读快照：逐拍坐标/动作与冲突汇总');
{
  const demo = {
    beats: 2,
    nextActorNum: 5,
    actors: [
      { id: 'a', name: '阿甲', start: { c: 3, r: 2 }, moves: { '1': 'R', '2': 'S' } },
      { id: 'b', name: '阿乙', start: { c: 4, r: 2 }, moves: { '1': 'L', '2': 'L' } },
      { id: 'd', name: '阿丁', start: { c: 8, r: 6 }, moves: { '1': 'R', '2': 'U' } }
    ]
  };
  const rpt = buildReport({ state: demo, title: '彩排一' });

  assert(rpt.app === 'stage-blocking-report' && rpt.version === 1, '带应用标识与版本号');
  assert(rpt.title === '彩排一', '标题被采用');
  assert(rpt.fromBeat === 0 && rpt.toBeat === 2, '默认范围 0..2');
  assert(rpt.actorIds.length === 3, '默认包含全部 3 位演员');

  // 逐拍记录：3 个拍次，每拍每人一行
  assert(rpt.beats.length === 3, '逐拍记录含起点 + 2 拍');
  const beat0 = rpt.beats.find((x) => x.beat === 0);
  const rowA0 = beat0.rows.find((x) => x.actorId === 'a');
  assert(rowA0.coord === '3-2' && rowA0.move === null, '起点拍：坐标 3-2，move 为 null');

  const beat1 = rpt.beats.find((x) => x.beat === 1);
  const rowA1 = beat1.rows.find((x) => x.actorId === 'a');
  assert(rowA1.coord === '4-2' && rowA1.move === 'R', '第 1 拍：阿甲右移到 4-2，动作 R');
  assert(rowA1.marks.includes('swap'), '阿甲第 1 拍被标记为互换');
  const rowD1 = beat1.rows.find((x) => x.actorId === 'd');
  assert(rowD1.blocked === true, '阿丁第 1 拍向右越界被拦截');
  assert(rowD1.coord === '8-6', '越界后坐标仍为 8-6（原地）');

  // 第 2 拍阿乙到 3-2，阿甲在 4-2 —— 无冲突
  const beat2 = rpt.beats.find((x) => x.beat === 2);
  assert(beat2.collisionCount === 0 && beat2.swapCount === 0 && beat2.blockedCount === 1,
    '第 2 拍仅 1 起越界');
  const rowB2 = beat2.rows.find((x) => x.actorId === 'b');
  assert(rowB2.coord === '2-2' && rowB2.move === 'L', '第 2 拍：阿乙再左移到 2-2');

  // 冲突汇总：1 互换（beat 1）+ 2 越界（d 在 1、2 拍），排序按拍/类型
  assert(rpt.counts.total === 3, '冲突总数 3');
  assert(rpt.counts.swap === 1 && rpt.counts.blocked === 2 && rpt.counts.collision === 0,
    '互换 1、越界 2、同格 0');
  const kinds = rpt.conflicts.map((c) => c.beat + ':' + c.kind);
  assert(kinds[0] === '1:swap' && kinds[1] === '1:blocked' && kinds[2] === '2:blocked',
    '冲突按拍次、类型排序');
  const swapCf = rpt.conflicts[0];
  assert(swapCf.key.indexOf('swp-1-') === 0, '互换条目带跳转键');
  assert(swapCf.key === 'swp-1-a-b', '互换键按演员 id 排序（与实时 UI 一致）');
  assert(swapCf.cells.length === 2, '互换条目记录两个格子');
  assert(typeof swapCf.text === 'string' && swapCf.text.length > 0, '冲突条目含描述文本');
  const blkCf = rpt.conflicts.find((c) => c.kind === 'blocked');
  assert(blkCf.key === 'blk-1-d', '越界键为 blk-拍-演员id（与实时 UI 一致）');

  // source 为生成时快照
  assert(rpt.source.actors.length === 3 && rpt.source.beats === 2, '内嵌生成时走位快照');
}

console.log('9) 报告范围与演员筛选');
{
  const demo = {
    beats: 3,
    actors: [
      { id: 'a', name: '阿甲', start: { c: 1, r: 1 }, moves: { '1': 'U', '2': 'U', '3': 'U' } },
      { id: 'b', name: '阿乙', start: { c: 2, r: 1 }, moves: { '1': 'U', '2': 'U', '3': 'U' } },
      { id: 'c', name: '阿丙', start: null, moves: { '1': 'U' } }
    ]
  };
  const rpt = buildReport({ state: demo, actorIds: ['a', 'c', '不存在'], fromBeat: 1, toBeat: 2 });
  assert(rpt.actorIds.length === 2, '演员筛选：保留存在的 2 位（忽略未知 id）');
  assert(rpt.fromBeat === 1 && rpt.toBeat === 2, '拍次范围生效');
  assert(rpt.beats.every((b) => b.beat >= 1 && b.beat <= 2), '逐拍记录只含所选范围');
  const rowC = rpt.beats[0].rows.find((x) => x.actorId === 'c');
  assert(rowC.coord === null && rowC.move === 'U' && !rowC.blocked,
    '无起点演员：坐标为 null、动作仍列出、不参与推演');

  // 筛选口径一致：同格中未被选择的演员不进入报告，已选者也不再被标同格
  const collide = {
    beats: 1,
    actors: [
      { id: 'a', name: '阿甲', start: { c: 2, r: 2 }, moves: { '1': 'R' } },
      { id: 'b', name: '阿乙', start: { c: 4, r: 2 }, moves: { '1': 'L' } }
    ]
  };
  const onlyA = buildReport({ state: collide, actorIds: ['a'], fromBeat: 1, toBeat: 1 });
  assert(onlyA.actors.length === 1, '只选阿甲：报告仅 1 人');
  assert(onlyA.counts.collision === 1, '只选阿甲：仍记录与阿乙的同格冲突');
  assert(onlyA.conflicts[0].actors.join('、') === '阿甲、阿乙', '冲突保留全部当事人姓名');
  assert(onlyA.beats[0].rows[0].marks.includes('collision'), '只选阿甲：阿甲行标记同格');
  assert(onlyA.beats[0].collisionCount === 1, '只选阿甲：本拍同格计数为 1');
  assert(onlyA.conflicts[0].key === 'col-1-' + cellKey(3, 2), '跳转键仍按格子生成');

  // from > to 自动交换；空选择回退为全部
  const rpt2 = buildReport({ state: demo, actorIds: [], fromBeat: 2, toBeat: 1 });
  assert(rpt2.fromBeat === 1 && rpt2.toBeat === 2, '起止拍反转时自动交换');
  assert(rpt2.actorIds.length === 3, '空演员选择回退为全部');
}

console.log('10) 同格冲突进入报告');
{
  const demo = {
    beats: 1,
    actors: [
      { id: 'a', name: '阿甲', start: { c: 2, r: 2 }, moves: { '1': 'R' } },
      { id: 'b', name: '阿乙', start: { c: 4, r: 2 }, moves: { '1': 'L' } }
    ]
  };
  const rpt = buildReport({ state: demo });
  const col = rpt.conflicts.filter((c) => c.kind === 'collision');
  assert(col.length === 1 && col[0].beat === 1, '同格冲突 1 起，在第 1 拍');
  assert(col[0].cells[0] === '3-2', '冲突格显示为 3-2');
  assert(col[0].key === 'col-1-' + cellKey(3, 2), '同格跳转键与实时 UI 一致（col-拍-c,r）');
  assert(col[0].actors.join('、') === '阿甲、阿乙', '冲突双方姓名齐全');
  const row = rpt.beats.find((b) => b.beat === 1).rows[0];
  assert(row.marks.includes('collision'), '逐拍行带同格标记');
}

console.log('11) 快照隔离：生成后修改走位不影响报告');
{
  const demo = {
    beats: 1,
    actors: [
      { id: 'a', name: '阿甲', start: { c: 1, r: 1 }, moves: { '1': 'U' } },
      { id: 'b', name: '阿乙', start: { c: 2, r: 1 }, moves: { '1': 'U' } }
    ]
  };
  const live = normalizeState(demo);
  const rpt = buildReport({ state: live });
  const snap = JSON.stringify(rpt);

  // 生成后大幅修改走位
  live.actors[0].start = { c: 8, r: 6 };
  live.actors[0].moves[1] = 'D';
  live.actors[1].name = '改名演员';
  live.beats = 2;

  assert(JSON.stringify(rpt) === snap, '走位变化后报告对象完全不变');
  assert(rpt.source.actors[0].start.c === 1, '内嵌快照仍是生成时的起点');
  assert(rpt.source.actors[1].name === '阿乙', '内嵌快照姓名不变');
  assert(rpt.source.beats === 1, '内嵌快照拍数不变');

  // normalizeReport 往返后内容保持一致（存档读取路径）
  const again = normalizeReport(JSON.parse(JSON.stringify(rpt)));
  assert(again !== null && again.id === rpt.id && again.title === rpt.title, '规整后保留 id/标题');
  assert(again.beats.length === rpt.beats.length, '规整后逐拍记录数量一致');
  assert(again.conflicts.length === rpt.conflicts.length, '规整后冲突数量一致');
  assert(again.source && again.source.actors.length === 2, '规整后保留内嵌快照');
}

console.log('12) normalizeReport 丢弃坏数据');
{
  assert(normalizeReport(null) === null, 'null 被拒');
  assert(normalizeReport({ app: 'other' }) === null, '非本应用数据被拒');
  assert(normalizeReport({ app: 'stage-blocking-report', fromBeat: 2, toBeat: 1 }) === null,
    '范围非法被拒');
  assert(normalizeReport({
    app: 'stage-blocking-report', fromBeat: 0, toBeat: 1, actors: []
  }) === null, '无演员被拒');

  const good = buildReport({ state: { beats: 1, actors: [
    { id: 'a', name: '甲', start: { c: 1, r: 1 }, moves: { '1': 'U' } }
  ] } });
  const raw = JSON.parse(JSON.stringify(good));
  raw.conflicts.push({ kind: 'weird', beat: 0, actorIds: ['a'] }); // 坏类型
  raw.conflicts.push({ kind: 'collision', beat: 9, actorIds: ['a'] }); // 超范围
  raw.beats[0].rows.push({ actorId: 'ghost', coord: '9-9' }); // 未知演员
  raw.beats[0].rows[0].coord = 'badcoord'; // 坏坐标
  const fixed = normalizeReport(raw);
  assert(fixed.conflicts.length === good.conflicts.length, '非法冲突条目被丢弃');
  const keptRow = fixed.beats[0].rows.find((x) => x.actorId === 'a');
  assert(keptRow.coord === null, '坏坐标归零为 null');
  assert(!fixed.beats.some((b) => b.rows.some((r) => r.actorId === 'ghost')), '未知演员行被丢弃');
}

console.log('');

/* ============================================================
 * 报告对比
 * ============================================================ */

// 构造两份可对比的报告：
// 共同演员 a,b,c,d,e,f,g；仅 A 含 x；仅 B 含 y。
// A：拍 0..2；B：拍 0..3（共同范围 0..2）。
// 冲突设计：
//   beat1 同格 (3,1): a,b  —— A 有 B 无 → 消除
//   beat1 同格 (3,2): a,c  —— 仅 B → 新增
//   beat2 同格 (7,2): d,e  —— 两边都有 → 保持
//   beat1 d 向 R 越界 (8,2) —— 两边都有 → 保持
//   beat1 e,f 互换 (6,2)/(5,2) —— 仅 B → 新增
//   x 仅在 A：beat2 越界（只涉及非共同演员 → 排除，excludedA=1）
//   y 仅在 B：beat3 越界（共同范围外 → 排除，excludedB=1）
function compareFixtures() {
  const stateA = {
    beats: 2,
    actors: [
      // beat1: a (2,1) R→(3,1)，b (4,1) L→(3,1) 同格；beat2 各自散开
      { id: 'a', name: '阿甲', start: { c: 2, r: 1 }, moves: { '1': 'R', '2': 'R' } },
      { id: 'b', name: '阿乙', start: { c: 4, r: 1 }, moves: { '1': 'L', '2': 'U' } },
      { id: 'c', name: '阿丙', start: { c: 1, r: 1 }, moves: { '1': 'S', '2': 'S' } },
      // beat1 在 (8,2) 向 R 越界；beat2 L→(7,2) 与 e 同格
      { id: 'd', name: '阿丁', start: { c: 8, r: 2 }, moves: { '1': 'R', '2': 'L' } },
      // beat1 原地 (6,2)；beat2 R→(7,2) 与 d 同格
      { id: 'e', name: '阿戊', start: { c: 6, r: 2 }, moves: { '1': 'S', '2': 'R' } },
      // A 侧 f 在 (4,6) 原地，不与任何人冲突
      { id: 'f', name: '阿己', start: { c: 4, r: 6 }, moves: { '1': 'S', '2': 'S' } },
      { id: 'g', name: '阿庚', start: { c: 1, r: 6 }, moves: { '1': 'D', '2': 'D' } },
      // 仅 A：只在 beat2 越界一次
      { id: 'x', name: '仅A', start: { c: 8, r: 6 }, moves: { '1': 'S', '2': 'R' } }
    ]
  };
  const stateB = {
    beats: 3,
    actors: [
      // beat1 原地 (3,2)；与 c 同格；beat2 R→(4,2)
      { id: 'a', name: '阿甲', start: { c: 3, r: 2 }, moves: { '1': 'S', '2': 'R', '3': 'S' } },
      // beat1 原地 (4,1)；beat2 R→(5,1)，避开与 a 同格
      { id: 'b', name: '阿乙', start: { c: 4, r: 1 }, moves: { '1': 'S', '2': 'R', '3': 'S' } },
      // beat1 R (2,2)→(3,2) 与 a 同格；beat2 原地
      { id: 'c', name: '阿丙', start: { c: 2, r: 2 }, moves: { '1': 'R', '2': 'S', '3': 'S' } },
      // beat1 仍在 (8,2) 向 R 越界（保持）；beat2 L→(7,2) 与 e 同格
      { id: 'd', name: '阿丁', start: { c: 8, r: 2 }, moves: { '1': 'R', '2': 'L', '3': 'S' } },
      // beat1 R (5,2)→(6,2) 与 f 互换；beat2 R→(7,2) 与 d 同格
      { id: 'e', name: '阿戊', start: { c: 5, r: 2 }, moves: { '1': 'R', '2': 'R', '3': 'S' } },
      // beat1 L (6,2)→(5,2) 与 e 互换；beat2 原地
      { id: 'f', name: '阿己', start: { c: 6, r: 2 }, moves: { '1': 'L', '2': 'S', '3': 'S' } },
      { id: 'g', name: '阿庚', start: { c: 1, r: 6 }, moves: { '1': 'D', '2': 'D', '3': 'S' } },
      // 仅 B：只在 beat3 越界（共同范围外）
      { id: 'y', name: '仅B', start: { c: 8, r: 1 }, moves: { '1': 'S', '2': 'S', '3': 'R' } }
    ]
  };
  const rptA = buildReport({ state: stateA, title: '排练一版' });
  const rptB = buildReport({ state: stateB, title: '排练二版' });
  return { stateA, stateB, rptA, rptB };
}

console.log('13) analyzeReports：共同演员 / 共同拍次对齐');
{
  const { rptA, rptB } = compareFixtures();
  const r = analyzeReports(rptA, rptB);
  assert(r.status === 'ok', '存在共同演员与共同拍次：status=ok');
  assert(r.commonActors.length === 7, '共同演员 7 位（x / y 互相不在对侧）');
  assert(r.onlyA.join('、') === '仅A' && r.onlyB.join('、') === '仅B', '非共同演员分别列出');
  assert(r.lo === 0 && r.hi === 2, '共同拍次为范围交集 0..2');
  assert(r.beatsOnlyA.length === 0, 'A 无范围外拍次');
  assert(r.beatsOnlyB.length === 1 && r.beatsOnlyB[0] === 3, 'B 的第 3 拍在共同范围外');
  assert(r.beats.length === 3, '逐拍差异含 0/1/2 三个拍次');
  assert(r.beats[2].rows.length === 7, '每拍每个共同演员一行');
}

console.log('14) 逐拍坐标 / 动作差异');
{
  const { rptA, rptB } = compareFixtures();
  const r = analyzeReports(rptA, rptB);
  const beat0 = r.beats.find((b) => b.beat === 0);
  const rowA0 = beat0.rows.find((x) => x.actorId === 'a');
  assert(rowA0.coordA === '2-1' && rowA0.coordB === '3-2', '起点拍：阿甲起点坐标差异 2-1 → 3-2');
  assert(rowA0.coordDiff === true && rowA0.moveA === null && rowA0.moveB === null,
    '坐标标为差异；起点拍动作两侧均为 null（不算动作差异）');

  const beat1 = r.beats.find((b) => b.beat === 1);
  const rowD = beat1.rows.find((x) => x.actorId === 'd');
  assert(rowD.coordA === '8-2' && rowD.coordB === '8-2' && !rowD.coordDiff,
    '阿丁第 1 拍两侧都被拦截在 8-2：坐标一致');
  assert(rowD.moveA === 'R' && rowD.moveB === 'R' && !rowD.moveDiff, '动作一致（都为 R）');
  const rowA1 = beat1.rows.find((x) => x.actorId === 'a');
  assert(rowA1.moveA === 'R' && rowA1.moveB === 'S' && rowA1.moveDiff,
    '阿甲第 1 拍动作差异 R → 原地');
  assert(r.diffCounts.coord > 0 && r.diffCounts.move > 0, '差异计数为正');

  const beat2 = r.beats.find((b) => b.beat === 2);
  assert(beat2.rows.every((x) => x.moveA !== undefined && x.moveB !== undefined),
    '第 2 拍行均带两侧动作');
}

console.log('15) 冲突变化：新增 / 消除 / 保持，三类分别统计');
{
  const { rptA, rptB } = compareFixtures();
  const r = analyzeReports(rptA, rptB);
  const find = (st, kind, beat) => r.changes.find((c) =>
    c.status === st && c.kind === kind && c.beat === beat);

  const removedCol = find('removed', 'collision', 1);
  assert(removedCol && removedCol.cells[0] === '3-1', '消除：A 的 beat1 同格 (3-1) 在 B 已不存在');
  assert(removedCol.keyA && !removedCol.keyB, '消除条目带 A 侧跳转键、无 B 侧键');

  const addedCol = find('added', 'collision', 1);
  assert(addedCol && addedCol.cells[0] === '3-2', '新增：B 的 beat1 同格 (3-2) 为新增');
  assert(!addedCol.keyA && addedCol.keyB, '新增条目带 B 侧跳转键、无 A 侧键');

  const keptCol = find('kept', 'collision', 2);
  assert(keptCol && keptCol.cells[0] === '7-2', '保持：beat2 (7-2) 同格两侧均在');
  assert(keptCol.keyA && keptCol.keyB, '保持条目两侧跳转键齐全');

  const keptBlk = find('kept', 'blocked', 1);
  assert(keptBlk && keptBlk.actors.includes('阿丁'), '保持：阿丁 beat1 越界两侧均被拦截');

  const addedSwap = find('added', 'swap', 1);
  assert(addedSwap, '新增：阿戊/阿己 beat1 互换仅 B 存在');

  assert(r.totals.added === 2, '新增合计 2（1 同格 + 1 互换）');
  assert(r.totals.removed === 1, '消除合计 1');
  assert(r.totals.kept === 2, '保持合计 2（1 同格 + 1 越界）');
  assert(r.summary.collision.added === 1 && r.summary.collision.removed === 1 &&
    r.summary.collision.kept === 1, '同格分类计数 1/1/1');
  assert(r.summary.swap.added === 1 && r.summary.blocked.kept === 1, '互换新增 1、越界保持 1');

  // 排除口径：x 的越界只涉及非共同演员（仅 A）；
  // B 侧 y 在 beat3 的越界 + d/e 持续到 beat3 的同格，都在共同范围外（共 2 条）
  assert(r.excludedA === 1 && r.excludedB === 2, '两侧被排除冲突分别为 1 / 2');
  assert(r.notices.some((n) => n.indexOf('仅「排练一版」包含的演员') >= 0 && n.indexOf('仅A') >= 0),
    '提示：仅 A 含的演员不参与');
  assert(r.notices.some((n) => n.indexOf('拍次') >= 0 && n.indexOf('排练二版') >= 0 &&
    n.indexOf('3') >= 0), '提示：B 的第 3 拍不在共同范围');
  assert(r.notices.some((n) => n.indexOf('有 1 条冲突') >= 0), '提示：A 被排除冲突数量');
  assert(r.notices.some((n) => n.indexOf('有 2 条冲突') >= 0), '提示：B 被排除冲突数量');
}

console.log('16) buildComparison 存档对象与快照隔离');
{
  const { rptA, rptB } = compareFixtures();
  const cmp = buildComparison({ reportA: rptA, reportB: rptB, title: '版次对比' });
  assert(cmp.app === 'stage-blocking-report-comparison' && cmp.version === 1, '带应用标识与版本号');
  assert(cmp.title === '版次对比', '标题被采用');
  assert(cmp.a.id === rptA.id && cmp.b.id === rptB.id, '记录两侧报告 id');
  assert(cmp.status === 'ok' && cmp.beats.length === 3, '内嵌分析结果');
  const snap = JSON.stringify(cmp);

  // 生成后修改报告，不影响已生成的对比
  rptA.title = '被改名';
  rptA.conflicts.length = 0;
  assert(JSON.stringify(cmp) === snap, '源报告变化后对比对象完全不变');

  // 默认标题
  const cmp2 = buildComparison({ reportA: rptB, reportB: rptA });
  assert(cmp2.title.indexOf('报告对比：') === 0, '未提供标题时自动命名');

  // 无效输入
  assert(buildComparison({ reportA: rptA, reportB: rptA }) === null, '同一份报告不能与自己对比');
  assert(buildComparison({ reportA: null, reportB: rptB }) === null, '缺少报告返回 null');
  assert(buildComparison({ reportA: { app: 'x' }, reportB: rptB }) === null, '非报告对象返回 null');
}

console.log('17) 演员不重叠 / 拍次不重叠：明确提示且无差异结果');
{
  // 演员完全不重叠
  const r1 = buildReport({ state: { beats: 1, actors: [
    { id: 'p', name: '潘某', start: { c: 1, r: 1 }, moves: { '1': 'U' } }
  ] } });
  const r2 = buildReport({ state: { beats: 1, actors: [
    { id: 'q', name: '齐某', start: { c: 1, r: 1 }, moves: { '1': 'U' } }
  ] } });
  const r = analyzeReports(r1, r2);
  assert(r.status === 'no-common-actors', '演员不重叠：status=no-common-actors');
  assert(!r.beats && !r.changes && !r.summary, '不生成逐拍差异 / 冲突变化等可能误导的结果');
  assert(r.onlyA.includes('潘某') && r.onlyB.includes('齐某'), '两侧演员仍分别列出用于提示');
  const cmp = buildComparison({ reportA: r1, reportB: r2 });
  assert(cmp.status === 'no-common-actors', '提示性对比可存档（无 beats/changes）');

  // 有共同演员但拍次不重叠
  const r3 = buildReport({ state: { beats: 2, fromBeat: undefined, actors: [
    { id: 'p', name: '潘某', start: { c: 1, r: 1 }, moves: { '1': 'U', '2': 'U' } }
  ] }, actorIds: ['p'], fromBeat: 0, toBeat: 1 });
  const r4 = buildReport({ state: { beats: 4, actors: [
    { id: 'p', name: '潘某', start: { c: 1, r: 1 }, moves: { '1': 'U', '2': 'U', '3': 'U', '4': 'U' } }
  ] }, actorIds: ['p'], fromBeat: 3, toBeat: 4 });
  const r5 = analyzeReports(r3, r4);
  assert(r5.status === 'no-common-beats', '拍次不重叠：status=no-common-beats');
  assert(r5.commonActors.length === 1, '共同演员仍被识别');
  assert(r5.rangeA.hi === 1 && r5.rangeB.lo === 3, '记录两侧范围用于提示');
  assert(!r5.beats && !r5.changes, '不生成逐拍差异');
}

console.log('18) 同名不同 id / 同 id 改名 的对齐口径');
{
  // 同名但 id 不同：不算共同演员
  const r1 = buildReport({ state: { beats: 1, actors: [
    { id: 'p1', name: '主角', start: { c: 1, r: 1 }, moves: { '1': 'U' } }
  ] } });
  const r2 = buildReport({ state: { beats: 1, actors: [
    { id: 'p2', name: '主角', start: { c: 1, r: 1 }, moves: { '1': 'U' } }
  ] } });
  assert(analyzeReports(r1, r2).status === 'no-common-actors', '同名不同 id：不视为共同演员');

  // 同 id 改名：视为共同演员，两侧姓名都保留
  const r3 = buildReport({ state: { beats: 1, actors: [
    { id: 'p', name: '旧名', start: { c: 1, r: 1 }, moves: { '1': 'U' } }
  ] } });
  const r4 = buildReport({ state: { beats: 1, actors: [
    { id: 'p', name: '新名', start: { c: 1, r: 1 }, moves: { '1': 'R' } }
  ] } });
  const r = analyzeReports(r3, r4);
  assert(r.status === 'ok' && r.commonActors.length === 1, '同 id 改名：仍对齐');
  const ca = r.commonActors[0];
  assert(ca.nameA === '旧名' && ca.nameB === '新名', '两侧姓名分别保留（视图显示 旧名 → 新名）');
}

console.log('19) normalizeComparison：存档规整与坏数据丢弃');
{
  const { rptA, rptB } = compareFixtures();
  const cmp = buildComparison({ reportA: rptA, reportB: rptB });

  // 正常往返
  const fixed = normalizeComparison(JSON.parse(JSON.stringify(cmp)));
  assert(fixed !== null && fixed.id === cmp.id && fixed.title === cmp.title, '规整后保留 id/标题');
  assert(fixed.changes.length === cmp.changes.length, '规整后冲突变化数量一致');
  assert(fixed.beats.length === cmp.beats.length, '规整后逐拍数量一致');
  assert(fixed.totals.added === cmp.totals.added && fixed.totals.removed === cmp.totals.removed &&
    fixed.totals.kept === cmp.totals.kept, '分类合计从条目重新派生');
  assert(fixed.diffCounts.coord === cmp.diffCounts.coord, '坐标差异数重新派生');

  // 差异标记被篡改：按坐标/动作实际值重新派生
  fixed.beats.forEach((bk) => bk.rows.forEach((row) => { row.coordDiff = !row.coordDiff; }));
  const again = normalizeComparison(fixed);
  const beat1 = again.beats.find((b) => b.beat === 1);
  const rowA = beat1.rows.find((x) => x.actorId === 'a');
  assert(rowA.coordDiff === (rowA.coordA !== rowA.coordB), '被篡改的差异标记被纠正');

  // 提示性对比（演员不重叠）往返
  const r1 = buildReport({ state: { beats: 1, actors: [
    { id: 'p', name: '潘', start: { c: 1, r: 1 }, moves: { '1': 'U' } }
  ] } });
  const r2 = buildReport({ state: { beats: 1, actors: [
    { id: 'q', name: '齐', start: { c: 1, r: 1 }, moves: { '1': 'U' } }
  ] } });
  const warnCmp = buildComparison({ reportA: r1, reportB: r2 });
  const warnFixed = normalizeComparison(JSON.parse(JSON.stringify(warnCmp)));
  assert(warnFixed.status === 'no-common-actors' && !warnFixed.beats, '提示性对比可往返且无逐拍数据');

  // 坏数据
  assert(normalizeComparison(null) === null, 'null 被拒');
  assert(normalizeComparison({ app: 'other' }) === null, '非本应用数据被拒');
  assert(normalizeComparison({ app: 'stage-blocking-report-comparison' }) === null, '缺侧信息被拒');
  const bad = JSON.parse(JSON.stringify(cmp));
  bad.lo = 9; bad.hi = 2; // 范围非法
  assert(normalizeComparison(bad) === null, '共同范围非法被拒');
  const bad2 = JSON.parse(JSON.stringify(cmp));
  bad2.changes.push({ kind: 'weird', status: 'added', beat: 1, actors: ['x'] });
  bad2.beats[0].rows.push({ actorId: 'ghost', coordA: '9-9', coordB: '9-9' });
  const fixed2 = normalizeComparison(bad2);
  assert(fixed2.changes.length === cmp.changes.length, '非法变化条目被丢弃');
  assert(!fixed2.beats.some((b) => b.rows.some((row) => row.actorId === 'ghost')), '未知演员行被丢弃');
}

console.log('20) compactBeatLabels：拍次段压缩');
{
  assert(compactBeatLabels([]) === '无', '空列表 → 无');
  assert(compactBeatLabels([0]) === '起点', '第 0 拍 → 起点');
  assert(compactBeatLabels([3]) === '3', '单拍');
  assert(compactBeatLabels([1, 2, 3]) === '1-3', '连续段合并');
  assert(compactBeatLabels([0, 1, 3, 4, 6]) === '起点-1、3-4、6', '混合段（起点开头）');
}

console.log('21) 冲突匹配：当事人顺序 / 互换格子顺序不影响「保持」判定');
{
  // 完全相同的走位，两份报告：互换条目两侧 actors/cells 顺序来自同一生成逻辑，
  // 这里直接验证 compareConflictKey 对不同输入顺序稳定
  const k1 = compareConflictKey({
    kind: 'collision', beat: 2, actorIds: ['a', 'b'], cells: ['3-2']
  });
  const k2 = compareConflictKey({
    kind: 'collision', beat: 2, actorIds: ['b', 'a'], cells: ['3-2']
  });
  assert(k1 === k2, '同格签名与当事人 id 顺序无关');
  const s1 = compareConflictKey({ kind: 'swap', beat: 1, actorIds: ['a', 'b'], cells: ['4-2', '3-2'] });
  const s2 = compareConflictKey({ kind: 'swap', beat: 1, actorIds: ['b', 'a'], cells: ['3-2', '4-2'] });
  assert(s1 === s2, '互换签名与当事人顺序无关（cells 不参与签名）');
  assert(compareConflictKey({ kind: 'blocked', beat: 1, actorIds: ['a'] }) ===
    'blocked:1:a', '越界签名只看拍与演员');

  // 同演员同格不同拍：不算同一条
  const c1 = compareConflictKey({ kind: 'collision', beat: 1, actorIds: ['a', 'b'], cells: ['3-2'] });
  const c2 = compareConflictKey({ kind: 'collision', beat: 2, actorIds: ['a', 'b'], cells: ['3-2'] });
  assert(c1 !== c2, '同格冲突拍次不同 → 不同条目（一拍消除一拍新增）');
}

console.log('22) 持续冲突只在进入/离开共同范围时计数一次');
{
  // A 范围 0..2，B 范围 0..3；d,e 在 beat2 与 beat3 都同格：
  // beat2 在共同范围内「保持」一条；beat3 仅提示范围外，不重复计数。
  // d 起点 (6,2)：beat1 原地、beat2 右到 (7,2)、beat3 原地
  // e 起点 (7,2)：三拍全部原地 → beat2 与 beat3 两人都同在 (7,2)（持续同格，无互换）
  const base = {
    actors: [
      { id: 'd', name: '阿丁', start: { c: 6, r: 2 }, moves: { '1': 'S', '2': 'R', '3': 'S' } },
      { id: 'e', name: '阿戊', start: { c: 7, r: 2 }, moves: { '1': 'S', '2': 'S', '3': 'S' } }
    ]
  };
  const r1 = buildReport({ state: Object.assign({ beats: 2 }, base),
    actorIds: ['d', 'e'], fromBeat: 0, toBeat: 2, title: '短' });
  const r2 = buildReport({ state: Object.assign({ beats: 3 }, base),
    actorIds: ['d', 'e'], fromBeat: 0, toBeat: 3, title: '长' });
  const r = analyzeReports(r1, r2);
  assert(r.status === 'ok' && r.lo === 0 && r.hi === 2, '共同范围 0..2');
  assert(r.totals.kept === 1 && r.totals.added === 0 && r.totals.removed === 0,
    'beat2 同格保持 1 条，beat3（持续同格但范围外）不产生新增');
  assert(r.beatsOnlyB.length === 1 && r.beatsOnlyB[0] === 3, 'beat3 列为 B 独有拍次提示');
  assert(r.excludedB === 1, 'B 的 beat3 同格计入排除数并在提示中说明');
}

console.log('');
if (failed) {
  console.error(`结果: ${passed} 通过, ${failed} 失败`);
  process.exit(1);
}
console.log(`结果: ${passed} 全部通过 🎉`);
