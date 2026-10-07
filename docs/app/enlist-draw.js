/* 魔王軍入隊証の描き方（横長 1200×800・縦長 1024×1536）。
 * 枠の画像（穴の開いた PNG/WebP）の下に写真を敷き、欄に文字を書く。 */
var PenEnlistDraw = (() => {
  const SERIF = '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif JP", "Noto Serif CJK JP", serif';
  const LAYOUTS = {
    land: {
      w: 1200, h: 800, hole: [61, 113, 451, 556],
      fields: {
        name: { box: [626, 341, 941, 385], align: 'center', size: 26 },
        job: { box: [626, 397, 941, 441], align: 'center', size: 26 },
        skill: { box: [626, 453, 941, 497], align: 'center', size: 24, lines: 2 },
        date: { box: [626, 509, 941, 553], align: 'center', size: 24 },
      },
    },
    port: {
      w: 1024, h: 1536, hole: [252, 276, 772, 900], corners: true,
      fields: {
        name: { box: [430, 944, 785, 1004], align: 'left', size: 36 },
        job: { box: [430, 1012, 785, 1072], align: 'left', size: 32 },
        skill: { box: [430, 1080, 785, 1166], align: 'left', size: 28, lines: 2 },
        date: { box: [430, 1176, 690, 1240], align: 'left', size: 32 },
      },
    },
  };
  const loadImg = (src) => new Promise((res) => { if (!src) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });

  /** 文字を欄に収める：まず1行で縮め、それでも入らず lines=2 なら2行に分ける */
  function fitText(ctx, text, f) {
    const [x0, y0, x1, y1] = f.box, w = x1 - x0 - 16, h = y1 - y0;
    const font = (s) => `700 ${s}px ${SERIF}`;
    let s = f.size;
    ctx.font = font(s);
    while (ctx.measureText(text).width > w && s > f.size * 0.7) { s -= 1; ctx.font = font(s); }
    if (ctx.measureText(text).width <= w || !f.lines) {
      while (ctx.measureText(text).width > w && s > 10) { s -= 1; ctx.font = font(s); }
      return { lines: [text], size: s };
    }
    // 2行：なるべく真ん中で分ける
    const chars = [...text];
    let best = null;
    for (let s2 = Math.min(f.size, Math.floor(h / 2.5)); s2 >= 10; s2--) {
      ctx.font = font(s2);
      for (let k = Math.ceil(chars.length / 2), d = 0; d < chars.length; d++) {
        for (const i of [k + d, k - d]) {
          if (i <= 0 || i >= chars.length) continue;
          const a = chars.slice(0, i).join(''), b = chars.slice(i).join('');
          if (ctx.measureText(a).width <= w && ctx.measureText(b).width <= w) { best = { lines: [a, b], size: s2 }; break; }
        }
        if (best) break;
      }
      if (best) return best;
    }
    return { lines: [text], size: 10 };
  }

  /** 写真の四隅の飾り（縦長。元の枠の隅の飾りは写真に重なっていたので、描き直す） */
  function drawCorners(ctx, [x0, y0, x1, y1]) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, '#f3dfa6'); g.addColorStop(0.5, '#b8924a'); g.addColorStop(1, '#6e5222');
    for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
      ctx.save(); ctx.translate(cx, cy); ctx.scale(sx, sy);
      ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 4;
      ctx.strokeStyle = g; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(6, 58); ctx.lineTo(6, 6); ctx.lineTo(58, 6); ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(14, 40); ctx.lineTo(14, 14); ctx.lineTo(40, 14); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(6, 58); ctx.quadraticCurveTo(10, 70, 4, 80); ctx.moveTo(58, 6); ctx.quadraticCurveTo(70, 10, 80, 4); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.translate(22, 22); ctx.rotate(Math.PI / 4);
      const r = ctx.createLinearGradient(-6, -6, 6, 6); r.addColorStop(0, '#ff5a64'); r.addColorStop(1, '#6a0710');
      ctx.fillStyle = r; ctx.fillRect(-6, -6, 12, 12); ctx.strokeStyle = '#e8cf8a'; ctx.lineWidth = 1.2; ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();
    }
  }

  /**
   * @param o.layout 'land' | 'port'
   * @param o.frame  枠の画像（Image）
   * @param o.photo  写真（Image か null）。null なら封蝋の紋章
   * @param o.mark   紋章（Image）
   * @param o.data   { name, job, skill, date }
   * @param o.focus  写真の中心（0〜1。{x, y}）
   */
  function draw(cv, o) {
    const L = LAYOUTS[o.layout];
    const scale = o.scale || 1;
    cv.width = L.w * scale; cv.height = L.h * scale;
    const ctx = cv.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const [hx0, hy0, hx1, hy1] = L.hole, hw = hx1 - hx0, hh = hy1 - hy0;
    // 写真の場所（枠の少し外まで敷いて、すき間が出ないようにする）
    ctx.save();
    ctx.beginPath(); ctx.rect(hx0 - 4, hy0 - 4, hw + 8, hh + 8); ctx.clip();
    if (o.photo) {
      const ir = o.photo.width / o.photo.height, hr = hw / hh;
      let sw, sh;
      if (ir > hr) { sh = o.photo.height; sw = sh * hr; } else { sw = o.photo.width; sh = sw / hr; }
      const fx = o.focus ? o.focus.x : 0.5, fy = o.focus ? o.focus.y : 0.5;
      const sx = Math.max(0, Math.min(o.photo.width - sw, o.photo.width * fx - sw / 2));
      const sy = Math.max(0, Math.min(o.photo.height - sh, o.photo.height * fy - sh / 2));
      ctx.drawImage(o.photo, sx, sy, sw, sh, hx0 - 4, hy0 - 4, hw + 8, hh + 8);
    } else {
      const g = ctx.createRadialGradient(hx0 + hw / 2, hy0 + hh * 0.42, 10, hx0 + hw / 2, hy0 + hh / 2, Math.max(hw, hh) * 0.75);
      g.addColorStop(0, '#3a0a10'); g.addColorStop(1, '#0a0405');
      ctx.fillStyle = g; ctx.fillRect(hx0 - 4, hy0 - 4, hw + 8, hh + 8);
      if (o.mark) { const m = Math.min(hw, hh) * 0.62; ctx.drawImage(o.mark, hx0 + (hw - m) / 2, hy0 + (hh - m) / 2, m, m); }
    }
    ctx.restore();
    if (o.frame) ctx.drawImage(o.frame, 0, 0, L.w, L.h);
    if (L.corners) drawCorners(ctx, L.hole);
    // 欄の文字
    ctx.fillStyle = '#21140f'; ctx.textBaseline = 'middle';
    for (const [k, f] of Object.entries(L.fields)) {
      const text = String((o.data && o.data[k]) || '').trim() || '—';
      const r = fitText(ctx, text, f);
      ctx.font = `700 ${r.size}px ${SERIF}`;
      ctx.textAlign = f.align;
      const [x0, y0, x1, y1] = f.box, cy = (y0 + y1) / 2, lh = r.size * 1.25;
      const x = f.align === 'center' ? (x0 + x1) / 2 : x0 + 4;
      r.lines.forEach((ln, i) => ctx.fillText(ln, x, cy + (i - (r.lines.length - 1) / 2) * lh + 1));
    }
    return cv;
  }
  return { draw, loadImg, LAYOUTS };
})();
if (typeof module !== 'undefined') module.exports = PenEnlistDraw;
