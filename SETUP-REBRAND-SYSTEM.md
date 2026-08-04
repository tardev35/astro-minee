# ติดตั้งระบบ Rebrand ทั้งชุด บนเครื่อง dev

คู่มือนี้พาตั้งค่า **เครื่อง dev 1 เครื่อง** ตั้งแต่ยังไม่มีอะไรเลย จนถึงกดรีแบรนด์
และกดขึ้นเว็บจริงบน Cloudflare ได้จากหน้าเว็บเดียว

> 📌 **ลำดับการอ่านทั้งหมดอยู่ที่ [`README.md`](README.md) หัวข้อ 🚦** ถ้ายังไม่ได้อ่านตรงนั้น
> ให้ไปอ่านก่อน จะได้รู้ว่าไฟล์นี้อยู่ตรงไหนของภาพรวม
>
> | ไฟล์ | ใช้เมื่อ |
> |---|---|
> | [`README.md`](README.md) | **จุดเริ่มต้นของทุกคน** — ลำดับการอ่าน + วิธีรีแบรนด์ + กฎเหล็ก |
> | **ไฟล์นี้** | **ตั้งเครื่องใหม่จากศูนย์** (ภาค B) + เปิด repo ให้คนใหม่ (ภาค A) |
> | [`DEPLOY-CLOUDFLARE.md`](DEPLOY-CLOUDFLARE.md) | เอาเว็บขึ้น Cloudflare + สลับบัญชี + แก้ปัญหา DNS |
> | [`CLAUDE.md`](CLAUDE.md) | สถาปัตยกรรมโปรเจกต์ (สาย dev) |
> | [`.claude/skills/rebrand-site/SKILL.md`](.claude/skills/rebrand-site/SKILL.md) | ขั้นตอนที่ Claude ทำตามตอนรีแบรนด์ (สาย dev) |
>
> ⛔ [`SETUP-NEW-MACHINE.md`](SETUP-NEW-MACHINE.md) เป็นรุ่นก่อนหน้าของไฟล์นี้
> ชี้ไป repo กับ branch ที่เลิกใช้แล้ว — **อย่าใช้**

**ปลายทางที่จะได้:**

| ของ | ค่า |
|---|---|
| ต้นแบบฉบับเบา (ที่ทุกคนโคลน) | `gitlab.com/tardev-group/astro-prototype` branch `main` — **1 commit ~5 MB** |
| ต้นแบบฉบับเต็ม (เจ้าของเท่านั้น) | `gitlab.com/tardev-group/astro-full-schema` branch `optimize-seo` |
| repo ที่คุณทำงาน | `gitlab.com/tardev-group/astro-<ชื่อคุณ>` (คนละอันต่อคน) |
| branch ที่ทำงาน | `main` |
| หน้าเว็บ dev | http://localhost:8888 |
| หน้า uploader | http://localhost:4444 |
| หน้า preview หลังรีแบรนด์ | http://localhost:4321 |

---

## 0. ระบบนี้มีอะไรบ้าง (อ่าน 1 นาทีก่อนลงมือ)

ต่างจากรุ่นก่อนตรงที่มันไม่ใช่แค่ "อัปโหลดรูป" อีกแล้ว — มี 4 ส่วนที่ต้องมีของครบถึงจะทำงาน

| ส่วน | ทำอะไร | ต้องติดตั้งอะไร |
|---|---|---|
| เว็บ Astro | ตัวเว็บลูกค้า | Node.js |
| Rebrand Uploader | หน้า UI ที่ `localhost:4444` รับไฟล์ + ยิงคำสั่ง | Node.js (ใช้ `sharp` ย่อรูป) |
| Claude Code CLI | ตัวที่ลงมือรีแบรนด์จริงตอนกดปุ่ม | **Claude CLI + login** |
| Cloudflare (wrangler) | ปุ่มขึ้นเว็บจริง + ปุ่มสลับบัญชี | **`wrangler login`** |

**ขาดข้อ 3 = ปุ่ม "เริ่ม Rebrand" กดแล้วไม่มีอะไรเกิด**
**ขาดข้อ 4 = ปุ่ม "ขึ้นเว็บจริง" ล้มตอนยิง**

สองข้อนี้คือของใหม่ที่คู่มือรุ่นก่อนไม่มี และเป็นข้อที่คนลืมบ่อยที่สุด

---

# ภาค A — เปิด repo ให้เพื่อน (คนที่ถือต้นแบบทำ)

> **dev ที่มารับเครื่อง ข้ามภาคนี้ทั้งภาค ไปเริ่มที่ [ภาค B](#ภาค-b--ตั้งเครื่อง-dev-ทำทุกเครื่อง)**
> ทุกอย่างในภาคนี้เจ้าของต้นแบบทำให้เสร็จก่อนส่งมอบแล้ว

## โครงที่ใช้อยู่

```
astro-full-schema / optimize-seo          ← ต้นแบบฉบับเต็ม มีคนเดียวที่แตะ
        │                                    (176 commit / 575 MB — ไม่ให้ใครโคลน)
        │  ยุบเหลือ commit เดียว
        ▼
astro-prototype / main                         ← ต้นแบบฉบับเบา 5 MB ที่ทุกคนโคลน
        │
        ├──> astro-bas    (บาส)
        ├──> astro-tud    (ตุ๊ด)
        └──> astro-aoy    (อ้อย)
```

**หนึ่งคน หนึ่ง repo** ทุก repo ปลายทางมี `main` เป็นสำเนาของต้นแบบ แล้วเจ้าตัวแตก branch
ของตัวเองทำงานบนนั้น

> **ทำไมยังต้องมีต้นแบบ ในเมื่อทุกคนมี repo ของตัวเอง** — เพราะมันเป็นที่เดียวที่รวมงาน
> จากทุกคนแล้วส่งกลับให้ทุกคนได้ ถ้าไม่มีจุดรวม สิ่งที่ตุ๊ดแก้จะไม่มีทางไปถึงอ้อยเลย

> **ทำไมมีต้นแบบสองชั้น** — ทุกครั้งที่รีแบรนด์ รูป banner/slide ชุดใหม่ ~3 MB ถูกคอมมิตลง
> ประวัติและอยู่ที่นั่นตลอดไป ผ่านมา ~30 แบรนด์ ประวัติจึงหนัก **575 MB เพื่อไฟล์จริง 6 MB**
> มีคนโคลนแล้วรอ **30 นาที** `astro-prototype` คือ tree เดียวกันเป๊ะแต่ตัดประวัติทิ้ง เหลือ 5 MB
> โคลนเสร็จในไม่กี่วินาที

---

## เลือกทางก่อน — เพื่อนได้โค้ดไปยังไง มี 2 แบบ

|  | **ทาง 1 — เพื่อนโคลนเอง** | **ทาง 2 — คุณยกให้** |
|---|---|---|
| เหมาะกับ | สาย dev / คนที่ใช้ git เป็น | สายคอนเทนต์ ที่ไม่อยากยุ่งกับ git |
| เพื่อนต้องทำ | โคลน `astro-prototype` แล้วตั้ง remote เอง 4 คำสั่ง | โคลน repo ตัวเองบรรทัดเดียว |
| คุณต้องทำต่อคน | ไม่ต้องทำอะไรเลย | สร้าง repo + push ให้ 2 คำสั่ง |
| เพื่อนต้องเข้าถึง `astro-prototype` | ต้องได้ | ไม่ต้อง |
| จุดที่พลาดง่าย | อยู่ฝั่งเพื่อน (ตั้ง remote ผิด → push ทับต้นแบบ) | อยู่ฝั่งคุณ |
| อ่านต่อที่ | **A2ก** | **A1 → A2ข** |

**ทั้งสองทางได้ไฟล์ชุดเดียวกันเป๊ะ** ต่างกันแค่ใครเป็นคนกดและใครรับความเสี่ยงที่จะพิมพ์ผิด
เลือกทางไหนแล้วให้ใช้ทางนั้นกับ repo นั้นตลอด **อย่าสลับไปมา** — ทางที่ 2 ต้องการให้
`main` ปลายทางเป็นกระจกเงาของต้นแบบ ถ้าเพื่อนเคยตั้ง remote เองมาก่อนแล้วคุณมายิงทับ
คำสั่งจะถูกปฏิเสธ

---

## A2ก. ทาง 1 — ส่งให้เพื่อนโคลนเอง

**สิ่งที่คุณทำ ทำครั้งเดียวต่อคน:**

1. สร้าง project เปล่า `astro-<ชื่อคน>` ตาม [A1](#a1-สร้าง-project-เปล่าใน-gitlab) — **ห้ามติ๊ก Initialize with README**
2. เชิญเจ้าตัวเข้ากลุ่ม `tardev-group` สิทธิ์ **Developer**
3. บอกชื่อ repo ให้เขา แล้วให้ไปทำ **[ภาค B](#ภาค-b--ตั้งเครื่อง-dev-ทำทุกเครื่อง) ตั้งแต่ B1**

จบ — ที่เหลือเขาทำเองทั้งหมด คุณไม่ต้อง push อะไรให้

> **คำสั่งโคลน + ตั้ง remote อยู่ที่ B4** ไม่เขียนซ้ำตรงนี้ เพราะเคยมีปัญหาว่าคนก็อป
> จากภาค A ไปรัน แล้วข้าม B1–B3 ที่เป็นการลงโปรแกรมกับตั้ง SSH key

> 🚨 **สิ่งที่ต้องย้ำกับเขาให้ได้เรื่องเดียว: `git remote set-url --push upstream DISABLED`**
> ทุกคนในกลุ่มมีสิทธิ์เขียน `astro-prototype` การเผลอพิมพ์ `git push upstream` ครั้งเดียว
> จะพาแบรนด์ของคนนั้นขึ้นไปเป็นต้นแบบให้คนที่โคลนทีหลังได้ไปทั้งกลุ่ม

> ⚠️ **ใครที่ตั้ง `upstream` ไว้เป็น `astro-mean` ตอนต้นเดือน ส.ค. ต้องเปลี่ยน** — repo นั้น
> ถูกคืนให้เป็นที่ทำงานของแบรนด์ ไม่ใช่ต้นแบบแล้ว ถ้าไม่เปลี่ยน คำสั่งดึงเครื่องมือข้างล่าง
> จะลากไฟล์ของแบรนด์นั้นมาแทน:
>
> ```bash
> git remote set-url upstream git@gitlab.com:tardev-group/astro-prototype.git
> git remote set-url --push upstream DISABLED
> ```

**เวลาต้นแบบมีของใหม่** — หยิบเฉพาะส่วนเครื่องมือ ไม่ merge ทั้งก้อน:

```bash
git fetch upstream
git checkout upstream/main -- tools/ .claude/
git commit -m "ดึงเครื่องมือจากต้นแบบ"
```

> **ทำไมไม่ `git merge upstream/main`** — เขารีแบรนด์ทับ `wrangler.toml` `astro.config.mjs`
> `src/pages/` `src/assets/` ไปหมดแล้ว merge ทั้งก้อนจะชนทุกไฟล์ตรงนั้น คำสั่งข้างบนหยิบมา
> เฉพาะโฟลเดอร์ที่ไม่มีใครแก้เอง ไม่มี conflict

---

# ทาง 2 — คุณยกให้ (A1 → A2ข)

ส่วนที่เหลือของภาค A ทั้งหมดตั้งแต่ตรงนี้ลงไปคือ**ทางที่ 2** ถ้าใช้ทางที่ 1 ข้ามไป
[ภาค B](#ภาค-b--ตั้งเครื่อง-dev-ทำทุกเครื่อง) ได้เลย

**เพื่อนไม่ต้องมีสิทธิ์เข้าถึงต้นแบบเลยแม้แต่ครั้งเดียว** เขาเห็นแค่ repo ของตัวเอง —
ขั้นตอนที่พลาดง่ายทั้งหมดอยู่ฝั่งคุณ ทำครั้งเดียวต่อคน

---

## A1. สร้าง project เปล่าใน GitLab

GitLab → **New project** → **Create blank project**

| ช่อง | ค่า |
|---|---|
| Project name | `astro-<ชื่อคน>` เช่น `astro-tud` |
| Project URL | group `tardev-group` |
| Visibility | **Private** |
| Initialize repository with a README | **ห้ามติ๊ก** ⚠️ ติ๊กแล้ว repo จะไม่ว่าง แล้วจะชนกับที่กำลังจะ push |

จากนั้น **Manage → Members → Invite members** เชิญเจ้าตัวเข้ามา ให้สิทธิ์ **Developer**
(push branch ตัวเองได้ แต่แตะ `main` ที่ถูก protect ไม่ได้ — ซึ่งเป็นสิ่งที่เราต้องการพอดี)

## A2ข. ยกโค้ดขึ้น repo นั้น — 2 คำสั่ง

ทำจาก**โฟลเดอร์ต้นแบบ** คือโฟลเดอร์ `astro-full-schema` ในเครื่องคุณ

**ยังไม่มีโฟลเดอร์นั้น?** ดึงลงมาก่อนด้วย `git clone` — **มันสร้างโฟลเดอร์ให้เอง
ไม่ต้องไปสร้างโฟลเดอร์เปล่ารอไว้** ทำครั้งเดียวจบ:

```powershell
cd $HOME\Desktop        # แค่บอกว่าจะให้โฟลเดอร์ไปโผล่ที่ไหน
git clone git@gitlab.com:tardev-group/astro-full-schema.git
cd astro-full-schema
git switch optimize-seo
```

> `clone` กับ `pull` ไม่ใช่ตัวเดียวกัน — `clone` ใช้ตอน**ยังไม่มีโค้ดในเครื่องเลย**
> ดึงมาทั้งก้อนพร้อมสร้างโฟลเดอร์ ส่วน `pull` ใช้กับโฟลเดอร์ที่**เป็น repo อยู่แล้ว**
> เพื่อดึงเฉพาะของใหม่ โฟลเดอร์เปล่าที่สร้างเองใน File Explorer ยัง `pull` ไม่ได้
> เพราะ git ยังไม่รู้จักมันว่าเป็น repo

**มีโฟลเดอร์อยู่แล้ว?** เข้าไปแล้วดึงของล่าสุดมาก่อน:

```powershell
cd path\ไปยัง\astro-full-schema
git switch optimize-seo
git pull
```

**แล้วยกขึ้น repo ของเพื่อน:**

```powershell
# 1) ตั้งชื่อเล่นให้ repo ของเขา — ทำครั้งเดียวต่อคน
git remote add tud git@gitlab.com:tardev-group/astro-tud.git

# 2) ส่งขึ้นไปโดยใช้ชื่อ main บนนั้น
git push tud prototype:main
```

จบ — เพื่อน clone ได้เลย

> 🪶 **ส่ง `prototype` ไม่ใช่ `optimize-seo`** ทั้งที่ไฟล์ชุดเดียวกัน — `prototype`
> คือ commit เดียวที่ไม่มีพ่อแม่ ยกไป **~6 MB** ส่วน `optimize-seo` ลากประวัติ 176 commit
> ไปด้วย **575 MB** ปลายทางได้ไฟล์เหมือนกันเป๊ะทั้งคู่ ต่างกันแค่เวลารอ
>
> **`prototype` คือ branch เดียวกับที่ push ขึ้น `astro-prototype`** เวลาอัปเดตต้นแบบให้ทีม
> ให้คอมมิตทับบน branch นี้แล้ว `git push proto prototype:main` — **ห้าม force**
> ไม่งั้นทุกคนที่โคลนไปแล้วต้อง `git reset --hard` ตามทั้งหมด

> **`tud` เป็นชื่อเล่นที่คุณตั้งเอง** อยู่แค่ในไฟล์ `.git/config` ของโฟลเดอร์นี้
> GitLab ไม่รู้จักชื่อนี้ ส่วนที่เป็นของจริงคือ URL ตั้งชื่อให้รู้ว่าใครเป็นใคร
> (`tud`, `aoy`, `bas`) ดีกว่าชื่อกลางๆ อย่าง `newrepo` เพราะพอมี 5 คนจะจำไม่ได้

> 🚨 **`:main` ท้ายคำสั่งคือหัวใจ ห้ามตกหล่น** แปลว่า "เอา branch ในเครื่องชื่อนี้
> ขึ้นไปใช้ชื่อ `main` บน remote" — ชื่อสองฝั่งไม่จำเป็นต้องตรงกัน
>
> **ถ้าลืมใส่** branch จะไปโผล่ชื่อ `prototype` และเพราะเป็น branch แรกของ repo
> เปล่า มันจะกลายเป็น default branch อัตโนมัติ + ถูก GitLab ป้องกันทันที การจะแก้ทีหลัง
> ต้องไล่เปลี่ยน default → ปลด protection → ลบ branch เก่า สามขั้นในหน้าเว็บ
> **เคยพลาดมาแล้วกับ `astro-bas`**
>
> **และอย่าใส่ `-u`** ในโฟลเดอร์ต้นแบบ มันจะล็อกให้ `git push` เฉยๆ วิ่งไป repo นั้นที่เดียว
> ทั้งที่โฟลเดอร์นี้ผูกหลาย repo — สั่งชื่อ remote ตรงๆ ทุกครั้งปลอดภัยกว่า

> **ทำไมเปลี่ยนชื่อเป็น `main`** — ใน repo ของเขา โค้ดชุดนี้*คือ*ตัวหลัก ไม่ใช่ branch ทดลอง
> การคงชื่อ `prototype` ไว้เป็นแกนจะทำให้เขาเข้าใจผิดว่าเป็น branch ชั่วคราวที่ห้ามแตะ
> — ทั้งที่มันคือฐานที่เขาจะทำงานทับ

## A3. ส่งอะไรให้เพื่อน

ส่ง 2 บรรทัดนี้พอ:

```
git clone git@gitlab.com:tardev-group/astro-tud.git
```
> แล้วอ่าน `SETUP-REBRAND-SYSTEM.md` ในโฟลเดอร์ เริ่มที่ **ภาค B** (ข้ามภาค A)

เขาจะได้ `main` เป็น default, `git push` เฉยๆ ใช้ได้ทันที ไม่ต้อง `switch` ไม่ต้องรู้จัก
คำว่า `prototype` ด้วยซ้ำ

**⚠️ อย่าส่งคำสั่งของภาค A ให้เพื่อนรัน** — คำสั่งอย่าง `git push tud prototype:main`
ใช้ได้เฉพาะโฟลเดอร์ต้นแบบ เพราะเครื่องเขาไม่มีทั้ง remote ชื่อ `tud` และ branch ชื่อ
`prototype` จะขึ้น `src refspec ... does not match any` **เคยพลาดมาแล้ว**

| | โฟลเดอร์ต้นแบบ (คุณ) | เครื่องเพื่อน |
|---|---|---|
| remote | `origin` = astro-full-schema, `proto` = astro-prototype, `tud`/`aoy`/`bas` = ของแต่ละคน | `origin` = repo ตัวเองอันเดียว |
| branch | `optimize-seo` (ที่ทำงาน) + `prototype` (ที่ส่งออก) | `main` |
| ทิศทาง | ส่งออก | รับเข้า + push branch ตัวเอง |

## A4. เวลาต้นแบบมีของใหม่ → กระจายออก

```powershell
git push proto prototype:main     # ต้นแบบฉบับเบา (คนที่โคลนเองดึงจากที่นี่)
git push bas  prototype:main
git push dev  prototype:main
git push tud  prototype:main
git push aoy  prototype:main
```

`git remote add` ทำครั้งเดียวตอนเปิด repo ครั้งต่อๆ ไปเหลือแค่บรรทัด `push`
เพื่อนแต่ละคนแค่ `git switch main` แล้ว `git pull`

> **ก่อนกระจาย ต้องอัปเดต `prototype` ให้ตรงกับงานล่าสุดก่อน** มันไม่ขยับตาม
> `optimize-seo` ให้เอง — เป็นคนละสายประวัติกันโดยตั้งใจ วิธีอัปเดตอยู่ใน **A6**

> ⚠️ **`astro-dev` ยังใช้บรรทัดข้างบนไม่ได้ (สถานะ ณ 28 ก.ค.)** มันแตกเป็นคนละสายไปตั้งแต่
> **25 ก.ค.** (`d12ac16`) แล้วเดินต่อด้วยรีแบรนด์ของตัวเองซ้อนกันหลายชั้นบน `main`
> (`NOVA852 → ดีเฮง789 → KINGHENG168 → PGZEED168 → ezwin168`) บวกกับ uploader
> คนละเวอร์ชัน — ตอนนี้ห่างกัน **57 vs 26 commit / 93 ไฟล์** คำสั่งกระจายจะถูกปฏิเสธ
> และ **`git merge dev/main` จะลากแบรนด์ของเขาเข้าต้นแบบทั้งก้อน อย่าทำ**
>
> จนกว่าจะรวมสายกันได้ ให้ยกทีละ commit แทน — ดู **A4.1**

**กติกาข้อเดียวที่ทำให้คำสั่งนี้ปลอดภัยตลอด:**

> **`main` ของทุก repo ปลายทางคือกระจกเงาของต้นแบบ ห้ามให้มี commit ที่ต้นแบบไม่มี**
> ทุกคนต้องแตก branch ของตัวเองเสมอ

### 🚨 การกด Merge ของ MR เข้า `main` ก็นับเป็นการคอมมิตลง `main`

จุดที่พลาดง่ายที่สุด เพราะมันไม่รู้สึกเหมือนคอมมิต — เป็นแค่การกดปุ่มเขียวในหน้าเว็บ
และเป็นสิ่งที่เจ้าของ repo ทำเป็นธรรมชาติที่สุดเมื่อเห็นงานที่ดี **เคยพลาดมาแล้วกับ
`astro-bas` วันที่ 27 ก.ค.** — พอกด Merge เสร็จ คำสั่งกระจายก็ถูกปฏิเสธทันที

**MR ใน repo ปลายทางมีไว้ให้ดูโค้ด ไม่ได้มีไว้กด Merge** งานที่ผ่านการรีวิวแล้วต้องเดินทาง
แบบนี้เท่านั้น:

```
branch ของ dev  →  [A5] เข้าต้นแบบ  →  [A4] กระจายกลับลงทุก repo
```

ถ้ากด Merge เข้า `main` ปลายทางไปแล้ว ไม่ต้องตกใจและ**อย่า `--force`** — ทำ **A5** ตามปกติ
คือดึง `main` ของ repo นั้นกลับเข้าต้นแบบ แล้วกระจายออกใหม่ ทุกอย่างจะกลับมาเป็นสายเดียวกัน

### ถ้าคำสั่งกระจายถูกปฏิเสธ

```
! [rejected]  Updates were rejected because the remote contains work that you do not have locally
```

แปลว่า repo ปลายทางมี commit ที่ต้นแบบไม่มี **นี่คือ branch protection ทำหน้าที่ถูกแล้ว
ไม่ใช่ความผิดพลาด** มันเพิ่งกันไม่ให้คุณทับงานคนอื่นหาย

ดูก่อนว่าใครทำอะไรไว้:

```powershell
git fetch tud
git log --format="%h  %an  %ar%n    %s" prototype..tud/main
```

แล้วดึงกลับเข้าต้นแบบตาม **A5** — เสร็จแล้วคำสั่งกระจายจะผ่านเอง

**`--force` แก้ปัญหานี้ไม่ได้ มันแค่ลบงานเขาทิ้ง** แล้วคนที่เสียงานจะไม่รู้ตัวด้วยซ้ำ

## A4.1 repo ที่แตกเป็นคนละสายไปแล้ว — ยกทีละ commit

ใช้เมื่อ repo ปลายทางเดินไปไกลจนรวมกลับไม่ไหวในตอนนี้ แต่ยังอยากให้ของชิ้นเดียวไปถึง
ทำใน **worktree ชั่วคราว** จะได้ไม่ต้องสลับ branch ในโฟลเดอร์ที่กำลังทำงานอยู่

```powershell
git fetch dev
git worktree add -b tmp-ยกของ ..\tmp-cp dev/main
cd ..\tmp-cp
git cherry-pick <commit>
# แก้ conflict — กติกา: เก็บสี/ข้อความของแบรนด์เขาไว้ เอาเฉพาะโครงสร้างของเราเข้าไป
git cherry-pick --continue
```

**ต้อง build ให้ผ่านก่อน push เสมอ** ไม่ต้อง `npm install` ใหม่ ยืม `node_modules`
ของโฟลเดอร์ต้นแบบมาใช้ได้เลย (เร็วกว่ามาก):

```powershell
cmd /c mklink /J node_modules C:\path\ไปยัง\astro-full-schema-main\node_modules
npm run build
```

ผ่านแล้วค่อยส่งขึ้นไป แล้วเก็บกวาด:

```powershell
git push dev tmp-ยกของ:main
cmd /c rmdir node_modules        # ⚠️ ปลด junction ก่อนเสมอ — อ่านกล่องข้างล่าง
cd ..\astro-full-schema-main
git worktree remove --force ..\tmp-cp
git branch -D tmp-ยกของ
```

> 🚨 **ห้ามสลับลำดับ 2 บรรทัดนี้เด็ดขาด** ถ้า `git worktree remove --force` รันตอน junction
> ยังอยู่ **มันจะเดินทะลุ junction เข้าไปลบ `node_modules` ตัวจริงของโฟลเดอร์ต้นแบบ**
> คำสั่งจะขึ้น `failed to delete ... Invalid argument` เหมือนล้มเหลวเฉยๆ แต่ของถูกลบไปแล้ว
> บางส่วน อาการที่ตามมาคือ `npm run build` ขึ้น `'astro' is not recognized`
> **เคยพลาดมาแล้ววันที่ 28 ก.ค.** แก้ได้ด้วย `npm install` ซ้ำ แต่ไม่ต้องให้ถึงตรงนั้น

> **conflict ที่จะเจอคือ `Footer*.astro` / `Navbar*.astro` เป็นหลัก** เพราะเป็นไฟล์ที่
> ทุกแบรนด์ retheme ทับ — เวลาแก้ให้ดูว่าอันไหนคือ "สีของแบรนด์เขา" (เก็บไว้) อันไหนคือ
> "โครงสร้าง/component ใหม่ของเรา" (เอาเข้า) ห้ามเลือกทั้งฝั่งแบบไม่อ่าน

## A5. เวลางานของเพื่อนดี อยากเก็บเข้าต้นแบบ

```powershell
# ในโฟลเดอร์ต้นแบบ
git fetch tud
git switch optimize-seo
git merge tud/ชื่อ-branch-ของเขา     # แก้ conflict ถ้ามี
git push origin optimize-seo          # เข้าต้นแบบฉบับเต็มก่อน
```

แล้ว **A6** เพื่อยกลง `prototype` จากนั้นค่อยกระจายออกทุกคนตาม **A4** —
เสร็จแล้วลบ branch ของเขาทิ้งได้

```powershell
git push tud --delete ชื่อ-branch-ของเขา
```

> **ถามตัวเองก่อนรับเข้า: อันนี้ควรมีผลกับทุกคนจริงไหม** งานบางอย่างเป็นการแก้ให้เข้ากับ
> เครื่องตัวเอง เช่นเปลี่ยนพอร์ตเพราะพอร์ตเดิมชนกับโปรแกรมอื่น — แบบนั้นให้เก็บไว้ใน
> repo ของเขาเอง อย่าลากทุกคนไปด้วย

## A6. อัปเดต `prototype` ให้ตรงกับต้นแบบ (ทำก่อน A4 ทุกครั้ง)

`prototype` เป็น**คนละสายประวัติ**กับ `optimize-seo` โดยตั้งใจ (มันเริ่มจาก commit
ที่ไม่มีพ่อแม่) มันจึงไม่ขยับตามให้เอง ต้องยกเนื้อไฟล์ข้ามมาเอง

รันจากโฟลเดอร์ต้นแบบ **ไม่ต้องสลับ branch ไม่แตะไฟล์ในโฟลเดอร์เลย** — ทำงานผ่าน index
ชั่วคราว จึงรันได้แม้กำลังแก้อะไรค้างอยู่:

```powershell
$env:GIT_INDEX_FILE = "$env:TEMP\tpl-index"
git read-tree optimize-seo
git rm --cached -q src/assets/banner.png src/assets/banner2.png src/assets/banner3.png
$tree = (git write-tree).Trim()
Remove-Item Env:\GIT_INDEX_FILE
Remove-Item "$env:TEMP\tpl-index"

$commit = (git commit-tree $tree -p (git rev-parse prototype) -m "Sync template with optimize-seo").Trim()
git branch -f prototype $commit
```

เช็กก่อน push ว่าได้ของถูก:

```powershell
git diff-tree -r --name-status optimize-seo prototype   # ต้องเห็นแค่ banner 3 ไฟล์
git status --short                                          # ต้องไม่มีอะไรงอกจากคำสั่งข้างบน
```

แล้วค่อยกระจายตาม **A4**

> **บรรทัด `git rm --cached` คือส่วนที่ต้องอ่าน** — `banner.png` `banner2.png` `banner3.png`
> เป็นอาร์ตเวิร์กของแบรนด์เก่าที่ไม่มีโค้ดไหน import แล้ว ตั้งแต่ `MainLayout` แคบ glob
> เหลือ `banner1.*` รวม **3 MB** ที่ต้นแบบไม่ควรแจกต่อ ถ้ามีไฟล์ตายเพิ่มในอนาคตให้เติม
> ชื่อในบรรทัดนี้
>
> **`-p (git rev-parse prototype)` คือสิ่งที่ทำให้ push แบบไม่ต้อง force** commit ใหม่
> ต่อท้ายของเดิมเป็นสายเดียวกัน ทุกคนที่โคลนไปแล้วจึง `git pull` ได้ตามปกติ
> **ถ้าตัดตัวนี้ออกจะกลายเป็นสายใหม่ทั้งเส้น** แล้วทุกคนต้อง `git reset --hard` ตามกันหมด

---

# ภาค B — ตั้งเครื่อง dev (ทำทุกเครื่อง)

> ทำไล่จาก **B1 ถึง B7 ตามลำดับ ห้ามข้าม** จบ B7 แล้วเครื่องพร้อมรีแบรนด์จริง
> ถ้าติดตรงไหนดู [ภาค E](#ภาค-e--ปัญหาบ่อย) ก่อนถาม

## B1. ติดตั้งโปรแกรม 3 ตัว

โหลดจากเว็บ กด Next รวดตาม default ได้ทั้งหมด

| # | โปรแกรม | ลิงก์ | ใช้ทำอะไร |
|---|---|---|---|
| 1 | **Node.js** เลือกตัว **LTS** | https://nodejs.org | ตัวเว็บ + uploader (`sharp` ที่ย่อรูปต้องใช้ LTS ตัว Current พัง) |
| 2 | **Git** | https://git-scm.com/download/win | เก็บงาน + รับของใหม่จากต้นแบบ |
| 3 | **Python 3** ติ๊ก **Add python.exe to PATH** ในหน้าแรกของตัวติดตั้ง | https://www.python.org/downloads/ | ตัวสำรองตอนอ่าน `.docx` |

> **Python จำเป็นแค่ไหน** — งานปกติไม่ใช้ เพราะ uploader แตกไฟล์ `.docx` เป็น `content.txt`
> ให้แล้ว แต่ถ้าได้ `.docx` มาตรงๆ โดยไม่ผ่าน uploader Claude จะ unzip แล้วอ่านด้วย Python
> ไม่มีก็ทำงานได้ **แต่จะติดตรงนั้นแบบงงๆ** ลงไว้ก่อนดีกว่า

เช็ก (เปิด **PowerShell ใหม่** หลังติดตั้ง):

```powershell
node --version      # ต้องได้ v20 ขึ้นไป (เครื่องที่พัฒนาใช้ v22)
npm --version
git --version
python --version    # ต้องได้ 3.x
```

> ⚠️ **ต้องเปิดหน้าต่างใหม่** โปรแกรมที่เพิ่งลงจะยังไม่อยู่ใน PATH ของหน้าต่างเก่า
> ถ้า `python` ยังไม่รู้จักทั้งที่ลงแล้ว = ลืมติ๊ก **Add python.exe to PATH**
> ให้รันตัวติดตั้งซ้ำ เลือก **Modify** แล้วติ๊กช่องนั้น

## B2. ติดตั้ง Claude Code CLI ⭐

เปิด **cmd.exe** (ไม่ใช่ PowerShell):

```
curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd
```

**เปิดหน้าต่างใหม่** แล้วเช็ก:

```powershell
claude --version
```

ขึ้นเลขเวอร์ชัน = ผ่าน ข้ามไปหัวข้อถัดไปได้เลย

<details>
<summary><b>ขึ้น <code>claude ... is not recognized</code> ทั้งที่ลงไปแล้ว — กดอ่านตรงนี้</b></summary>

ไฟล์ลงแล้วแต่ Windows หาไม่เจอ บางเครื่องตัวติดตั้งบอกตรงๆ ว่า
`Native installation exists but C:\Users\<ชื่อ>\.local\bin is not in your PATH`

**① เช็กก่อนว่าไฟล์อยู่จริงไหม** — คัดลอกไปวางได้เลย ไม่ต้องแก้อะไร `$HOME` คือโฟลเดอร์
ผู้ใช้ของเครื่องนั้นเอง (`C:\Users\<ชื่อคุณ>`) PowerShell เติมให้อัตโนมัติ:

```powershell
Test-Path $HOME\.local\bin\claude.exe
```

- `False` → ยังไม่ได้ติดตั้งจริง ย้อนขึ้นไปรันคำสั่งติดตั้งใน **cmd.exe**
- `True` → PATH ไม่ติด ทำข้อ ②

**② แก้ PATH ถาวร** — วางทั้ง 4 บรรทัดใน PowerShell:

```powershell
$new = "$HOME\.local\bin"
$p = [Environment]::GetEnvironmentVariable('Path','User')
if (-not $p) { $p = '' }
if ($p -notlike "*$new*") { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $new), 'User') }
```

> ⚠️ **อย่าใช้ `setx PATH "%PATH%;..."`** ที่หาเจอตามเน็ต — `%PATH%` รวม PATH ของระบบมาด้วย
> แล้วไปก๊อปยัดใน PATH ส่วนตัว และ `setx` ตัดทิ้งทุกอย่างที่เกิน 1024 ตัวอักษร PATH ที่ยาว
> อยู่แล้วจะหายไปเงียบๆ กู้คืนยาก คำสั่งข้างบนแตะแค่ PATH ส่วนตัวและไม่มีลิมิตนั้น

> ⚠️ **`$HOME` ต้องอยู่ในเครื่องหมายคำพูดคู่ `"` เท่านั้น** ถ้าเปลี่ยนเป็นคำพูดเดี่ยว `'`
> PowerShell จะไม่แทนค่าให้ แล้วคุณจะได้โฟลเดอร์ชื่อ `$HOME` จริงๆ ตัวหนึ่งแทนพาธที่ต้องการ
> — ไม่ขึ้น error ด้วย เพราะฉะนั้นคัดลอกไปทั้งบรรทัด อย่าพิมพ์ตามเอง

**③ ปิดหน้าต่างทุกบานแล้วเปิดใหม่** — จุดที่คนติดกันมากที่สุด หน้าต่างที่เปิดค้างอยู่อ่าน
PATH ไปตั้งแต่ตอนเปิดแล้ว แก้ทีหลังเท่าไหร่มันก็ไม่เห็น **รวมหน้าต่างที่รัน uploader ค้างไว้ด้วย**

อยากใช้ในหน้าต่างเดิมเลยโดยไม่ปิด:

```powershell
$env:Path += ";$HOME\.local\bin"
```

**ทางลัดถ้า PATH ยังดื้อ** — บอกพาธให้ uploader ตรงๆ แล้วเปิด uploader **จากหน้าต่างเดียวกันนั้น**
(ตัวแปรมีผลเฉพาะหน้าต่างนั้น ดับเบิลคลิก `start-uploader.cmd` จะไม่ได้ค่านี้):

```powershell
$env:CLAUDE_BIN = "$HOME\.local\bin\claude.exe"
npm run rebrand:upload
```

</details>

### login ให้เรียบร้อย — ข้อที่คนลืมบ่อยที่สุด

```powershell
claude
```

ทำตามที่ถามบนหน้าจอจน login เสร็จ แล้วพิมพ์ `/exit`

> ปุ่ม "เริ่ม Rebrand" ยิง `claude -p` แบบไม่มีหน้าจอให้ตอบคำถาม
> **ถ้ายังไม่ login มันจะค้างเงียบๆ โดยไม่มี error ที่อ่านรู้เรื่อง**
> ต้อง login ให้จบในหน้าต่างปกติก่อนอย่างน้อย 1 ครั้ง

## B3. ตั้งชื่อ-อีเมล Git + SSH key

**① บอก git ว่าคุณเป็นใคร** (ชื่อนี้จะติดไปกับทุก commit):

```powershell
git config --global user.name "ชื่อจริง"
git config --global user.email "อีเมลที่ใช้สมัคร GitLab"
git config --global push.autoSetupRemote true
```

**② สร้าง SSH key** — ยังไม่มีบัญชี GitLab ให้สมัครที่ https://gitlab.com ก่อน แล้วบอกหัวหน้า
ให้เชิญเข้ากลุ่ม `tardev-group`

```powershell
ssh-keygen -t ed25519 -C "อีเมล GitLab"
```

กด **Enter รวด 3 ครั้ง** (ที่เก็บ default, ไม่ใส่รหัสผ่าน)

**③ เอา key ไปใส่ใน GitLab**

```powershell
Get-Content $HOME\.ssh\id_ed25519.pub
```

คัดลอกทั้งบรรทัดที่ขึ้นมา → GitLab → คลิกรูปโปรไฟล์มุมขวาบน → **Edit profile** →
**SSH Keys** (เมนูซ้าย) → **Add new key** → วาง → Add key

**④ เช็กว่าใช้ได้จริง**

```powershell
ssh -T git@gitlab.com
```

ต้องขึ้น `Welcome to GitLab, @ชื่อคุณ!` — ถ้าขึ้น `Permission denied (publickey)` แปลว่า
key ยังไม่เข้า ย้อนไปข้อ ③

> ครั้งแรกจะถามว่า `Are you sure you want to continue connecting?` ให้พิมพ์ **yes**

## B4. โคลนโค้ด

**หัวหน้าสร้าง repo ให้คุณแล้ว** ชื่อ `tardev-group/astro-<ชื่อคุณ>` — ถ้ายังไม่มี ทักขอก่อน
อย่าไปสร้างเอง

โคลน **ต้นแบบ** ลงมาแล้วเปลี่ยนปลายทางเป็น repo ของคุณ (แทน `astro-tuch` ด้วยชื่อตัวเอง
ทั้ง 3 จุด):

```powershell
cd $HOME\Desktop

# ① โคลนต้นแบบ ~5 MB เสร็จในไม่กี่วินาที
git clone git@gitlab.com:tardev-group/astro-prototype.git astro-tuch
cd astro-tuch

# ② ต้นแบบกลายเป็น upstream (ดึงอย่างเดียว) — repo ของคุณเป็น origin
git remote rename origin upstream
git remote add origin git@gitlab.com:tardev-group/astro-tuch.git
git remote set-url --push upstream DISABLED

# ③ ส่งขึ้น repo ตัวเอง
git push -u origin main
```

**เช็กก่อนไปต่อ — ข้อนี้พลาดแล้วเดือดร้อนทั้งกลุ่ม:**

```powershell
git remote -v
```

```
origin    git@gitlab.com:tardev-group/astro-tuch.git (fetch)
origin    git@gitlab.com:tardev-group/astro-tuch.git (push)      ← ของคุณ
upstream  git@gitlab.com:tardev-group/astro-prototype.git (fetch)
upstream  DISABLED (push)                                        ← ต้องเป็น DISABLED
```

> 🚨 **อย่าหยุดแค่ `git clone`** ถ้าไม่ทำข้อ ② ต่อ `git push` จะวิ่งไปทับ **ต้นแบบของทั้งกลุ่ม**
> บรรทัด `set-url --push upstream DISABLED` ทำให้พิมพ์ผิดแล้วขึ้น error เฉยๆ แทนที่จะทับจริง
> ส่วน `git fetch upstream` ยังใช้ได้ปกติ

> โหลดแล้วขึ้นเป็นร้อย MB รอเป็นสิบนาที = **โคลนผิด repo** กด Ctrl+C ทิ้งแล้วดูชื่อให้ดี
> ต้นแบบคือ `astro-prototype` ไม่ใช่ `astro-full-schema`

> **`git log --oneline` ขึ้นไม่กี่ commit = ปกติ ไม่ใช่ของหาย** ต้นแบบถูกยุบประวัติทิ้ง
> โดยตั้งใจ เพราะประวัติเก่าคือรูปของแบรนด์ที่เลิกใช้แล้วรวม 575 MB

## B5. ติดตั้ง dependencies

```powershell
npm install
```

ครั้งแรกใช้เวลาสักพัก — `sharp` (ตัวย่อรูปของ uploader) ต้องดาวน์โหลด binary ของ Windows มาด้วย

## B6. `wrangler login` — ผูกกับ Cloudflare ⭐ ของใหม่

```powershell
npx wrangler login
```

- ครั้งแรกถามว่าจะติดตั้ง `wrangler` ไหม → ตอบ **y**
- เบราว์เซอร์เปิดหน้า Cloudflare ให้กด **Allow**

เช็ก:

```powershell
npx wrangler whoami
```

ต้องขึ้นอีเมล + ตาราง Account ID **ถ้าขึ้นว่ายังไม่ได้ login ให้ทำซ้ำ**

> - ไม่ต้อง `npm i -g wrangler` — มันอยู่ใน `devDependencies` แล้ว `npx` หยิบตัวในโปรเจกต์ให้เอง
> - เครื่อง dev ที่ไม่ต้อง deploy เอง **ข้ามข้อนี้ได้** ทุกอย่างอื่นทำงานปกติ
>   แค่ปุ่ม "ขึ้นเว็บจริง" กับแถวบัญชีในการ์ด 7 จะใช้ไม่ได้
> - รายละเอียดเรื่องบัญชี/โดเมน/ปัญหาที่เจอจริง อยู่ใน [`DEPLOY-CLOUDFLARE.md`](DEPLOY-CLOUDFLARE.md)

## B7. ตรวจว่าเครื่องพร้อมจริง — อย่าข้าม

4 ข้อนี้ตรงกับ 4 ส่วนของระบบพอดี ทำให้ครบก่อนบอกว่าเสร็จ

**1) เว็บขึ้นไหม**

```powershell
npm run dev
```

เปิด http://localhost:8888 ต้องเห็นเว็บ → `Ctrl+C` ปิด

**2) uploader ขึ้นไหม**

```powershell
npm run rebrand:upload
```

เปิด http://localhost:4444 ต้องเห็นการ์ด 1-7
(หรือดับเบิลคลิก `tools\rebrand-uploader\start-uploader.cmd` ก็ได้ ไม่ต้องเปิด VS Code)

**3) uploader ต่อกับ Claude ได้ไหม** ⭐ ข้อที่ตัดสินว่าติดตั้งสำเร็จหรือไม่

ในหน้า uploader → การ์ด 6 → กดปุ่ม **🧪 ทดสอบท่อ**

ใช้เวลาไม่กี่วินาที ไม่แตะไฟล์อะไร **ถ้าขึ้นเขียว = ครบแล้ว** ถ้าค้างหรือแดง กลับไปดู B2

**4) Cloudflare ต่อได้ไหม** (ข้ามได้ถ้าไม่ deploy จากเครื่องนี้)

ในหน้า uploader → การ์ด 7 → ดูแถว **บัญชี Cloudflare**
ต้องขึ้นอีเมลกับชื่อบัญชี **ถ้าขึ้น "ยังไม่ได้ login" ให้กลับไปทำ B6**

---

# ภาค C — ค่าที่ผูกกับแบรนด์ ต้องถูกก่อนกด "ขึ้นเว็บจริง"

ระบบยิงขึ้นเว็บจริงได้ในปุ่มเดียว **ผิดที่ไหนก็ทับของจริงที่นั่น** สี่จุดนี้ต้องเป็นของแบรนด์นี้

| ไฟล์ | ค่า | ถ้าผิดจะเกิดอะไร |
|---|---|---|
| `wrangler.toml` | `name` | 🚨 **ทับ Worker ของแบรนด์อื่น เว็บนั้นหายทันที** |
| `wrangler.toml` | `account_id` | ไปโผล่ในบัญชีที่ไม่มีใครดูอยู่ |
| `astro.config.mjs` | `site:` | canonical / sitemap / og:image ชี้ผิดโดเมน |
| `src/pages/index.astro` | `webSiteSchema.url` | JSON-LD ชี้ผิดโดเมน |

**ไม่ต้องแก้ `account_id` ด้วยมือ** — กดปุ่ม **🔑 สลับบัญชี** ในการ์ด 7 มันเขียนให้
(ดู [`DEPLOY-CLOUDFLARE.md`](DEPLOY-CLOUDFLARE.md) → "สลับบัญชีเมื่อบัญชีเดิมครบจำนวน")

ส่วนอีกสามจุด Claude แก้ให้ตอนรีแบรนด์ **ถ้าใส่ URL จริงในการ์ด 6**
ถ้าเว้นว่างไว้ มันจะไม่แตะโดเมนเดิมโดยตั้งใจ

**หน้าต่างยืนยันก่อน deploy บอกชื่อ Worker กับบัญชีให้อ่านทุกครั้ง — อ่านก่อนกด**

---

# ภาค D — งานประจำวันหลังจากนี้

```powershell
# ── เริ่มงานทุกครั้ง เอาของใหม่มาก่อนเสมอ ──
git switch main
git pull

# ── แล้วค่อยแตก branch ของงานนี้ ──
git switch -c ชื่องานที่จะทำ      # อย่าทำบน main

npm run rebrand:upload            # เปิด uploader
# ...อัปโหลดไฟล์ → กดเริ่ม Rebrand → กดทดสอบหน้าเว็บ → ติ๊ก 5 ข้อ → ขึ้นเว็บจริง...

git status                        # ดูว่าแก้อะไรไป
git add -A
git commit -m "ข้อความ"
git push -u origin ชื่องานที่จะทำ
```

> 🚨 **`git pull` ก่อนเริ่มงาน สำคัญกว่าที่คิด**
>
> repo ของคุณเป็นสำเนาของต้นแบบ เวลาต้นแบบมีของใหม่จะถูกดันลงมาที่ `main` ของคุณ
> — **แต่ไม่มีอะไรเด้งบอก** ถ้าไม่ pull คุณจะทำงานบนของเก่าไปเรื่อยๆ ยิ่งนานยิ่งห่าง
> และตอนส่งงานกลับจะชนกันหนัก
>
> เสียเวลา 3 วินาที แลกกับการไม่ต้องมานั่งแก้ conflict ทีหลัง

คำสั่ง Git ที่จำเป็นทั้งหมดพร้อมตัวอย่าง อยู่ใน [README หัวข้อ 6.2](README.md)

**เช็กว่ายืนอยู่ branch ไหน:**

```powershell
git branch --show-current
```

## บอกกันก่อนลงมือ

ทุกคนเปิดหน้าเว็บเดียวกัน จึงเห็นบั๊กเดียวกันพร้อมกันได้ง่ายมาก **วันที่ 28 ก.ค. เกิดขึ้น
3 ครั้งในวันเดียว** — ปุ่มลิงก์ผิด, พอร์ตในเอกสาร, การ์ดกดไม่ได้ สองครั้งแรกรอดเพราะบังเอิญ
แก้เหมือนกันเป๊ะ ครั้งที่สามชนกันจริงและเกือบทำให้สีเว็บย้อนกลับไปเป็นแบรนด์เก่า

ไม่ต้องมีระบบอะไร **พิมพ์บอกในแชทประโยคเดียวก่อนแก้ก็พอ** — "เจอปุ่มกดไม่ได้ กำลังแก้"

## พอร์ตชนกับโปรแกรมอื่น — อย่าแก้ไฟล์

ถ้า `4444` ถูกโปรแกรมอื่นในเครื่องใช้อยู่ **อย่าไปแก้ `package.json` หรือ `server.mjs`**
เพราะการแก้ไฟล์จะไหลกลับเข้าต้นแบบแล้วลากทุกคนย้ายพอร์ตตาม ทั้งที่ปัญหาอยู่ที่เครื่องคุณคนเดียว

สั่งพอร์ตเฉพาะครั้งนั้นแทน — `server.mjs` อ่าน `process.env.PORT` อยู่แล้ว:

```powershell
$env:PORT=5555; npm run rebrand:upload
```

แล้วเปิด `http://localhost:5555` ปิดหน้าต่างเมื่อไหร่ค่าก็หายไป ไม่มีอะไรค้างในโค้ด

---

# ภาค E — ปัญหาบ่อย

| อาการ | สาเหตุ | แก้ |
|---|---|---|
| `claude` ไม่รู้จักคำสั่ง | ยังไม่เปิดหน้าต่างใหม่หลังติดตั้ง | ปิด PowerShell แล้วเปิดใหม่ |
| ปิด-เปิดหน้าต่างแล้วยัง `claude` ไม่รู้จัก | ไฟล์ลงแล้วแต่ไม่อยู่ใน PATH | กล่องพับใน **B2** — เช็ก `Test-Path` แล้วเติม PATH ถาวร |
| `ไม่พบคำสั่ง claude` ขึ้นในหน้า uploader ทั้งที่ `claude --version` ในหน้าต่างอื่นได้ | uploader จำ PATH ตอนที่มันถูกเปิด | `Ctrl+C` ปิด uploader แล้ว `npm run rebrand:upload` ใหม่ |
| กดสลับบัญชี CF แล้วไม่เด้งหน้า login | **ไม่ใช่บั๊ก** ระบบตั้งใจไม่เปิดเบราว์เซอร์ให้ | รอสถานะขึ้น "รออนุญาตในเบราว์เซอร์..." แล้ว**กดลิงก์ในการ์ด** หรือทำ `npx wrangler login` เองในหน้าต่างแยก |
| กดสลับบัญชี CF ระหว่าง rebrand รันอยู่ | ระบบบล็อกไว้ — ขั้นเลือกบัญชีเขียนทับ `wrangler.toml` ที่ rebrand กำลังแก้ | รอ rebrand จบก่อน · ระหว่างรอ `npx wrangler login` ในหน้าต่างแยกได้ (ไม่แตะไฟล์ใน repo) |
| clone นาน 30 นาที / โหลดเป็นร้อย MB | โคลนผิด repo ไปโดน `astro-full-schema` | ต้นแบบคือ `astro-prototype` ~5 MB (**B4**) |
| กด "เริ่ม Rebrand" แล้วค้างเงียบ | ยังไม่ได้ `claude` login | ทำ B2 ให้จบ แล้วกด 🧪 ทดสอบท่อ |
| `npm install` ล้มที่ `sharp` | Node เก่าเกินไป | ลง Node LTS ใหม่ |
| อัปโหลดรูปแล้วขึ้น error เขียนไฟล์ไม่ได้ | `npm run dev` เปิดค้างอยู่ จับไฟล์ไว้ | `Ctrl+C` ปิด dev server ก่อนอัปโหลด |
| ปุ่ม Rebrand เป็นสีจาง กดไม่ได้ | ยังอัปโหลดไม่ครบ | อัปโหลดให้เสร็จ ปุ่มจะสว่างเอง |
| ปุ่ม "ขึ้นเว็บจริง" กดไม่ได้ | ยังไม่ได้ทดสอบหน้าเว็บ / ติ๊กไม่ครบ 5 ข้อ | กดทดสอบหน้าเว็บก่อน แล้วติ๊กให้ครบ |
| `wrangler` บอกว่าไม่ได้ login | ยังไม่ทำ B6 หรือเพิ่งกดสลับบัญชีแล้วยกเลิก | `npx wrangler login` ใหม่ |
| deploy สำเร็จแต่เปิดเว็บไม่ได้ | DNS ค้าง / ยังไม่ผูก Custom Domain | [`DEPLOY-CLOUDFLARE.md`](DEPLOY-CLOUDFLARE.md) ขั้นที่ 0 และปัญหา ⑤ |
| พอร์ต 4444 ถูกโปรแกรมอื่นใช้อยู่ | ชนกับของในเครื่องคุณเอง | `$env:PORT=5555; npm run rebrand:upload` — **อย่าแก้ไฟล์** (ภาค D) |
| `git push` ขึ้น `Updates were rejected` | ปลายทางมี commit ที่ต้นแบบไม่มี | ดู **A4** — ดึงกลับเข้าต้นแบบด้วย **A5** ก่อน **ห้าม `--force`** |
| ทำงานอยู่ดีๆ แล้ว conflict เต็มไปหมด | ไม่ได้ `git pull` มานาน ห่างจากต้นแบบไปไกล | ภาค D — `git switch main && git pull` ก่อนเริ่มงานทุกครั้ง |
| แก้บั๊กแล้วแต่ repo อื่นยังพังอยู่ | หยุดที่ repo ตัวเอง ไม่ได้ส่งกลับต้นแบบ | **A5** ดึงเข้าต้นแบบ แล้ว **A4** กระจายออกทุก repo |
| ตอนรีแบรนด์ขึ้น `cp874 codec can't encode` | Python พิมพ์อักษรนอกโค้ดเพจไทยของ Windows | **ไม่ใช่งานพัง** เป็นแค่คำสั่งพิมพ์ผลตรวจ Claude ทำงานต่อเอง |
| `python` ไม่รู้จักคำสั่ง | ลืมติ๊ก **Add python.exe to PATH** ตอนติดตั้ง | รันตัวติดตั้งซ้ำ → **Modify** → ติ๊กช่องนั้น (B1) |
| `ssh -T git@gitlab.com` ขึ้น `Permission denied (publickey)` | ยังไม่ได้เอา SSH key ใส่ GitLab | **B3 ข้อ ③** |
| `git push` ครั้งแรกขึ้น `rejected` ทั้งที่ repo เพิ่งสร้าง | ตอนสร้าง repo ติ๊ก "Initialize with README" | ลบ repo แล้วสร้างใหม่แบบ **ว่างเปล่า** (A1) |
| `git remote -v` ขึ้น `origin` เป็น `astro-prototype` | ข้ามข้อ ② ของ B4 — **push ตอนนี้จะทับต้นแบบทั้งกลุ่ม** | ทำ B4 ข้อ ② ให้ครบก่อน push |

---

# สรุปคำสั่งทั้งหมด (เครื่องใหม่ ไล่จากบนลงล่าง)

แทน `astro-tuch` ด้วยชื่อ repo ที่หัวหน้าสร้างให้ (มี 3 จุด)

```powershell
# ═══ B1 ═══ ลงจากเว็บ กด Next รวด: Node.js LTS · Git · Python 3 (ติ๊ก Add to PATH)
node --version ; git --version ; python --version     # ต้องขึ้นเลขครบ 3 ตัว

# ═══ B2 ═══ Claude CLI — รันบรรทัดนี้ใน cmd.exe เท่านั้น ไม่ใช่ PowerShell:
#    curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd
#    แล้วปิดหน้าต่างทิ้ง เปิดใหม่
claude --version
claude                   # login ให้เสร็จ แล้วพิมพ์ /exit

# ═══ B3 ═══ git config + SSH key
git config --global user.name "ชื่อจริง"
git config --global user.email "อีเมล GitLab"
git config --global push.autoSetupRemote true
ssh-keygen -t ed25519 -C "อีเมล GitLab"               # Enter รวด 3 ครั้ง
Get-Content $HOME\.ssh\id_ed25519.pub                 # ก๊อปไปใส่ GitLab → Edit profile → SSH Keys
ssh -T git@gitlab.com                                 # ต้องขึ้น Welcome to GitLab

# ═══ B4 ═══ โคลนต้นแบบ แล้วเปลี่ยนปลายทางเป็น repo ของตัวเอง
cd $HOME\Desktop
git clone git@gitlab.com:tardev-group/astro-prototype.git astro-tuch
cd astro-tuch
git remote rename origin upstream
git remote add origin git@gitlab.com:tardev-group/astro-tuch.git
git remote set-url --push upstream DISABLED
git push -u origin main
git remote -v            # origin ต้องเป็น astro-tuch · upstream push ต้องเป็น DISABLED

# ═══ B5 ═══
npm install

# ═══ B6 ═══
npx wrangler login       # ข้ามได้ถ้าไม่ deploy จากเครื่องนี้
npx wrangler whoami

# ═══ B7 ═══ ทดสอบว่าพร้อม ต้องผ่านครบ 4 ข้อ
npm run dev              # 1) เปิด localhost:8888 → Ctrl+C
npm run rebrand:upload   # 2) เปิด localhost:4444
                         # 3) การ์ด 6 → กด 🧪 ทดสอบท่อ → ต้องเขียว
                         # 4) การ์ด 7 → แถวบัญชี Cloudflare ต้องขึ้นอีเมล
```
