import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createHash } from 'node:crypto';
const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });
await app.register(cors, { origin: true });

type ReviewStatus = 'unreviewed' | 'in_review' | 'accepted' | 'rejected';
type Annotation = { id: string; axis: string; index: number; x: number; y: number; kind: string; severity: string; note: string; diameter: number; confidence: number; reviewStatus: ReviewStatus; reviewer?: string; createdAt: string };
const scan = { id: 'valve-housing-017', part: '液压阀体 / VH-017', material: 'AlSi10Mg', resolution: '42 μm', dimensions: '128 × 128 × 96 voxels', operator: '张工', acquiredAt: '2026-09-30 08:42', scanner: 'Phoenix v|tome|x M 300', lot: 'LOT-2026-09-A17', standard: 'ASTM E1441' };
// ---- 标注交接文件（导入 / 导出）----
// 决策：原子批量写入，而非逐条容错。整批校验全部通过才一次性提交；任何一条不合法
// 都整批拒绝、不留下半批数据。坏记录通过行级错误报告定位，修复后整体重传；
// 幂等键（batchId 或内容哈希）保证重传与网络重试不会产生重复标注。
const IMPORT_FORMAT = 'ct-annotation-batch';
const IMPORT_VERSION = 1;
const MAX_BATCH = 2000;
const AXES = ['axial', 'coronal', 'sagittal'];
const KINDS = ['孔隙', '裂纹', '夹杂', '未熔合'];
const SEVERITIES = ['低', '中', '高'];
type ImportError = { row: number; field: string; message: string; value?: unknown };
const importedBatches = new Map<string, { imported: number; ids: string[]; at: string }>();
function nextAnnotationId(taken: Set<string>) { let max = 0; for (const id of taken) { const match = /^D-(\d+)$/.exec(id); if (match) max = Math.max(max, +match[1]); } let id = ''; do { id = `D-${String(++max).padStart(3, '0')}`; } while (taken.has(id)); taken.add(id); return id; }
let annotations: Annotation[] = [
  { id: 'D-024', axis: 'axial', index: 42, x: 57, y: 39, kind: '孔隙', severity: '中', note: '疑似缩孔，建议复核', diameter: 1.86, confidence: .91, reviewStatus: 'in_review', reviewer: '王工', createdAt: '2026-09-30T09:12:00.000Z' },
  { id: 'D-031', axis: 'coronal', index: 37, x: 31, y: 61, kind: '夹杂', severity: '低', note: '边缘夹杂', diameter: .72, confidence: .74, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:18:00.000Z' },
  { id: 'D-044', axis: 'sagittal', index: 51, x: 64, y: 47, kind: '裂纹', severity: '高', note: '线性高密度异常，需二次扫描确认', diameter: 3.42, confidence: .68, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:27:00.000Z' }
];
const workflow = [
  { id: 'ingest', label: '数据接收', status: 'done', owner: '系统', detail: '原始 DICOM 序列已校验' },
  { id: 'reconstruct', label: '体数据重建', status: 'done', owner: '算法服务', detail: '96 层切片已生成' },
  { id: 'primary', label: '初检标注', status: 'active', owner: '张工', detail: '存在 3 个候选缺陷' },
  { id: 'review', label: '二次复核', status: 'pending', owner: '王工', detail: '等待高风险裂纹复核' },
  { id: 'release', label: '报告签发', status: 'pending', owner: '质量负责人', detail: '需完成复核与判定' }
];
function slice(axis: string, index: number) { const size = 96; const data: number[][] = []; for (let y = 0; y < size; y++) { const row: number[] = []; for (let x = 0; x < size; x++) { const dx = x - 48, dy = y - 48; const shell = Math.sqrt(dx * dx + dy * dy); let value = 12 + Math.max(0, 1 - Math.abs(shell - 31) / 9) * 130 + Math.max(0, 1 - Math.abs(shell - 14) / 5) * 48; value += 16 * Math.sin((x + index) * .17) * Math.cos((y - index) * .12); const hole = (x - (57 + Math.sin(index * .15) * 4)) ** 2 + (y - (39 + Math.cos(index * .1) * 3)) ** 2; if (hole < 28 + (index - 42) ** 2 * .7) value = 8; const inclusion = (x - 30) ** 2 + (y - 61) ** 2; if (inclusion < 13 && axis !== 'sagittal') value = 220; row.push(Math.max(0, Math.min(255, Math.round(value)))); } data.push(row); } return { axis, index, size, data }; }
function stats() { return { defectCount: annotations.length, criticalCount: annotations.filter(item => item.severity === '高').length, unreviewedCount: annotations.filter(item => item.reviewStatus !== 'accepted' && item.reviewStatus !== 'rejected').length, totalVolume: +annotations.reduce((sum, item) => sum + 4 / 3 * Math.PI * (item.diameter / 2) ** 3, 0).toFixed(2), byKind: Object.entries(annotations.reduce<Record<string, number>>((out, item) => { out[item.kind] = (out[item.kind] ?? 0) + 1; return out; }, {})).map(([kind, count]) => ({ kind, count })) }; }
app.get('/api/health', async () => ({ status: 'ok', service: 'ct-inspection-workbench', version: '0.8.0' }));
app.get('/api/scans/current', async () => scan);
app.get('/api/scans/current/slice', async (request) => { const query = request.query as { axis?: string; index?: string }; return slice(query.axis ?? 'axial', Math.max(0, Math.min(95, Number(query.index ?? 42)))); });
app.get('/api/workflow', async () => workflow);
app.get('/api/annotations', async () => annotations);
app.post('/api/annotations', async (request) => { const body = request.body as Omit<Annotation, 'id' | 'createdAt' | 'confidence' | 'reviewStatus'>; const item: Annotation = { ...body, id: nextAnnotationId(new Set(annotations.map(annotation => annotation.id))), confidence: +(0.62 + Math.random() * .34).toFixed(2), reviewStatus: 'unreviewed', createdAt: new Date().toISOString() }; annotations = [item, ...annotations]; return item; });
app.get('/api/annotations/export', async (_request, reply) => { const payload = { format: IMPORT_FORMAT, version: IMPORT_VERSION, batchId: `B-${Date.now().toString(36)}-${createHash('sha256').update(annotations.map(item => item.id).join('|')).digest('hex').slice(0, 8)}`, scanId: scan.id, exportedAt: new Date().toISOString(), annotations: annotations.map(({ id, axis, index, x, y, kind, severity, diameter, note }) => ({ id, axis, index, x, y, kind, severity, diameter, note })) }; reply.header('content-disposition', `attachment; filename="annotations-${scan.id}.json"`); return payload; });
app.post('/api/annotations/import', async (request, reply) => {
  const raw = request.body as unknown;
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!body) return reply.code(400).send({ ok: false, stage: 'envelope', errors: [{ row: 0, field: 'file', message: '请求体不是合法的交接文件 JSON 对象' }] });
  const strategy = body.onConflict === 'regenerate' ? 'regenerate' : 'fail';
  // 1) 文件头校验：格式版本、扫描标识、记录集合规模
  const errors: ImportError[] = [];
  if (body.format !== IMPORT_FORMAT || body.version !== IMPORT_VERSION) errors.push({ row: 0, field: 'format', message: `文件格式不受支持，需要 ${IMPORT_FORMAT} v${IMPORT_VERSION}`, value: body.format });
  if (typeof body.scanId !== 'string' || !body.scanId) errors.push({ row: 0, field: 'scanId', message: '缺少扫描标识 scanId' });
  else if (body.scanId !== scan.id) errors.push({ row: 0, field: 'scanId', message: `扫描不匹配：文件属于 ${body.scanId}，当前扫描为 ${scan.id}`, value: body.scanId });
  const records = body.annotations;
  if (!Array.isArray(records) || records.length === 0) errors.push({ row: 0, field: 'annotations', message: 'annotations 必须是非空数组' });
  else if (records.length > MAX_BATCH) errors.push({ row: 0, field: 'annotations', message: `单批最多 ${MAX_BATCH} 条（当前 ${records.length} 条），请拆分后分批导入`, value: records.length });
  if (errors.length) return reply.code(422).send({ ok: false, stage: 'envelope', errors });
  const list = records as Record<string, unknown>[];
  // 2) 幂等：同一批次（batchId + 冲突策略）已成功导入过 → 回放首次结果，不重复写入
  const batchId = typeof body.batchId === 'string' && body.batchId ? body.batchId : `sha256:${createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 16)}`;
  const ledgerKey = `${batchId}@${strategy}`;
  const seen = importedBatches.get(ledgerKey);
  if (seen) return { ok: true, duplicate: true, batchId, imported: seen.imported, ids: seen.ids, message: '该批次已导入，本次为重复提交，未重复写入' };
  // 3) 逐条校验：收集全部错误（不遇错即停），任何一条失败都整批拒绝
  const existingIds = new Set(annotations.map(item => item.id));
  const fileIds = new Set<string>();
  list.forEach((record, i) => {
    const row = i + 1;
    if (!record || typeof record !== 'object' || Array.isArray(record)) { errors.push({ row, field: 'record', message: '记录必须是 JSON 对象' }); return; }
    const { id, axis, index, x, y, kind, severity, diameter, note } = record;
    if (id !== undefined) {
      if (typeof id !== 'string' || !/^[\w-]{1,32}$/.test(id)) errors.push({ row, field: 'id', message: 'ID 须为 1–32 位字母、数字、下划线或连字符', value: id });
      else if (strategy === 'fail' && existingIds.has(id)) errors.push({ row, field: 'id', message: `ID 与现有标注 ${id} 冲突`, value: id });
      else if (strategy === 'fail' && fileIds.has(id)) errors.push({ row, field: 'id', message: `ID ${id} 在文件内重复`, value: id });
      else fileIds.add(id);
    }
    if (typeof axis !== 'string' || !AXES.includes(axis)) errors.push({ row, field: 'axis', message: `平面须为 ${AXES.join(' / ')}`, value: axis });
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 95) errors.push({ row, field: 'index', message: '切片序号须为 0–95 的整数', value: index });
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 96) errors.push({ row, field: 'x', message: 'X 坐标须为 0–96 的数值', value: x });
    if (typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 96) errors.push({ row, field: 'y', message: 'Y 坐标须为 0–96 的数值', value: y });
    if (typeof kind !== 'string' || !KINDS.includes(kind)) errors.push({ row, field: 'kind', message: `类型须为 ${KINDS.join(' / ')}`, value: kind });
    if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) errors.push({ row, field: 'severity', message: `严重度须为 ${SEVERITIES.join(' / ')}`, value: severity });
    if (typeof diameter !== 'number' || !Number.isFinite(diameter) || diameter < 0.05 || diameter > 50) errors.push({ row, field: 'diameter', message: '尺寸（直径 mm）须为 0.05–50 的数值', value: diameter });
    if (note !== undefined && (typeof note !== 'string' || note.length > 200)) errors.push({ row, field: 'note', message: '备注须为不超过 200 字的文本', value: typeof note === 'string' ? `${note.slice(0, 40)}…` : note });
  });
  if (errors.length) return reply.code(422).send({ ok: false, stage: 'records', rejected: list.length, errors });
  // 4) 原子提交：全部校验通过，一次同步写入，不存在半批数据
  const taken = new Set(existingIds);
  const now = new Date().toISOString();
  const committed: Annotation[] = list.map(record => {
    const wanted = typeof record.id === 'string' ? record.id : undefined;
    const id = wanted && !taken.has(wanted) ? (taken.add(wanted), wanted) : nextAnnotationId(taken);
    return { id, axis: record.axis as string, index: record.index as number, x: +(record.x as number).toFixed(1), y: +(record.y as number).toFixed(1), kind: record.kind as string, severity: record.severity as string, note: typeof record.note === 'string' ? record.note : '', diameter: +(record.diameter as number).toFixed(2), confidence: 1, reviewStatus: 'unreviewed', createdAt: now };
  });
  annotations = [...committed, ...annotations];
  importedBatches.set(ledgerKey, { imported: committed.length, ids: committed.map(item => item.id), at: now });
  const reassigned = committed.filter((item, i) => typeof list[i].id === 'string' && list[i].id !== item.id).length;
  return { ok: true, duplicate: false, batchId, imported: committed.length, reassigned, ids: committed.map(item => item.id) };
});
app.post('/api/annotations/:id/review', async (request) => { const id = (request.params as { id: string }).id; const body = request.body as { status: ReviewStatus; reviewer?: string; note?: string }; const item = annotations.find(annotation => annotation.id === id); if (!item) return { ok: false, error: 'annotation_not_found' }; item.reviewStatus = body.status; item.reviewer = body.reviewer ?? '王工'; if (body.note) item.note = body.note; return item; });
app.delete('/api/annotations/:id', async (request) => { const id = (request.params as { id: string }).id; annotations = annotations.filter(item => item.id !== id); return { ok: true }; });
app.get('/api/measurements', async () => annotations.map(item => ({ annotationId: item.id, diameter: item.diameter, estimatedVolume: +(4 / 3 * Math.PI * (item.diameter / 2) ** 3).toFixed(2), aspectRatio: +(1.1 + item.diameter * .24).toFixed(2), tolerance: item.diameter > 2 ? '超出工艺关注阈值' : '在监控范围内' })));
app.get('/api/compare', async () => ({ current: { scanId: scan.id, label: 'VH-017 / 本次扫描', defectCount: annotations.length, highRisk: annotations.filter(item => item.severity === '高').length }, previous: { scanId: 'valve-housing-016', label: 'VH-016 / 上一炉次', defectCount: 2, highRisk: 0 }, delta: { defectCount: annotations.length - 2, highRisk: annotations.filter(item => item.severity === '高').length } }));
app.get('/api/report', async () => ({ scan, workflow, summary: stats(), annotations, releaseGate: annotations.some(item => item.severity === '高' && item.reviewStatus !== 'accepted') ? 'blocked' : 'ready' }));
await app.listen({ port: 6182, host: '127.0.0.1' });
