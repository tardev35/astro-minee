import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKDIR = join(ROOT, ".rebrand-dist");

const TEAM = ["bas", "mean", "minee", "tuch"];

const BRAND_PATHS = ["src/pages/", "src/components/", "src/assets/", "public/", "astro.config.mjs", "workspec.md"];

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function git(args, cwd = ROOT) {
  const r = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trimEnd(), err: (r.stderr ?? "").trimEnd() };
}

function gitOk(args, cwd = ROOT) {
  const r = git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}\n${r.err || r.out}`);
  return r.out;
}

function die(msg) {
  console.error(`\n${C.red("หยุด")} ${msg}\n`);
  process.exit(1);
}

const USAGE = `
  node tools/distribute.mjs --check
  node tools/distribute.mjs <commit>... [--to bas,mean] [--dry-run] [--allow-content]

  --check           ดูว่าแต่ละ repo ขาด commit เครื่องมือตัวไหนบ้าง (ไม่แตะอะไร)
  --to              เลือก repo ปลายทาง (ไม่ใส่ = ${TEAM.join(", ")})
  --dry-run         cherry-pick + build ให้ดู แต่ไม่ push
  --allow-content   ยอมให้ยก commit ที่แตะไฟล์เนื้อหาแบรนด์ไปด้วย
  --no-build        ข้าม npm run build (ใช้ตอนรีบเท่านั้น)
  --limit N         --check ย้อนดูกี่ commit (ค่าเริ่มต้น 30)
`;

const argv = process.argv.slice(2);
const opts = { to: null, check: false, dryRun: false, allowContent: false, noBuild: false, limit: 30 };
const asked = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--to") opts.to = argv[++i];
  else if (a === "--limit") opts.limit = Number(argv[++i]);
  else if (a === "--check") opts.check = true;
  else if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--allow-content") opts.allowContent = true;
  else if (a === "--no-build") opts.noBuild = true;
  else if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (a.startsWith("-")) die(`ไม่รู้จักตัวเลือก ${a} — ดู --help`);
  else asked.push(a);
}

const remotes = new Set(gitOk(["remote"]).split("\n").filter(Boolean));
const targets = (
  opts.to
    ? opts.to
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : TEAM
).filter((r) => {
  if (remotes.has(r)) return true;
  console.log(C.yellow(`  ข้าม ${r} — ยังไม่มี remote ชื่อนี้`));
  return false;
});
if (!targets.length) die("ไม่มี repo ปลายทางที่ใช้ได้");

function commitFiles(sha) {
  return gitOk(["show", "--format=", "--name-only", sha]).split("\n").filter(Boolean);
}

function brandFilesIn(files) {
  return files.filter((f) => BRAND_PATHS.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
}

function subject(sha) {
  return gitOk(["log", "-1", "--format=%s", sha]);
}

const stateCache = new Map();

function applyState(sha, ref) {
  const key = `${sha} ${ref}`;
  if (stateCache.has(key)) return stateCache.get(key);

  let res;
  if (git(["merge-base", "--is-ancestor", sha, ref]).code === 0) {
    res = { state: "present", why: "commit เดียวกัน" };
  } else if (git(["cherry", ref, sha, `${sha}~1`]).out.startsWith("-")) {
    res = { state: "present", why: "patch เดียวกัน" };
  } else {
    const r = git(["merge-tree", "--write-tree", `--merge-base=${sha}~1`, ref, sha]);
    const lines = r.out.split("\n");
    if (r.code === 0) {
      res = lines[0].trim() === gitOk(["rev-parse", `${ref}^{tree}`]) ? { state: "present", why: "เนื้อหาตรงกันแล้ว" } : { state: "apply" };
    } else if (r.code === 1) {
      const seen = git(["log", ref, "--format=%s", "-n", "400"]).out.split("\n");
      if (seen.includes(subject(sha))) {
        res = { state: "present", why: "ยกไปแล้วแบบแก้ conflict" };
      } else {
        const files = lines.filter((l) => /^\d{6} [0-9a-f]{40} [123]\t/.test(l)).map((l) => l.split("\t")[1]);
        res = { state: "conflict", files: [...new Set(files)] };
      }
    } else {
      res = { state: "unknown", why: r.err || r.out };
    }
  }

  stateCache.set(key, res);
  return res;
}

function brandNameIn(cwd) {
  const f = join(cwd, "src", "lib", "brandProfile.ts");
  if (!existsSync(f)) return "?";
  const m = readFileSync(f, "utf8").match(/BRAND_NAME\s*(?::[^=]*)?=\s*["'`]([^"'`]+)/);
  return m ? m[1] : "?";
}

function fetchAll() {
  for (const r of targets) {
    const f = git(["fetch", "--quiet", r]);
    if (f.code !== 0) die(`ดึง ${r} ไม่สำเร็จ\n${f.err}`);
  }
}

function toolCommitsOnHead() {
  const shas = gitOk(["log", "--format=%h", `-n`, String(opts.limit)])
    .split("\n")
    .filter(Boolean);
  return shas
    .reverse()
    .map((sha) => ({ sha, subject: subject(sha), brand: brandFilesIn(commitFiles(sha)) }))
    .filter((c) => c.brand.length === 0);
}

function runCheck() {
  fetchAll();
  const cands = toolCommitsOnHead();
  console.log(`\n${C.bold("commit เครื่องมือ")} ใน ${opts.limit} commit ล่าสุดของ ${gitOk(["rev-parse", "--abbrev-ref", "HEAD"])} — ${cands.length} ตัว (ไม่แตะไฟล์เนื้อหาเลย)\n`);

  const liftable = new Set();
  const needAttention = new Set();

  for (const r of targets) {
    const ref = `${r}/main`;
    const head = gitOk(["log", "-1", "--format=%h %s", ref]);
    const missing = cands.filter((c) => applyState(c.sha, ref).state === "apply");
    const murky = cands.filter((c) => applyState(c.sha, ref).state === "conflict");

    if (!missing.length && !murky.length) {
      console.log(`  ${C.green("✓")} ${C.bold(r.padEnd(6))} ครบแล้ว   ${C.dim(head)}`);
      continue;
    }
    console.log(`  ${C.yellow("•")} ${C.bold(r.padEnd(6))} ขาด ${missing.length}${murky.length ? ` · ต้องดูเอง ${murky.length}` : ""}   ${C.dim(head)}`);
    for (const m of missing) {
      console.log(`      ${C.yellow("ขาด")}      ${m.sha}  ${m.subject}`);
      liftable.add(m.sha);
    }
    for (const m of murky) {
      console.log(`      ${C.dim("ต้องดูเอง")} ${m.sha}  ${m.subject}`);
      needAttention.add(r);
    }
  }

  if (liftable.size) {
    const order = cands.filter((c) => liftable.has(c.sha)).map((c) => c.sha);
    const to = targets.filter((r) => cands.some((c) => applyState(c.sha, `${r}/main`).state === "apply"));
    console.log(`\n  ยกตัวที่ยกได้:\n  ${C.bold(`node tools/distribute.mjs ${order.join(" ")} --to ${to.join(",")}`)}`);
  } else {
    console.log(`\n  ${C.green("ไม่มีตัวไหนที่ยกอัตโนมัติได้แล้ว")}`);
  }

  if (needAttention.size) {
    console.log(`\n  ${C.dim('"ต้องดูเอง" = merge ชนกัน มักแปลว่าเครื่องนั้นได้เนื้อหาไปแล้วทางอื่น (A6) หรือแก้ทับเอง')}\n  ${C.dim("ถ้าไม่แน่ใจ เช็กด้วย git show <remote>/main:<ไฟล์> ก่อนลงมือ")}`);
  }
  console.log("");
}

function npmBuild(cwd) {
  const r = spawnSync("npm run build", { cwd, encoding: "utf8", shell: true, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: (r.status ?? 1) === 0, log: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function tailOf(log, n = 12) {
  return log
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n)
    .map((l) => `      ${l}`)
    .join("\n");
}

function distributeTo(remote, picks, stamp) {
  const ref = `${remote}/main`;
  const todo = picks.filter((p) => applyState(p.sha, ref).state !== "present");
  const already = picks.length - todo.length;

  if (!todo.length) return { remote, state: "skip", note: `มีครบแล้วทั้ง ${picks.length} ตัว` };

  const wt = join(WORKDIR, remote);
  const branch = `dist-${remote}-${stamp}`;
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
  git(["worktree", "prune"]);
  gitOk(["worktree", "add", "--quiet", "-b", branch, wt, ref]);

  try {
    const applied = [];
    const failed = [];

    for (const p of todo) {
      const r = git(["cherry-pick", p.sha], wt);
      if (r.code === 0) {
        applied.push(p);
        continue;
      }
      const files = git(["diff", "--name-only", "--diff-filter=U"], wt).out.split("\n").filter(Boolean);
      git(["cherry-pick", "--abort"], wt);
      failed.push({ ...p, files });
    }

    const brand = brandNameIn(wt);
    if (!applied.length) return { remote, state: "conflict", note: `แบรนด์ ${brand} — ยกไม่ได้สักตัว`, failed };

    if (!opts.noBuild) {
      const b = npmBuild(wt);
      if (!b.ok) return { remote, state: "build", note: `แบรนด์ ${brand} — build ไม่ผ่าน ไม่ push`, log: tailOf(b.log), failed };
    }

    if (opts.dryRun) {
      return { remote, state: "dry", note: `แบรนด์ ${brand} — ยกได้ ${applied.length} ตัว, build ผ่าน, ไม่ push`, failed };
    }

    const push = git(["push", remote, `${branch}:main`]);
    if (push.code !== 0) return { remote, state: "push", note: push.err || push.out, failed };

    const range = push.err.match(/([0-9a-f]{7,}\.\.[0-9a-f]{7,})/);
    const bits = [`แบรนด์ ${brand}`, `ยก ${applied.length} ตัว`];
    if (already) bits.push(`มีอยู่แล้ว ${already}`);
    if (range) bits.push(range[1]);
    return { remote, state: failed.length ? "partial" : "ok", note: bits.join(" — "), failed };
  } finally {
    git(["worktree", "remove", "--force", wt], ROOT);
    git(["branch", "-D", branch]);
    git(["worktree", "prune"]);
  }
}

function runDistribute() {
  const dirty = gitOk(["status", "--porcelain"]);
  if (dirty) {
    console.log(`\n  ${C.dim(`โฟลเดอร์นี้มีของค้าง ${dirty.split("\n").length} ไฟล์ — ไม่กระทบ ทุกอย่างทำใน worktree แยก`)}`);
  }

  const picks = asked.map((sha) => {
    const full = git(["rev-parse", "--verify", `${sha}^{commit}`]);
    if (full.code !== 0) die(`ไม่รู้จัก commit ${sha}`);
    const files = commitFiles(sha);
    return { sha: gitOk(["rev-parse", "--short", sha]), subject: subject(sha), files, brand: brandFilesIn(files) };
  });

  const tainted = picks.filter((p) => p.brand.length > 0);
  if (tainted.length && !opts.allowContent) {
    console.error(`\n${C.red("commit ต่อไปนี้แตะไฟล์เนื้อหาแบรนด์")} — ยกไปจะลากของแบรนด์นี้ไปด้วย\n`);
    for (const t of tainted) {
      console.error(`  ${t.sha}  ${t.subject}`);
      for (const f of t.brand) console.error(`      ${C.red(f)}`);
    }
    console.error(`\n  ถ้าตั้งใจจริง (เช่นแก้โครงสร้างที่บังเอิญอยู่ในไฟล์หน้า) ใส่ ${C.bold("--allow-content")}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${C.bold("ยก")} ${picks.length} commit → ${targets.join(", ")}${opts.dryRun ? C.yellow("  (ซ้อม ไม่ push)") : ""}\n`);
  for (const p of picks) console.log(`  ${p.sha}  ${p.subject}`);
  console.log("");

  fetchAll();
  const stamp = Date.now().toString(36);
  const results = [];
  for (const r of targets) {
    process.stdout.write(`  ${C.bold(r.padEnd(6))} กำลังทำ...`);
    let res;
    try {
      res = distributeTo(r, picks, stamp);
    } catch (e) {
      res = { remote: r, state: "error", note: String(e.message ?? e) };
    }
    const mark = { ok: C.green("✓"), dry: C.green("✓"), skip: C.dim("–"), partial: C.yellow("!") }[res.state] ?? C.red("✗");
    process.stdout.write(`\r  ${mark} ${C.bold(r.padEnd(6))} ${res.note ?? res.state}          \n`);
    for (const f of res.failed ?? []) {
      console.log(`      ${C.yellow("ชนกัน")} ${f.sha}  ${f.subject}`);
      for (const file of f.files ?? []) console.log(`             ${C.red(file)}`);
    }
    if (res.log) console.log(res.log);
    results.push(res);
  }

  const bad = results.filter((r) => !["ok", "dry", "skip"].includes(r.state) || r.failed?.length);
  console.log("");
  if (bad.length) {
    console.log(`  ${C.yellow(`${bad.length} repo ต้องทำมือ`)} — repo ที่เหลือไปถึงแล้ว ไม่ต้องรันซ้ำ`);
    console.log(`  วิธีทำมือ: ${C.dim("SETUP-REBRAND-SYSTEM.md → A4.1")}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${C.green("เสร็จทุกเครื่อง")} — บอกทีมให้สั่ง ${C.bold("git pull")} ได้เลย\n`);
}

try {
  if (opts.check) runCheck();
  else if (!asked.length) console.log(USAGE);
  else runDistribute();
} catch (e) {
  die(String(e.message ?? e));
} finally {
  git(["worktree", "prune"]);
  if (existsSync(WORKDIR)) rmSync(WORKDIR, { recursive: true, force: true });
}
