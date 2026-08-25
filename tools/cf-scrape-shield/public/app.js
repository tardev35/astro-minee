const $ = (id) => document.getElementById(id);

const tokenInput = $("token");
const remember = $("remember");
let zones = [];

if (sessionStorage.getItem("cf-token")) {
  tokenInput.value = sessionStorage.getItem("cf-token");
  remember.checked = true;
}

remember.addEventListener("change", () => {
  if (remember.checked) sessionStorage.setItem("cf-token", tokenInput.value);
  else sessionStorage.removeItem("cf-token");
});

tokenInput.addEventListener("input", () => {
  if (remember.checked) sessionStorage.setItem("cf-token", tokenInput.value);
});

function say(el, text, kind) {
  el.textContent = text;
  el.className = "msg " + kind;
}

function clear(el) {
  el.textContent = "";
  el.className = "msg";
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenInput.value.trim(), ...body }),
  });
  return res.json();
}

function badge(value) {
  if (value === "on") return '<span class="badge on">เปิดอยู่</span>';
  if (value === "off") return '<span class="badge off">ปิดแล้ว</span>';
  return '<span class="badge unknown">ไม่ทราบ</span>';
}

function render() {
  const needle = $("filter").value.trim().toLowerCase();
  const shown = zones.filter((z) => !needle || z.name.includes(needle));
  $("rows").innerHTML = shown
    .map((z, i) => {
      const idx = zones.indexOf(z);
      const action =
        z.editable === false
          ? '<span class="note">แก้ไม่ได้ด้วย token นี้</span>'
          : z.value === "on"
            ? `<button class="small" data-off="${idx}">ปิด</button>`
            : `<button class="small" data-on="${idx}">เปิดกลับ</button>`;
      return `<tr><td class="dom">${z.name}</td><td>${badge(z.value)}</td><td>${action}</td></tr>`;
    })
    .join("");

  const on = zones.filter((z) => z.value === "on" && z.editable !== false).length;
  $("btnAllOff").textContent = on ? `ปิดทุกโดเมนที่ยังเปิดอยู่ (${on})` : "ไม่มีโดเมนที่ยังเปิดอยู่";
  $("btnAllOff").disabled = on === 0;
}

$("rows").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const off = btn.dataset.off;
  const on = btn.dataset.on;
  const idx = Number(off ?? on);
  const zone = zones[idx];
  btn.disabled = true;
  btn.textContent = "…";
  const r = await api("/api/setting", { zoneId: zone.id, value: off !== undefined ? "off" : "on" });
  if (!r.ok) {
    say($("zoneMsg"), `${zone.name}: ${r.error}`, "err");
    render();
    return;
  }
  zone.value = r.value;
  say($("zoneMsg"), `${zone.name} → ${r.value === "off" ? "ปิดแล้ว" : "เปิดแล้ว"}`, "info");
  render();
});

$("filter").addEventListener("input", render);

$("btnVerify").addEventListener("click", async () => {
  clear($("tokenMsg"));
  const r = await api("/api/verify", {});
  if (!r.ok) return say($("tokenMsg"), r.error, "err");
  say($("tokenMsg"), `token ใช้งานได้ (สถานะ: ${r.status})`, "info");
});

$("btnLoad").addEventListener("click", async () => {
  const btn = $("btnLoad");
  btn.disabled = true;
  btn.textContent = "กำลังโหลด…";
  clear($("tokenMsg"));
  const r = await api("/api/zones", {});
  btn.disabled = false;
  btn.textContent = "โหลดโดเมนทั้งหมด";
  if (!r.ok) return say($("tokenMsg"), r.error, "err");

  zones = r.zones;
  $("zonePanel").style.display = zones.length ? "block" : "none";
  const on = zones.filter((z) => z.value === "on").length;
  say($("tokenMsg"), `เจอ ${zones.length} โดเมน · ยังเปิด Email Obfuscation อยู่ ${on}`, "info");
  clear($("zoneMsg"));
  render();
});

$("btnAllOff").addEventListener("click", async () => {
  const targets = zones.filter((z) => z.value === "on" && z.editable !== false);
  if (!targets.length) return;
  if (!confirm(`ปิด Email Address Obfuscation ให้ ${targets.length} โดเมน?`)) return;

  const btn = $("btnAllOff");
  btn.disabled = true;
  const failed = [];
  for (let i = 0; i < targets.length; i++) {
    const zone = targets[i];
    btn.textContent = `กำลังปิด ${i + 1}/${targets.length} — ${zone.name}`;
    const r = await api("/api/setting", { zoneId: zone.id, value: "off" });
    if (r.ok) zone.value = r.value;
    else failed.push(`${zone.name}: ${r.error}`);
    render();
  }
  if (failed.length) say($("zoneMsg"), `ปิดไม่สำเร็จ ${failed.length} รายการ — ${failed.join(" | ")}`, "err");
  else say($("zoneMsg"), `ปิดครบ ${targets.length} โดเมนแล้ว`, "info");
  render();
});

$("btnManual").addEventListener("click", async () => {
  clear($("manualMsg"));
  const zoneId = $("manualZone").value.trim();
  const r = await api("/api/zone", { zoneId });
  if (!r.ok) {
    $("manualTable").style.display = "none";
    return say($("manualMsg"), r.error, "err");
  }
  const z = r.zone;
  $("manualTable").style.display = "table";
  $("manualRows").innerHTML =
    `<tr><td class="dom" style="width:46%">${z.name}</td><td style="width:20%">${badge(z.value)}</td>` +
    `<td style="width:34%"><button class="small" id="manualToggle">${z.value === "on" ? "ปิด" : "เปิดกลับ"}</button></td></tr>`;
  $("manualToggle").addEventListener("click", async () => {
    const btn = $("manualToggle");
    btn.disabled = true;
    const next = z.value === "on" ? "off" : "on";
    const out = await api("/api/setting", { zoneId: z.id, value: next });
    if (!out.ok) return say($("manualMsg"), out.error, "err");
    z.value = out.value;
    $("manualRows").querySelector("td:nth-child(2)").innerHTML = badge(z.value);
    btn.disabled = false;
    btn.textContent = z.value === "on" ? "ปิด" : "เปิดกลับ";
    say($("manualMsg"), `${z.name} → ${z.value === "off" ? "ปิดแล้ว" : "เปิดแล้ว"}`, "info");
  });
});
