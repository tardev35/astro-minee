# ตั้งต้นเครื่องใหม่ (Setup) — สำหรับทีมที่ใช้ Rebrand Uploader

> ⚠️ **ไฟล์นี้เป็นรุ่นก่อนหน้า — ตั้งเครื่องใหม่ให้ใช้ [`SETUP-REBRAND-SYSTEM.md`](SETUP-REBRAND-SYSTEM.md)**
>
> ไฟล์นี้ชี้ไป branch `uploader-phase2-fire-rebrand` + repo `astro-bas` ซึ่งยัง**ไม่มี**
> ส่วน Cloudflare (ปุ่มขึ้นเว็บจริง, ปุ่มสลับบัญชี, `wrangler login`), ปุ่มทดสอบหน้าเว็บ,
> สวิตช์หน้าเสริม และการหมุนฟอนต์ — รวม 36 commit ที่ตามมาทีหลัง
>
> เก็บไว้เพราะยังมีเครื่องที่ตั้งตามไฟล์นี้อยู่ **ไม่ใช่เพราะมันยังเป็นวิธีที่ถูก**

คู่มือนี้พาตั้งค่า **เครื่องเปล่า 1 เครื่อง** ตั้งแต่ยังไม่มีอะไรเลย จนถึงกด "เริ่ม Rebrand"
ในหน้าเว็บได้จริง และ push งานขึ้น GitLab ของทีมได้

> 📌 คู่มือนี้ต่างจาก [`README.md`](README.md) ตรงที่:
> `README.md` = คู่มืองาน**รีแบรนด์รายแบรนด์** (Fork 1 repo ต่อ 1 แบรนด์)
> ไฟล์นี้ = คู่มือ**ตั้งเครื่อง + ตั้ง repo ของทีม** สำหรับใช้ตัว uploader ที่ยิง Claude ได้เอง
> ถ้ายังไม่มีบัญชี GitLab / ยังไม่เคยตั้ง SSH key ให้ทำ [README หัวข้อ 2](README.md#2-สมัคร-gitlab--ขอเข้าทีม-ทำครั้งเดียว) ก่อน แล้วค่อยกลับมาที่ข้อ 3 ของไฟล์นี้

**ปลายทางที่จะได้:**

| ของ | ค่า |
|---|---|
| โค้ดต้นทาง | `gitlab.com/tardev-group/astro-full-schema` branch `uploader-phase2-fire-rebrand` |
| repo ที่ทีม push ขึ้น | `gitlab.com/tardev-group/astro-bas` (remote ชื่อ `origin`) |
| branch ที่ทำงาน | `uploader-phase2-fire-rebrand` |
| หน้าเว็บ dev | http://localhost:8888 |
| หน้า uploader | http://localhost:4444 |

---

## 1. ติดตั้ง Node.js + Git

1. **Node.js** — https://nodejs.org เลือกตัว **LTS** แล้วกด Next รวด
2. **Git** — https://git-scm.com/download/win กด Next รวดตาม default

เช็ก (เปิด **PowerShell** ใหม่):
```powershell
node --version
git --version
```
ขึ้นเลขเวอร์ชันทั้งคู่ = ผ่าน

> 💡 ถ้าขึ้น `is not recognized` ทั้งที่ลงแล้ว → **ปิด-เปิดหน้าต่างใหม่** (PATH เพิ่งอัปเดต)

---

## 2. ติดตั้ง Claude Code CLI ⭐ (ข้อที่ขาดไม่ได้)

ปุ่ม **"เริ่ม Rebrand"** ในหน้า uploader คือการที่โปรแกรมไปเรียกคำสั่ง `claude` บนเครื่องนี้
**ถ้าเครื่องไม่มี CLI หรือยังไม่ได้ login ปุ่มนี้จะใช้ไม่ได้**

### 2.1 ติดตั้ง

เปิด **Command Prompt (cmd.exe)** — ⚠️ **ไม่ใช่ PowerShell** — แล้ววาง:

```cmd
curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd
```

> ⚠️ ถ้าวางใน PowerShell จะขึ้น error ทันที เพราะ PowerShell รุ่นที่มากับ Windows
> ไม่รู้จักเครื่องหมาย `&&` — ต้องรันใน **cmd.exe** เท่านั้น
> (กด `Win + R` → พิมพ์ `cmd` → Enter)

ตัวติดตั้งจะวางไฟล์ไว้ที่ `%USERPROFILE%\.local\bin\claude.exe` และเพิ่มเข้า PATH ให้เอง

### 2.2 เช็กว่า PATH ติด

**ปิดหน้าต่างเดิมทิ้ง เปิดใหม่** แล้วพิมพ์:
```powershell
claude --version
```
ขึ้นเลขเวอร์ชัน (เช่น `2.1.220 (Claude Code)`) = ผ่าน

### 2.3 login ให้เรียบร้อย ⭐ ข้อที่คนลืมบ่อยที่สุด

ติดตั้งเสร็จยัง **ใช้ไม่ได้ทันที** ต้องเข้าสู่ระบบก่อน 1 ครั้ง — พิมพ์:
```powershell
claude
```
ทำตามขั้นตอน login ที่ขึ้นมาจนเข้าโปรแกรมได้ แล้วพิมพ์ `/exit` ออก

> ทำไมต้องทำ: ปุ่มในหน้าเว็บรัน Claude แบบ **ไม่มีหน้าจอ (headless)** ถ้ายังไม่ login
> มันจะตายทันทีตั้งแต่วินาทีแรกเพราะไม่มีใครตอบหน้า login ให้

> 💰 **เรื่องค่าใช้จ่าย: หัวหน้ารับผิดชอบเอง** — ทีมงานกดใช้ได้ตามงาน ไม่ต้องกังวล
> (ค่าใช้จ่ายลงที่บัญชีที่ login บนเครื่องนั้น ใช้บัญชีที่หัวหน้าจัดให้)

---

## 3. ตั้งชื่อ-อีเมลให้ Git + SSH key

ถ้าเครื่องนี้ยังไม่เคยตั้ง (ทำครั้งเดียวต่อเครื่อง):

```powershell
git config --global user.name "ชื่อ ของคุณ"
git config --global user.email "อีเมลที่สมัคร GitLab"
git config --global push.autoSetupRemote true
```

สร้าง SSH key แล้วเอาไปใส่ใน GitLab (ละเอียดอยู่ใน [README ข้อ 2.4](README.md)):
```bash
ssh-keygen -t ed25519 -C "อีเมลที่สมัคร GitLab"   # กด Enter รวด 3 ครั้ง
cat ~/.ssh/id_ed25519.pub                          # ก๊อปทั้งบรรทัด
```
เอาไปวางที่ https://gitlab.com/-/user_settings/ssh_keys → **Add key**

ทดสอบ:
```bash
ssh -T git@gitlab.com
```
ขึ้น `Welcome to GitLab, @ชื่อคุณ!` = ผ่าน

> ต้องถูกเชิญเข้ากลุ่ม `tardev-group` ก่อน ไม่งั้นข้อ 4 จะขึ้น 404 — แจ้งแอดมิน

---

## 4. โคลนโค้ดลงเครื่อง (เอาเฉพาะ branch ที่ใช้)

```bash
git clone --branch uploader-phase2-fire-rebrand git@gitlab.com:tardev-group/astro-full-schema.git astro-bas
cd astro-bas
```

เช็กว่าอยู่ถูก branch:
```bash
git branch --show-current
```
ต้องขึ้น `uploader-phase2-fire-rebrand`

---

## 5. ติดตั้ง dependencies

```powershell
npm install
```

ใช้เวลา 1–2 นาที (ตัว `sharp` ที่ใช้ย่อรูปต้อง build) รอจนขึ้นบรรทัดว่างกลับมา

---

## 6. เปลี่ยน remote ให้ชี้ repo ของทีม ⭐

ตอนนี้ `origin` ยังชี้ไปที่ **repo ต้นแบบของแอดมิน** ถ้า push ตอนนี้จะไปทับต้นแบบ
ต้องเปลี่ยนก่อน:

```bash
# 1) เก็บต้นแบบไว้เป็น upstream (ไว้ดึงของใหม่มาทีหลัง — ไม่ push เข้าอันนี้)
git remote rename origin upstream

# 2) ตั้ง origin ใหม่ = repo ของทีม
git remote add origin git@gitlab.com:tardev-group/astro-bas.git

# 3) เช็กให้ชัวร์
git remote -v
```

ต้องได้หน้าตาแบบนี้:
```
origin    git@gitlab.com:tardev-group/astro-bas.git (fetch)
origin    git@gitlab.com:tardev-group/astro-bas.git (push)
upstream  git@gitlab.com:tardev-group/astro-full-schema.git (fetch)
upstream  git@gitlab.com:tardev-group/astro-full-schema.git (push)
```

> 🚨 **`git push` = ขึ้น `origin` = `astro-bas` เสมอ** ส่วน `upstream` มีไว้ **ดึงอย่างเดียว ห้าม push**
> ถ้า `git remote -v` ยังขึ้น `astro-full-schema` ตรงบรรทัด `origin` **อย่าเพิ่ง push** — ทำข้อ 6 ใหม่

---

## 7. push ขึ้น branch ของทีม

```bash
git push -u origin uploader-phase2-fire-rebrand
```

> ℹ️ ตอนนี้ **`astro-bas` ยังเป็น repo เปล่า** (ยังไม่มี branch ไหนเลย) —
> คนแรกที่ push คือคนที่สร้าง branch แรกให้มัน ถ้าคุณคือคนแรก หลัง push เสร็จ
> ให้ไปตั้ง default branch ที่
> **Settings → Repository → Branch defaults** เป็น `uploader-phase2-fire-rebrand`
> คนถัดไปจะได้ clone มาแล้วอยู่ถูก branch ทันที
>
> ถ้ามีคน push ไปก่อนแล้ว คุณ **ไม่ต้อง** ทำข้อนี้ — แค่ `git pull` ก่อนเริ่มงานทุกครั้ง

---

## 8. ทดสอบว่าเครื่องพร้อมจริง (สำคัญ — อย่าข้าม)

### 8.1 เว็บขึ้นไหม
```powershell
npm run dev
```
เปิด http://localhost:8888 เห็นหน้าเว็บ = ผ่าน แล้วกด `Ctrl + C` ปิด

### 8.2 uploader + Claude ต่อกันได้ไหม
ดับเบิลคลิกไฟล์ **`tools\rebrand-uploader\start-uploader.cmd`**
(หรือพิมพ์ `npm run rebrand:upload` ก็ได้) → เบราว์เซอร์จะเปิด http://localhost:4444

เลื่อนลงไป **ส่วนที่ 6** แล้วกดปุ่ม **🧪 ทดสอบท่อ**

| ผลที่เห็น | แปลว่า |
|---|---|
| ขึ้นข้อความ `ท่อ uploader ทำงานปกติ` ใน log ภายใน ~10 วินาที | ✅ **พร้อมใช้งานจริงครบทุกข้อ** |
| ขึ้นแดงว่า `ไม่พบคำสั่ง claude` | ยังไม่ได้ลง CLI หรือ PATH ไม่ติด → ข้อ 2.1 / 2.2 |
| ค้าง หรือขึ้นแดงเรื่อง login / auth | ยังไม่ได้ login → ข้อ 2.3 |

ปุ่มนี้ใช้เวลาไม่กี่วินาที **ไม่แตะไฟล์ใดๆ** ใช้ทดสอบซ้ำได้ตลอด

---

## 9. งานประจำวันหลังจากนี้

```bash
git pull                              # ดึงงานล่าสุดของทีมก่อนเริ่มเสมอ
# ...ทำงาน / รีแบรนด์...
git add .
git commit -m "อธิบายสั้นๆ ว่าทำอะไร"
git push                              # ขึ้น astro-bas branch uploader-phase2-fire-rebrand
```

**ขั้นตอนรีแบรนด์ผ่านหน้าเว็บ:**
0. **ปิด `npm run dev` ก่อน** ถ้าเคยเปิดหน้า localhost:8888 ดูรอบนี้ — dev server
   จับไฟล์รูปใน `src/assets` ค้างไว้ ทำให้อัปโหลดทับไม่ได้ (กด Ctrl+C ในหน้าต่างนั้น)
1. **แตก branch ใหม่ก่อนเริ่ม** → `git switch -c rebrand-ชื่อแบรนด์`
   (ถ้าผลไม่ถูกใจ ทิ้งทั้ง branch ได้ ของเดิมไม่กระทบ)
2. เปิด uploader (`start-uploader.cmd`) → อัปโหลด logo / docx / banner / slide ให้ครบ
3. กด **"⬆ อัพโหลดทั้งหมด"** รอจน popup ขึ้นเขียวแล้วปิดตัวเอง
4. กรอกชื่อแบรนด์ (+ URL จริงถ้ามี) → กด **▶ เริ่ม Rebrand**
5. รอจนขึ้น "เสร็จแล้ว" → กด **🔍 ทดสอบหน้าเว็บ** ในส่วนที่ 7 แล้วไล่เช็กลิสต์ 5 ข้อ
6. พอใจแล้วค่อย `git add . ; git commit -m "..." ; git push`
   แล้วค่อย deploy — ดู [`DEPLOY-CLOUDFLARE.md`](DEPLOY-CLOUDFLARE.md) (วิธีใหม่ ไม่ต้องใช้
   password ของ server) หรือ `.\deploy.ps1 -Domain <โดเมน>` สำหรับแบรนด์เก่าที่ยังอยู่บน VPS

> ⚠️ **ห้ามปิดหน้าต่างดำ (cmd) ระหว่างที่ rebrand กำลังรัน** — ปิดแล้วงานตายกลางคัน
> ไฟล์จะค้างครึ่งทาง ปิด/refresh **แท็บเบราว์เซอร์** ได้ตามสบาย log ต่อกลับมาเอง
>
> ⚠️ **ห้าม commit หรือสลับ branch ตอน rebrand กำลังรัน** — Claude กำลังเขียนไฟล์อยู่
> จะได้งานครึ่ง ๆ กลาง ๆ รอให้ขึ้น "เสร็จแล้ว" ก่อนเสมอ
>
> ⚠️ ระบบ **ไม่ deploy ให้อัตโนมัติ** โดยตั้งใจ — มันหยุดที่ตรวจงานเสมอ deploy เป็นคนกดเอง

### 9.1 Git ที่ต้องระวังเป็นพิเศษกับ repo ของทีม

คู่มือ Git ฉบับเต็ม (branch / ทิ้งงาน / ดึงของเก่ากลับ / ปัญหาที่เจอบ่อย) อยู่ใน
**[README ข้อ 6.2](README.md#62-คู่มือ-git-เท่าที่ต้องใช้จริงกับโปรเจกต์นี้)** — อ่านรอบเดียวพอ
ตรงนี้เก็บเฉพาะเรื่องที่ **ต่างจากคู่มือนั้น เพราะ repo ทีมมี 2 remote**

**เช็กปลายทางก่อน push ทุกครั้ง — ต้องเช็ก 2 อย่าง ไม่ใช่อย่างเดียว**

เครื่องทีมมี 2 remote การรู้แค่ "repo ไหน" หรือแค่ "สาขาไหน" อย่างเดียวไม่พอ

```bash
git remote -v      # ① ไป repo ไหน
git status -sb     # ② ไปสาขาไหน (ดูบรรทัดแรก)
```

① ต้องได้แบบนี้:
- `origin` = **`astro-bas`** ← ที่ทีม push ขึ้น
- `upstream` = **`astro-full-schema`** ← ต้นแบบ **ดึงอย่างเดียว ห้าม push**

② บรรทัดแรกอ่านแบบนี้:
```
## uploader-phase2-fire-rebrand...origin/uploader-phase2-fire-rebrand
   └─ สาขาในเครื่อง                  └─ ปลายทาง — ต้องขึ้นต้นด้วย origin/
```

**ถ้าปลายทางขึ้นต้นด้วย `upstream/` แปลว่าผูกผิด** — แก้ด้วย:
```bash
git branch --set-upstream-to=origin/<ชื่อสาขา>
```

> 💡 ดูทุกสาขาพร้อมปลายทางทีเดียวด้วย `git branch -vv` — ตัวที่มี `*` คือสาขาที่ยืนอยู่
> ในวงเล็บเหลี่ยมคือปลายทาง ควรเป็น `[origin/...]` ทุกตัว

**ดึงของใหม่จากต้นแบบมาใส่งานทีม** (เช่นแอดมินแก้ skill หรือ uploader):
```bash
git fetch upstream
git merge upstream/uploader-phase2-fire-rebrand
```

> 🚨 **`git push` เฉย ๆ ไปเข้า `origin` เสมอ** ถ้าเผลอพิมพ์ `git push upstream` จะไปทับ
> ต้นแบบของแอดมิน — เจอแบบนั้นแจ้งแอดมินทันที **อย่า push ซ้ำ**

---

## 10. ปัญหาบ่อย

| อาการ | วิธีแก้ |
|---|---|
| `claude` is not recognized | ปิด-เปิดหน้าต่างใหม่ ถ้ายังไม่หายให้ตั้งพาธตรงๆ ก่อนเปิด uploader:<br>`set CLAUDE_BIN=C:\Users\<ชื่อ>\.local\bin\claude.exe` |
| คำสั่งติดตั้ง Claude ขึ้น error ที่เครื่องหมาย `&&` | รันผิดโปรแกรม — ต้องรันใน **cmd.exe** ไม่ใช่ PowerShell (ข้อ 2.1) |
| ปุ่ม "เริ่ม Rebrand" กดไม่ได้ (จาง) | ยังไม่ได้กรอกชื่อแบรนด์ หรือกรอกอักขระที่ไม่รับ (ใช้ได้แค่ A-Z 0-9 ไทย เว้นวรรค `.` `_` `-`) — ดูข้อความใต้ช่องคำสั่ง |
| กดทดสอบท่อแล้วเงียบ/แดง | ยังไม่ได้ `claude` login (ข้อ 2.3) |
| `git push` ขึ้น `rejected` / `non-fast-forward` | มีคนในทีม push ก่อน → `git pull` แล้ว `git push` ใหม่ |
| `git push` แล้วสงสัยว่าไปเข้า repo ไหน | `git remote -v` — บรรทัด `origin` ต้องเป็น **`astro-bas`** ถ้าเป็น `astro-full-schema` ให้ทำข้อ 6 ใหม่ |
| clone แล้วขึ้น 404 / `repository not found` | ยังไม่ถูกเชิญเข้ากลุ่ม `tardev-group` → แจ้งแอดมิน |
| clone แล้วขึ้น `Permission denied (publickey)` | ยังไม่ได้ใส่ SSH key ใน GitLab (ข้อ 3) |
| `npm install` ล้ม ตอน build `sharp` | ลง Node.js เวอร์ชัน **LTS** (ไม่ใช่ตัว Current) แล้วลบโฟลเดอร์ `node_modules` ทิ้งแล้วรันใหม่ |
| เปิด localhost:4444 ไม่ขึ้น | หน้าต่างดำถูกปิดไปแล้ว → ดับเบิลคลิก `start-uploader.cmd` ใหม่ |

---

## สรุปคำสั่งทั้งหมด (เครื่องใหม่ ไล่จากบนลงล่าง)

```bash
# --- ครั้งเดียวต่อเครื่อง ---
# 1) ลง Node.js LTS + Git จากเว็บ (ข้อ 1)
# 2) ลง Claude CLI ใน cmd.exe:
#    curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd
# 3) เปิดหน้าต่างใหม่ แล้ว login ให้เรียบร้อย:
claude --version
claude                 # login ครั้งเดียว แล้ว /exit

git config --global user.name "ชื่อ ของคุณ"
git config --global user.email "อีเมล GitLab"
git config --global push.autoSetupRemote true
ssh-keygen -t ed25519 -C "อีเมล GitLab"    # แล้วเอา ~/.ssh/id_ed25519.pub ไปใส่ใน GitLab
ssh -T git@gitlab.com                       # ต้องขึ้น Welcome to GitLab

# --- ตั้ง repo ---
git clone --branch uploader-phase2-fire-rebrand git@gitlab.com:tardev-group/astro-full-schema.git astro-bas
cd astro-bas
npm install

git remote rename origin upstream
git remote add origin git@gitlab.com:tardev-group/astro-bas.git
git remote -v                               # origin ต้องเป็น astro-bas
git push -u origin uploader-phase2-fire-rebrand

# --- ทดสอบว่าพร้อม ---
npm run dev                                 # localhost:8888 แล้ว Ctrl+C
npm run rebrand:upload                      # localhost:4444 → ส่วนที่ 6 → กด 🧪 ทดสอบท่อ
```

---

อ่านต่อ: [`README.md`](README.md) (งานรีแบรนด์ + deploy + กฎเหล็ก) ·
[`CLAUDE.md`](CLAUDE.md) และ [`.claude/skills/rebrand-site/SKILL.md`](.claude/skills/rebrand-site/SKILL.md) (สำหรับ dev)
