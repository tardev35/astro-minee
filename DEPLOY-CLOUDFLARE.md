# เอาเว็บขึ้น Cloudflare (Workers Static Assets)

คู่มือนี้พาตั้งแต่ `npx wrangler login` จนเว็บขึ้นบนโดเมนจริง
เขียนจากการทำจริงกับ **MAHORANLOTTO** — ทุกข้อผิดพลาดในหัวข้อ "ปัญหาที่เจอจริง" คือของที่เจอมาแล้ว

> 📌 วิธีนี้ **แทนที่** `deploy.ps1` (VPS + SSH) ไม่ใช่ทำคู่กัน
> ตราบใดที่ยังมีแบรนด์อื่นอยู่บน VPS **อย่าเพิ่งปิด VPS**

---

## ทำไมใช้วิธีนี้ ไม่ใช่ R2 + Worker

บทความส่วนใหญ่สอนแบบ **R2 + เขียน Worker เอง** ซึ่ง**ไม่เหมาะกับงานเรา**:

| | Workers Static Assets (วิธีนี้) | R2 + Worker เขียนเอง |
|---|---|---|
| ค่า request | **ฟรี ไม่จำกัด** | ทุก request นับเป็น Worker invocation + ค่า R2 |
| โค้ดที่ต้องเขียน | **ไม่มี** | map path, index.html, content-type, cache, 404, decode URL ไทย |
| เว็บ 15 แบรนด์พังพร้อมกันได้ไหม | ไม่ได้ แยกกันคนละ Worker | **ได้ ถ้าใช้ Worker ตัวเดียวเสิร์ฟทุกโดเมน** |

> "Requests to static assets are free and unlimited"
> — [Cloudflare Workers Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

**ข้อจำกัดที่ต้องเช็ก** (แผนฟรี): ไม่เกิน **20,000 ไฟล์** ต่อ Worker และไฟล์เดี่ยวไม่เกิน **25 MiB**
เว็บของเราอยู่ที่ ~120 ไฟล์ ไฟล์ใหญ่สุด ~2 MB — ห่างจากเพดานมาก

---

## เตรียมก่อนเริ่ม

1. **บัญชี Cloudflare ที่ยืนยันอีเมลแล้ว** ⚠️ อ่านหัวข้อ "ปัญหาที่เจอจริง ①" ก่อน — ข้อนี้ทำให้เสียเวลามาแล้ว
2. **โดเมนอยู่บน Cloudflare** — nameserver ที่ผู้ให้บริการโดเมนต้องชี้มา Cloudflare แล้ว
   ถ้าโดเมน**เพิ่งย้ายมาและยังไม่มี DNS record เลย** อ่าน **ขั้นที่ 0** ก่อน
3. **Node.js** ติดตั้งแล้ว (ดู [SETUP-NEW-MACHINE.md](SETUP-NEW-MACHINE.md))

---

## ขั้นที่ 0 — อย่าปล่อยให้โดเมนอยู่ในสภาพ "ไม่มี record"

ข้ามข้อนี้ได้ **ถ้าโดเมนยังชี้ VPS อยู่** (มี A record อยู่แล้ว) — ข้อนี้มีไว้สำหรับกรณีที่
โดเมน**เพิ่งเข้ามาอยู่บน Cloudflare แต่ยังไม่มี record ใดๆ** และจะทิ้งช่วงก่อนผูก Worker

### 🥇 วิธีที่ควรใช้ — ยิงหน้า placeholder ขึ้นไปเลย

```powershell
npx wrangler deploy --name <brand-token> --config tools/domain-placeholder/wrangler.toml
```

แล้ว **Add Custom Domain ต่อทันที** (ขั้นที่ 4) รายละเอียดทั้งหมดอยู่ที่
[tools/domain-placeholder/README.md](tools/domain-placeholder/README.md)

วิธีนี้แก้ **สองปัญหาพร้อมกัน** ส่วน A record หลอกข้างล่างแก้ได้ปัญหาเดียว:

| | หน้า placeholder | A record หลอก `192.0.2.1` |
|---|---|---|
| กันกับดัก "ไม่มี record" | ✅ | ✅ |
| สิ่งที่บอทเห็นระหว่างรอ | **หน้า 200 ที่บอกว่า `noindex`** | **Cloudflare error 522** |
| ต้องกลับมาลบทีหลัง | ❌ ไม่ต้อง (deploy ทับได้เลย) | ✅ ต้องลบ/ยืนยันเขียนทับ |

**ปัญหาที่สองคือเรื่อง SEO:** พอ zone active ปุ๊บ Cloudflare ออก Universal SSL ให้ทันที
ชื่อโดเมนจึงไปโผล่ใน **Certificate Transparency log ซึ่งเปิดสาธารณะ** ภายในไม่กี่นาที —
crawler อ่านจากตรงนั้นได้เลยโดยไม่ต้องมีใครลิงก์มาหา **นี่คือคำตอบว่าทำไมโดเมนที่ยังไม่ได้
ขึ้นเว็บถึงโดน Google เก็บ index** ถ้าช่วงนั้นมันเจอ 522 ก็มีโอกาสถูกเก็บเข้า index ในสภาพหน้าพัง

> ⚠️ **ห้ามใส่ `Disallow: /` ในหน้า placeholder** `noindex` ทำงานได้ก็ต่อเมื่อ Google เข้ามา
> อ่านหน้าได้ บล็อกไว้ = ไม่มีวันเห็น `noindex` แล้ว URL ยังถูกเก็บเข้า index จาก CT log ได้อยู่ดี

### วิธีสำรอง — A record หลอก

ใช้เมื่อยังไม่พร้อม deploy อะไรเลย (เช่นยังไม่ได้สลับบัญชี Cloudflare ให้ถูก)

### ปัญหาที่มันแก้

พอ resolver ตัวไหนถามหาโดเมนที่ยังไม่มี record มันจะ**จำคำตอบว่า "ไม่มี" ไว้**
นานเท่ากับ SOA minimum TTL ของโซน — ของ Cloudflare คือ **1800 วินาที (30 นาที)**

ผลคือหลังผูก Worker เสร็จ **เว็บขึ้นแล้วจริง คนทั่วโลกเข้าได้ แต่เครื่องที่เคยถามไปตอนนั้น
ยังเข้าไม่ได้อีกครึ่งชั่วโมง** และไม่มีอะไรที่กดใน Cloudflare แล้วช่วยได้เลย (Purge Cache
ไม่เกี่ยว — คนละแคชชั้นกัน ดูหัวข้อ "ปัญหาที่เจอจริง ⑤")

### วิธีกัน — สร้าง A record หลอกไว้ก่อน

DNS records → **Add record**

| ช่อง | ค่า |
|---|---|
| Type | `A` |
| Name | `@` (โดเมนหลัก) |
| IPv4 address | `192.0.2.1` |
| Proxy status | **Proxied (เมฆส้ม)** ⚠️ **ต้องส้ม ไม่งั้นแทบไม่ได้ประโยชน์** |

> ใช้ `192.0.2.1` เพราะ `192.0.2.0/24` เป็นช่วงที่ RFC 5737 สงวนไว้สำหรับเอกสาร/ทดสอบ
> **ไม่มีเจ้าของจริง** — อย่าหยิบเลขมั่วอย่าง `192.0.1.2` มาใช้ นั่นเป็น IP ที่มีคนถือจริง

### ทำไม "ต้องเมฆส้ม" ถึงเป็นหัวใจ

พอเปิด proxy **โลกภายนอกไม่เห็น `192.0.2.1` เลย** มันเห็น anycast IP ของ Cloudflare แทน
ซึ่งเป็น**คู่เดียวกับที่ Custom Domain ของ Worker จะให้ทีหลัง** เพราะ IP คู่นี้ผูกกับ*โซน*
ไม่ได้ผูกกับ record:

| | ตอนเป็น record หลอก (proxied) | ตอนเป็น Worker Custom Domain |
|---|---|---|
| คำตอบ DNS สาธารณะ | anycast ของโซน เช่น `104.21.95.120` | **เลขเดียวกันเป๊ะ** |
| TTL | 300 วิ | 300 วิ |

**คำตอบไม่เปลี่ยนแม้แต่นิดเดียวตอนสลับ** = ไม่ต้องรอ propagate และไม่เคยมีสภาพ "ไม่มี record"
ให้ resolver ไหนจำ

ถ้าปล่อยเมฆเทา (DNS-only) จะแย่กว่ามาก เพราะ `192.0.2.1` ถูกประกาศออกไปจริง คนเข้าเว็บจะ
ค้างรอ timeout แทนที่จะฟ้องทันที และตอนสลับ IP เปลี่ยนจริง ต้องรอ TTL อีกรอบ

### ข้อแลกเปลี่ยนที่ต้องยอมรับ

ช่วงที่ยังเป็น record หลอก โดเมนจะ "มีชีวิต" แต่เสิร์ฟ **Cloudflare error 522** เพราะไม่มี
origin จริงข้างหลัง ถ้าบอทมาไต่ช่วงนั้นจะเห็นหน้า error — ยอมรับได้เมื่อแลกกับการไม่ให้
resolver ทั่วโลกจำว่าโดเมนไม่มีอยู่จริง แต่**ยิ่งช่วงสั้นยิ่งดี**

> นี่คือข้อเสียที่หน้า placeholder ไม่มี — มันตอบ 200 พร้อม `noindex` แทนที่จะเป็น 522
> ถ้า deploy ได้ ให้ใช้วิธีนั้นแทน

### ตอนจะผูก Custom Domain ทีหลัง

Cloudflare จะเห็นว่ามี record ของ hostname นี้อยู่แล้วและ**ถามให้ยืนยันเขียนทับ** ตอบตกลงได้เลย
ถ้ามันไม่ยอมให้ทับ ให้**ลบ record หลอกทิ้งก่อน** แล้วค่อยกด Add Domain

> ⚠️ ขั้นตอนนี้ยังไม่เคยทำจริงในโปรเจกต์นี้ — MAHORANLOTTO กับ UFAYES ผูก Custom Domain
> ตอนที่ไม่มี record หลอกอยู่ ถ้าลองแล้วพฤติกรรมต่างจากนี้ ให้มาแก้บรรทัดนี้

**ทางที่ดีที่สุดถ้าทำได้:** ข้ามเรื่อง record หลอกไปเลย แล้ว **deploy หน้า placeholder เสร็จ →
Add Custom Domain ต่อทันทีในนาทีเดียวกัน** ช่องว่างจะสั้นจนแทบไม่มีใครไปถามโดน และสิ่งที่
บอทเจอคือหน้า `noindex` ไม่ใช่ error

---

## ขั้นที่ 1 — login เข้า Cloudflare

```powershell
npx wrangler login
```

- ครั้งแรกจะถามว่าจะติดตั้ง `wrangler` ไหม → ตอบ **y**
- เบราว์เซอร์จะเปิดหน้า Cloudflare ให้กด **Allow**
- กลับมาที่หน้าต่างคำสั่ง จะขึ้นว่า login สำเร็จ

**เช็กว่าติดจริง:**

```powershell
npx wrangler whoami
```

ต้องขึ้นอีเมลกับ Account ID ถ้าขึ้นว่ายังไม่ได้ login ให้ทำข้อ 1 ซ้ำ

> 💡 **ไม่ต้อง `npm i -g wrangler`** — `npx` ดึงตัวล่าสุดมาให้เอง และเลี่ยงปัญหาเวอร์ชันไม่ตรงกันระหว่างเครื่องในทีม

---

## ขั้นที่ 2 — ตั้งค่า `wrangler.toml`

ไฟล์นี้อยู่ที่รากโปรเจกต์แล้ว หน้าตาแบบนี้:

```toml
name = "mahoranlotto"
account_id = "74bd4e712aca2afaa89bd2ea6a015e85"
compatibility_date = "2026-07-27"
workers_dev = false

[assets]
directory = "dist"
not_found_handling = "404-page"
```

| บรรทัด | ความหมาย |
|---|---|
| `name` | **ชื่อ Worker = ตัวตนของ deployment** เปลี่ยน**ทุกแบรนด์** (ดูหัวข้อ "รีแบรนด์รอบหน้า") |
| `account_id` | บัญชี Cloudflare ที่จะ deploy เข้าไป — เปลี่ยน**ทุก 5-10 แบรนด์** ไม่ใช่ทุกแบรนด์ |
| `compatibility_date` | วันที่ล็อกพฤติกรรม runtime — ใส่วันที่ตั้งค่าครั้งแรก ไม่ต้องขยับบ่อย |
| `workers_dev = false` | **ปิด `*.workers.dev`** — สำคัญมาก อ่านด้านล่าง |
| `directory` | โฟลเดอร์ที่ Astro build ออกมา |
| `not_found_handling` | ให้ URL มั่วได้หน้า 404 จริง **ถ้าไม่ใส่ ทุก URL ผิดจะได้หน้าแรกพร้อม HTTP 200** |

### หา `account_id` จากไหน

**ทางที่เร็วและแม่นที่สุด — ไม่ต้องเข้า dashboard:**

```powershell
npx wrangler whoami
```

```
│ Account Name                      │ Account ID                       │
│ Ufayes-brand1@gmail.com's Account │ 74bd4e712aca2afaa89bd2ea6a015e85 │
```

> ดีกว่าก๊อปจากเบราว์เซอร์ เพราะมันบอก**บัญชีที่ wrangler จะ deploy ไปจริงๆ** ไม่ใช่บัญชีที่บังเอิญเปิดค้างอยู่ในแท็บ — ถ้ามีหลายบัญชีแล้วก๊อปผิด เว็บจะไปโผล่ผิดที่โดยไม่มีอะไรเตือน

ถ้าอยากดูจาก dashboard: **Workers & Pages → กล่อง Account details ทางขวา → Click to copy**
หรือดูจาก URL ตอนอยู่ในหน้า dashboard — สตริง hex ยาวๆ ต่อจาก `dash.cloudflare.com/`

---

## สลับบัญชีเมื่อบัญชีเดิมครบจำนวน

หนึ่งบัญชี Cloudflare ใส่โดเมนได้ไม่จำกัดในแผนฟรี — **เลข 5-10 แบรนด์ต่อบัญชีคือกติกาที่เราตั้งเอง
ไม่ใช่เพดานของ Cloudflare** จะไม่มี error ว่า "บัญชีเต็ม" ให้เห็น เป็นจังหวะที่เราเลือกจะแยกเอง

### แยกไปทำไม (ไม่ใช่เหตุผลที่คนมักคิด)

**ไม่ได้ช่วยเรื่อง Google** — โครงสร้างบัญชี Cloudflare มองไม่เห็นจากภายนอก พิสูจน์ได้จาก header
ของสองแบรนด์ที่อยู่บัญชีเดียวกัน ไม่มีตัวไหนซ้ำกันเลยนอกจาก boilerplate ที่เว็บ Cloudflare
ทุกเว็บบนโลกส่งเหมือนกัน

เหตุผลจริงมีสองข้อ ทั้งคู่เป็นเรื่อง**ฝั่ง Cloudflare ไม่ใช่ฝั่ง Google**:

1. **Blast radius** — บัญชีโดนระงับทีเดียว เว็บทุกแบรนด์ในบัญชีนั้นดับพร้อมกัน
2. **NS pair ผูกกับบัญชี** — โดเมนในบัญชีเดียวกันได้คู่ nameserver เดียวกัน วัดจากของจริง:

   | โดเมน | NS pair |
   |---|---|
   | ufayes-brand.com | `armfazh` / `arushi` |
   | mahoranlotto-brand.com | `armfazh` / `arushi` ← คู่เดียวกัน |
   | gsybet-guideline.com | `aaron` / `addilyn` |

   ลำพัง NS เป็นสัญญาณอ่อนมาก (คู่หนึ่งมีเว็บที่ไม่เกี่ยวกันใช้อยู่มหาศาล) แต่พอไปรวมกับ
   **ลิงก์ที่ชี้หากัน** และ **โครงสร้างหน้าที่เหมือนกัน** มันคือตัวช่วยจัดกลุ่มที่ถูกที่สุด

**ผลต่อการตัดสินใจ:** อย่าแบ่งบัญชีตามลำดับเวลาที่เปิดตัว ให้แบ่งโดย
**เอาแบรนด์ที่เกี่ยวข้องกันไว้คนละบัญชี**

### วิธีสลับ — ปุ่มในการ์ด 7 ของ uploader

การ์ด 7 มีแถว **บัญชี Cloudflare** แสดงอีเมลที่ login อยู่ ชื่อบัญชี และ `account_id`
ที่ `wrangler.toml` ชี้ไป — เห็นตลอดเวลาไม่ว่าจะสลับหรือไม่ เพราะบัญชีคือสิ่งเดียวใน deploy
ที่มองไม่เห็นจนกว่าจะผิด

กด **🔑 สลับบัญชี** แล้วมันจะทำให้ตามลำดับ:

1. `wrangler logout` — ออกจากบัญชีเดิม
2. `wrangler login --browser false` — ได้ลิงก์อนุญาตมาแสดงเป็นปุ่ม กดแล้ว login บัญชีใหม่ กด **Allow**
3. `wrangler whoami` — อ่านรายชื่อบัญชีที่ login ใหม่เข้าถึงได้
4. **กดเลือกบัญชีจากรายการ → เขียน `account_id` ลง `wrangler.toml` ให้เลย**

**ข้อ 4 คือครึ่งที่ขาดไม่ได้** — `wrangler login` บอกว่าเข้าถึงบัญชีไหนได้ แต่ `account_id`
ในไฟล์ต่างหากที่ตัดสินว่า deploy ไปที่ไหน เปลี่ยนแค่ข้อแรกแล้วไม่แก้ไฟล์ = deploy พังตอนยิงจริง

### ทำไมไม่ใช้วิธีเชิญ member หรือ API token

| | เชิญอีเมลกลางเข้าทุกบัญชี | API token ต่อบัญชี | **ปุ่มสลับ OAuth (ที่ใช้อยู่)** |
|---|---|---|---|
| ตัดเส้นเชื่อมที่ Cloudflare เห็น | ❌ อีเมลเดียวเป็น member ทุกบัญชี | ✅ | ✅ |
| ไม่มี credential แบบ plaintext บนเครื่อง | ✅ | ❌ token ที่ deploy ได้วางบนดิสก์ | ✅ |
| คน non-tech ทำเองได้ | ✅ | ⚠️ ต้องมีคนวาง token ให้ | ✅ |

### ข้อจำกัดที่ต้องยอมรับ

- **เป็น state ระดับเครื่อง** `wrangler logout` ล้าง token ตัวเดียวที่ทุกโปรเจกต์บนเครื่องนั้นใช้ร่วมกัน
  สลับที่นี่ = สลับทั้งเครื่อง โปรเจกต์อื่นต้อง login ใหม่ด้วย
- **deploy สองบัญชีในรอบเดียวไม่ได้** ต้องสลับคั่นทุกครั้ง
- **แต่ละบัญชีต้องมีอีเมล/รหัสผ่าน/2FA ที่คนกด deploy เข้าถึงได้จริง** — ย้ายจากปัญหา
  "จัดการ token" ไปเป็น "จัดการรหัสผ่าน" ซึ่งจัดการง่ายกว่า แต่ไม่ได้หายไป
- **โดเมนใหม่ในบัญชีใหม่ต้องทำขั้นที่ 0 ด้วย** ไม่งั้นเจอกับดัก DNS เดิม

### ⚠️ `workers_dev = false` ห้ามลืม

Cloudflare แถม URL ฟรีให้แบบ `ชื่อ.ซับโดเมน.workers.dev` ซึ่ง**เสิร์ฟเว็บชุดเดียวกันเป๊ะ**
= มีเว็บสาธารณะ 2 ชุดให้ Google เก็บ index = **duplicate content**

ปิดผ่านหน้า dashboard ได้ **แต่ไม่พอ** — ค่า default ของ key นี้คือ `true`
**ถ้าไม่เขียนไว้ในไฟล์ `wrangler deploy` รอบหน้าจะเปิดกลับมาเงียบๆ**

---

## ขั้นที่ 3 — build แล้ว deploy

```powershell
npm run build
npx wrangler deploy
```

ครั้งแรกจะได้ URL ชั่วคราวแบบ `https://<name>.<ซับโดเมน>.workers.dev`
(ถ้าตั้ง `workers_dev = false` แล้ว URL นี้จะปิด — ข้ามไปเช็กที่โดเมนจริงเลย)

---

## ขั้นที่ 4 — ผูกโดเมนจริง (ใช้ Custom Domain เท่านั้น)

**Workers & Pages → เลือก Worker → แท็บ Domains → ปุ่ม `+ Add Domain`**

ใส่โดเมนเปล่าๆ ไม่ต้องมี `www` ไม่ต้องมี `*` ไม่ต้องมี `/*`:

```
mahoranlotto-brand.com
```

Cloudflare จะ**สร้าง DNS record ให้เอง** + ออกใบรับรอง รอ 1-2 นาที

### 🚨 ห้ามใช้ `+ Add Route`

ปุ่ม **Add Route** อยู่ข้างๆ กัน หน้าตาคล้ายกัน แต่**คนละเรื่องกันสิ้นเชิง**:

| | Custom Domain (ถูก) | Route (ผิดสำหรับงานนี้) |
|---|---|---|
| สร้าง DNS ให้ | ✅ อัตโนมัติ | ❌ **ต้องมี record อยู่ก่อน** |
| ครอบโดเมนหลัก | ✅ | ❌ `*.example.com/*` **ไม่ครอบ** `example.com` |
| ใช้เมื่อ | **Worker คือเว็บเอง** ← กรณีเรา | มี origin จริงอยู่ข้างหลัง อยากเอา Worker ไปคั่น |

> เอกสาร Cloudflare: *"If your Worker is your application's origin, use Custom Domains"*

**หลัง add เสร็จ** ไปดูหน้า **DNS records** จะเห็นรายการใหม่ประเภท **`Worker`** มีไอคอนกุญแจ 🔒
(แก้ไม่ได้ ถูกต้องแล้ว) — **อย่าไปสร้าง record ของโดเมนหลักทิ้งไว้คู่กับมัน จะชนกัน**

> ข้อยกเว้นเดียวคือ record หลอกตาม **ขั้นที่ 0** ซึ่งตั้งใจให้ถูกเขียนทับตอน Add Domain
> ถ้ามีอยู่ ให้ยืนยันทับ หรือลบทิ้งก่อนกด Add Domain — สุดท้ายต้องเหลือ record ประเภท
> `Worker` ตัวเดียว

---

## ขั้นที่ 5 — ทำให้ `www` เด้งมาโดเมนหลัก

ถ้าไม่ทำ คนพิมพ์ `www.` จะเข้าไม่ได้เลย

**5.1 สร้าง DNS record หลอก**
DNS records → **Add record**

| ช่อง | ค่า |
|---|---|
| Type | `A` |
| Name | `www` |
| IPv4 address | `192.0.2.1` |
| Proxy status | **Proxied (เมฆส้ม)** ⚠️ ต้องส้ม |

> `192.0.2.1` เป็น IP สงวนสำหรับเอกสาร ไม่มีเครื่องจริง — **ไม่เคยถูกเรียกถึง** เพราะ
> Cloudflare เด้ง 301 ตั้งแต่ที่ขอบก่อนจะไปหา origin record นี้มีไว้ให้ Cloudflare
> ยอมรับ request ที่ชื่อ `www` เท่านั้น

**5.2 สร้าง Redirect Rule**
**Rules → Redirect Rules → Create rule**

- **When incoming requests match:** `Hostname` `equals` `www.mahoranlotto-brand.com`
- **Then:** Type `Dynamic` · Status **301**
- **Expression:** `concat("https://mahoranlotto-brand.com", http.request.uri.path)`

> ใช้ **Redirect Rules** ไม่ใช่ **Page Rules** — Page Rules เป็นของเก่า โควตาน้อยกว่า
> และ **Page Rule จะไม่ทำงานกับ hostname ที่ผูกเป็น Custom Domain ของ Worker**

> ⚠️ **ทำ 5.1 แล้วลืม 5.2 = `www` ตอบ 522** ไม่ใช่ "เข้าไม่ได้เฉยๆ" — record หลอกทำให้
> Cloudflare ยอมรับชื่อ `www` แล้วพยายามต่อไปหา origin ที่ `192.0.2.1` ซึ่งไม่มีเครื่องจริง
> จนหมดเวลา **เจอ 522 ที่ `www` เมื่อไหร่ ให้เดาข้อนี้ก่อนเสมอ** ไม่ต้องไปไล่ดู Worker
> หรือ SSL (เจอจริงกับ tungma168-brand.com เมื่อ 2026-07-31)
>
> ระวังตัวเช็ค redirect ออนไลน์ด้วย — มันดูแค่โซ่ redirect ไม่ได้ดูว่าปลายทางมีชีวิตไหม
> `http://www` จะยังเด้ง 301 เป็น `https://www` จาก Always Use HTTPS แล้วค่อยตาย 522
> ตรงนั้น เครื่องมือจึงขึ้นว่า "ทุกอย่างปกติ" ทั้งที่เว็บเข้าไม่ได้ **เชื่อ `curl -sI` เท่านั้น**

---

## ขั้นที่ 6 — ตรวจให้ครบก่อนบอกว่าเสร็จ

```powershell
curl.exe -sI https://mahoranlotto-brand.com/
curl.exe -sI https://www.mahoranlotto-brand.com/
curl.exe -sI https://mahoranlotto-brand.com/promotion/
curl.exe -sI "https://mahoranlotto-brand.com/%E0%B8%95%E0%B8%A3%E0%B8%A7%E0%B8%88%E0%B8%AB%E0%B8%A7%E0%B8%A2/"
curl.exe -sI https://mahoranlotto-brand.com/abcxyz
```

| ต้องได้ | |
|---|---|
| โดเมนหลัก | **200** |
| `www` | **301** ไปโดเมนหลัก |
| `/promotion/` | 200 |
| **หน้าไทย** (`/ตรวจหวย`) | **200** ← จุดที่พังบ่อยสุด |
| URL มั่ว | **404** ไม่ใช่ 200 |
| `*.workers.dev` | **404** (ปิดแล้ว) |

**แล้วเปิดดูด้วยตาอีกรอบ** — เทียบกับเว็บเดิมว่าเนื้อหา รูป สี เหมือนกันทุกอย่าง

---

## ปัญหาที่เจอจริง (เรียงตามที่เจอ)

### ① `[code: 10034] You need to verify your email address to use Workers`

ไฟล์อัปโหลดขึ้นครบแล้วแต่ตายตอนสุดท้าย — **บัญชี Cloudflare ยังไม่ได้ยืนยันอีเมล**

**กับดัก:** ถ้าสมัครด้วยอีเมลที่ไม่มีจริง **จะเปลี่ยนอีเมลไม่ได้ด้วย** เพราะการเปลี่ยนอีเมลต้องผ่านการยืนยันอีเมลเดิมก่อน

> "You cannot change your email address ... if you did not successfully verify the original email address"
> "If you cannot access your original email address, **you will need to create a new account** with a working email address and move domains"

**ทางแก้:** ลองเข้า My Profile ดูว่ากดปุ่ม Change Email Address ได้ไหม ถ้าไม่ได้ = ต้องสร้างบัญชีใหม่แล้วย้ายโดเมน

**ทำให้ถูกตั้งแต่แรก:** ใช้**อีเมลกลางของบริษัทที่หลายคนเข้าถึงได้** ไม่ใช่อีเมลส่วนตัวคนใดคนหนึ่ง และไม่ใช่อีเมลมั่ว — บัญชีนี้จะถือเว็บทุกแบรนด์

### ② เว็บขึ้นที่ `www` แต่โดเมนหลักเป็นหน้า "Site Under Construction"

เกิดจากใช้ **Route** `*.mahoranlotto-brand.com/*` แทน Custom Domain

`*.` ครอบแค่ subdomain **ไม่ครอบโดเมนหลัก** → `www` เข้า Worker ส่วนโดเมนหลักตกไปที่ VPS เก่า

**แก้:** ลบ route ทิ้ง แล้วใช้ **Add Domain** ตามขั้นที่ 4

### ③ ลบ route แล้วขึ้น "The route you are trying to access does not exist"

route ถูกลบไปแล้วที่ฝั่งเซิร์ฟเวอร์ (มักโดน `wrangler deploy` sync ให้ตรงกับไฟล์ที่ไม่มี `routes`)
เหลือแต่ UI ค้าง → กด **Cancel** แล้ว **refresh หน้า (F5)**

### ④ หน้า DNS ขึ้น 0 records แต่เว็บใช้งานได้

record ของ Custom Domain ใช้เวลาสักครู่กว่าจะโผล่ในหน้า DNS
เมื่อขึ้นแล้วจะเป็นประเภท **`Worker`** พร้อมไอคอนกุญแจ — **ปกติ ไม่ต้องแก้อะไร**

### ⑤ `ERR_NAME_NOT_RESOLVED` / `DNS_PROBE_POSSIBLE` ทั้งที่คนอื่นเข้าได้

**เว็บไม่ได้พัง — DNS ที่เครื่อง/เราเตอร์/VPN ของคุณจำผลเก่าตอนที่ยังไม่มี record ไว้**
กันไว้ล่วงหน้าได้ที่ **ขั้นที่ 0**

🚫 **กด Purge Cache ที่ Cloudflare ไม่ช่วยเลย ไม่ว่ากดกี่ครั้ง** — คนละแคชคนละชั้น:

| | Purge Cache แก้ | ปัญหานี้ |
|---|---|---|
| แคชอะไร | **เนื้อหา** HTML/รูป ที่ Cloudflare เก็บที่ edge | **ที่อยู่** (DNS) ที่ resolver ของคนอื่นเก็บ |
| อยู่ที่ไหน | เซิร์ฟเวอร์ Cloudflare | เครื่องคุณ / เราเตอร์ / VPN |
| Cloudflare สั่งล้างได้ | ✅ ของตัวเอง | ❌ เป็นเครื่องของคนอื่น |

**เช็กว่าใช่ไหม** — เทียบกับ DNS สาธารณะ ต้องถาม **A record ตรงๆ**:

```powershell
nslookup -type=A mahoranlotto-brand.com            # resolver ของเครื่องคุณ
nslookup -type=A mahoranlotto-brand.com 1.1.1.1    # Cloudflare
nslookup -type=A mahoranlotto-brand.com 8.8.8.8    # Google
```

ถ้าสองอันหลังได้ IP แต่อันแรกไม่ได้ = แคชค้าง **ไม่ต้องไปแก้อะไรที่ Cloudflare**

**ดูว่าต้องรออีกนานเท่าไร:**

```powershell
nslookup -debug -type=A mahoranlotto-brand.com     # อ่านบรรทัด ttl = ...
```

⚠️ **กับดักที่เจอจริง — อาการ "มี AAAA แต่ไม่มี A"** resolver อาจตอบ IPv6 มาแล้วแต่ยังจำ
"ไม่มี A record" ค้างอยู่ พอเครื่องไม่มี IPv6 ก็เข้าไม่ได้ทั้งที่ดูเผินๆ เหมือน DNS ทำงานแล้ว
ต้องถาม `-type=A` เท่านั้นถึงจะเห็น

⚠️ **ถ้าใช้ VPN — สลับประเทศไม่ช่วย** VPN หลายเจ้า (เช่น ProtonVPN) บังคับให้ใช้ resolver
ของตัวเองที่ IP ภายใน เช่น `10.2.0.1` เปลี่ยน server ปลายทางยังไงก็เจอ resolver ตัวเดิม
เช็กว่าเครื่องใช้ตัวไหนอยู่:

```powershell
Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, ServerAddresses
```

| วิธีแก้ | ได้ผลเมื่อไร |
|---|---|
| **เปิดจากมือถือ ปิด WiFi ใช้ 4G** | ทันที — ใช้พิสูจน์ว่าเว็บขึ้นจริง |
| **ยิง curl ข้ามแคช** `curl.exe --resolve โดเมน:443:<IP จาก 1.1.1.1> https://โดเมน/` | ทันที — พิสูจน์ได้จากเครื่องเดิม |
| **ปิด VPN ก่อน** แล้วเปลี่ยน DNS เครื่องเป็น `1.1.1.1` | ทันที (`Win+R` → `ncpa.cpl` → คลิกขวาการ์ดเน็ต → Properties → IPv4) |
| `ipconfig /flushdns` | ล้างแค่แคชใน Windows **ไม่ได้ล้างของเราเตอร์หรือ VPN** |
| ล้างแคชเบราว์เซอร์ | `chrome://net-internals/#dns` → Clear host cache (Brave/Edge ใช้ path เดียวกัน) |
| ไม่ทำอะไร | ≤ **30 นาที** (SOA minimum TTL ของ Cloudflare = 1800 วิ) |

---

## รีแบรนด์รอบหน้า — สิ่งที่ต้องเปลี่ยน

🚨 **`name` ใน `wrangler.toml` ผูกกับแบรนด์**
ถ้ารีแบรนด์แล้วไม่เปลี่ยนชื่อ `wrangler deploy` จะไป **เขียนทับ Worker ของแบรนด์เดิม เว็บที่ออนไลน์อยู่หายทันที**

🅿️ **ถ้าโดเมนนี้เคย park ไว้ด้วยหน้า placeholder — `name` ต้องเป็นชื่อ *เดิม* ที่ park ไว้**
ไม่ใช่ตั้งใหม่ เพราะการทับ Worker ตัวเดิมคือสิ่งที่ทำให้ Custom Domain กับ DNS ไม่ต้องแตะเลย
ตั้งชื่อใหม่ = ได้ Worker ตัวที่สอง ส่วนโดเมนยังชี้ placeholder อยู่ **และไม่มี error เตือน**
เช็กด้วย `npx wrangler deployments list --name <ชื่อ>` ว่าเห็นทั้งเวอร์ชันเก่าและใหม่บนตัวเดียวกัน

รายการที่ต้องแก้ให้ครบทุกครั้งที่ได้โดเมนจริงใหม่:

| ไฟล์ | แก้อะไร | เปลี่ยนบ่อยแค่ไหน |
|---|---|---|
| `wrangler.toml` | `name` | **ทุกแบรนด์** |
| `astro.config.mjs` | `site:` | **ทุกแบรนด์** |
| `src/pages/index.astro` | `webSiteSchema.url` | **ทุกแบรนด์** |
| `wrangler.toml` | `account_id` | ทุก 5-10 แบรนด์ — **ไม่ต้องแก้มือ** กดปุ่มสลับบัญชีในการ์ด 7 มันเขียนให้ |
| `public/robots.txt` | — | ไม่ต้องแก้ สร้างเองจาก `site:` แล้ว |

แล้วทำขั้นที่ 3-6 ใหม่ทั้งหมด (สร้าง Custom Domain ของโดเมนใหม่ + www redirect ของโดเมนใหม่)

---

## คำสั่งที่ใช้บ่อย

```powershell
npx wrangler whoami                  # login อยู่ด้วยบัญชีไหน
npm run build ; npx wrangler deploy  # อัปเว็บขึ้น
npx wrangler deploy --dry-run        # เช็ก config ไม่ได้อัปจริง
npx wrangler deployments list        # ดูประวัติ deploy
npx wrangler rollback                # ย้อนกลับเวอร์ชันก่อนหน้า
```
