import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareVolumePlan, publishVolumes } from '../scripts/volume-publishing.mjs';

function fixture() {
  const state = { bookId: 'book', bookTitle: '测试作品', complete: true,
    coverage: { chapters: true, drafts: true, volumes: true },
    volumes: [{ id: 'a', title: '第一卷' }, { id: 'b', title: '第二卷' }],
    chapters: [1, 2, 3].map(number => ({ id: 'c' + number, number, title: '第' + number,
      body: '正文' + number, status: number === 1 ? 'published' : 'draft',
      location: number === 1 ? 'chapters' : 'drafts', volumeId: 'a' })) };
  const calls = [], events = [];
  const ui = {
    snapshot: async () => structuredClone(state),
    openAssignVolume: async (c, v) => ({ kind: 'assign-volume', bookId: 'book', chapterId: c.id,
      volumeId: v.volumeId, volumeTitle: v.volumeTitle, understood: true }),
    confirmAssignVolume: async d => { calls.push('assign:' + d.chapterId); state.chapters.find(c => c.id === d.chapterId).volumeId = d.volumeId; },
    openPublish: async (c, v, aiUsed) => ({ ...c, kind: 'publish', bookId: 'book', chapterId: c.id,
      volumeId: v.volumeId, volumeTitle: v.volumeTitle, aiUsed, aiChecked: true, understood: true }),
    confirmPublish: async d => { calls.push('publish:' + d.chapterId); const c = state.chapters.find(c => c.id === d.chapterId); c.status = 'reviewing'; c.location = 'chapters'; },
  };
  const ranges = [{ volumeId: 'a', volumeTitle: '第一卷', from: 1, to: 2 },
    { volumeId: 'b', volumeTitle: '第二卷', from: 3, to: 3 }];
  return { state, calls, events, ui, ranges, journal: async e => events.push(structuredClone(e)) };
}

test('先规划后按章号归卷与发布，跳过已提交章；复跑不重复提交', async () => {
  const f = fixture(), plan = await prepareVolumePlan(f.ui, 'book', f.ranges);
  assert.deepEqual(f.calls, []);
  const result = await publishVolumes(f.ui, plan, { moveDrafts: true, aiUsed: true }, f.journal);
  assert.deepEqual(f.calls, ['publish:c2', 'assign:c3', 'publish:c3']);
  assert.equal(result[0].skipped, true);
  assert.equal(f.state.chapters[2].volumeId, 'b');
  assert.equal(f.events.at(-1).stage, 'volumes-verified');
  await publishVolumes(f.ui, plan, { moveDrafts: true, aiUsed: true }, f.journal);
  assert.equal(f.calls.length, 3);
});

test('缺章、重号、重叠范围、错误卷名或已发布章错卷均不执行', async () => {
  for (const change of [
    f => f.state.chapters.pop(),
    f => f.state.chapters.push({ ...f.state.chapters[0], id: 'duplicate' }),
    f => { f.ranges[1].from = 2; },
    f => { f.ranges[0].volumeTitle = '错误名'; },
    f => { f.state.chapters[0].volumeId = 'b'; },
    f => { f.state.coverage.volumes = false; },
    f => { f.state.chapters[1].body = ''; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(prepareVolumePlan(f.ui, 'book', f.ranges));
    assert.deepEqual(f.calls, []);
  }
});

test('归卷未获授权或AI事实未知时整个计划不开始', async () => {
  const f = fixture(), plan = await prepareVolumePlan(f.ui, 'book', f.ranges);
  await assert.rejects(publishVolumes(f.ui, plan, { aiUsed: true }, f.journal), /归卷授权/);
  await assert.rejects(publishVolumes(f.ui, plan, { moveDrafts: true }, f.journal), /AI/);
  assert.deepEqual(f.calls, []);
});

test('正文变动、发布表单错卷或AI未选中时不确认发布', async () => {
  for (const mode of ['body', 'volume', 'ai']) {
    const f = fixture(), plan = await prepareVolumePlan(f.ui, 'book', f.ranges);
    if (mode === 'body') f.state.chapters[1].body = '被改动';
    else {
      const open = f.ui.openPublish;
      f.ui.openPublish = async (...args) => { const d = await open(...args);
        if (mode === 'volume') d.volumeId = 'b'; else d.aiChecked = false;
        return d;
      };
    }
    await assert.rejects(publishVolumes(f.ui, plan, { moveDrafts: true, aiUsed: true }, f.journal));
    assert.deepEqual(f.calls, []);
  }
});

test('提交超时不重试、不处理下一章；归卷超时同样停止', async () => {
  for (const kind of ['publish', 'assign']) {
    const f = fixture();
    if (kind === 'assign') f.state.chapters[1].volumeId = 'b';
    const plan = await prepareVolumePlan(f.ui, 'book', f.ranges);
    let attempts = 0;
    f.ui[kind === 'assign' ? 'confirmAssignVolume' : 'confirmPublish'] = async () => {
      attempts++; throw new Error('超时');
    };
    await assert.rejects(publishVolumes(f.ui, plan, { moveDrafts: true, aiUsed: true }, f.journal), /超时/);
    assert.equal(attempts, 1);
    assert.equal(f.events.at(-1).stage, kind === 'assign' ? 'assign-intent' : 'publish-intent');
  }
});

test('确认前正文变化、回执错卷和记录失败均终止', async () => {
  for (const kind of ['changed', 'receipt', 'journal']) {
    const f = fixture(), plan = await prepareVolumePlan(f.ui, 'book', f.ranges);
    const open = f.ui.openPublish, confirm = f.ui.confirmPublish;
    if (kind === 'changed') f.ui.openPublish = async (...args) => {
      const d = await open(...args); f.state.chapters[1].body = '新版本'; return d;
    };
    if (kind === 'receipt') f.ui.confirmPublish = async d => {
      await confirm(d); f.state.chapters[1].volumeId = 'b';
    };
    const journal = kind === 'journal' ? async () => { throw new Error('磁盘失败'); } : f.journal;
    await assert.rejects(publishVolumes(f.ui, plan, { moveDrafts: true, aiUsed: false }, journal));
    assert.equal(f.calls.includes('publish:c3'), false);
    if (kind !== 'receipt') assert.deepEqual(f.calls, []);
  }
});

test('后台成功后抛超时，核实后恢复不重复归卷或发布', async () => {
  for (const kind of ['publish', 'assign']) {
    const f = fixture();
    if (kind === 'assign') f.state.chapters[1].volumeId = 'b';
    const plan = await prepareVolumePlan(f.ui, 'book', f.ranges);
    const method = kind === 'assign' ? 'confirmAssignVolume' : 'confirmPublish';
    const confirm = f.ui[method];
    f.ui[method] = async d => { await confirm(d); throw new Error('超时'); };
    await assert.rejects(publishVolumes(f.ui, plan, { moveDrafts: true, aiUsed: true }, f.journal), /超时/);
    assert.equal(f.events.at(-1).stage, kind === 'assign' ? 'assign-intent' : 'publish-intent');
    assert.equal(f.calls.length, 1);
    f.ui[method] = confirm;
    await publishVolumes(f.ui, plan, { moveDrafts: true, aiUsed: true }, f.journal);
    assert.equal(f.calls.filter(c => c === kind + ':c2').length, 1);
    assert.equal(f.calls.filter(c => c === 'publish:c2').length, 1);
    assert.equal(f.events.at(-1).stage, 'volumes-verified');
  }
});
