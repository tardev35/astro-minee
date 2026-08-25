import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 9898;
const API = "https://api.cloudflare.com/client/v4";

const ZONE_ID_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9_.~-]{30,200}$/;
const SETTING = "email_obfuscation";

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(join(__dirname, "public")));

function readToken(req) {
  const raw = String(req.body?.token ?? "").trim().replace(/^Bearer\s+/i, "");
  return TOKEN_RE.test(raw) ? raw : null;
}

async function cf(path, token, init = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  } catch (err) {
    return { ok: false, error: `ต่อ api.cloudflare.com ไม่ได้: ${err.message}` };
  }
  let body = {};
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: `Cloudflare ตอบกลับมาไม่ใช่ JSON (HTTP ${res.status})` };
  }
  if (!res.ok || body.success === false) {
    const msg = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join(" · ");
    return { ok: false, error: msg || `Cloudflare ตอบ HTTP ${res.status}` };
  }
  return { ok: true, body };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

app.post("/api/verify", async (req, res) => {
  const token = readToken(req);
  if (!token) return res.status(400).json({ ok: false, error: "รูปแบบ API token ไม่ถูกต้อง" });

  const r = await cf("/user/tokens/verify", token);
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  res.json({ ok: true, status: r.body.result?.status ?? "unknown" });
});

app.post("/api/zones", async (req, res) => {
  const token = readToken(req);
  if (!token) return res.status(400).json({ ok: false, error: "รูปแบบ API token ไม่ถูกต้อง" });

  const zones = [];
  for (let page = 1; page <= 50; page++) {
    const r = await cf(`/zones?per_page=50&page=${page}`, token);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    zones.push(...(r.body.result ?? []).map((z) => ({ id: z.id, name: z.name, status: z.status })));
    const info = r.body.result_info ?? {};
    if (!info.total_pages || page >= info.total_pages) break;
  }

  const withSetting = await mapLimit(zones, 6, async (z) => {
    const r = await cf(`/zones/${z.id}/settings/${SETTING}`, token);
    if (!r.ok) return { ...z, value: null, editable: false, error: r.error };
    return { ...z, value: r.body.result?.value ?? null, editable: r.body.result?.editable !== false };
  });

  res.json({ ok: true, zones: withSetting });
});

app.post("/api/setting", async (req, res) => {
  const token = readToken(req);
  if (!token) return res.status(400).json({ ok: false, error: "รูปแบบ API token ไม่ถูกต้อง" });

  const zoneId = String(req.body?.zoneId ?? "").trim().toLowerCase();
  if (!ZONE_ID_RE.test(zoneId)) {
    return res.status(400).json({ ok: false, error: "Zone ID ต้องเป็นตัวอักษร a-f และตัวเลข 32 ตัว" });
  }

  const value = req.body?.value === "on" ? "on" : "off";
  const r = await cf(`/zones/${zoneId}/settings/${SETTING}`, token, {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  res.json({ ok: true, value: r.body.result?.value ?? value });
});

app.post("/api/zone", async (req, res) => {
  const token = readToken(req);
  if (!token) return res.status(400).json({ ok: false, error: "รูปแบบ API token ไม่ถูกต้อง" });

  const zoneId = String(req.body?.zoneId ?? "").trim().toLowerCase();
  if (!ZONE_ID_RE.test(zoneId)) {
    return res.status(400).json({ ok: false, error: "Zone ID ต้องเป็นตัวอักษร a-f และตัวเลข 32 ตัว" });
  }

  const meta = await cf(`/zones/${zoneId}`, token);
  if (!meta.ok) return res.status(400).json({ ok: false, error: meta.error });
  const setting = await cf(`/zones/${zoneId}/settings/${SETTING}`, token);
  if (!setting.ok) return res.status(400).json({ ok: false, error: setting.error });

  res.json({
    ok: true,
    zone: {
      id: zoneId,
      name: meta.body.result?.name ?? zoneId,
      status: meta.body.result?.status ?? "",
      value: setting.body.result?.value ?? null,
      editable: setting.body.result?.editable !== false,
    },
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Cloudflare Scrape Shield — http://${HOST}:${PORT}`);
  console.log("ปิด Email Address Obfuscation ทีละโดเมนหรือทั้งบัญชี");
  console.log("token ไม่ถูกเขียนลงดิสก์และไม่ถูก log — ส่งผ่าน request แล้วทิ้ง");
});
