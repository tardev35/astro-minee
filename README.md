# คู่มือเริ่มต้นใช้งาน (Onboarding)

เว็บ Astro template
"เปิดตัวแบรนด์ใหม่" = เอาโครงหน้าเดิมมาเปลี่ยนชื่อ สี และเนื้อหาใหม่
โดยสั่งงานผ่าน **Claude Code** เป็นหลัก และเก็บโค้ดไว้บน **GitLab**

---

# 🚦 เครื่องเปล่า เริ่มตรงไหน — อ่านตามลำดับนี้

มีคู่มือหลายไฟล์ **อย่าเปิดมั่ว** ไล่ตามนี้ทีละข้อ ข้ามไม่ได้

| ลำดับ | ทำอะไร | อ่านที่ไหน | เสร็จเมื่อ |
|---|---|---|---|
| **0** | เข้าใจภาพรวม 2 นาที | หน้านี้ ย่อหน้าถัดไป + **ข้อ 9 กฎเหล็ก** | รู้ว่าห้ามทำอะไร |
| **1** | ลงโปรแกรม 4 ตัว · ตั้ง git config + SSH key · โคลน · ตั้ง remote | [`SETUP-REBRAND-SYSTEM.md`](SETUP-REBRAND-SYSTEM.md) **ภาค B ทั้งภาค** | `npm run dev` ขึ้นเว็บ + ปุ่ม 🧪 ทดสอบท่อ เขียว |
| **2** | รู้ว่าค่าไหนต้องถูกก่อนขึ้นเว็บจริง | [`SETUP-REBRAND-SYSTEM.md`](SETUP-REBRAND-SYSTEM.md) **ภาค C** | อ่านจบ ยังไม่ต้องทำอะไร |
| **3** | ลงมือรีแบรนด์จริง | หน้านี้ **ข้อ 5** | ได้เว็บแบรนด์ใหม่ในเครื่อง |
| **4** | เอาเว็บขึ้นจริง | [`DEPLOY-CLOUDFLARE.md`](DEPLOY-CLOUDFLARE.md) | เปิดโดเมนแล้วเห็นเว็บ |
| **5** | งานประจำวัน + git ที่ต้องใช้จริง | [`SETUP-REBRAND-SYSTEM.md`](SETUP-REBRAND-SYSTEM.md) **ภาค D** + หน้านี้ **ข้อ 6.2** | — |

**สาย dev อ่านเพิ่ม:** [`CLAUDE.md`](CLAUDE.md) (สถาปัตยกรรมโปรเจกต์) และ
[`.claude/skills/rebrand-site/SKILL.md`](.claude/skills/rebrand-site/SKILL.md) (ขั้นตอนรีแบรนด์ที่ Claude ทำตาม)

> ⛔ [`SETUP-NEW-MACHINE.md`](SETUP-NEW-MACHINE.md) เป็นรุ่นเก่า **อย่าใช้** ชี้ repo กับ branch ที่เลิกใช้แล้ว

---

## repo ของคุณอยู่ที่ไหน

ทุกคนอยู่กลุ่ม GitLab เดียวกันคือ **`tardev-group`** แต่ **แยก repo คนละอัน**

```
tardev-group/astro-prototype   ← ต้นแบบ ทุกคนโคลนจากที่นี่  (ดึงอย่างเดียว ห้าม push)
tardev-group/astro-<ชื่อคุณ>    ← ของคุณคนเดียว งานทุกอย่าง push ที่นี่
```

**repo ของคุณหัวหน้าสร้างให้แล้ว** ไม่ต้องไปสร้างเอง — ถ้ายังไม่มี ทักขอก่อนเริ่มข้อ 1
สิ่งที่ต้องเตรียมเองมีอย่างเดียวคือ **บัญชี GitLab + SSH key** (อยู่ในภาค B)

---

## 1. ติดตั้งโปรแกรม (ทำครั้งแรกครั้งเดียวต่อเครื่อง)

ต้องมี 2 โปรแกรมนี้ก่อน:

1. **Node.js** — ดาวน์โหลดจาก https://nodejs.org (เลือกตัว **LTS**) แล้วกด Next ไปเรื่อย ๆ
2. **Git** — ดาวน์โหลดจาก https://git-scm.com/download/win แล้วกด Next ไปเรื่อย ๆ ตามค่า default

**เช็กว่าติดตั้งสำเร็จ** — เปิด **PowerShell** (หรือ **Git Bash**) แล้วพิมพ์:

```powershell
git --version
node --version
```

ถ้าขึ้นเลขเวอร์ชันทั้งคู่ = พร้อมใช้งาน

> 💡 **ถ้า PowerShell บอกว่า "git ... is not recognized"** ทั้งที่ติดตั้งแล้ว
> ให้ **ปิด-เปิด PowerShell ใหม่** สักครั้ง (ต้องเปิดใหม่ path ถึงจะอัปเดต)
> ถ้ายังไม่หาย ให้ใช้ **Git Bash** แทน (ติดตั้งมาพร้อม Git อยู่แล้ว ใช้คำสั่ง git ได้เลย)

---

## 2. สมัคร GitLab + ขอเข้าทีม (ทำครั้งเดียว)

โค้ดของเราเก็บไว้บน **GitLab** ในกลุ่ม **`tardev-group`** (เป็น repo แบบ private)
คนใหม่ต้องทำ 4 ขั้นตอนนี้ให้ครบก่อนถึงจะโคลนโปรเจกต์ได้

### 2.1 สมัครบัญชี GitLab
1. เข้า **https://gitlab.com/users/sign_up**
2. สมัครด้วยอีเมล หรือกดปุ่ม **"Sign in with Google"** (ใช้ Gmail — ง่ายสุด)
3. ยืนยันอีเมลที่ GitLab ส่งไป

### 2.2 แจ้งแอดมินให้เชิญเข้ากลุ่ม
เพราะ repo เป็น private — **ส่ง username หรืออีเมล GitLab ของคุณให้แอดมิน**
แอดมินจะเชิญเข้ากลุ่ม `tardev-group` (Members → Invite) แล้วคุณจะเห็นโปรเจกต์

> แอดมินเชิญที่: `https://gitlab.com/groups/tardev-group/-/group_members`

### 2.3 ตั้งชื่อ-อีเมลให้ Git (บอก Git ว่าใครเป็นคนแก้)
พิมพ์ทีละบรรทัด (เปลี่ยนชื่อกับอีเมลเป็นของคุณ):

```powershell
git config --global user.name "ชื่อ ของคุณ"
git config --global user.email "อีเมลที่สมัคร GitLab"
git config --global push.autoSetupRemote true
```

บรรทัดที่ 3 ตั้งครั้งเดียว ช่วยให้ `git push` ทำงานง่ายขึ้น (ไม่ต้องพิมพ์ต่อท้ายยาว ๆ)

### 2.4 สร้างกุญแจ SSH + เพิ่มเข้า GitLab (ทำให้ push/pull ไม่ต้องกรอกรหัสทุกครั้ง)
พิมพ์ใน **Git Bash** (แนะนำ) หรือ PowerShell:

```bash
ssh-keygen -t ed25519 -C "อีเมลที่สมัคร GitLab"
```
- ถามที่เก็บไฟล์ → **กด Enter** (ใช้ค่า default)
- ถาม passphrase → **กด Enter ผ่าน** 2 ครั้ง (ไม่ต้องตั้งรหัส เพื่อความง่าย)

จากนั้นแสดงกุญแจสาธารณะออกมา (ก๊อปทั้งบรรทัด):
```bash
cat ~/.ssh/id_ed25519.pub
```
> ได้ข้อความขึ้นต้นด้วย `ssh-ed25519 ...` — **กุญแจนี้เปิดเผยได้ ปลอดภัย ไม่ใช่ความลับ**

เอาไปเพิ่มใน GitLab:
1. เข้า **https://gitlab.com/-/user_settings/ssh_keys**
2. วางกุญแจในช่อง **Key** → ตั้งชื่อ (เช่น `my-laptop`) → **Add key**

### 2.5 ทดสอบการเชื่อมต่อ
```bash
ssh -T git@gitlab.com
```
ถ้าขึ้น **"Welcome to GitLab, @ชื่อคุณ!"** = เชื่อมสำเร็จ พร้อมโคลนได้เลย

---

## 3. เอาโค้ดลงเครื่อง

> 📖 **ขั้นตอนเต็มอยู่ที่ [`SETUP-REBRAND-SYSTEM.md`](SETUP-REBRAND-SYSTEM.md) ภาค B**
> ทำ **B1 → B7 ตามลำดับ** แล้วกลับมาต่อข้อ 4 ของหน้านี้ · ตรงนี้สรุปให้เห็นภาพเฉยๆ

**repo ของคุณหัวหน้าสร้างให้แล้ว** ชื่อ `tardev-group/astro-<ชื่อคุณ>` — ไม่ต้อง Fork
ไม่ต้องสร้างเอง ถ้ายังไม่มีให้ทักขอก่อน

สิ่งที่เกิดขึ้นใน B4 คือโคลน **ต้นแบบ** ลงมา แล้วเปลี่ยนปลายทางให้เป็น repo ของคุณ:

```bash
git clone git@gitlab.com:tardev-group/astro-prototype.git astro-tuch
cd astro-tuch
git remote rename origin upstream          # ต้นแบบ = ดึงอย่างเดียว
git remote add origin git@gitlab.com:tardev-group/astro-tuch.git
git remote set-url --push upstream DISABLED
git push -u origin main
npm install
```

> 🚨 **สามบรรทัดกลางห้ามข้าม** ถ้าโคลนแล้วหยุดเลย `git push` จะวิ่งไปทับ **ต้นแบบของทั้งกลุ่ม**
> เช็กด้วย `git remote -v` — `origin` ต้องเป็นชื่อ repo ของคุณ และ `upstream` ฝั่ง push
> ต้องเป็น `DISABLED`

> ⛔ **วิธี Fork ที่เคยเขียนไว้ตรงนี้ เลิกใช้แล้ว** — Fork ลากประวัติเก่า 575 MB มาด้วย
> โคลนต้นแบบใช้ 5 MB ได้ไฟล์ชุดเดียวกันเป๊ะ

---

## 4. เปิดหน้าเว็บดูในเครื่อง (dev server)

```powershell
npm run dev
```

แล้วเปิดเบราว์เซอร์ไปที่ **http://localhost:8888**
หน้าเว็บจะอัปเดตทันทีทุกครั้งที่ไฟล์ถูกแก้ (ไม่ต้องรีเฟรชเอง)

หยุด server ด้วยการกด **Ctrl + C** ในหน้าต่างคำสั่ง

---

## 5. งานรีแบรนด์ผ่าน Claude Code (หัวใจของงาน)

### 5.1 เตรียมของ 3 อย่าง
- **ชื่อแบรนด์ใหม่** (เช่น `TAKDEE999`)
- **ไฟล์เนื้อหา** `.docx` (brief เนื้อหาของแบรนด์)
- **รูปภาพ** — โลโก้ / แบนเนอร์ / สไลด์

> **ถ้าแบรนด์นี้มีเว็บ WordPress อยู่แล้ว** และอยากย้ายเนื้อหามาโดยไม่ต้องก๊อปเอง
> ข้ามข้อ "ไฟล์เนื้อหา" ไปได้ ดึงอัตโนมัติแทน — [`WP-IMPORT.md`](WP-IMPORT.md)

### 5.2 อัปโหลดรูปด้วยเครื่องมือช่วย (กันรูปเพี้ยน)
เปิดหน้าต่างคำสั่งอีกอันแล้วรัน:

```powershell
npm run rebrand:upload
```

เปิดเบราว์เซอร์ไปที่ **http://localhost:4444** แล้วลากรูปเข้าไปตามช่อง
(เครื่องมือนี้จะตั้งชื่อไฟล์/นามสกุลให้ถูกอัตโนมัติ — **ควรใช้เสมอ** แทนการก๊อปไฟล์เข้า `src/assets` เอง)

> ⚠️ **ปิดหน้าเว็บ localhost:8888 ก่อนอัปโหลด** — ถ้าเคยเปิดหน้าเว็บดูใน dev server
> รอบนี้ ตัว dev server จะจับไฟล์รูปใน `src/assets` ค้างไว้ ทำให้อัปโหลดทับไม่ได้
> (ขึ้นข้อความว่าไฟล์ถูกล็อก) ให้กด **Ctrl + C** ปิด `npm run dev` ก่อน แล้วค่อยอัปโหลด
> จะเปิดดูใหม่ทีหลังก็ได้ — แค่รัน `npm run dev` อยู่เฉยๆ โดยยังไม่เปิดหน้าเว็บ ไม่มีปัญหา

หลักการตั้งชื่อรูป:
- `banner1` = รูปหลัก (hero) บนสุดของเว็บ
- `banner2`, `banner3`, `banner4` = รูปประกอบบทความ
- `slide1`–`slide4` = รูปในสไลด์/ส่วนเนื้อหา

### 5.3 สั่ง Claude Code
พิมพ์สั่งเป็นภาษาไทยได้เลย ตัวอย่าง:

```
เว็บใหม่ชื่อ TAKDEE999 รีแบรนด์ตาม docx และรูปที่วางไว้ใน src/assets ให้หน่อย
```

Claude จะทำตามขั้นตอนมาตรฐานในไฟล์ skill ให้เอง (เปลี่ยนชื่อ/สี/เนื้อหา
ทุกหน้า + ตรวจงาน) — **คุณไม่ต้องจำขั้นตอนเทคนิค** แค่บอกว่าต้องการอะไร

> ⚠️ ถ้ามี **URL จริง** ของแบรนด์ ให้บอก Claude ไปด้วยในประโยคเดียว เช่น
> `...ชื่อ TAKDEE999 url จริงคือ takdee999-guide.com` — ไม่งั้น Claude จะ
> **ไม่เดา** โดเมนให้ (ตั้งใจกันพลาด)

### 5.4 ตรวจงาน
บอก Claude ว่า `ตรวจงานให้หน่อย` หรือดูเองที่ http://localhost:8888
เช็กว่า: ชื่อแบรนด์ถูก, สีถูก, รูปขึ้นครบ, ไม่มีชื่อแบรนด์เก่าหลงเหลือ

---

## 6. บันทึกงานขึ้น GitLab (Git)

> ✅ ถ้าทำ **B4** มาครบแล้ว **ไม่ต้องตั้งค่าอะไรเพิ่ม** — `git push` เข้า repo ของคุณเองเลย

ทำ **หลังรีแบรนด์เสร็จ** หรือทุกครั้งที่แก้งานเสร็จ
พิมพ์ทีละบรรทัด (บรรทัดที่ 2 เปลี่ยนข้อความในเครื่องหมายคำพูดเป็นสิ่งที่ทำ):

```powershell
git add .
git commit -m "rebrand CHOKDEE1688"
git push
```

- `git add .` = หยิบไฟล์ที่แก้ทั้งหมด
- `git commit -m "..."` = บันทึกเป็นเวอร์ชัน พร้อมข้อความอธิบายสั้น ๆ
- `git push` = ส่งขึ้น GitLab

> 💡 **ไม่ต้อง `git pull` ทุกครั้ง** — เพราะ repo นี้เป็นของคุณคนเดียว ไม่มีใครมา push ชน
> (จะต้อง pull ก็ต่อเมื่อมีคนอื่นทำงานใน repo เดียวกับคุณ หรือคุณแก้จากหลายเครื่อง)
>
> 💡 **ถ้าขึ้น error `no upstream branch`** (มักเจอครั้งแรกของ branch ใหม่)
> ใช้ `git push -u origin main` **ครั้งเดียว** จากนั้นพิมพ์ `git push` เฉย ๆ ได้เลย
> (commit ที่ค้างไม่หาย — แค่ยังไม่ถูกส่งขึ้น)
>
> 💡 **ถ้าขึ้น error `rejected` / `non-fast-forward`**
> มีคนอื่น (หรือตัวคุณจากอีกเครื่อง) push ก่อน — สั่ง `git pull` แล้วค่อย `git push` ใหม่

### 6.1 ถ้า `origin` ยังชี้ต้นแบบอยู่ (วิธีแก้)

เกิดจากโคลนแล้วข้ามข้อ ② ของ B4 เช็กก่อนว่าพลาดจริงไหม:
```powershell
git remote -v
```
ถ้าบรรทัด `origin` ขึ้น `astro-prototype` หรือ `astro-full-schema` = **อย่าเพิ่ง push**

เปลี่ยนปลายทางให้ชี้ repo ของคุณ:
```powershell
git remote rename origin upstream
git remote add origin git@gitlab.com:tardev-group/astro-<ชื่อคุณ>.git
git remote set-url --push upstream DISABLED
git remote -v
git push -u origin main
```

> ถ้า **เผลอ push ขึ้นต้นแบบไปแล้ว** → แจ้งแอดมินทันที **อย่า push ซ้ำ** แอดมินจะย้อนคืนให้

---

### 6.2 คู่มือ Git เท่าที่ต้องใช้จริงกับโปรเจกต์นี้

> อ่านครั้งเดียว แล้วกลับมาเปิดดูตอนติดปัญหา — ทั้งหมดนี้คือคำสั่งที่งานรีแบรนด์ใช้จริง
> ไม่ใช่ทฤษฎี Git

#### ① ดูก่อนทำ — คำสั่งที่ควรพิมพ์บ่อยที่สุด

```powershell
git status -sb          # ⭐ แก้อะไรค้าง + ยืนอยู่สาขาไหน + push ไปไหน (ครบในคำสั่งเดียว)
git diff                # แก้อะไรไปบ้าง (กด q เพื่อออก)
git log --oneline -5    # 5 งานล่าสุดที่บันทึกไว้
```

**`git status -sb` ก่อน `git add .` ทุกครั้ง** เพราะ `git add .` หยิบไฟล์ที่แก้ **ทั้งหมด**
รวมของที่คุณไม่ได้ตั้งใจแก้ด้วย

**บรรทัดแรกของ `git status -sb` ตอบคำถาม "push แล้วจะไปเข้าที่ไหน":**

```
## test-uploader-v2...origin/test-uploader-v2
   └─ สาขาในเครื่อง      └─ ปลายทางบน GitLab
```

ถ้าขึ้นแค่ `## ชื่อสาขา` เฉย ๆ **ไม่มีส่วนหลัง `...`** แปลว่าสาขานี้ยังไม่เคยส่งขึ้น GitLab

#### ①.1 "อยู่สาขาไหน" กับ "push ไป repo ไหน" คนละเรื่องกัน

จุดนี้สับสนกันบ่อย — **`git remote -v` ไม่ได้บอกสาขา** มันบอกแค่ว่า repo ปลายทางคืออันไหน

| อยากรู้ว่า | ใช้คำสั่ง |
|---|---|
| ยืนอยู่**สาขา**ไหน | `git branch --show-current` |
| push ไปเข้า**สาขา**ไหน | `git status -sb` (ดูบรรทัดแรก) |
| push ไปเข้า **repo** ไหน | `git remote -v` |
| ดูทุกสาขาพร้อมปลายทางทีเดียว | `git branch -vv` |

`git branch -vv` — สาขาที่มี `*` ข้างหน้าคือตัวที่ยืนอยู่ ในวงเล็บเหลี่ยมคือปลายทาง:

```
* test-uploader-v2  faa9a8b [origin/test-uploader-v2] Park preset pages...
  main              656e4c2 [origin/main] ProviderGrid: link...
```

> 💡 **สาขาใหม่ที่ยังไม่เคย push** ปกติ Git จะขึ้น error `no upstream branch` ให้พิมพ์
> `git push -u origin <ชื่อสาขา>` เองครั้งแรก — **แต่ถ้าตั้ง `push.autoSetupRemote true`
> ไว้ตามข้อ 2.3 แล้ว `git push` เฉย ๆ จะสร้างสาขาบน GitLab ให้อัตโนมัติ** ไม่ต้องพิมพ์ยาว

#### ② Branch — ทำไมต้องแยก และแยกยังไง

Branch คือ **สายงานคู่ขนาน** แก้บนสายหนึ่งไม่กระทบอีกสาย ใช้เพื่อ **ไม่ให้งานทดลองไปทับงานที่ใช้จริง**

```powershell
git branch --show-current           # ตอนนี้ยืนอยู่สายไหน
git switch -c rebrand-ชื่อแบรนด์      # แตกสายใหม่จากจุดที่ยืนอยู่ แล้วย้ายไปเลย
git switch main                     # ย้ายกลับ
git branch                          # ดูสายทั้งหมดในเครื่อง
```

**ควรแตก branch ใหม่ทุกครั้งก่อนเริ่มรีแบรนด์** ถ้าผลออกมาไม่ชอบก็ทิ้งทั้งสายได้ ของเดิมไม่กระทบ

> ⚠️ **กับดักที่เจ็บที่สุด: อย่าสลับ branch ตอนมีไฟล์ค้างที่ยังไม่ commit**
> โดยเฉพาะ**หลังอัปโหลดไฟล์แบรนด์ผ่าน uploader แต่ยังไม่ได้ commit** — ถ้าไฟล์ที่ค้าง
> ไม่ชนกับ branch ปลายทาง Git จะ **ลากตามไปด้วย** งานไปโผล่ผิดสายโดยไม่มีใครเตือน
> **เช็ก `git status` ให้ว่าง (หรือ commit ก่อน) แล้วค่อยสลับเสมอ**

#### ③ ทิ้งงาน / ย้อนกลับ

```powershell
git restore src/pages/index.astro   # ทิ้งการแก้เฉพาะไฟล์นี้
git restore .                       # ทิ้งการแก้ทั้งหมด กลับไปเป็นตอน commit ล่าสุด
```

ใช้ตอน **รีแบรนด์พังกลางคัน** หรือ **กดหยุด rebrand แล้วไฟล์ค้างครึ่งทาง**

> 🚨 **`git restore` ลบงานทิ้งถาวร กู้ไม่ได้**
> ต่างจาก commit ที่ต่อให้ลบ branch ทิ้งก็ยังตามกลับมาได้ — แต่ไฟล์ที่ **ยังไม่เคย commit**
> พอโดน restore ทับแล้ว **หายเลย ไม่มีที่ไหนเก็บไว้**
> **`git status` และ `git diff` ก่อนทุกครั้ง**

**นิสัยที่ปลอดภัยกว่า** ถ้าไม่แน่ใจว่าจะทิ้งดีไหม — เก็บไว้ก่อนบนสายชั่วคราว เสียแค่ commit ขยะ 1 อัน แต่ได้ทางกลับ:

```powershell
git switch -c เก็บไว้ก่อน
git add . ; git commit -m "เผื่อได้ใช้"
git switch -                          # กลับสายเดิม
```

#### ④ ดึงของเก่ากลับมา

ทุกแบรนด์ที่เคย commit ไว้ **ยังอยู่ครบในประวัติ** ถึงไฟล์ปัจจุบันจะถูกแบรนด์ใหม่ทับไปแล้ว

```powershell
git log --oneline -20                              # หา commit ของแบรนด์ที่ต้องการ
git restore --source=<รหัส commit> src/pages/index.astro   # ดึงกลับมาเฉพาะไฟล์
git restore --source=<รหัส commit> .                       # ดึงกลับมาทั้งชุด
```

ตัวอย่าง: อยากได้หน้าแรกของแบรนด์เก่ากลับมาดู → หา commit ของแบรนด์นั้นใน `git log`
แล้วเอา 7 ตัวอักษรแรกมาใส่

#### ⑤ เช็กก่อน push ว่าจะไปเข้า repo ไหน

```powershell
git remote -v
```

ต้องขึ้นชื่อ repo **ของคุณ** — ถ้าขึ้น `astro-full-schema` (ต้นแบบของแอดมิน) **อย่า push** ให้ทำข้อ 6.1 ก่อน

#### ⑥ ปัญหาที่เจอบ่อย

| อาการ | แปลว่า | ทำยังไง |
|---|---|---|
| `git status` ขึ้นไฟล์ modified แต่ `git diff` ว่างเปล่า | เป็นเรื่อง **ขึ้นบรรทัดใหม่ (LF/CRLF)** ล้วน ๆ เนื้อหาไม่ได้เปลี่ยน | ไม่ต้อง commit ก็ได้ ล้างด้วย `git restore <ไฟล์>` |
| `no upstream branch` | สายใหม่ที่ยังไม่เคยส่งขึ้น GitLab | `git push -u origin <ชื่อ branch>` **ครั้งเดียว** ต่อไป `git push` เฉย ๆ |
| `rejected` / `non-fast-forward` | มีคน (หรือคุณจากอีกเครื่อง) push ก่อน | `git pull` แล้วค่อย `git push` ใหม่ |
| commit แล้วแต่ GitLab ไม่อัปเดต | ยังไม่ได้ push — commit อยู่แค่ในเครื่อง | `git push` |
| ไม่รู้ว่ายืนอยู่สายไหน | — | `git branch --show-current` |

#### ⑦ ห้ามทำ

1. **ห้าม `git push --force`** — ทับประวัติของคนอื่นแบบกู้ยาก ถ้าติดปัญหาจน push ไม่ได้ ให้ถาม dev
2. **ห้าม commit/สลับ branch ตอน rebrand กำลังรันอยู่** — Claude กำลังเขียนไฟล์อยู่ จะได้งานครึ่ง ๆ กลาง ๆ รอให้ขึ้น "เสร็จแล้ว" ก่อน
3. **ห้าม `git restore .` โดยไม่ดู `git status` ก่อน** — ดูข้อ ③
4. **ห้าม push งานแบรนด์เข้า repo ต้นแบบ** — ดูข้อ ⑤ และกฎเหล็กข้อ 3

> 💡 `git checkout` ทำได้ทุกอย่างข้างบนเหมือนกัน แต่คำสั่งเดียวทำหลายหน้าที่จนสับสนง่าย
> Git รุ่นใหม่เลยแยกเป็น **`git switch`** (สลับ/สร้าง branch) กับ **`git restore`** (ทิ้ง/ดึงไฟล์)
> ใช้สองตัวใหม่นี้จะปลอดภัยกว่า ถ้าเจอคำสั่งเก่าในเน็ตก็เทียบได้ตามตารางนี้:
> `git checkout <branch>` = `git switch <branch>` ·
> `git checkout -b <ชื่อ>` = `git switch -c <ชื่อ>` ·
> `git checkout -- <ไฟล์>` = `git restore <ไฟล์>`

## 7. เอาเว็บขึ้นจริง (Deploy)

> ☁️ **กำลังย้ายไป Cloudflare** — แบรนด์ใหม่ให้ใช้ [`DEPLOY-CLOUDFLARE.md`](DEPLOY-CLOUDFLARE.md)
> แทนหัวข้อนี้ (ไม่ต้องใช้ password ของ server, ไม่ต้องรอ purge cache)
> หัวข้อ 7 ข้างล่างนี้คือวิธีเดิมบน VPS ที่แบรนด์เก่ายังใช้อยู่ — **ยังห้ามปิด VPS**

เมื่องานพร้อมขึ้น production ใช้คำสั่งเดียว (ใส่โดเมนของแบรนด์นั้น):

```powershell
.\deploy.ps1 -Domain takdee999-guide.com
```

สคริปต์จะทำให้อัตโนมัติ: **build → บีบอัด → ยิงขึ้น server → ล้าง cache**
พอขึ้น `DEPLOYMENT COMPLETE!` = เว็บออนไลน์แล้ว

> 🔑 **ทุกคน deploy เองได้** ระหว่างทางสคริปต์จะถาม **password ของ server**
> (ขอ password จากทีม/แอดมิน) พิมพ์ password แล้วกด Enter เพื่อไปต่อ — จะถูก
> ถามทุกครั้งที่ deploy ถือเป็นเรื่องปกติ
>
> ⚠️ **ระวังพิมพ์ชื่อโดเมนให้ถูก** — ใส่โดเมนของแบรนด์ที่กำลังทำเท่านั้น
> ถ้าใส่ผิด จะไปทับเว็บของอีกแบรนด์บน server ดูให้ชัวร์ก่อนกด Enter

### 7.1 ตั้ง Cloudflare Cache Rule (ครั้งเดียวต่อโดเมน — แล้วไม่ต้อง purge อีก)

ปกติเวลา deploy เสร็จ เนื้อหาใหม่มักไม่ขึ้นทันทีเพราะ **Cloudflare cache หน้าเก่าไว้** —
`deploy.ps1` เลยยิง purge cache ให้ทุกครั้ง แต่ถ้าตั้ง **Cache Rule** ครั้งเดียว
เว็บใหม่จะขึ้นเองภายใน ~2 นาที **โดยไม่ต้อง purge** และ **PageSpeed ดีขึ้น**
(asset ที่มี hash จะถูก cache ยาว ผ่าน audit "efficient cache policy")

> ℹ️ **restart nginx ไม่ช่วย** — cache อยู่ที่ Cloudflare ไม่ใช่ที่ server;
> restart nginx ไม่แตะ cache ของ CF เลย ต้องตั้งที่ Cloudflare เท่านั้น

เข้า **dashboard.cloudflare.com → เลือกโดเมน → Caching → Cache Rules → Create rule**

**Rule 1 — asset ที่มี hash (cache ยาว)** — ลากให้อยู่ **บนสุด**
| ช่อง | ค่า |
|---|---|
| Rule name | `Cache hashed assets` |
| When incoming requests match | **URI Path** · **starts with** · `/_astro/` |
| Cache eligibility | **Eligible for cache** |
| Edge TTL | Override origin → **1 year** |
| Browser TTL | Override origin → **1 year** |

**Rule 2 — HTML / หน้าเพจ (cache สั้น ให้ fresh)**
| ช่อง | ค่า |
|---|---|
| Rule name | `HTML short TTL` |
| When incoming requests match | **URI Path** · **does not start with** · `/_astro/` |
| Cache eligibility | **Eligible for cache** |
| Edge TTL | Override origin → **2 minutes** |
| Browser TTL | Override origin → **Respect origin** |

> ⚠️ ถ้ามี **Page Rule เก่าแบบ "Cache Everything"** (เมนู Rules → Page Rules) ให้ลบทิ้ง
> — มันคือตัวที่ทำให้ HTML ถูก cache จนต้อง purge ทุกครั้ง Cache Rules ใหม่ทำหน้าที่แทนแล้ว

หลังตั้งเสร็จ: deploy → ผู้ใช้เห็นเว็บใหม่เองใน ~2 นาที ไม่ต้อง purge / ไม่ต้อง restart nginx

---

## 8. เจอปัญหาบ่อย ๆ (Troubleshooting)

| อาการ | วิธีแก้ |
|---|---|
| `git ... is not recognized` (PowerShell) | ปิด-เปิด PowerShell ใหม่ หรือใช้ **Git Bash** แทน (ดูข้อ 1) |
| `git clone` แล้วขึ้น `Permission denied (publickey)` | ยังไม่ได้เพิ่ม SSH key เข้า GitLab (ข้อ 2.4) หรือแอดมินยังไม่เชิญเข้ากลุ่ม (ข้อ 2.2) |
| `git clone` แล้วขึ้น repository not found / 404 | ยังไม่ได้ถูกเชิญเข้ากลุ่ม `tardev-group` — แจ้งแอดมิน (ข้อ 2.2) |
| `git push` ขึ้น `no upstream branch` | ใช้ `git push -u origin main` ครั้งเดียว (ดูข้อ 6) |
| `git push` ขึ้น `rejected` / `non-fast-forward` | มีคน push ก่อน — สั่ง `git pull` แล้วค่อย `git push` ใหม่ |
| commit แล้วแต่ GitLab ไม่อัปเดต | ยังไม่ได้ `git push` — commit อยู่แค่ในเครื่อง สั่ง push เพิ่ม |
| `npm run dev` เปิดไม่ขึ้น / error | ปิดหน้าต่างเดิมก่อน แล้วรันใหม่ ถ้ายังไม่หาย รัน `npm install` อีกครั้ง |
| build ไม่ผ่าน (`deploy` หยุดกลางคัน) | โค้ดมีปัญหา — บอก Claude ว่า `build ไม่ผ่าน ช่วยดูให้หน่อย` |
| รูปไม่ขึ้น / รูปเป็นของแบรนด์เก่า | อัปโหลดรูปใหม่ผ่าน `npm run rebrand:upload` (ข้อ 5.2) แล้วบอก Claude ให้ตรวจรูปซ้ำ |
| deploy แล้วเว็บไม่อัปเดต (เห็นของเก่า) | Cloudflare cache หน้าเก่าไว้ — purge cache ที่ CF หรือตั้ง Cache Rule ครั้งเดียว (ข้อ 7.1); **restart nginx ไม่ช่วย** |
| ไม่แน่ใจว่า push ไปเข้า repo ไหน | รัน `git remote -v` — ต้องขึ้นชื่อ repo **ของคุณ** ถ้ายังเป็น `astro-full-schema` ให้ทำข้อ 6.1 |
| เผลอ push เข้า repo ต้นแบบของแอดมิน | แจ้งแอดมินทันที **อย่า push ซ้ำ** แล้วทำข้อ 6.1 ให้ถูกก่อนบันทึกงานต่อ |

ปัญหาที่แก้เองไม่ได้ → ถาม Claude Code เป็นภาษาไทยตรง ๆ หรือแจ้งทีม dev

---

## 9. กฎเหล็ก (ห้ามทำ)

1. **ห้ามลบ component ที่ไม่ได้ใช้ใน `src/components/`** — พวก `NavbarStyle*`,
   `ContentBox*`, `Footer*` เวอร์ชันที่ดูเหมือนไม่ได้ใช้ คือ "คลัง" ไว้ทำแบรนด์
   หน้า ไม่ใช่ขยะ
2. **ห้ามเดา URL/โดเมนเอง** — ใส่เฉพาะ URL จริงที่ได้รับมาเท่านั้น
3. **ห้าม push งานแบรนด์ตัวเองเข้าต้นแบบ** (`astro-prototype` / `astro-full-schema`) —
   ทุกคนมี repo ของตัวเองที่หัวหน้าสร้างให้ เช็ก `git remote -v` ก่อน push ครั้งแรกทุกครั้ง
   ว่า `origin` เป็นชื่อ repo คุณ และ `upstream` ฝั่ง push เป็น `DISABLED`
4. **ยืนยันงานเสร็จ = build ผ่าน + เปิดดูหน้าเว็บจริงด้วยตา** เสมอ ไม่ใช่แค่
   Claude บอกว่าเสร็จ

---

## คำสั่งที่ใช้บ่อย (สรุป)

```powershell
# ตั้งค่าครั้งเดียวต่อเครื่อง — ขั้นตอนเต็มอยู่ที่ SETUP-REBRAND-SYSTEM.md ภาค B
git config --global user.name "ชื่อ"
git config --global user.email "อีเมล"
ssh-keygen -t ed25519 -C "อีเมล"     # สร้าง SSH key แล้วเพิ่มใน GitLab

# เอาโค้ดลงเครื่อง (แทน astro-tuch ด้วยชื่อ repo ที่หัวหน้าสร้างให้)
git clone git@gitlab.com:tardev-group/astro-prototype.git astro-tuch
cd astro-tuch
git remote rename origin upstream
git remote add origin git@gitlab.com:tardev-group/astro-tuch.git
git remote set-url --push upstream DISABLED
git push -u origin main
git remote -v                   # origin = ของคุณ · upstream push = DISABLED

# ทำงานประจำวัน
npm install                     # ติดตั้ง (ครั้งแรกครั้งเดียว)
npm run dev                     # เปิดดูเว็บที่ localhost:8888
npm run rebrand:upload          # อัปโหลดรูปแบรนด์ที่ localhost:4444
npm run build                   # build ตรวจว่าโค้ดสมบูรณ์
git add . ; git commit -m "..." ; git push   # บันทึกขึ้น GitLab
.\deploy.ps1 -Domain <โดเมน>    # เอาเว็บขึ้นจริง
```

รายละเอียดเชิงลึกสำหรับ dev อยู่ใน `CLAUDE.md` และ
`.claude/skills/rebrand-site/SKILL.md`
