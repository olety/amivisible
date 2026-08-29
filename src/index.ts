import { Hono } from "hono";
import { runCheck } from "./report";

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true, service: "amivisible" }));

// SSRF guard: public http(s) hosts only
function validateTarget(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { error: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "http(s) only" };
  if (url.username || url.password) return { error: "credentials in URL not allowed" };
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
    host === "0.0.0.0" || /^127\./.test(host) || /^10\./.test(host) ||
    /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) || host === "[::1]" || host.startsWith("[fc") || host.startsWith("[fd") || host.startsWith("[fe80")
  ) return { error: "private/internal hosts not allowed" };
  if (!host.includes(".")) return { error: "need a public hostname" };
  return { url };
}

app.get("/api/check", async (c) => {
  const raw = c.req.query("url");
  if (!raw) return c.json({ error: "missing ?url=" }, 400);
  const target = validateTarget(raw);
  if ("error" in target) return c.json({ error: target.error }, 400);

  // 1h result cache, no accounts, no storage of anything else
  const cacheKey = new Request(`https://cache.amivisible.internal/v1/${encodeURIComponent(target.url.href)}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit && c.req.query("fresh") !== "1") {
    const body = await hit.text();
    return c.body(body, 200, { "content-type": "application/json", "x-amivisible-cache": "hit" });
  }

  try {
    const report = await runCheck(target.url.href);
    const body = JSON.stringify(report);
    c.executionCtx.waitUntil(
      cache.put(cacheKey, new Response(body, {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
      })),
    );
    return c.body(body, 200, { "content-type": "application/json", "x-amivisible-cache": "miss" });
  } catch (e) {
    return c.json({ error: "check failed", detail: e instanceof Error ? e.message : String(e) }, 502);
  }
});

export default app;
