"""Local web server for the PDF tools.

Same as `python -m http.server`, but tells the browser to check for newer
files on every load, so edits show up with a normal refresh (no Ctrl+F5).

    python serve.py          # http://localhost:8765
    python serve.py 9000     # pick another port
"""
import functools
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # "no-cache" still lets the browser reuse a file if it hasn't changed,
        # but only after asking the server first.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    here = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(NoCacheHandler, directory=here)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"PDF tools running at http://localhost:{port}  (Ctrl+C to stop)")
        httpd.serve_forever()
