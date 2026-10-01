import { useRef, useState } from 'react';

type ImportError = { row: number; field: string; message: string };
type Row = { id?: string; axis: string; index: number; x: number; y: number; kind: string; severity: string; diameter: number; note?: string };
type Payload = { format?: string; version?: number; scanId?: string; exportedAt?: string; annotations?: Row[] };
type Feedback = { ok: boolean; message: string };

const AXIS_LABEL: Record<string, string> = { axial: '轴向', coronal: '冠状', sagittal: '矢状' };

export default function ImportExport({ scanId, onImported }: { scanId?: string; onImported: () => void }) {
  const [fileName, setFileName] = useState('');
  const [payload, setPayload] = useState<Payload | null>(null);
  const [batchId, setBatchId] = useState('');
  const [parseError, setParseError] = useState('');
  const [errors, setErrors] = useState<ImportError[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const download = async () => {
    const data = await fetch('/api/annotations/export').then(r => r.json());
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `annotations-${data.scanId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pick = async (file: File) => {
    setPayload(null); setErrors([]); setFeedback(null); setParseError('');
    setFileName(file.name);
    setBatchId(crypto.randomUUID());
    try {
      const parsed = JSON.parse(await file.text()) as Payload;
      if (!parsed || !Array.isArray(parsed.annotations)) { setParseError('文件结构不完整：缺少 annotations 数组，请使用本系统导出的标注文件'); return; }
      setPayload(parsed);
    } catch { setParseError('文件不是合法的 JSON，无法解析'); }
  };

  const submit = async () => {
    if (!payload || busy) return;
    setBusy(true); setErrors([]); setFeedback(null);
    try {
      const res = await fetch('/api/annotations/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ batchId, scanId: payload.scanId, annotations: payload.annotations }) });
      const data = await res.json();
      if (data.ok) {
        setFeedback({ ok: true, message: `成功导入 ${data.imported} 条缺陷标注（${(data.ids as string[]).slice(0, 6).join('、')}${data.imported > 6 ? ' …' : ''}）${data.duplicate ? '，本次为重复提交，已按批次去重' : ''}` });
        setPayload(null); setFileName('');
        onImported();
      } else {
        setErrors(data.errors ?? [{ row: 0, field: 'file', message: data.error ?? '导入失败' }]);
        setFeedback({ ok: false, message: `校验未通过：${(data.errors ?? []).length || 1} 处问题，整批未写入，请修正文件后重新导入` });
      }
    } catch { setFeedback({ ok: false, message: '网络错误，导入未完成；导入采用原子写入，失败不会留下半批数据，可直接重新提交' }); }
    finally { setBusy(false); }
  };

  const rows = payload?.annotations ?? [];
  const mismatch = !!payload && payload.scanId !== scanId;

  return <div className="transfer">
    <div className="transfer-card">
      <small>EXPORT / 交接带出</small>
      <h3>导出当前标注</h3>
      <p>将当前扫描的全部缺陷标注导出为 JSON 文件，包含扫描标识、平面、切片、坐标、类型、严重度、尺寸与备注。导出的文件可在现场交接后重新导入本系统。</p>
      <button onClick={download}>导出标注文件</button>
    </div>
    <div className="transfer-card">
      <small>IMPORT / 外部发现带入</small>
      <h3>导入标注文件</h3>
      <p>导入前整批校验扫描标识、字段合法性与 ID 冲突；全部通过后一次原子写入，任一记录有问题则整批拒绝，不会留下半批数据。</p>
      <div className="file-pick">
        <button onClick={() => fileInput.current?.click()}>选择文件</button>
        <input ref={fileInput} type="file" accept="application/json,.json" onChange={e => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }} />
        <span className="file-name">{fileName || '未选择文件'}</span>
      </div>
      {parseError && <div className="import-result fail">{parseError}</div>}
    </div>
    {payload && <div className="transfer-card wide">
      <small>PREVIEW / 导入预览</small>
      <h3>{fileName} · {rows.length} 条记录</h3>
      <p>扫描标识 {payload.scanId ?? '缺失'} · 格式版本 {payload.version ?? '—'} · 导出于 {payload.exportedAt ?? '—'}</p>
      {mismatch && <div className="scan-warn">扫描标识不匹配：文件属于 {payload.scanId ?? '未知扫描'}，当前扫描为 {scanId}，提交将被拒绝。</div>}
      <table className="preview">
        <thead><tr><th>#</th><th>ID</th><th>平面</th><th>切片</th><th>坐标</th><th>类型</th><th>严重度</th><th>尺寸</th><th>备注</th></tr></thead>
        <tbody>{rows.slice(0, 8).map((r, i) => <tr key={i}><td>{i + 1}</td><td>{r.id ?? '自动分配'}</td><td>{AXIS_LABEL[r.axis] ?? r.axis}</td><td>{r.index}</td><td>({r.x}, {r.y})</td><td>{r.kind}</td><td>{r.severity}</td><td>Ø {r.diameter} mm</td><td>{r.note || '—'}</td></tr>)}</tbody>
      </table>
      {rows.length > 8 && <p>… 其余 {rows.length - 8} 条记录将在导入时一并校验</p>}
      <button className="import-submit" disabled={busy} onClick={submit}>{busy ? '导入中…' : `确认导入 ${rows.length} 条记录`}</button>
    </div>}
    {feedback && <div className={`transfer-card wide import-result ${feedback.ok ? 'ok' : 'fail'}`}>{feedback.message}</div>}
    {errors.length > 0 && <div className="transfer-card wide">
      <small>ERROR LOCATIONS / 错误定位</small>
      <h3>{errors.length} 处问题（整批未写入）</h3>
      <div className="error-list">{errors.map((e, i) => <div className="error-item" key={i}><b>{e.row ? `第 ${e.row} 行` : '文件级'}</b><span>{e.field} · {e.message}</span></div>)}</div>
    </div>}
  </div>;
}
