import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "src", "assets", "content.txt");
const OUT_DOCX = join(ROOT, "src", "assets", "content.docx");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const MIN_BODY = 60;

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const USAGE = `
  node tools/site-import.mjs <url ของเว็บเดิม> [--write] [--force] [--all]

  ไม่ใส่ --write   = แสดงผลให้ดูเฉยๆ ไม่เขียนไฟล์
  --write          = เขียน src/assets/content.txt
  --force          = ยอมทับ content.txt ที่มีอยู่ (และลบ content.docx)
  --all            = เอาทุกหัวข้อ ไม่ต้องคัดวิดเจ็ตออก

  ดึงเนื้อหาจากเว็บเดิมมาเป็น brief ที่ uploader กับ skill รีแบรนด์อ่านอยู่แล้ว
  ไม่ต้องบอกว่าเว็บเดิมทำด้วยอะไร มันลองเองสองทาง:

    WordPress   ผ่าน REST API (/wp-json/wp/v2/pages)
    Astro/static  ผ่าน sitemap แล้วอ่านจาก HTML ที่ render ออกมา

  รูปภาพไม่ได้ดึงมา — อัปผ่าน uploader ตามปกติ เพราะที่นั่นย่อขนาด ตั้งชื่อ
  และลบของแบรนด์เก่าให้ถูกต้อง
`;

const argv = process.argv.slice(2);
const opts = {
  write: argv.includes("--write"),
  force: argv.includes("--force"),
  all: argv.includes("--all"),
};
const site = argv.find((a) => !a.startsWith("-"));

if (!site) {
  console.log(USAGE);
  process.exit(0);
}

let ORIGIN;
try {
  ORIGIN = new URL(site.startsWith("http") ? site : `https://${site}`).origin;
} catch {
  console.error(`\n${C.red("หยุด")} อ่าน url ไม่ออก: ${site}\n`);
  process.exit(1);
}

async function get(url, as = "text") {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return as === "json" ? r.json() : r.text();
}

const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  bull: "•",
  middot: "·",
  deg: "°",
  trade: "™",
  copy: "©",
  reg: "®",
};

const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);

const stripTags = (s) => s.replace(/<[^>]*>/g, " ");

const clean = (s) => decodeEntities(stripTags(s)).replace(/ /g, " ").replace(/\s+/g, " ").trim();

const withoutCode = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");

const chars = (s) => [...s].length;

/** Headings and paragraphs of one page, in document order. */
function blocksOf(html) {
  const out = [];
  let skipped = 0;
  const re = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<p\b[^>]*>([\s\S]*?)<\/p>|<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  for (const m of withoutCode(html).matchAll(re)) {
    const tag = (m[1] || (m[3] !== undefined ? "p" : "li")).toLowerCase();
    const text = clean(m[2] ?? m[3] ?? m[4] ?? "");
    if (!text) continue;
    if (/^h[4-6]$/.test(tag)) {
      skipped++;
      continue;
    }
    out.push({ tag, text });
  }
  return { blocks: out, skippedDeepHeadings: skipped };
}

/** The article region of a rendered page — chrome outside <main> is the template's, not the brand's. */
function articleHtml(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return main[1];
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return (body ? body[1] : html)
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ");
}

function keepArticleGroups(blocks) {
  const groups = [];
  let cur = { head: null, body: [] };
  for (const b of blocks) {
    if (b.tag === "h1" || b.tag === "h2") {
      groups.push(cur);
      cur = { head: b, body: [] };
    } else cur.body.push(b);
  }
  groups.push(cur);

  const kept = [];
  const dropped = [];
  for (const g of groups) {
    const prose = g.body.filter((b) => b.tag === "p" || b.tag === "li");
    const longest = prose.reduce((n, b) => Math.max(n, chars(b.text)), 0);

    if (!g.head) {
      const body = g.body.filter((b) => b.tag !== "p" || chars(b.text) >= MIN_BODY);
      if (body.length) kept.push({ head: null, body });
      continue;
    }
    if (g.head.tag === "h1" || longest >= MIN_BODY) kept.push(g);
    else dropped.push({ title: g.head.text, longest });
  }
  return { kept, dropped };
}

const metaOf = (html) => ({
  title: clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""),
  description: clean(
    (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) ||
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) ||
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i) ||
      [])[1] || "",
  ),
});

const SUB_PAGES = [
  { label: "โปรโมชั่น", slugs: ["โปรโมชั่น", "promotion", "promotions", "promo"] },
  { label: "ติดต่อเรา", slugs: ["ติดต่อเรา", "contact-us", "contract", "contact", "contactus"] },
  { label: "ทดลองเล่น", slugs: ["ทดลองเล่น", "testplay", "demo", "try", "tryplay"] },
  { label: "ทางเข้า", slugs: ["ทางเข้า", "entrance", "link", "login"] },
];

const NOT_A_BRAND = new Set([
  "SLOT",
  "SLOTS",
  "GAME",
  "GAMES",
  "AUTO",
  "LINE",
  "WALLET",
  "TRUE",
  "BONUS",
  "JACKPOT",
  "DEMO",
  "LOGIN",
  "PLAY",
  "FREE",
  "SPIN",
  "SPINS",
  "LIVE",
  "CASINO",
  "SPORT",
  "SPORTS",
  "BACCARAT",
  "MOBILE",
  "BANKING",
  "SOFT",
  "GAMING",
  "ONLINE",
  "THAI",
  "TIER",
  "HIGH",
]);

const brandTokens = (s) => new Set((s.match(/[A-Z][A-Z0-9]{3,}/g) || []).filter((t) => !NOT_A_BRAND.has(t)));

const slugOf = (u) => {
  try {
    const segs = decodeURIComponent(new URL(u).pathname).split("/").filter(Boolean);
    return (segs.pop() || "").toLowerCase();
  } catch {
    return "";
  }
};

async function fromWordPress() {
  const pages = await get(`${ORIGIN}/wp-json/wp/v2/pages?per_page=100`, "json");
  if (!Array.isArray(pages) || !pages.length) throw new Error("REST API ตอบมาแต่ไม่มีหน้าเลย");
  const norm = (u) => String(u || "").replace(/\/+$/, "");
  const home = pages.find((p) => norm(p.link) === norm(ORIGIN)) ?? pages[0];
  return {
    how: "WordPress REST API",
    list: pages.map((p) => ({ url: p.link, slug: decodeURIComponent(p.slug || "").toLowerCase(), html: p.content?.rendered || "", isHome: p === home })),
  };
}

async function sitemapUrls() {
  const seen = new Set();
  const urls = [];
  const add = (u) => {
    const k = u.replace(/\/+$/, "");
    if (!seen.has(k)) {
      seen.add(k);
      urls.push(u);
    }
  };
  const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));

  for (const name of ["sitemap-index.xml", "sitemap.xml", "sitemap-0.xml"]) {
    let xml;
    try {
      xml = await get(`${ORIGIN}/${name}`);
    } catch {
      continue;
    }
    for (const loc of locs(xml)) {
      if (/\.xml(\?|$)/i.test(loc)) {
        try {
          for (const u of locs(await get(loc))) add(u);
        } catch {}
      } else add(loc);
    }
    if (urls.length) break;
  }
  return urls;
}

async function fromStatic() {
  const urls = await sitemapUrls();
  if (!urls.length) throw new Error("ไม่เจอ sitemap ที่อ่านได้");
  const isHome = (u) => {
    try {
      return new URL(u).pathname.replace(/\/+$/, "") === "";
    } catch {
      return false;
    }
  };
  const list = [];
  for (const u of urls) {
    let html;
    try {
      html = await get(u);
    } catch {
      continue;
    }
    list.push({ url: u, slug: slugOf(u), html, raw: html, isHome: isHome(u) });
  }
  if (!list.some((p) => p.isHome) && list.length) list[0].isHome = true;
  return { how: "sitemap + HTML ที่ render แล้ว", list, static: true };
}

async function main() {
  console.log(`\n${C.bold("ดึงจาก")} ${ORIGIN}`);

  let src;
  try {
    src = await fromWordPress();
  } catch (wpErr) {
    try {
      src = await fromStatic();
    } catch (stErr) {
      console.error(`\n${C.red("หยุด")} ดึงไม่ได้ทั้งสองทาง`);
      console.error(`  WordPress : ${wpErr.message}`);
      console.error(`  static    : ${stErr.message}\n`);
      process.exit(1);
    }
  }

  const home = src.list.find((p) => p.isHome);
  if (!home) {
    console.error(`\n${C.red("หยุด")} หาหน้าแรกไม่เจอ\n`);
    process.exit(1);
  }
  console.log(`  วิธี: ${src.how} · เจอ ${src.list.length} หน้า`);

  const homePageHtml = src.static ? home.raw : await get(home.url);
  const homeMeta = metaOf(homePageHtml);
  const scope = src.static ? articleHtml(home.raw) : home.html;
  const { blocks, skippedDeepHeadings } = blocksOf(scope);
  const { kept, dropped } = opts.all ? { kept: [{ head: null, body: blocks }], dropped: [] } : keepArticleGroups(blocks);

  const lines = [];
  if (homeMeta.title) lines.push("Title", homeMeta.title);
  if (homeMeta.description) lines.push("Description", homeMeta.description);

  const counts = { h1: 0, h2: 0, h3: 0, para: 0 };
  const emit = (b) => {
    if (b.tag === "h1" || b.tag === "h2" || b.tag === "h3") {
      lines.push("", `${b.tag.toUpperCase()}:${b.text}`);
      counts[b.tag]++;
    } else {
      lines.push(b.text);
      counts.para++;
    }
  };
  for (const g of kept) {
    if (g.head) emit(g.head);
    for (const b of g.body) emit(b);
  }

  const subs = [];
  for (const cfg of SUB_PAGES) {
    let p;
    for (const s of cfg.slugs) {
      p = src.list.find((x) => x.slug === s && !x.isHome);
      if (p) break;
    }
    if (!p) continue;
    const html = src.static ? p.raw : await get(p.url);
    const m = metaOf(html);
    const body = src.static ? blocksOf(articleHtml(p.raw)).blocks : blocksOf(p.html).blocks;
    subs.push({ ...cfg, url: p.url, ...m, empty: !body.some((b) => b.tag === "p" && chars(b.text) >= MIN_BODY) });
  }

  const withMeta = subs.filter((s) => s.title || s.description);
  if (withMeta.length) {
    lines.push("", "SUB-PAGES (Title & Meta Description)");
    for (const s of withMeta) {
      lines.push("", `[${s.label}]`);
      if (s.title) lines.push(`Title:${s.title}`);
      if (s.description) lines.push(`Meta:${s.description}`);
    }
  }

  const text =
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n";

  console.log(`\n${C.bold("ที่ดึงได้")}  H1×${counts.h1} · H2×${counts.h2} · H3×${counts.h3} · ย่อหน้า ${counts.para} · ${chars(text)} ตัวอักษร`);

  if (dropped.length) {
    console.log(`\n${C.dim("คัดออก (หัวข้อวิดเจ็ต — template ของแบรนด์ใหม่สร้างเองอยู่แล้ว)")}`);
    for (const d of dropped) console.log(C.dim(`  • ${d.title}  ${d.longest ? `(ข้อความยาวสุด ${d.longest} ตัวอักษร)` : "(ไม่มีเนื้อความ)"}`));
    console.log(C.dim(`  ถ้าอันไหนเป็นเนื้อหาจริง สั่งใหม่ด้วย --all แล้วตัดเอง`));
  }
  console.log("");

  const warn = [];
  const d = chars(homeMeta.description);
  if (!d) warn.push("หน้าแรกไม่มี meta description เลย — ต้องเขียนเอง 150–160 ตัวอักษร");
  else if (d < 150) warn.push(`description หน้าแรก ${d} ตัวอักษร — ต่ำกว่าพื้น 150 ที่ verify-build บังคับ ต้องขยายก่อน build ผ่าน`);
  else if (d > 160) warn.push(`description หน้าแรก ${d} ตัวอักษร — เกิน 160 Google จะตัดท้ายทิ้ง`);
  if (counts.h1 !== 1) warn.push(`เจอ H1 ${counts.h1} อัน — หน้าเดียวต้องมี 1 อันเท่านั้น`);
  if (skippedDeepHeadings) warn.push(`ข้าม h4–h6 ${skippedDeepHeadings} อัน — บนเว็บเดิมมันเป็นป้ายการ์ดในวิดเจ็ต ไม่ใช่หัวข้อบทความ`);

  const ownBrands = brandTokens(`${homeMeta.title} ${homeMeta.description}`);
  const strays = new Map();
  for (const s of subs) {
    const miss = [!s.title && "Title", !s.description && "Meta"].filter(Boolean);
    if (miss.length) warn.push(`หน้า ${s.label} ไม่มี ${miss.join(" และ ")} บนเว็บเดิม — agent ต้องเขียนเอง`);
    if (s.empty) warn.push(`หน้า ${s.label} ไม่มีเนื้อความบนเว็บเดิม (เป็นหน้าปุ่ม)`);
    for (const t of brandTokens(`${s.title} ${s.description}`)) {
      if (ownBrands.has(t)) continue;
      if (!strays.has(t)) strays.set(t, []);
      strays.get(t).push(s.label);
    }
  }
  for (const [t, where] of strays) {
    warn.push(`${C.bold(t)} โผล่ในหน้า ${where.join(", ")} — เว็บเดิมยังค้างชื่อแบรนด์ก่อนหน้ามันเองอยู่ อย่ายกมาทั้งดุ้น`);
  }
  for (const cfg of SUB_PAGES) {
    if (!subs.some((s) => s.label === cfg.label)) warn.push(`เว็บเดิมไม่มีหน้า ${cfg.label} — template มีหน้านี้อยู่ ให้ agent ตั้ง title/meta เอง`);
  }

  if (warn.length) {
    console.log(`${C.yellow("ต้องรู้ก่อนรีแบรนด์")}`);
    for (const w of warn) console.log(`  • ${w}`);
    console.log("");
  }

  if (!opts.write) {
    console.log(C.dim("────────── ผลลัพธ์ (ยังไม่เขียนไฟล์) ──────────"));
    console.log(text);
    console.log(C.dim("──────────────────────────────────────────────"));
    console.log(`  พอใจแล้วสั่ง ${C.bold("--write")} เพื่อเขียนลง src/assets/content.txt\n`);
    return;
  }

  if (existsSync(OUT) && !opts.force) {
    const old = readFileSync(OUT, "utf8");
    console.error(`${C.red("หยุด")} src/assets/content.txt มีอยู่แล้ว (${chars(old)} ตัวอักษร) — brief ของแบรนด์ที่ใช้อยู่`);
    console.error(`  บรรทัดแรก: ${old.split("\n").slice(0, 2).join(" / ").slice(0, 70)}`);
    console.error(`\n  ถ้าตั้งใจทับ ใส่ ${C.bold("--force")}\n`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(OUT, text, "utf8");
  console.log(`  ${C.green("เขียนแล้ว")} src/assets/content.txt`);

  if (existsSync(OUT_DOCX)) {
    unlinkSync(OUT_DOCX);
    console.log(`  ${C.green("ลบแล้ว")}  src/assets/content.docx (ไม่งั้น brief ของแบรนด์เก่าจะชนะ)`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${C.red("หยุด")} ${e.message}\n`);
  process.exit(1);
});
