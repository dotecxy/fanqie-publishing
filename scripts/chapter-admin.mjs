// Browser adapters must use the current tool's UI operations, never private APIs.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const digest = text => createHash('sha256').update(text).digest('hex');
const titleKey = title => title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const sameChapter = (a, b) => ['id', 'number', 'title', 'status', 'location', 'body', 'volumeId']
  .every(key => a[key] === b[key]);

async function snapshot(ui, bookId) {
  const s = await ui.snapshot();
  if (s.bookId !== bookId || !s.bookTitle || s.complete !== true || !Array.isArray(s.chapters)
      || !Array.isArray(s.volumes) || s.coverage?.chapters !== true
      || s.coverage?.drafts !== true || s.coverage?.volumes !== true) {
    throw new Error('作品不匹配或分页读取不完整');
  }
  if (new Set(s.chapters.map(c => c.id)).size !== s.chapters.length
      || s.chapters.some(c => typeof c.id !== 'string' || !c.id || typeof c.title !== 'string'
        || typeof c.body !== 'string' || (c.status !== 'draft' && !c.body.trim())
        || !['published', 'reviewing', 'draft'].includes(c.status)
        || !['chapters', 'drafts'].includes(c.location))) {
    throw new Error('章节身份、正文或状态不完整');
  }
  if (s.volumes.some(v => !v.id || typeof v.title !== 'string')
      || new Set(s.volumes.map(v => v.id)).size !== s.volumes.length) {
    throw new Error('分卷身份不完整');
  }
  return s;
}

// Read-only browser preparation; the backup path must be new (never overwritten).
export async function prepareClear(ui, bookId, backupPath) {
  const s = await snapshot(ui, bookId);
  const backup = JSON.stringify({ ...s, capturedAt: new Date().toISOString() }, null, 2);
  await writeFile(backupPath, backup, { flag: 'wx', encoding: 'utf8' });
  if (await readFile(backupPath, 'utf8') !== backup) throw new Error('备份回读失败');
  return { bookId, bookTitle: s.bookTitle, backupPath, backupSha256: digest(backup),
    chapterCount: s.chapters.length, includesBlankDrafts: true };
}

// approval must come from the user after reviewing this exact plan.
// Each journal callback must durably save the event before resolving.
export async function clearAllChapters(ui, plan, approval, journal) {
  if (approval?.action !== 'clear-all-chapters' || approval.bookId !== plan.bookId
      || approval.backupSha256 !== plan.backupSha256) throw new Error('缺少本次清空授权');
  const backup = await readFile(plan.backupPath, 'utf8');
  if (digest(backup) !== plan.backupSha256) throw new Error('备份已变化');
  const original = JSON.parse(backup);
  if (original.bookId !== plan.bookId || original.chapters.length !== plan.chapterCount) {
    throw new Error('清空计划与备份不符');
  }
  let current = await snapshot(ui, plan.bookId);
  const expected = new Map(original.chapters.map(c => [c.id, c]));
  function check() {
    if (current.chapters.length !== expected.size || current.chapters.some(c =>
      !expected.has(c.id) || !sameChapter(c, expected.get(c.id)))) {
      throw new Error('章节集合或版本变化，停止删除并重新核对');
    }
  }
  check();
  // Freeze the set; never chase newly created chapters or rely on row indices.
  for (const chapter of [...original.chapters].reverse()) {
    current = await snapshot(ui, plan.bookId);
    check();
    const dialog = await ui.openDelete(chapter); // Locate this id from a fresh row.
    if (dialog.bookId !== plan.bookId || dialog.chapterId !== chapter.id
        || dialog.kind !== 'delete-chapter' || dialog.understood !== true) {
      throw new Error('删除弹窗身份或影响不明确');
    }
    await journal({ stage: 'delete-intent', bookId: plan.bookId, chapterId: chapter.id });
    current = await snapshot(ui, plan.bookId);
    check();
    await ui.confirmDelete(dialog); // Exactly once. Any error aborts, never retries.
    current = await snapshot(ui, plan.bookId);
    expected.delete(chapter.id);
    check();
    await journal({ stage: 'deleted', bookId: plan.bookId, chapterId: chapter.id });
  }
  current = await snapshot(ui, plan.bookId);
  if (current.chapters.length) throw new Error('仍有章节，不能报告已清空');
  return { bookId: plan.bookId, deleted: original.chapters.length, remaining: 0 };
}

export async function createVolumes(ui, bookId, titles, journal) {
  if (!Array.isArray(titles) || !titles.length || titles.some(t =>
    typeof t !== 'string' || !t.trim() || t !== t.trim())
      || new Set(titles.map(titleKey)).size !== titles.length) throw new Error('分卷名称为空或重复');
  const result = [];
  for (const title of titles) {
    let s = await snapshot(ui, bookId);
    const found = s.volumes.filter(v => v.title === title);
    if (s.volumes.some(v => titleKey(v.title) === titleKey(title) && v.title !== title)) {
      throw new Error('分卷名称可能经平台规范化后重名，需现场核对');
    }
    if (found.length > 1) throw new Error('已有同名分卷不唯一');
    if (found.length === 1) {
      result.push({ ...found[0], reused: true });
      continue;
    }
    const dialog = await ui.openCreateVolume(title); // UI opens and fills the form.
    if (dialog.bookId !== bookId || dialog.title !== title
        || dialog.kind !== 'create-volume' || dialog.understood !== true) {
      throw new Error('分卷弹窗不匹配');
    }
    await journal({ stage: 'volume-intent', bookId, title });
    const beforeConfirm = await snapshot(ui, bookId);
    if (JSON.stringify(beforeConfirm.volumes) !== JSON.stringify(s.volumes)) {
      throw new Error('确认前分卷列表变化，停止创建并重新核对');
    }
    await ui.confirmCreateVolume(dialog); // Once, no timeout retry.
    const after = await snapshot(ui, bookId);
    const created = after.volumes.filter(v => v.title === title);
    if (created.length !== 1 || !created[0].id) throw new Error('未取得唯一分卷回执');
    if (after.volumes.length !== s.volumes.length + 1 || s.volumes.some(v =>
      !after.volumes.some(w => w.id === v.id && w.title === v.title))) {
      throw new Error('原有分卷发生变化，停止继续创建');
    }
    await journal({ stage: 'volume-created', bookId, volume: created[0] });
    result.push({ ...created[0], reused: false });
  }
  return result;
}
