import { Hono } from "hono";

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true, service: "amivisible" }));

// URL in -> visibility report out. Engine lands next.
app.get("/api/check", (c) => {
  return c.json({ error: "not built yet" }, 501);
});

export default app;
