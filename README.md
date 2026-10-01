# 工业 CT 无损检测工作台

React + Vite + TypeScript 前端与 Fastify + TypeScript API 的全栈工业 CT 阅片、标注和复核演示项目。

## 功能
- 轴向、冠状、矢状三正交切片联动阅片
- 可调窗宽、窗位与切片序号
- 孔隙、裂纹、夹杂和未熔合缺陷标注
- API 持久于进程内的标注流、删除、汇总报告
- 缺陷尺寸、严重度、复核意见和检测摘要
- 标注交接文件导入 / 导出（“数据交接”页签）

## 标注交接文件

现场交接时，可将外部发现的缺陷整批带入当前扫描，无需逐个点击切片。

**文件格式**（JSON，导出文件可直接重新导入）：
```json
{
  "format": "ct-annotation-batch",
  "version": 1,
  "batchId": "B-…",
  "scanId": "valve-housing-017",
  "exportedAt": "2026-10-01T08:00:00.000Z",
  "annotations": [
    { "id": "D-024", "axis": "axial", "index": 42, "x": 57, "y": 39,
      "kind": "孔隙", "severity": "中", "diameter": 1.86, "note": "疑似缩孔" }
  ]
}
```

**接口**
- `GET /api/annotations/export` — 导出当前扫描全部标注为交接文件（带 `batchId` 幂等键）
- `POST /api/annotations/import` — 导入交接文件；可选 `onConflict: "regenerate"` 在 ID 冲突时自动重新分配

**设计决策：原子批量写入（而非逐条容错）**
1. 先校验文件头（格式版本、扫描标识匹配、批量上限 2000 条），再逐条校验字段合法性与 ID 冲突（含文件内重复），全部通过才一次同步写入；任何一条不合法都整批拒绝（HTTP 422），不会留下半批数据。
2. 部分坏记录：错误报告按行号 + 字段定位全部问题，修复后整体重传即可。
3. 重复提交：以 `batchId`（缺失时取内容哈希）+ 冲突策略作为幂等键，重投或网络重试直接回放首次结果，不重复写入；前端同时在导入期间禁用提交按钮。
4. 大批量失败恢复：原子写保证失败零残留，可安全修复重试；超限批次在文件头阶段即被拒绝并提示拆分。

## 启动
```bash
npm install
npm run dev
```
网页：`http://localhost:5182`；API：`http://localhost:6182`。
