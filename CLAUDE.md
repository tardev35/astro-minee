# CLAUDE.md

ไฟล์นี้ให้ข้อมูลแก่ Claude Code (claude.ai/code) เพื่อใช้ประกอบการทำงานกับโค้ดในโปรเจกต์นี้

## คำสั่งที่ใช้บ่อย

```sh
npm install              # ติดตั้ง dependencies
npm run dev               # เปิด dev server ที่ localhost:8888
npm run build              # build ไปที่ ./dist/ (เช็ก type/content ของ Astro + รัน verify ต่อท้ายอัตโนมัติ)
npm run verify             # เกทคุณภาพบน dist/ (อ่านอย่างเดียว) — `postbuild` เรียกให้เองอยู่แล้ว
npm run preview            # รัน production build ที่ build แล้วมาดูตัวอย่าง
npm run astro -- check      # รัน diagnostics ของ Astro (type-check ไฟล์ .astro)
npx prettier --write .       # จัด format (มี prettier-plugin-astro + prettier-plugin-tailwindcss ติดตั้งไว้แล้ว แต่ยังไม่ได้ผูกเป็น npm script)
```

โปรเจกต์นี้ไม่มี test suite และไม่มี lint script ตั้งค่าไว้ ให้ถือว่า `npm run build` ที่ผ่านสะอาด บวกกับการเช็ก HTML/dev server ที่ render ออกมาด้วยตาจริง คือมาตรฐานในการยืนยันว่างานเสร็จ (ดู skill `verify`)

## โปรเจกต์นี้คืออะไร

เป็นเว็บ Astro 5 + Tailwind 4 เว็บเดียว แต่โค้ดเบสนี้เป็น **template กลางที่ใช้ซ้ำกับลูกค้าเว็บสล็อต/คาสิโนไทยหลายเจ้าที่ไม่เกี่ยวข้องกัน** ทุกครั้งที่ "เปิดตัวแบรนด์ใหม่" คือการเอาโครงหน้าเดิมมาเปลี่ยนชื่อ สี และเนื้อหาใหม่ ที่มาแบบนี้ทำให้ component library มีรูปร่างแบบนี้: `src/components/` มี component หลายตัวที่ทำหน้าที่เดียวกันแต่มีหลายเวอร์ชันคู่ขนาน เช่น `Navbar.astro`, `NavbarStyle1..11`, `NavbarCyber`, `NavbarPremium`, `NavbarHuay`; เช่นเดียวกับ `ContentBox*`, `ContentBox3Three*`, `ContentBoxSevenThree*`, `Footer*`, `Announcement*`, `Faq*`, `LatestWinners*` ที่แต่ละตัวก็มีเวอร์ชัน `Style/Premium/Cyber/Huay/Neumorphism/FloatingBadge` ของตัวเอง มีแค่เวอร์ชันที่ถูก import ใช้จริงใน frontmatter ของหน้านั้นๆ เท่านั้นที่ "ใช้งานอยู่" ส่วนที่เหลือคือของสำรองไว้สำหรับรีแบรนด์ครั้งถัดไป **ห้ามลบเวอร์ชันที่ไม่ได้ใช้งาน** — มันคือ inventory สำหรับแบรนด์ถัดไป ไม่ใช่ dead code เว้นแต่ task จะขอให้เคลียร์ออกโดยตรง

ด้วยเหตุนี้ เวลา component ตัวไหนถูกถอดออกจาก `index.astro` หลังรีแบรนด์แล้ว มันเป็นเรื่องปกติที่เนื้อหา/สีข้างในจะยังเป็นของแบรนด์เก่าอยู่ — ถือเป็น drift ที่คาดไว้แล้ว ไม่ใช่บั๊ก เว้นแต่ task ปัจจุบันจะรวมไฟล์นั้นอยู่ในสโคปด้วย

## สถาปัตยกรรม

- `src/pages/*.astro` — ใช้ file-based routing บางไฟล์ชื่อเป็นภาษาไทย (เช่น `ทางเข้า.astro`, `ตรวจหวย.astro`, `แนวทาง.astro`, `ทดลองเล่น.astro`) และ route ตามชื่อไฟล์นั้นเลย
- `src/pages/index.astro` คือหน้าแลนดิ้งหลักที่ประกอบร่างจากหลายส่วน: import component เวอร์ชันที่เลือกใช้ต่อ 1 slot จาก `src/components/`, สร้าง `schema.org` JSON-LD (WebPage/WebSite/Organization) แบบ inline จากค่าคงที่ในหน้า, และส่งเนื้อหาจริงเข้าไปผ่าน prop (เช่น `faqs`) แทนที่จะพึ่งค่า default ของ component กลาง เพราะค่า default อาจเป็นของแบรนด์ก่อนหน้า
- `src/layouts/MainLayout.astro` คือโครงหน้าที่ใช้ร่วมกัน: font, meta/OG/Twitter tags, ภาพพื้นหลังแบบ fixed, คู่ `Navbar*`/`Footer*` ที่ใช้งานอยู่ และการเลือกภาพ hero banner ระบบ import แค่ `import.meta.glob("../assets/banner1.{png,webp,jpg,jpeg}")` — **เจาะชื่อไฟล์ ไม่ใช่ glob กว้าง** และถ้าไม่เจอจะ throw ให้ build ล้มพร้อมข้อความ ไม่ fallback ไปไฟล์อื่น

  เดิมเป็น `banner*.{...}` ซึ่งพังสองทางพร้อมกัน (แก้แล้วเมื่อ 2026-07-31 ทั้งคู่): **ไฟล์รุ่นเก่าที่ค้างใน `src/assets` ถูกเลือกไปใช้แบบเงียบๆ ได้** เพราะลำดับ path เอาแน่ไม่ได้ และ **eager glob = import ทุกไฟล์ที่แมตช์ ส่วน import = emit** ต่อให้ไม่มีหน้าไหน render ผลคือ `banner.png` (2.2 MB), `banner2`, `banner3` ของแบรนด์ก่อนๆ ติดขึ้น `dist/` ทุก build และขึ้น Cloudflare ทุก deploy รวม 3.1 MB — ประมาณหนึ่งในสามของ build ที่ไม่มีใครโหลด

  หลักที่ต้องคงไว้ถ้าไปแตะ logic เลือก banner/slide ที่อื่น: **อ้างชื่อไฟล์ตรงๆ อย่าให้ตัวเลือกมีของแบรนด์เก่าอยู่ใน scope** และอย่า import รูปที่ไม่ได้ render — `tools/verify-build.mjs` จะทำให้ build แดงถ้ามีรูปที่ไม่มีเวอร์ชันไหนถูกใช้เลย
- `src/assets/` มีไฟล์ที่ตายแล้วจากการรีแบรนด์ครั้งก่อนๆ ค้างอยู่โดยตั้งใจ (ไฟล์ `.png` เดิมของ banner/slide ที่ไม่มีโค้ดไหน import แล้ว) — อย่าคิดว่าทุกไฟล์ในโฟลเดอร์นี้ถูกใช้งานอยู่ ให้ grep หาการ import จริงก่อนตัดสินว่าไฟล์นั้นใช้งานอยู่หรือลบได้อย่างปลอดภัย
- ไม่มี `src/content/` collections — เนื้อหาทั้งหมด hardcode อยู่ในแต่ละหน้า/component ไม่ได้มาจาก markdown/CMS
- `astro.config.mjs`: build แบบ static, ตั้ง `inlineStylesheets: 'always'`, มี redirect `/line` ไปยัง tinyurl ภายนอก, เปิดใช้ sitemap integration, และมี `site:` เป็น URL ที่จะถูกอัปเดตทุกครั้งที่เปิดตัวแบรนด์ใหม่

## ขั้นตอนการรีแบรนด์

การเปิดตัว/รีดีไซน์แบรนด์บน template นี้ (ชื่อใหม่, docx brief เนื้อหา, โลโก้/แบนเนอร์/สไลด์ภาพใหม่) เป็นงานที่เกิดขึ้นซ้ำและมีขั้นตอนชัดเจนอยู่แล้ว — ให้ทำตาม `.claude/skills/rebrand-site/SKILL.md` แทนที่จะคิดขั้นตอนขึ้นมาใหม่ ในนั้นครอบคลุม: การดึงเนื้อหาจาก docx, การแมปเนื้อหาลง component slot ที่มีอยู่, การ retheme เฉพาะ component ที่ถูก render จริง, บั๊ก class ของภาพ banner/slide ที่ค้างจากของเก่า (ตามที่อธิบายไว้ด้านบน), และขั้นตอน verify (build + grep HTML ที่ render ออกมาหาชื่อแบรนด์/สีของเก่าที่หลงเหลือ)

`workspec.md` ที่ root ของโปรเจกต์คือ log งานรีแบรนด์แบบต่อเนื่องตามวันที่ (เป้าหมาย, ไฟล์ที่แก้, บั๊กที่เจอ, การ verify ที่ทำ, และส่วนที่ระบุชัดว่าไม่ได้แตะ) ให้ append เพิ่มเข้าไปสำหรับงานรีแบรนด์/รีดีไซน์ใหม่ แทนที่จะสร้างเอกสารใหม่แยกต่างหาก
