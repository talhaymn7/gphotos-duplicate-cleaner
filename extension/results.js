import { groupItems, hashBlob } from "./hash.js";

const PAGE = 40;
const CONCURRENCY = 8;
const BULK_CHUNK = 500; // hızlı silmede bir seferde seçilecek en fazla öğe
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let items = new Map(); // id -> { ...öğe, hash, aspect, w, h, bytes }
let meta = {};
let allGroups = []; // hassasiyete göre bütün gruplar (güvenlik kontrolleri bunu kullanır)
let groups = []; // filtreden geçip ekranda gösterilenler
let groupOf = new Map(); // id -> grup (id dizisi)
let shown = 0;
let selected = new Set();
let stopRequested = false;
let workerTabId = null;

// lh3 önizleme URL'sindeki boyut parametresini değiştir
const thumbUrl = (url, size) => url.replace(/=[^?]*/, `=w${size}-h${size}`);
const fullUrl = (url) => url.replace(/=[^?]*/, "=w16383-h16383");
const photoUrl = (id) => `https://photos.google.com${meta.prefix || ""}/photo/${id}`;

async function pool(list, n, fn) {
  const queue = [...list];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// ------------------------------------------------------------ yükleme ve hash

async function load() {
  const all = await chrome.storage.local.get(null);
  meta = all.meta || {};
  selected = new Set(all.sel || []);
  items = new Map();
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("i:")) items.set(v.id, { ...v, ...(all["h:" + v.id] || {}), ...(all["d:" + v.id] || {}) });
  }
}

// Önizlemeyi indir: önce oturum çerezleriyle, olmazsa çerezsiz dene
async function fetchImage(url) {
  let lastError;
  for (const credentials of ["include", "omit"]) {
    try {
      const res = await fetch(url, { credentials });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") || "";
      if (!type.startsWith("image/")) throw new Error(`görsel değil (${type || "tür yok"})`);
      return await res.blob();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function hashMissing() {
  const todo = [...items.values()].filter((it) => !it.hash); // hatalı olanlar da yeniden denenir
  if (!todo.length) return;
  const errors = new Map(); // hata mesajı -> adet
  const notice = $("#notice");
  notice.hidden = false;
  const total = todo.length;
  let done = 0;
  let failed = 0;
  let pending = {};
  const start = Date.now();

  const timer = setInterval(async () => {
    const rate = done / Math.max((Date.now() - start) / 1000, 1);
    const eta = Math.ceil((total - done) / Math.max(rate, 0.1) / 60);
    notice.innerHTML = `<b>Önizlemeler inceleniyor…</b> ${done.toLocaleString("tr-TR")} / ${total.toLocaleString("tr-TR")}
      · kalan ~${eta} dk${failed ? ` · ${failed} hata` : ""}<br><progress max="${total}" value="${done}"></progress>`;
    if (Object.keys(pending).length) {
      const batch = pending;
      pending = {};
      await chrome.storage.local.set(batch);
    }
  }, 1000);

  await pool(todo, CONCURRENCY, async (it) => {
    let rec;
    try {
      rec = await hashBlob(await fetchImage(thumbUrl(it.thumb, 256)));
    } catch (e) {
      rec = { error: `${e.name}: ${e.message}` };
      errors.set(rec.error, (errors.get(rec.error) || 0) + 1);
      if (failed++ === 0) console.warn("[Kopya Bulucu] ilk hata", it.thumb, e);
    }
    delete it.error;
    Object.assign(it, rec);
    pending["h:" + it.id] = rec;
    done++;
  });
  clearInterval(timer);
  await chrome.storage.local.set(pending);

  if (failed) {
    const sample = todo.find((it) => it.error)?.thumb || "";
    const list = [...errors].map(([msg, n]) => `<li>${esc(msg)} — ${n} kez</li>`).join("");
    notice.innerHTML = `<b>${failed} / ${total} önizleme indirilemedi.</b> Bu sayfayı yenileyince tekrar denenir.
      <ul>${list}</ul><div style="font-size:12px;word-break:break-all;color:var(--muted)">Örnek link: ${esc(sample.slice(0, 160))}</div>`;
  } else {
    notice.hidden = true;
  }
}

// ------------------------------------------------------------ gerçek çözünürlük

// Görselin boyutu dosyanın başında yazar: tam çözünürlüklü sürümü indirmeye başla,
// boyutu okuyunca indirmeyi kes. Çoğu zaman birkaç KB yeter.
function parseSize(b) {
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }
  if (b[0] === 0x89 && b[1] === 0x50 && b.length >= 24) { // PNG
    const v = new DataView(b.buffer, b.byteOffset);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b.length >= 10) { // GIF
    return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
  }
  return null;
}

async function measure(it) {
  const res = await fetch(fullUrl(it.thumb), { credentials: "include" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const bytes = Number(res.headers.get("content-length")) || null;
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  try {
    while (buf.length < 1 << 20) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
      const size = parseSize(buf);
      if (size) return { ...size, bytes };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { w: 0, h: 0, bytes };
}

async function ensureDims(ids, onProgress) {
  const todo = ids.map((id) => items.get(id)).filter((it) => it && it.w == null);
  let done = 0;
  await pool(todo, 6, async (it) => {
    let rec;
    try {
      rec = await measure(it);
    } catch {
      rec = { w: 0, h: 0, bytes: null };
    }
    Object.assign(it, rec);
    await chrome.storage.local.set({ ["d:" + it.id]: rec });
    updateTile(it.id);
    onProgress?.(++done, todo.length);
  });
}

// En yüksek çözünürlük; eşitse daha büyük dosya; o da eşitse listede ilk olan
function bestOf(ids) {
  const score = (id) => {
    const it = items.get(id);
    return [(it.w || 0) * (it.h || 0), it.bytes || 0];
  };
  return ids.reduce((best, id) => {
    const [a1, a2] = score(id);
    const [b1, b2] = score(best);
    return a1 > b1 || (a1 === b1 && a2 > b2) ? id : best;
  });
}

// ------------------------------------------------------------ çekim zamanı ve grup türü

const MONTHS = {
  oca: 0, şub: 1, sub: 1, mar: 2, nis: 3, may: 4, haz: 5, tem: 6, ağu: 7, agu: 7, eyl: 8, eki: 9, kas: 10, ara: 11,
  jan: 0, feb: 1, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "Fotoğraf - Manzara - 21 Kas 2026 15:53:05" ya da "Photo - Landscape - Nov 21, 2026, 3:53:05 PM"
function labelTime(label) {
  const t = label?.match(/(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?/i);
  if (!t) return null;
  const word = "([A-Za-zÇĞİÖŞÜçğıöşü]{3})[A-Za-zçğıöşü.]*";
  let day, mon, year;
  let m = label.match(new RegExp(`(\\d{1,2})\\s+${word}\\s+(\\d{4})`));
  if (m) [, day, mon, year] = m;
  else if ((m = label.match(new RegExp(`${word}\\s+(\\d{1,2}),?\\s+(\\d{4})`)))) [, mon, day, year] = m;
  else return null;
  const month = MONTHS[mon.toLocaleLowerCase("tr-TR")];
  if (month == null) return null;
  let hour = Number(t[1]) % (t[4] ? 12 : 24);
  if (t[4]?.toUpperCase() === "PM") hour += 12;
  return new Date(Number(year), month, Number(day), hour, Number(t[2]), Number(t[3])).getTime();
}

const KINDS = {
  same: { text: "Aynı anda çekilmiş · büyük ihtimalle kopya", cls: "same" },
  burst: { text: "Seri çekim · farklı kareler olabilir, dikkat", cls: "burst" },
  different: { text: "Farklı zamanlarda · paylaşılmış/indirilmiş kopya olabilir", cls: "different" },
  unknown: { text: "Çekim zamanı okunamadı", cls: "" },
};

function groupKind(ids) {
  const ts = ids.map((id) => labelTime(items.get(id).label));
  if (ts.some((t) => t == null)) return "unknown";
  const span = (Math.max(...ts) - Math.min(...ts)) / 1000;
  if (span === 0) return "same";
  return span <= 60 ? "burst" : "different";
}

// ------------------------------------------------------------ görselleri gösterme

// <img src> ile açılan önizlemeler oturum çerezi taşımadığı için 403 alıyor;
// fetch ile indirip blob URL olarak gösteriyoruz (ekranda görünene kadar beklenir).
const blobUrls = new Set();
const lazy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    lazy.unobserve(e.target);
    showImage(e.target, e.target.dataset.src);
  }
}, { rootMargin: "400px" });

async function showImage(img, url) {
  try {
    const u = URL.createObjectURL(await fetchImage(url));
    blobUrls.add(u);
    img.src = u;
  } catch {
    img.alt = "önizleme yüklenemedi";
  }
}

function openLightbox(it) {
  const box = $("#lightbox");
  const img = document.createElement("img");
  img.alt = "yükleniyor…";
  box.replaceChildren(img);
  box.classList.add("open");
  showImage(img, thumbUrl(it.thumb, 2048));
}

function closeLightbox() {
  const box = $("#lightbox");
  const src = box.querySelector("img")?.src;
  if (src?.startsWith("blob:")) {
    URL.revokeObjectURL(src);
    blobUrls.delete(src);
  }
  box.classList.remove("open");
  box.replaceChildren();
}

// ------------------------------------------------------------ gruplama ve görüntüleme

function regroup() {
  const media = $("#media").value;
  const kind = $("#kind").value;
  const usable = [...items.values()].filter(
    (it) => it.hash && !it.trashed && (media === "all" || (media === "video") === Boolean(it.video)),
  );
  allGroups = groupItems(usable, Number($("#threshold").value));
  groupOf = new Map(allGroups.flatMap((g) => g.map((id) => [id, g])));
  groups = kind === "all" ? allGroups : allGroups.filter((g) => groupKind(g) === kind);
  lazy.disconnect();
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls.clear();
  shown = 0;
  $("#list").innerHTML = "";
  renderMore();
  renderStats();
}

function renderStats() {
  const extra = groups.reduce((n, g) => n + g.length - 1, 0);
  const errors = [...items.values()].filter((it) => it.error).length;
  const when = meta.scannedAt ? new Date(meta.scannedAt).toLocaleString("tr-TR") : "—";
  $("#stats").innerHTML = `
    <span><b>${items.size.toLocaleString("tr-TR")}</b> öğe taranmış</span>
    <span><b>${groups.length.toLocaleString("tr-TR")}</b> kopya grubu</span>
    <span><b>${extra.toLocaleString("tr-TR")}</b> fazlalık</span>
    ${errors ? `<span>${errors} okunamadı</span>` : ""}
    <span title="Son tarama">${when}${meta.complete === false ? " (yarım)" : ""}</span>`;
  $("#trash").disabled = selected.size === 0;
  $("#trash").textContent = `Çöp kutusuna taşı (${selected.size})`;

  if (!items.size) {
    $("#list").innerHTML = `<div class="notice">Henüz tarama yok. <a href="https://photos.google.com/" target="_blank">photos.google.com</a>
      sayfasını aç, sağ alttaki <b>Kopyaları tara</b> düğmesine bas, bitince bu sayfayı yenile.</div>`;
  } else if (!groups.length) {
    $("#list").innerHTML = `<div class="notice">Bu ayarlarla kopya bulunamadı.</div>`;
  }
}

function renderMore() {
  $("#list .more")?.remove();
  for (const g of groups.slice(shown, shown + PAGE)) $("#list").appendChild(renderGroup(g));
  shown = Math.min(shown + PAGE, groups.length);
  if (shown < groups.length) {
    const b = document.createElement("button");
    b.className = "more";
    b.textContent = `Daha fazla göster (${groups.length - shown} grup kaldı)`;
    b.onclick = renderMore;
    $("#list").appendChild(b);
  }
}

function renderGroup(ids) {
  const el = document.createElement("section");
  el.className = "group";
  const video = items.get(ids[0]).video;
  const kind = KINDS[groupKind(ids)];
  el.innerHTML = `
    <div class="group-head">
      <span class="chip">${ids.length} ${video ? "video" : "fotoğraf"}</span>
      ${kind.cls ? `<span class="chip ${kind.cls}">${kind.text}</span>` : ""}
      <span class="spacer"></span>
      <button data-rest>En iyisi hariç seç</button>
      <button data-none>Hiçbiri</button>
    </div>
    <div class="items"></div>`;
  const box = el.querySelector(".items");
  ids.forEach((id) => box.appendChild(renderItem(items.get(id))));
  el.querySelector("[data-rest]").onclick = async () => {
    await ensureDims(ids);
    const best = bestOf(ids);
    setSelected(ids.filter((id) => id !== best), true, [best]);
  };
  el.querySelector("[data-none]").onclick = () => setSelected([], true, ids);
  ensureDims(ids).then(() => ids.forEach(updateTile));
  return el;
}

function renderItem(it) {
  const el = document.createElement("div");
  el.className = "item" + (selected.has(it.id) ? " selected" : "") + (it.trashed ? " trashed" : "");
  el.dataset.id = it.id;
  const dur = it.duration ? ` ${Math.floor(it.duration / 60)}:${String(it.duration % 60).padStart(2, "0")}` : "";
  el.innerHTML = `
    <div class="thumb" title="Seçmek için tıkla">
      <img data-src="${esc(thumbUrl(it.thumb, 360))}" alt="">
      ${it.video ? `<span class="tag">▶${dur}</span>` : ""}
      <button class="zoom" title="Büyük göster">🔍</button>
      <span class="best">tutulacak</span>
      <span class="mark">${it.trashed ? "silindi" : "silinecek"}</span>
    </div>
    <div class="meta">
      <div class="res"></div>
      <div>${esc(it.label || "")}</div>
      <a href="${esc(photoUrl(it.id))}" target="_blank" rel="noopener">Google Fotoğraflar'da aç ↗</a>
    </div>`;
  el.querySelector(".thumb").onclick = () => toggle(it.id);
  el.querySelector(".zoom").onclick = (e) => {
    e.stopPropagation();
    openLightbox(it);
  };
  lazy.observe(el.querySelector("img"));
  fillTile(el, it);
  return el;
}

function fillTile(el, it) {
  const g = groupOf.get(it.id);
  const known = g && g.every((id) => items.get(id).w != null);
  el.classList.toggle("is-best", Boolean(known && bestOf(g) === it.id));
  el.querySelector(".res").textContent =
    it.w == null ? "çözünürlük ölçülüyor…" : it.w ? `${it.w}×${it.h}${it.bytes ? ` · ${(it.bytes / 1e6).toFixed(1)} MB` : ""}` : "çözünürlük okunamadı";
}

function updateTile(id) {
  const el = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  if (el) fillTile(el, items.get(id));
}

function toggle(id) {
  if (!selected.has(id)) {
    const g = groupOf.get(id) || [id];
    if (g.every((x) => x === id || selected.has(x))) {
      flash("Bir gruptaki fotoğrafların hepsi seçilemez, en az biri kalmalı.");
      return;
    }
  }
  setSelected([id], !selected.has(id));
}

function flash(text) {
  $("#log").textContent = text;
  setTimeout(() => $("#log").textContent === text && ($("#log").textContent = ""), 4000);
}

// on=true ise ids seçilir; offIds varsa onlar seçimden çıkarılır
async function setSelected(ids, on, offIds = []) {
  for (const id of ids) on ? selected.add(id) : selected.delete(id);
  for (const id of offIds) selected.delete(id);
  for (const id of [...ids, ...offIds]) {
    document.querySelector(`.item[data-id="${CSS.escape(id)}"]`)?.classList.toggle("selected", selected.has(id));
  }
  await chrome.storage.local.set({ sel: [...selected] });
  renderStats();
}

// ------------------------------------------------------------ çöp kutusuna taşıma

function navigate(tabId, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("sayfa yüklenemedi"));
    }, 30000);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

async function sendWithRetry(tabId, msg) {
  for (let i = 0; i < 20; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      await sleep(500); // içerik betiği henüz yüklenmemiş
    }
  }
  return { ok: false, error: "sayfayla bağlantı kurulamadı" };
}

async function markTrashed(ids) {
  for (const id of ids) {
    selected.delete(id);
    const it = items.get(id);
    if (it) it.trashed = true;
    const el = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
    if (el) {
      el.classList.remove("selected");
      el.classList.add("trashed");
      el.querySelector(".mark").textContent = "silindi";
    }
  }
  await chrome.storage.local.remove(ids.flatMap((id) => ["i:" + id, "h:" + id, "d:" + id]));
  await chrome.storage.local.set({ sel: [...selected] });
}

// Hızlı: kütüphane ızgarasında hedefleri seçip toplu siler (BULK_CHUNK'lık parçalar halinde)
async function trashFast(ids) {
  const ordered = [...ids].sort((a, b) => (items.get(a)?.order ?? 0) - (items.get(b)?.order ?? 0));
  let trashed = 0;
  const onMsg = (m) => {
    if (m.type === "bulkProgress") $("#log").textContent = `Izgarada seçiliyor… ${m.n} / ${m.total} (taşınan: ${trashed})`;
  };
  chrome.runtime.onMessage.addListener(onMsg);
  try {
    for (let i = 0; i < ordered.length && !stopRequested; i += BULK_CHUNK) {
      const chunk = ordered.slice(i, i + BULK_CHUNK);
      await navigate(workerTabId, `https://photos.google.com${meta.prefix || ""}/?kopyabulucu=1`);
      const res = await sendWithRetry(workerTabId, { type: "bulkTrash", ids: chunk });
      console.info("[Kopya Bulucu] toplu silme sonucu", res);
      await markTrashed(res.trashed || []);
      trashed += (res.trashed || []).length;
      if (!res.ok) return { trashed, error: res };
      if (!res.trashed.length) return { trashed, error: { error: "ızgarada hiçbir hedef bulunamadı" } };
    }
    return { trashed };
  } finally {
    chrome.runtime.onMessage.removeListener(onMsg);
  }
}

// Yavaş ama basit: her öğeyi açıp tek tek çöp kutusuna taşır
async function trashSlow(ids) {
  let trashed = 0;
  const failures = [];
  for (const [i, id] of ids.entries()) {
    if (stopRequested) break;
    $("#log").textContent = `${i + 1} / ${ids.length} taşınıyor… (${trashed} başarılı, ${failures.length} hata)`;
    let res;
    try {
      await navigate(workerTabId, photoUrl(id) + "?kopyabulucu=1");
      res = await sendWithRetry(workerTabId, { type: "trash", id });
    } catch (e) {
      res = { ok: false, error: String(e.message || e) };
    }
    if (res.ok) {
      trashed++;
      await markTrashed([id]);
    } else {
      failures.push(`${id}: ${res.error}`);
      // İlk öğeler peş peşe başarısızsa sayfa yapısı tutmuyor demektir; boşuna devam etme
      if (trashed === 0 && failures.length >= 3) break;
    }
  }
  return { trashed, failures };
}

async function trashSelected() {
  // Güvenlik: her gruptan en az bir öğe kalmalı (filtrede görünmeyen gruplar dahil)
  const wholeGroups = allGroups.filter((g) => g.every((id) => selected.has(id)));
  if (wholeGroups.length) {
    alert(`${wholeGroups.length} grupta bütün öğeler seçili. Her gruptan en az birini bırak, sonra tekrar dene.`);
    return;
  }
  const ids = [...selected];
  if (!ids.length) return;
  const fast = $("#trash-mode").value === "fast";
  if (!confirm(`${ids.length} öğe Google Fotoğraflar'da çöp kutusuna taşınacak (60 gün içinde geri alınabilir).\n\n` +
               `Açılacak pencereyi işlem bitene kadar kapatma, küçültme ve içinde gezinme. Devam?`)) return;

  stopRequested = false;
  $("#trash").disabled = true;
  $("#stop").hidden = false;
  const win = await chrome.windows.create({ url: "https://photos.google.com/?kopyabulucu=1", type: "popup", width: 1000, height: 760 });
  workerTabId = win.tabs[0].id;
  let total = 0;
  let message = "";

  try {
    if (fast) {
      const r = await trashFast(ids);
      total += r.trashed;
      if (r.error && !stopRequested) {
        console.warn("[Kopya Bulucu] hızlı silme hatası", r.error);
        try {
          await navigator.clipboard.writeText(JSON.stringify(r.error, null, 2));
        } catch {}
        const rest = [...selected];
        if (rest.length && confirm(`Hızlı yöntem durdu: ${r.error.error}\n(Ayrıntılar panoya kopyalandı.)\n\n` +
                                   `Kalan ${rest.length} öğe için tek tek yönteme geçilsin mi?`)) {
          const s = await trashSlow(rest);
          total += s.trashed;
          if (s.failures.length) message = `, ${s.failures.length} hata`;
        } else {
          message = ` — hızlı yöntem durdu: ${r.error.error}`;
        }
      }
    } else {
      const s = await trashSlow(ids);
      total += s.trashed;
      if (s.failures.length) {
        message = `, ${s.failures.length} hata`;
        console.warn("Taşınamayanlar:\n" + s.failures.join("\n"));
        if (!s.trashed) {
          alert("Silme düğmesi bulunamadı ya da çalışmadı. Bir fotoğrafı Google Fotoğraflar'da aç, " +
                "paneldeki Tanılama'yı çalıştır ve çıktıyı paylaş.\n\nİlk hata: " + s.failures[0]);
        }
      }
    }
  } finally {
    chrome.windows.remove(win.id).catch(() => {});
    workerTabId = null;
    $("#stop").hidden = true;
  }
  $("#log").textContent = `${total} öğe çöp kutusuna taşındı${message}.`;
  renderStats();
}

// ------------------------------------------------------------ başlat

$("#threshold").oninput = () => ($("#threshold-val").textContent = $("#threshold").value);
$("#threshold").onchange = regroup;
$("#media").onchange = regroup;
$("#kind").onchange = regroup;
$("#select-all").onclick = async () => {
  const all = groups.flat();
  $("#select-all").disabled = true;
  await ensureDims(all, (d, n) => ($("#log").textContent = `Çözünürlükler ölçülüyor… ${d} / ${n}`));
  $("#select-all").disabled = false;
  $("#log").textContent = "";
  const best = groups.map(bestOf);
  const keep = new Set(best);
  await setSelected(all.filter((id) => !keep.has(id)), true, best);
  all.forEach(updateTile);
};
$("#clear").onclick = () => setSelected([], true, [...selected]);
$("#trash").onclick = trashSelected;
$("#stop").onclick = () => {
  stopRequested = true;
  if (workerTabId) chrome.tabs.sendMessage(workerTabId, { type: "bulkStop" }).catch(() => {});
};
$("#lightbox").onclick = closeLightbox;
document.addEventListener("keydown", (e) => e.key === "Escape" && closeLightbox());

$("h1").textContent += ` v${chrome.runtime.getManifest().version}`;
await load();
renderStats();
await hashMissing();
regroup();
