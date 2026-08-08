// Local-only rebrand console.
// Run with: npm run rebrand:upload   (opens http://localhost:4444)
//
// Four jobs, in the order an operator does them:
//   1. STAGE (ส่วนที่ 1-5) — copy a new brand's files into src/assets and public
//      with the exact filenames + extensions the components import, so the
//      "extension drift" bug class (Phase 4 of the rebrand-site skill) can't
//      happen; plus the aff/LINE links and sub-page Title/Meta.
//   2. RUN (ส่วนที่ 6) — spawn `claude -p` headless on this repo to perform the
//      rebrand itself, and stream its progress back to the page over SSE.
//      It stops at build + verify: it never deploys and never pushes.
//   3. SHIP (ส่วนที่ 7) — build + preview locally, then `wrangler deploy`.
//   4. SAVE (ส่วนที่ 8) — commit everything and push to `origin`, on whatever
//      branch is checked out. Never switches branch, never force-pushes.
//
// Deps: Node built-ins + sharp (already in package.json). No new dependency.

import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFile, unlink, writeFile, mkdir, stat, rename } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const ASSETS = join(ROOT, "src", "assets");
const PUBLIC = join(ROOT, "public");
const PAGES = join(ROOT, "src", "pages");
// Astro routes src/pages only, so this is where a page goes to be switched off
// without losing it. The rebrand skill parks preset pages here when a brand did
// not ask for them; createPage() looks here before scaffolding a second copy.
const PAGES_DISABLED = join(ROOT, "src", "pages-disabled");
const CONFIG = join(ROOT, "astro.config.mjs");
// Port/host are env-overridable but the localhost-only bind is load-bearing,
// not a nicety: there is NO auth on any endpoint, /upload rewrites source files,
// and /rebrand/start spawns a Claude session with --permission-mode
// bypassPermissions. Anyone who can reach this port can therefore run arbitrary
// code on this machine. HOST=0.0.0.0 is FORBIDDEN until real auth + HTTPS exist
// (see the rebrand web-UI plan); the default keeps a bare run safe.
const PORT = Number(process.env.PORT) || 4444;
const HOST = process.env.HOST || "127.0.0.1";

const IMAGE_EXTS = ["png", "webp", "jpg", "jpeg", "avif", "gif", "svg"];

// Cap the stored source width. 2560px covers a full-bleed hero on a 27" QHD
// monitor without upscaling smaller uploads — only genuinely oversized files
// (e.g. a 4000px export) get downscaled, so the repo can't bloat while big
// screens still stay crisp. Bump this if you serve 4K-native hero art.
const MAX_SOURCE_WIDTH = 2560;

// Promotion / carousel slides are never rendered wider than 600px
// (SmoothCarousel uses widths=[200,400,600]), so storing the full-size export
// is wasted bytes. Fit inside a 600x600 box: keeps aspect ratio, never crops,
// never upscales a smaller upload.
const SLIDE_BOX = 600;

// Phone hero art. 1080 covers a 360 CSS-px viewport at DPR 3, which is the
// widest real phone case — storing the 2560 the desktop banner allows would be
// paying for pixels no phone can show.
const MOBILE_BANNER_WIDTH = 1080;

// A solid colour / gradient background is NOT rendered as an image — that would
// ship a full-screen bitmap for something that is just a CSS declaration. The
// uploader instead writes src/assets/bg.json, which MainLayout reads to decide:
//   { "mode": "image" }                          → <Image> the bg.png (default)
//   { "mode": "color", "color": "#rrggbb" }       → CSS background-color, 0 bytes
//   { "mode": "gradient", "css": "linear-…" }     → CSS gradient, 0 bytes
// bg.png is kept on disk either way so image mode always has a source to import.
const BG_CONFIG = join(ASSETS, "bg.json");

// Normalize an upload before it is stored: downscale only when larger than the
// limit (never upscale). Returns a sharp pipeline the caller finishes + writes.
async function prep(buf, { maxWidth = MAX_SOURCE_WIDTH, box = null } = {}) {
  const meta = await sharp(buf).metadata();
  let img = sharp(buf);
  if (box) {
    img = img.resize({ width: box, height: box, fit: "inside", withoutEnlargement: true });
  } else if (meta.width && meta.width > maxWidth) {
    img = img.resize({ width: maxWidth });
  }
  return img;
}

// Remove same-base image files with a different extension so a hardcoded import
// or a glob (e.g. logo.*, banner*.{png,webp,...}) can't pick a stale leftover.
async function cleanupSiblings(dir, base, keepExt) {
  for (const ext of IMAGE_EXTS) {
    if (ext === keepExt) continue;
    try {
      await unlink(join(dir, `${base}.${ext}`));
    } catch {
      /* not present — fine */
    }
  }
}

// sharp cannot write .ico. Wrap a PNG payload in a minimal ICO container
// (ICO supports embedded PNG since Windows Vista; modern browsers read it).
function buildIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width  (0 => 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8); // size of image data
  entry.writeUInt32LE(6 + 16, 12); // offset of image data
  return Buffer.concat([header, entry, pngBuffer]);
}

async function toPng(buf, dir, base, opts) {
  // Lossless PNG optimization: identical pixels, ~80% smaller than sharp's
  // default png() on photographic banners/slides. No banding, safe for hero art.
  const img = await prep(buf, opts);
  await img.png({ compressionLevel: 9, effort: 10 }).toFile(join(dir, `${base}.png`));
  await cleanupSiblings(dir, base, "png");
  return `${base}.png`;
}

// og:image. Every page declares twitter:card = summary_large_image, which wants
// roughly 1.91:1 at about 1200x630. slide1 is stored inside a 600x600 box, so
// the card was rendering a small square — the layout Twitter and Facebook use
// for a "large image" card does not exist at that aspect ratio.
//
// Letterboxed, not cropped: these are promo banners whose whole point is the
// text printed on them, and a centre crop of a square banner to 1.91:1 cuts the
// brand name off the top and the call to action off the bottom. The padding
// colour is sampled from the artwork, so it reads as part of the design instead
// of as two black bars.
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

async function toOgImage(buf, dir) {
  let background = { r: 10, g: 10, b: 9 };
  try {
    const { dominant } = await sharp(buf).stats();
    if (dominant) background = dominant;
  } catch {
    // stats() can fail on odd inputs; the near-black default is fine.
  }
  await sharp(buf)
    .resize({ width: OG_WIDTH, height: OG_HEIGHT, fit: "contain", background })
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(join(dir, "og.png"));
  await cleanupSiblings(dir, "og", "png");
  return "og.png";
}

async function toWebp(buf, dir, base, opts) {
  const img = await prep(buf, opts);
  await img.webp({ quality: 90, effort: 6 }).toFile(join(dir, `${base}.webp`));
  await cleanupSiblings(dir, base, "webp");
  return `${base}.webp`;
}

// sharp can't vectorize a bitmap. For a raster favicon, wrap a square PNG as a
// base64 data URI inside a minimal SVG so favicon.svg still refreshes with the
// new brand instead of keeping the previous one. (A real .svg upload is written
// through untouched — see the favicon slot.)
// 128, not 512: this wrapper base64s a PNG, and base64 costs ~4 bytes per 3, so
// the size here lands almost squared on the file. At 512 the generated
// favicon.svg measured 210,922 bytes — larger than the hero image — and it is
// linked in every page's <head> as type="image/svg+xml", which Chrome prefers
// over the .ico and .png siblings. A favicon is drawn at 16-32 CSS px; 128
// still covers 2-3x DPR and macOS's larger tab icons, at roughly 1/16th the
// bytes.
async function rasterToSvg(buf, size = 128) {
  const png = await sharp(buf)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
      `<image width="${size}" height="${size}" href="${dataUri}"/>` +
      `</svg>\n`,
    "utf8",
  );
}

// ── Background: image | solid colour | gradient ─────────────────────────────
// The three are mutually exclusive; handleBackground() below enforces that
// exactly one of them was supplied and rejects zero or two+.

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// Validate + expand to 6-digit lowercase. Every colour that reaches the CSS
// string / bg.json goes through here, so an operator can never inject arbitrary
// CSS (e.g. `red;url(...)`) into the value MainLayout drops into a style attr.
function hexColor(value, label) {
  const s = String(value ?? "").trim();
  if (!HEX_RE.test(s)) {
    throw new Error(`${label} ต้องเป็นรหัสสี hex เช่น #1a2b3c (ได้รับ: ${s || "ว่าง"})`);
  }
  const body = s.slice(1).toLowerCase();
  return "#" + (body.length === 3 ? [...body].map((c) => c + c).join("") : body);
}

function angleDeg(value) {
  const n = Number(String(value ?? "").trim() || 180);
  if (!Number.isFinite(n)) throw new Error(`มุมไล่สีต้องเป็นตัวเลข (ได้รับ: ${value})`);
  return ((n % 360) + 360) % 360;
}

// The CSS value MainLayout paints. Built from validated hex + a clamped angle,
// and it is exactly the string the browser preview shows — no image involved.
function gradientCss({ type, from, to, angle }) {
  return type === "radial"
    ? `radial-gradient(circle at 50% 50%, ${from}, ${to})`
    : `linear-gradient(${angle}deg, ${from}, ${to})`;
}

// Persist the chosen background mode for MainLayout. Colour/gradient ship as a
// CSS string (no bitmap); image mode resets the config so a previously stored
// colour/gradient can't keep overriding the freshly uploaded bg.png.
async function writeBgConfig(config) {
  await writeFile(BG_CONFIG, JSON.stringify(config, null, 2) + "\n");
  return "bg.json";
}

async function handleBackground(params, buf) {
  const color = (params.get("color") || "").trim();
  const from = (params.get("from") || "").trim();
  const to = (params.get("to") || "").trim();

  // The 3 conditions — exactly one must be present.
  const picked = [
    buf.length > 0 && "image",
    color !== "" && "color",
    (from !== "" || to !== "") && "gradient",
  ].filter(Boolean);

  if (picked.length === 0) {
    throw new Error("background: ต้องเลือก 1 อย่าง — อัพโหลดรูป / เลือกสีเดียว / ไล่สี (gradient)");
  }
  if (picked.length > 1) {
    throw new Error(`background: เลือกได้อย่างเดียวเท่านั้น แต่ส่งมา ${picked.length} อย่าง (${picked.join(" + ")})`);
  }

  switch (picked[0]) {
    case "image": {
      const png = await toPng(buf, ASSETS, "bg");
      const cfg = await writeBgConfig({ mode: "image" });
      return [png, cfg];
    }
    case "color":
      return [await writeBgConfig({ mode: "color", color: hexColor(color, "สีพื้นหลัง") })];
    case "gradient": {
      const type = params.get("type") === "radial" ? "radial" : "linear";
      const css = gradientCss({
        type,
        from: hexColor(from, "สีเริ่มต้นของ gradient"),
        to: hexColor(to, "สีปลายทางของ gradient"),
        angle: angleDeg(params.get("angle")),
      });
      return [await writeBgConfig({ mode: "gradient", css })];
    }
  }
}

// ── Text links: affiliate redirect + LINE redirect ──────────────────────────
// These are not files — they are string literals living inside source files:
//   • login.astro / register.astro:  const targetUrl = "<aff>";
//   • astro.config.mjs redirects:     "/line": "<line>",
// The uploader edits those literals in place so an operator can rebrand the
// links without touching code. Both values land inside a double-quoted string,
// so validateLink() rejects anything that isn't a clean http(s) URL — an
// operator can never inject a stray quote/newline and break the file.

const AFF_RE = /(const\s+targetUrl\s*=\s*)"[^"]*"/;
const LINE_RE = /("\/line"\s*:\s*)"[^"]*"/;

function validateLink(value, label) {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${label}: ยังไม่ได้กรอกลิงก์`);
  if (/["'\n\r\\]/.test(s)) throw new Error(`${label}: ลิงก์มีอักขระต้องห้าม (\" ' \\ หรือขึ้นบรรทัดใหม่)`);
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`${label}: ต้องเป็น URL ที่ถูกต้อง เช่น https://example.com/abc (ได้รับ: ${s})`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`${label}: รองรับเฉพาะ http/https (ได้รับ: ${u.protocol})`);
  }
  return s;
}

// Replace `regex`'s captured literal in one file; error if the anchor is gone
// (e.g. someone renamed targetUrl) rather than silently writing nothing.
async function replaceInFile(file, regex, value, label) {
  const src = await readFile(file, "utf8");
  if (!regex.test(src)) throw new Error(`${label}: ไม่พบตำแหน่งลิงก์ในไฟล์ ${file}`);
  await writeFile(file, src.replace(regex, `$1"${value}"`));
}

async function handleAffLink(value) {
  const url = validateLink(value, "ลิงก์ aff");
  await replaceInFile(join(PAGES, "login.astro"), AFF_RE, url, "ลิงก์ aff (login)");
  await replaceInFile(join(PAGES, "register.astro"), AFF_RE, url, "ลิงก์ aff (register)");
  return ["src/pages/login.astro", "src/pages/register.astro"];
}

async function handleLineLink(value) {
  const url = validateLink(value, "ลิงก์ไลน์");
  await replaceInFile(CONFIG, LINE_RE, url, "ลิงก์ไลน์ (/line)");
  return ["astro.config.mjs"];
}

// Read the links currently in the source so the UI can pre-fill its inputs.
async function readCurrentLinks() {
  const out = { aff: "", line: "" };
  try {
    out.aff = (await readFile(join(PAGES, "login.astro"), "utf8")).match(AFF_RE)?.[0]?.match(/"([^"]*)"/)?.[1] || "";
  } catch { /* file missing — leave blank */ }
  try {
    out.line = (await readFile(CONFIG, "utf8")).match(LINE_RE)?.[0]?.match(/:\s*"([^"]*)"/)?.[1] || "";
  } catch { /* file missing — leave blank */ }
  return out;
}

// ── Sub-page SEO: Title + Meta description, sourced from content.docx ────────
// The four sub-pages set their <title>/<meta name="description"> via props on a
// single <MainLayout title="..." description="..."> tag (MainLayout renders them
// into the head + OG/Twitter). The brand's content.docx carries a
// "SUB-PAGES (Title & Meta Description)" section with a [heading] per page and a
// "Title:" / "Meta:" line under each. The uploader parses that section so an
// operator can pull the copy in, review it, and save it into the pages.
//
// Which page each entry maps to: keyed by the Thai heading used in the docx,
// matched loosely (with/without brackets, a few synonyms) so small wording
// differences still land on the right file.
const PAGE_META = {
  promotion: { file: "promotion.astro", label: "โปรโมชั่น", match: ["โปรโมชั่น", "promotion"] },
  contactus: { file: "contact-us.astro", label: "ติดต่อเรา", match: ["ติดต่อเรา", "ติดต่อ", "contact"] },
  demo: { file: "ทดลองเล่น.astro", label: "ทดลองเล่น", match: ["ทดลองเล่น", "ทดลอง", "demo"] },
  entrance: { file: "ทางเข้า.astro", label: "ทางเข้า", match: ["ทางเข้า", "entrance"] },
};

// ── Optional extra pages the operator can toggle on ─────────────────────────
// Unlike PAGE_META (which edits pages that always exist), these files may not
// exist yet. Toggling one on SCAFFOLDS a new src/pages/*.astro — a blank shell
// that inherits the current brand's chrome (it clones the frontmatter of an
// existing sub-page so it picks up whatever Announcement/ContentBox variant the
// brand uses) and gets a nav link wired in — leaving a TODO body for Claude to
// fill from the docx during the rebrand. Toggling off does NOTHING (never
// deletes): off simply means "don't create". `route` is the Astro file-based
// route (Thai filename → Thai route); `navLabel` is the menu text; `boxTitle`
// is the placeholder ContentBox heading. Add a row here to offer another page.
// `kind` decides what switching a page ON means:
//   scaffold — the uploader creates it blank, with a TODO body Claude fills in
//   template — the page already exists in the repo with real content and its own
//              Huay theme; it may only ever be moved in or out of src/pages,
//              never regenerated, or a rebrand would wipe the lottery copy
const PRESET_PAGES = {
  article: { kind: "scaffold", file: "บทความ.astro", route: "/บทความ", navLabel: "บทความ", boxTitle: "บทความ", icon: "📰" },
  aboutus: { kind: "scaffold", file: "about-us.astro", route: "/about-us", navLabel: "เกี่ยวกับเรา", boxTitle: "เกี่ยวกับเรา", icon: "🏢" },
  huaycheck: { kind: "template", file: "ตรวจหวย.astro", route: "/ตรวจหวย", navLabel: "ตรวจหวย", footerLabel: "ตรวจผลรางวัล", boxTitle: "ตรวจหวย", icon: "🔍" },
  huayguide: { kind: "template", file: "แนวทาง.astro", route: "/แนวทาง", navLabel: "แนวทาง", footerLabel: "แนวทางหวย", boxTitle: "แนวทาง", icon: "📊" },
  register: { kind: "cta", file: "register.astro", route: "/register", navLabel: "สมัครสมาชิก", boxTitle: "สมัครสมาชิก", cta: "สมัครสมาชิก", icon: "📝" },
  login: { kind: "cta", file: "login.astro", route: "/login", navLabel: "เข้าสู่ระบบ", boxTitle: "เข้าสู่ระบบ", cta: "เข้าระบบเกม", icon: "🔑" },
};
// A "cta" page replaces the interstitial that auto-forwards to the affiliate
// link with a real page whose only content is one button to the same place.
// The destination is never written here — it rotates per brand and is read back
// out of whatever is already on disk.
const CTA_TARGET_RE = /\btargetUrl\s*=\s*["']([^"']+)["']/;
const LEGACY_TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const LEGACY_DESC_RE = /<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']*)["']/i;
const LEGACY_DESC_RE_ALT = /<meta\b[^>]*\bcontent=["']([^"']*)["'][^>]*\bname=["']description["']/i;
const redirectBackup = (cfg) => join(PAGES_DISABLED, cfg.file.replace(/\.astro$/, ".redirect.astro"));
const isCtaPage = (src) => /<MainLayout\b/.test(src);
// The interstitial these pages replace showed a loading animation on the way to
// the affiliate link, and losing it made the hand-off feel like a dead click.
// The component brings it back on the click instead of on page load, so the
// page itself stays a real indexable page rather than a redirect.
const CTA_REDIRECT_IMPORT = 'import CtaRedirect from "../components/CtaRedirect.astro";';
// /ทางเข้า exists to offer เข้าสู่ระบบ and สมัครสมาชิก and nothing else. Once
// those two are menu entries in their own right it becomes a third link to the
// same two places, so any cta toggle takes it out of the menu and the last one
// switched off puts it back. Only the menu entry moves — the page stays routed,
// because it is linked from the homepage and indexed.
const ENTRANCE = { route: "/ทางเข้า", label: "ทางเข้า", icon: "🚪" };
// The entry is stashed verbatim on the way out so switching back on returns the
// brand's own icon, not a stand-in. Rebuilding it from label + a default icon
// silently repaints one menu row a different colour of emoji than the rest.
const ENTRANCE_STASH = join(PAGES_DISABLED, ".entrance-nav.txt");

async function anyCtaEnabled() {
  for (const cfg of Object.values(PRESET_PAGES)) {
    if (cfg.kind !== "cta") continue;
    try {
      if (isCtaPage(await readFile(join(PAGES, cfg.file), "utf8"))) return true;
    } catch { /* not routed — not enabled */ }
  }
  return false;
}
// A generated page is cloned from this existing sub-page's frontmatter so it
// stays on the brand's current component variants without hardcoding names here.
const CANONICAL_PAGE = "ทางเข้า.astro";
// The layout imports exactly one active navbar; a new page's link must go into
// whichever file that is (it rotates each rebrand), so resolve it dynamically.
const NAV_IMPORT_RE = /import\s+Navbar\s+from\s+["']\.\.\/components\/([^"']+)["']/;

// Anchor on the <MainLayout ...> opening tag specifically. The Thai pages also
// pass a title= to <ContentBox>, so a bare /title=/ would hit the wrong tag —
// these two regexes only ever touch attributes inside the MainLayout tag.
const ML_TITLE_RE = /(<MainLayout\b[^>]*?\btitle=)"[^"]*"/;
// Also normalises the pre-existing `,description=` typo in contact-us.astro to a
// clean ` description=` on write.
const ML_DESC_RE = /(<MainLayout\b[^>]*?)[,\s]+description=("|')[^"']*\2/;
// The shape every hand-written page in this repo actually uses: the tag points
// at a const that the page's JSON-LD graph reads too, so one edit keeps both.
const ML_DESC_VAR_RE = /<MainLayout\b[^>]*?[,\s]+description=\{\s*pageDescription\s*\}/;
const PAGE_DESC_CONST_RE = /(const\s+pageDescription\s*=\s*)"[\s\S]*?"/;
// The page's own name in its JSON-LD graph — the first `name:` after the
// pageGraph call opens, before the breadcrumb entries. Retitling the tag but
// not this leaves the structured data claiming the old heading.
const GRAPH_NAME_RE = /(pageGraph\(Astro,\s*\{[\s\S]*?\bname:\s*)"[^"]*"/;

// Title/Meta land inside a double-quoted Astro attribute, so forbid anything
// that would break out of it (quote, angle brackets, backtick, newline). Thai
// text and the "|" separator used in the briefs are fine.
function validateText(value, label) {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${label}: ยังไม่ได้กรอกข้อความ`);
  if (/["'<>`\n\r]/.test(s)) throw new Error(`${label}: ห้ามมีอักขระ \" ' < > \` หรือขึ้นบรรทัดใหม่`);
  return s;
}

// ── Minimal ZIP reader (a .docx is a ZIP; no zip dependency in this repo) ────
// Read via the central directory (reliable sizes/offsets even for streamed
// entries) and inflate the one member we need. Enough for Office-produced docx.
function extractZipEntry(buf, wantName) {
  // End Of Central Directory record: signature 0x06054b50, scan from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ไฟล์ docx ไม่ถูกต้อง (ไม่พบ EOCD ของ ZIP)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // offset of central directory
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // central file header sig
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wantName) {
      // Jump to the local header to find where the data actually starts.
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ไม่พบ ${wantName} ใน docx`);
}

function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// One text line per Word paragraph (concatenate its <w:t> runs).
function docxToLines(xml) {
  const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  const lines = [];
  for (const para of paras) {
    const runs = [...para.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
    const line = decodeXmlEntities(runs.join("")).trim();
    if (line) lines.push(line);
  }
  return lines;
}

// Given the docx lines, find the [heading] blocks and pull the Title/Meta line
// under each, mapping headings to page keys via PAGE_META. best-effort: pages
// not found in the docx are reported in `warnings`, never guessed.
function parseSubPages(lines) {
  const pages = {};
  const found = new Set();
  let current = null; // page key of the section we're inside
  const titleRe = /^\s*title\s*[:：]\s*(.+)$/i;
  const metaRe = /^\s*(?:meta|des|description)\s*[:：]\s*(.+)$/i;
  for (const raw of lines) {
    const line = raw.trim();
    // A heading line switches the current section. Strip brackets, then see
    // whether any page's match-terms appear in it.
    const bare = line.replace(/^\[|\]$/g, "").trim();
    const hit = Object.entries(PAGE_META).find(
      ([, cfg]) => cfg.match.some((m) => bare.includes(m)),
    );
    // Treat a line as a heading only when it's short and not a Title/Meta line —
    // avoids a long paragraph that merely mentions "โปรโมชั่น" flipping sections.
    if (hit && bare.length <= 40 && !titleRe.test(line) && !metaRe.test(line)) {
      current = hit[0];
      pages[current] ??= { title: "", meta: "" };
      continue;
    }
    if (!current) continue;
    const t = line.match(titleRe);
    if (t) { pages[current].title = t[1].trim(); found.add(current); continue; }
    const d = line.match(metaRe);
    if (d) { pages[current].meta = d[1].trim(); found.add(current); }
  }
  // Keep only pages that yielded at least a title or meta.
  const result = {};
  for (const key of found) result[key] = pages[key];
  const warnings = Object.keys(PAGE_META)
    .filter((k) => !result[k])
    .map((k) => `${PAGE_META[k].label}: ไม่พบใน docx`);
  return { pages: result, warnings };
}

// Parse a docx buffer straight into sub-page copy — used both for the staged
// file and for a file the operator has only browsed (not uploaded yet), so the
// preview reflects the source they actually picked.
function parseDocxBuffer(buf) {
  const xml = extractZipEntry(buf, "word/document.xml").toString("utf8");
  return parseSubPages(docxToLines(xml));
}

// A .docx is a ZIP, so its first four bytes are the local-file-header magic.
// Sniffing the bytes rather than trusting the extension means a brief saved as
// "content.docx" that is really plain text still reads, and vice versa.
function looksLikeDocx(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

// Decode a plain-text brief. This is the whole difficulty of accepting .txt:
// Notepad's "ANSI" on a Thai Windows is windows-874, not UTF-8, and decoding
// those bytes as UTF-8 yields text that is wrong in a way nothing downstream
// can detect — the rebrand would simply write mojibake into every page. So:
// honour a BOM if there is one, then try UTF-8 in FATAL mode, and only fall
// back to windows-874 when that throws. Strict mode is what makes the fallback
// safe; non-fatal UTF-8 would "succeed" on cp874 bytes and hand back U+FFFD.
function decodeTextBrief(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-874").decode(buf);
  }
}

function briefTextToLines(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// One entry point for "whatever the operator handed us as the brief".
function parseBriefBuffer(buf) {
  if (looksLikeDocx(buf)) return parseDocxBuffer(buf);
  return parseSubPages(briefTextToLines(decodeTextBrief(buf)));
}

// ── Pre-chew the brief and the artwork for the rebrand agent ────────────────
// Both of these exist purely to delete work from the *serial* head of a rebrand
// (SKILL Phase 1 / step P0). Nothing else can start until the brief is read and
// the palette is known, so every second saved there is a second off the whole
// run — unlike the parallel phase, where more agents can absorb the work.

// The uploader already extracts every paragraph of the docx for ส่วนที่ 4; it
// just used to throw all of it away except the SUB-PAGES section. Writing the
// full text out means Phase 1 is a single Read instead of an unzip + python
// round-trip (which also carried a Windows-vs-posix path footgun).
async function writeContentText(buf) {
  try {
    const lines = docxToLines(extractZipEntry(buf, "word/document.xml").toString("utf8"));
    if (!lines.length) return null;
    await writeFile(join(ASSETS, "content.txt"), lines.join("\n") + "\n", "utf8");
    return "content.txt";
  } catch {
    // An unparseable docx still stages fine — the agent falls back to unzip.
    return null;
  }
}

// Artwork the palette is read from, in priority order (logo first: it carries
// the brand's core hue most cleanly, with the least background noise).
const PALETTE_SOURCES = ["logo.webp", "banner1.png", "slide1.png"];

// Measure an image's most-used colours instead of asking an agent to eyeball
// them. sharp is already a dependency, and exact hex beats a guess.
async function topColors(file, count = 5) {
  const { data, info } = await sharp(file)
    .resize(64, 64, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bins = new Map();
  let total = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] < 128) continue; // logos are cut-outs; transparent pixels aren't brand colour
    total++;
    // 5 bits per channel: coarse enough that a gradient or JPEG noise collapses
    // into one bucket, fine enough to keep distinct brand hues apart.
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    const cur = bins.get(key);
    if (cur) {
      cur.n++; cur.r += data[i]; cur.g += data[i + 1]; cur.b += data[i + 2];
    } else {
      bins.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
    }
  }
  if (!total) return null;

  // average each bucket back out so the hex is a real colour from the image,
  // not the quantised corner of its bin
  const swatches = [...bins.values()].map((c) => {
    const r = Math.round(c.r / c.n), g = Math.round(c.g / c.n), b = Math.round(c.b / c.n);
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
    const light = (max + min) / 2;
    const sat = max === min ? 0 : (max - min) / (light > 0.5 ? 2 - max - min : max + min);
    return {
      hex: "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""),
      share: Math.round((c.n / total) * 1000) / 1000,
      n: c.n, sat, light,
    };
  });

  const strip = ({ hex, share }) => ({ hex, share });

  // Two lists, because they answer different questions and the loudest colour
  // is usually the wrong one to theme with. A banner is mostly dark background,
  // so `dominant` alone returns five shades of near-black and buries the accent
  // that the retheme actually needs. `vivid` scores saturation alongside area,
  // and drops near-black / near-white / grey, so the brand hue surfaces.
  return {
    dominant: swatches.sort((a, b) => b.n - a.n).slice(0, count).map(strip),
    vivid: swatches
      .filter((c) => c.sat >= 0.15 && c.light >= 0.12 && c.light <= 0.95)
      .sort((a, b) => b.sat * b.share - a.sat * a.share)
      .slice(0, count)
      .map(strip),
  };
}

// Recomputed from whatever is currently staged, so it is always in sync with
// the images on disk no matter what order the operator uploaded them in.
async function writePalette() {
  const sources = {};
  for (const name of PALETTE_SOURCES) {
    try {
      const colors = await topColors(join(ASSETS, name));
      if (colors) sources[name] = colors;
    } catch {
      // not staged yet, or not readable — just leave it out
    }
  }
  if (!Object.keys(sources).length) return null;
  await writeFile(join(ASSETS, "palette.json"), JSON.stringify({ sources }, null, 2) + "\n", "utf8");
  return "palette.json";
}

async function readDocxSubPages() {
  // content.docx first: when both exist, content.txt was derived FROM it, and
  // the docx is what the operator actually handed over.
  try {
    return parseDocxBuffer(await readFile(join(ASSETS, "content.docx")));
  } catch {
    /* no docx, or unreadable — try the text brief */
  }
  try {
    return parseSubPages(briefTextToLines(await readFile(join(ASSETS, "content.txt"), "utf8")));
  } catch {
    return { pages: {}, warnings: ["ยังไม่มี content.docx หรือ content.txt — อัพโหลด Content brief ในส่วนที่ 1 ก่อน"] };
  }
}

// Read the title/description currently on each page's <MainLayout> tag so the UI
// can pre-fill (and so the operator sees what a blank docx result falls back to).
async function readCurrentPageMeta() {
  const out = {};
  for (const [key, cfg] of Object.entries(PAGE_META)) {
    const entry = { file: `src/pages/${cfg.file}`, label: cfg.label, title: "", meta: "" };
    try {
      const src = await readFile(join(PAGES, cfg.file), "utf8");
      entry.title = src.match(ML_TITLE_RE)?.[0]?.match(/"([^"]*)"$/)?.[1] || "";
      entry.meta = src.match(ML_DESC_RE)?.[0]?.match(/description=("|')([^"']*)\1/)?.[2] || "";
    } catch { /* file missing — leave blank */ }
    out[key] = entry;
  }
  return out;
}

// Write Title/Meta onto a file's <MainLayout> tag. Errors (rather than silently
// no-ops) if either prop anchor is missing. Shared by the existing sub-pages and
// the optional preset pages, which use the same <MainLayout title/desc> shape.
async function setMainLayoutMeta(file, title, desc, label) {
  const t = validateText(title, `Title ${label}`);
  const d = validateText(desc, `Meta ${label}`);
  const src = await readFile(file, "utf8");
  if (!ML_TITLE_RE.test(src)) throw new Error(`${label}: ไม่พบ title บนแท็ก <MainLayout>`);
  // Two shapes in the wild: description="..." inline on the tag, and
  // description={pageDescription} pointing at a const the JSON-LD graph also
  // reads. Editing only the inline form would silently skip every page written
  // the second way — and leave the graph disagreeing with the meta tag.
  const quoted = ML_DESC_RE.test(src);
  const viaConst = ML_DESC_VAR_RE.test(src) && PAGE_DESC_CONST_RE.test(src);
  if (!quoted && !viaConst) throw new Error(`${label}: ไม่พบ description บนแท็ก <MainLayout>`);
  let next = src.replace(ML_TITLE_RE, `$1"${t}"`);
  next = quoted ? next.replace(ML_DESC_RE, `$1 description="${d}"`) : next.replace(PAGE_DESC_CONST_RE, `$1"${d}"`);
  if (GRAPH_NAME_RE.test(next)) next = next.replace(GRAPH_NAME_RE, `$1"${t}"`);
  await writeFile(file, next);
}

async function writePageMeta(key, title, desc) {
  const cfg = PAGE_META[key];
  if (!cfg) throw new Error(`unknown page: ${key}`);
  const label = `${cfg.label} (${cfg.file})`;
  await setMainLayoutMeta(join(PAGES, cfg.file), title, desc, label);
  return [`src/pages/${cfg.file}`];
}

async function fileExists(p) {
  try { await readFile(p); return true; } catch { return false; }
}

// Scaffold (or refresh) an optional preset page. Title/Meta are OPTIONAL: blank
// is fine — the tool has no AI to "write" copy, so a blank new page gets safe
// default Title/Meta (just enough to build with non-empty SEO) and a ContentBox
// body holding a 1-paragraph placeholder. Claude writes the real Title/Meta AND
// the real ~1-paragraph article at rebrand time (SKILL.md Phase 4.5). If the
// file already exists we NEVER overwrite the body, and only refresh Title/Meta
// when BOTH were supplied (blank = leave the existing page untouched).
const softText = (s) => String(s ?? "").replace(/["'<>`]/g, "").replace(/\s+/g, " ").trim();

// The affiliate destination is per-brand and lives only in these pages, so it is
// read back rather than written here: the page being replaced first, then its
// saved redirect, then the other cta page. A button with nowhere to go is worse
// than an error, so a miss throws.
async function ctaTarget(cfg) {
  const paths = [join(PAGES, cfg.file), redirectBackup(cfg)];
  for (const other of Object.values(PRESET_PAGES)) {
    if (other.kind !== "cta" || other.file === cfg.file) continue;
    paths.push(join(PAGES, other.file), redirectBackup(other));
  }
  for (const p of paths) {
    try {
      const m = (await readFile(p, "utf8")).match(CTA_TARGET_RE);
      if (m) return m[1];
    } catch { /* try the next one */ }
  }
  return null;
}

// Borrow the styling of the button that already points at this route from the
// canonical sub-page, the same trick addFooterLink uses on the footer, so the
// generated button matches the brand without any colour being named here.
async function ctaButtonClass(route) {
  try {
    const src = await readFile(join(PAGES, CANONICAL_PAGE), "utf8");
    const tag = src.match(new RegExp(`<a\\b[^>]*href="${route}"[^>]*>`, "i"));
    return tag?.[0].match(/class="([^"]*)"/)?.[1] || null;
  } catch {
    return null;
  }
}

// Both generated kinds need the same head. Only the imports are taken from the
// canonical sub-page — they carry whichever component variants this brand
// rotated in. Its graph is NOT taken: cloning the frontmatter whole publishes
// the canonical page's name, description and breadcrumb on the new route, and
// leaving the graph out entirely fails verify-build's "indexable page with no
// JSON-LD at all".
function pageHead(canonicalFm, cfg, t, d, extra = "", extraImports = []) {
  const cloned = canonicalFm.split(/\r?\n/).filter((l) => /^\s*import\b/.test(l));
  const missing = extraImports.filter((line) => !cloned.some((l) => l.trim() === line.trim()));
  const imports = [...cloned, ...missing].join("\n");
  const hasGraph = /\bpageGraph\b/.test(imports);
  const parts = [`const pageDescription =\n  "${d}";`];
  if (hasGraph) {
    parts.push(
      `const graph = pageGraph(Astro, {\n` +
        `  name: "${t}",\n` +
        `  description: pageDescription,\n` +
        `  breadcrumb: [\n` +
        `    { name: "หน้าแรก", path: "/" },\n` +
        `    { name: "${cfg.navLabel}", path: "${cfg.route}" },\n` +
        `  ],\n` +
        `});`,
    );
  }
  if (extra.trim()) parts.push(extra.trim());
  return {
    head: `---\n${imports}\n\n${parts.join("\n\n")}\n---\n\n`,
    ldScript: hasGraph ? `  <script type="application/ld+json" set:html={graph} />\n\n` : "",
  };
}

async function createCtaPage(cfg, title, desc, label) {
  const file = join(PAGES, cfg.file);
  const backup = redirectBackup(cfg);
  let existing = null;
  try { existing = await readFile(file, "utf8"); } catch { /* not created yet */ }

  if (existing && isCtaPage(existing)) {
    if (title?.trim() && desc?.trim()) await setMainLayoutMeta(file, title, desc, label);
    return { written: [`src/pages/${cfg.file}`], created: false };
  }

  const target = await ctaTarget(cfg);
  if (!target) throw new Error(`หา targetUrl ของ ${cfg.file} ไม่เจอ — ลิงก์ปลายทางของแบรนด์นี้เก็บอยู่ในหน้าเดิมเท่านั้น ถ้าหน้าเดิมหายไปแล้ว ต้องเอากลับมาก่อน`);

  const t = title?.trim()
    ? validateText(title, `Title ${label}`)
    : softText(existing?.match(LEGACY_TITLE_RE)?.[1]) || cfg.boxTitle;
  const d = desc?.trim()
    ? validateText(desc, `Meta ${label}`)
    : softText(existing?.match(LEGACY_DESC_RE)?.[1] || existing?.match(LEGACY_DESC_RE_ALT)?.[1]) || `หน้า${cfg.navLabel} (อยู่ระหว่างจัดทำเนื้อหา)`;

  const canonical = await readFile(join(PAGES, CANONICAL_PAGE), "utf8");
  const fm = canonical.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) throw new Error(`ไม่พบ frontmatter ใน ${CANONICAL_PAGE} (ต้นแบบหน้าย่อย)`);
  // Only the imports are cloned. They carry whichever component variants this
  // brand rotated in, which is the whole reason to read the canonical page —
  // but its graph names its own route, so publishing that here would put the
  // wrong name and breadcrumb on this page. That one is written fresh.
  const cls = await ctaButtonClass(cfg.route);
  const { head, ldScript } = pageHead(fm[1], cfg, t, d, `const targetUrl = "${target}";\n`, [CTA_REDIRECT_IMPORT]);

  const page =
    head +
    `<MainLayout title="${t}" description={pageDescription}>\n` +
    ldScript +
    `  <Announcement />\n\n` +
    `  <ContentBox title="${cfg.boxTitle}" as="h1">\n` +
    `    <!-- TODO(rebrand): ตั้ง title/description บน <MainLayout> จาก content brief ตอนรีแบรนด์ และจัดสีปุ่มกับ CtaRedirect.astro ให้ตรงพาเลตต์${cls ? "" : " (ยังไม่ได้คลาสจาก " + CANONICAL_PAGE + " — ปุ่มนี้ยังไม่มีสีแบรนด์)"} -->\n` +
    `    <div class="flex justify-center py-8">\n` +
    `      <a\n` +
    `        href={targetUrl}\n` +
    `        rel="nofollow sponsored"\n` +
    `        data-cta-redirect\n` +
    `        aria-label="${cfg.cta}"\n` +
    `        class="${cls || "inline-flex items-center justify-center rounded-lg border border-white/25 bg-white/10 px-10 py-4 text-2xl font-bold"}">\n` +
    `        ${cfg.cta}\n` +
    `      </a>\n` +
    `    </div>\n` +
    `  </ContentBox>\n\n` +
    `  <Navfoot />\n\n` +
    `  <CtaRedirect label="${cfg.navLabel}" />\n` +
    `</MainLayout>\n`;

  // Keep the interstitial we are about to replace: it is the only copy of this
  // brand's affiliate link outside git, and switching the toggle back off
  // restores it rather than leaving /login and /register as dead routes.
  if (existing && !(await fileExists(backup))) {
    await mkdir(PAGES_DISABLED, { recursive: true });
    await writeFile(backup, existing);
  }
  await writeFile(file, page);
  return { written: [`src/pages/${cfg.file}`], created: !existing, replacedRedirect: !!existing, target };
}

async function createPage(key, title, desc) {
  const cfg = PRESET_PAGES[key];
  if (!cfg) throw new Error(`ไม่รู้จักหน้า preset: ${key}`);
  const label = `${cfg.navLabel} (${cfg.file})`;
  if (cfg.kind === "cta") return createCtaPage(cfg, title, desc, label);
  const file = join(PAGES, cfg.file);
  const parked = join(PAGES_DISABLED, cfg.file);
  const hasTitle = !!(title && title.trim());
  const hasDesc = !!(desc && desc.trim());
  if (await fileExists(file)) {
    if (hasTitle && hasDesc) await setMainLayoutMeta(file, title, desc, label);
    return { written: [`src/pages/${cfg.file}`], created: false };
  }
  // Parked by a previous rebrand that wasn't asked for this page (the skill
  // moves it to pages-disabled rather than deleting it). Move it back instead
  // of scaffolding a second copy — otherwise toggling the page on would leave
  // the same filename sitting in two directories, and only one of them routed.
  if (await fileExists(parked)) {
    await rename(parked, file);
    if (hasTitle && hasDesc) await setMainLayoutMeta(file, title, desc, label);
    return { written: [`src/pages/${cfg.file}`], created: false, restored: true };
  }
  // A template page has real content that ships with the repo — there is nothing
  // to scaffold, and generating a placeholder in its place would silently
  // replace the lottery copy with an empty shell.
  if (cfg.kind === "template") {
    throw new Error(`ไม่พบไฟล์ ${cfg.file} ทั้งใน src/pages และ src/pages-disabled — หน้านี้เป็นหน้าที่มากับ template สร้างใหม่ให้ไม่ได้`);
  }
  // new page: blank Title/Meta fall back to safe defaults (Claude rewrites both
  // + the article body when the rebrand runs).
  const t = hasTitle ? validateText(title, `Title ${label}`) : cfg.boxTitle;
  const d = hasDesc ? validateText(desc, `Meta ${label}`) : `หน้า${cfg.navLabel} (อยู่ระหว่างจัดทำเนื้อหา)`;
  const canonical = await readFile(join(PAGES, CANONICAL_PAGE), "utf8");
  const fm = canonical.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) throw new Error(`ไม่พบ frontmatter ใน ${CANONICAL_PAGE} (ต้นแบบหน้าย่อย)`);
  const { head, ldScript } = pageHead(fm[1], cfg, t, d);
  const page =
    head +
    `<MainLayout title="${t}" description={pageDescription}>\n` +
    ldScript +
    `  <Announcement />\n\n` +
    `  <ContentBox title="${cfg.boxTitle}">\n` +
    `    <!-- TODO(rebrand): เขียนบทความจริงของ "${cfg.navLabel}" ~1 ย่อหน้าใน <ContentBox> นี้ + ตั้ง title/description บน <MainLayout> จาก content.docx ตอนรีแบรนด์ -->\n` +
    `    <p class="py-6 text-center text-white/70">อยู่ระหว่างปรับปรุงเนื้อหา</p>\n` +
    `  </ContentBox>\n\n` +
    `  <Navfoot />\n` +
    `</MainLayout>\n`;
  await writeFile(file, page);
  return { written: [`src/pages/${cfg.file}`], created: true };
}

// Switching a page OFF parks it: the file moves out of the routed folder and its
// menu links go, but nothing is deleted. Someone wrote that page, and a brand
// that doesn't want it today may want it back next time — the file is the only
// copy outside git, so removing it would be the one irreversible thing this tool
// does. Off on a page that was already off is a no-op, not an error.
async function disablePage(key) {
  const cfg = PRESET_PAGES[key];
  if (!cfg) throw new Error(`ไม่รู้จักหน้า preset: ${key}`);
  const file = join(PAGES, cfg.file);
  const parked = join(PAGES_DISABLED, cfg.file);
  const written = [];

  // A cta route is never parked. Every navbar, the footer and /ทางเข้า link to
  // /login and /register, so taking the file away turns all of those into dead
  // links. Off restores the interstitial that was there before instead.
  if (cfg.kind === "cta") {
    const backup = redirectBackup(cfg);
    if (!(await fileExists(backup))) return { written: [], parked: false, missing: true };
    await writeFile(file, await readFile(backup, "utf8"));
    await unlink(backup);
    written.push(`src/pages/${cfg.file}`);
    const nav = await removeNavLink(cfg.route);
    if (nav.removed) written.push(`navbar ${nav.navFile} (-${nav.removed})`);
    let entranceBack = 0;
    if (!(await anyCtaEnabled())) {
      let saved = null;
      try { saved = (await readFile(ENTRANCE_STASH, "utf8")).trim() || null; } catch { /* first run, or stash cleaned */ }
      const back = await addNavLink(ENTRANCE.route, ENTRANCE.label, ENTRANCE.icon, saved);
      entranceBack = back.inserted || 0;
      if (entranceBack) {
        written.push(`navbar ${back.navFile} (+${entranceBack} ${ENTRANCE.label})`);
        if (saved) await unlink(ENTRANCE_STASH).catch(() => {});
      }
    }
    return { written, parked: true, reverted: true, navRemoved: nav.removed || 0, entranceRestored: entranceBack };
  }

  if (await fileExists(file)) {
    await mkdir(PAGES_DISABLED, { recursive: true });
    await rename(file, parked);
    written.push(`src/pages-disabled/${cfg.file}`);
  } else if (!(await fileExists(parked))) {
    return { written: [], parked: false, missing: true };
  }

  const nav = await removeNavLink(cfg.route);
  const foot = await removeFooterLink(cfg.route);
  if (nav.removed) written.push(`navbar ${nav.navFile} (-${nav.removed})`);
  if (foot.removed) written.push(`footer ${foot.footerFile} (-${foot.removed})`);
  return { written, parked: true, navRemoved: nav.removed || 0, footerRemoved: foot.removed || 0 };
}

// Best-effort: add a { name, path } entry to the ACTIVE navbar's link arrays
// (resolved from MainLayout's import, since the active file rotates each
// rebrand). Inserts into every inline `[ {…path…} ].map(` array (desktop +
// mobile). Idempotent — skips if the route is already linked. If the navbar
// variant doesn't use that array shape, it writes nothing and returns a warning
// telling the operator/Claude to wire the link by hand.
// ── Menu links, in both the navbar and the footer ───────────────────────────
// Links live in two shapes across the variant library — some navbars declare an
// inline array right before `.map(`, others a named `const menu = [...]` — and
// the footer uses <li><a> markup instead of objects. Rather than a regex per
// shape, find the individual entries and group the ones that sit adjacent
// (separated only by commas and whitespace); each group is one list, whichever
// way it was written. NavbarHuay is the named-const kind, and it is exactly the
// navbar lottery brands use, so handling only the inline shape would fail on
// the one case this is most needed for.
const NAV_ITEM_RE = /\{[^{}]*\bpath:\s*["'][^"']*["'][^{}]*\}/g;
const FOOTER_ITEM_RE = /<li>\s*<a\b[^>]*href="[^"]*"[\s\S]*?<\/a>\s*<\/li>/g;

function linkGroups(src, re) {
  const items = [...src.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length, text: m[0] }));
  const groups = [];
  for (const it of items) {
    const prev = groups[groups.length - 1];
    if (prev && /^[\s,]*$/.test(src.slice(prev[prev.length - 1].end, it.start))) prev.push(it);
    else groups.push([it]);
  }
  return groups;
}

const indentOf = (src, pos) => (src.slice(0, pos).match(/([ \t]*)$/) || ["", ""])[1];

// Append `render(lastItem)` after the final entry of every group. Groups are
// processed back to front so earlier offsets stay valid as the string grows.
// `sep` separates entries — "," between object literals in a JS array, nothing
// between <li> elements, where a comma would render as a visible comma on the
// page. Getting that wrong is silent: the build still passes.
function appendToGroups(src, re, render, sep = ",") {
  const groups = linkGroups(src, re);
  let out = src;
  for (let i = groups.length - 1; i >= 0; i--) {
    const last = groups[i][groups[i].length - 1];
    const indent = indentOf(src, groups[i][0].start);
    out = out.slice(0, last.end) + sep + "\n" + indent + render(last.text) + out.slice(last.end);
  }
  return { out, count: groups.length };
}

// Drop every entry pointing at `route`, plus the separator it leaves behind.
function dropFromGroups(src, re, route) {
  const items = [...src.matchAll(re)].filter((m) => m[0].includes(`"${route}"`) || m[0].includes(`'${route}'`));
  let out = src;
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    let start = m.index;
    let end = m.index + m[0].length;
    // Take the entry's own line: its leading indent, and the comma + newline
    // after it. Deliberately NOT the next line's indent — swallowing that
    // pulls the following entry to column 0, which is how the first version of
    // this left NavbarHuay looking mangled after a single toggle.
    const after = out.slice(end).match(/^,?[ \t]*\r?\n?/);
    if (after) end += after[0].length;
    const before = out.slice(0, start).match(/[ \t]*$/);
    if (before) start -= before[0].length;
    out = out.slice(0, start) + out.slice(end);
  }
  return { out, count: items.length, removed: items.map((m) => m[0]) };
}

// Which navbar/footer is live rotates every rebrand, so resolve from MainLayout
// rather than trusting a remembered filename.
async function activeChrome(kind) {
  const ml = await readFile(join(ROOT, "src", "layouts", "MainLayout.astro"), "utf8");
  const re = kind === "footer"
    ? /import\s+Footer\s+from\s+["']\.\.\/components\/([^"']+)["']/
    : NAV_IMPORT_RE;
  const m = ml.match(re);
  if (!m) return null;
  return { name: m[1], file: join(ROOT, "src", "components", m[1]) };
}

// `verbatim` re-inserts an entry exactly as it was removed, so restoring a menu
// item gives back the icon the brand picked rather than a generic stand-in.
async function addNavLink(route, label, icon, verbatim) {
  const nav = await activeChrome("navbar");
  if (!nav) return { warning: `หา import Navbar ใน MainLayout.astro ไม่เจอ — เพิ่มลิงก์ ${route} (${label}) ในเมนูเองตอนรีแบรนด์` };
  let src;
  try { src = await readFile(nav.file, "utf8"); }
  catch { return { navFile: nav.name, warning: `เปิด navbar ${nav.name} ไม่ได้ — เพิ่มลิงก์ ${route} (${label}) ในเมนูเองตอนรีแบรนด์` }; }
  if (src.includes(`path: "${route}"`) || src.includes(`path: '${route}'`)) {
    return { navFile: nav.name, already: true };
  }
  // Every menu item in this library carries an icon; an entry without one reads
  // as a gap in the row. Only skip it on a navbar whose entries have none.
  const usesIcons = /\bicon:\s*["']/.test(src);
  const entry = verbatim || `{ name: "${label}", path: "${route}"${usesIcons && icon ? `, icon: "${icon}"` : ""} }`;
  const { out, count } = appendToGroups(src, NAV_ITEM_RE, () => entry);
  if (!count) return { navFile: nav.name, warning: `navbar ${nav.name} ไม่ตรงรูปแบบ array ที่รองรับ — เพิ่มลิงก์ ${route} (${label}) ในเมนูเองตอนรีแบรนด์` };
  await writeFile(nav.file, out);
  return { navFile: nav.name, inserted: count };
}

async function removeNavLink(route) {
  const nav = await activeChrome("navbar");
  if (!nav) return { removed: 0 };
  let src;
  try { src = await readFile(nav.file, "utf8"); } catch { return { removed: 0 }; }
  const { out, count, removed } = dropFromGroups(src, NAV_ITEM_RE, route);
  if (count) await writeFile(nav.file, out);
  return { navFile: nav.name, removed: count, entry: removed[0] || null };
}

async function addFooterLink(route, label) {
  const foot = await activeChrome("footer");
  if (!foot) return { removed: 0 };
  let src;
  try { src = await readFile(foot.file, "utf8"); } catch { return { footerFile: null }; }
  if (src.includes(`href="${route}"`)) return { footerFile: foot.name, already: true };
  // clone the sibling's classes so the new row matches the brand's styling
  const { out, count } = appendToGroups(src, FOOTER_ITEM_RE, (sibling) => {
    const cls = sibling.match(/class="([^"]*)"/);
    return `<li><a href="${route}"${cls ? ` class="${cls[1]}"` : ""}>${label}</a></li>`;
  }, ""); // HTML list — no separator between items
  if (!count) return { footerFile: foot.name, warning: `footer ${foot.name} ไม่มีลิสต์ลิงก์ที่รองรับ — เพิ่มลิงก์ ${route} เองตอนรีแบรนด์` };
  await writeFile(foot.file, out);
  return { footerFile: foot.name, inserted: count };
}

async function removeFooterLink(route) {
  const foot = await activeChrome("footer");
  if (!foot) return { removed: 0 };
  let src;
  try { src = await readFile(foot.file, "utf8"); } catch { return { removed: 0 }; }
  const { out, count } = dropFromGroups(src, FOOTER_ITEM_RE, route);
  if (count) await writeFile(foot.file, out);
  return { footerFile: foot.name, removed: count };
}

// Read the current state of each preset page so the UI can set its toggle
// (exists → on + prefilled) or badge it as "will be created".
async function readCurrentNewPages() {
  const out = {};
  for (const [key, cfg] of Object.entries(PRESET_PAGES)) {
    const entry = { file: `src/pages/${cfg.file}`, route: cfg.route, label: cfg.navLabel, exists: false, parked: false, title: "", meta: "" };
    try {
      const src = await readFile(join(PAGES, cfg.file), "utf8");
      // A cta route always has a file. What the toggle reports is whether that
      // file is the button page yet — the interstitial reads as "off".
      entry.exists = cfg.kind === "cta" ? isCtaPage(src) : true;
      entry.title = src.match(ML_TITLE_RE)?.[0]?.match(/"([^"]*)"$/)?.[1] || softText(src.match(LEGACY_TITLE_RE)?.[1]) || "";
      entry.meta =
        src.match(ML_DESC_RE)?.[0]?.match(/description=("|')([^"']*)\1/)?.[2] ||
        softText(src.match(LEGACY_DESC_RE)?.[1] || src.match(LEGACY_DESC_RE_ALT)?.[1]) ||
        "";
    } catch {
      // Not routed — but it may be parked rather than absent, and those are very
      // different things to an operator: one needs writing from scratch, the
      // other is last brand's page waiting to be switched back on.
      try {
        const src = await readFile(join(PAGES_DISABLED, cfg.file), "utf8");
        entry.parked = true;
        entry.title = src.match(ML_TITLE_RE)?.[0]?.match(/"([^"]*)"$/)?.[1] || "";
        entry.meta = src.match(ML_DESC_RE)?.[0]?.match(/description=("|')([^"']*)\1/)?.[2] || "";
      } catch { /* genuinely not created yet — leave blank */ }
    }
    out[key] = entry;
  }
  return out;
}

async function handleUpload(slot, index, ext, buf, params) {
  const n = Number(index);
  switch (slot) {
    case "logo": {
      // One upload, both destinations: src/assets/logo.webp for the component
      // imports and public/logo.webp for the absolute og/schema logo URL. They
      // must stay identical, so there is no separate "public logo" field.
      const written = [
        "src/assets/" + (await toWebp(buf, ASSETS, "logo")),
        "public/" + (await toWebp(buf, PUBLIC, "logo")),
      ];
      const palette = await writePalette();
      if (palette) written.push(palette);
      return written;
    }
    // Accepts both a .docx and a plain-text brief. The slot keeps its name so
    // no client or prompt has to learn a second one.
    case "docx": {
      if (looksLikeDocx(buf)) {
        await writeFile(join(ASSETS, "content.docx"), buf);
        const written = ["content.docx"];
        const text = await writeContentText(buf);
        if (text) written.push(text);
        return written;
      }
      const lines = briefTextToLines(decodeTextBrief(buf));
      if (!lines.length) throw new Error("ไฟล์ Content brief ว่างเปล่า หรืออ่านไม่ออก");
      await writeFile(join(ASSETS, "content.txt"), lines.join("\n") + "\n", "utf8");
      const written = ["content.txt"];
      // A content.docx from the previous brand would still win in
      // readDocxSubPages() and in whatever the rebrand agent opens first, so a
      // text brief has to take the docx with it. Same failure shape as a stale
      // banner: the new brief is present, and the old one is what gets read.
      try {
        await unlink(join(ASSETS, "content.docx"));
        written.push("content.docx (ลบของแบรนด์ก่อนหน้า)");
      } catch {
        /* nothing to clear */
      }
      return written;
    }
    case "banner": {
      if (!(n >= 1 && n <= 4)) throw new Error("banner index must be 1-4");
      const written = [await toPng(buf, ASSETS, `banner${n}`)];
      // only banner1 feeds the palette, so don't re-measure for 2-4
      if (n === 1) {
        const palette = await writePalette();
        if (palette) written.push(palette);
      }
      return written;
    }
    // Portrait/square hero art for phones. Optional, which is exactly why the
    // clear branch exists: left on disk, a previous brand's mobile banner would
    // keep rendering on phones under a new brand's name, and nobody looks at a
    // phone viewport during review. The client sends clear=1 whenever banner1
    // is uploaded without one, so this file can never outlive its brand.
    case "bannermobile": {
      if (params.get("clear") === "1") {
        const removed = [];
        for (const ext of IMAGE_EXTS) {
          try {
            await unlink(join(ASSETS, `banner1-mobile.${ext}`));
            removed.push(`banner1-mobile.${ext} (ลบแล้ว)`);
          } catch {
            /* not present — fine */
          }
        }
        return removed;
      }
      if (!buf.length) throw new Error("ไม่พบไฟล์แบนเนอร์มือถือที่ส่งมา");
      return [await toPng(buf, ASSETS, "banner1-mobile", { maxWidth: MOBILE_BANNER_WIDTH })];
    }
    case "slide": {
      if (!(n >= 1 && n <= 4)) throw new Error("slide index must be 1-4");
      const written = [await toPng(buf, ASSETS, `slide${n}`, { box: SLIDE_BOX })];
      if (n === 1) {
        // From the ORIGINAL upload, not the 600px-boxed slide — the og image is
        // 1200 wide and there is no point upscaling a copy we just shrank.
        written.push(await toOgImage(buf, ASSETS));
        const palette = await writePalette();
        if (palette) written.push(palette);
      }
      return written;
    }
    case "favicon": {
      const written = [];
      const rasters = [
        ["favicon-96x96.png", 96],
        ["apple-touch-icon.png", 180],
        ["web-app-manifest-192x192.png", 192],
        ["web-app-manifest-512x512.png", 512],
      ];
      for (const [name, size] of rasters) {
        await sharp(buf).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(join(PUBLIC, name));
        written.push(name);
      }
      const icoPng = await sharp(buf).resize(48, 48, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      await writeFile(join(PUBLIC, "favicon.ico"), buildIco(icoPng, 48));
      written.push("favicon.ico");
      if (ext === "svg") {
        await writeFile(join(PUBLIC, "favicon.svg"), buf);
      } else {
        // raster upload: still refresh favicon.svg by embedding the PNG in it
        await writeFile(join(PUBLIC, "favicon.svg"), await rasterToSvg(buf));
      }
      written.push("favicon.svg");
      return written;
    }
    default:
      throw new Error(`unknown slot: ${slot}`);
  }
}

// sharp surfaces a locked destination as a bare libvips
// "unable to open for write ... Invalid argument", which tells an operator
// nothing about what to do. On Windows the cause is almost always the Astro dev
// server holding a handle on the asset.
//
// The trigger is narrower than "dev server is running", which matters because
// the naive version of this note sends people to stop a server that isn't the
// problem: `npm run dev` on its own is harmless, and uploads keep working. It
// only locks an asset once the dev server has actually *served* it — i.e. after
// someone opens localhost:8888 in a browser and Vite optimises the image. From
// that point every write to that file fails, reproducibly, until dev is stopped.
// That is also why this looks intermittent in practice: it depends on whether
// anyone happened to open the preview tab.
function friendlyUploadError(err) {
  const msg = String(err?.message ?? err);
  if (/unable to open for write|write error/i.test(msg)) {
    return "เขียนไฟล์ไม่ได้ เพราะมีโปรแกรมอื่นล็อกไฟล์อยู่ — ถ้าเปิด `npm run dev` (localhost:8888) ค้างไว้ ให้กด Ctrl+C ปิดก่อน แล้วอัพโหลดใหม่";
  }
  return msg;
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Every other endpoint passes its parameters in the query string and uses the
// body for raw file bytes, so JSON parsing lives here rather than in readBody().
async function readJson(req, cap = 64 * 1024) {
  const buf = await readBody(req);
  // Localhost-only + tiny payloads, so this checks the size after buffering
  // rather than aborting mid-stream.
  if (buf.length > cap) throw new Error("ข้อมูลที่ส่งมาใหญ่เกินไป");
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("body ไม่ใช่ JSON ที่ถูกต้อง");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ส่วนที่ 6 — run the rebrand itself (spawn `claude -p`, stream back over SSE)
// ════════════════════════════════════════════════════════════════════════════
// The operator stages files with ส่วนที่ 1-5, then fires this. It runs headless,
// so nobody is there to answer a permission prompt — hence bypassPermissions,
// which is also why the prompt is assembled HERE from validated fields instead
// of accepting a free-form prompt from the browser.
//
// One run at a time; its whole event log is kept in memory so a page refresh
// (or a browser that slept) can replay from any index and pick the live stream
// back up. Closing the uploader's console window kills the run — closing the
// browser tab does not.

// `claude` resolves off PATH (it is a real .exe on Windows, not a .cmd shim, so
// spawn() finds it without a shell — which is what lets a long Thai prompt be
// passed as one argv entry with no quoting/escaping at all).
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const RUN_TIMEOUT_MS = Number(process.env.REBRAND_TIMEOUT_MS) || 90 * 60 * 1000;
// Ring-buffer the log: a long rebrand emits thousands of events and this process
// also serves uploads, so the oldest lines are dropped rather than grown forever.
const MAX_EVENTS = 4000;
// Guard against a single pathological NDJSON line (a huge tool_result) growing
// the split buffer without bound.
const MAX_LINE_BUF = 8 * 1024 * 1024;

// Brand names go into the prompt as an argv entry, so the only real hazard is a
// value that argv-parses as a flag; the character class also keeps a typo'd
// paste from silently becoming the brand. Thai + latin + digits + . _ - space.
const BRAND_RE = /^[A-Za-z0-9฀-๿][A-Za-z0-9฀-๿ ._-]{0,39}$/;

// The exact prompt shape SKILL.md:108-119 decodes:
//   rebrand and retheme to "<BRAND>"[ then real url is "<URL>"] ทำแบบ 2-agent ขนานตาม playbook[ — <notes>]
// The URL clause is dropped when blank — that absence is what tells the skill to
// leave the domain alone. The trailing stop-clause is added only for a fired run
// (unattended): a human pasting this into Claude Code is there to say "no".
function buildRebrandPrompt({ brand, url, notes }, { unattended = true } = {}) {
  const b = String(brand ?? "").trim();
  if (!b) throw new Error("ชื่อแบรนด์: ยังไม่ได้กรอก");
  if (!BRAND_RE.test(b)) throw new Error("ชื่อแบรนด์: ใช้ได้เฉพาะ A-Z 0-9 ไทย เว้นวรรค และ . _ - (ไม่เกิน 40 ตัว)");
  let p = 'rebrand and retheme to "' + b + '"';
  const u = String(url ?? "").trim();
  if (u) p += ' then real url is "' + validateLink(u, "URL production") + '"';
  // "ขนานตาม playbook" (not "2-agent") — the playbook decides how many agents
  // to fan out from the actual page count; pinning a number here would fight it.
  // The older "2-agent ขนาน" phrasing still works: SKILL.md reads both.
  p += " ทำแบบขนานตาม playbook";
  const n = String(notes ?? "").replace(/[\r\n]+/g, " ").trim();
  if (n) p += " — " + validateText(n, "หมายเหตุ");
  if (unattended) p += " — หยุดที่ build + verify เท่านั้น ห้าม deploy และห้าม git push";
  return p;
}

// Cheap end-to-end test of spawn → NDJSON → SSE → UI without burning 40 minutes.
const DRY_PROMPT = 'ตอบกลับสั้นๆ ว่า "ท่อ uploader ทำงานปกติ" แล้วจบเลย ห้ามใช้ tool ใดๆ ห้ามแก้ไฟล์';

const runState = {
  id: null,
  status: "idle", // idle | running | stopping | done | error | stopped
  dry: false,
  fast: false,       // fast mode was REQUESTED for this run
  child: null,
  prompt: "",
  startedAt: 0,
  endedAt: 0,
  exitCode: null,
  stopReason: null,
  sessionId: null,
  model: null,
  speed: null,       // what the API actually served ("fast" | "standard")
  fastState: null,   // what the CLI accepted ("on" | "off")
  numTurns: 0,
  costUsd: null,
  toolCount: 0,
  errorCount: 0,
  files: new Set(),
  events: [],
  nextSeq: 0,
  clients: new Set(),
  timer: null,
};

const isActive = () => runState.status === "running" || runState.status === "stopping";

// Absolute sequence numbers (not array indices) survive the ring buffer, so a
// reconnecting client asks for "?from=<last seen + 1>" and gets exactly what it
// missed — or the oldest surviving event if it was away too long.
function pushEvent(type, payload = {}) {
  const ev = { i: runState.nextSeq++, t: Date.now(), type, ...payload };
  runState.events.push(ev);
  if (runState.events.length > MAX_EVENTS) runState.events.shift();
  const frame = "data: " + JSON.stringify(ev) + "\n\n";
  for (const client of runState.clients) {
    try { client.write(frame); } catch { /* dead socket; the close handler removes it */ }
  }
  return ev;
}

function relFromRoot(p) {
  const s = String(p || "").replace(/\\/g, "/");
  const root = ROOT.replace(/\\/g, "/");
  return s.toLowerCase().startsWith(root.toLowerCase() + "/") ? s.slice(root.length + 1) : s;
}

// One short line describing what a tool call is doing, from whichever field
// carries the meaning for that tool.
function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const pick =
    input.file_path ?? input.path ?? input.command ?? input.description ??
    input.pattern ?? input.url ?? input.skill ?? input.prompt ?? "";
  const s = String(pick).replace(/\s+/g, " ").trim();
  return s.length > 180 ? s.slice(0, 177) + "…" : s;
}

function flattenToolResult(content) {
  if (typeof content === "string") return content.slice(0, 400);
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : b?.text || "")).join(" ").slice(0, 400);
  }
  return "";
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// Tool errors that are the harness working as designed rather than something
// going wrong: the agent hits a guardrail and recovers on its own next turn.
//
// Worth separating because an operator watching this log has no way to tell the
// two apart, and the first live rebrand proved the cost — a Write to
// public/site.webmanifest was blocked by the read-before-write rail, the agent
// Read and re-Wrote it two turns later, and the run was fine, but the red ⚠ was
// alarming enough to stop and ask about. One routine hit in 112 tool calls. If
// every red line is routine, people learn to ignore red lines, which is worse
// than not showing them at all.
const BENIGN_TOOL_ERRORS = [
  /File has not been read yet/i, // Write before Read — agent Reads, then retries
  /String to replace not found/i, // Edit anchor missed — agent re-reads and retries
  /has been modified since/i, // file changed after Read — agent re-reads
  /File has already been read/i,
  /No changes to make/i, // no-op edit
];
const isBenignToolError = (text) => BENIGN_TOOL_ERRORS.some((re) => re.test(text));

// Translate one stream-json message from the CLI into the compact events the UI
// renders. Unknown message types are ignored on purpose — the CLI adds new ones
// over time and a rebrand must not fall over because of a message we don't know.
function handleCliMessage(msg) {
  switch (msg?.type) {
    case "system":
      if (msg.subtype === "init") {
        runState.sessionId = msg.session_id || null;
        runState.model = msg.model || null;
        pushEvent("init", { text: "session " + (runState.sessionId || "?") + " · model " + (runState.model || "?") });
      }
      break;

    case "assistant": {
      // parent_tool_use_id is set for text forwarded from a subagent
      // (--forward-subagent-text): the 2-agent parallel playbook would otherwise
      // look frozen for many minutes at a stretch.
      const sub = msg.parent_tool_use_id ? 1 : 0;
      for (const b of msg.message?.content || []) {
        if (b.type === "text" && b.text && b.text.trim()) {
          pushEvent("text", { text: b.text.trim(), sub });
        } else if (b.type === "tool_use") {
          runState.toolCount++;
          const ev = { name: b.name, text: summarizeToolInput(b.input), sub };
          if (EDIT_TOOLS.has(b.name) && b.input?.file_path) {
            ev.file = relFromRoot(b.input.file_path);
            runState.files.add(ev.file);
          }
          pushEvent("tool", ev);
        }
      }
      break;
    }

    case "user":
      for (const b of msg.message?.content || []) {
        if (b.type === "tool_result" && b.is_error) {
          const text = flattenToolResult(b.content);
          const benign = isBenignToolError(text);
          // the counter the UI surfaces only tracks the ones worth reading
          if (!benign) runState.errorCount++;
          pushEvent("tool_error", { text, benign });
        }
      }
      break;

    case "result":
      runState.numTurns = msg.num_turns ?? runState.numTurns;
      runState.costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null;
      // Two different questions, so both are kept: fast_mode_state says the CLI
      // took the setting, usage.speed says what the API actually served. They can
      // disagree — fast mode has its own availability window and rate limits, so
      // an accepted "on" can still be served at standard speed.
      runState.fastState = typeof msg.fast_mode_state === "string" ? msg.fast_mode_state : null;
      runState.speed = typeof msg.usage?.speed === "string" ? msg.usage.speed : null;
      pushEvent("result", {
        subtype: msg.subtype || "",
        text: typeof msg.result === "string" ? msg.result.trim() : "",
        durationMs: msg.duration_ms ?? null,
        numTurns: runState.numTurns,
        costUsd: runState.costUsd,
        fast: runState.fast,
        fastState: runState.fastState,
        speed: runState.speed,
      });
      break;
  }
}

function finishRun(code, signal) {
  clearTimeout(runState.timer);
  runState.timer = null;
  runState.exitCode = code;
  runState.endedAt = Date.now();
  if (runState.stopReason === "timeout") runState.status = "error";
  else if (runState.stopReason === "manual") runState.status = "stopped";
  else runState.status = code === 0 ? "done" : "error";
  runState.child = null;
  pushEvent("end", {
    status: runState.status,
    exitCode: code,
    signal: signal || null,
    elapsedMs: runState.endedAt - runState.startedAt,
    files: [...runState.files],
    toolCount: runState.toolCount,
    errorCount: runState.errorCount,
    numTurns: runState.numTurns,
    costUsd: runState.costUsd,
  });
  for (const client of runState.clients) {
    try { client.end(); } catch { /* already gone */ }
  }
  runState.clients.clear();
}

// A ~5-second answer to the one question a real run only answers at the very
// end: is the API actually serving fast *right now*? `fast_mode_state` says the
// CLI took the setting; `usage.speed` says what was served. They disagree
// often — 2026-07-29 measured `on`/`standard` on four probes and one 35-minute
// rebrand — and only the second one is worth waiting out a rebrand for.
//
// Every flag here earns its place. With the default context (tool definitions +
// CLAUDE.md + skills) the probe drags ~32k tokens along; stripped down it writes
// 7.4k cache tokens once and every later probe is a cache READ of that same
// prefix. So: keep this array and the prompt BYTE-IDENTICAL. Change one
// character and every probe pays the full cache write again instead of reading,
// roughly 20x the usage for the same four-second answer.
const PROBE_ARGS = [
  "-p", "ok",
  "--output-format", "json",
  "--model", "opus",                                  // fast mode is Opus-only
  "--settings", JSON.stringify({ fastMode: true }),
  "--tools", "",                                      // no tool definitions in the prompt
  "--disable-slash-commands",                         // no skills either
  "--system-prompt", "Reply with the single word: ok",
];

function probeFastMode() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CLAUDE_BIN, PROBE_ARGS, {
        cwd: ROOT,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, error: "รัน " + CLAUDE_BIN + " ไม่ได้: " + err.message });
      return;
    }

    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(value);
    };
    // Generous, because a probe that hangs must not hold the button hostage:
    // failing the check is fine (the UI just says "เช็กไม่ได้"), hanging is not.
    const timer = setTimeout(() => finish({ ok: false, error: "เช็กไม่ทันใน 60 วินาที" }), 60000);

    child.stdout.on("data", (b) => { out += b; });
    child.on("error", (err) => finish({ ok: false, error: err.message }));
    child.on("close", () => {
      try {
        const j = JSON.parse(out);
        finish({
          ok: true,
          fastState: typeof j.fast_mode_state === "string" ? j.fast_mode_state : null,
          speed: typeof j.usage?.speed === "string" ? j.usage.speed : null,
          ms: j.duration_ms ?? null,
          costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null,
        });
      } catch {
        finish({ ok: false, error: "อ่านผลเช็กไม่ได้" + (out.trim() ? ": " + out.trim().slice(0, 200) : "") });
      }
    });
  });
}

function startRun({ brand, url, notes, dry, fast }) {
  if (isActive()) throw new Error("มีงาน rebrand กำลังรันอยู่แล้ว — รอให้จบหรือกดหยุดก่อน");
  const prompt = dry ? DRY_PROMPT : buildRebrandPrompt({ brand, url, notes });

  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",                 // required by stream-json
    "--forward-subagent-text",   // surface both parallel agents in the log
    "--permission-mode", "bypassPermissions",
  ];
  // Fast mode has no CLI flag — it is the `fastMode` *setting* (a sibling of
  // `model` and `effortLevel`), and `--settings` takes a JSON string that is
  // merged on top of the user's own settings. Passing it per-run instead of
  // writing ~/.claude/settings.json is what keeps the toggle scoped to this run:
  // nothing to clean up if the uploader is killed mid-rebrand.
  //
  // Verify it landed via the result event's `fastState`, not by assuming: under
  // -p an unparseable/unknown settings payload is SILENTLY ignored, so a typo
  // here would degrade to a normal-speed run with no error anywhere.
  //
  // `--model opus` is NOT redundant here, however much it looks it. Measured on
  // this repo: the same run with `--settings {"fastMode":true}` reports
  // fast_mode_state=off without the flag and =on with it — even though both
  // resolve to claude-opus-5 either way (the model comes from the user's
  // settings.json, which the --settings layer appears to displace). Fast mode is
  // Opus-only, so asking for fast already implies Opus; dropping this flag to
  // tidy up silently gives back a standard-speed run.
  if (fast) args.push("--settings", JSON.stringify({ fastMode: true }), "--model", "opus");

  Object.assign(runState, {
    id: randomUUID(),
    status: "running",
    dry: !!dry,
    fast: !!fast,
    prompt,
    startedAt: Date.now(),
    endedAt: 0,
    exitCode: null,
    stopReason: null,
    sessionId: null,
    model: null,
    speed: null,
    fastState: null,
    numTurns: 0,
    costUsd: null,
    toolCount: 0,
    errorCount: 0,
    files: new Set(),
    events: [],
    nextSeq: 0,
  });

  let child;
  try {
    child = spawn(CLAUDE_BIN, args, {
      cwd: ROOT,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    runState.status = "error";
    throw new Error("รัน " + CLAUDE_BIN + " ไม่ได้: " + err.message);
  }
  runState.child = child;

  pushEvent("start", {
    text: (dry ? "[ทดสอบท่อ] " : "") + prompt,
    dry: !!dry,
    fast: !!fast,
    id: runState.id,
    startedAt: runState.startedAt,
  });

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    if (buf.length > MAX_LINE_BUF) {
      pushEvent("stderr", { text: "บรรทัด output ยาวผิดปกติ — ตัดทิ้ง 1 ก้อน" });
      buf = "";
      return;
    }
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        handleCliMessage(JSON.parse(line));
      } catch {
        // Not JSON: a CLI notice/warning printed on stdout. Show it verbatim —
        // this is usually the only clue when a flag is wrong.
        pushEvent("raw", { text: line.slice(0, 500) });
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) pushEvent("stderr", { text: text.slice(0, 2000) });
  });

  child.on("error", (err) => {
    const hint = err.code === "ENOENT"
      ? "ไม่พบคำสั่ง " + CLAUDE_BIN + " — ติดตั้ง Claude Code หรือกำหนด CLAUDE_BIN=<เต็มพาธของ claude.exe> ก่อนรัน uploader"
      : err.message;
    pushEvent("stderr", { text: hint });
    if (isActive()) finishRun(null, null);
  });

  child.on("close", (code, signal) => {
    if (!isActive()) return;
    finishRun(code, signal);
  });

  runState.timer = setTimeout(() => {
    if (!isActive()) return;
    pushEvent("stderr", { text: "เกินเวลา " + Math.round(RUN_TIMEOUT_MS / 60000) + " นาที — กำลังหยุด" });
    stopRun("timeout");
  }, RUN_TIMEOUT_MS);

  return runSnapshot();
}

// child.kill() alone leaves the node/npm processes that Claude spawned running,
// so on Windows kill the whole tree.
function stopRun(reason = "manual") {
  if (!isActive() || !runState.child) throw new Error("ไม่มีงานที่กำลังรันอยู่");
  runState.status = "stopping";
  runState.stopReason = reason;
  pushEvent("stopping", { text: reason === "timeout" ? "หยุดเพราะเกินเวลา" : "ผู้ใช้กดหยุด" });
  const pid = runState.child.pid;
  if (process.platform === "win32" && pid) {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      try { runState.child.kill(); } catch { /* already dead */ }
    }
  } else {
    try { runState.child.kill("SIGTERM"); } catch { /* already dead */ }
  }
}

function runSnapshot() {
  return {
    id: runState.id,
    status: runState.status,
    dry: runState.dry,
    fast: runState.fast,
    fastState: runState.fastState,
    speed: runState.speed,
    prompt: runState.prompt,
    startedAt: runState.startedAt || null,
    endedAt: runState.endedAt || null,
    elapsedMs: runState.startedAt ? (runState.endedAt || Date.now()) - runState.startedAt : 0,
    sessionId: runState.sessionId,
    model: runState.model,
    exitCode: runState.exitCode,
    numTurns: runState.numTurns,
    costUsd: runState.costUsd,
    toolCount: runState.toolCount,
    errorCount: runState.errorCount,
    files: [...runState.files],
    nextSeq: runState.nextSeq,
    oldestSeq: runState.events[0]?.i ?? runState.nextSeq,
  };
}

// Shown in the confirm dialog so an operator sees whether today's brief is
// actually staged before firing a 40-minute run.
async function stagedDocxInfo() {
  // Either form counts as "the brief is staged" — gating the Rebrand button on
  // content.docx alone would lock out every operator who uploaded a .txt.
  for (const name of ["content.docx", "content.txt"]) {
    try {
      const s = await stat(join(ASSETS, name));
      return { exists: true, mtime: s.mtimeMs, size: s.size, name };
    } catch {
      /* try the next form */
    }
  }
  return { exists: false, mtime: null, size: 0, name: "" };
}

// ════════════════════════════════════════════════════════════════════════════
// ส่วนที่ 7 — build the site and serve it, so the operator can look at it
// ════════════════════════════════════════════════════════════════════════════
// Written for someone who will never open a terminal: one button has to cover
// "npm run build", "npm run preview", and "now go to localhost:4321".
//
// It previews the BUILT output rather than starting the dev server, for two
// reasons. The dev server keeps file handles on everything under src/assets it
// has served, which is exactly the lock that makes the next upload fail (see
// friendlyUploadError). And the point of checking a rebrand is to see what will
// actually ship — the dev server can happily render a page the real build
// refuses to produce.
const ASTRO_BIN = join(ROOT, "node_modules", "astro", "astro.js");
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT) || 4321;
const PREVIEW_READY_TIMEOUT_MS = 40000;
const MAX_PREVIEW_LOG = 400;

const previewState = {
  status: "idle", // idle | building | running | error
  child: null,
  url: "",
  error: "",
  log: [], // build output — the only place a non-technical operator sees why a build failed
  startedAt: 0,
};

function previewLog(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim()) previewState.log.push(line);
  }
  if (previewState.log.length > MAX_PREVIEW_LOG) {
    previewState.log = previewState.log.slice(-MAX_PREVIEW_LOG);
  }
}

// astro.js is plain JS run through the node we are already inside: no npm, no
// shell, and no .cmd shim — which Node refuses to spawn without shell:true.
function spawnAstro(args) {
  return spawn(process.execPath, [ASTRO_BIN, ...args], {
    cwd: ROOT,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    } catch { /* fall through to kill() */ }
  }
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

// Ready means actually answering HTTP. Astro prints a banner too, but reading
// readiness out of console output breaks every time that banner is restyled.
function waitForPreview(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => { res.resume(); resolvePromise(); });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error("เปิดเซิร์ฟเวอร์ทดสอบไม่สำเร็จ (หมดเวลารอ)"));
        else setTimeout(tick, 400);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

async function startPreview() {
  if (previewState.status === "building") throw new Error("กำลังเตรียมเว็บอยู่แล้ว");
  if (previewState.status === "running") return previewSnapshot(); // idempotent: button pressed twice

  stopPreview();
  Object.assign(previewState, { status: "building", url: "", error: "", log: [], startedAt: Date.now() });

  const exitCode = await new Promise((resolvePromise) => {
    const b = spawnAstro(["build"]);
    b.stdout.setEncoding("utf8");
    b.stderr.setEncoding("utf8");
    b.stdout.on("data", previewLog);
    b.stderr.on("data", previewLog);
    b.on("error", (err) => { previewLog(err.message); resolvePromise(-1); });
    b.on("close", resolvePromise);
  });

  if (exitCode !== 0) {
    previewState.status = "error";
    previewState.error = "build ไม่ผ่าน — เว็บยังมีข้อผิดพลาดอยู่ ดูรายละเอียดด้านล่าง";
    return previewSnapshot();
  }

  // --host 127.0.0.1 on purpose. Left to itself astro preview binds ::1 only,
  // so anything resolving localhost to IPv4 first cannot reach it — verified:
  // localhost:4321 answered while 127.0.0.1:4321 refused. Binding explicitly
  // (same as the dev script) removes the resolution order from the equation,
  // and keeps the preview off the network, which a preview has no business on.
  const child = spawnAstro(["preview", "--port", String(PREVIEW_PORT), "--host", "127.0.0.1"]);
  previewState.child = child;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", previewLog);
  child.stderr.on("data", previewLog);
  child.on("close", () => {
    // only reset if this is still the current process — a restart may have replaced it
    if (previewState.child === child) {
      previewState.child = null;
      if (previewState.status === "running") { previewState.status = "idle"; previewState.url = ""; }
    }
  });

  // Poll the address it is actually bound to; hand the operator the name they
  // are used to typing (localhost, same as :8888 and :4444).
  const url = "http://localhost:" + PREVIEW_PORT + "/";
  try {
    await waitForPreview("http://127.0.0.1:" + PREVIEW_PORT + "/", PREVIEW_READY_TIMEOUT_MS);
  } catch (err) {
    killTree(child);
    previewState.child = null;
    previewState.status = "error";
    previewState.error = err.message;
    return previewSnapshot();
  }

  previewState.status = "running";
  previewState.url = url;
  return previewSnapshot();
}

function stopPreview() {
  if (previewState.child) killTree(previewState.child);
  previewState.child = null;
  if (previewState.status === "running" || previewState.status === "building") previewState.status = "idle";
  previewState.url = "";
}

// Never strand a preview server holding the port after the uploader is closed.
process.on("exit", () => { if (previewState.child) killTree(previewState.child); });
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { if (previewState.child) killTree(previewState.child); process.exit(0); });
}

function previewSnapshot() {
  return {
    status: previewState.status,
    url: previewState.url,
    error: previewState.error,
    log: previewState.log.slice(-120),
    port: PREVIEW_PORT,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ส่วนที่ 7 (ต่อ) — deploy the site to Cloudflare
// ════════════════════════════════════════════════════════════════════════════
// This is the only button in the tool that reaches the public internet, so it
// is also the only one with a gate in front of it (the five-item checklist).
//
// It needs nothing from the operator. `wrangler.toml` already carries which
// Worker to write and which Cloudflare account to write it into, so there is
// no password to type as there was with deploy.ps1 over SSH, no domain
// argument to get wrong, and no account to pick.
const WRANGLER_BIN = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

const deployState = {
  status: "idle", // idle | running | done | error
  log: [],
  error: "",
  url: "", // the deployed URL wrangler reports back
  target: null, // { name, account_id } read from wrangler.toml, shown before firing
  startedAt: 0,
  endedAt: 0,
  child: null,
};

function deployLog(text) {
  for (const line of String(text).split(/\r?\n/)) {
    // wrangler paints progress with ANSI colour; strip it or the log is unreadable
    const clean = line.replace(/\[[0-9;]*m/g, "").trimEnd();
    if (clean.trim()) deployState.log.push(clean);
  }
  if (deployState.log.length > MAX_PREVIEW_LOG) {
    deployState.log = deployState.log.slice(-MAX_PREVIEW_LOG);
  }
}

// Show the operator what they are about to overwrite. Reading the file rather
// than remembering it means a rebrand that changed `name` is reflected without
// restarting the uploader — and a name still reading as the previous brand is
// visible in the confirm dialog before anything is published.
async function deployTarget() {
  try {
    const toml = await readFile(join(ROOT, "wrangler.toml"), "utf8");
    return {
      name: toml.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] || "",
      accountId: toml.match(/^\s*account_id\s*=\s*"([^"]+)"/m)?.[1] || "",
    };
  } catch {
    return { name: "", accountId: "" };
  }
}

function runStep(bin, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: ROOT,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    deployState.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", deployLog);
    child.stderr.on("data", deployLog);
    child.on("error", (err) => { deployLog(err.message); resolvePromise(-1); });
    child.on("close", (code) => { deployState.child = null; resolvePromise(code); });
  });
}

async function startDeploy() {
  if (deployState.status === "running") throw new Error("กำลัง deploy อยู่แล้ว");
  if (isActive()) throw new Error("มี rebrand กำลังรันอยู่ — รอให้จบก่อน");

  Object.assign(deployState, {
    status: "running", log: [], error: "", url: "", startedAt: Date.now(), endedAt: 0,
    target: await deployTarget(),
  });

  const timer = setTimeout(() => {
    if (deployState.child) killTree(deployState.child);
  }, DEPLOY_TIMEOUT_MS);

  try {
    // Always rebuild. dist/ may be stale from an edit made after the last
    // preview, and publishing a stale build is the one mistake here that is
    // invisible — the deploy succeeds and ships yesterday's site.
    deployLog("== build ==");
    if ((await runStep(ASTRO_BIN, ["build"])) !== 0) {
      deployState.status = "error";
      deployState.error = "build ไม่ผ่าน — ยังไม่ได้ deploy อะไรขึ้นไป";
      return deploySnapshot();
    }

    deployLog("== deploy ==");
    if ((await runStep(WRANGLER_BIN, ["deploy"])) !== 0) {
      deployState.status = "error";
      deployState.error = "deploy ไม่สำเร็จ — ดูรายละเอียดด้านล่าง";
      return deploySnapshot();
    }

    deployState.url = deployState.log.join("\n").match(/https:\/\/[^\s]+/g)?.pop() || "";
    deployState.status = "done";
    return deploySnapshot();
  } finally {
    clearTimeout(timer);
    deployState.endedAt = Date.now();
  }
}

function deploySnapshot() {
  return {
    status: deployState.status,
    error: deployState.error,
    url: deployState.url,
    target: deployState.target,
    log: deployState.log.slice(-150),
    elapsedMs: deployState.startedAt ? (deployState.endedAt || Date.now()) - deployState.startedAt : 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ส่วนที่ 7 (ต่อ) — สลับบัญชี Cloudflare
// ════════════════════════════════════════════════════════════════════════════
// Brands are spread across several Cloudflare accounts deliberately. An account
// suspension takes down every site inside it, and the nameserver pair a zone is
// given turns out to be per-account — mahoranlotto and ufayes, added to the same
// account, both got armfazh/arushi. Neither fact is visible to a search engine.
// Both are visible to Cloudflare, which is the party that can act on them.
//
// Switching is a real logout/login rather than inviting one shared email into
// every account, or keeping an API token per account on disk. The shared member
// would be exactly the link between accounts we are trying not to create, and a
// deploy-capable token in a plaintext file is a worse credential than an OAuth
// session that can be revoked.
//
// `wrangler login` looks interactive but the interaction happens in a browser,
// not on stdin, so it can be driven from here. `--browser false` makes it print
// the OAuth URL instead of opening it; we surface that as a link, which also
// means none of this depends on the browser being on the same machine.
const CF_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const CF_WHO_TTL_MS = 60 * 1000;

const cfState = {
  status: "idle", // idle | running | done | error
  phase: "", // logout | login | whoami
  authUrl: "", // shown the moment wrangler prints it
  log: [],
  error: "",
  startedAt: 0,
  endedAt: 0,
  child: null,
};

// Last known answer from `whoami`, so polling /cf/status does not shell out
// every second. Refreshed on demand and after a switch.
let cfWho = { at: 0, email: "", accounts: [] };

function cfLog(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const clean = line.replace(/\[[0-9;]*m/g, "").trimEnd();
    if (clean.trim()) cfState.log.push(clean);
  }
  if (cfState.log.length > MAX_PREVIEW_LOG) cfState.log = cfState.log.slice(-MAX_PREVIEW_LOG);
}

// Read-only wrangler call: no logging, no cfState.child, so it is safe to run
// while the switch flow owns the state.
function wranglerOut(args) {
  return new Promise((resolvePromise) => {
    let out = "";
    const child = spawn(process.execPath, [WRANGLER_BIN, ...args], {
      cwd: ROOT, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("error", () => resolvePromise(""));
    child.on("close", () => resolvePromise(out));
  });
}

function cfRun(args, onData) {
  return new Promise((resolvePromise) => {
    let out = "";
    const child = spawn(process.execPath, [WRANGLER_BIN, ...args], {
      cwd: ROOT, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    cfState.child = child;
    const take = (chunk) => { out += chunk; cfLog(chunk); if (onData) onData(out); };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => { cfLog(err.message); resolvePromise({ code: -1, out }); });
    child.on("close", (code) => { cfState.child = null; resolvePromise({ code, out }); });
  });
}

// `whoami` prints the email in a sentence and the accounts in a box-drawing
// table. Match the id by its shape (32 hex) rather than by column position, so
// a longer account name shifting the table does not break the parse.
function parseWhoami(out) {
  const email = out.match(/associated with the email\s+(\S+?)\.?\s*$/m)?.[1] || "";
  const accounts = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/);
    if (m) accounts.push({ name: m[1], id: m[2] });
  }
  return { email, accounts };
}

async function cfWhoami(force = false) {
  if (!force && cfWho.at && Date.now() - cfWho.at < CF_WHO_TTL_MS) return cfWho;
  cfWho = { at: Date.now(), ...parseWhoami(await wranglerOut(["whoami"])) };
  return cfWho;
}

// Returns as soon as the flow is under way; the browser polls /cf/status for
// the OAuth link and the result, because the operator may take minutes over it.
async function startCfSwitch() {
  if (cfState.status === "running") throw new Error("กำลังสลับบัญชีอยู่แล้ว");
  if (deployState.status === "running") throw new Error("กำลัง deploy อยู่ — รอให้จบก่อน");
  if (isActive()) throw new Error("มี rebrand กำลังรันอยู่ — รอให้จบก่อน");

  Object.assign(cfState, {
    status: "running", phase: "logout", authUrl: "",
    log: [], error: "", startedAt: Date.now(), endedAt: 0,
  });

  const timer = setTimeout(() => { if (cfState.child) killTree(cfState.child); }, CF_LOGIN_TIMEOUT_MS);

  (async () => {
    try {
      cfLog("== logout ==");
      // A machine that was never logged in has nothing to log out of, and
      // wrangler says so on stderr. That is not a failure — keep going.
      await cfRun(["logout"]);

      cfState.phase = "login";
      cfLog("== login ==");
      const { code } = await cfRun(["login", "--browser", "false"], (out) => {
        if (!cfState.authUrl) {
          cfState.authUrl = out.match(/https:\/\/dash\.cloudflare\.com\/oauth2\/auth\S+/)?.[0] || "";
        }
      });
      if (code !== 0) {
        cfState.status = "error";
        cfState.error = "ยังไม่ได้กดอนุญาต — ปิดหน้าเบราว์เซอร์ไปก่อน หรือหมดเวลา 5 นาที";
        return;
      }

      cfState.phase = "whoami";
      const { out } = await cfRun(["whoami"]);
      cfWho = { at: Date.now(), ...parseWhoami(out) };
      if (!cfWho.accounts.length) {
        cfState.status = "error";
        cfState.error = "login ผ่านแล้วแต่ยังไม่เห็นบัญชีไหนเลย — ลองสลับใหม่อีกครั้ง";
        return;
      }
      cfState.status = "done";
    } catch (err) {
      cfState.status = "error";
      cfState.error = err.message;
    } finally {
      clearTimeout(timer);
      cfState.phase = "";
      cfState.endedAt = Date.now();
    }
  })();

  return cfSnapshot();
}

function stopCfSwitch() {
  if (cfState.child) killTree(cfState.child);
  if (cfState.status === "running") {
    cfState.status = "error";
    cfState.error = "ยกเลิกการสลับบัญชีแล้ว — ตอนนี้ยังไม่ได้ login บัญชีไหน กดสลับใหม่อีกครั้ง";
    cfState.endedAt = Date.now();
  }
  return cfSnapshot();
}

// The other half of switching. `wrangler login` decides which accounts are
// reachable; `account_id` decides which one is actually written to. Change only
// the first and the tool is logged into B while still aiming at A — the deploy
// fails rather than going somewhere wrong, but somebody still has to edit the
// file, and that is the step a non-tech operator has no way to know about.
async function setAccountId(id) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("รูปแบบ Account ID ไม่ถูกต้อง");
  const path = join(ROOT, "wrangler.toml");
  const src = await readFile(path, "utf8");
  let out;
  if (/^\s*account_id\s*=/m.test(src)) {
    out = src.replace(/^(\s*account_id\s*=\s*)"[^"]*"/m, `$1"${id}"`);
  } else if (/^\s*name\s*=/m.test(src)) {
    out = src.replace(/^(\s*name\s*=.*)$/m, `$1\naccount_id = "${id}"`);
  } else {
    throw new Error("อ่าน wrangler.toml ไม่ออก — ไม่เจอทั้ง account_id และ name");
  }
  if (out === src) throw new Error("เขียน account_id ลง wrangler.toml ไม่สำเร็จ");
  await writeFile(path, out, "utf8");
  return deployTarget();
}

function cfSnapshot() {
  return {
    status: cfState.status,
    phase: cfState.phase,
    authUrl: cfState.authUrl,
    error: cfState.error,
    email: cfWho.email,
    accounts: cfWho.accounts,
    log: cfState.log.slice(-120),
    elapsedMs: cfState.startedAt ? (cfState.endedAt || Date.now()) - cfState.startedAt : 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ส่วนที่ 8 — เซฟงานขึ้น GitLab (commit + push)
// ════════════════════════════════════════════════════════════════════════════
// Pushes whatever branch is checked out, to `origin`. It does not create,
// switch, or refuse a branch — that decision belongs to the operator, and a
// tool that quietly moves you somewhere else is worse than one that does what
// the label says.
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

const gitState = {
  status: "idle", // idle | running | done | error
  log: [],
  error: "",
  hint: "",
  branch: "",
  pushed: 0,
  startedAt: 0,
  endedAt: 0,
  child: null,
};

function gitLog(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const clean = line.replace(/\[[0-9;]*m/g, "").trimEnd();
    if (clean.trim()) gitState.log.push(clean);
  }
  if (gitState.log.length > MAX_PREVIEW_LOG) {
    gitState.log = gitState.log.slice(-MAX_PREVIEW_LOG);
  }
}

// Quiet read — for the status panel, which polls. Never touches gitState.log.
function gitRead(args) {
  return new Promise((resolvePromise) => {
    let out = "";
    let err = "";
    const child = spawn("git", args, { cwd: ROOT, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => resolvePromise({ code: -1, out: "", err: e.message }));
    // trimEnd, never trim: `status --porcelain` puts a status character in
    // column 1 and a SPACE in column 0 for a worktree-only change, so trimming
    // the front shifts the first line and eats a character off its path.
    child.on("close", (code) => resolvePromise({ code, out: out.trimEnd(), err: err.trim() }));
  });
}

// Loud run — for the actual commit/push, mirrored into the visible log.
function gitStep(args) {
  return new Promise((resolvePromise) => {
    gitLog("$ git " + args.join(" "));
    // Same reason as the status read: without it, git renders every Thai path
    // in this repo as \340\270\227 octal escapes in the log the operator reads.
    const full = ["-c", "core.quotepath=false", ...args];
    const child = spawn("git", full, { cwd: ROOT, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    gitState.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", gitLog);
    child.stderr.on("data", gitLog);
    child.on("error", (e) => { gitLog(e.message); resolvePromise(-1); });
    child.on("close", (code) => { gitState.child = null; resolvePromise(code); });
  });
}

const GIT_STATUS_LABEL = {
  M: "แก้ไข", A: "เพิ่มใหม่", D: "ลบ", R: "เปลี่ยนชื่อ", C: "คัดลอก", "?": "ไฟล์ใหม่", U: "ชนกัน",
};

// Anything under these is build output or downloaded packages — never source,
// and never something a rebrand produced. `git add -A` stages whatever is not
// ignored, so a repo whose .gitignore is missing or broken turns this button
// into a several-hundred-megabyte commit that is then pushed. Caught by
// running the tool against a scratch repo that had no .gitignore at all: the
// push went through carrying every file in node_modules.
const GIT_NEVER_COMMIT = ["node_modules/", "dist/", ".astro/", ".wrangler/"];

function offendingPaths(files) {
  return files.filter((f) => GIT_NEVER_COMMIT.some((bad) => f.path.replace(/\\/g, "/").startsWith(bad)));
}

async function gitInfo() {
  const [branchR, originR, statusR, upstreamR, userR] = await Promise.all([
    gitRead(["rev-parse", "--abbrev-ref", "HEAD"]),
    gitRead(["remote", "get-url", "origin"]),
    // -c core.quotepath=false: this repo has Thai page filenames, and git's
    // default escapes every non-ASCII byte as \340\270\227 in porcelain output.
    gitRead(["-c", "core.quotepath=false", "status", "--porcelain"]),
    gitRead(["rev-parse", "--abbrev-ref", "@{u}"]),
    gitRead(["config", "user.email"]),
  ]);

  if (branchR.code === -1) {
    return { ok: false, error: "เรียก git ไม่ได้ — ยังไม่ได้ติดตั้ง Git หรือยังไม่ได้อยู่ใน PATH (ดูคู่มือ ภาค B1)" };
  }
  if (branchR.code !== 0) {
    return { ok: false, error: "โฟลเดอร์นี้ไม่ใช่ git repo" };
  }

  const files = statusR.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      const key = code.trim()[0] || "M";
      return { path, code: code.trim(), label: GIT_STATUS_LABEL[key] || "แก้ไข" };
    });

  return {
    ok: true,
    branch: branchR.out,
    detached: branchR.out === "HEAD",
    origin: originR.code === 0 ? originR.out : "",
    hasUpstream: upstreamR.code === 0,
    identity: userR.out,
    files,
    blocked: offendingPaths(files).slice(0, 5).map((f) => f.path),
    blockedCount: offendingPaths(files).length,
    commitName: (await currentSiteHost()) || (await currentBrandName()),
  };
}

// What the commit message box is pre-filled with. Reading the files rather than
// remembering them means a rebrand that just landed is reflected without a
// restart — the same reason deployTarget() re-reads wrangler.toml.
//
// The domain wins over BRAND_NAME because it is the one identifier that is
// unique per brand: names get typo'd in the prompt (WINNOW168 shipped as
// "winnow167"), reused across rounds, and spelled three ways between the
// artwork, the docx and the URL. BRAND_NAME stays as the fallback for a tree
// whose astro.config.mjs has no site: yet.
async function currentSiteHost() {
  try {
    const src = await readFile(CONFIG, "utf8");
    const raw = src.match(/^\s*site:\s*["']([^"']+)["']/m)?.[1];
    return raw ? new URL(raw).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

async function currentBrandName() {
  try {
    const src = await readFile(join(ROOT, "src", "lib", "brandProfile.ts"), "utf8");
    return src.match(/export const BRAND_NAME\s*=\s*"([^"]+)"/)?.[1] || "";
  } catch {
    return "";
  }
}

async function startGitPush(message) {
  if (gitState.status === "running") throw new Error("กำลังเซฟอยู่แล้ว");
  if (isActive()) throw new Error("มี rebrand กำลังรันอยู่ — รอให้จบก่อน");

  const msg = String(message || "").trim();
  if (!msg) throw new Error("ยังไม่ได้ใส่ข้อความ commit");

  const info = await gitInfo();
  if (!info.ok) throw new Error(info.error);
  if (info.detached) throw new Error("ตอนนี้ไม่ได้อยู่บน branch ไหนเลย (detached HEAD) — สลับกลับไป branch ก่อน");
  if (!info.origin) throw new Error("repo นี้ยังไม่มี remote ชื่อ origin — ดูคู่มือ ภาค B4");
  if (!info.files.length) throw new Error("ไม่มีไฟล์ที่เปลี่ยน — ไม่มีอะไรให้เซฟ");
  if (info.blockedCount) {
    throw new Error(
      `ยังเซฟไม่ได้ — มีของที่ไม่ควรขึ้น git ปนอยู่ (${info.blocked[0]}) ` +
        "ซึ่งเป็นโฟลเดอร์ที่โหลดมาเองหรือไฟล์ที่ build ขึ้น ไม่ใช่งานที่เราแก้ " +
        "แปลว่าไฟล์ .gitignore ของ repo นี้หายไปหรือเสีย ให้แจ้งหัวหน้าก่อน อย่าเพิ่งกดเซฟ",
    );
  }

  Object.assign(gitState, {
    status: "running", log: [], error: "", hint: "", branch: info.branch,
    pushed: info.files.length, startedAt: Date.now(), endedAt: 0,
  });

  const timer = setTimeout(() => {
    if (gitState.child) killTree(gitState.child);
  }, GIT_TIMEOUT_MS);

  try {
    if ((await gitStep(["add", "-A"])) !== 0) {
      gitState.status = "error";
      gitState.error = "git add ไม่ผ่าน — ยังไม่ได้ commit อะไร";
      return gitSnapshot();
    }

    if ((await gitStep(["commit", "-m", msg])) !== 0) {
      gitState.status = "error";
      gitState.error = "commit ไม่ผ่าน — ยังไม่ได้ส่งอะไรขึ้นไป";
      const text = gitState.log.join("\n");
      if (/Please tell me who you are|user\.email/i.test(text)) {
        gitState.hint = "ยังไม่ได้ตั้งชื่อ/อีเมลของ git บนเครื่องนี้ — ทำตามคู่มือ ภาค B2 (git config --global user.name / user.email) แล้วกดใหม่";
      }
      return gitSnapshot();
    }

    const pushArgs = info.hasUpstream
      ? ["push", "origin", "HEAD"]
      : ["push", "-u", "origin", info.branch];

    if ((await gitStep(pushArgs)) !== 0) {
      gitState.status = "error";
      gitState.error = "push ไม่สำเร็จ — commit เก็บไว้ในเครื่องแล้ว ยังไม่หายไปไหน";
      const text = gitState.log.join("\n");
      if (/non-fast-forward|fetch first|behind its remote/i.test(text)) {
        gitState.hint = "มีคนส่งงานขึ้น branch นี้ก่อนหน้า — เปิดหน้าต่างดำแล้วสั่ง git pull ก่อน จากนั้นกดปุ่มนี้ใหม่";
      } else if (/pre-receive hook declined|protected branch/i.test(text)) {
        gitState.hint = "branch นี้ถูกล็อกไว้ที่ GitLab (protected branch) — ให้หัวหน้าปลดล็อก หรือย้ายไปทำบน branch ของตัวเอง";
      } else if (/Permission denied|Could not read from remote|publickey/i.test(text)) {
        gitState.hint = "GitLab ไม่รับกุญแจ SSH ของเครื่องนี้ — ทำตามคู่มือ ภาค B3 ใหม่อีกรอบ";
      }
      return gitSnapshot();
    }

    gitState.status = "done";
    return gitSnapshot();
  } finally {
    clearTimeout(timer);
    gitState.endedAt = Date.now();
  }
}

function gitSnapshot() {
  return {
    status: gitState.status,
    error: gitState.error,
    hint: gitState.hint,
    branch: gitState.branch,
    pushed: gitState.pushed,
    log: gitState.log.slice(-150),
    elapsedMs: gitState.startedAt ? (gitState.endedAt || Date.now()) - gitState.startedAt : 0,
  };
}

const PAGE = /* html */ `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rebrand Asset Uploader</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Google+Sans:ital,opsz,wght@0,17..18,400..700;1,17..18,400..700&display=swap" rel="stylesheet">
<link rel="icon" href="data:," />
<style>
  :root {
    color-scheme: dark;
    --bg: #0b1120;
    --panel: #0f172a;
    --card-a: #1c2740;
    --card-b: #141d33;
    --line: #26324c;
    --line-soft: #1e293b;
    --ink: #e6edf7;
    --muted: #93a3bd;
    --faint: #64748b;
    --accent: #38bdf8;
    --accent-2: #6366f1;
    --grad: linear-gradient(135deg, #38bdf8 0%, #6366f1 100%);
    --grad-line: linear-gradient(90deg, #38bdf8, #6366f1);
    --ok: #4ade80;
    --err: #f87171;
    --radius: 16px;
  }
  * { box-sizing: border-box; }
  html, body { overflow-x: hidden; }
  body {
    /* Google Sans has a Thai subset, so the Thai labels get it too rather
       than dropping to a fallback */
    font-family: "Google Sans", "Segoe UI", system-ui, -apple-system, sans-serif;
    margin: 0; color: var(--ink); min-height: 100vh;
    background:
      radial-gradient(900px 500px at 82% -8%, rgba(99,102,241,0.18), transparent 60%),
      radial-gradient(760px 460px at 6% 2%, rgba(56,189,248,0.14), transparent 55%),
      var(--bg);
    background-attachment: fixed;
  }

  /* ── header ─────────────────────────────────────────── */
  header {
    position: sticky; top: 0; z-index: 20;
    padding: 18px 30px;
    background: rgba(11,17,32,0.72);
    backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line-soft);
  }
  .head-inner { margin: 0; }
  header h1 {
    margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.02em;
    display: flex; align-items: center; gap: 12px;
  }
  header h1 .mark {
    width: 34px; height: 34px; border-radius: 10px; flex: none;
    background: var(--grad); display: grid; place-items: center;
    font-size: 18px; box-shadow: 0 8px 20px -6px rgba(56,189,248,0.55);
  }
  header h1 .grad-text {
    background: var(--grad); -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  header p { margin: 8px 0 0; color: var(--muted); font-size: 12.5px; line-height: 1.6; max-width: 900px; }
  header code { background: rgba(148,163,184,0.14); padding: 1px 6px; border-radius: 5px; font-size: 11.5px; color: #cbd5e1; }
  header strong { color: #cbd5e1; }

  /* ── layout: full-width grid, cards flow 1→5 left→right, wrap on overflow ─ */
  /* auto-fill (not auto-fit) keeps column tracks fixed, so a lone card on the
     last row stays one column wide instead of stretching across the full width. */
  /* Form on the left, action panel on the right.
     Earlier versions tried to tile all six cards into a mosaic, packing them by
     height. It looked efficient and read terribly: the step numbers are the only
     navigation this page has, and packing moved them around — 6 landing between
     3 and 4, cards changing neighbours on resize. Nobody could tell where they
     were in the process.
     So the steps are simply a column, in order, always. The one thing that
     needed to escape the scroll — the pair of buttons — is pinned instead. */
  main {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 400px;
    align-items: start;
    gap: 22px; padding: 26px 30px 40px; margin: 0;
  }
  .steps { display: flex; flex-direction: column; gap: 22px; min-width: 0; }

  .action { position: sticky; top: 104px; }
  /* the run log can grow without bound, so the panel scrolls inside itself
     rather than growing past the viewport and taking the buttons with it */
  .action .card { max-height: calc(100vh - 128px); overflow: auto; }

  /* Cards 1 and 4 hold most of the fields on the page. Two-up inside the card
     is what keeps the column from becoming a mile of scrolling — it halves the
     two tallest cards without moving anything between cards. */
  .card.two-up .fieldset { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0 26px; }
  .card.two-up .fieldset > .field { border-top: 0; padding: 11px 0; }

  @media (max-width: 1180px) {
    main { grid-template-columns: 1fr; }
    /* once it is a single column the panel can't usefully stick — it would
       cover the form it belongs to */
    .action { position: static; }
    .action .card { max-height: none; }
  }
  @media (max-width: 640px) {
    main { padding: 20px 16px 40px; }
    header { padding: 16px; }
  }

  /* ── card ───────────────────────────────────────────── */
  .card {
    position: relative; isolation: isolate;
    background: linear-gradient(180deg, var(--card-a), var(--card-b));
    border: 1px solid var(--line); border-radius: var(--radius);
    padding: 22px 22px 20px;
    box-shadow: 0 14px 36px -22px rgba(0,0,0,0.85);
    transition: border-color .18s ease, box-shadow .18s ease;
  }
  .card::before {
    content: ""; position: absolute; inset: 0 0 auto 0; height: 3px;
    background: var(--grad-line); border-radius: var(--radius) var(--radius) 0 0;
    opacity: .9;
  }
  .card:hover { border-color: #34456a; box-shadow: 0 22px 46px -24px rgba(0,0,0,0.95); }
  .card h2 {
    margin: 0 0 6px; font-size: 16px; font-weight: 700; letter-spacing: -0.01em;
    display: flex; align-items: center; gap: 11px;
  }
  .card h2::before {
    /* number comes from data-n on the <h2>, not a CSS counter: the Rebrand
       card sits third in the DOM for layout reasons, and a counter would have
       renumbered it to 4 and broken every reference to "ส่วนที่ 6" */
    content: attr(data-n); flex: none;
    width: 27px; height: 27px; border-radius: 9px;
    display: grid; place-items: center;
    background: var(--grad); color: #05101f; font-weight: 800; font-size: 13px;
    box-shadow: 0 5px 14px -4px rgba(56,189,248,0.5);
  }
  .card > .sub { margin: 0 0 14px; padding-left: 38px; font-size: 12px; color: var(--muted); line-height: 1.55; }

  /* ── fields ─────────────────────────────────────────── */
  .field { display: flex; flex-direction: column; gap: 7px; padding: 13px 0; border-top: 1px solid var(--line-soft); }
  /* The display:flex above outranks the UA stylesheet's [hidden] rule, so
     without this a .field carrying the hidden attribute stays on screen and
     only the JS believes it is gone — which is how the "เว็บสร้างไม่ผ่าน" box
     appeared, empty, beside a preview that had built fine. Same reason
     .np-body and .panel below carry the rule. */
  .field[hidden] { display: none; }
  .field:first-of-type { border-top: 0; padding-top: 4px; }
  .field .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .field label { font-size: 13.5px; font-weight: 600; color: #dbe4f0; }
  .field .target {
    font-size: 10.5px; color: var(--accent); font-family: ui-monospace, monospace;
    background: rgba(56,189,248,0.08); border: 1px solid rgba(56,189,248,0.2);
    padding: 2px 8px; border-radius: 6px;
  }
  .field .opt {
    font-size: 10px; color: var(--faint); font-weight: 600; text-transform: uppercase; letter-spacing: .05em;
    background: rgba(148,163,184,0.1); padding: 2px 7px; border-radius: 999px;
  }

  /* inputs — unified look */
  .field input[type=file] { font-size: 12px; color: var(--muted); max-width: 100%; }
  input[type=file]::file-selector-button {
    font: inherit; font-weight: 600; font-size: 12px; cursor: pointer; margin-right: 10px;
    color: var(--accent); background: var(--panel);
    border: 1px solid var(--line); border-radius: 8px; padding: 7px 13px;
    transition: background .15s, border-color .15s;
  }
  input[type=file]::file-selector-button:hover { background: #0b2b40; border-color: var(--accent); }
  .field input.linkinput, .field .metatitle, .field .metadesc {
    width: 100%; font-size: 13px; color: var(--ink);
    background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px;
    transition: border-color .15s, box-shadow .15s;
  }
  .field input.linkinput { font-family: ui-monospace, monospace; }
  .field .metadesc { resize: vertical; font-family: "Google Sans", "Segoe UI", system-ui, sans-serif; line-height: 1.5; }
  .field input.linkinput:focus, .field .metatitle:focus, .field .metadesc:focus,
  .panel input:focus, .panel select:focus {
    outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(56,189,248,0.16);
  }
  .field .status { font-size: 11.5px; min-height: 15px; color: var(--muted); }
  .field .status.ok { color: var(--ok); }
  .field .status.warn { color: #fbbf24; }
  .field .status.bad { color: var(--err); }

  /* toggle switch + status badge (ส่วนที่ 5 — optional pages) */
  .switch { position: relative; display: inline-flex; width: 42px; height: 24px; flex: none; cursor: pointer; }
  .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .switch .slider { position: absolute; inset: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 999px; transition: .18s; }
  .switch .slider::before { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: var(--muted); border-radius: 50%; transition: .18s; }
  .switch input:checked + .slider { background: #0b2b40; border-color: var(--accent); }
  .switch input:checked + .slider::before { transform: translateX(18px); background: var(--accent); }
  .switch input:focus-visible + .slider { box-shadow: 0 0 0 3px rgba(56,189,248,0.16); }
  .switch:has(input:disabled) { cursor: not-allowed; }
  .switch input:disabled + .slider { opacity: .45; }
  .badge { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
  .badge.new { color: var(--ok); background: rgba(74,222,128,0.12); border: 1px solid rgba(74,222,128,0.3); }
  .badge.exists { color: var(--faint); background: rgba(148,163,184,0.1); border: 1px solid var(--line); }
  /* Amber, not accent-cyan: fast mode draws on its own quota and is not always
     granted, so the toggle must not read as an ordinary always-works switch. */
  .badge.warn { color: #fbbf24; background: rgba(251,191,36,0.12); border: 1px solid rgba(251,191,36,0.32); }
  .switch.warn input:checked + .slider { background: #3a2c07; border-color: #fbbf24; }
  .switch.warn input:checked + .slider::before { background: #fbbf24; }
  .np-body { display: flex; flex-direction: column; gap: 7px; margin-top: 8px; }
  .np-body[hidden] { display: none; }

  .thumb { width: 46px; height: 46px; object-fit: contain; border-radius: 9px; background: var(--panel); border: 1px solid var(--line); display: none; }
  .thumb.show { display: block; }

  /* background mode chips + panels */
  .modes { flex-wrap: wrap; gap: 7px; }
  .modes label {
    display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; cursor: pointer;
    padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel);
    transition: all .15s;
  }
  .modes label:has(input:checked) { border-color: var(--accent); color: var(--accent); background: #0b2b40; box-shadow: 0 0 0 3px rgba(56,189,248,0.12); }
  .modes input { accent-color: var(--accent); margin: 0; }
  .panel[hidden] { display: none; }
  .panel { flex-wrap: wrap; gap: 8px; }
  .panel input[type=color] { width: 40px; height: 32px; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); cursor: pointer; }
  .panel input[type=text] { width: 92px; font-family: ui-monospace, monospace; font-size: 12px; text-transform: lowercase; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; }
  .panel select { font-size: 12px; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; }
  .panel .hint { font-size: 11px; color: var(--faint); align-self: center; }
  #bgPreview { width: 100%; height: 56px; border-radius: 9px; border: 1px solid var(--line); }

  /* ghost button (pull-from-docx) */
  button.ghost {
    background: var(--panel); color: var(--accent); border: 1px solid var(--line);
    padding: 9px 16px; font-size: 13px; font-weight: 700; border-radius: 9px;
    display: inline-flex; align-items: center; gap: 7px; transition: all .15s;
  }
  button.ghost:hover { background: #0b2b40; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(56,189,248,0.12); }
  .pull-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 2px 0 12px; padding-bottom: 14px; border-bottom: 1px solid var(--line-soft); }
  .pull-hint { flex: 1 1 200px; min-width: 0; font-size: 11px; color: var(--faint); line-height: 1.5; }

  /* ── ส่วนที่ 6: fire the rebrand + live run log ──────── */
  button.fire {
    background: var(--grad); color: #05101f; border: 0;
    padding: 10px 20px; font-size: 14px; font-weight: 800; border-radius: 10px; cursor: pointer;
    box-shadow: 0 8px 20px -8px rgba(56,189,248,0.55); transition: transform .12s, filter .15s;
  }
  button.fire:hover:not(:disabled) { filter: brightness(1.06); transform: translateY(-1px); }
  button.fire:disabled, button.ghost:disabled { opacity: .45; cursor: not-allowed; filter: none; transform: none; box-shadow: none; }
  button.danger { color: var(--err); }
  button.danger:hover:not(:disabled) { background: rgba(248,113,113,0.1); border-color: var(--err); box-shadow: 0 0 0 3px rgba(248,113,113,0.12); }
  .pill {
    font-size: 10.5px; font-weight: 700; padding: 3px 10px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--panel); color: var(--muted);
  }
  .pill.run { color: var(--accent); border-color: rgba(56,189,248,0.4); background: #0b2b40; animation: pulse 1.6s ease-in-out infinite; }
  .pill.done { color: var(--ok); border-color: rgba(74,222,128,0.35); background: rgba(74,222,128,0.1); }
  .pill.bad { color: var(--err); border-color: rgba(248,113,113,0.35); background: rgba(248,113,113,0.1); }
  @keyframes pulse { 50% { opacity: .55; } }
  .rb-timer { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); }
  .rb-stat { font-size: 11px; color: var(--faint); }
  .rb-stat b { color: var(--ink); font-family: ui-monospace, monospace; font-size: 12px; }
  #rbLog {
    margin: 0; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word;
    font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.65;
    background: #070d1a; border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px;
  }
  #rbLog::-webkit-scrollbar { width: 8px; }
  #rbLog::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; }
  #rbLog .l { display: block; }
  #rbLog .l.tool { color: var(--accent); }
  #rbLog .l.sub { border-left: 2px solid var(--accent-2); padding-left: 8px; margin-left: 2px; }
  #rbLog .l.meta { color: var(--faint); }
  #rbLog .l.bad { color: var(--err); }
  #rbLog .l.good { color: var(--ok); }
  #rbLog .l.warn { color: #fbbf24; }
  #rbLog .l .who { color: var(--accent-2); font-weight: 700; }
  #rbFileBox { font-size: 11.5px; color: var(--muted); }
  #rbFileBox summary { cursor: pointer; color: var(--accent); }
  #rbFileList { font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.7; padding: 6px 0 0 14px; max-height: 150px; overflow: auto; white-space: pre-wrap; word-break: break-all; }

  /* ── confirm dialog ─────────────────────────────────────
     Native <dialog> rather than a hand-rolled overlay: showModal() brings the
     backdrop, focus trap, Esc-to-close and inert-background for free, and a
     <form method="dialog"> button closes it with its own value — so the whole
     thing is markup plus a promise wrapper. */
  dialog#confirmDlg {
    width: min(600px, 92vw); padding: 0; color: var(--ink);
    background: linear-gradient(180deg, var(--card-a), var(--card-b));
    border: 1px solid var(--line); border-radius: var(--radius);
    box-shadow: 0 30px 70px -20px rgba(0,0,0,0.9);
  }
  dialog#confirmDlg::backdrop { background: rgba(3,7,18,0.72); backdrop-filter: blur(3px); }
  dialog#confirmDlg .cf-top { height: 3px; background: var(--grad-line); border-radius: var(--radius) var(--radius) 0 0; }
  dialog#confirmDlg .cf-body { padding: 22px 24px 4px; }
  dialog#confirmDlg h3 {
    margin: 0 0 4px; font-size: 17px; font-weight: 800; letter-spacing: -0.01em;
    display: flex; align-items: center; gap: 10px;
  }
  dialog#confirmDlg h3 .cf-icon {
    width: 30px; height: 30px; border-radius: 9px; flex: none; display: grid; place-items: center;
    background: var(--grad); color: #05101f; font-size: 15px;
  }
  dialog#confirmDlg.danger h3 .cf-icon { background: linear-gradient(135deg, #f87171, #b91c1c); color: #fff; }
  dialog#confirmDlg .cf-sub { margin: 2px 0 14px 40px; font-size: 12px; color: var(--muted); }
  dialog#confirmDlg ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 9px; }
  dialog#confirmDlg li {
    font-size: 13px; line-height: 1.65; color: #dbe4f0;
    padding-left: 24px; position: relative;
  }
  dialog#confirmDlg li::before {
    content: "›"; position: absolute; left: 8px; top: -1px; color: var(--accent); font-weight: 700;
  }
  dialog#confirmDlg li b { color: var(--err); font-weight: 700; }
  dialog#confirmDlg li .cf-ok { color: var(--ok); }
  dialog#confirmDlg pre {
    margin: 14px 0 0; padding: 11px 13px; max-height: 150px; overflow: auto;
    background: #070d1a; border: 1px solid var(--line); border-radius: 9px;
    font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.7;
    white-space: pre-wrap; word-break: break-word; color: #cbd5e1;
  }
  dialog#confirmDlg .cf-label { margin: 16px 0 0; font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
  dialog#confirmDlg .cf-actions {
    display: flex; justify-content: flex-end; gap: 10px;
    padding: 18px 24px 20px; margin-top: 18px; border-top: 1px solid var(--line-soft);
  }
  dialog#confirmDlg .cf-actions button { font: inherit; cursor: pointer; border-radius: 10px; padding: 10px 20px; font-size: 13.5px; font-weight: 700; }
  dialog#confirmDlg .cf-cancel { background: var(--panel); color: var(--muted); border: 1px solid var(--line); }
  dialog#confirmDlg .cf-cancel:hover { color: var(--ink); border-color: #34456a; }
  dialog#confirmDlg .cf-go { background: var(--grad); color: #05101f; border: 0; box-shadow: 0 8px 20px -8px rgba(56,189,248,0.55); }
  dialog#confirmDlg.danger .cf-go { background: linear-gradient(135deg, #f87171, #b91c1c); color: #fff; box-shadow: 0 8px 20px -8px rgba(248,113,113,0.55); }
  dialog#confirmDlg .cf-go:hover { filter: brightness(1.07); }
  dialog#confirmDlg button:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(56,189,248,0.35); }

  /* ── upload progress dialog ─────────────────────────── */
  /* Shares the confirm dialog's chrome (see dialog#confirmDlg) so the two read
     as the same component; only the log body differs. */
  dialog#upDlg {
    width: min(560px, 92vw); padding: 0; color: var(--ink);
    background: linear-gradient(180deg, var(--card-a), var(--card-b));
    border: 1px solid var(--line); border-radius: var(--radius);
    box-shadow: 0 30px 70px -20px rgba(0,0,0,0.9);
  }
  dialog#upDlg::backdrop { background: rgba(3,7,18,0.72); backdrop-filter: blur(3px); }
  dialog#upDlg .cf-body { padding: 22px 24px 20px; }
  dialog#upDlg h3 { margin: 0 0 4px; font-size: 17px; font-weight: 800; display: flex; align-items: center; gap: 10px; }
  dialog#upDlg h3 .cf-icon { width: 30px; height: 30px; border-radius: 9px; flex: none; display: grid; place-items: center; background: var(--grad); color: #05101f; font-size: 15px; }
  dialog#upDlg.bad h3 .cf-icon { background: linear-gradient(135deg, #f87171, #b91c1c); color: #fff; }
  dialog#upDlg.done h3 .cf-icon { background: linear-gradient(135deg, #4ade80, #16a34a); color: #052e16; }
  dialog#upDlg .cf-sub { margin: 2px 0 14px 40px; font-size: 12px; color: var(--muted); }
  dialog#upDlg .cf-actions { display: flex; justify-content: flex-end; padding: 0 24px 20px; }
  dialog#upDlg .cf-actions button { font: inherit; cursor: pointer; border-radius: 10px; padding: 9px 20px; font-size: 13.5px; font-weight: 700; background: var(--panel); color: var(--muted); border: 1px solid var(--line); }
  dialog#upDlg .cf-actions button:hover { color: var(--ink); border-color: #34456a; }

  #log {
    font-size: 11.5px; font-family: ui-monospace, monospace; line-height: 1.85;
    max-height: 300px; overflow: auto;
    background: #070d1a; border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px;
  }
  #log:empty { display: none; }
  #log div.ok { color: var(--ok); }
  #log div.err { color: var(--err); }
  #log::-webkit-scrollbar { width: 8px; }
  #log::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; }

  /* the upload button sits beside Rebrand now — same weight, different hue so
     the two primary actions stay tellable apart at a glance */
  button.fire.alt { background: linear-gradient(135deg, #a78bfa, #6366f1); color: #0b1120; box-shadow: 0 8px 20px -8px rgba(129,140,248,0.55); }
  button.fire.go { background: linear-gradient(135deg, #4ade80, #16a34a); color: #052e16; box-shadow: 0 8px 20px -8px rgba(74,222,128,0.5); }

  /* ── ส่วนที่ 7: post-rebrand check ──────────────────── */
  #pvLog {
    margin: 6px 0 0; padding: 10px 12px; max-height: 220px; overflow: auto;
    background: #070d1a; border: 1px solid rgba(248,113,113,0.35); border-radius: 9px;
    font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.7;
    white-space: pre-wrap; word-break: break-word; color: #fca5a5;
  }
  #pvErrMsg { color: var(--err); font-weight: 700; }

  /* The only button here that publishes. Red on purpose — it should not look
     like the green "have a look" button sitting directly above it. */
  button.fire.go-live { background: linear-gradient(135deg, #fb7185, #be123c); color: #fff; box-shadow: 0 8px 20px -8px rgba(244,63,94,0.55); }
  #dpLog {
    margin: 6px 0 0; padding: 10px 12px; max-height: 260px; overflow: auto;
    background: #070d1a; border: 1px solid var(--line); border-radius: 9px;
    font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.7;
    white-space: pre-wrap; word-break: break-word; color: #cbd5e1;
  }
  #dpBox.bad #dpLog { border-color: rgba(248,113,113,0.35); color: #fca5a5; }
  #dpBox.bad #dpMsg { color: var(--err); font-weight: 700; }
  #dpBox.done #dpMsg { color: var(--ok); font-weight: 700; }
  /* A checklist, not prose: the operator is looking away at another tab, and
     ticking is how they keep their place when they come back. */
  ul.checks { margin: 4px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 9px; }
  ul.checks label { display: flex; gap: 9px; align-items: flex-start; font-size: 12.5px; line-height: 1.6; color: #dbe4f0; cursor: pointer; }
  ul.checks input { margin: 3px 0 0; accent-color: var(--ok); width: 15px; height: 15px; flex: none; cursor: pointer; }
  ul.checks label:has(input:checked) { color: var(--faint); text-decoration: line-through; }

  /* Cloudflare account row */
  #cfNow b { color: #dbe4f0; font-weight: 700; }
  #cfNow code { font-size: 11px; color: var(--faint); }
  a.cf-auth {
    display: inline-flex; align-items: center; gap: 8px; margin: 6px 0 4px;
    padding: 10px 16px; border-radius: 10px; text-decoration: none;
    font-size: 13px; font-weight: 700; color: #08131f;
    background: linear-gradient(180deg, #7dd3fc, #38bdf8);
    box-shadow: 0 4px 14px rgba(56,189,248,0.28);
  }
  a.cf-auth:hover { filter: brightness(1.08); }
  .cf-acct {
    display: flex; align-items: center; gap: 10px; width: 100%;
    margin-top: 6px; padding: 9px 12px; text-align: left; cursor: pointer;
    border: 1px solid var(--line); border-radius: 9px;
    background: rgba(148,163,184,0.06); color: #dbe4f0; font-size: 12.5px;
  }
  .cf-acct:hover { border-color: rgba(125,211,252,0.5); background: rgba(56,189,248,0.08); }
  .cf-acct .id { margin-left: auto; font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--faint); }
  .cf-acct.on { border-color: rgba(74,222,128,0.45); background: rgba(74,222,128,0.08); }
  .cf-acct.on::after { content: 'ใช้อยู่'; font-size: 10.5px; color: var(--ok); font-weight: 700; }

  /* ── ส่วนที่ 8: commit + push ────────────────────────── */
  #gtWhere b { color: #dbe4f0; font-weight: 700; }
  #gtWhere code { font-size: 11px; color: var(--faint); }
  #gtMsg { width: 100%; }
  #gtFiles, #gtLog {
    margin: 6px 0 0; padding: 10px 12px; max-height: 200px; overflow: auto;
    background: #070d1a; border: 1px solid var(--line); border-radius: 9px;
    font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.7;
    white-space: pre-wrap; word-break: break-word; color: #cbd5e1;
  }
  #gtBox.bad #gtLog { border-color: rgba(248,113,113,0.35); color: #fca5a5; }
  #gtBox.bad #gtMsgOut { color: var(--err); font-weight: 700; }
  #gtBox.done #gtMsgOut { color: var(--ok); font-weight: 700; }
</style>
</head>
<body>
<header>
  <div class="head-inner">
    <h1><span class="mark">📦</span> <span class="grad-text">Rebrand Asset Uploader</span></h1>
    
  </div>
</header>
<main>
  <!-- Steps run 1-5 top to bottom, in order, always. Nothing reflows into a
       different position as the window resizes — the numbers are the whole
       navigation, so they have to stay put. -->
  <div class="steps">
    <section class="card two-up" id="card1">
    <h2 data-n="1">ไฟล์แบรนด์ · src/assets</h2>
    <p class="sub">โลโก้ / เนื้อหา (docx) / พื้นหลัง (รูป หรือ สี/ไล่สี) / แบนเนอร์ / รูป promotion + carousel</p>
    <div class="fieldset">
<div class="field" data-img>
      <div class="row"><label>Logo</label><span class="target">src/assets/logo.webp + public/logo.webp</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="logo" /><img class="thumb" /></div>
      <span class="status">อัพครั้งเดียว เซฟลงทั้ง src/assets และ public ให้อัตโนมัติ</span>
    </div>
    <div class="field">
      <div class="row"><label>Content brief</label><span class="target">content.docx / content.txt</span></div>
      <div class="row"><input type="file" accept=".docx,.txt" data-slot="docx" /></div>
      <span class="status"></span>
    </div>
    <div class="field" id="bgField" data-img>
      <div class="row"><label>Background</label><span class="target">bg.png</span><span class="opt">เลือกอย่างใดอย่างหนึ่ง</span></div>
      <div class="row modes">
        <label><input type="radio" name="bgmode" value="image" checked /> รูปภาพ</label>
        <label><input type="radio" name="bgmode" value="color" /> สีเดียว</label>
        <label><input type="radio" name="bgmode" value="gradient" /> ไล่สี (gradient)</label>
      </div>
      <div class="row panel" data-mode="image">
        <input type="file" accept="image/*" data-slot="bg" id="bgFile" /><img class="thumb" />
      </div>
      <div class="row panel" data-mode="color" hidden>
        <input type="color" id="bgColor" value="#0f172a" />
        <input type="text" id="bgColorHex" value="#0f172a" spellcheck="false" />
        <span class="hint">ใช้เป็น CSS สีเดียว — ไม่โหลดรูป</span>
      </div>
      <div class="row panel" data-mode="gradient" hidden>
        <input type="color" id="bgFrom" value="#0f172a" />
        <input type="text" id="bgFromHex" value="#0f172a" spellcheck="false" />
        <input type="color" id="bgTo" value="#1e3a8a" />
        <input type="text" id="bgToHex" value="#1e3a8a" spellcheck="false" />
        <select id="bgType">
          <option value="linear">เส้นตรง</option>
          <option value="radial">รัศมี (radial)</option>
        </select>
        <select id="bgAngle">
          <option value="180" selected>บน → ล่าง</option>
          <option value="0">ล่าง → บน</option>
          <option value="90">ซ้าย → ขวา</option>
          <option value="270">ขวา → ซ้าย</option>
          <option value="135">ทแยง ↘</option>
          <option value="225">ทแยง ↙</option>
          <option value="45">ทแยง ↗</option>
          <option value="315">ทแยง ↖</option>
        </select>
      </div>
      <div class="row"><div id="bgPreview" hidden></div></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Banner 1</label><span class="target">banner1.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="1" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Banner 1 มือถือ</label><span class="opt">optional</span><span class="target">banner1-mobile.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="bannermobile" /><img class="thumb" /></div>
      <span class="status">รูปแนวตั้ง/จัตุรัสสำหรับจอมือถือ · ไม่ใส่ = มือถือใช้ Banner 1 ตัวเดียวกับคอม · <b>ถ้าอัพ Banner 1 ใหม่โดยไม่ใส่ช่องนี้ ตัวมือถือของแบรนด์เก่าจะถูกลบทิ้งให้</b></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Banner 2</label><span class="opt">optional</span><span class="target">banner2.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="2" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Banner 3</label><span class="opt">optional</span><span class="target">banner3.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="3" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Banner 4</label><span class="opt">optional</span><span class="target">banner4.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="4" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Promotion + Carousel 1</label><span class="target">slide1.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="1" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Promotion + Carousel 2</label><span class="target">slide2.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="2" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Promotion + Carousel 3</label><span class="target">slide3.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="3" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Promotion + Carousel 4</label><span class="opt">optional</span><span class="target">slide4.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="4" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
      </div>
    
    </section>
    <section class="card" id="card2">
      <h2 data-n="2">ไอคอนเว็บ · public</h2>
      <p class="sub">favicon (สร้างชุดไอคอนให้อัตโนมัติ) — โลโก้ public ดึงจาก Logo ในส่วนที่ 1 ให้เอง</p>
      <div class="field" data-img>
        <div class="row"><label>Favicon</label><span class="target">favicon.ico + .png set + .svg</span></div>
        <div class="row"><input type="file" accept="image/*,.svg" data-slot="favicon" /><img class="thumb" /></div>
        <span class="status"></span>
      </div>
    </section>
    <section class="card" id="card3">
      <h2 data-n="3">ลิงก์ · aff / ไลน์</h2>
      <div class="field" id="affField">
        <div class="row"><label>ลิงก์ aff</label><span class="target">src/pages/login.astro + register.astro</span></div>
        <div class="row"><input type="url" class="linkinput" id="affInput" placeholder="https://..." spellcheck="false" /></div>
        <span class="status">แก้ค่า <code>targetUrl</code> ในทั้งหน้า login และ register พร้อมกัน</span>
      </div>
      <div class="field" id="lineField">
        <div class="row"><label>ลิงก์ไลน์</label><span class="target">astro.config.mjs → redirects "/line"</span></div>
        <div class="row"><input type="url" class="linkinput" id="lineInput" placeholder="https://..." spellcheck="false" /></div>
        <span class="status">แก้ปลายทางของ redirect <code>/line</code></span>
      </div>
    </section>
    <section class="card two-up" id="card4">
      <h2 data-n="4">SEO · Title / Meta หน้าย่อย</h2>
      <div class="pull-row">
        <button type="button" id="pullDocx" class="ghost">📄 ดึงจาก Content brief</button>
        <span class="pull-hint">อัพ Content brief (.docx หรือ .txt) ในส่วนที่ 1 ก่อน แล้วค่อยกดปุ่มนี้</span>
      </div>
      <div class="fieldset">
<div class="field" data-page="promotion">
        <div class="row"><label>โปรโมชั่น</label><span class="target">src/pages/promotion.astro</span></div>
        <input type="text" class="metatitle" data-k="title" placeholder="Title" spellcheck="false" />
        <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description" spellcheck="false"></textarea>
        <span class="status"></span>
      </div>
      <div class="field" data-page="contactus">
        <div class="row"><label>ติดต่อเรา</label><span class="target">src/pages/contact-us.astro</span></div>
        <input type="text" class="metatitle" data-k="title" placeholder="Title" spellcheck="false" />
        <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description" spellcheck="false"></textarea>
        <span class="status"></span>
      </div>
      <div class="field" data-page="demo">
        <div class="row"><label>ทดลองเล่น</label><span class="target">src/pages/ทดลองเล่น.astro</span></div>
        <input type="text" class="metatitle" data-k="title" placeholder="Title" spellcheck="false" />
        <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description" spellcheck="false"></textarea>
        <span class="status"></span>
      </div>
      <div class="field" data-page="entrance">
        <div class="row"><label>ทางเข้า</label><span class="target">src/pages/ทางเข้า.astro</span></div>
        <input type="text" class="metatitle" data-k="title" placeholder="Title" spellcheck="false" />
        <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description" spellcheck="false"></textarea>
        <span class="status"></span>
      </div>
      </div>
    
    </section>
    <section class="card" id="card5">
      <h2 data-n="5">หน้าเสริม · เปิด/ปิด</h2>
      <p class="sub">ติ๊ก = มีหน้านี้ในเว็บ · เอาติ๊กออก = พักหน้าไว้ (ไฟล์ไม่ถูกลบ เปิดกลับได้ทุกเมื่อ)</p>

      <div class="field newpage" data-newpage="huaycheck">
        <div class="row">
          <label class="switch"><input type="checkbox" class="np-toggle" /><span class="slider"></span></label>
          <label>ตรวจหวย</label>
          <span class="target">src/pages/ตรวจหวย.astro</span>
          <span class="badge np-badge"></span>
        </div>
        <span class="status">เปิดเฉพาะเว็บหวย — หน้านี้มากับ template พร้อมเนื้อหาแล้ว</span>
      </div>
      <div class="field newpage" data-newpage="huayguide">
        <div class="row">
          <label class="switch"><input type="checkbox" class="np-toggle" /><span class="slider"></span></label>
          <label>แนวทาง</label>
          <span class="target">src/pages/แนวทาง.astro</span>
          <span class="badge np-badge"></span>
        </div>
        <span class="status">เปิดเฉพาะเว็บหวย — หน้านี้มากับ template พร้อมเนื้อหาแล้ว</span>
      </div>

      <div class="field newpage" data-newpage="article">
        <div class="row">
          <label class="switch"><input type="checkbox" class="np-toggle" /><span class="slider"></span></label>
          <label>บทความ</label>
          <span class="target">src/pages/บทความ.astro</span>
          <span class="badge np-badge"></span>
        </div>
        <div class="np-body" hidden>
          <input type="text" class="metatitle" data-k="title" placeholder="Title (เว้นว่างได้ — Claude เขียนให้)" spellcheck="false" />
          <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description (เว้นว่างได้ — Claude เขียนให้)" spellcheck="false"></textarea>
        </div>
        <span class="status"></span>
      </div>
      <div class="field newpage" data-newpage="aboutus">
        <div class="row">
          <label class="switch"><input type="checkbox" class="np-toggle" /><span class="slider"></span></label>
          <label>เกี่ยวกับเรา</label>
          <span class="target">src/pages/about-us.astro</span>
          <span class="badge np-badge"></span>
        </div>
        <div class="np-body" hidden>
          <input type="text" class="metatitle" data-k="title" placeholder="Title (เว้นว่างได้ — Claude เขียนให้)" spellcheck="false" />
          <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description (เว้นว่างได้ — Claude เขียนให้)" spellcheck="false"></textarea>
        </div>
        <span class="status"></span>
      </div>

      <div class="field newpage" data-newpage="register">
        <div class="row">
          <label class="switch"><input type="checkbox" class="np-toggle" /><span class="slider"></span></label>
          <label>สมัครสมาชิก</label>
          <span class="target">src/pages/register.astro</span>
          <span class="badge np-badge"></span>
        </div>
        <div class="np-body" hidden>
          <input type="text" class="metatitle" data-k="title" placeholder="Title (เว้นว่างได้ — ใช้ของหน้าเดิม)" spellcheck="false" />
          <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description (เว้นว่างได้ — ใช้ของหน้าเดิม)" spellcheck="false"></textarea>
        </div>
        <span class="status">เปิด = เปลี่ยนหน้าเด้งอัตโนมัติเป็นหน้าจริงที่มีปุ่มสมัครสมาชิกปุ่มเดียว · ปิด = เอาหน้าเด้งกลับ (ปลายทางเดิมไม่เปลี่ยน)</span>
      </div>
      <div class="field newpage" data-newpage="login">
        <div class="row">
          <label class="switch"><input type="checkbox" class="np-toggle" /><span class="slider"></span></label>
          <label>เข้าสู่ระบบ</label>
          <span class="target">src/pages/login.astro</span>
          <span class="badge np-badge"></span>
        </div>
        <div class="np-body" hidden>
          <input type="text" class="metatitle" data-k="title" placeholder="Title (เว้นว่างได้ — ใช้ของหน้าเดิม)" spellcheck="false" />
          <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description (เว้นว่างได้ — ใช้ของหน้าเดิม)" spellcheck="false"></textarea>
        </div>
        <span class="status">เปิด = เปลี่ยนหน้าเด้งอัตโนมัติเป็นหน้าจริงที่มีปุ่มเข้าระบบเกมปุ่มเดียว · ปิด = เอาหน้าเด้งกลับ (ปลายทางเดิมไม่เปลี่ยน)</span>
      </div>
    </section>
  </div>

  <!-- The Rebrand card is not a sixth step, it is the action panel: it stays
       stuck beside the form so the two buttons are reachable at any scroll
       position, which is what the old sticky footer was trying to do. -->
  <aside class="action">
    <section class="card" id="card6">
      <h2 data-n="6">สร้างคำสั่ง Rebrand (สำหรับ Claude Code)</h2>
      <div class="field">
        <div class="row"><label>ชื่อแบรนด์</label></div>
        <input type="text" class="linkinput" id="rbBrand" placeholder="เช่น PABLO666" spellcheck="false" />
      </div>
      <div class="field">
        <div class="row"><label>URL production จริง</label><span class="opt">optional</span></div>
        <input type="url" class="linkinput" id="rbUrl" placeholder="เช่น https://www.pablo666-brand.com" spellcheck="false" />
        <span class="status">ใส่เมื่อรู้โดเมนจริง — เว้นว่างได้ คำสั่งจะสั่งห้ามเปลี่ยนโดเมนเดิม</span>
      </div>
      <div class="field">
        <div class="row"><label>หมายเหตุ / variant hints</label><span class="opt">optional</span></div>
        <textarea class="metadesc" id="rbNotes" rows="2" placeholder="เช่น โทนทอง-ดำ, ใช้ NavbarPremium, เน้นหน้าโปรโมชั่น" spellcheck="false"></textarea>
      </div>
      <div class="field">
        <div class="row"><label>คำสั่งที่จะรัน</label><button type="button" id="rbCopy" class="ghost">📋 Copy คำสั่ง</button></div>
        <textarea class="metadesc" id="rbPrompt" rows="3" readonly spellcheck="false"></textarea>
        <span class="status" id="rbHint">Copy ไว้วางเองใน Claude Code ก็ได้ หรือกด "เริ่ม Rebrand" ให้ระบบยิงให้เลย</span>
      </div>
      <div class="field">
        <div class="row">
          <label class="switch warn"><input type="checkbox" id="rbFast" /><span class="slider"></span></label>
          <label for="rbFast">Fast mode</label>
          <span class="badge warn" id="rbFastBadge" hidden>โควตาแยกต่างหาก</span>
        </div>
        <span class="status" id="rbFastCheck"></span>
      </div>
      <div class="field">
        <div class="row">
          <button type="button" id="uploadAll" class="fire alt">⬆ อัพโหลดทั้งหมด</button>
          <button type="button" id="rbFire" class="fire" disabled>▶ เริ่ม Rebrand</button>
          <button type="button" id="rbStop" class="ghost danger" disabled>■ หยุด</button>
          <button type="button" id="rbDry" class="ghost" title="ยิง prompt สั้นๆ เพื่อเช็กว่าต่อ Claude ได้จริง ใช้เวลาไม่กี่วินาที ไม่แตะไฟล์">🧪 ทดสอบท่อ</button>
          <span class="pill" id="rbPill">พร้อม</span>
          <span class="rb-timer" id="rbTimer"></span>
        </div>
        <span class="status" id="rbFireHint">อัพโหลดไฟล์ให้เสร็จก่อน แล้วปุ่ม Rebrand จะกดได้ · งานจริงกินเวลาหลายสิบนาที · <strong>ห้ามปิดหน้าต่างดำ (cmd)</strong> ระหว่างรัน (ปิดแท็บเบราว์เซอร์ได้ ไม่กระทบ)</span>
      </div>
      <div class="field" id="rbRunBox" hidden>
        <div class="row">
          <span class="rb-stat">tools <b id="rbTools">0</b></span>
          <span class="rb-stat" id="rbErrWrap" hidden>ข้อผิดพลาด <b id="rbErrs">0</b></span>
          <span class="rb-stat">ไฟล์ที่แก้ <b id="rbFiles">0</b></span>
          <span class="rb-stat" id="rbMeta"></span>
        </div>
        <pre id="rbLog"></pre>
        <details id="rbFileBox" hidden>
          <summary>ไฟล์ที่ถูกแก้</summary>
          <div id="rbFileList"></div>
        </details>
        <span class="status" id="rbDone"></span>
      </div>
    </section>

    <section class="card" id="card7">
      <h2 data-n="7">ทดสอบหน้าเว็บ</h2>

      <div class="field">
        <div class="row">
          <button type="button" id="pvStart" class="fire go">🔍 ทดสอบหน้าเว็บ</button>
          <button type="button" id="pvOpen" class="ghost" hidden>🌐 เปิดเว็บ</button>
          <button type="button" id="pvStop" class="ghost danger" hidden>■ ปิดเซิร์ฟเวอร์ทดสอบ</button>
          <span class="pill" id="pvPill">ยังไม่ได้ทดสอบ</span>
        </div>
        <span class="status" id="pvHint">ทำหลังรีแบรนด์เสร็จ · ใช้เวลาประมาณครึ่งนาที</span>
      </div>

      <div class="field" id="pvErrBox" hidden>
        <div class="row"><label>เว็บสร้างไม่ผ่าน</label></div>
        <span class="status" id="pvErrMsg"></span>
        <pre id="pvLog"></pre>
      </div>

      <div class="field" id="pvCheck" hidden>
        <div class="row"><label>ดูให้ครบ 5 ข้อนี้</label><span class="opt" id="pvCount">0/5</span></div>
        <ul class="checks">
          <li><label><input type="checkbox" /> ชื่อแบรนด์ถูกต้องทุกหน้า ไม่มีชื่อเก่าโผล่</label></li>
          <li><label><input type="checkbox" /> สีเว็บเข้ากับโลโก้ที่อัพไป</label></li>
          <li><label><input type="checkbox" /> รูปขึ้นครบ ทั้งแบนเนอร์และสไลด์ ไม่มีช่องว่างหรือรูปแตก</label></li>
          <li><label><input type="checkbox" /> กดเมนูทุกอันแล้วเปิดได้ ไม่เจอหน้า 404</label></li>
          <li><label><input type="checkbox" /> ปุ่มสมัคร/เข้าสู่ระบบ กดแล้วไปถูกที่</label></li>
        </ul>
        <span class="status">ติ๊กให้ครบ 5 ข้อ แล้วปุ่มขึ้นเว็บจริงข้างล่างจะกดได้</span>
      </div>

      <!-- Shown whether or not anyone intends to switch: the account is the one
           thing about a deploy that is invisible until it is wrong. -->
      <div class="field" id="cfBox">
        <div class="row">
          <label>บัญชี Cloudflare</label>
          <button type="button" id="cfSwitch" class="ghost">🔑 สลับบัญชี</button>
          <button type="button" id="cfCancelBtn" class="ghost danger" hidden>■ ยกเลิก</button>
        </div>
        <span class="status" id="cfNow">กำลังตรวจสอบ...</span>
        <div id="cfAuth" hidden>
          <a id="cfAuthLink" class="cf-auth" target="_blank" rel="noopener">🔓 เปิดหน้าอนุญาตของ Cloudflare</a>
          <span class="status">กดลิงก์ → login บัญชีใหม่ → กด Allow แล้วกลับมาที่หน้านี้ รอสักครู่</span>
        </div>
        <div id="cfPick" hidden>
          <div class="row"><label>เลือกบัญชีที่จะ deploy เข้า</label></div>
          <div id="cfPickList"></div>
        </div>
        <pre id="cfLog" hidden></pre>
      </div>

      <div class="field">
        <div class="row">
          <button type="button" id="dpStart" class="fire go-live" disabled>🚀 ขึ้นเว็บจริง</button>
          <span class="pill" id="dpPill">ยังไม่ได้ขึ้น</span>
          <span class="rb-timer" id="dpTimer"></span>
        </div>
        <span class="status" id="dpHint">ทดสอบหน้าเว็บและติ๊กให้ครบ 5 ข้อก่อน</span>
      </div>

      <div class="field" id="dpBox" hidden>
        <div class="row"><label id="dpTitle"></label></div>
        <span class="status" id="dpMsg"></span>
        <pre id="dpLog"></pre>
      </div>
    </section>

    <section class="card" id="card8">
      <h2 data-n="8">เซฟงานขึ้น GitLab</h2>

      <div class="field">
        <div class="row"><label>จะเซฟขึ้นที่ไหน</label></div>
        <span class="status" id="gtWhere">กำลังตรวจสอบ...</span>
      </div>

      <div class="field" id="gtFilesBox" hidden>
        <div class="row"><label>ไฟล์ที่เปลี่ยน</label><span class="opt" id="gtCount"></span></div>
        <pre id="gtFiles"></pre>
      </div>

      <div class="field">
        <div class="row"><label>ข้อความ commit</label></div>
        <div class="row"><input type="text" id="gtMsg" spellcheck="false" placeholder="เขียนสั้นๆ ว่ารอบนี้ทำอะไร" /></div>
        <span class="status">เขียนเป็นภาษาอะไรก็ได้ — ไว้ให้คนอ่านย้อนหลังรู้ว่ารอบนี้เปลี่ยนอะไร</span>
      </div>

      <div class="field">
        <div class="row">
          <button type="button" id="gtStart" class="fire go" disabled>💾 commit + push</button>
          <span class="pill" id="gtPill">ยังไม่ได้เซฟ</span>
          <span class="rb-timer" id="gtTimer"></span>
        </div>
        <span class="status" id="gtHint">ทำหลัง deploy เสร็จ หรือจะเซฟระหว่างทางก็ได้</span>
      </div>

      <div class="field" id="gtBox" hidden>
        <div class="row"><label id="gtTitle"></label></div>
        <span class="status" id="gtMsgOut"></span>
        <pre id="gtLog"></pre>
      </div>
    </section>
  </aside>
</main>
<dialog id="confirmDlg">
  <div class="cf-top"></div>
  <form method="dialog">
    <div class="cf-body">
      <h3><span class="cf-icon" id="cfIcon">▶</span><span id="cfTitle"></span></h3>
      <p class="cf-sub" id="cfSub"></p>
      <ul id="cfList"></ul>
      <p class="cf-label" id="cfCodeLabel" hidden>คำสั่งที่จะรัน</p>
      <pre id="cfCode" hidden></pre>
    </div>
    <div class="cf-actions">
      <button type="submit" value="cancel" class="cf-cancel" id="cfCancel">ยกเลิก</button>
      <button type="submit" value="ok" class="cf-go" id="cfOk">ตกลง</button>
    </div>
  </form>
</dialog>
<dialog id="upDlg">
  <div class="cf-top"></div>
  <div class="cf-body">
    <h3><span class="cf-icon" id="upIcon">⬆</span><span id="upTitle">กำลังอัพโหลด...</span></h3>
    <p class="cf-sub" id="upSub">กำลังส่งไฟล์เข้า src/assets และ public</p>
    <div id="log"></div>
  </div>
  <div class="cf-actions" id="upActions" hidden>
    <button type="button" class="cf-cancel" id="upClose">ปิด</button>
  </div>
</dialog>
<script>
  // live thumbnails
  document.querySelectorAll('.field[data-img] input[type=file]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const thumb = inp.parentElement.querySelector('.thumb');
      if (!thumb) return;
      if (inp.files[0]) { thumb.src = URL.createObjectURL(inp.files[0]); thumb.classList.add('show'); }
      else thumb.classList.remove('show');
    });
  });

  const log = document.getElementById('log');
  // Declared up here beside addLog, not next to the upload handler, so addLog
  // can never touch it before initialisation (temporal dead zone).
  let upFailed = false;
  function addLog(msg, ok) {
    if (!ok) upFailed = true;
    const d = document.createElement('div');
    d.className = ok ? 'ok' : 'err';
    d.textContent = (ok ? '✓ ' : '✗ ') + msg;
    // append, not prepend: the log now reads top-to-bottom in the order things
    // actually happened, which is what an operator watching a modal expects
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  // Never let a missing/renamed .status span abort an upload run: this is a
  // cosmetic sink, so a markup slip must not throw out of the click handler
  // and skip the actual fetch (that shipped once — the favicon field had no
  // .status, so picking a favicon silently uploaded nothing).
  function setStatus(inp, txt) {
    const s = inp?.closest('.field')?.querySelector('.status');
    if (s) s.textContent = txt;
    else console.warn('[uploader] missing .status for slot:', inp?.dataset?.slot ?? inp);
  }

  // ── Background: image / solid colour / gradient — pick exactly one ─────────
  const bgField = document.getElementById('bgField');
  const bgFile = document.getElementById('bgFile');
  const bgPreview = document.getElementById('bgPreview');
  const $ = (id) => document.getElementById(id);
  const bgMode = () => bgField.querySelector('input[name=bgmode]:checked').value;

  // keep each <input type=color> and its hex textbox in sync, both directions
  [['bgColor','bgColorHex'], ['bgFrom','bgFromHex'], ['bgTo','bgToHex']].forEach(([pick, text]) => {
    $(pick).addEventListener('input', () => { $(text).value = $(pick).value; drawPreview(); });
    $(text).addEventListener('input', () => {
      const v = $(text).value.trim();
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) { $(pick).value = v.length === 4 ? '#' + [...v.slice(1)].map(c => c + c).join('') : v; }
      drawPreview();
    });
  });
  ['bgType','bgAngle'].forEach((id) => $(id).addEventListener('change', drawPreview));

  // The CSS here mirrors the server's SVG geometry, so this swatch is a true
  // preview of the bg.png that will be written.
  function drawPreview() {
    const mode = bgMode();
    if (mode === 'color') {
      bgPreview.hidden = false;
      bgPreview.style.background = $('bgColorHex').value.trim();
    } else if (mode === 'gradient') {
      bgPreview.hidden = false;
      const from = $('bgFromHex').value.trim(), to = $('bgToHex').value.trim();
      bgPreview.style.background = $('bgType').value === 'radial'
        ? 'radial-gradient(circle at 50% 50%, ' + from + ', ' + to + ')'
        : 'linear-gradient(' + $('bgAngle').value + 'deg, ' + from + ', ' + to + ')';
    } else {
      bgPreview.hidden = true;
    }
    $('bgAngle').hidden = $('bgType').value === 'radial';
  }

  bgField.querySelectorAll('input[name=bgmode]').forEach((r) => {
    r.addEventListener('change', () => {
      bgField.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.mode !== bgMode(); });
      drawPreview();
    });
  });
  drawPreview();

  // Builds the /upload call for whichever bg mode is active. Returns null when
  // the image mode is selected but no file was chosen (bg stays untouched).
  function bgRequest() {
    const mode = bgMode();
    if (mode === 'image') {
      if (!bgFile.files.length) return null;
      return { q: new URLSearchParams({ slot: 'bg' }), body: bgFile.files[0], label: 'bg (รูปภาพ)' };
    }
    if (mode === 'color') {
      return { q: new URLSearchParams({ slot: 'bg', color: $('bgColorHex').value.trim() }), body: null, label: 'bg (สีเดียว)' };
    }
    const q = new URLSearchParams({
      slot: 'bg',
      from: $('bgFromHex').value.trim(),
      to: $('bgToHex').value.trim(),
      type: $('bgType').value,
      angle: $('bgAngle').value,
    });
    return { q, body: null, label: 'bg (ไล่สี)' };
  }

  // ── Text links: pre-fill with the values currently in the source ──────────
  const affInput = document.getElementById('affInput');
  const lineInput = document.getElementById('lineInput');
  function setLinkStatus(field, txt) { document.getElementById(field).querySelector('.status').textContent = txt; }
  fetch('/current').then((r) => r.json()).then((j) => {
    if (j.aff) affInput.placeholder = j.aff;
    if (j.line) lineInput.placeholder = j.line;
  }).catch(() => {});

  // POST one text link if its box was filled in; blank = leave the code as-is.
  async function sendLink(slot, input, fieldId, label) {
    const value = input.value.trim();
    if (!value) return false;
    const q = new URLSearchParams({ slot, value });
    setLinkStatus(fieldId, '⏳ กำลังบันทึก...');
    try {
      const res = await fetch('/upload?' + q.toString(), { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      setLinkStatus(fieldId, '✅ ' + j.written.join(', '));
      addLog(label + ' → ' + j.written.join(', '), true);
      input.placeholder = value;
      input.value = '';
    } catch (e) {
      setLinkStatus(fieldId, '❌ ' + e.message);
      addLog(label + ': ' + e.message, false);
    }
    return true;
  }

  // ── Sub-page Title/Meta: pre-fill from source, pull from docx, save ────────
  const metaFields = [...document.querySelectorAll('.field[data-page]')];
  const metaEls = (f) => ({
    title: f.querySelector('[data-k=title]'),
    desc: f.querySelector('[data-k=desc]'),
    status: f.querySelector('.status'),
  });
  // remember what's currently saved so "อัพโหลดทั้งหมด" only writes changed pages
  function markSaved(f, title, desc) { f.dataset.origTitle = title; f.dataset.origDesc = desc; }

  fetch('/current-pages').then((r) => r.json()).then((cur) => {
    for (const f of metaFields) {
      const c = cur[f.dataset.page];
      if (!c) continue;
      const { title, desc } = metaEls(f);
      title.value = c.title || '';
      desc.value = c.meta || '';
      markSaved(f, title.value, desc.value);
    }
  }).catch(() => {});

  document.getElementById('pullDocx').addEventListener('click', async () => {
    try {
      // Prefer the file the operator just browsed (not yet uploaded) so the
      // preview reads the original source; fall back to the staged content.docx.
      const docxInput = document.querySelector('input[data-slot="docx"]');
      const picked = docxInput && docxInput.files && docxInput.files[0];
      const res = picked
        ? await fetch('/parse-docx', { method: 'POST', body: picked })
        : await fetch('/parse-docx');
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      let filled = 0;
      for (const f of metaFields) {
        const p = j.pages[f.dataset.page];
        const { title, desc, status } = metaEls(f);
        if (p) {
          if (p.title) title.value = p.title;
          if (p.meta) desc.value = p.meta;
          status.textContent = '📄 ดึงจาก docx แล้ว — ตรวจ/แก้ก่อนกดอัพโหลด';
          filled++;
        } else {
          status.textContent = 'ไม่พบใน docx — คงค่าเดิม';
        }
      }
      (j.warnings || []).forEach((w) => addLog('docx: ' + w, false));
      const src = picked ? ('ไฟล์ที่เลือก (' + picked.name + ')') : 'content.docx ในโปรเจค';
      addLog('ดึงจาก ' + src + ': เติมได้ ' + filled + ' หน้า', filled > 0);
    } catch (e) {
      addLog('ดึงจาก docx: ' + e.message, false);
    }
  });

  // POST one page's Title/Meta if it changed since last save. Blank = skip.
  async function sendPageMeta(f) {
    const { title, desc, status } = metaEls(f);
    const t = title ? title.value.trim() : '', d = desc ? desc.value.trim() : '';
    if (t === (f.dataset.origTitle || '') && d === (f.dataset.origDesc || '')) return false;
    if (!t || !d) { status.textContent = '⚠️ ต้องกรอกทั้ง Title และ Meta'; return false; }
    const q = new URLSearchParams({ slot: 'pagemeta', page: f.dataset.page, title: t, desc: d });
    status.textContent = '⏳ กำลังบันทึก...';
    try {
      const res = await fetch('/upload?' + q.toString(), { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      status.textContent = '✅ ' + j.written.join(', ');
      addLog(f.dataset.page + ' → ' + j.written.join(', '), true);
      markSaved(f, t, d);
    } catch (e) {
      status.textContent = '❌ ' + e.message;
      addLog(f.dataset.page + ': ' + e.message, false);
    }
    return true;
  }

  // ── Optional preset pages (ส่วนที่ 5): toggle → scaffold file + nav link ────
  const newpageFields = [...document.querySelectorAll('.field[data-newpage]')];
  const npEls = (f) => ({
    toggle: f.querySelector('.np-toggle'),
    body: f.querySelector('.np-body'),
    title: f.querySelector('[data-k=title]'),
    desc: f.querySelector('[data-k=desc]'),
    status: f.querySelector('.status'),
    badge: f.querySelector('.np-badge'),
  });
  // The lottery toggles are pure on/off — those pages ship with the repo and
  // have no Title/Meta fields, so .np-body and the inputs are absent for them.
  // Every read of those three has to tolerate null or the whole card throws.
  for (const f of newpageFields) {
    const { toggle, body } = npEls(f);
    toggle.addEventListener('change', () => { if (body) body.hidden = !toggle.checked; });
  }
  fetch('/current-newpages').then((r) => r.json()).then((cur) => {
    for (const f of newpageFields) {
      const c = cur[f.dataset.newpage];
      if (!c) continue;
      const { toggle, body, title, desc, badge } = npEls(f);
      // Remember the state on load. Only a CHANGE is sent on upload — without
      // this every run would re-park or re-enable pages nobody touched, and
      // parking rewrites the navbar and footer.
      f.dataset.origOn = c.exists ? '1' : '0';
      if (c.exists) {
        toggle.checked = true;
        if (body) body.hidden = false;
        if (title) title.value = c.title || '';
        if (desc) desc.value = c.meta || '';
        badge.textContent = 'เปิดอยู่'; badge.className = 'badge np-badge exists';
      } else if (c.parked) {
        // The page exists but a previous rebrand switched it off. Left OFF it
        // stays off; switched on it is moved back, not scaffolded again — so
        // the label has to say "เปิดกลับ" rather than "สร้างใหม่", or the
        // operator expects a blank page and gets last brand's article.
        if (title) title.value = c.title || '';
        if (desc) desc.value = c.meta || '';
        badge.textContent = 'ปิดอยู่ — เปิดกลับได้'; badge.className = 'badge np-badge exists';
      } else {
        badge.textContent = 'จะสร้างใหม่'; badge.className = 'badge np-badge new';
      }
    }
  }).catch(() => {});

  // Send a preset page only when its switch MOVED. Doing it unconditionally
  // would rewrite the navbar and footer on every upload for pages nobody
  // touched — and parking is a file move, so a no-op run must stay a no-op.
  // Title/Meta are optional; blank means Claude writes them at rebrand time.
  async function sendNewPage(f) {
    const { toggle, title, desc, status } = npEls(f);
    const want = toggle.checked;
    const had = f.dataset.origOn === '1';
    if (want === had) return false;

    // null for the lottery rows — those pages ship with the repo and have no
    // Title/Meta inputs to read (see npEls above)
    const t = title ? title.value.trim() : '', d = desc ? desc.value.trim() : '';
    const q = new URLSearchParams({ slot: 'newpage', page: f.dataset.newpage, title: t, desc: d, on: want ? '1' : '0' });
    status.textContent = want
      ? ((!t && !d) ? '⏳ กำลังเปิดหน้า (Claude เขียนเนื้อหาให้ตอนรีแบรนด์)...' : '⏳ กำลังเปิดหน้า...')
      : '⏳ กำลังพักหน้า (ไฟล์ไม่ถูกลบ)...';
    try {
      const res = await fetch('/upload?' + q.toString(), { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      status.textContent = j.written.length ? '✅ ' + j.written.join(', ') : '✅ ไม่มีอะไรต้องเปลี่ยน';
      addLog(f.dataset.newpage + ' → ' + (j.written.join(', ') || 'ไม่มีอะไรต้องเปลี่ยน'), true);
      if (j.restored) addLog(f.dataset.newpage + ': เปิดกลับจากที่ปิดไว้ — เนื้อหาเป็นของแบรนด์ก่อน Claude จะเขียนใหม่ตอนรีแบรนด์', true);
      if (j.disabled) addLog(f.dataset.newpage + ': พักไว้ที่ src/pages-disabled แล้ว — ไม่ได้ลบ กดเปิดกลับได้', true);
      if (j.missing) addLog(f.dataset.newpage + ': ไม่มีไฟล์อยู่แล้ว ไม่ต้องทำอะไร', true);
      if (j.navAlready) addLog(f.dataset.newpage + ': ลิงก์เมนูมีอยู่แล้ว (ข้าม)', true);
      if (j.navWarning) addLog('navbar: ' + j.navWarning, false);
      if (j.footerWarning) addLog('footer: ' + j.footerWarning, false);
      f.dataset.origOn = want ? '1' : '0'; // committed — a second upload must not repeat it
    } catch (e) {
      status.textContent = '❌ ' + e.message;
      addLog(f.dataset.newpage + ': ' + e.message, false);
    }
    return true;
  }

  // ── Rebrand run (ส่วนที่ 6) ────────────────────────────────────────────────
  // The prompt is NOT assembled here: /rebrand/preview returns the exact string
  // /rebrand/start will fire, so the textarea can never show something different
  // from what runs. Copy still works for pasting into Claude Code by hand.
  const rbBrand = document.getElementById('rbBrand');
  const rbUrl = document.getElementById('rbUrl');
  const rbNotes = document.getElementById('rbNotes');
  const rbPrompt = document.getElementById('rbPrompt');
  const rbCopy = document.getElementById('rbCopy');
  const rbFast = document.getElementById('rbFast');
  const rbFastBadge = document.getElementById('rbFastBadge');
  const rbFastCheck = document.getElementById('rbFastCheck');
  const rbFire = document.getElementById('rbFire');
  const rbStop = document.getElementById('rbStop');
  const rbPill = document.getElementById('rbPill');
  const rbTimer = document.getElementById('rbTimer');
  const rbHint = document.getElementById('rbHint');
  const rbRunBox = document.getElementById('rbRunBox');
  const rbLog = document.getElementById('rbLog');
  const rbTools = document.getElementById('rbTools');
  const rbErrs = document.getElementById('rbErrs');
  const rbErrWrap = document.getElementById('rbErrWrap');
  const rbFilesN = document.getElementById('rbFiles');
  const rbMeta = document.getElementById('rbMeta');
  const rbFileBox = document.getElementById('rbFileBox');
  const rbFileList = document.getElementById('rbFileList');
  const rbDone = document.getElementById('rbDone');
  const uploadAllBtn = document.getElementById('uploadAll');

  let promptOk = false;
  let promptTimer = null;
  let rbSource = null;        // EventSource
  let rbLastIdx = -1;         // last event seq rendered, for gap-free reconnect
  let rbClosed = false;       // run ended: stop reconnecting
  let rbTicker = null;
  let rbStartedAt = 0;
  let rbFileSet = new Set();
  let rbToolCount = 0;
  let rbErrCount = 0;

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function refreshPrompt() {
    clearTimeout(promptTimer);
    promptTimer = setTimeout(async () => {
      const q = new URLSearchParams({ brand: rbBrand.value, url: rbUrl.value, notes: rbNotes.value });
      try {
        const res = await fetch('/rebrand/preview?' + q.toString());
        const j = await res.json();
        if (j.ok) {
          rbPrompt.value = j.prompt;
          promptOk = true;
          rbHint.textContent = 'Copy ไว้วางเองใน Claude Code ก็ได้ หรือกด "เริ่ม Rebrand" ให้ระบบยิงให้เลย';
        } else {
          rbPrompt.value = '⚠ ' + j.error;
          promptOk = false;
          rbHint.textContent = j.error;
        }
      } catch (e) {
        rbPrompt.value = '⚠ ต่อ server ไม่ได้: ' + e.message;
        promptOk = false;
      }
      syncButtons();
    }, 250);
  }
  [rbBrand, rbUrl, rbNotes].forEach((el) => el.addEventListener('input', refreshPrompt));

  // Deliberately NOT persisted (no localStorage): fast mode draws on a separate
  // quota that is not always granted, so it has to be an explicit choice for the
  // run in front of you — not something inherited from a run someone else fired
  // last week and never looked at again. A page reload always lands on OFF.
  //
  // usage.speed — the only field that says whether fast was actually *served* —
  // arrives with the result message, i.e. after the 35-minute wait has already
  // been spent. So the toggle asks the same question up front in ~5 seconds, and
  // the answer is repeated in the confirm dialog, where the money is committed.
  // (No backticks in this block: it lives inside the PAGE template literal.)
  let fastProbe = null;    // last probe result
  let fastProbeAt = 0;     // when it was taken — availability drifts through the day
  let fastProbing = null;  // in-flight probe, so two fast clicks share one spawn
  const FAST_PROBE_TTL = 3 * 60 * 1000;

  function showFastProbe(p) {
    if (!p) { rbFastCheck.textContent = ''; rbFastCheck.className = 'status'; return; }
    if (!p.ok) {
      rbFastCheck.className = 'status bad';
      rbFastCheck.textContent = '✕ เช็กไม่ได้: ' + p.error;
    } else if (p.speed === 'fast') {
      rbFastCheck.className = 'status ok';
      rbFastCheck.textContent = '✓ เช็กแล้ว ตอนนี้ได้ fast จริง';
    } else {
      rbFastCheck.className = 'status warn';
      rbFastCheck.textContent = '⚠ ตอนนี้ระบบไม่ได้จัด fast ให้ (speed=' + (p.speed || '?') + ') — เปิดไว้ก็จะได้ความเร็วปกติ';
    }
  }

  function probeFast() {
    if (fastProbing) return fastProbing;
    rbFastCheck.className = 'status';
    rbFastCheck.textContent = 'กำลังเช็กว่าตอนนี้ fast ใช้ได้จริงไหม…';
    fastProbing = fetch('/rebrand/fastcheck')
      .then((r) => r.json())
      .catch((e) => ({ ok: false, error: e.message }))
      .then((p) => { fastProbe = p; fastProbeAt = Date.now(); showFastProbe(p); return p; })
      .finally(() => { fastProbing = null; });
    return fastProbing;
  }

  function fastVerdictText() {
    if (!fastProbe) return '';
    if (!fastProbe.ok) return ' — เช็กสถานะไม่ได้ (' + esc(fastProbe.error) + ')';
    return fastProbe.speed === 'fast'
      ? ' — เช็กแล้ว <span class="cf-ok">ตอนนี้ได้ fast จริง</span>'
      : ' — <b>เช็กแล้วตอนนี้ไม่ได้ fast</b> (speed=' + esc(String(fastProbe.speed || '?')) + ') จะได้ความเร็วปกติ';
  }

  rbFast.addEventListener('change', () => {
    rbFastBadge.hidden = !rbFast.checked;
    if (rbFast.checked) probeFast();
    else { fastProbe = null; fastProbeAt = 0; showFastProbe(null); }
  });

  function running() { return rbPill.dataset.status === 'running' || rbPill.dataset.status === 'stopping'; }

  // Files chosen in the form but not yet sent. The Rebrand button stays locked
  // while any exist: firing with a file still sitting in an <input> would run
  // the whole rebrand against the PREVIOUS brand's assets and look like the
  // tool ignored what the operator picked.
  function pendingFiles() {
    return [...document.querySelectorAll('input[type=file]')].some((i) => i.files.length);
  }

  let briefStaged = false; // a content.docx exists on disk (checked at load, and after each upload)

  function syncButtons() {
    const busy = running();
    const pending = pendingFiles();
    rbFire.disabled = busy || !promptOk || pending || !briefStaged;
    rbStop.disabled = !busy;
    document.getElementById('rbDry').disabled = busy;
    // Speed is fixed at spawn time, so a mid-run toggle would change nothing but
    // would leave the switch disagreeing with the run it is sitting next to.
    rbFast.disabled = busy;
    // While an agent is reading src/assets, re-staging files underneath it would
    // hand it a half-swapped brand — so uploads are locked for the duration.
    uploadAllBtn.disabled = busy;

    // say WHY the button is off, rather than leaving a dead grey button
    const hint = document.getElementById('rbFireHint');
    if (busy) hint.innerHTML = 'กำลังรัน — <strong>ห้ามปิดหน้าต่างดำ (cmd)</strong> (ปิดแท็บเบราว์เซอร์ได้ ไม่กระทบ)';
    else if (pending) hint.innerHTML = '⬆ <strong>ยังมีไฟล์ที่เลือกไว้แต่ยังไม่ได้อัพโหลด</strong> — กด "อัพโหลดทั้งหมด" ก่อน ปุ่ม Rebrand ถึงจะกดได้';
    else if (!briefStaged) hint.innerHTML = '⚠ <strong>ยังไม่มี Content brief ใน src/assets</strong> — อัพโหลด .docx หรือ .txt ในส่วนที่ 1 ก่อน';
    else if (!promptOk) hint.innerHTML = 'กรอกชื่อแบรนด์ให้ถูกต้องก่อน ปุ่ม Rebrand ถึงจะกดได้';
    else hint.innerHTML = 'พร้อมยิงแล้ว · งานจริงกินเวลาหลายสิบนาที · <strong>ห้ามปิดหน้าต่างดำ (cmd)</strong> ระหว่างรัน (ปิดแท็บเบราว์เซอร์ได้)';
  }

  // keep the gate honest as soon as a file is picked, not only after an upload
  document.querySelectorAll('input[type=file]').forEach((i) => i.addEventListener('change', syncButtons));

  async function refreshBriefStaged() {
    try {
      const st = await (await fetch('/rebrand/status')).json();
      briefStaged = !!st.docx?.exists;
    } catch { briefStaged = false; }
    syncButtons();
  }

  const PILL = {
    idle:     ['พร้อม', ''],
    running:  ['กำลังทำงาน', 'run'],
    stopping: ['กำลังหยุด...', 'run'],
    done:     ['เสร็จแล้ว', 'done'],
    stopped:  ['หยุดแล้ว', 'bad'],
    error:    ['ล้มเหลว', 'bad'],
  };
  function setPill(status) {
    const [label, cls] = PILL[status] || PILL.idle;
    rbPill.dataset.status = status;
    rbPill.textContent = label;
    rbPill.className = 'pill' + (cls ? ' ' + cls : '');
    syncButtons();
  }

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function startTicker() {
    clearInterval(rbTicker);
    rbTicker = setInterval(() => { rbTimer.textContent = fmtElapsed(Date.now() - rbStartedAt); }, 1000);
  }

  function rbLine(cls, html) {
    // keep following the tail only if the operator hasn't scrolled up to read
    const atBottom = rbLog.scrollHeight - rbLog.scrollTop - rbLog.clientHeight < 40;
    const d = document.createElement('span');
    d.className = 'l ' + cls;
    d.innerHTML = html;
    rbLog.appendChild(d);
    if (atBottom) rbLog.scrollTop = rbLog.scrollHeight;
  }

  function rbReset() {
    rbLog.textContent = '';
    rbFileSet = new Set();
    rbToolCount = 0;
    rbLastIdx = -1;
    rbClosed = false;
    rbTools.textContent = '0';
    rbErrCount = 0;
    rbErrs.textContent = '0';
    rbErrWrap.hidden = true;
    rbFilesN.textContent = '0';
    rbMeta.textContent = '';
    rbDone.textContent = '';
    rbFileBox.hidden = true;
    rbFileList.textContent = '';
    rbRunBox.hidden = false;
  }

  function renderEvent(ev) {
    if (ev.i <= rbLastIdx) return; // replay overlap after a reconnect
    rbLastIdx = ev.i;
    const sub = ev.sub ? ' sub' : '';
    const who = ev.sub ? '<span class="who">agent</span> ' : '';
    switch (ev.type) {
      case 'start':
        rbStartedAt = ev.startedAt || ev.t;
        startTicker();
        rbLine('meta', '▶ ' + esc(ev.text));
        break;
      case 'init':
        rbLine('meta', esc(ev.text));
        break;
      case 'text':
        rbLine('' + sub, who + esc(ev.text));
        break;
      case 'tool':
        rbToolCount++;
        rbTools.textContent = rbToolCount;
        if (ev.file) {
          rbFileSet.add(ev.file);
          rbFilesN.textContent = rbFileSet.size;
          rbFileBox.hidden = false;
          rbFileList.textContent = [...rbFileSet].join('\\n');
        }
        rbLine('tool' + sub, who + '● ' + esc(ev.name) + (ev.text ? ' — ' + esc(ev.text) : ''));
        break;
      case 'tool_error':
        // A guardrail the agent routes around on its own is not a failure —
        // showing it in the same red as a real one trains people to ignore red.
        if (ev.benign) {
          rbLine('meta', '↻ ' + esc(ev.text) + ' — agent แก้เองแล้ว');
        } else {
          rbErrCount++;
          rbErrs.textContent = rbErrCount;
          rbErrWrap.hidden = false;
          rbLine('bad', '⚠ tool error: ' + esc(ev.text));
        }
        break;
      case 'stderr':
      case 'raw':
        rbLine('bad', esc(ev.text));
        break;
      case 'stopping':
        setPill('stopping');
        rbLine('bad', '■ ' + esc(ev.text));
        break;
      case 'result': {
        const bits = [];
        if (ev.numTurns) bits.push(ev.numTurns + ' turns');
        if (ev.durationMs) bits.push(fmtElapsed(ev.durationMs));
        if (ev.speed === 'fast') bits.push('fast');
        rbMeta.textContent = bits.join(' · ');
        // Say so when fast was asked for but not served — otherwise the operator
        // reads a slow run as "fast mode is broken" instead of "quota was full",
        // and there is no other place that difference is visible.
        if (ev.fast && ev.speed && ev.speed !== 'fast') {
          rbLine('warn', 'ขอ Fast mode ไว้ แต่รอบนี้ API ให้ความเร็วปกติ (' + esc(ev.speed) + ')'
            + (ev.fastState === 'on'
              ? ' — ตัวตั้งค่าถูกรับแล้ว (fast_mode_state=on) แต่ไม่ได้ถูกจัดให้รันเร็ว เช่นโควตา fast เต็มหรืออยู่ในช่วง cooldown'
              : ' — ตัวตั้งค่าไม่ถูกรับ (fast_mode_state=' + esc(String(ev.fastState)) + ')'));
        }
        if (ev.text) rbLine('good', esc(ev.text));
        break;
      }
      case 'end': {
        clearInterval(rbTicker);
        rbClosed = true;
        rbTimer.textContent = fmtElapsed(ev.elapsedMs || 0);
        setPill(ev.status);
        const okRun = ev.status === 'done';
        rbLine(okRun ? 'good' : 'bad', (okRun ? '✓ จบงาน' : '✗ จบแบบ ' + ev.status) + ' (exit ' + ev.exitCode + ')');
        rbDone.innerHTML = okRun
          ? 'ต่อไป: <b>ส่วนที่ 7</b> กดทดสอบหน้าเว็บแล้วดูด้วยตา → ขึ้นเว็บจริง → <b>ส่วนที่ 8</b> เซฟงานขึ้น GitLab'
          : 'งานไม่จบสมบูรณ์ — repo อาจถูกแก้ค้างไว้ ตรวจด้วย <code>git status</code> / ย้อนด้วย <code>git checkout .</code> ก่อนยิงใหม่';
        addLog('rebrand: ' + ev.status, okRun);
        gtRefresh();
        break;
      }
    }
  }

  function attach(from) {
    if (rbSource) { rbSource.close(); rbSource = null; }
    rbSource = new EventSource('/rebrand/stream?from=' + from);
    rbSource.onmessage = (e) => { try { renderEvent(JSON.parse(e.data)); } catch { /* ignore */ } };
    rbSource.onerror = () => {
      // EventSource retries on its own, but it would replay from the same
      // ?from= — so reconnect explicitly at the next unseen event instead.
      rbSource.close();
      rbSource = null;
      if (rbClosed) return;
      setTimeout(() => { if (!rbClosed) attach(rbLastIdx + 1); }, 2000);
    };
  }

  rbCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(rbPrompt.value);
      addLog('คัดลอกคำสั่ง rebrand แล้ว — วางใน Claude Code ได้เลย', true);
    } catch {
      rbPrompt.select();
      addLog('คัดลอกอัตโนมัติไม่ได้ (เลือกข้อความให้แล้ว กด Ctrl+C)', false);
    }
  });

  // ── confirm dialog ────────────────────────────────────────────────────────
  // Replaces window.confirm(), which could not show the one thing that matters
  // most here — the exact prompt about to be fired — as anything but a wall of
  // unstyled text, and which browsers label with "localhost:4444 says".
  const cfDlg = document.getElementById('confirmDlg');
  function askConfirm({ title, sub = '', lines = [], code = '', ok = 'ตกลง', icon = '▶', danger = false }) {
    document.getElementById('cfTitle').textContent = title;
    document.getElementById('cfSub').textContent = sub;
    document.getElementById('cfIcon').textContent = icon;
    document.getElementById('cfOk').textContent = ok;
    cfDlg.classList.toggle('danger', danger);
    // lines are our own markup (for <b>/<span>); code is user input, so it goes
    // in via textContent and can never inject anything.
    document.getElementById('cfList').innerHTML = lines.map((l) => '<li>' + l + '</li>').join('');
    const codeEl = document.getElementById('cfCode');
    codeEl.textContent = code;
    codeEl.hidden = !code;
    document.getElementById('cfCodeLabel').hidden = !code;
    return new Promise((resolve) => {
      cfDlg.addEventListener('close', () => resolve(cfDlg.returnValue === 'ok'), { once: true });
      cfDlg.returnValue = '';
      cfDlg.showModal();
      // focus Cancel, not the go button: Enter should not fire a 30-minute,
      // repo-rewriting job by accident. Esc closes with returnValue '' = false.
      document.getElementById('cfCancel').focus();
    });
  }

  async function fireRun(dry) {
    if (!dry) {
      let docxNote = '<b>ไม่พบ content.docx ใน src/assets — ยังไม่ได้อัพ brief</b>';
      try {
        const st = await (await fetch('/rebrand/status')).json();
        if (st.docx?.exists) {
          docxNote = 'content.docx ที่ staged ไว้: <span class="cf-ok">' + new Date(st.docx.mtime).toLocaleString('th-TH') + '</span>';
        }
      } catch { /* keep the warning */ }
      // Re-check rather than trust a reading from when the toggle was flipped:
      // fast availability moves during the day, and this is the last moment the
      // operator can still back out for free.
      if (rbFast.checked && (!fastProbe || Date.now() - fastProbeAt > FAST_PROBE_TTL)) await probeFast();
      const go = await askConfirm({
        title: 'เริ่ม rebrand จริงหรือไม่?',
        sub: 'Claude จะลงมือแก้โปรเจกต์นี้ทันทีเมื่อกดตกลง',
        lines: [
          'จะแก้ <b>ไฟล์จริง</b> ใน <code>src/</code> ของโปรเจกต์นี้',
          'กินเวลาหลายสิบนาที — <b>ห้ามปิดหน้าต่าง cmd</b> ระหว่างรัน (ปิดแท็บเบราว์เซอร์ได้)',
          docxNote,
          // Last chance to notice: the toggle sits above the button, so someone
          // who left it on from the previous run would otherwise never re-read it.
          ...(rbFast.checked ? ['เปิด <b>Fast mode</b> ไว้' + fastVerdictText()] : []),
        ],
        code: rbPrompt.value,
        ok: '▶ เริ่ม Rebrand',
      });
      if (!go) return;
    }
    rbReset();
    setPill('running');
    rbStartedAt = Date.now();
    startTicker();
    try {
      const res = await fetch('/rebrand/start' + (dry ? '?dry=1' : ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: rbBrand.value, url: rbUrl.value, notes: rbNotes.value, fast: rbFast.checked }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      addLog((dry ? 'เริ่มทดสอบท่อ' : 'เริ่ม rebrand แล้ว') + (rbFast.checked ? ' (Fast mode)' : ''), true);
      attach(0);
    } catch (e) {
      clearInterval(rbTicker);
      setPill('error');
      rbClosed = true;
      rbLine('bad', 'เริ่มไม่สำเร็จ: ' + esc(e.message));
      addLog('เริ่ม rebrand ไม่สำเร็จ: ' + e.message, false);
    }
  }

  rbFire.addEventListener('click', () => fireRun(false));
  rbStop.addEventListener('click', async () => {
    const stop = await askConfirm({
      title: 'หยุดงาน rebrand ตอนนี้?',
      sub: 'งานจะถูกตัดกลางคัน ไม่สามารถสั่งให้ทำต่อจากจุดเดิมได้',
      icon: '■',
      danger: true,
      lines: [
        'ไฟล์ที่แก้ไปแล้ว <b>จะค้างครึ่งทาง</b> — เว็บอาจอยู่ในสภาพที่ build ไม่ผ่าน',
        'ตรวจด้วย <code>git status</code> และย้อนกลับด้วย <code>git checkout .</code> ก่อนยิงใหม่',
      ],
      ok: '■ หยุดเลย',
    });
    if (!stop) return;
    rbStop.disabled = true;
    try {
      const j = await (await fetch('/rebrand/stop', { method: 'POST' })).json();
      if (!j.ok) throw new Error(j.error);
    } catch (e) {
      addLog('หยุดไม่สำเร็จ: ' + e.message, false);
      syncButtons();
    }
  });

  // Pipe smoke-test: same spawn → NDJSON → SSE path, seconds instead of an hour.
  document.getElementById('rbDry').addEventListener('click', () => fireRun(true));

  // Reattach to a run already in flight (page refresh / reopened tab).
  (async () => {
    try {
      const st = await (await fetch('/rebrand/status')).json();
      const run = st.run;
      if (run && (run.status === 'running' || run.status === 'stopping')) {
        rbReset();
        setPill(run.status);
        rbStartedAt = run.startedAt || Date.now();
        // Mirror the in-flight run's setting rather than the default-off markup,
        // so the reattached page doesn't claim a fast run is running at 1x.
        rbFast.checked = !!run.fast;
        rbFastBadge.hidden = !run.fast;
        startTicker();
        attach(0);
        addLog('มีงาน rebrand ค้างอยู่ — ต่อ log กลับมาแล้ว' + (run.fast ? ' (Fast mode)' : ''), true);
      }
    } catch { /* server just started; nothing to reattach */ }
  })();

  refreshPrompt();
  refreshBriefStaged();

  // ── ส่วนที่ 7: build + preview ────────────────────────────────────────────
  // The operator gets one button. Everything a terminal would have told them —
  // that a build is running, that it failed and why, that a server is up on a
  // port — has to be visible here instead.
  const pvStart = document.getElementById('pvStart');
  const pvOpen = document.getElementById('pvOpen');
  const pvStop = document.getElementById('pvStop');
  const pvPill = document.getElementById('pvPill');
  const pvHint = document.getElementById('pvHint');
  const pvErrBox = document.getElementById('pvErrBox');
  const pvCheck = document.getElementById('pvCheck');
  let pvUrl = '';

  function pvRender(p) {
    const s = p.status;
    pvUrl = p.url || '';
    // the deploy gate reads this: publishing without having looked at the site
    // is exactly what the checklist exists to prevent
    pvPill.dataset.ok = s === 'running' ? '1' : '0';
    if (typeof dpSync === 'function') dpSync();
    pvStart.disabled = s === 'building';
    pvOpen.hidden = s !== 'running';
    pvStop.hidden = s !== 'running';
    pvCheck.hidden = s !== 'running';
    pvErrBox.hidden = s !== 'error';

    if (s === 'building') {
      pvPill.className = 'pill run'; pvPill.textContent = 'กำลังสร้างเว็บ...';
      pvStart.textContent = '⏳ กำลังสร้าง...';
      pvHint.textContent = 'กำลัง build เวอร์ชันจริง — รอสักครู่ อย่าเพิ่งปิดหน้าต่างดำ';
    } else if (s === 'running') {
      pvPill.className = 'pill done'; pvPill.textContent = 'เปิดอยู่';
      pvStart.textContent = '🔄 สร้างใหม่อีกครั้ง';
      pvHint.innerHTML = 'เว็บทดสอบเปิดอยู่ที่ <code>' + esc(pvUrl) + '</code> — แก้อะไรเพิ่มแล้วกด "สร้างใหม่อีกครั้ง"';
    } else if (s === 'error') {
      pvPill.className = 'pill bad'; pvPill.textContent = 'ไม่ผ่าน';
      pvStart.textContent = '🔍 ลองใหม่';
      pvHint.textContent = 'เว็บยังสร้างไม่สำเร็จ ดูสาเหตุด้านล่าง';
      document.getElementById('pvErrMsg').textContent = p.error || 'build ไม่ผ่าน';
      document.getElementById('pvLog').textContent = (p.log || []).join('\\n');
    } else {
      pvPill.className = 'pill'; pvPill.textContent = 'ยังไม่ได้ทดสอบ';
      pvStart.textContent = '🔍 ทดสอบหน้าเว็บ';
      pvHint.textContent = 'ทำหลังรีแบรนด์เสร็จ · ใช้เวลาประมาณครึ่งนาที';
    }
  }

  pvStart.addEventListener('click', async () => {
    pvRender({ status: 'building' });
    // poll while the build runs so the pill isn't frozen for 30 seconds
    const poll = setInterval(async () => {
      try {
        const st = await (await fetch('/preview/status')).json();
        if (st.preview.status === 'building') pvRender(st.preview);
      } catch { /* transient */ }
    }, 1500);
    try {
      const j = await (await fetch('/preview/start', { method: 'POST' })).json();
      clearInterval(poll);
      pvRender(j.preview);
      // browsers block window.open outside a gesture, and this resolves long
      // after the click — so the ปุ่มเปิดเว็บ above is the reliable path and
      // this is only a convenience when the browser allows it.
      if (j.preview.status === 'running') window.open(j.preview.url, '_blank', 'noopener');
    } catch (e) {
      clearInterval(poll);
      pvRender({ status: 'error', error: 'ต่อ server ไม่ได้: ' + e.message, log: [] });
    }
  });

  pvOpen.addEventListener('click', () => { if (pvUrl) window.open(pvUrl, '_blank', 'noopener'); });
  pvStop.addEventListener('click', async () => {
    try { pvRender((await (await fetch('/preview/stop', { method: 'POST' })).json()).preview); }
    catch { /* leave the UI as-is */ }
  });

  // Tick counter, so progress through the list is visible at a glance.
  //
  // The ticks do nothing else today — they are not sent, not stored, and Claude
  // never sees them. That is deliberate but temporary: the agreed job for this
  // list is to GATE THE DEPLOY BUTTON in phase 3 (all five ticked, or deploy
  // stays disabled), the same way Rebrand stays locked until the upload
  // finishes. Deploy is the one button here that reaches production, so making
  // it wait until somebody has actually looked at the site is worth a gate.
  // Whoever builds that: read pvAllChecked() below, don't re-count inline.
  const pvBoxes = () => [...pvCheck.querySelectorAll('input[type=checkbox]')];
  const pvAllChecked = () => pvBoxes().every((b) => b.checked);
  pvBoxes().forEach((c) => c.addEventListener('change', () => {
    document.getElementById('pvCount').textContent = pvBoxes().filter((b) => b.checked).length + '/' + pvBoxes().length;
    dpSync();
  }));

  // ── ส่วนที่ 7 (ต่อ): deploy ────────────────────────────────────────────────
  // The publish button. Everything it needs is already in wrangler.toml, so it
  // asks for nothing — but it is gated, because it is the only action in this
  // tool that the public sees, and the gate is the checklist above: somebody
  // has to have actually looked at the site before it goes out.
  const dpStart = document.getElementById('dpStart');
  const dpPill = document.getElementById('dpPill');
  const dpHint = document.getElementById('dpHint');
  const dpTimer = document.getElementById('dpTimer');
  const dpBox = document.getElementById('dpBox');
  let dpTicker = null;
  let dpBusy = false;
  let dpTarget = null;

  function dpSync() {
    if (dpBusy) return;
    const previewed = pvPill.dataset.ok === '1';
    const ticked = pvAllChecked();
    dpStart.disabled = !(previewed && ticked) || running();
    if (running()) dpHint.textContent = 'มี rebrand กำลังรันอยู่ — รอให้จบก่อน';
    else if (!previewed) dpHint.textContent = 'กด "ทดสอบหน้าเว็บ" ให้เว็บขึ้นก่อน';
    else if (!ticked) dpHint.textContent = 'ติ๊กให้ครบ 5 ข้อก่อน — ยังเหลือ ' + pvBoxes().filter((b) => !b.checked).length + ' ข้อ';
    else dpHint.innerHTML = 'พร้อมขึ้นเว็บจริงแล้ว' + (dpTarget?.name ? ' → Worker <code>' + esc(dpTarget.name) + '</code>' : '');
  }

  function dpRender(d) {
    dpBox.hidden = !(d.log && d.log.length);
    dpBox.className = 'field' + (d.status === 'done' ? ' done' : d.status === 'error' ? ' bad' : '');
    document.getElementById('dpLog').textContent = (d.log || []).join('\\n');
    if (d.status === 'done') {
      dpPill.className = 'pill done'; dpPill.textContent = 'ขึ้นแล้ว';
      document.getElementById('dpTitle').textContent = 'ขึ้นเว็บจริงเรียบร้อย';
      document.getElementById('dpMsg').innerHTML = 'อาจต้องรอสักครู่กว่าเว็บจะอัปเดต — ถ้าเปิดแล้วยังเห็นของเก่า ให้ล้างแคชเบราว์เซอร์';
    } else if (d.status === 'error') {
      dpPill.className = 'pill bad'; dpPill.textContent = 'ไม่สำเร็จ';
      document.getElementById('dpTitle').textContent = 'ขึ้นเว็บไม่สำเร็จ';
      document.getElementById('dpMsg').textContent = d.error || 'ดูรายละเอียดด้านล่าง';
    }
  }

  dpStart.addEventListener('click', async () => {
    const t = dpTarget || {};
    const go = await askConfirm({
      title: 'ขึ้นเว็บจริงเลยหรือไม่?',
      sub: 'คนทั่วไปจะเห็นเว็บเวอร์ชันนี้ทันทีหลังจากนี้',
      icon: '🚀',
      danger: true,
      lines: [
        'จะ <b>build ใหม่แล้วส่งขึ้น Cloudflare</b> ทับของเดิมที่อยู่บนเว็บตอนนี้',
        t.name ? 'Worker ปลายทาง: <code>' + esc(t.name) + '</code>' : '<b>อ่านชื่อ Worker จาก wrangler.toml ไม่ได้</b>',
        // The account was readable all along but never shown; a deploy into the
        // wrong one is the mistake with no symptom until somebody looks.
        cfAcctName(t.accountId) ? 'บัญชี: <b>' + esc(cfAcctName(t.accountId)) + '</b>' : 'บัญชี: <code>' + esc(t.accountId || 'ไม่ได้ตั้งไว้') + '</code>',
        'ถ้าชื่อ Worker ไม่ใช่ของแบรนด์นี้ <b>เว็บของแบรนด์นั้นจะถูกทับหาย</b> — ยกเลิกแล้วไปแก้ wrangler.toml ก่อน',
      ],
      ok: '🚀 ขึ้นเลย',
    });
    if (!go) return;

    dpBusy = true;
    dpStart.disabled = true;
    dpPill.className = 'pill run'; dpPill.textContent = 'กำลังขึ้น...';
    dpHint.textContent = 'กำลัง build แล้วส่งขึ้น Cloudflare — อย่าปิดหน้าต่างดำ';
    dpBox.hidden = true;
    const t0 = Date.now();
    clearInterval(dpTicker);
    dpTicker = setInterval(() => { dpTimer.textContent = fmtElapsed(Date.now() - t0); }, 1000);
    try {
      const j = await (await fetch('/deploy/start', { method: 'POST' })).json();
      dpRender(j.deploy || { status: 'error', error: j.error, log: [] });
    } catch (e) {
      dpRender({ status: 'error', error: 'ต่อ server ไม่ได้: ' + e.message, log: [] });
    } finally {
      clearInterval(dpTicker);
      dpTimer.textContent = fmtElapsed(Date.now() - t0);
      dpBusy = false;
      dpSync();
    }
  });

  (async () => {
    try {
      const st = await (await fetch('/deploy/status')).json();
      dpTarget = st.target || null;
      if (st.deploy && st.deploy.log && st.deploy.log.length) dpRender(st.deploy);
    } catch { /* server not answering */ }
    dpSync();
  })();

  // ── Cloudflare account ────────────────────────────────────────────────────
  // Two separate things have to agree before a deploy lands where it should:
  // which account wrangler is logged into, and which account_id wrangler.toml
  // names. This panel shows both and can change both.
  const cfSwitch = document.getElementById('cfSwitch');
  const cfCancelBtn = document.getElementById('cfCancelBtn');
  const cfNow = document.getElementById('cfNow');
  const cfAuth = document.getElementById('cfAuth');
  const cfAuthLink = document.getElementById('cfAuthLink');
  const cfPick = document.getElementById('cfPick');
  const cfPickList = document.getElementById('cfPickList');
  const cfLogEl = document.getElementById('cfLog');
  let cfPoll = null;
  let cfAccounts = [];
  let cfWhoEmail = '';

  // Hoisted on purpose: the deploy confirm dialog above is wired up before this
  // block runs, and calls it to name the account instead of showing a raw id.
  function cfAcctName(id) {
    return cfAccounts.find((a) => a.id === id)?.name || '';
  }

  function cfRenderNow(c) {
    const id = dpTarget?.accountId || '';
    const hit = cfAccounts.find((a) => a.id === id);
    if (!c.email) {
      cfNow.innerHTML = '<b>ยังไม่ได้ login</b> — กด "สลับบัญชี" เพื่อเข้าสู่ระบบ Cloudflare';
      return;
    }
    // A wrangler.toml pointing at an account this login cannot see is the one
    // state that looks fine and fails at deploy time, so name it here.
    const where = hit
      ? '<b>' + esc(hit.name) + '</b>'
      : id
        ? '<b style="color:var(--bad)">บัญชีใน wrangler.toml ไม่อยู่ในรายการที่ login นี้เข้าถึงได้</b>'
        : '<b style="color:var(--bad)">wrangler.toml ยังไม่มี account_id</b>';
    cfNow.innerHTML = esc(c.email) + ' · ' + where + (id ? '<br><code>' + esc(id) + '</code>' : '');
  }

  function cfRenderPick() {
    cfPick.hidden = cfAccounts.length < 1;
    cfPickList.innerHTML = '';
    for (const a of cfAccounts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cf-acct' + (a.id === (dpTarget?.accountId || '') ? ' on' : '');
      b.innerHTML = '<span>' + esc(a.name) + '</span><span class="id">' + esc(a.id) + '</span>';
      b.addEventListener('click', async () => {
        const j = await (await fetch('/cf/account?id=' + encodeURIComponent(a.id), { method: 'POST' })).json();
        if (!j.ok) { cfNow.innerHTML = '<b style="color:var(--bad)">' + esc(j.error) + '</b>'; return; }
        dpTarget = j.target;
        cfRenderPick();
        cfRenderNow({ email: cfWhoEmail });
        dpSync();
      });
      cfPickList.appendChild(b);
    }
  }

  function cfRender(c) {
    cfWhoEmail = c.email || '';
    cfAccounts = c.accounts || [];
    const running = c.status === 'running';
    cfSwitch.disabled = running;
    cfCancelBtn.hidden = !running;
    cfAuth.hidden = !(running && c.authUrl);
    if (c.authUrl) cfAuthLink.href = c.authUrl;
    cfLogEl.hidden = !(c.log && c.log.length && (running || c.status === 'error'));
    cfLogEl.textContent = (c.log || []).join('\\n');

    if (running) {
      cfNow.textContent = c.phase === 'login'
        ? (c.authUrl ? 'รออนุญาตในเบราว์เซอร์...' : 'กำลังขอลิงก์อนุญาต...')
        : c.phase === 'whoami' ? 'อนุญาตแล้ว กำลังอ่านรายชื่อบัญชี...' : 'กำลังออกจากบัญชีเดิม...';
      cfPick.hidden = true;
      return;
    }
    if (c.status === 'error') {
      cfNow.innerHTML = '<b style="color:var(--bad)">' + esc(c.error || 'สลับบัญชีไม่สำเร็จ') + '</b>';
      cfPick.hidden = true;
      return;
    }
    cfRenderNow(c);
    cfRenderPick();
  }

  async function cfTick() {
    try {
      const j = await (await fetch('/cf/status')).json();
      if (j.target) dpTarget = j.target;
      cfRender(j.cf);
      if (j.cf.status !== 'running') { clearInterval(cfPoll); cfPoll = null; dpSync(); }
    } catch { /* server not answering; keep the last state */ }
  }

  cfSwitch.addEventListener('click', async () => {
    const go = await askConfirm({
      title: 'สลับบัญชี Cloudflare?',
      sub: 'ใช้ตอนบัญชีเดิมมีโดเมนครบตามจำนวนที่ตั้งไว้แล้ว',
      icon: '🔑',
      lines: [
        'จะ <b>ออกจากบัญชีเดิมก่อน</b> แล้วเปิดหน้าให้ login บัญชีใหม่',
        'การออกจากระบบมีผล <b>ทั้งเครื่อง</b> ไม่ใช่แค่โปรเจกต์นี้ — โปรเจกต์อื่นบนเครื่องนี้จะต้อง login ใหม่ด้วย',
        'ต้องมี <b>อีเมลกับรหัสผ่าน</b>ของบัญชีใหม่พร้อมอยู่ตรงหน้า',
      ],
      ok: '🔑 สลับเลย',
    });
    if (!go) return;
    cfLogEl.hidden = false;
    cfLogEl.textContent = '';
    const j = await (await fetch('/cf/switch', { method: 'POST' })).json();
    if (!j.ok) { cfNow.innerHTML = '<b style="color:var(--bad)">' + esc(j.error) + '</b>'; return; }
    cfRender(j.cf);
    clearInterval(cfPoll);
    cfPoll = setInterval(cfTick, 1500);
  });

  cfCancelBtn.addEventListener('click', async () => {
    cfRender((await (await fetch('/cf/stop', { method: 'POST' })).json()).cf);
    clearInterval(cfPoll); cfPoll = null;
  });

  (async () => {
    try { cfTick(); } catch { /* server not answering */ }
  })();

  // a preview may already be up from before this page was opened
  (async () => {
    try { pvRender((await (await fetch('/preview/status')).json()).preview); }
    catch { /* server not answering; leave the default idle state */ }
  })();

  // ── upload progress dialog ────────────────────────────────────────────────
  // The log used to live in a sticky footer bar, which meant the result of the
  // upload was reported far away from the button that caused it. It is a modal
  // now: it takes over while files are moving, then gets out of the way by
  // itself on a clean run. On any failure it stays put and waits — a failed
  // upload is the one thing here nobody should be allowed to miss.
  const upDlg = document.getElementById('upDlg');
  function upOpen() {
    upFailed = false;
    log.textContent = '';
    upDlg.className = '';
    document.getElementById('upIcon').textContent = '⬆';
    document.getElementById('upTitle').textContent = 'กำลังอัพโหลด...';
    document.getElementById('upSub').textContent = 'กำลังส่งไฟล์เข้า src/assets และ public';
    document.getElementById('upActions').hidden = true;
    if (!upDlg.open) upDlg.showModal();
  }
  function upFinish(count) {
    const ok = !upFailed;
    upDlg.className = ok ? 'done' : 'bad';
    document.getElementById('upIcon').textContent = ok ? '✓' : '✕';
    document.getElementById('upTitle').textContent = ok ? 'อัพโหลดเสร็จแล้ว' : 'อัพโหลดไม่สำเร็จบางรายการ';
    document.getElementById('upSub').textContent = ok
      ? 'ส่งขึ้นไป ' + count + ' รายการ — กำลังปิดหน้าต่างนี้'
      : 'ดูรายการสีแดงด้านล่าง แก้แล้วกดอัพโหลดใหม่ได้';
    document.getElementById('upActions').hidden = ok;
    // close itself only when there is nothing to read
    if (ok) setTimeout(() => { if (upDlg.open) upDlg.close(); }, 1400);
  }
  document.getElementById('upClose').addEventListener('click', () => upDlg.close());

  document.getElementById('uploadAll').addEventListener('click', async () => {
    if (running()) return;
    const inputs = [...document.querySelectorAll('input[type=file]')].filter((i) => i !== bgFile);
    let any = false;
    let sent = 0;
    upOpen();

    if (await sendLink('aff', affInput, 'affField', 'ลิงก์ aff')) any = true;
    if (await sendLink('line', lineInput, 'lineField', 'ลิงก์ไลน์')) any = true;
    for (const f of metaFields) { if (await sendPageMeta(f)) any = true; }
    for (const f of newpageFields) { if (await sendNewPage(f)) any = true; }

    const bgReq = bgRequest();
    if (bgReq) {
      any = true;
      setStatus(bgFile, '⏳ กำลังอัพโหลด...');
      try {
        const res = await fetch('/upload?' + bgReq.q.toString(), { method: 'POST', body: bgReq.body });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
        setStatus(bgFile, '✅ ' + j.written.join(', '));
        addLog(bgReq.label + ' → ' + j.written.join(', '), true);
        sent++;
        // Same clear as the main loop below, and easy to forget precisely
        // because bgFile is filtered OUT of that loop and uploaded here on its
        // own: without it the input still holds a file, pendingFiles() keeps
        // saying "not uploaded yet", and Rebrand stays locked forever.
        bgFile.value = '';
      } catch (e) {
        setStatus(bgFile, '❌ ' + e.message);
        addLog(bgReq.label + ': ' + e.message, false);
      }
    }

    // A new desktop banner with no phone banner beside it means this brand has
    // no phone art — so the previous brand's has to go. Left alone it would
    // keep rendering under the new name on exactly the viewport nobody opens
    // during review. Runs before the loop so it cannot undo a fresh upload.
    const b1Input = document.querySelector('input[data-slot="banner"][data-index="1"]');
    const bmInput = document.querySelector('input[data-slot="bannermobile"]');
    if (b1Input && b1Input.files.length && bmInput && !bmInput.files.length) {
      try {
        const res = await fetch('/upload?slot=bannermobile&clear=1', { method: 'POST' });
        const j = await res.json();
        if (res.ok && j.ok && j.written.length) {
          addLog('ลบแบนเนอร์มือถือของแบรนด์ก่อนหน้า → ' + j.written.join(', '), true);
        }
      } catch (e) {
        addLog('ลบแบนเนอร์มือถือเก่าไม่สำเร็จ: ' + e.message, false);
      }
    }

    for (const inp of inputs) {
      if (!inp.files.length) continue;
      any = true;
      const file = inp.files[0];
      const slot = inp.dataset.slot;
      const index = inp.dataset.index || '';
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const q = new URLSearchParams({ slot, index, ext });
      setStatus(inp, '⏳ กำลังอัพโหลด...');
      try {
        const res = await fetch('/upload?' + q.toString(), { method: 'POST', body: file });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
        setStatus(inp, '✅ ' + j.written.join(', '));
        addLog(slot + (index ? index : '') + ' → ' + j.written.join(', '), true);
        sent++;
        inp.value = ''; // clear it: the file is on disk now, so it is no longer "pending"
      } catch (e) {
        setStatus(inp, '❌ ' + e.message);
        addLog(slot + (index ? index : '') + ': ' + e.message, false);
      }
    }
    if (!any) {
      addLog('ยังไม่ได้เลือกไฟล์ใดๆ', false);
      upDlg.className = 'bad';
      document.getElementById('upIcon').textContent = '!';
      document.getElementById('upTitle').textContent = 'ไม่มีอะไรให้อัพโหลด';
      document.getElementById('upSub').textContent = 'ยังไม่ได้เลือกไฟล์ หรือกรอกลิงก์/Title ใดๆ ในส่วนที่ 1-5';
      document.getElementById('upActions').hidden = false;
    } else {
      // Safety net for the gate. Each slot clears its own input on success
      // above, which is the correct behaviour when only some of them fail —
      // but it is one line per slot and it was already missed once (bgFile is
      // uploaded outside the main loop, so it kept the Rebrand button locked
      // even after a clean upload). If nothing failed, then by definition
      // everything selected is now on disk, so sweep the lot. Any input added
      // to this page in future is covered without anyone remembering to.
      if (!upFailed) document.querySelectorAll('input[type=file]').forEach((i) => { i.value = ''; });
      upFinish(sent);
    }
    // a fresh docx may have just landed, and cleared inputs change the gate
    await refreshBriefStaged();
    gtRefresh();
  });

  // ── ส่วนที่ 8: commit + push ──────────────────────────────────────────────
  const gtStart = document.getElementById('gtStart');
  const gtPill = document.getElementById('gtPill');
  const gtHint = document.getElementById('gtHint');
  const gtTimer = document.getElementById('gtTimer');
  const gtWhere = document.getElementById('gtWhere');
  const gtMsg = document.getElementById('gtMsg');
  const gtBox = document.getElementById('gtBox');
  const gtFilesBox = document.getElementById('gtFilesBox');
  let gtTicker = null;
  let gtBusy = false;
  let gtInfo = null;
  let gtTouched = false;

  gtMsg.addEventListener('input', () => { gtTouched = true; gtSync(); });

  function gtRenderInfo(info) {
    gtInfo = info;
    if (!info || !info.ok) {
      gtWhere.innerHTML = '<b style="color:var(--bad)">' + esc(info?.error || 'อ่านสถานะ git ไม่ได้') + '</b>';
      gtFilesBox.hidden = true;
      return;
    }
    const repo = (info.origin.match(/([^/:]+?)(?:\\.git)?$/) || [])[1] || info.origin;
    gtWhere.innerHTML = info.origin
      ? 'repo <b>' + esc(repo) + '</b> · branch <b>' + esc(info.branch) + '</b>'
      : '<b style="color:var(--bad)">repo นี้ยังไม่มี remote ชื่อ origin</b> — ดูคู่มือ ภาค B4';

    gtFilesBox.hidden = info.files.length === 0;
    document.getElementById('gtCount').textContent = info.files.length + ' ไฟล์';
    document.getElementById('gtFiles').textContent =
      info.files.map((f) => '[' + f.label + '] ' + f.path).join('\\n');

    // Only ever pre-fill a box the operator has not typed into.
    if (!gtTouched && !gtMsg.value && info.commitName) {
      gtMsg.value = 'Rebrand the site to ' + info.commitName;
    }
    gtSync();
  }

  function gtSync() {
    if (gtBusy) return;
    const ok = gtInfo && gtInfo.ok && gtInfo.origin && !gtInfo.detached && !gtInfo.blockedCount;
    const changed = ok && gtInfo.files.length > 0;
    const typed = gtMsg.value.trim().length > 0;
    gtStart.disabled = !(changed && typed) || running();
    if (running()) gtHint.textContent = 'มี rebrand กำลังรันอยู่ — รอให้จบก่อน';
    else if (gtInfo && gtInfo.blockedCount) gtHint.innerHTML = '⚠ มีของที่ไม่ควรขึ้น git ปนอยู่ (<code>' + esc(gtInfo.blocked[0]) + '</code>) — .gitignore ของ repo นี้หายหรือเสีย <b>แจ้งหัวหน้าก่อน</b>';
    else if (!ok) gtHint.textContent = 'ยังเซฟไม่ได้ — ดูบรรทัดข้างบน';
    else if (!changed) gtHint.textContent = 'ไม่มีไฟล์ที่เปลี่ยน — ยังไม่มีอะไรให้เซฟ';
    else if (!typed) gtHint.textContent = 'ใส่ข้อความ commit ก่อน';
    else gtHint.innerHTML = 'พร้อมเซฟ ' + gtInfo.files.length + ' ไฟล์ขึ้น branch <code>' + esc(gtInfo.branch) + '</code>';
  }

  function gtRender(r) {
    gtBox.hidden = !(r.log && r.log.length);
    gtBox.className = 'field' + (r.status === 'done' ? ' done' : r.status === 'error' ? ' bad' : '');
    document.getElementById('gtLog').textContent = (r.log || []).join('\\n');
    if (r.status === 'done') {
      gtPill.className = 'pill done'; gtPill.textContent = 'เซฟแล้ว';
      document.getElementById('gtTitle').textContent = 'เซฟขึ้น GitLab เรียบร้อย';
      document.getElementById('gtMsgOut').textContent =
        'ส่ง ' + r.pushed + ' ไฟล์ขึ้น branch ' + r.branch + ' แล้ว';
    } else if (r.status === 'error') {
      gtPill.className = 'pill bad'; gtPill.textContent = 'ไม่สำเร็จ';
      document.getElementById('gtTitle').textContent = 'เซฟไม่สำเร็จ';
      document.getElementById('gtMsgOut').textContent = (r.error || '') + (r.hint ? ' — ' + r.hint : '');
    }
  }

  async function gtRefresh() {
    if (gtBusy) return;
    try {
      const j = await (await fetch('/git/status')).json();
      gtRenderInfo(j.info);
    } catch { /* server not answering */ }
  }

  gtStart.addEventListener('click', async () => {
    const i = gtInfo || {};
    const go = await askConfirm({
      title: 'เซฟงานขึ้น GitLab เลยหรือไม่?',
      sub: 'ส่งขึ้น branch ที่ยืนอยู่ตอนนี้ ไม่มีการสลับ branch',
      icon: '💾',
      lines: [
        'branch ปลายทาง: <code>' + esc(i.branch || '?') + '</code>',
        'repo: <code>' + esc(i.origin || '?') + '</code>',
        'จะส่งไฟล์ที่เปลี่ยนทั้งหมด <b>' + (i.files ? i.files.length : 0) + ' ไฟล์</b>',
      ],
      code: 'git add -A\\ngit commit -m "' + gtMsg.value.trim() + '"\\ngit push origin ' + (i.branch || 'HEAD'),
      ok: '💾 เซฟเลย',
    });
    if (!go) return;

    gtBusy = true;
    gtStart.disabled = true;
    gtPill.className = 'pill run'; gtPill.textContent = 'กำลังเซฟ...';
    gtHint.textContent = 'กำลัง commit แล้ว push ขึ้น GitLab';
    gtBox.hidden = true;
    const t0 = Date.now();
    clearInterval(gtTicker);
    gtTicker = setInterval(() => { gtTimer.textContent = fmtElapsed(Date.now() - t0); }, 1000);
    try {
      const j = await (await fetch('/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: gtMsg.value.trim() }),
      })).json();
      gtRender(j.run || { status: 'error', error: j.error, log: [] });
    } catch (e) {
      gtRender({ status: 'error', error: 'ต่อ server ไม่ได้: ' + e.message, log: [] });
    } finally {
      clearInterval(gtTicker);
      gtTimer.textContent = fmtElapsed(Date.now() - t0);
      gtBusy = false;
      await gtRefresh();
      gtSync();
    }
  });

  // Files change from outside this page constantly — an editor, a terminal, the
  // rebrand run itself. Refreshing on focus is what keeps the file list from
  // being a lie the moment the operator alt-tabs back.
  window.addEventListener('focus', gtRefresh);

  (async () => {
    try {
      const j = await (await fetch('/git/status')).json();
      gtRenderInfo(j.info);
      if (j.run && j.run.log && j.run.log.length) gtRender(j.run);
    } catch { /* server not answering */ }
    gtSync();
  })();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (req.method === "GET" && url.pathname === "/current") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await readCurrentLinks()));
    return;
  }
  if (req.method === "GET" && url.pathname === "/current-pages") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await readCurrentPageMeta()));
    return;
  }
  if (req.method === "GET" && url.pathname === "/current-newpages") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await readCurrentNewPages()));
    return;
  }
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/parse-docx") {
    try {
      // POST body = the docx the operator just browsed (preview before upload);
      // GET = fall back to the staged src/assets/content.docx.
      let result;
      if (req.method === "POST") {
        const buf = await readBody(req);
        if (!buf.length) throw new Error("ไม่พบไฟล์ Content brief ที่ส่งมา");
        result = parseBriefBuffer(buf);
      } else {
        result = await readDocxSubPages();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/upload") {
    try {
      const slot = url.searchParams.get("slot") || "";
      const index = url.searchParams.get("index") || "";
      const ext = (url.searchParams.get("ext") || "").toLowerCase();
      const buf = await readBody(req);
      let written;
      let extra = {};
      if (slot === "bg") {
        // the one slot that may arrive with no body (colour / gradient mode)
        written = await handleBackground(url.searchParams, buf);
      } else if (slot === "aff") {
        // text-only slots: the new link comes in ?value=, never as a body
        written = await handleAffLink(url.searchParams.get("value"));
      } else if (slot === "line") {
        written = await handleLineLink(url.searchParams.get("value"));
      } else if (slot === "pagemeta") {
        // sub-page SEO: page key + title + desc arrive in the query, no body
        written = await writePageMeta(
          url.searchParams.get("page") || "",
          url.searchParams.get("title"),
          url.searchParams.get("desc"),
        );
      } else if (slot === "newpage") {
        // Optional page, switched on or off. `on=0` parks it (see disablePage);
        // anything else turns it on — either scaffolding it, or moving it back
        // out of src/pages-disabled — and wires both the navbar and footer link.
        const key = url.searchParams.get("page") || "";
        const cfg = PRESET_PAGES[key];
        if (!cfg) throw new Error(`ไม่รู้จักหน้า preset: ${key}`);

        if (url.searchParams.get("on") === "0") {
          const off = await disablePage(key);
          written = off.written;
          extra = { disabled: off.parked, missing: !!off.missing };
        } else {
          const pageRes = await createPage(key, url.searchParams.get("title"), url.searchParams.get("desc"));
          const navRes = await addNavLink(cfg.route, cfg.navLabel, cfg.icon);
          // Footers already ship their own /login and /register rows, so a cta
          // toggle neither adds one nor is allowed to remove one — the off path
          // would otherwise delete a link it never created.
          const footRes = cfg.kind === "cta" ? {} : await addFooterLink(cfg.route, cfg.footerLabel || cfg.navLabel);
          const entRes = cfg.kind === "cta" ? await removeNavLink(ENTRANCE.route) : {};
          if (entRes.entry) {
            await mkdir(PAGES_DISABLED, { recursive: true });
            await writeFile(ENTRANCE_STASH, entRes.entry);
          }
          written = [...pageRes.written];
          if (navRes.inserted) written.push(`navbar ${navRes.navFile} (+${navRes.inserted})`);
          if (footRes.inserted) written.push(`footer ${footRes.footerFile} (+${footRes.inserted})`);
          if (entRes.removed) written.push(`navbar ${entRes.navFile} (-${entRes.removed} ${ENTRANCE.label})`);
          extra = {
            created: pageRes.created,
            // distinguishes "moved back from pages-disabled" from "scaffolded
            // fresh" — the operator gets last brand's article in one case and a
            // TODO placeholder in the other, so the log has to say which
            restored: !!pageRes.restored,
            // a cta page overwrote an interstitial rather than appearing from
            // nothing — the operator needs to see that the redirect was moved
            replacedRedirect: !!pageRes.replacedRedirect,
            ctaTarget: pageRes.target || null,
            navWarning: navRes.warning || null,
            navAlready: !!navRes.already,
            footerWarning: footRes.warning || null,
          };
        }
      } else {
        // bannermobile with clear=1 is a deletion, so it legitimately arrives
        // with no body — every other slot here still must carry one.
        const isClear = slot === "bannermobile" && url.searchParams.get("clear") === "1";
        if (!buf.length && !isClear) throw new Error("empty upload");
        written = await handleUpload(slot, index, ext, buf, url.searchParams);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, written, ...extra }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: friendlyUploadError(err) }));
    }
    return;
  }
  // ── ส่วนที่ 6: build / fire / watch / stop the rebrand run ────────────────
  if (req.method === "GET" && url.pathname === "/rebrand/preview") {
    // The UI never assembles the prompt itself — it renders whatever this
    // returns, so what's shown and what's fired can't drift apart.
    try {
      const prompt = buildRebrandPrompt({
        brand: url.searchParams.get("brand"),
        url: url.searchParams.get("url"),
        notes: url.searchParams.get("notes"),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, prompt }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/rebrand/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, run: runSnapshot(), docx: await stagedDocxInfo() }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/rebrand/fastcheck") {
    // Refused mid-run on purpose: the answer would arrive too late to act on,
    // and spawning a second claude beside a rebrand only muddies the log.
    if (isActive()) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "มีงานรันอยู่ — เช็กได้หลังงานจบ" }));
      return;
    }
    const probe = await probeFastMode();
    res.writeHead(probe.ok ? 200 : 502, { "Content-Type": "application/json" });
    res.end(JSON.stringify(probe));
    return;
  }
  if (req.method === "POST" && url.pathname === "/rebrand/start") {
    try {
      const body = await readJson(req);
      const run = startRun({
        brand: body.brand,
        url: body.url,
        notes: body.notes,
        dry: url.searchParams.get("dry") === "1",
        fast: body.fast === true,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, run }));
    } catch (err) {
      res.writeHead(isActive() ? 409 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/rebrand/stop") {
    try {
      stopRun("manual");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, run: runSnapshot() }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/rebrand/stream") {
    const from = Number(url.searchParams.get("from")) || 0;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    // Replay first, then subscribe. Node is single-threaded and nothing awaits
    // between the two, so no event can slip through the gap.
    for (const ev of runState.events) {
      if (ev.i >= from) res.write("data: " + JSON.stringify(ev) + "\n\n");
    }
    if (isActive()) {
      runState.clients.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(":ping\n\n"); } catch { /* closing */ }
      }, 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        runState.clients.delete(res);
      });
    } else {
      res.end();
    }
    return;
  }

  // ── ส่วนที่ 7: build + preview the site ───────────────────────────────────
  if (req.method === "GET" && url.pathname === "/preview/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, preview: previewSnapshot() }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/preview/start") {
    try {
      // Responds only once the build has finished and the server answers, so
      // the browser never opens a tab on a page that isn't up yet. The client
      // polls /preview/status meanwhile to show progress.
      const snap = await startPreview();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: snap.status === "running", preview: snap }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message, preview: previewSnapshot() }));
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/preview/stop") {
    stopPreview();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, preview: previewSnapshot() }));
    return;
  }

  // ── deploy ────────────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/deploy/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, deploy: deploySnapshot(), target: await deployTarget() }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/deploy/start") {
    try {
      const snap = await startDeploy();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: snap.status === "done", deploy: snap }));
    } catch (err) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message, deploy: deploySnapshot() }));
    }
    return;
  }

  // ── Cloudflare account ────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/cf/status") {
    // Only reach for whoami when nothing is mid-switch; during a switch the
    // flow owns the answer and will refresh it itself.
    if (cfState.status !== "running") await cfWhoami(url.searchParams.get("refresh") === "1");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cf: cfSnapshot(), target: await deployTarget() }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/cf/switch") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cf: await startCfSwitch() }));
    } catch (err) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message, cf: cfSnapshot() }));
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/cf/stop") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cf: stopCfSwitch() }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/cf/account") {
    try {
      const target = await setAccountId(url.searchParams.get("id") || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, target }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ── git commit + push ─────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/git/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, info: await gitInfo(), run: gitSnapshot() }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/git/push") {
    try {
      const body = await readJson(req);
      const snap = await startGitPush(body.message || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: snap.status === "done", run: snap }));
    } catch (err) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message, run: gitSnapshot() }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// ensure target dirs exist (they normally do in this repo)
await mkdir(ASSETS, { recursive: true });
await mkdir(PUBLIC, { recursive: true });

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`\n  Rebrand asset uploader running:\n  → http://${shown}:${PORT}   (bind ${HOST})\n`);
  console.log(`  Writes into:\n  - ${ASSETS}\n  - ${PUBLIC}\n`);
  console.log(`  Rebrand runner: ${CLAUDE_BIN} (override with CLAUDE_BIN=<path to claude.exe>)`);
  console.log("  Ctrl+C to stop — that also kills a rebrand run in progress.\n");
});
