// Perceptual hash (pHash) ve benzer öğeleri gruplama.
// Hash, 64 bitlik bir parmak izidir: görsel küçültülse ya da yeniden sıkıştırılsa da neredeyse aynı kalır.

const N = 32;
const COS = new Float64Array(8 * N);
for (let k = 0; k < 8; k++) {
  for (let n = 0; n < N; n++) COS[k * N + n] = Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
}

// gray: 32x32 parlaklık değerleri. 2B DCT'nin düşük frekanslı 8x8 kısmını medyana göre bitlere çevirir.
export function phashFromGray(gray) {
  const tmp = new Float64Array(8 * N);
  for (let k = 0; k < 8; k++) {
    for (let x = 0; x < N; x++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += gray[y * N + x] * COS[k * N + y];
      tmp[k * N + x] = s;
    }
  }
  const coef = new Float64Array(64);
  for (let k = 0; k < 8; k++) {
    for (let l = 0; l < 8; l++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += tmp[k * N + x] * COS[l * N + x];
      coef[k * 8 + l] = s;
    }
  }
  const sorted = [...coef].sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 32; i++) {
    if (coef[i] > median) hi |= 1 << (31 - i);
    if (coef[32 + i] > median) lo |= 1 << (31 - i);
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

export async function hashBlob(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(N, N);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, N, N);
    const d = ctx.getImageData(0, 0, N, N).data;
    const gray = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return { hash: phashFromGray(gray), aspect: bmp.width / bmp.height };
  } finally {
    bmp.close();
  }
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

const split = (hex) => [parseInt(hex.slice(0, 8), 16), parseInt(hex.slice(8), 16)];
const distance = (a, b) => popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1]);

class BKTree {
  constructor() {
    this.root = null; // { h, item, children: Map<mesafe, düğüm> }
  }

  add(h, item) {
    if (!this.root) {
      this.root = { h, item, children: new Map() };
      return;
    }
    let node = this.root;
    for (;;) {
      const d = distance(h, node.h);
      const next = node.children.get(d);
      if (!next) {
        node.children.set(d, { h, item, children: new Map() });
        return;
      }
      node = next;
    }
  }

  *query(h, maxd) {
    const stack = this.root ? [this.root] : [];
    while (stack.length) {
      const node = stack.pop();
      const d = distance(h, node.h);
      if (d <= maxd) yield node.item;
      for (const [cd, child] of node.children) if (cd >= d - maxd && cd <= d + maxd) stack.push(child);
    }
  }
}

// items: [{ id, hash, aspect, video, duration, order }]
// Döner: id dizilerinden oluşan gruplar (her grup kütüphane sırasına göre)
export function groupItems(items, threshold) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => parent.set(find(a), find(b));

  const trees = { photo: new BKTree(), video: new BKTree() };
  for (const it of items) {
    parent.set(it.id, it.id);
    const h = split(it.hash);
    const tree = it.video ? trees.video : trees.photo;
    for (const other of tree.query(h, threshold)) {
      const ar = Math.abs(it.aspect - other.aspect) / Math.max(it.aspect, other.aspect);
      if (ar > 0.1) continue; // en-boy oranı çok farklıysa aynı görsel değildir
      if (it.video && it.duration != null && other.duration != null && Math.abs(it.duration - other.duration) > 1) continue;
      union(it.id, other.id);
    }
    tree.add(h, it);
  }

  const byId = new Map(items.map((it) => [it.id, it]));
  const groups = new Map();
  for (const it of items) {
    const r = find(it.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it.id);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => byId.get(a).order - byId.get(b).order))
    .sort((a, b) => byId.get(a[0]).order - byId.get(b[0]).order);
}
