#!/usr/bin/env python3
"""gcode — interactive 3D gcode previewer (gcode.ffilt.us).

Serves a static Three.js viewer. Parsing/rendering happens in the browser;
the server only hosts files and a health check. No print control, no
cloud. Env: HTTP_PORT (8080).
"""
import os
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HTTP_PORT = int(os.environ.get("HTTP_PORT", "8080"))
ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")


class Handler(BaseHTTPRequestHandler):
    server_version = "gcode-preview"
    protocol_version = "HTTP/1.1"

    def _send(self, code, ctype, body, extra=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            self._send(200, "text/plain", b"ok\n")
            return
        if path == "/":
            path = "/index.html"
        # serve from static/
        rel = path.lstrip("/")
        if ".." in rel.split("/"):
            self._send(400, "text/plain", b"bad path\n")
            return
        fpath = os.path.join(STATIC, rel)
        if not os.path.isfile(fpath):
            self._send(404, "text/plain", b"not found\n")
            return
        ctype = mimetypes.guess_type(fpath)[0] or "application/octet-stream"
        with open(fpath, "rb") as f:
            data = f.read()
        self._send(200, ctype, data, extra=(("Cache-Control", "no-cache"),))

    def log_message(self, format, *args):
        pass


def main():
    httpd = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Handler)
    httpd.daemon_threads = True
    print(f"gcode-preview listening on :{HTTP_PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
