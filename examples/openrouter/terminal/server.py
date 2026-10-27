#!/usr/bin/env python3
"""Run the real Claude Code app in your browser.

This is a terminal, not a dashboard: it allocates a real PTY, launches the
`claude` CLI inside it, and streams the terminal to xterm.js. What you see and
type is Claude Code itself.

Stdlib only — no pip installs. The only vendored asset is xterm.js (MIT).

    python3 examples/openrouter/terminal/server.py            # :7681
    PORT=9000 python3 examples/openrouter/terminal/server.py

Backends
    openrouter   the configured Claude Code setup (settings.json → OpenRouter)
    demo         the same CLI pointed at the bundled stand-in server, for hosts
                 with no egress to openrouter.ai; replies are canned, not a model
"""

import base64
import fcntl
import json
import os
import pty
import queue
import select
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_DIR = os.path.dirname(HERE)                      # examples/openrouter
MOCK = os.path.join(ENV_DIR, "dashboard", "dev-mock-server.mjs")
REPO = os.path.dirname(os.path.dirname(ENV_DIR))
PORT = int(os.environ.get("PORT", "7681"))
HOST = os.environ.get("HOST", "0.0.0.0")
MOCK_PORT = int(os.environ.get("MOCK_PORT", "8787"))

CONF_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.join(os.path.expanduser("~"), ".config")), "openrouter")
KEY_FILE = os.environ.get("OPENROUTER_KEY_FILE", os.path.join(CONF_DIR, "api_key"))


def probe_egress(host="openrouter.ai", port=443, timeout=4.0):
    """Can this host reach OpenRouter at all? Decides the default backend."""
    import socket
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def read_key():
    for path in (os.environ.get("ANTHROPIC_AUTH_TOKEN"), os.environ.get("OPENROUTER_API_KEY")):
        if path and path.startswith("sk-or-"):
            return path
    try:
        with open(KEY_FILE) as fh:
            key = fh.read().strip()
        return key if key.startswith("sk-or-") else ""
    except OSError:
        return ""


# ---------------------------------------------------------------- the session
class Session:
    """One PTY running `claude`, with a fan-out buffer for SSE listeners."""

    def __init__(self):
        self.lock = threading.Lock()
        self.pid = None
        self.fd = None
        self.backend = None
        self.started_at = None
        self.subscribers = set()
        self.log = bytearray()          # replay buffer so a reconnecting tab catches up
        self.alive = False
        self.mock_proc = None
        self.cols, self.rows = 120, 32

    # -- lifecycle ----------------------------------------------------------
    def start(self, backend):
        self.stop()
        env = dict(os.environ)
        env.update({
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "FORCE_COLOR": "1",
            "COLUMNS": str(self.cols),
            "LINES": str(self.rows),
        })

        if backend == "demo":
            self._start_mock()
            cfg_dir = "/tmp/openrouter-terminal-demo"
            os.makedirs(cfg_dir, exist_ok=True)
            with open(os.path.join(cfg_dir, "settings.json"), "w") as fh:
                json.dump({"env": {
                    "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{MOCK_PORT}",
                    "ANTHROPIC_AUTH_TOKEN": "demo-token",
                    "ANTHROPIC_API_KEY": "",
                    "ANTHROPIC_MODEL": "thinkingmachines/inkling-small:free[1m]",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "thinkingmachines/inkling-small:free[1m]",
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "nvidia/nemotron-3.5-lightning:free[1m]",
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                }}, fh, indent=2)
            env["CLAUDE_CONFIG_DIR"] = cfg_dir
            # Skip first-run onboarding (theme, security notes, folder trust) so
            # the demo opens straight on the prompt.
            seed = {
                "hasCompletedOnboarding": True,
                "theme": "dark",
                "numStartups": 5,
                "projects": {REPO: {"hasTrustDialogAccepted": True, "allowedTools": []}},
            }
            for home in (os.path.join(cfg_dir, ".claude.json"),
                         os.path.join(os.path.expanduser("~"), ".claude.json")):
                try:
                    if os.path.exists(home):
                        with open(home, encoding="utf-8") as fh:
                            current = json.load(fh)
                    else:
                        current = {}
                    current.update(seed)
                    current.setdefault("projects", {}).update(seed["projects"])
                    with open(home, "w", encoding="utf-8") as fh:
                        json.dump(current, fh, indent=2)
                except (OSError, json.JSONDecodeError):
                    pass
        else:
            key = read_key()
            if key:
                env["ANTHROPIC_AUTH_TOKEN"] = key
                env["OPENROUTER_API_KEY"] = key
            env["ANTHROPIC_BASE_URL"] = "https://openrouter.ai/api"
            env["ANTHROPIC_API_KEY"] = ""

        claude = os.environ.get("CLAUDE_BIN") or "claude"
        argv = [claude]

        self.log.clear()
        self.backend = backend
        self.started_at = time.time()
        pid, fd = pty.fork()
        if pid == 0:                                    # child
            try:
                os.chdir(REPO)
                os.execvpe(claude, argv, env)
            except Exception:
                sys.stderr.write("failed to start claude\n")
                os._exit(127)

        self.pid, self.fd = pid, fd
        self.alive = True
        self._resize(self.cols, self.rows)
        threading.Thread(target=self._reader, args=(fd,), daemon=True).start()
        self._broadcast({"type": "start", "backend": backend, "pid": pid})
        return {"backend": backend, "pid": pid}

    def _start_mock(self):
        if self.mock_proc and self.mock_proc.poll() is None:
            return
        try:
            self.mock_proc = subprocess.Popen(
                ["node", MOCK], env={**os.environ, "MOCK_PORT": str(MOCK_PORT)},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            for _ in range(60):
                try:
                    import urllib.request
                    urllib.request.urlopen(f"http://127.0.0.1:{MOCK_PORT}/__log", timeout=0.5).read()
                    return
                except Exception:
                    time.sleep(0.1)
        except Exception:
            self.mock_proc = None

    def stop(self):
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
        self.pid = None
        self.fd = None
        self.alive = False

    # -- io -----------------------------------------------------------------
    def _reader(self, fd):
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            with self.lock:
                self.log.extend(chunk)
                del self.log[:-200_000]                 # keep the last ~200KB
                for q in list(self.subscribers):
                    q.put(chunk)
        self.alive = False
        self._broadcast({"type": "exit"})

    def _broadcast(self, event):
        payload = json.dumps(event).encode()
        with self.lock:
            for q in list(self.subscribers):
                q.put(payload)

    def write(self, data):
        if self.fd is None:
            return False
        try:
            os.write(self.fd, data.encode() if isinstance(data, str) else data)
            return True
        except OSError:
            return False

    def _resize(self, cols, rows):
        if self.fd is None:
            return
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGWINCH)
            except ProcessLookupError:
                pass

    def resize(self, cols, rows):
        self.cols, self.rows = max(20, cols), max(6, rows)
        self._resize(self.cols, self.rows)

    def snapshot(self):
        with self.lock:
            return bytes(self.log)


SESSION = Session()


# ------------------------------------------------------------------- http bits
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "claude-code-terminal"

    def log_message(self, fmt, *args):                  # keep the console quiet
        pass

    # -- helpers ------------------------------------------------------------
    def _send(self, status, body, ctype="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, status=200):
        self._send(status, json.dumps(payload).encode())

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def _static(self, rel, ctype):
        path = os.path.normpath(os.path.join(HERE, rel))
        if not path.startswith(HERE) or not os.path.isfile(path):
            return self._json({"error": "not found"}, 404)
        with open(path, "rb") as fh:
            body = fh.read()
        self._send(200, body, ctype)

    # -- routes -------------------------------------------------------------
    def do_GET(self):
        try:
            path = self.path.split("?")[0]
            if path in ("/", "/index.html"):
                return self._static("index.html", "text/html; charset=utf-8")
            if path == "/app.js":
                return self._static("app.js", "text/javascript; charset=utf-8")
            if path == "/styles.css":
                return self._static("styles.css", "text/css; charset=utf-8")
            if path.startswith("/vendor/"):
                rel = path[len("/vendor/"):]
                ext = os.path.splitext(rel)[1]
                ctype = {".js": "text/javascript; charset=utf-8",
                         ".css": "text/css; charset=utf-8",
                         ".map": "application/json"}.get(ext, "application/octet-stream")
                return self._static(os.path.join("vendor", rel), ctype)
            if path == "/api/health":
                return self._json({"ok": True, "alive": SESSION.alive, "backend": SESSION.backend,
                                   "pid": SESSION.pid, "claude": which_claude(),
                                   "egress": EGRESS})
            if path == "/api/stream":
                return self._stream()
            return self._json({"error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                return self._json({"error": "internal"}, 500)
            except Exception:
                pass

    def do_POST(self):
        try:
            path = self.path.split("?")[0]
            data = self._body()
            if path == "/api/start":
                backend = data.get("backend") if data.get("backend") in ("openrouter", "demo") else "openrouter"
                if data.get("cols") and data.get("rows"):
                    SESSION.cols, SESSION.rows = int(data["cols"]), int(data["rows"])
                info = SESSION.start(backend)
                return self._json({"ok": True, **info})
            if path == "/api/input":
                return self._json({"ok": SESSION.write(data.get("data", ""))})
            if path == "/api/resize":
                SESSION.resize(int(data.get("cols") or 120), int(data.get("rows") or 32))
                return self._json({"ok": True})
            if path == "/api/stop":
                SESSION.stop()
                return self._json({"ok": True})
            return self._json({"error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                return self._json({"error": "internal"}, 500)
            except Exception:
                pass

    # -- SSE ----------------------------------------------------------------
    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        q = queue.Queue()
        with SESSION.lock:
            SESSION.subscribers.add(q)
            replay = bytes(SESSION.log)

        def send(event, payload):
            self.wfile.write(f"event: {event}\ndata: {payload}\n\n".encode())
            self.wfile.flush()

        try:
            send("hello", json.dumps({"alive": SESSION.alive, "backend": SESSION.backend}))
            if replay:
                send("data", base64.b64encode(replay).decode())
            while True:
                try:
                    item = q.get(timeout=15)
                except queue.Empty:
                    send("ping", str(int(time.time())))      # keep the proxy from idling out
                    continue
                if isinstance(item, (bytes, bytearray)) and not item.startswith(b"{"):
                    send("data", base64.b64encode(bytes(item)).decode())
                else:
                    send("event", item.decode() if isinstance(item, (bytes, bytearray)) else json.dumps(item))
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with SESSION.lock:
                SESSION.subscribers.discard(q)


EGRESS = probe_egress()


def which_claude():
    for base in os.environ.get("PATH", "").split(os.pathsep):
        candidate = os.path.join(base, "claude")
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            try:
                return subprocess.run([candidate, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
            except Exception:
                return candidate
    return None


def main():
    claude = which_claude()
    print(f"Claude Code terminal on http://{HOST}:{PORT}")
    print(f"  claude  : {claude or 'NOT FOUND — install with: npm i -g @anthropic-ai/claude-code'}")
    print(f"  key     : {'found' if read_key() else 'missing'} ({KEY_FILE})")
    print(f"  egress  : {'openrouter.ai reachable' if EGRESS else 'BLOCKED — default backend is the local demo'}")
    if not claude:
        print("  warning: the terminal will show a shell error until the CLI is installed")
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
        server.daemon_threads = True
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        SESSION.stop()
        if SESSION.mock_proc:
            SESSION.mock_proc.terminate()


if __name__ == "__main__":
    main()
