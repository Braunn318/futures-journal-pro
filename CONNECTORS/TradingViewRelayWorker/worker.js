export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    if (!env.RELAY_TOKEN || token !== env.RELAY_TOKEN) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const payload = await request.json();
      const id = crypto.randomUUID();
      const item = { id, receivedAt: new Date().toISOString(), payload };
      await env.FJ_QUEUE.put(`event:${Date.now()}:${id}`, JSON.stringify(item), { expirationTtl: 86400 * 14 });
      return json({ ok: true, id }, 201);
    }

    if (request.method === "GET" && url.pathname === "/pull") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 100);
      const listed = await env.FJ_QUEUE.list({ prefix: "event:", limit });
      const events = [];
      for (const key of listed.keys) {
        const raw = await env.FJ_QUEUE.get(key.name);
        if (raw) events.push({ key: key.name, ...JSON.parse(raw) });
      }
      return json({ ok: true, events });
    }

    if (request.method === "POST" && url.pathname === "/ack") {
      const body = await request.json();
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      const listed = await env.FJ_QUEUE.list({ prefix: "event:", limit: 1000 });
      for (const key of listed.keys) {
        const raw = await env.FJ_QUEUE.get(key.name);
        if (!raw) continue;
        const item = JSON.parse(raw);
        if (ids.has(item.id)) await env.FJ_QUEUE.delete(key.name);
      }
      return json({ ok: true });
    }

    return json({ ok: true, service: "Futures Journal TradingView Relay" });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" }
  });
}
