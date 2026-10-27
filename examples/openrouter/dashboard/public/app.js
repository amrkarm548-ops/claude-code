const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let status = null;
let selectedModel = null;

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({ error: 'bad JSON from server' }));
  return data;
}

function setPill(el, text, kind) {
  el.textContent = text;
  el.className = `pill pill-${kind}`;
}

function fmtLeft(seconds) {
  const sign = seconds < 0 ? 'منتهي منذ ' : '';
  const s = Math.abs(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${sign}${d}ي ${h}س`;
  if (h > 0) return `${sign}${h}س ${String(m).padStart(2, '0')}د`;
  return `${sign}${m}:${String(sec).padStart(2, '0')}`;
}

function renderStatus(data) {
  status = data;
  $('settings-path').textContent = data.settings.path + (data.settings.exists ? '' : ' (ملف غير موجود)');

  $('base-url').textContent = data.baseUrl || '—';
  $('key-mask').textContent = data.key.present ? data.key.masked : 'لا يوجد مفتاح';
  $('key-mask').title = data.key.source ? `المصدر: ${data.key.source}` : '';

  const expiry = $('expiry');
  if (!data.expiry) {
    expiry.textContent = 'غير مسجّل';
    expiry.className = 'value mono muted';
  } else {
    const left = data.expiry.left;
    const live = Math.max(0, Math.round((data.expiry.at - Date.now() / 1000) / 1000) * 1000);
    expiry.textContent = fmtLeft(Math.round(left));
    expiry.className = `value mono ${left <= 0 ? 'neg' : left < 1800 ? 'soon' : ''}`;
    expiry.title = `${data.expiry.iso} (${data.expiry.mode || '?'})`;
    if (left > 0) {
      clearInterval(window.__expiryTimer);
      window.__expiryTimer = setInterval(() => {
        const rem = data.expiry.at - Math.floor(Date.now() / 1000);
        expiry.textContent = fmtLeft(rem);
        expiry.className = `value mono ${rem <= 0 ? 'neg' : rem < 1800 ? 'soon' : ''}`;
        if (rem <= 0) clearInterval(window.__expiryTimer);
      }, 1000);
    }
  }

  $('checks').innerHTML = data.checks
    .map((c) => `<li class="${c.ok ? 'ok' : 'bad'}">
        <span class="mark">${c.ok ? '✓' : '✗'}</span>
        <span>${esc(c.label)}</span>
        <span class="val">${esc(c.value ?? '—')}</span>
      </li>`)
    .join('');

  const rows = [
    ['default', data.models.default],
    ['opus', data.models.opus],
    ['sonnet', data.models.sonnet],
    ['haiku', data.models.haiku],
    ['fable', data.models.fable],
    ['subagent', data.models.subagent],
  ];
  $('model-classes').innerHTML = rows
    .map(([k, v]) => {
      const free = !v || /:free$|^openrouter\/free$/.test(v);
      return `<tr><td>${k}</td><td><code class="${free ? 'yes' : ''}">${esc(v || '—')}</code></td></tr>`;
    })
    .join('');

  const ready = data.ready;
  setPill($('connection'), ready ? 'الإعداد مكتمل' : 'الإعداد ناقص', ready ? 'ok' : 'bad');
  $('live-dot').className = `dot ${ready ? 'ok' : 'bad'}`;
}

function renderCatalog(data) {
  selectedModel = selectedModel || status?.models?.haiku || data.models[0]?.id;
  $('catalog-source').textContent =
    data.source === 'live'
      ? `· مباشر ${new Date(data.fetchedAt).toLocaleTimeString('ar-EG')}`
      : '· نسخة محفوظة (لا يوجد اتصال)';

  const err = $('catalog-error');
  if (data.error) {
    err.hidden = false;
    err.innerHTML = `تعذّر جلب القائمة المباشرة: <code>${esc(data.error)}</code> — المعروض من لقطة محفوظة بتاريخ 2026-10-27.`;
  } else {
    err.hidden = true;
  }

  $('catalog').innerHTML = data.models
    .map((m) => {
      const sel = m.id === selectedModel;
      return `<tr data-model="${esc(m.id)}">
        <td><code>${esc(m.id)}</code>${m.name ? `<div class="muted">${esc(m.name)}</div>` : ''}${m.note ? `<div class="muted">${esc(m.note)}</div>` : ''}${m.expires ? `<div class="muted">ينتهي ${esc(m.expires)}</div>` : ''}</td>
        <td>${m.context ? (m.context / 1000).toFixed(0) + 'k' : '—'}</td>
        <td class="${m.tools ? 'yes' : 'no'}">${m.tools ? '✓' : '✗'}</td>
        <td class="${m.vision ? 'yes' : 'no'}">${m.vision ? '✓' : '✗'}</td>
        <td><button class="btn btn-ghost" data-pick="${esc(m.id)}">${sel ? 'مختار' : 'اختر'}</button></td>
      </tr>`;
    })
    .join('');

  updateCmd();
}

function updateCmd() {
  const env = selectedModel && selectedModel !== status?.models?.haiku ? `OPENROUTER_FREE_MODEL=${selectedModel} ` : '';
  $('cmd').textContent = `${env}./examples/openrouter/setup.sh --free --expires 4h --key sk-or-v1-…`;
}

async function loadStatus() {
  try {
    renderStatus(await api('/api/status'));
  } catch (err) {
    setPill($('connection'), 'السيرفر لا يرد', 'bad');
  }
}

async function loadCatalog(force) {
  const data = await api(`/api/free-models${force ? '?refresh=1' : ''}`);
  renderCatalog(data);
}

async function loadCredits() {
  const el = $('credits');
  const data = await api('/api/credits');
  if (data.ok) {
    el.innerHTML = `<span class="big">$${Number(data.left ?? 0).toFixed(2)}</span>
      متبقٍ من $${Number(data.total ?? 0).toFixed(2)} (مستخدم $${Number(data.used ?? 0).toFixed(4)})`;
  } else if (data.network) {
    el.innerHTML = `<span class="muted">لا يمكن قراءة الرصيد من هنا: ${esc(data.error)}</span>`;
  } else {
    el.innerHTML = `<span class="muted">${esc(data.error || 'تعذّر قراءة الرصيد')}</span>`;
  }
}

function out(el, text, kind) {
  el.hidden = false;
  el.className = `out ${kind || ''}`;
  el.textContent = text;
}

$('run-test').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const box = $('test-out');
  btn.disabled = true;
  out(box, 'جارٍ الإرسال إلى https://openrouter.ai/api/v1/messages …', '');
  try {
    const data = await api('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: selectedModel }),
    });
    if (data.ok) {
      out(
        box,
        `✓ نجح الاتصال\nmodel   : ${data.model}\nlatency : ${data.ms} ms\nusage   : ${JSON.stringify(data.usage)}\nرد الموديل: ${data.text}`,
        'ok',
      );
    } else {
      out(
        box,
        `✗ فشل عند: ${data.stage}\n${data.error || ''}${data.detail ? '\n\n' + data.detail : ''}\n\nmodel: ${data.model || '—'}${data.status ? `\nHTTP: ${data.status}` : ''}`,
        'bad',
      );
    }
  } catch (err) {
    out(box, `✗ خطأ في الاتصال باللوحة: ${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
  }
});

$('send-chat').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const box = $('chat-out');
  const message = $('chat-input').value.trim();
  if (!message) return out(box, 'اكتب رسالة الأول.', 'bad');
  btn.disabled = true;
  out(box, 'جارٍ التفكير…', '');
  try {
    const data = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: selectedModel, message }),
    });
    if (data.ok) {
      out(box, `${data.text}\n\n— ${data.model} · ${data.ms}ms · ${JSON.stringify(data.usage)}`, 'ok');
    } else {
      out(box, `✗ ${data.error}${data.detail ? '\n' + data.detail : ''}`, 'bad');
    }
  } catch (err) {
    out(box, `✗ ${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
  }
});

$('catalog').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pick]');
  if (!btn) return;
  selectedModel = btn.dataset.pick;
  document.querySelectorAll('#catalog tr').forEach((tr) => {
    const b = tr.querySelector('[data-pick]');
    if (b) b.textContent = b.dataset.pick === selectedModel ? 'مختار' : 'اختر';
  });
  updateCmd();
  $('test-out').hidden = true;
  $('chat-out').hidden = true;
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const text = $(btn.dataset.copy).textContent;
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'تم النسخ ✓';
    setTimeout(() => (btn.textContent = old), 1400);
  } catch {
    /* clipboards need https; ignore */
  }
});

$('refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  await Promise.all([loadStatus(), loadCatalog(true), loadCredits()]);
  btn.disabled = false;
});

(async function init() {
  await loadStatus();
  await loadCatalog(false);
  loadCredits();

  // Tell the user up-front when this preview host cannot reach OpenRouter,
  // instead of letting them read every failure as a config problem.
  try {
    const probe = await api('/api/reach');
    if (!probe.ok) {
      const d = $('disclaimer');
      d.hidden = false;
      d.textContent = probe.network
        ? 'ملاحظة: السيرفر اللي بيخدم المعاينة دي مش عنده اتصال بـ openrouter.ai، فالاختبارات الحية هتفشل هنا. شغّل نفس اللوحة على جهازك (node examples/openrouter/dashboard/server.mjs) وهتشتغل عادي. باقي البيانات (الإعدادات، المفتاح، العدّاد، قائمة الموديلات) حقيقية 100%.'
        : `السيرفر واصل لـ openrouter.ai لكن الطلب رجع ${probe.error} — راجع المفتاح أو الموديل.`;
    }
  } catch {
    /* ignore */
  }
})();
