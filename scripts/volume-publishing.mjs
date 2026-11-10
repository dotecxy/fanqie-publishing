// UI adapter only: do not use private publishing endpoints or evaluate mutations.
const unchangedText = (a, b) => a.id === b.id && a.number === b.number
  && a.title === b.title && a.body === b.body;

async function read(ui, bookId) {
  const s = await ui.snapshot();
  if (s.bookId !== bookId || s.complete !== true || !s.bookTitle
      || s.coverage?.chapters !== true || s.coverage?.drafts !== true || s.coverage?.volumes !== true
      || !Array.isArray(s.chapters) || !Array.isArray(s.volumes)) {
    throw new Error('作品不匹配或章节/分卷列表不完整');
  }
  if (s.chapters.some(c => !c.id || typeof c.body !== 'string')
      || new Set(s.chapters.map(c => c.id)).size !== s.chapters.length
      || s.volumes.some(v => !v.id || !v.title)
      || new Set(s.volumes.map(v => v.id)).size !== s.volumes.length) {
    throw new Error('章节或分卷身份不完整');
  }
  return s;
}

function volume(s, target) {
  const found = s.volumes.filter(v => v.id === target.volumeId);
  if (found.length !== 1 || found[0].title !== target.volumeTitle) {
    throw new Error('目标分卷不存在或已改名');
  }
}

function chapter(s, expected) {
  const found = s.chapters.filter(c => c.number === expected.number);
  if (found.length !== 1 || !unchangedText(found[0], expected)) {
    throw new Error('章号重复、缺章或稿件版本变化');
  }
  const c = found[0];
  if (!['draft', 'reviewing', 'published'].includes(c.status) || !c.body.trim()
      || c.location !== (c.status === 'draft' ? 'drafts' : 'chapters')) {
    throw new Error('章节为空或状态不支持');
  }
  return c;
}

// Read-only preparation. Persist the returned full baselines before execution.
export async function prepareVolumePlan(ui, bookId, ranges) {
  if (!Array.isArray(ranges) || !ranges.length) throw new Error('缺少分卷范围');
  const s = await read(ui, bookId), chapters = [];
  let end = 0;
  const ids = new Set();
  for (const r of ranges) {
    if (!Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to)
        || r.from < 1 || r.to < r.from || r.from <= end || ids.has(r.volumeId)) {
      throw new Error('卷序、章号范围重叠或分卷重复');
    }
    volume(s, r);
    for (let number = r.from; number <= r.to; number++) {
      const matches = s.chapters.filter(c => c.number === number);
      if (matches.length !== 1) throw new Error('章号重复或缺章：' + number);
      const c = chapter(s, matches[0]);
      if (c.status !== 'draft' && c.volumeId !== r.volumeId) {
        throw new Error('已提交章节所属卷不符，需单独处理');
      }
      chapters.push({ ...c, targetVolumeId: r.volumeId, targetVolumeTitle: r.volumeTitle });
    }
    ids.add(r.volumeId);
    end = r.to;
  }
  return structuredClone({ bookId, bookTitle: s.bookTitle, ranges, chapters });
}

// Authorization is supplied by the executing agent from the user's actual request.
// journal must durably save full baselines/intents/receipts before resolving.
export async function publishVolumes(ui, plan, { moveDrafts = false, aiUsed }, journal) {
  if (typeof aiUsed !== 'boolean') throw new Error('缺少AI使用事实');
  const fresh = await prepareVolumePlan(ui, plan.bookId, plan.ranges);
  if (fresh.chapters.length !== plan.chapters.length || fresh.chapters.some((c, i) => {
    const old = plan.chapters[i];
    return !unchangedText(c, old) || c.targetVolumeId !== old.targetVolumeId
      || c.targetVolumeTitle !== old.targetVolumeTitle;
  })) throw new Error('发布计划或稿件发生变化');
  if (!moveDrafts && fresh.chapters.some(c => c.status === 'draft' && c.volumeId !== c.targetVolumeId)) {
    throw new Error('缺少草稿归卷授权');
  }
  await journal({ stage: 'volume-plan', plan: fresh });
  const results = [];
  for (const expected of plan.chapters) {
    const target = { volumeId: expected.targetVolumeId, volumeTitle: expected.targetVolumeTitle };
    let s = await read(ui, plan.bookId);
    volume(s, target);
    let c = chapter(s, expected);
    if (c.status === 'draft' && c.volumeId !== target.volumeId) {
      if (!moveDrafts) throw new Error('缺少草稿归卷授权');
      const d = await ui.openAssignVolume(c, target);
      if (d.kind !== 'assign-volume' || d.bookId !== plan.bookId || d.chapterId !== c.id
          || d.volumeId !== target.volumeId || d.volumeTitle !== target.volumeTitle
          || d.understood !== true) throw new Error('归卷表单不匹配');
      await journal({ stage: 'assign-intent', chapter: c, target });
      s = await read(ui, plan.bookId);
      volume(s, target);
      const before = chapter(s, expected);
      if (before.status !== 'draft' || before.volumeId !== c.volumeId) throw new Error('归卷前状态变化');
      await ui.confirmAssignVolume(d); // Once; any error aborts, never retries.
      s = await read(ui, plan.bookId);
      volume(s, target);
      c = chapter(s, expected);
      if (c.status !== 'draft' || c.volumeId !== target.volumeId) throw new Error('未取得草稿归卷回执');
      await journal({ stage: 'assigned', chapter: c, target });
    }
    if (c.volumeId !== target.volumeId) throw new Error('章节所属卷不匹配');
    if (c.status !== 'draft') {
      await journal({ stage: 'already-submitted', chapter: c });
      results.push({ id: c.id, number: c.number, status: c.status, skipped: true });
      continue;
    }
    const d = await ui.openPublish(c, target, aiUsed);
    if (d.kind !== 'publish' || d.bookId !== plan.bookId || d.chapterId !== c.id
        || d.title !== c.title || d.number !== c.number || d.body !== c.body
        || d.volumeId !== target.volumeId || d.volumeTitle !== target.volumeTitle
        || d.aiUsed !== aiUsed || d.aiChecked !== true || d.understood !== true) {
      throw new Error('发布设置、全文、分卷或AI声明不匹配');
    }
    await journal({ stage: 'publish-intent', chapter: c, target });
    s = await read(ui, plan.bookId);
    volume(s, target);
    const before = chapter(s, expected);
    if (before.status !== 'draft' || before.volumeId !== target.volumeId) throw new Error('提交前状态变化');
    await ui.confirmPublish(d); // Once, then verify backend independently.
    s = await read(ui, plan.bookId);
    volume(s, target);
    c = chapter(s, expected);
    if (c.volumeId !== target.volumeId || !['reviewing', 'published'].includes(c.status)) {
      throw new Error('未取得对应分卷的提交回执');
    }
    await journal({ stage: 'submitted', chapter: c });
    results.push({ id: c.id, number: c.number, status: c.status, skipped: false });
  }
  // Re-read the entire authorized set, including skipped chapters, before completion.
  const final = await read(ui, plan.bookId);
  for (const expected of plan.chapters) {
    volume(final, { volumeId: expected.targetVolumeId, volumeTitle: expected.targetVolumeTitle });
    const c = chapter(final, expected);
    if (c.volumeId !== expected.targetVolumeId || !['reviewing', 'published'].includes(c.status)) {
      throw new Error('最终按卷核对不通过');
    }
  }
  await journal({ stage: 'volumes-verified', chapters: plan.chapters.map(c => chapter(final, c)) });
  return results;
}
