# 按卷归属与发布

按作者指定的分卷范围，将已有非空草稿归入目标卷，再按全书章号升序提交审核。添加本能力不授权操作任何作品。此流程不上传缺稿、不改正文、不移动已提交章节；建卷使用独立的[创建分卷流程](chapter-admin.md)。

## 执行流程

1. 确认作品、稿源、立即或定时要求，以及每卷的名称和起止章号。读取章节管理、草稿箱和分卷的全部相关分页，取得实际卷 ID、章节 ID、章号、标题、完整正文、状态和当前所属卷。不能把某卷筛选结果当成全书；计划外章节不加入本次范围。
2. 保存固定计划及完整正文基线。每卷对应一个连续区间，区间按章号升序且不重叠；多个区间之间可以留有未授权范围，但每个区间内部不得缺章、重号或包含空正文。章号转为数值后排序，不用行号或创建时间代替。
3. 目标卷必须已存在且 ID、名称一致。需要建卷时先核实建卷授权，创建后重新读取真实卷 ID。卷名不能唯一确定、卷名变化或实际顺序不符时先核实。草稿在其他卷时，需要明确允许按该计划归卷；未获归卷授权则在执行整个计划前停止。
4. 按章号逐章执行。已审核中或已发布的章节仅在 ID、章号、标题、正文和卷归属均匹配时跳过；已提交章错卷停止，另行处理。对待归卷草稿打开真实归卷控件，核对作品、章节和目标卷，保存意图后确认一次；重新读取后台，确认正文未变、状态仍为草稿且所属卷正确，保存归卷回执。
5. 核对编辑页全文和当前卷归属，读取平台实际发布设置与警告。按创作事实选择 AI 声明，并另读选中状态。最终提交前再核对作品、章号、标题、全文、卷和发布方式；保存意图，串行确认一次。只有章节管理中同一章节在目标卷显示“审核中/已发布”，才保存提交回执并继续下一章。
6. 超时或结果不明时停止，先查旧操作是否仍运行，再核对实时后台。已成功归卷的草稿不重复归卷；已提交且卷正确的章节不重复提交。不能因缺少本地回执直接重放操作，也不能在状态未知时重新启动旧计划。
7. 全部处理后重新遍历授权章节，核对每章完整正文、身份、卷归属和状态，检查是否遗留目标草稿。按卷报告本次提交、原已提交、当前审核中和已发布数量。提交到终章不证明平台已完结。

标题冲突按技能入口的授权规则处理：获准后只改后章标题，保留正文，记录旧/新标题并核实唯一；因基线已改变，重建剩余计划后继续。不要跳过脚本的版本检查强行使用旧计划。

## 代码调用

[volume-publishing.mjs](../scripts/volume-publishing.mjs) 提供 `prepareVolumePlan` 和 `publishVolumes`。前者只读，后者依次归卷、发布并核对。它不是番茄 SDK，不含现场未验证的选择器或后台接口。仅通过当前浏览器工具操作网站 UI，不读取 Cookie、不调用私有发布接口。

```js
import { prepareVolumePlan, publishVolumes } from './scripts/volume-publishing.mjs';

// ui 和 journal 由执行方提供；ID、卷名与范围来自现场和作者方案。
const ranges = [
  { volumeId: firstVolumeId, volumeTitle: '第一卷 开局', from: 1, to: 30 },
  { volumeId: secondVolumeId, volumeTitle: '第二卷 入城', from: 31, to: 60 },
];
const plan = await prepareVolumePlan(ui, bookId, ranges);
// 先持久保存 plan 并核对授权。aiUsed 必须依据本批稿件的真实创作过程。
const result = await publishVolumes(ui, plan, { moveDrafts: true, aiUsed }, journal);
```

`moveDrafts:true` 只能在用户已授权按此计划调整草稿所属卷时传入，字段本身不构成授权。`aiUsed` 必须是明确的布尔值；不同章节使用事实不一致时按事实拆成不同计划。`result` 是逐章处理时状态；最终状态以 `volumes-verified` 事件中的实时核对结果为准。示例不创建后台连接，也不启动实际发布。

## 浏览器适配器约定

| 方法 | 返回或要求 |
| --- | --- |
| `snapshot()` | `{bookId,bookTitle,complete:true,coverage:{chapters:true,drafts:true,volumes:true},chapters:[{id,number,title,body,status,location,volumeId}],volumes:[{id,title}]}`。必须读完相关全部列表及完整正文才置真。`number` 为数值章号，状态为 `draft/reviewing/published`，位置为 `drafts/chapters`；未知状态不能强行映射。 |
| `openAssignVolume(chapter,target)` | 依据当前 UI 打开归卷控件并选中目标，另读结果，返回 `{kind:'assign-volume',bookId,chapterId,volumeId,volumeTitle,understood:true}`。未知提示不能设置 `understood:true`。 |
| `confirmAssignVolume(dialog)` | 再核对当前章节、卷和表单，依当前工具要求确认一次，等待操作结束；无内部重试。 |
| `openPublish(chapter,target,aiUsed)` | 核对编辑页全文、所属卷及实际发布设置，处理已识别提示，选择并另读 AI 状态；返回 `{kind:'publish',bookId,chapterId,number,title,body,volumeId,volumeTitle,aiUsed,aiChecked:true,understood:true,...}`。这些字段必须来自页面读取，不能从参数直接复制作为验证。 |
| `confirmPublish(dialog)` | 再读当前目标身份、卷和发布设置，确保仍与核对结果一致；依当前工具确认规则点击一次，等待结束，不自动重试。 |
| `journal(event)` | 将完整计划、正文基线、操作意图和回执持久落盘后才返回。写入失败应抛错，不能仅存于内存。 |

`target` 为 `{volumeId,volumeTitle}`。发布方式及定时值由适配器按本次授权配置、核对并写入回执；代码不默认授权立即发布，也不凭参数猜测平台控件。调用者须单执行者串行运行。`snapshot()` 不能离开未保存的编辑表单导致设置丢失，可使用同一浏览器中代理自己的只读列表页；确认前由适配器重新检查实际表单，不能信任旧对象。

恢复时先解决未完成意图的实时状态，确认无旧调用仍在运行，才可用同一计划重新核对剩余任务。脚本会重新读取稿件及卷，已成功提交的章跳过；正文或标题变化则停止。核对与点击之间仍可能发生人为修改，不能用模拟测试宣称消除了这种竞态。

从技能目录运行：`node --test tests/*.test.mjs`。测试覆盖范围、错卷、授权、正文变动、AI 选中状态、回执、日志失败及超时恢复；模拟通过不代表已在真实平台验证归卷或发布。
