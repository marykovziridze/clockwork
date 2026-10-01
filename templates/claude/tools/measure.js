// Clockwork measure kit: browser-side measuring functions for chrome-devtools `evaluate_script`.
// Why: layout, contrast and image claims count only when read from the running page (computed
// style, text ink, served pixels), never from class names or source (lessons L54-L63, L90, L99).
// No dependencies. Plain script (no import/export) so its text can be pasted into a function.
//
// Install once per page load (navigation wipes it):
//   evaluate_script  function: "() => { <paste this whole file>; return Object.keys(window.__cw) }"
// Then call:          function: "() => window.__cw.overflowScan({ expectWidth: 390 })"
// If window.__cw is undefined, you navigated: install again. Every result carries `stamp` and
// `harnessOk`; a result whose harnessOk is false is a claim about the browser, not the page.
// Node: require() this file (or run it in node:vm) to unit-test the pure helpers.
var CW = (function () {
  // ---------- pure helpers (unit-tested in node) ----------
  // Widths table (L59): ~12 widths. 1710 = a 13" laptop.
  // Add your own monitor's width to the design-system widths row.
  // dpr values are instrument assumptions (phones 3, tablet/laptop 2, external monitors 1).
  var widthsTable = [
    { width: 320, dpr: 3, mobile: true, why: 'WCAG 2.2 1.4.10 reflow width' },
    { width: 360, dpr: 3, mobile: true, why: 'small Android' },
    { width: 390, dpr: 3, mobile: true, why: 'iPhone' },
    { width: 430, dpr: 3, mobile: true, why: 'large phone' },
    { width: 768, dpr: 2, mobile: true, why: 'tablet portrait' },
    { width: 1024, dpr: 2, mobile: false, why: 'tablet landscape / small laptop' },
    { width: 1280, dpr: 2, mobile: false, why: 'laptop' },
    { width: 1440, dpr: 2, mobile: false, why: 'laptop' },
    { width: 1536, dpr: 1, mobile: false, why: 'common Windows laptop' },
    { width: 1710, dpr: 2, mobile: false, why: '13" laptop' },
    { width: 1920, dpr: 1, mobile: false, why: 'desktop monitor' },
    { width: 2560, dpr: 1, mobile: false, why: 'large monitor' },
  ];
  // Viewport string for chrome-devtools `emulate` (device metrics, never window resize: L62).
  function viewportFor(width, height) {
    var row = widthsTable.filter(function (r) { return r.width === width; })[0] || { dpr: width < 768 ? 3 : 2, mobile: width < 1024 };
    var h = height || (row.mobile ? Math.round(width * 2.16) : Math.round(width * 0.5625));
    return width + 'x' + h + 'x' + row.dpr + (row.mobile ? ',mobile,touch' : '');
  }

  function clamp01(x) { return Math.min(1, Math.max(0, x)); }
  function num(s, pctScale) {
    s = String(s).trim();
    if (s === 'none') return 0;
    if (s.slice(-1) === '%') return parseFloat(s) / 100 * (pctScale == null ? 1 : pctScale);
    return parseFloat(s);
  }
  function encode(c) { c = clamp01(c); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); }
  function decode(c) { c = clamp01(c); return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  // OKLab -> sRGB (Bjorn Ottosson's matrices; Tailwind v4 computed colours are oklch()).
  function oklabToRgb(L, a, b) {
    var l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    var m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    var s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [
      encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  }
  // Parse a CSS colour string to {r,g,b,a} (0-255, a 0-1). Returns null for formats it cannot
  // read (lab, lch, color-mix): the browser path then converts through a canvas.
  function parseColor(str) {
    if (str == null) return null;
    if (typeof str === 'object' && 'r' in str) return str;
    var s = String(str).trim().toLowerCase();
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    var hex = s.match(/^#([0-9a-f]{3,8})$/);
    if (hex) {
      var h = hex[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    var fn = s.match(/^([a-z-]+)\((.*)\)$/);
    if (!fn) return null;
    var parts = fn[2].replace(/,/g, ' ').replace('/', ' / ').split(/\s+/).filter(Boolean);
    var alpha = 1, slash = parts.indexOf('/');
    if (slash >= 0) { alpha = num(parts[slash + 1]); parts = parts.slice(0, slash); }
    else if ((fn[1] === 'rgba' || fn[1] === 'rgb') && parts.length === 4) { alpha = num(parts[3]); parts = parts.slice(0, 3); }
    var rgb;
    if (fn[1] === 'rgb' || fn[1] === 'rgba') rgb = parts.map(function (p) { return num(p, 255); });
    else if (fn[1] === 'oklab') rgb = oklabToRgb(num(parts[0]), num(parts[1], 0.4), num(parts[2], 0.4));
    else if (fn[1] === 'oklch') {
      var hr = num(parts[2]) * Math.PI / 180, C = num(parts[1], 0.4);
      rgb = oklabToRgb(num(parts[0]), C * Math.cos(hr), C * Math.sin(hr));
    } else if (fn[1] === 'color' && parts[0] === 'srgb') rgb = parts.slice(1, 4).map(function (p) { return num(p) * 255; });
    else if (fn[1] === 'color' && parts[0] === 'srgb-linear') rgb = parts.slice(1, 4).map(function (p) { return encode(num(p)); });
    else if (fn[1] === 'color' && parts[0] === 'display-p3') {
      var p = parts.slice(1, 4).map(function (v) { return decode(num(v)); });
      rgb = [encode(1.2249401 * p[0] - 0.2249404 * p[1]), encode(-0.0420569 * p[0] + 1.0420571 * p[1]),
        encode(-0.0196376 * p[0] - 0.0786361 * p[1] + 1.0982735 * p[2])];
    } else return null;
    if (rgb.length < 3 || rgb.some(function (v) { return isNaN(v); }) || isNaN(alpha)) return null;
    return { r: Math.max(0, Math.min(255, rgb[0])), g: Math.max(0, Math.min(255, rgb[1])), b: Math.max(0, Math.min(255, rgb[2])), a: clamp01(alpha) };
  }
  // Paint `top` over `bottom` (source-over).
  function composite(top, bottom) {
    var a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    function ch(k) { return (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a; }
    return { r: ch('r'), g: ch('g'), b: ch('b'), a: a };
  }
  // WCAG 2.2 relative luminance and contrast ratio (https://www.w3.org/TR/WCAG22/#dfn-relative-luminance).
  function relativeLuminance(c) {
    c = parseColor(c);
    return 0.2126 * decode(c.r / 255) + 0.7152 * decode(c.g / 255) + 0.0722 * decode(c.b / 255);
  }
  function contrastRatio(fg, bg) {
    var b = parseColor(bg), f = parseColor(fg);
    if (!b || !f) return null;
    if (b.a < 1) b = composite(b, { r: 255, g: 255, b: 255, a: 1 }); // unknown base: assume white
    if (f.a < 1) f = composite(f, b);
    var l1 = relativeLuminance(f), l2 = relativeLuminance(b);
    return Math.round((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) * 100) / 100;
  }
  // WCAG large text: >= 18pt (24px) or >= 14pt (18.66px) bold. AA needs 3:1 large, 4.5:1 otherwise.
  function requiredContrast(fontSizePx, fontWeight) {
    var large = fontSizePx >= 24 || (Number(fontWeight) >= 700 && fontSizePx >= 18.66);
    return large ? 3 : 4.5;
  }
  // Width the image content is drawn at (CSS px) inside its box, per object-fit.
  function drawnImageWidth(iw, ih, boxW, boxH, fit) {
    if (!iw || !ih) return boxW;
    var contain = Math.min(boxW / iw, boxH / ih), cover = Math.max(boxW / iw, boxH / ih);
    if (fit === 'cover') return iw * cover;
    if (fit === 'contain') return iw * contain;
    if (fit === 'none') return iw;
    if (fit === 'scale-down') return Math.min(iw, iw * contain);
    return boxW; // fill
  }
  // Resolution: served file pixels / (drawn CSS width x dpr). >= 1 is sharp at this dpr (L99).
  function resolution(servedPx, drawnCssW, dpr) {
    if (!servedPx || !drawnCssW) return null;
    return { perDevicePx: Math.round(servedPx / (drawnCssW * (dpr || 1)) * 100) / 100, perCssPx: Math.round(servedPx / drawnCssW * 100) / 100 };
  }
  // Baseline helpers (design-system.md BL rows). Side gutter by Material 3 breakpoint: compact (< 600) 16,
  // medium and wider 24 (m3.material.io/foundations/layout/breakpoints/compact, /medium, /expanded, /large-extra-large).
  function gutterFor(width) { return width < 600 ? 16 : 24; }
  function onGrid(px, base) { var r = Math.abs(px) / (base || 4); return Math.abs(r - Math.round(r)) < 0.01; }
  // Characters per rendered line: text length over line count (ink height / line height).
  function charsPerLine(chars, inkHeight, lineHeightPx) {
    if (!lineHeightPx || !inkHeight) return null;
    return Math.round(chars / Math.max(1, Math.round(inkHeight / lineHeightPx)));
  }
  // Pixels of height a drawn image is off its file's proportions. object-fit other than fill crops or letterboxes: 0.
  function stretchPx(nw, nh, bw, bh, fit) {
    if (!nw || !nh || !bw || !bh) return null;
    if (fit && fit !== 'fill') return 0;
    return Math.round(Math.abs(bh - bw * nh / nw) * 10) / 10;
  }
  // Judge a harness stamp (L14, L54): visible tab, the width we asked for, fonts done, page loaded.
  function harnessVerdict(st, expect) {
    expect = expect || {};
    var reasons = [];
    if (st.visibilityState !== 'visible') reasons.push('visibilityState=' + st.visibilityState + ' (animations, layout and scroll are frozen)');
    if (expect.expectWidth && st.innerWidth !== expect.expectWidth) reasons.push('innerWidth ' + st.innerWidth + ' != expected ' + expect.expectWidth);
    if (expect.expectUrl && st.href.indexOf(expect.expectUrl) !== 0) reasons.push('href ' + st.href + ' is not ' + expect.expectUrl);
    if (st.readyState !== 'complete') reasons.push('readyState=' + st.readyState);
    if (st.fonts && st.fonts !== 'loaded') reasons.push('fonts ' + st.fonts + ' (text widths not final)');
    if (st.rect && !(st.rect.w > 0 && st.rect.h > 0)) reasons.push('zero rect for ' + st.rect.selector + ' (a failed read, not a measurement)');
    return { ok: reasons.length === 0, reasons: reasons };
  }

  // ---------- browser-side ----------
  function stamp(rectSelector) {
    var s = {
      href: location.href, visibilityState: document.visibilityState, hasFocus: document.hasFocus(),
      innerWidth: window.innerWidth, clientWidth: document.documentElement.clientWidth,
      dpr: window.devicePixelRatio, readyState: document.readyState,
      fonts: document.fonts ? document.fonts.status : 'unknown',
    };
    if (rectSelector) {
      var el = document.querySelector(rectSelector), r = el && el.getBoundingClientRect();
      s.rect = { selector: rectSelector, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 };
    }
    return s;
  }
  function wrap(opts, body) {
    opts = opts || {};
    var st = stamp(opts.rectSelector || 'body'), v = harnessVerdict(st, opts);
    body.stamp = st; body.harnessOk = v.ok; body.harnessReasons = v.reasons;
    return body;
  }
  function describe(el) {
    if (!el || !el.tagName) return String(el);
    var d = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
    var cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    var parent = el.parentElement, idx = parent ? Array.prototype.indexOf.call(parent.children, el) + 1 : 1;
    return (parent && parent !== document.body ? describe(parent).split(' > ').pop() + ' > ' : '') + d + (cls ? '.' + cls : '') + ':nth-child(' + idx + ')';
  }
  function box(r) { return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
  function all(selector, limit) { return Array.prototype.slice.call(document.querySelectorAll(selector), 0, limit || 50); }
  function visible(el) {
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  function textInk(el, ownOnly) { // union of painted text boxes (all descendants, or el's own text nodes)
    var rects = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) {
      if (!n.nodeValue.trim() || (ownOnly && n.parentNode !== el)) continue;
      var rg = document.createRange(); rg.selectNodeContents(n);
      Array.prototype.forEach.call(rg.getClientRects(), function (r) { if (r.width > 0) rects.push(r); });
    }
    if (!rects.length) return null;
    var l = Math.min.apply(null, rects.map(function (r) { return r.left; })), t = Math.min.apply(null, rects.map(function (r) { return r.top; }));
    var rr = Math.max.apply(null, rects.map(function (r) { return r.right; })), b = Math.max.apply(null, rects.map(function (r) { return r.bottom; }));
    return { x: Math.round(l), y: Math.round(t), w: Math.round(rr - l), h: Math.round(b - t), right: Math.round(rr), bottom: Math.round(b) };
  }
  function toRgba(str) {
    var c = parseColor(str);
    if (c) return c;
    var cv = document.createElement('canvas'); cv.width = cv.height = 1;
    var ctx = cv.getContext('2d'); ctx.fillStyle = str; ctx.fillRect(0, 0, 1, 1);
    var d = ctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  }

  function harness(opts) {
    opts = opts || {};
    var out = wrap(opts, {});
    var html = document.documentElement.outerHTML;
    out.mustContain = (opts.mustContain || []).map(function (m) { return { marker: m, found: html.indexOf(m) >= 0 }; });
    out.mustNotContain = (opts.mustNotContain || []).map(function (m) { return { marker: m, found: html.indexOf(m) >= 0 }; });
    out.markersOk = out.mustContain.every(function (m) { return m.found; }) && out.mustNotContain.every(function (m) { return !m.found; });
    return out;
  }

  var DEFAULT_PROPS = ['display', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color',
    'background-color', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-bottom',
    'gap', 'border-radius', 'width', 'height', 'max-width', 'opacity', 'transform', 'translate'];
  function styles(selector, props, opts) {
    opts = opts || {};
    props = props && props.length ? props : DEFAULT_PROPS;
    var els = all(selector, opts.limit);
    var items = els.map(function (el) {
      var cs = getComputedStyle(el, opts.pseudo || null), values = {};
      props.forEach(function (p) { values[p] = cs.getPropertyValue(p); });
      return { el: describe(el), rect: box(el.getBoundingClientRect()), ink: textInk(el), visible: visible(el), values: values };
    });
    var body = { selector: selector, count: document.querySelectorAll(selector).length, measured: items.length, items: items };
    if (!body.count) body.note = '0 matches: a failed read, not a pass';
    return wrap(opts, body);
  }

  // Vertical distance between two elements; ink:true measures painted text, not boxes (L56).
  function gap(selA, selB, opts) {
    opts = opts || {};
    var a = document.querySelector(selA), b = document.querySelector(selB);
    if (!a || !b) return wrap(opts, { note: 'missing element: ' + (!a ? selA : selB) });
    var ra = opts.ink ? textInk(a) : box(a.getBoundingClientRect()), rb = opts.ink ? textInk(b) : box(b.getBoundingClientRect());
    if (!ra || !rb) return wrap(opts, { note: 'no text ink to measure' });
    return wrap(opts, { a: ra, b: rb, vertical: rb.y - (ra.y + ra.h), horizontal: rb.x - (ra.x + ra.w), leftEdgeDelta: rb.x - ra.x, method: opts.ink ? 'ink' : 'box' });
  }

  // Walk ancestors once: nearest clipping box (root clippers html/body count as the viewport)
  // and whether the element sits in a position:fixed layer (fixed layers never scroll the page).
  function context(el, includeSelf) {
    var clip = null, fixed = false;
    for (var p = includeSelf ? el : el.parentElement; p; p = p.parentElement) {
      var cs = getComputedStyle(p);
      if (cs.position === 'fixed') fixed = true;
      var o = cs.overflowX;
      if (!clip && p !== document.body && p !== document.documentElement && (o === 'hidden' || o === 'clip' || o === 'auto' || o === 'scroll')) clip = p;
    }
    return { clip: clip, fixed: fixed };
  }
  // Horizontal overflow and clipped text. Measures each element's own text ink against its clipping
  // box, because a page-level scrollWidth check passes while text is visibly cut (Verification §25).
  function overflowScan(opts) {
    opts = opts || {};
    var tol = opts.tolerance == null ? 1 : opts.tolerance, limit = opts.limit || 25;
    var de = document.documentElement, vw = de.clientWidth;
    var rootClips = [de, document.body].some(function (e) { var o = getComputedStyle(e).overflowX; return o === 'hidden' || o === 'clip'; });
    var page = { scrollWidth: de.scrollWidth, clientWidth: vw, overflowPx: Math.max(0, de.scrollWidth - vw),
      rootHidesOverflow: rootClips };
    var beyond = [], cut = [], fullyHidden = 0, scanned = 0, textEls = 0;
    all('body *', 20000).forEach(function (el) {
      if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|BR|WBR)$/.test(el.tagName)) return;
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      if (getComputedStyle(el).visibility === 'hidden') return;
      scanned++;
      var cx = context(el, false);
      var moving = !!(el.getAnimations && el.getAnimations().length); // mid-animation: re-read at rest
      if (!cx.fixed && !cx.clip && (r.right - vw > tol || -r.left > tol)) beyond.push({ el: describe(el), rect: box(r), overBy: Math.round(Math.max(r.right - vw, -r.left)), animating: moving });
      var ink = textInk(el, true);
      if (!ink) return;
      textEls++;
      var tc = context(el, true), cr = tc.clip ? tc.clip.getBoundingClientRect() : { left: 0, right: vw, width: vw };
      if (cr.width <= 1) return; // visually-hidden (sr-only) text
      if (ink.x >= cr.right || ink.right <= cr.left) { fullyHidden++; return; } // e.g. off-screen carousel slide
      var by = Math.max(ink.right - cr.right, cr.left - ink.x);
      if (by > tol) cut.push({ el: describe(el), text: el.textContent.trim().slice(0, 40), inkRight: ink.right, clipRight: Math.round(cr.right), cutBy: Math.round(by), clippedBy: tc.clip ? describe(tc.clip) : 'viewport', animating: moving });
    });
    var body = { page: page, coverage: { elements: scanned, textElements: textEls }, beyondViewport: beyond.slice(0, limit),
      beyondCount: beyond.length, textCut: cut.slice(0, limit), textCutCount: cut.length, fullyHiddenText: fullyHidden,
      ok: page.overflowPx <= tol && !beyond.length && !cut.length, notChecked: ['vertical clipping / line-clamp', 'canvas and SVG text', 'content inside fixed layers'] };
    return wrap(opts, body);
  }

  // Contrast from computed colours of the layers actually painted under the text
  // (elementsFromPoint). Images, gradients, filters or blend modes under the text => needsPixelCheck:
  // measure those from two screenshots instead (ink shown, ink hidden via hideInk) (L90).
  function renderedContrast(selector, opts) {
    opts = opts || {};
    var sx = window.scrollX, sy = window.scrollY, items = [];
    all(selector, opts.limit || 40).forEach(function (el) {
      if (!visible(el)) return;
      if (opts.scroll !== false) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      var ink = textInk(el);
      if (!ink) return;
      var x = ink.x + Math.min(ink.w / 2, 4), y = ink.y + ink.h / 2;
      var stack = document.elementsFromPoint(x, y), i = stack.indexOf(el), why = [];
      if (i < 0) { items.push({ el: describe(el), note: 'element not under its own text point (covered or offscreen)', reliable: false }); return; }
      if (i > 0 && !el.contains(stack[0])) why.push('covered by ' + describe(stack[0]));
      var cs = getComputedStyle(el), opacity = 1;
      for (var p = el; p; p = p.parentElement) opacity *= parseFloat(getComputedStyle(p).opacity);
      var fg = toRgba(cs.color); fg.a *= opacity;
      var layers = [];
      for (var k = i; k < stack.length; k++) {
        var lc = getComputedStyle(stack[k]);
        if (/^(IMG|VIDEO|CANVAS|PICTURE|IFRAME|svg)$/.test(stack[k].tagName)) why.push('image/media under text: ' + describe(stack[k]));
        if (lc.backgroundImage !== 'none') why.push('background-image under text: ' + describe(stack[k]));
        if (lc.filter !== 'none' || lc.mixBlendMode !== 'normal' || (lc.backdropFilter && lc.backdropFilter !== 'none')) why.push('filter/blend on ' + describe(stack[k]));
        var bc = toRgba(lc.backgroundColor);
        if (bc.a > 0) layers.push(bc);
        if (bc.a >= 1) break;
      }
      var bg = { r: 255, g: 255, b: 255, a: 1 };
      for (var j = layers.length - 1; j >= 0; j--) bg = composite(layers[j], bg);
      var size = parseFloat(cs.fontSize), req = requiredContrast(size, cs.fontWeight), ratio = contrastRatio(fg, bg);
      items.push({ el: describe(el), text: el.textContent.trim().slice(0, 40), fg: cs.color, opacity: Math.round(opacity * 100) / 100,
        bg: 'rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(', ') + ')', fontSize: size, fontWeight: cs.fontWeight,
        ratio: why.length ? null : ratio, required: req, pass: why.length ? null : ratio >= req, reliable: why.length === 0, needsPixelCheck: why.length > 0, why: why });
    });
    if (opts.scroll !== false) window.scrollTo(sx, sy);
    var measured = items.filter(function (it) { return it.ratio != null; });
    return wrap(opts, { selector: selector, method: 'computed layers under the text point', measured: measured.length,
      failing: measured.filter(function (it) { return !it.pass; }).length, unreliable: items.filter(function (it) { return !it.reliable; }).length, items: items });
  }
  // Toggle painted text off for the two-screenshot contrast method (screenshot, hideInk, screenshot).
  function hideInk(selector, on) {
    var id = 'cw-hide-ink', s = document.getElementById(id);
    if (on === false) { if (s) s.remove(); return { hidden: false }; }
    if (!s) { s = document.createElement('style'); s.id = id; document.head.appendChild(s); }
    s.textContent = selector + ', ' + selector + ' * { color: transparent !important; text-shadow: none !important; -webkit-text-stroke: 0 !important; }';
    return { hidden: true, selector: selector };
  }

  // Served pixels vs drawn size for every <img> (L99). Loads each currentSrc into a fresh Image, whose
  // naturalWidth is the file's real pixel width (the element's own naturalWidth is density-corrected).
  async function imageResolution(opts) {
    opts = opts || {};
    var min = opts.min == null ? 1 : opts.min, dpr = window.devicePixelRatio, items = [];
    var imgs = all(opts.selector || 'img', opts.limit || 60);
    for (var i = 0; i < imgs.length; i++) {
      var el = imgs[i], r = el.getBoundingClientRect(), src = el.currentSrc || el.src;
      var it = { el: describe(el), src: String(src).slice(-80), box: box(r) };
      if (!r.width || !visible(el)) { it.note = 'not drawn'; items.push(it); continue; }
      if (!el.complete || !el.naturalWidth) { it.note = 'not loaded (lazy? scroll to it first)'; items.push(it); continue; }
      if (/\.svg(\?|#|$)|^data:image\/svg/.test(src)) { it.note = 'svg: resolution rule does not apply'; items.push(it); continue; }
      var served = await new Promise(function (res) {
        var im = new Image(), t = setTimeout(function () { res(0); }, 5000);
        im.onload = function () { clearTimeout(t); res(im.naturalWidth); }; im.onerror = function () { clearTimeout(t); res(0); };
        im.src = src;
      });
      var fit = getComputedStyle(el).objectFit, drawn = drawnImageWidth(el.naturalWidth, el.naturalHeight, r.width, r.height, fit);
      var res = resolution(served, drawn, dpr);
      it.servedPx = served; it.drawnCssW = Math.round(drawn); it.fit = fit; it.dpr = dpr;
      if (!res) it.note = 'could not load currentSrc for its real width';
      else { it.perDevicePx = res.perDevicePx; it.perCssPx = res.perCssPx; it.belowMin = res.perDevicePx < min; }
      items.push(it);
    }
    var judged = items.filter(function (x) { return x.perDevicePx != null; });
    return wrap(opts, { dpr: dpr, min: min, measured: judged.length, belowMin: judged.filter(function (x) { return x.belowMin; }).length,
      notJudged: items.length - judged.length, items: items, notChecked: ['CSS background images', 'EXIF crop: compare the render with the source visually'] });
  }

  // Tap/click target sizes (WCAG 2.2 2.5.8 AA = 24px; 2.5.5 AAA = 44px; the rules table decides).
  function targetSizes(opts) {
    opts = opts || {};
    var min = opts.min || 24, small = [], n = 0;
    all(opts.selector || 'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, summary', 2000).forEach(function (el) {
      if (!visible(el)) return;
      var r = el.getBoundingClientRect(); n++;
      if (r.width < min || r.height < min) small.push({ el: describe(el), text: (el.textContent || el.value || '').trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) });
    });
    return wrap(opts, { min: min, measured: n, belowMin: small.length, items: small.slice(0, opts.limit || 40), note: 'inline links in running text are exempt in WCAG; judge each' });
  }
  // After a real Tab press (press_key), read what has focus and whether a ring is painted.
  function focusState(opts) {
    var el = document.activeElement, cs = el && getComputedStyle(el);
    return wrap(opts, { el: describe(el), focusVisible: !!(el && el.matches(':focus-visible')), outline: cs && cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
      boxShadow: cs && cs.boxShadow, rect: el && box(el.getBoundingClientRect()) });
  }

  // In-page anchors. No hash: list every #link and whether its target exists. With a hash: jump,
  // wait, and report where the target landed and whether a fixed/sticky header covers it.
  async function anchorLanding(hash, opts) {
    opts = opts || {};
    if (!hash) {
      var links = all('a[href^="#"]', 500).filter(function (a) { return a.getAttribute('href').length > 1; });
      var missing = links.filter(function (a) { return !document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))); });
      return wrap(opts, { links: links.length, missingTargets: missing.map(function (a) { return { el: describe(a), href: a.getAttribute('href') }; }), ok: missing.length === 0 });
    }
    var id = decodeURIComponent(hash.replace(/^#/, '')), target = document.getElementById(id);
    if (!target) return wrap(opts, { hash: hash, exists: false, ok: false });
    if (location.hash === '#' + id) history.replaceState(null, '', location.pathname + location.search);
    location.hash = id;
    await new Promise(function (res) { setTimeout(res, opts.settleMs || 800); });
    var r = target.getBoundingClientRect(), headerBottom = 0, coveredBy = null;
    all('body *', 20000).forEach(function (el) {
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
      var hr = el.getBoundingClientRect();
      if (hr.top <= 1 && hr.width > window.innerWidth / 2 && hr.bottom > headerBottom && visible(el)) { headerBottom = hr.bottom; coveredBy = describe(el); }
    });
    var inView = r.top >= headerBottom - 1 && r.top < window.innerHeight;
    return wrap(opts, { hash: hash, exists: true, targetTop: Math.round(r.top), headerBottom: Math.round(headerBottom), header: coveredBy,
      scrollMarginTop: getComputedStyle(target).scrollMarginTop, focused: describe(document.activeElement), ok: inView });
  }

  // Step each running animation to fixed points and read the property that carries the value (L57).
  function animationStates(selector, props, opts) {
    opts = opts || {};
    var fr = opts.fractions || [0, 0.25, 0.5, 0.75, 1];
    var out = all(selector, opts.limit || 10).map(function (el) {
      var anims = el.getAnimations ? el.getAnimations() : [];
      return { el: describe(el), animations: anims.map(function (an) {
        var ct = an.effect.getComputedTiming(), was = an.playState, t0 = an.currentTime;
        var end = isFinite(ct.endTime) ? ct.endTime : (ct.delay || 0) + ct.duration;
        an.pause();
        var samples = fr.map(function (f) {
          an.currentTime = Math.min(f * end, end - 0.01); // at exactly `end` an unfilled animation is gone
          var cs = getComputedStyle(el), v = {};
          (props || ['opacity', 'transform', 'translate', 'clip-path']).forEach(function (p) { v[p] = cs.getPropertyValue(p); });
          return { at: f, values: v };
        });
        an.currentTime = t0; if (was === 'running') an.play();
        return { name: an.animationName || an.transitionProperty || an.id || 'animation', endTime: end, samples: samples };
      }) };
    });
    return wrap(opts, { selector: selector, items: out, note: 'no animations listed = none running now; trigger the state first (scroll, hover) and pass waitForStableDom:false' });
  }

  // Baseline floors (design-system.md "## Baseline", BL rows): the plain craft defects a page can have with no
  // project value set (text on the screen edge, cramped sections, labels touching their button edge). Each part
  // lists offenders against the row's minimum; the numbers and their sources live in the BL rows.
  function effectiveBg(el) { // first painted background colour up the tree (white when none)
    for (var p = el; p && p.nodeType === 1; p = p.parentElement) { var c = toRgba(getComputedStyle(p).backgroundColor); if (c.a > 0.05) return c; }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  function paintedSurface(el) { // its own face: a background unlike its parent's, an image, a shadow or a full border
    var cs = getComputedStyle(el), bg = toRgba(cs.backgroundColor);
    if (cs.backgroundImage !== 'none' || cs.boxShadow !== 'none') return true;
    if (['Top', 'Right', 'Bottom', 'Left'].every(function (s) { return parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none'; })) return true;
    if (bg.a <= 0.05) return false;
    var pb = el.parentElement ? effectiveBg(el.parentElement) : { r: 255, g: 255, b: 255 };
    return Math.abs(bg.r - pb.r) + Math.abs(bg.g - pb.g) + Math.abs(bg.b - pb.b) > 6;
  }
  function contentBox(el) { // union of painted text and form controls inside el (media excluded: it may bleed)
    var rs = [], ink = textInk(el);
    if (ink) rs.push({ l: ink.x, t: ink.y, r: ink.right, b: ink.bottom });
    Array.prototype.forEach.call(el.querySelectorAll('input:not([type="hidden"]), select, textarea, button'), function (c) {
      var r = c.getBoundingClientRect(); if (r.width && visible(c)) rs.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
    });
    if (!rs.length) return null;
    return { l: Math.min.apply(null, rs.map(function (x) { return x.l; })), t: Math.min.apply(null, rs.map(function (x) { return x.t; })),
      r: Math.max.apply(null, rs.map(function (x) { return x.r; })), b: Math.max.apply(null, rs.map(function (x) { return x.b; })) };
  }
  function baselineScan(opts) {
    opts = opts || {};
    var vw = document.documentElement.clientWidth, g = opts.gutter || gutterFor(vw), lim = opts.limit || 20;
    var R = function (n) { return Math.round(n); }, txt = function (el) { return (el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40); };
    var list = function (items) { return { count: items.length, items: items.slice(0, lim) }; };
    var MEDIA = /^(script|style|template|noscript|br|wbr|img|video|canvas|picture|svg|iframe)$/i, CTL = /^(BUTTON|INPUT|SELECT|TEXTAREA)$/;
    // BL-1: nothing readable or clickable inside the side gutter (off-screen slides and sr-only text skipped).
    var edges = [];
    all('body *', 20000).forEach(function (el) {
      if (MEDIA.test(el.tagName) || !visible(el)) return;
      var ctl = CTL.test(el.tagName), b = ctl ? el.getBoundingClientRect() : textInk(el, true);
      if (!b) return;
      var l = ctl ? b.left : b.x, r = b.right;
      if (r - l <= 1 || r <= 0 || l >= vw) return;
      if (Math.min(l, vw - r) < g - 0.5) edges.push({ el: describe(el), text: txt(el), left: R(l), right: R(vw - r) });
    });
    // BL-2: section breathing room. Sections = main's children (unwrapping single wrappers), else body's.
    var root = document.querySelector('main') || document.body, secs = Array.prototype.slice.call(root.children);
    while (secs.length === 1 && secs[0].children.length) secs = Array.prototype.slice.call(secs[0].children);
    secs = secs.filter(function (el) { return visible(el) && !/^(H[1-6]|P|UL|OL|A|SPAN|IMG|FIGURE|BUTTON|SCRIPT|STYLE|HEADER|FOOTER|NAV)$/.test(el.tagName) && el.getBoundingClientRect().height > 0; })
      .sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });
    var min = opts.section || 48, sections = [], prev = null;
    secs.forEach(function (el) {
      var r = el.getBoundingClientRect(), cb = contentBox(el);
      if (!cb) return;
      if (paintedSurface(el) && (cb.t - r.top < min - 0.5 || r.bottom - cb.b < min - 0.5)) sections.push({ el: describe(el), kind: 'band inset', top: R(cb.t - r.top), bottom: R(r.bottom - cb.b) });
      if (prev && cb.t - prev.cb.b < min - 0.5) sections.push({ el: describe(el), kind: 'gap to previous section', after: describe(prev.el), gap: R(cb.t - prev.cb.b) });
      prev = { el: el, cb: cb };
    });
    // BL-3: a button's label inset from its painted edge (icon-only and unpainted text buttons skipped).
    var buttons = [];
    all('button, [role="button"], input[type="submit"], input[type="button"], input[type="reset"], a[href]', 3000).forEach(function (el) {
      if (!visible(el) || !paintedSurface(el)) return;
      var r = el.getBoundingClientRect(), cs = getComputedStyle(el), ink = el.tagName === 'INPUT' ? null : textInk(el);
      if (!ink && el.tagName !== 'INPUT') return;
      var il = ink ? ink.x - r.left : parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), ir = ink ? r.right - ink.right : parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
      if (Math.min(il, ir) < (opts.button || 16) - 0.5) buttons.push({ el: describe(el), text: txt(el), left: R(il), right: R(ir) });
    });
    // BL-5: text fields: inset (12 beside an icon, else 16) and height.
    var fields = [];
    all('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="range"]):not([type="color"]):not([type="file"]), select, textarea', 500).forEach(function (el) {
      if (!visible(el)) return;
      var cs = getComputedStyle(el), r = el.getBoundingClientRect();
      var icon = !!el.parentElement && Array.prototype.some.call(el.parentElement.querySelectorAll('svg, img'), function (m) { var q = m.getBoundingClientRect(); return q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top; });
      var il = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), ir = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
      if (Math.min(il, ir) < (icon ? 12 : 16) - 0.5 || r.height < (opts.field || 44) - 0.5) fields.push({ el: describe(el), left: R(il), right: R(ir), height: R(r.height), icon: icon });
    });
    // BL-4: cards = painted boxes narrower than the page that hold text; content inset on every side.
    var cards = [];
    all('body *', 20000).forEach(function (el) {
      if (MEDIA.test(el.tagName) || /^(BUTTON|INPUT|SELECT|TEXTAREA|A|LABEL|HTML|BODY)$/.test(el.tagName) || secs.indexOf(el) >= 0 || !visible(el)) return;
      var r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 32 || r.width > vw * 0.9 || getComputedStyle(el).display === 'inline' || !paintedSurface(el)) return;
      var cb = contentBox(el);
      if (!cb) return;
      var ins = { top: cb.t - r.top, right: r.right - cb.r, bottom: r.bottom - cb.b, left: cb.l - r.left };
      if (Math.min(ins.top, ins.right, ins.bottom, ins.left) < (opts.card || 16) - 0.5) cards.push({ el: describe(el), text: txt(el), top: R(ins.top), right: R(ins.right), bottom: R(ins.bottom), left: R(ins.left) });
    });
    // BL-6 and BL-9: paragraphs and list items that wrap (line height matters only where lines follow lines).
    var lineHeight = [], measure = [];
    all('p, li', 3000).forEach(function (el) {
      if (!visible(el)) return;
      var ink = textInk(el); if (!ink) return;
      var cs = getComputedStyle(el), fs = parseFloat(cs.fontSize), lh = cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight);
      var chars = el.textContent.trim().replace(/\s+/g, ' ').length, lines = Math.max(1, Math.round(ink.h / (lh || fs * 1.2)));
      if (lines < 2) return;
      var ratio = lh ? Math.round(lh / fs * 100) / 100 : 'normal';
      if (ratio === 'normal' || ratio < 1.5 - 0.005 || ratio > 1.7 + 0.005) lineHeight.push({ el: describe(el), text: txt(el), fontSize: fs, lineHeight: ratio });
      var cpl = charsPerLine(chars, ink.h, lh || fs * 1.2);
      if (cpl > (opts.measure || 75)) measure.push({ el: describe(el), text: txt(el), charsPerLine: cpl, lines: lines });
    });
    // BL-7: a heading is nearer its own text than the block above (a short label above it, an eyebrow, is skipped).
    var headings = [];
    all('h1, h2, h3, h4, h5, h6', 300).forEach(function (h) {
      var p = h.previousElementSibling, n = h.nextElementSibling, hi = textInk(h);
      if (!p || !n || !hi || !visible(p) || !visible(n)) return;
      var pi = contentBox(p) || (function (r) { return { b: r.bottom }; })(p.getBoundingClientRect()), ni = contentBox(n) || (function (r) { return { t: r.top }; })(n.getBoundingClientRect());
      if (p.textContent.trim().length < 40 && (textInk(p) || { h: 999 }).h < parseFloat(getComputedStyle(h).fontSize) * 1.5) return;
      var above = hi.y - pi.b, below = ni.t - hi.bottom;
      if (below > 0 && above <= below) headings.push({ el: describe(h), text: txt(h), above: R(above), below: R(below) });
    });
    // BL-8: neighbouring targets closer than the gap (links inside running text are exempt).
    var ts = all('a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, summary', 400).filter(function (el) {
      if (!visible(el)) return false;
      var par = el.parentElement;
      return !(el.tagName === 'A' && par && /^(P|LI|SPAN|TD|DD|BLOCKQUOTE)$/.test(par.tagName) && par.textContent.trim().length > el.textContent.trim().length + 10);
    }).map(function (el) { return { el: el, r: el.getBoundingClientRect() }; });
    var targets = [], tg = opts.targetGap || 8;
    for (var i = 0; i < ts.length; i++) for (var j = i + 1; j < ts.length; j++) {
      var a = ts[i], b = ts[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      var dx = Math.max(a.r.left, b.r.left) - Math.min(a.r.right, b.r.right), dy = Math.max(a.r.top, b.r.top) - Math.min(a.r.bottom, b.r.bottom);
      var gp = dx < 0 && dy >= 0 ? dy : dy < 0 && dx >= 0 ? dx : null;
      if (gp !== null && gp < tg - 0.5) targets.push({ a: describe(a.el), b: describe(b.el), gap: R(gp) });
    }
    // BL-10: stretched or squashed images.
    var images = [];
    all('img', 300).forEach(function (el) {
      var r = el.getBoundingClientRect(), src = el.currentSrc || el.src;
      if (!r.width || !visible(el) || !el.naturalWidth || /\.svg(\?|#|$)|^data:image\/svg/.test(src)) return;
      var s = stretchPx(el.naturalWidth, el.naturalHeight, r.width, r.height, getComputedStyle(el).objectFit);
      if (s > 1) images.push({ el: describe(el), src: String(src).slice(-60), drawn: R(r.width) + 'x' + R(r.height), file: el.naturalWidth + 'x' + el.naturalHeight, offByPx: s });
    });
    // BL-11: spacing values off the 4px grid (horizontal margins skipped: auto centring computes any value).
    var seen = {}, off = {};
    all('body *', 8000).forEach(function (el) {
      if (!visible(el)) return;
      var cs = getComputedStyle(el);
      ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-bottom', 'row-gap', 'column-gap'].forEach(function (p) {
        var v = cs.getPropertyValue(p); if (!/px$/.test(v)) return;
        var n = Math.round(Math.abs(parseFloat(v)) * 100) / 100; if (!n) return;
        seen[n] = (seen[n] || 0) + 1;
        if (!onGrid(n, opts.grid || 4)) { off[n] = off[n] || { value: n, uses: 0, example: describe(el) + ' ' + p }; off[n].uses++; }
      });
    });
    var scale = Object.keys(off).map(function (k) { return off[k]; }).sort(function (a, b) { return b.uses - a.uses; });
    var body = { width: vw, gutter: g, edges: list(edges), sections: list(sections), buttons: list(buttons), fields: list(fields), cards: list(cards),
      lineHeight: list(lineHeight), measure: list(measure), headings: list(headings), targets: list(targets), images: list(images),
      scale: { count: scale.length, distinctValues: Object.keys(seen).length, items: scale.slice(0, lim) },
      notChecked: ['background images on blocks without text', 'cards drawn by a pseudo-element', 'a short label (eyebrow) directly above a heading', 'fluid (clamp, vw) spacing: off the grid at most widths, judge it against the project token'] };
    body.ok = ['edges', 'sections', 'buttons', 'fields', 'cards', 'lineHeight', 'measure', 'headings', 'targets', 'images', 'scale'].every(function (k) { return body[k].count === 0; });
    return wrap(opts, body);
  }

  // Negative control (L55): inject known-bad fixtures, prove each instrument catches them, remove them.
  async function selfTest() {
    var box0 = document.createElement('div');
    box0.id = 'cw-neg';
    box0.innerHTML = '<div style="width:' + (window.innerWidth + 300) + 'px;height:4px"></div>' +
      '<p id="cw-neg-contrast" style="color:#777;background:#888;font-size:14px">low contrast control</p>' +
      '<div style="width:60px;overflow:hidden"><span style="white-space:nowrap">clipped text control that is long</span></div>' +
      '<a href="#cw-no-such-target">missing anchor control</a> <button style="width:10px;height:10px;padding:0"></button>' +
      '<p id="cw-neg-edge" style="position:absolute;left:0;top:0;margin:0">edge control</p>' +
      '<button style="padding:0 2px;background:#888;border:0;color:#000">tight button control</button>';
    document.body.appendChild(box0);
    try {
      var o = overflowScan(), c = renderedContrast('#cw-neg-contrast', { scroll: true }), a = await anchorLanding(), t = targetSizes(), b = baselineScan({ limit: 100000 });
      var caught = {
        overflow: o.beyondViewport.some(function (x) { return x.overBy >= 299; }) || o.page.overflowPx >= 299,
        textCut: o.textCut.some(function (x) { return x.text.indexOf('clipped text control') === 0; }),
        contrast: c.items.some(function (x) { return x.pass === false; }),
        anchor: a.missingTargets.some(function (x) { return x.href === '#cw-no-such-target'; }),
        target: t.items.some(function (x) { return x.w === 10; }),
        edge: b.edges.items.some(function (x) { return x.el.indexOf('cw-neg-edge') >= 0; }),
        buttonPadding: b.buttons.items.some(function (x) { return x.text === 'tight button control'; }),
      };
      return wrap({}, { caught: caught, allCaught: Object.keys(caught).every(function (k) { return caught[k]; }) });
    } finally { box0.remove(); }
  }

  return {
    widthsTable: widthsTable, viewportFor: viewportFor, parseColor: parseColor, composite: composite,
    relativeLuminance: relativeLuminance, contrastRatio: contrastRatio, requiredContrast: requiredContrast,
    drawnImageWidth: drawnImageWidth, resolution: resolution, harnessVerdict: harnessVerdict, oklabToRgb: oklabToRgb,
    stamp: stamp, harness: harness, styles: styles, gap: gap, overflowScan: overflowScan, renderedContrast: renderedContrast,
    hideInk: hideInk, imageResolution: imageResolution, targetSizes: targetSizes, focusState: focusState,
    anchorLanding: anchorLanding, animationStates: animationStates, selfTest: selfTest,
    gutterFor: gutterFor, onGrid: onGrid, charsPerLine: charsPerLine, stretchPx: stretchPx, baselineScan: baselineScan,
  };
})();
if (typeof window === 'object' && window) window.__cw = CW;
if (typeof module === 'object' && module && module.exports) module.exports = CW;
