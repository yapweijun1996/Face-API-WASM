#!/usr/bin/env python3
"""
serve.py — Static server with COOP/COEP headers for Face-API-WASM.

Why: TF.js auto-selects the fastest WASM binary, but the threaded-SIMD build
needs SharedArrayBuffer, which browsers gate behind two response headers:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

Plain `python3 -m http.server` does NOT send these, so threading silently
falls back to SIMD-only (~2-4x slower). This server adds them.

This project is fully offline (no cross-origin assets), so COEP is safe here.

Usage:
    python3 serve.py            # serves on http://localhost:8080
    python3 serve.py 3000       # custom port

Then open http://localhost:8080/home.html
Camera access works on localhost without HTTPS.
"""

import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class CrossOriginIsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Required for SharedArrayBuffer -> WASM multi-threading.
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        # No-cache during dev so model/lib edits show up immediately.
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quieter than the default per-request noise.
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    httpd = HTTPServer(('', port), CrossOriginIsolatedHandler)
    print(f"Face-API-WASM dev server (COOP/COEP enabled)")
    print(f"  http://localhost:{port}/home.html")
    print(f"  Cross-origin isolated: WASM multi-threading available")
    print(f"  Ctrl+C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        httpd.server_close()


if __name__ == '__main__':
    main()
