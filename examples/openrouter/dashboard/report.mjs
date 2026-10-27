#!/usr/bin/env node
// Renders a standalone, self-contained HTML report of the OpenRouter setup.
//
//   node examples/openrouter/dashboard/report.mjs [out.html]
//
// No server, no network: it reads the same config the dashboard reads (settings
// file, key file, expiry metadata) plus the bundled free-model snapshot, and
// bakes everything into one file that opens anywhere — useful when the preview
// proxy is unavailable. The key is masked; the full key is never written.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(HERE, 'report.html');

const CONF_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'openrouter')
  : path.join(process.env.HOME || '.', '.config', 'openrouter');
const KEY_FILE = process.env.OPENROUTER_KEY_FILE || path.join(CONF_DIR, 'api_key');
const META_FILE = process.env.OPENROUTER_META_FILE || path.join(CONF_DIR, 'key_meta.json');
const SETTINGS_FILE = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '.', '.claude'), 'settings.json');

const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
const readJson = (f) => {
  try {
    return JSON.parse(read(f));
  } catch {
    return null;
  }
};
const mask = (k) => (!k ? null : k.length <= 16 ? `${k.slice(0, 6)}…` : `${k.slice(0, 12)}…${k.slice(-4)}`);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const settings = readJson(SETTINGS_FILE) || {};
const env = settings.env || {};
const key = read(KEY_FILE).trim() || env.ANTHROPIC_AUTH_TOKEN || '';
const meta = readJson(META_FILE) || {};
const free = readJson(path.join(HERE, 'free-models.snapshot.json')) || [];

const models = {
  opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  fable: env.ANTHROPIC_DEFAULT_FABLE_MODEL,
  subagent: env.CLAUDE_CODE_SUBAGENT_MODEL,
};
const bare = (id) => String(id || '').replace(/\[1m\]$/i, '').replace(/^~/, '');
const all = Object.values(models).filter(Boolean).map(bare);
const freeOnly = all.length > 0 && all.every((m) => /:free$|^openrouter\/free$/.test(m));

const checks = [
  ['ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL || '—', env.ANTHROPIC_BASE_URL === 'https://openrouter.ai/api'],
  ['ANTHROPIC_AUTH_TOKEN', mask(env.ANTHROPIC_AUTH_TOKEN) || '—', String(env.ANTHROPIC_AUTH_TOKEN || '').startsWith('sk-or-')],
  ['ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY === '' ? '"" (فاضي كما يجب)' : env.ANTHROPIC_API_KEY === undefined ? 'غير موجود ✗' : env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY === ''],
  ['الموديلات', freeOnly ? 'كلها :free' : 'فيها موديل مدفوع', freeOnly],
  ['model discovery', env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? 'غير محدد', freeOnly ? env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === '0' : true],
  ['nonessential traffic', env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1' ? 'متوقف (يوفّر الكوتا)' : 'شغال', true],
];

const rows = free
  .map(
    (m) => `<tr>
      <td><code>${esc(m.id)}</code>${m.name ? `<div class="muted">${esc(m.name)}</div>` : ''}${m.expires ? `<div class="muted">ينتهي ${esc(m.expires)}</div>` : ''}</td>
      <td class="num">${m.context ? (m.context / 1000).toFixed(0) + 'k' : '—'}</td>
      <td class="${m.tools ? 'yes' : 'no'}">${m.tools ? '✓' : '✗'}</td>
      <td class="${m.vision ? 'yes' : 'no'}">${m.vision ? '✓' : '✗'}</td>
    </tr>`,
  )
  .join('');

const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>تقرير OpenRouter × Claude Code</title>
<style>
  :root{--bg:#0b0d10;--panel:#12161b;--panel2:#171c23;--line:#232b35;--text:#e6edf3;--muted:#8b98a5;--accent:#7aa2f7;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;padding:24px clamp(14px,4vw,40px) 44px;background:radial-gradient(1200px 600px at 80% -10%,#16202c 0%,var(--bg) 55%);color:var(--text);font:15px/1.65 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;min-height:100vh}
  h1{font-size:20px;margin:0}
  h2{font-size:14px;margin:0 0 14px}
  .top{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:18px}
  .pill{font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid rgba(63,185,80,.35);background:rgba(63,185,80,.08);color:var(--ok)}
  .pill.bad{color:var(--bad);border-color:rgba(248,81,73,.35);background:rgba(248,81,73,.08)}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));align-items:start}
  .card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:14px;padding:18px}
  .span2{grid-column:span 2}@media(max-width:900px){.span2{grid-column:span 1}}
  .stat-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
  .stat{flex:1 1 170px;background:#0e1216;border:1px solid var(--line);border-radius:10px;padding:10px 12px}
  .stat .label{display:block;font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
  .mono,code,pre{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
  ul.checks{list-style:none;margin:0;padding:0;display:grid;gap:6px}
  ul.checks li{display:flex;gap:10px;align-items:baseline;font-size:13px;padding:7px 10px;border-radius:8px;background:#0e1216;border:1px solid transparent}
  ul.checks li.ok{border-color:rgba(63,185,80,.18)}ul.checks li.ok b{color:var(--ok)}
  ul.checks li.bad{border-color:rgba(248,81,73,.24)}ul.checks li.bad b{color:var(--bad)}
  ul.checks li span.val{margin-inline-start:auto;color:var(--muted);font-family:var(--mono);font-size:11.5px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:start;color:var(--muted);font-weight:500;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;position:sticky;top:0;background:var(--panel2)}
  td{padding:7px 8px;border-top:1px solid var(--line)}
  td.num{text-align:end;font-family:var(--mono)}
  .table-wrap{max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:10px}
  .yes{color:var(--ok)}.no{color:var(--muted)}.muted{color:var(--muted)}
  .models td:first-child{color:var(--muted);font-size:12px;width:90px}
  pre{background:#0e1216;border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;color:#a8c1f5;margin:10px 0 0}
  .note{border:1px solid rgba(210,153,34,.35);background:rgba(210,153,34,.08);color:#e3c07a;border-radius:10px;padding:10px 14px;margin-bottom:18px;font-size:13.5px}
  .foot{margin-top:24px;color:var(--muted);font-size:12.5px}
  .big{font-size:20px;color:var(--text);display:block}
</style>
</head>
<body>
<div class="top">
  <h1>OpenRouter <span class="muted">×</span> Claude Code — تقرير الحالة</h1>
  <span class="pill ${checks.every((c) => c[2]) ? '' : 'bad'}">${checks.every((c) => c[2]) ? 'الإعداد مكتمل' : 'الإعداد ناقص'}</span>
</div>

<p class="note">ده تقرير ثابت (ملف واحد) — بيقرأ الإعدادات الحقيقية على الجهاز اللي اتولّد عليه، ومش بيعمل أي طلبات للموديل. للاختبار الحي: <code>./examples/openrouter/verify.sh</code> أو اللوحة: <code>node examples/openrouter/dashboard/server.mjs</code>.</p>

<div class="grid">
  <section class="card span2">
    <h2>فحوص الإعداد <span class="muted mono">${esc(SETTINGS_FILE)}</span></h2>
    <div class="stat-row">
      <div class="stat"><span class="label">Base URL</span><span class="mono">${esc(env.ANTHROPIC_BASE_URL || '—')}</span></div>
      <div class="stat"><span class="label">المفتاح</span><span class="mono">${esc(mask(key) || 'لا يوجد')}</span></div>
      <div class="stat"><span class="label">ينتهي بعد</span><span class="mono" id="countdown">${meta.expires_at ? '…' : 'غير مسجّل'}</span></div>
    </div>
    <ul class="checks">
      ${checks.map(([k, v, ok]) => `<li class="${ok ? 'ok' : 'bad'}"><b>${ok ? '✓' : '✗'}</b><span>${esc(k)}</span><span class="val">${esc(v)}</span></li>`).join('\n      ')}
    </ul>
  </section>

  <section class="card">
    <h2>فئات الموديلات</h2>
    <table class="models"><tbody>
      ${Object.entries(models)
        .map(([k, v]) => `<tr><td>${k}</td><td><code>${esc(v || '—')}</code></td></tr>`)
        .join('\n      ')}
    </tbody></table>
    <p class="muted">كل الفئات <code>:free</code> = مفيش أي استهلاك رصيد.</p>
  </section>

  <section class="card">
    <h2>حدود المجاني</h2>
    <span class="big">50 طلب/يوم</span>
    <div class="muted">(1000/يوم بعد شراء $10 رصيد مدفوع مرة واحدة) · 20 طلب/دقيقة</div>
    <p class="muted">كل turn في Claude Code = عدة طلبات، يعني بضع تفاعلات يوميًا.</p>
  </section>

  <section class="card span2">
    <h2>الموديلات المجانية (لقطة ${new Date().toISOString().slice(0, 10)})</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>الموديل</th><th>Context</th><th>Tools</th><th>Vision</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <pre>./examples/openrouter/setup.sh --list-free      # القائمة الحية
OPENROUTER_FREE_MODEL=poolside/laguna-s-2.1:free ./examples/openrouter/setup.sh --free</pre>
  </section>
</div>

<div class="foot">
  <pre>./examples/openrouter/setup.sh --free --expires 4h --key sk-or-v1-…
./examples/openrouter/verify.sh
node examples/openrouter/dashboard/server.mjs   # اللوحة التفاعلية</pre>
</div>

${meta.expires_at
  ? `<script>
  const at = ${Number(meta.expires_at)};
  const el = document.getElementById('countdown');
  const fmt = (s) => {
    const sign = s < 0 ? 'منتهي منذ ' : '';
    s = Math.abs(s);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
          m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return sign + d + 'ي ' + h + 'س';
    if (h > 0) return sign + h + 'س ' + String(m).padStart(2, '0') + 'د';
    return sign + m + ':' + String(sec).padStart(2, '0');
  };
  const tick = () => {
    const left = at - Math.floor(Date.now() / 1000);
    el.textContent = fmt(left);
    el.style.color = left <= 0 ? 'var(--bad)' : left < 1800 ? 'var(--warn)' : '';
  };
  tick(); setInterval(tick, 1000);
</script>`
  : ''}
</body>
</html>
`;

fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${(html.length / 1024).toFixed(1)} KB)`);
console.log(`  settings ${SETTINGS_FILE}`);
console.log(`  key      ${mask(key) || 'none'} · expiry ${meta.expires_at ? new Date(meta.expires_at * 1000).toISOString() : 'unset'}`);
