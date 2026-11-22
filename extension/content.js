// photos.google.com üzerinde çalışır:
//  - Kütüphane ızgarasını otomatik kaydırıp her öğenin id'sini ve önizleme URL'sini toplar
//  - Sonuç sayfasından gelen "trash" mesajıyla açık fotoğrafı çöp kutusuna taşır
(() => {
  if (window.top !== window) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PHOTO_LINK = 'a[href*="photo/"]';
  // Önizlemeler lh3.googleusercontent.com ya da photos.fife.usercontent.google.com'dan gelir
  const THUMB = '[data-latest-bg], [style*="usercontent"], img[src*="usercontent"]';
  const visible = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

  // ------------------------------------------------------------ ızgaradan veri okuma

  function photoId(a) {
    const m = a.getAttribute("href").match(/photo\/([^/?#]+)/);
    return m && m[1];
  }

  // Öğenin önizleme görselini, komşu öğelere taşmadan, birkaç üst ebeveyne kadar arar.
  function tileInfo(a) {
    let el = a;
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      if (i > 0 && el.querySelectorAll(PHOTO_LINK).length > 1) break;
      const t = el.matches(THUMB) ? el : el.querySelector(THUMB);
      if (!t) continue;
      const src =
        t.getAttribute("data-latest-bg") ||
        (t.tagName === "IMG" ? t.src : (t.style.backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1]);
      if (!src) continue;
      const dur = (el.textContent || "").match(/\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/);
      return { thumb: src, container: el, duration: dur ? toSeconds(dur[0]) : null };
    }
    return null;
  }

  function toSeconds(s) {
    return s.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
  }

  function findScroller() {
    let best = document.scrollingElement;
    let bestH = best.scrollHeight - best.clientHeight;
    for (const el of document.querySelectorAll("div, c-wiz, main")) {
      const extra = el.scrollHeight - el.clientHeight;
      if (extra > bestH + 100 && /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.querySelector(PHOTO_LINK)) {
        best = el;
        bestH = extra;
      }
    }
    return best;
  }

  function accountPrefix() {
    const m = location.pathname.match(/^\/u\/\d+/);
    return m ? m[0] : "";
  }

  // ------------------------------------------------------------ tarama

  let scanning = false;
  let stopRequested = false;

  async function scan(setStatus) {
    scanning = true;
    stopRequested = false;
    const scroller = findScroller();
    const seen = new Map(); // id -> öğe
    let pending = {};
    let order = 0;
    let stuck = 0;

    const flush = async () => {
      if (Object.keys(pending).length) {
        await chrome.storage.local.set(pending);
        pending = {};
      }
    };

    const collect = () => {
      let missing = 0;
      for (const a of document.querySelectorAll(PHOTO_LINK)) {
        const id = photoId(a);
        if (!id || seen.has(id)) continue;
        const info = tileInfo(a);
        if (!info) {
          if (visible(a)) missing++;
          continue;
        }
        const label = a.getAttribute("aria-label") || info.container.getAttribute("aria-label") || "";
        const item = {
          id,
          thumb: info.thumb,
          label,
          video: /video/i.test(label) || info.duration != null,
          duration: info.duration,
          order: order++,
        };
        seen.set(id, item);
        pending["i:" + id] = item;
      }
      return missing;
    };

    await chrome.storage.local.set({ meta: { prefix: accountPrefix(), scannedAt: Date.now(), complete: false } });
    scroller.scrollTop = 0;
    await sleep(1000);

    while (!stopRequested) {
      // Görünen öğelerin önizlemeleri yüklenene kadar biraz bekle
      for (let i = 0; i < 6 && collect() > 0; i++) await sleep(250);
      if (Object.keys(pending).length >= 200) await flush();
      setStatus(`Taranıyor… ${seen.size.toLocaleString("tr-TR")} öğe`);

      const before = scroller.scrollTop;
      scroller.scrollTop = before + scroller.clientHeight * 0.85;
      await sleep(400);
      if (scroller.scrollTop === before) {
        // Sonda olabiliriz ya da Google Fotoğraflar yeni satır yüklüyor olabilir
        if (++stuck >= 8) break;
        await sleep(800);
      } else {
        stuck = 0;
      }
    }
    collect();
    await flush();

    const complete = !stopRequested;
    if (complete) {
      // Tam taramada artık görünmeyen (silinmiş) öğeleri depodan temizle
      const all = await chrome.storage.local.get(null);
      const gone = Object.keys(all).filter((k) => k.startsWith("i:") && !seen.has(k.slice(2)));
      await chrome.storage.local.remove(gone.flatMap((k) => [k, "h:" + k.slice(2), "d:" + k.slice(2)]));
    }
    await chrome.storage.local.set({ meta: { prefix: accountPrefix(), scannedAt: Date.now(), complete } });
    scanning = false;
    return { count: seen.size, complete };
  }

  // ------------------------------------------------------------ çöp kutusuna taşıma

  const DELETE_LABEL = /^(sil|delete|çöp kutusuna taşı|move to trash)$/i;
  const CONFIRM_TEXT = /(çöp kutusuna taşı|move to trash|taşı|^sil$|^delete$)/i;

  async function waitFor(fn, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const r = fn();
      if (r) return r;
      await sleep(150);
    }
    return null;
  }

  function findDeleteButton() {
    return [...document.querySelectorAll('button, [role="button"]')].find(
      (b) => visible(b) && DELETE_LABEL.test((b.getAttribute("aria-label") || "").trim()),
    );
  }

  function findConfirmButton() {
    for (const dlg of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
      if (!visible(dlg)) continue;
      const btn = [...dlg.querySelectorAll('button, [role="button"]')].find(
        (b) => visible(b) && CONFIRM_TEXT.test((b.textContent || b.getAttribute("aria-label") || "").trim()),
      );
      if (btn) return btn;
    }
    return null;
  }

  async function trashCurrent(id) {
    if (!location.pathname.includes(id)) return { ok: false, error: "yanlış sayfa" };
    const del = await waitFor(findDeleteButton, 8000);
    if (del) {
      del.click();
    } else {
      // Yedek: Google Fotoğraflar'ın silme kısayolu (#)
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "#", code: "Digit3", shiftKey: true, keyCode: 51, bubbles: true }));
    }
    const confirm = await waitFor(findConfirmButton, 5000);
    if (!confirm) return { ok: false, error: del ? "onay penceresi çıkmadı" : "silme düğmesi bulunamadı" };
    confirm.click();
    // Başarılı olunca Google Fotoğraflar sonraki fotoğrafa ya da ızgaraya geçer
    const moved = await waitFor(() => !location.pathname.includes(id), 8000);
    return moved ? { ok: true } : { ok: false, error: "silme doğrulanamadı" };
  }

  // ------------------------------------------------------------ toplu çöpe taşıma (ızgaradan)
  // Hedef öğeleri ızgarada seçip tek seferde siler. Her tıklamada Google'ın "N seçildi"
  // sayacının tam 1 arttığı doğrulanır; bir şey tutmazsa seçim temizlenir, hiçbir şey silinmez.

  let bulkStop = false;
  // "3 seçildi", "3 öğe seçili", "3 selected" ... biçimi dile göre değişiyor
  const COUNT_RE = /(\d[\d.,]*)\D{0,15}?(?:seçil|selected)/i;
  // Bir günün bütün fotoğraflarını seçen başlık kutucuğu ("... tüm fotoğrafları seç: Dün")
  const DAY_CHECKBOX = /(tüm|all)\b/i;

  // Google'ın "N seçildi" yazısı; okunamazsa null
  function selectionCount() {
    for (const el of document.querySelectorAll("div, span, h1, h2")) {
      const text = el.textContent;
      if (text.length > 40 || !visible(el)) continue;
      const m = text.trim().match(COUNT_RE);
      if (m) return Number(m[1].replace(/[.,]/g, ""));
    }
    return null;
  }

  function clearSelectionButton() {
    return [...document.querySelectorAll('button, [role="button"]')].find(
      (b) => visible(b) && /(seçimi (temizle|kaldır)|clear selection)/i.test(b.getAttribute("aria-label") || ""),
    );
  }

  const selectionActive = () => Boolean(clearSelectionButton());

  async function clearSelection() {
    const btn = clearSelectionButton();
    if (!btn) return;
    btn.click();
    await waitFor(() => !selectionActive(), 3000);
  }

  const isTileCheckbox = (cb) => !DAY_CHECKBOX.test(cb.getAttribute("aria-label") || "");

  // Öğenin kendi seçim kutucuğu: en yakın ebeveynlerde, komşu öğelere taşmadan aranır
  function tileCheckbox(a) {
    let el = a;
    for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
      if (i > 0 && el.querySelectorAll(PHOTO_LINK).length > 1) break;
      const cb = [el, ...el.querySelectorAll('[role="checkbox"]')].find(
        (c) => c.matches('[role="checkbox"]') && isTileCheckbox(c),
      );
      if (cb) return cb;
    }
    return null;
  }

  // Ekranda işaretli olan fotoğraf kutucukları: kutucuk -> fotoğraf id'si
  function checkedTiles() {
    const ids = [];
    for (const cb of document.querySelectorAll('[role="checkbox"][aria-checked="true"]')) {
      if (!isTileCheckbox(cb)) continue;
      for (let el = cb.parentElement, i = 0; el && i < 5; el = el.parentElement, i++) {
        const links = el.querySelectorAll(PHOTO_LINK);
        if (!links.length) continue;
        if (links.length === 1) ids.push(photoId(links[0]));
        break;
      }
    }
    return ids;
  }

  async function selectTile(a) {
    let cb = tileCheckbox(a);
    if (!cb) {
      // Kutucuk bazen sadece fare üstüne gelince oluşuyor
      for (const t of [a, a.parentElement]) t?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await sleep(200);
      cb = tileCheckbox(a);
    }
    if (!cb) return { ok: false, error: "seçim kutucuğu bulunamadı", html: (a.parentElement?.parentElement?.outerHTML || "").slice(0, 1500) };
    if (cb.getAttribute("aria-checked") === "true") return { ok: true };
    // Tıklamadan sonra ekranda tam olarak bu öğe işaretlenmiş olmalı, başka hiçbir şey değil
    const before = new Set(checkedTiles());
    cb.click();
    if (!(await waitFor(() => cb.getAttribute("aria-checked") === "true", 2000))) {
      return { ok: false, error: "kutucuk işaretlenmedi", buttons: visibleButtonLabels() };
    }
    await sleep(150);
    const added = checkedTiles().filter((id) => !before.has(id));
    const id = photoId(a);
    if (added.length !== 1 || added[0] !== id) {
      cb.click();
      return { ok: false, error: `bir tıklama ${added.length} öğe seçti`, added };
    }
    return { ok: true };
  }

  // Taramada kaydedilen kütüphane sırası: id -> sıra
  async function loadOrders() {
    const all = await chrome.storage.local.get(null);
    const orders = new Map();
    for (const [k, v] of Object.entries(all)) if (k.startsWith("i:")) orders.set(v.id, v.order);
    return orders;
  }

  // Izgarada verilen sıradaki öğeye atlar: ekrandaki öğelerin sırasından ve konumundan
  // "öğe başına piksel" tahmin edip kaydırır; birkaç adımda hedefe yaklaşır.
  async function jumpTo(scroller, orders, target) {
    const isDoc = scroller === document.scrollingElement;
    let pxPerItem = scroller.scrollHeight / Math.max(orders.size, 1);
    let tries = 0;
    for (let attempt = 0; attempt < 15; attempt++) {
      const vis = [];
      for (const a of document.querySelectorAll(PHOTO_LINK)) {
        const o = orders.get(photoId(a));
        if (o != null && visible(a)) vis.push({ o, top: a.getBoundingClientRect().top });
      }
      if (!vis.length) {
        await sleep(300);
        continue;
      }
      vis.sort((x, y) => x.o - y.o);
      const first = vis[0];
      const last = vis[vis.length - 1];
      if (target >= first.o && target <= last.o) {
        // Hedef aralıkta: öğeler yeni çiziliyor olabilir, kısa bir süre bekle
        if (++tries >= 2) return;
        await sleep(300);
        continue;
      }
      if (last.o > first.o && last.top > first.top) pxPerItem = (last.top - first.top) / (last.o - first.o);
      const near = target < first.o ? first : last;
      const viewTop = isDoc ? 0 : scroller.getBoundingClientRect().top;
      let delta = near.top + (target - near.o) * pxPerItem - viewTop - scroller.clientHeight / 2;
      if (Math.abs(delta) < 50) delta = Math.sign(target - near.o) * scroller.clientHeight * 0.5;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + delta;
      if (scroller.scrollTop === before) return; // sayfanın başı/sonu
      await sleep(450);
    }
  }

  async function bulkTrash(ids, report) {
    bulkStop = false;
    const targets = new Set(ids);
    const found = new Set();
    const fail = async (r) => {
      await clearSelection();
      return { ...r, ok: false, trashed: [] };
    };

    await clearSelection();
    const scroller = findScroller();
    const orders = await loadOrders();
    const queue = [...targets].filter((id) => orders.has(id)).sort((a, b) => orders.get(a) - orders.get(b));

    for (const id of queue) {
      if (bulkStop) break;
      if (found.has(id)) continue;
      await jumpTo(scroller, orders, orders.get(id));
      // Hedefe yakın başka hedefler de olabilir: ekrana gelmiş olanların hepsini seç
      for (const a of document.querySelectorAll(PHOTO_LINK)) {
        const aid = photoId(a);
        if (!aid || !targets.has(aid) || found.has(aid) || !visible(a)) continue;
        const r = await selectTile(a);
        if (!r.ok) return fail(r);
        found.add(aid);
        report(found.size, targets.size);
      }
    }
    if (bulkStop) return fail({ error: "durduruldu" });
    const missing = [...targets].filter((id) => !found.has(id));
    if (!found.size) return { ok: true, trashed: [], missing };

    // Son kontrol: ekranda işaretli olanların hepsi hedef olmalı; sayaç okunabiliyorsa o da tutmalı
    const stray = checkedTiles().filter((id) => !found.has(id));
    if (stray.length) return fail({ error: `hedef olmayan ${stray.length} öğe seçili` });
    const count = selectionCount();
    if (count != null && count !== found.size) return fail({ error: `seçili sayı tutmuyor (${count} ≠ ${found.size})` });
    const del = await waitFor(findDeleteButton, 5000);
    if (!del) return fail({ error: "toplu silme düğmesi bulunamadı", buttons: visibleButtonLabels() });
    const clicked = { del: del.getAttribute("aria-label") };
    del.click();
    // Onay penceresi çıkarsa onayla; çıkmadan seçim kalktıysa doğrudan taşınmış demektir
    const confirm = await waitFor(() => findConfirmButton() || (!selectionActive() && "direct"), 5000);
    if (!confirm) return fail({ error: "onay penceresi çıkmadı", ...clicked, buttons: visibleButtonLabels() });
    if (confirm !== "direct") {
      clicked.confirm = (confirm.textContent || confirm.getAttribute("aria-label") || "").trim();
      confirm.click();
    }
    if (!(await waitFor(() => !selectionActive(), 30000))) {
      return { ok: false, error: "silme doğrulanamadı; Google Fotoğraflar'da kontrol et", ...clicked, trashed: [] };
    }

    // Gerçekten silindi mi? Seçilenlerden birkaçının yerine gidip ızgaradan kalktığını doğrula.
    const list = [...found];
    const sample = [...new Set([...list.slice(0, 3), ...list.slice(-3)])];
    for (const id of sample) {
      await jumpTo(scroller, orders, orders.get(id));
      if (!(await waitFor(() => !tileById(id), 6000))) {
        return { ok: false, error: "Google Fotoğraflar silmeyi uygulamadı (öğe hâlâ ızgarada)", ...clicked, trashed: [] };
      }
    }
    return { ok: true, trashed: list, missing, ...clicked };
  }

  const tileById = (id) => document.querySelector(`a[href*="photo/${id}"]`);

  function visibleButtonLabels() {
    return [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .map((b) => b.getAttribute("aria-label") || b.textContent.trim())
      .filter(Boolean)
      .slice(0, 40);
  }

  // ------------------------------------------------------------ tanılama

  function diagnostics() {
    const anchors = [...document.querySelectorAll(PHOTO_LINK)];
    const scroller = findScroller();
    return {
      url: location.href,
      anchors: anchors.length,
      withThumb: anchors.filter((a) => tileInfo(a)).length,
      scroller: `${scroller.tagName}.${[...scroller.classList].join(".")} (${scroller.scrollHeight}px)`,
      samples: anchors.slice(0, 3).map((a) => {
        const info = tileInfo(a);
        return {
          href: a.getAttribute("href"),
          label: a.getAttribute("aria-label"),
          thumb: info?.thumb?.slice(0, 120),
          duration: info?.duration,
          html: (a.parentElement?.parentElement?.outerHTML || "").slice(0, 800),
        };
      }),
      buttons: visibleButtonLabels(),
      selectionCount: selectionCount(),
    };
  }

  // ------------------------------------------------------------ panel

  // Google sayfaları Trusted Types kullanıyor: innerHTML yasak, elemanları tek tek oluştur.
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v);
    }
    el.append(...children);
    return el;
  }

  function buildPanel() {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
    const root = host.attachShadow({ mode: "open" });
    const style = h("style");
    style.textContent = `
        .box { font: 13px/1.4 system-ui, "Segoe UI", sans-serif; background: #fff; color: #1d1d1b;
               border: 1px solid #ddd; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.18);
               padding: 12px; width: 250px; }
        @media (prefers-color-scheme: dark) { .box { background: #252423; color: #ecebe6; border-color: #3a3935; } }
        b { display: block; margin-bottom: 6px; }
        .status { color: #777; margin: 6px 0 8px; min-height: 18px; }
        .row { display: flex; gap: 6px; flex-wrap: wrap; }
        button { font: inherit; border: 1px solid #ccc; background: transparent; color: inherit;
                 border-radius: 8px; padding: 5px 9px; cursor: pointer; }
        button.primary { background: #2f6fde; border-color: #2f6fde; color: #fff; }
        button[hidden] { display: none; }
        .box { position: relative; }
        .min { position: absolute; top: 6px; right: 8px; border: none; padding: 2px 6px; }`;
    const stop = h("button", { "data-stop": "", text: "Durdur" });
    stop.hidden = true;
    root.append(
      style,
      h("div", { class: "box" },
        h("button", { class: "min", title: "Gizle", text: "–" }),
        h("b", { text: `Kopya Bulucu v${chrome.runtime.getManifest().version}` }),
        h("div", { class: "status", text: "Kütüphane sayfasında taramayı başlat." }),
        h("div", { class: "row" },
          h("button", { class: "primary", "data-scan": "", text: "Kopyaları tara" }),
          stop,
          h("button", { "data-results": "", text: "Sonuçlar" }),
          h("button", { "data-diag": "", title: "Sorun olursa bunun çıktısını paylaş", text: "Tanılama" }),
        ),
      ),
    );
    const $ = (s) => root.querySelector(s);
    const setStatus = (t) => ($(".status").textContent = t);

    $("[data-scan]").onclick = async () => {
      $("[data-scan]").hidden = true;
      $("[data-stop]").hidden = false;
      try {
        const r = await scan(setStatus);
        setStatus(r.count
          ? `${r.complete ? "Bitti" : "Durduruldu"}: ${r.count.toLocaleString("tr-TR")} öğe. Sonuçlar'a geç.`
          : "Hiç öğe bulunamadı. Tanılama'ya basıp çıktıyı paylaş.");
      } catch (e) {
        console.error("[Kopya Bulucu]", e);
        setStatus(/context invalidated/i.test(e.message)
          ? "Eklenti yeniden yüklenmiş; sayfayı F5 ile yenile."
          : "Hata: " + e.message);
      } finally {
        scanning = false;
        $("[data-scan]").hidden = false;
        $("[data-stop]").hidden = true;
      }
    };
    $("[data-stop]").onclick = () => (stopRequested = true);
    $("[data-results]").onclick = () => chrome.runtime.sendMessage({ type: "openResults" });
    $("[data-diag]").onclick = async () => {
      const text = JSON.stringify(diagnostics(), null, 2);
      try {
        await navigator.clipboard.writeText(text);
        setStatus("Tanılama panoya kopyalandı, sohbete yapıştır.");
      } catch {
        console.log(text);
        setStatus("Tanılama konsola yazıldı (F12 → Console).");
      }
    };
    $(".min").onclick = () => host.remove();

    document.body.appendChild(host);
    // Tek bir fotoğraf açıkken (ya da silme penceresinde) paneli gizle
    setInterval(() => {
      host.style.display = /\/photo\//.test(location.pathname) && !scanning ? "none" : "";
    }, 500);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ping") {
      sendResponse({ ok: true });
    } else if (msg.type === "trash") {
      trashCurrent(msg.id).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    } else if (msg.type === "bulkTrash") {
      const report = (n, total) => chrome.runtime.sendMessage({ type: "bulkProgress", n, total }).catch(() => {});
      bulkTrash(msg.ids, report).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e), trashed: [] }));
      return true;
    } else if (msg.type === "bulkStop") {
      bulkStop = true;
    } else if (msg.type === "diag") {
      sendResponse(diagnostics());
    }
  });

  if (!new URLSearchParams(location.search).has("kopyabulucu")) buildPanel();
})();
