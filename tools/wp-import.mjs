import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "src", "assets", "content.txt");
const OUT_DOCX = join(ROOT, "src", "assets", "content.docx");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const USAGE = `
  node tools/wp-import.mjs <url ของเว็บ WordPress> [--write] [--force]

  ไม่ใส่ --write   = แสดงผลให้ดูเฉยๆ ไม่เขียนไฟล์
  --write          = เขียน src/assets/content.txt
  --force          = ยอมทับ content.txt ที่มีอยู่ (และลบ content.docx)

  ดึงเนื้อหาผ่าน WP REST API (/wp-json/wp/v2/pages) แล้วแปลงเป็นรูปแบบ brief
  ที่ uploader กับ skill รีแบรนด์อ่านอยู่แล้ว รูปภาพไม่ได้ดึงมา — อัปผ่าน
  uploader ตามปกติ เพราะที่นั่นย่อขนาด ตั้งชื่อ และลบของแบรนด์เก่าให้ถูกต้อง
`;

const argv = process.argv.slice(2);
const opts = { write: argv.includes("--write"), force: argv.includes("--force") };
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

// Cloudflare in front of these sites answers 403 to any client that does not
// look like a browser, so the User-Agent is load-bearing, not politeness.
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

const clean = (s) => decodeEntities(stripTags(s)).replace(/ /g, " ").replace(/\s+/g, " ").trim();

const withoutCode = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");

/** Headings and paragraphs of one WP page, in document order. */
function blocksOf(html) {
  const out = [];
  const re = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<p\b[^>]*>([\s\S]*?)<\/p>|<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  for (const m of withoutCode(html).matchAll(re)) {
    const tag = (m[1] || (m[3] !== undefined ? "p" : "li")).toLowerCase();
    const text = clean(m[2] ?? m[3] ?? m[4] ?? "");
    if (text) out.push({ tag, text });
  }
  return out;
}

const metaOf = (html) => ({
  title: clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""),
  description: clean((html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) || [])[1] || ""),
});

// Thai section names parseSubPages() matches on — keep these spellings, they are
// the keys in the uploader's PAGE_META table.
const SUB_PAGES = [
  { label: "โปรโมชั่น", slugs: ["promotion", "promotions", "promo"] },
  { label: "ติดต่อเรา", slugs: ["contract", "contact", "contact-us", "contactus"] },
  { label: "ทดลองเล่น", slugs: ["testplay", "demo", "try", "tryplay"] },
  { label: "ทางเข้า", slugs: ["entrance", "login", "link"] },
];

const chars = (s) => [...s].length;

async function main() {
  console.log(`\n${C.bold("ดึงจาก")} ${ORIGIN}`);

  let pages;
  try {
    pages = await get(`${ORIGIN}/wp-json/wp/v2/pages?per_page=100`, "json");
  } catch (e) {
    console.error(`\n${C.red("หยุด")} เรียก WP REST API ไม่สำเร็จ — ${e.message}`);
    console.error(`  เว็บนี้อาจปิด REST API ไว้ หรือไม่ได้ใช้ WordPress\n`);
    process.exit(1);
  }
  if (!Array.isArray(pages) || !pages.length) {
    console.error(`\n${C.red("หยุด")} REST API ตอบมาแต่ไม่มีหน้าเลย\n`);
    process.exit(1);
  }

  const norm = (u) => String(u || "").replace(/\/+$/, "");
  const home = pages.find((p) => norm(p.link) === norm(ORIGIN)) ?? pages[0];
  console.log(`  เจอ ${pages.length} หน้า · หน้าแรก = ${C.bold(clean(home.title?.rendered || home.slug))}`);

  const homeMeta = metaOf(await get(home.link));
  const blocks = blocksOf(home.content?.rendered || "");

  const lines = [];
  if (homeMeta.title) lines.push("Title", homeMeta.title);
  if (homeMeta.description) lines.push("Description", homeMeta.description);

  const counts = { h1: 0, h2: 0, h3: 0, para: 0 };
  for (const b of blocks) {
    if (b.tag === "h1" || b.tag === "h2" || b.tag === "h3") {
      const level = b.tag === "h1" ? "H1" : b.tag === "h2" ? "H2" : "H3";
      lines.push("", `${level}:${b.text}`);
      counts[b.tag]++;
    } else {
      lines.push(b.text);
      counts.para++;
    }
  }

  const subs = [];
  for (const cfg of SUB_PAGES) {
    const p = pages.find((x) => cfg.slugs.includes(decodeURIComponent(x.slug || "").toLowerCase()));
    if (!p || p.id === home.id) continue;
    const m = metaOf(await get(p.link));
    subs.push({ ...cfg, link: p.link, ...m, empty: !clean(p.content?.rendered || "") });
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

  console.log(`\n${C.bold("ที่ดึงได้")}  H1×${counts.h1} · H2×${counts.h2} · H3×${counts.h3} · ย่อหน้า ${counts.para} · ${chars(text)} ตัวอักษร\n`);

  const warn = [];
  const d = chars(homeMeta.description);
  if (!d) warn.push("หน้าแรกไม่มี meta description เลย — ต้องเขียนเอง 150–160 ตัวอักษร");
  else if (d < 150) warn.push(`description หน้าแรก ${d} ตัวอักษร — ต่ำกว่าพื้น 150 ที่ verify-build บังคับ ต้องขยายก่อน build ผ่าน`);
  else if (d > 160) warn.push(`description หน้าแรก ${d} ตัวอักษร — เกิน 160 Google จะตัดท้ายทิ้ง`);
  if (counts.h1 !== 1) warn.push(`เจอ H1 ${counts.h1} อัน — หน้าเดียวต้องมี 1 อันเท่านั้น`);

  for (const s of subs) {
    const miss = [!s.title && "Title", !s.description && "Meta"].filter(Boolean);
    if (miss.length) warn.push(`หน้า ${s.label} ไม่มี ${miss.join(" และ ")} บนเว็บเดิม — agent ต้องเขียนเอง`);
    if (s.empty) warn.push(`หน้า ${s.label} เนื้อหาว่างเปล่าบนเว็บเดิม`);
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

  // A .txt brief must leave no .docx behind: readDocxSubPages() and the rebrand
  // agent both read the .docx first, so a leftover one silently wins over this.
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
