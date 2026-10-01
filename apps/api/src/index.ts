import Fastify from 'fastify';
import cors from '@fastify/cors';
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

type ReviewStatus = 'unreviewed' | 'in_review' | 'accepted' | 'rejected';
type Annotation = { id: string; axis: string; index: number; x: number; y: number; kind: string; severity: string; note: string; diameter: number; confidence: number; reviewStatus: ReviewStatus; reviewer?: string; createdAt: string };
const scan = { id: 'valve-housing-017', part: '液压阀体 / VH-017', material: 'AlSi10Mg', resolution: '42 μm', dimensions: '128 × 128 × 96 voxels', operator: '张工', acquiredAt: '2026-09-30 08:42', scanner: 'Phoenix v|tome|x M 300', lot: 'LOT-2026-09-A17', standard: 'ASTM E1441' };
let annotations: Annotation[] = [
  { id: 'D-024', axis: 'axial', index: 42, x: 57, y: 39, kind: '孔隙', severity: '中', note: '疑似缩孔，建议复核', diameter: 1.86, confidence: .91, reviewStatus: 'in_review', reviewer: '王工', createdAt: '2026-09-30T09:12:00.000Z' },
  { id: 'D-031', axis: 'coronal', index: 37, x: 31, y: 61, kind: '夹杂', severity: '低', note: '边缘夹杂', diameter: .72, confidence: .74, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:18:00.000Z' },
  { id: 'D-044', axis: 'sagittal', index: 51, x: 64, y: 47, kind: '裂纹', severity: '高', note: '线性高密度异常，需二次扫描确认', diameter: 3.42, confidence: .68, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:27:00.000Z' }
];
let idCounter = 44;
const allocateId = () => { let id: string; do { id = `D-${String(++idCounter).padStart(3, '0')}`; } while (annotations.some(item => item.id === id)); return id; };
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
app.post('/api/annotations', async (request) => { const body = request.body as Omit<Annotation, 'id' | 'createdAt' | 'confidence' | 'reviewStatus'>; const item: Annotation = { ...body, id: allocateId(), confidence: +(0.62 + Math.random() * .34).toFixed(2), reviewStatus: 'unreviewed', createdAt: new Date().toISOString() }; annotations = [item, ...annotations]; return item; });
app.post('/api/annotations/:id/review', async (request) => { const id = (request.params as { id: string }).id; const body = request.body as { status: ReviewStatus; reviewer?: string; note?: string }; const item = annotations.find(annotation => annotation.id === id); if (!item) return { ok: false, error: 'annotation_not_found' }; item.reviewStatus = body.status; item.reviewer = body.reviewer ?? '王工'; if (body.note) item.note = body.note; return item; });
app.delete('/api/annotations/:id', async (request) => { const id = (request.params as { id: string }).id; annotations = annotations.filter(item => item.id !== id); return { ok: true }; });
const AXES = ['axial', 'coronal', 'sagittal'];
const KINDS = ['孔隙', '裂纹', '夹杂', '未熔合'];
const SEVERITIES = ['低', '中', '高'];
const MAX_IMPORT_RECORDS = 2000;
const importBatches = new Map<string, Record<string, unknown>>();
app.get('/api/annotations/export', async () => ({ format: 'ct-annotation-export', version: 1, scanId: scan.id, exportedAt: new Date().toISOString(), count: annotations.length, annotations: annotations.map(item => ({ id: item.id, axis: item.axis, index: item.index, x: item.x, y: item.y, kind: item.kind, severity: item.severity, diameter: item.diameter, note: item.note })) }));
app.post('/api/annotations/import', async (request, reply) => {
  const body = request.body as { batchId?: string; scanId?: string; annotations?: unknown[] } | null;
  const batchId = typeof body?.batchId === 'string' && body.batchId ? body.batchId : undefined;
  if (batchId && importBatches.has(batchId)) return { ...importBatches.get(batchId), duplicate: true };
  const finish = (status: number, result: Record<string, unknown>) => { if (batchId) { if (importBatches.size >= 200) importBatches.delete(importBatches.keys().next().value as string); importBatches.set(batchId, result); } return reply.code(status).send(result); };
  if (!body || !Array.isArray(body.annotations)) return finish(400, { ok: false, error: 'invalid_file', imported: 0, errors: [{ row: 0, field: 'file', message: '文件结构不完整：缺少 annotations 数组，请使用本系统导出的文件' }] });
  if (body.scanId !== scan.id) return finish(409, { ok: false, error: 'scan_mismatch', imported: 0, errors: [{ row: 0, field: 'scanId', message: `扫描标识不匹配：文件属于 ${body.scanId ?? '未知扫描'}，当前扫描为 ${scan.id}` }] });
  if (body.annotations.length === 0) return finish(400, { ok: false, error: 'empty_file', imported: 0, errors: [{ row: 0, field: 'annotations', message: '文件不包含任何标注记录' }] });
  if (body.annotations.length > MAX_IMPORT_RECORDS) return finish(413, { ok: false, error: 'too_many_records', imported: 0, errors: [{ row: 0, field: 'annotations', message: `记录数 ${body.annotations.length} 超过单批上限 ${MAX_IMPORT_RECORDS}，请拆分文件后分批导入` }] });
  const errors: { row: number; field: string; message: string }[] = [];
  const seen = new Set<string>();
  const existing = new Set(annotations.map(item => item.id));
  body.annotations.forEach((raw, i) => {
    const row = i + 1;
    const record = raw as Record<string, unknown> | null;
    const fail = (field: string, message: string) => errors.push({ row, field, message });
    if (!record || typeof record !== 'object' || Array.isArray(record)) { fail('record', '记录不是合法的对象'); return; }
    const { id, axis, index, x, y, kind, severity, diameter, note } = record as Record<string, any>;
    if (id !== undefined) { if (typeof id !== 'string' || !/^D-\d{3,}$/.test(id)) fail('id', `ID「${String(id)}」格式非法，应为 D-数字（如 D-052）`); else if (existing.has(id)) fail('id', `ID ${id} 与现有标注冲突`); else if (seen.has(id)) fail('id', `ID ${id} 在文件内重复`); else seen.add(id); }
    if (!AXES.includes(axis)) fail('axis', `平面「${String(axis)}」非法，应为 axial / coronal / sagittal`);
    if (!Number.isInteger(index) || index < 0 || index > 95) fail('index', `切片序号「${String(index)}」非法，应为 0–95 的整数`);
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 96) fail('x', `X 坐标「${String(x)}」非法，应为 0–96 的数值`);
    if (typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 96) fail('y', `Y 坐标「${String(y)}」非法，应为 0–96 的数值`);
    if (!KINDS.includes(kind)) fail('kind', `缺陷类型「${String(kind)}」非法，应为 ${KINDS.join(' / ')}`);
    if (!SEVERITIES.includes(severity)) fail('severity', `严重度「${String(severity)}」非法，应为 低 / 中 / 高`);
    if (typeof diameter !== 'number' || !Number.isFinite(diameter) || diameter <= 0 || diameter > 50) fail('diameter', `尺寸「${String(diameter)}」非法，应为 0–50 mm 的数值`);
    if (note !== undefined && (typeof note !== 'string' || note.length > 200)) fail('note', '备注应为不超过 200 字的文本');
  });
  if (errors.length) return finish(400, { ok: false, error: 'validation_failed', imported: 0, errors });
  const created: Annotation[] = (body.annotations as Record<string, any>[]).map(record => ({ id: record.id ?? allocateId(), axis: record.axis, index: record.index, x: record.x, y: record.y, kind: record.kind, severity: record.severity, note: record.note ?? '', diameter: record.diameter, confidence: +(0.62 + Math.random() * .34).toFixed(2), reviewStatus: 'unreviewed', createdAt: new Date().toISOString() }));
  annotations = [...created, ...annotations];
  return finish(200, { ok: true, imported: created.length, ids: created.map(item => item.id) });
});
app.get('/api/measurements', async () => annotations.map(item => ({ annotationId: item.id, diameter: item.diameter, estimatedVolume: +(4 / 3 * Math.PI * (item.diameter / 2) ** 3).toFixed(2), aspectRatio: +(1.1 + item.diameter * .24).toFixed(2), tolerance: item.diameter > 2 ? '超出工艺关注阈值' : '在监控范围内' })));
app.get('/api/compare', async () => ({ current: { scanId: scan.id, label: 'VH-017 / 本次扫描', defectCount: annotations.length, highRisk: annotations.filter(item => item.severity === '高').length }, previous: { scanId: 'valve-housing-016', label: 'VH-016 / 上一炉次', defectCount: 2, highRisk: 0 }, delta: { defectCount: annotations.length - 2, highRisk: annotations.filter(item => item.severity === '高').length } }));
app.get('/api/report', async () => ({ scan, workflow, summary: stats(), annotations, releaseGate: annotations.some(item => item.severity === '高' && item.reviewStatus !== 'accepted') ? 'blocked' : 'ready' }));
await app.listen({ port: 6182, host: '127.0.0.1' });
