/* Terminal client: xterm.js ⇄ PTY over SSE + POST. */
const $ = (id) => document.getElementById(id);

const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 14,
  lineHeight: 1.25,
  cursorBlink: true,
  allowProposedApi: true,
  convertEol: false,
  scrollback: 8000,
  theme: {
    background: '#0b0d10',
    foreground: '#e6edf3',
    cursor: '#7aa2f7',
    selectionBackground: '#2c4a7a',
    black: '#1a1f26', red: '#f85149', green: '#3fb950', yellow: '#d29922',
    blue: '#7aa2f7', magenta: '#bc8cff', cyan: '#39c5cf', white: '#e6edf3',
    brightBlack: '#6e7781', brightRed: '#ff7b72', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#a5b4fc', brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd', brightWhite: '#ffffff',
  },
});

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('screen'));
fit.fit();
term.focus();

let backend = null;
let alive = false;

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json().catch(() => ({}));
}

function setStatus(text, kind) {
  $('status').textContent = text;
  $('dot').className = `dot ${kind || ''}`;
}

function markBackend(name) {
  backend = name;
  $('backend-tag').textContent = name === 'demo' ? 'local demo' : 'OpenRouter';
  $('backend-tag').className = `tag ${name === 'demo' ? 'tag-demo' : 'tag-or'}`;
  document.querySelectorAll('[data-backend]').forEach((b) => {
    b.classList.toggle('active', b.dataset.backend === name);
  });
}

async function resize() {
  fit.fit();
  $('size').textContent = `${term.cols}×${term.rows}`;
  await post('/api/resize', { cols: term.cols, rows: term.rows });
}

async function start(which) {
  term.reset();
  term.write('\x1b[90mstarting claude…\x1b[0m\r\n');
  const info = await post('/api/start', { backend: which, cols: term.cols, rows: term.rows });
  markBackend(info.backend || which);
  setStatus('متصل', 'ok');
}

term.onData(async (data) => {
  await post('/api/input', { data });
});

term.onResize(() => {
  if (!backend) return;
  post('/api/resize', { cols: term.cols, rows: term.rows });
  $('size').textContent = `${term.cols}×${term.rows}`;
});

window.addEventListener('resize', () => {
  clearTimeout(window.__rz);
  window.__rz = setTimeout(resize, 120);
});

document.querySelectorAll('[data-backend]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    await start(btn.dataset.backend);
    btn.disabled = false;
    term.focus();
  });
});

$('restart').addEventListener('click', async () => {
  await start(backend || 'openrouter');
  term.focus();
});

// --- SSE stream -------------------------------------------------------------
function connect() {
  const es = new EventSource('/api/stream');

  es.addEventListener('hello', (e) => {
    const info = JSON.parse(e.data);
    if (info.backend) markBackend(info.backend);
    alive = Boolean(info.alive);
    setStatus(alive ? 'متصل' : 'جاهز', alive ? 'ok' : '');
  });

  es.addEventListener('data', (e) => {
    term.write(b64ToBytes(e.data));
  });

  es.addEventListener('event', (e) => {
    const info = JSON.parse(e.data);
    if (info.type === 'exit') {
      alive = false;
      setStatus('الجلسة انتهت — اضغط ↻', 'bad');
      term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
    }
    if (info.type === 'start') setStatus('متصل', 'ok');
  });

  es.onerror = () => {
    setStatus('انقطع الاتصال — إعادة المحاولة…', 'bad');
    es.close();
    setTimeout(connect, 1500);
  };
}

// --- boot -------------------------------------------------------------------
(async function boot() {
  const health = await fetch('/api/health').then((r) => r.json()).catch(() => ({}));

  const b = $('banner');
  b.hidden = false;
  if (!health.claude) {
    b.className = 'banner bad';
    b.innerHTML = 'الـ CLI مش متسطّب. شغّل: <code>npm i -g @anthropic-ai/claude-code</code> ثم أعد تحميل الصفحة.';
  } else if (health.egress) {
    b.className = 'banner';
    b.innerHTML = `تشغيل <code>claude</code> ${health.claude} — متصل بـ OpenRouter. اكتب في الطرفية تحت.`;
  } else {
    b.className = 'banner warn';
    b.innerHTML =
      `تشغيل <code>claude</code> ${health.claude} — <b>openrouter.ai محجوب من السيرفر ده</b>، فالجلسة بدأت على <b>Local demo</b> (ردود ثابتة من سيرفر محلي، مش موديل). على جهازك بنفس الأمر هيشتغل على OpenRouter الحقيقي.`;
  }

  connect();
  const initial = health.alive ? (health.backend || 'openrouter') : (health.egress ? 'openrouter' : 'demo');
  if (!health.alive) await start(initial);
  else markBackend(health.backend || initial);
  setStatus(health.claude ? 'متصل' : 'بدون CLI', health.claude ? 'ok' : 'bad');
})();
