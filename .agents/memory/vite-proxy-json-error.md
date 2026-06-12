---
name: Vite proxy JSON error
description: Why "Server error — please try again" appears on login and how to prevent it.
---

## The rule
Always add a `configure` + `proxy.on('error', ...)` handler to the Vite dev server proxy. Without it, when the backend (port 8099) is briefly unreachable (during the 0.3s auto-restart window), Vite's http-proxy returns an HTML `502 Bad Gateway` page — not JSON.

## Why
`authService.js::safeParseJson` returns `{}` for non-JSON bodies. `data.error` is then `undefined`. The fallback string `'Server error — please try again'` at `authService.js:250` fires. This looks like a server crash to the user but is actually a dev-proxy HTML error swallowing the real backend JSON.

The backend 500/503 paths in `auth.ts` always include `error: "..."` in their JSON body — those are fine. The problem only surfaces via the proxy.

## How to apply
In `artifacts/ib-ai-v2/vite.config.ts` under `server.proxy["/api"]`, add:
```ts
configure: (proxy) => {
  proxy.on("error", (_err, _req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: false,
      error: "Service temporarily unavailable — the server is starting up. Please try again in a moment.",
    }));
  });
},
```
This ensures `data.error` is always a non-empty string, so no fallback fires.

**Why:** Confirmed via static analysis — all backend 500 paths include `error` field. Only the Vite proxy HTML 502 produces a falsy `data.error`.
