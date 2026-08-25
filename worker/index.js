// Worker ที่อยู่หน้าไฟล์ static ของ Astro บน Cloudflare
//
// หน้าที่เดียว: 301 จาก www -> non-www แล้วส่งที่เหลือให้ไฟล์ static ตามปกติ
//
// ทำไมต้องมี: ถ้าปล่อยให้ทั้ง www และ non-www เสิร์ฟเนื้อหาเดียวกัน Google จะเห็นเป็น
// สองเว็บที่เนื้อหาซ้ำกัน และแบ่งน้ำหนักลิงก์ออกเป็นสองทาง
//
// การมี main = ในไฟล์ wrangler.toml ทำให้ทุก request วิ่งผ่านโค้ดนี้ก่อนถึงไฟล์
// (เดิมเป็น assets ล้วน ไม่มีโค้ดคั่น) — ถ้าไม่อยากให้ request วิ่งผ่าน Worker
// ใช้ Redirect Rules ในหน้า Cloudflare แทนได้ ผลลัพธ์เหมือนกันแต่ทำที่ edge
// ข้อแลกเปลี่ยนคือมันไม่ได้อยู่ใน repo จึงไม่ได้ถูกตั้งใหม่ให้อัตโนมัติตอน deploy แบรนด์ถัดไป

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      // 301 ไม่ใช่ 302 เพราะต้องการให้ search engine ย้ายน้ำหนักไปที่ non-www ถาวร
      return Response.redirect(url.toString(), 301);
    }

    return env.ASSETS.fetch(request);
  },
};
