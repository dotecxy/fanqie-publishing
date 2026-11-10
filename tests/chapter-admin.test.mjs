import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareClear, clearAllChapters, createVolumes } from '../scripts/chapter-admin.mjs';

function mock() {
  const state = { bookId: 'book', bookTitle: '测试作品', complete: true,
    coverage: { chapters: true, drafts: true, volumes: true },
    chapters: [
      { id: 'c1', number: 1, title: '正文', body: '正文全文', status: 'published', location: 'chapters' },
      { id: 'c2', number: '', title: '未命名', body: '', status: 'draft', location: 'drafts' },
    ], volumes: [{ id: 'default', title: '默认卷' }] };
  const calls = [];
  const ui = {
    snapshot: async () => structuredClone(state),
    openDelete: async c => ({ bookId: state.bookId, chapterId: c.id, kind: 'delete-chapter', understood: true }),
    confirmDelete: async d => { calls.push(d.chapterId); state.chapters = state.chapters.filter(c => c.id !== d.chapterId); },
    openCreateVolume: async title => ({ bookId: state.bookId, title, kind: 'create-volume', understood: true }),
    confirmCreateVolume: async d => { calls.push(d.title); state.volumes.push({ id: 'new', title: d.title }); },
  };
  return { state, ui, calls };
}

test('全清需授权与完整备份；逐章回执包含空白稿；保留分卷', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fanqie-admin-'));
  try {
    const { state, ui, calls } = mock(), events = [];
    const plan = await prepareClear(ui, 'book', join(dir, 'backup.json'));
    await assert.rejects(clearAllChapters(ui, plan, {}, async e => events.push(e)), /授权/);
    assert.equal(calls.length, 0);
    const approval = { action: 'clear-all-chapters', bookId: 'book', backupSha256: plan.backupSha256 };
    const receipt = await clearAllChapters(ui, plan, approval, async e => events.push(e));
    assert.equal(receipt.remaining, 0);
    assert.deepEqual(calls, ['c2', 'c1']);
    assert.deepEqual(events.map(e => e.stage), ['delete-intent', 'deleted', 'delete-intent', 'deleted']);
    assert.equal(state.volumes.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('不完整列表、正文变化、备份篡改均不删除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fanqie-admin-'));
  try {
    const { state, ui, calls } = mock();
    state.complete = false;
    await assert.rejects(prepareClear(ui, 'book', join(dir, 'bad.json')), /不完整/);
    state.complete = true;
    const plan = await prepareClear(ui, 'book', join(dir, 'backup.json'));
    const approval = { action: 'clear-all-chapters', bookId: 'book', backupSha256: plan.backupSha256 };
    state.chapters[0].body = '新版本';
    await assert.rejects(clearAllChapters(ui, plan, approval, async () => {}), /集合或版本变化/);
    await appendFile(plan.backupPath, ' ');
    await assert.rejects(clearAllChapters(ui, plan, approval, async () => {}), /备份已变化/);
    assert.equal(calls.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('确认删除结果不明即停，不重试、不处理下一章', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fanqie-admin-'));
  try {
    const { ui } = mock(), events = [];
    let confirms = 0;
    ui.confirmDelete = async () => { confirms++; throw new Error('超时'); };
    const plan = await prepareClear(ui, 'book', join(dir, 'backup.json'));
    const approval = { action: 'clear-all-chapters', bookId: 'book', backupSha256: plan.backupSha256 };
    await assert.rejects(clearAllChapters(ui, plan, approval, async e => events.push(e)), /超时/);
    assert.equal(confirms, 1);
    assert.deepEqual(events.map(e => e.stage), ['delete-intent']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('新建分卷并复用已有卷；重复名称或不明回执即停', async () => {
  const { ui, calls, state } = mock(), events = [];
  const result = await createVolumes(ui, 'book', ['默认卷', '第二卷'], async e => events.push(e));
  assert.deepEqual(result.map(v => v.reused), [true, false]);
  assert.deepEqual(calls, ['第二卷']);
  await assert.rejects(createVolumes(ui, 'book', ['重复', '重复'], async () => {}), /重复/);
  ui.confirmCreateVolume = async () => {};
  await assert.rejects(createVolumes(ui, 'book', ['第三卷'], async () => {}), /回执/);
  assert.equal(state.volumes.length, 2);
  assert.equal(events.length, 2);
});

test('误切作品、新增章节、持久记录失败均不发删除确认', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fanqie-admin-'));
  try {
    const { ui, state, calls } = mock();
    const plan = await prepareClear(ui, 'book', join(dir, 'backup.json'));
    const approval = { action: 'clear-all-chapters', bookId: 'book', backupSha256: plan.backupSha256 };
    state.bookId = 'other';
    await assert.rejects(clearAllChapters(ui, plan, approval, async () => {}), /作品不匹配/);
    state.bookId = 'book';
    state.chapters.push({ ...state.chapters[0], id: 'new' });
    await assert.rejects(clearAllChapters(ui, plan, approval, async () => {}), /集合或版本变化/);
    state.chapters.pop();
    await assert.rejects(clearAllChapters(ui, plan, approval, async () => { throw new Error('磁盘失败'); }), /磁盘失败/);
    assert.equal(calls.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('建卷超时不重试；不得将覆盖默认卷当作新建成功', async () => {
  const { ui, state } = mock();
  let confirms = 0;
  ui.confirmCreateVolume = async () => { confirms++; throw new Error('超时'); };
  await assert.rejects(createVolumes(ui, 'book', ['第二卷'], async () => {}), /超时/);
  assert.equal(confirms, 1);
  ui.confirmCreateVolume = async () => { state.volumes[0].title = '第二卷'; };
  await assert.rejects(createVolumes(ui, 'book', ['第二卷'], async () => {}), /原有分卷发生变化/);
});

test('打开删除弹窗后正文变化不确认；近似卷名先核实', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fanqie-admin-'));
  try {
    const { ui, state, calls } = mock();
    const plan = await prepareClear(ui, 'book', join(dir, 'backup.json'));
    const approval = { action: 'clear-all-chapters', bookId: 'book', backupSha256: plan.backupSha256 };
    const open = ui.openDelete;
    ui.openDelete = async c => { const d = await open(c); state.chapters[0].body = '改过'; return d; };
    await assert.rejects(clearAllChapters(ui, plan, approval, async () => {}), /版本变化/);
    state.volumes.push({ id: 'v2', title: 'Volume A' });
    await assert.rejects(createVolumes(ui, 'book', ['volume  A'], async () => {}), /规范化/);
    assert.equal(calls.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
