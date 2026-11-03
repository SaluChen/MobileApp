/* ==========================================================================
 * 銷售分析 Dashboard —— dashboard.html 專用
 * --------------------------------------------------------------------------
 * 五種分析模式，全部打同一支 API：
 *     GET staff-dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day|month|quarter|year
 *   年銷售：起始年 ~ 結束年，依年統計
 *   季銷售：某一年，依季統計（Q1~Q4）
 *   月銷售：某一年，依月統計（1~12 月）
 *   日銷售：某一個月，依日統計
 *   區間銷售：任意起訖日，統計單位可自選（預設依區間長度自動挑）
 *
 * 後端只回傳「有訂單」的時段；沒有訂單的時段由 fillPeriods() 補 0，
 * 圖表的 X 軸才會連續（不會把一月接到四月）。
 *
 * 圖表全部用原生 SVG 自己畫，不依賴外部函式庫 ——
 * 後台常架在內網，CDN 連不上時整頁圖表都會消失。
 * ========================================================================== */
(function () {
  'use strict';

  var ALLOWED_ROLES = ['manager', 'admin', 'finance'];
  var ROLE_LABEL = {
    customer: '一般會員', manager: '營運人員', finance: '財務',
    warehouse: '倉管', logistics: '物流', admin: '系統管理員'
  };
  var PAY_LABEL = {
    'Credit Card': '信用卡', 'ATM Transfer': 'ATM 轉帳', 'Mobile Pay': '行動支付',
    'COD': '貨到付款', 'App Pay': 'App 支付'
  };
  var LOGIN_PAGE = 'login.html';
  var DEFAULT_API = 'api.php';
  var API_URL = localStorage.getItem('shop_api_url') || DEFAULT_API;
  var TOKEN = localStorage.getItem('shop_token') || null;
  var ME = null;

  // 類別色：固定順序指派，不循環（第 7 類以後併入「其他」）
  var SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6'];
  var PIE_MAX = 6;

  var state = { mode: 'month', data: null, periods: [], reqSeq: 0 };

  // ======================================================================
  // 工具
  // ======================================================================
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function cssVar(name) {
    return getComputedStyle($('app')).getPropertyValue(name).trim();
  }
  function num(v) { var n = Number(v || 0); return isFinite(n) ? n : 0; }
  function comma(n, digits) {
    var s = Math.abs(n).toFixed(digits || 0);
    var dot = s.indexOf('.');
    var whole = dot < 0 ? s : s.slice(0, dot);
    return (n < 0 ? '-' : '') + whole.replace(/\B(?=(\d{3})+$)/g, ',') + (dot < 0 ? '' : s.slice(dot));
  }
  function money(n) {
    n = num(n);
    return '$' + comma(n, Number.isInteger(n) ? 0 : 2);
  }
  /** 軸刻度與 KPI 用的精簡金額：12,345 → 1.2萬 */
  function compact(n) {
    n = num(n);
    var a = Math.abs(n);
    if (a >= 1e8) return trim(n / 1e8) + '億';
    if (a >= 1e4) return trim(n / 1e4) + '萬';
    return comma(n);
  }
  function trim(x) { return String(Math.round(x * 10) / 10); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function daysBetween(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000) + 1; }

  function notify(msg, kind) {
    $('dashMsg').innerHTML = msg ? '<div class="notice ' + (kind || 'info') + '">' + esc(msg) + '</div>' : '';
  }

  // ======================================================================
  // API 與守門（同 backoffice.js）
  // ======================================================================
  async function api(path) {
    var headers = {};
    if (TOKEN) { headers['Authorization'] = 'Bearer ' + TOKEN; headers['X-Auth-Token'] = TOKEN; }
    var res = await fetch(API_URL + path, { headers: headers });
    var text = await res.text();
    var data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch (e) { throw new Error('伺服器回傳非 JSON 內容（HTTP ' + res.status + '）\n' + text.slice(0, 200)); }
    }
    if (res.status === 401 || (data && data.code === 'ACCOUNT_SUSPENDED')) {
      bounceToLogin((data && data.code === 'ACCOUNT_SUSPENDED') ? 'suspended' : 'expired');
      throw new Error((data && data.message) || '登入已過期，請重新登入');
    }
    if (!res.ok) throw new Error((data && data.message) || ('伺服器錯誤 HTTP ' + res.status));
    return data;
  }

  function bounceToLogin(reason) {
    TOKEN = null; ME = null;
    localStorage.removeItem('shop_token');
    location.replace(LOGIN_PAGE + (reason ? '?reason=' + encodeURIComponent(reason) : ''));
  }

  function doLogout() {
    var old = TOKEN;
    if (old) {
      fetch(API_URL + '/users?action=logout', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + old, 'X-Auth-Token': old }
      }).catch(function () {});
    }
    bounceToLogin('logout');
  }

  async function boot() {
    if (!TOKEN) { bounceToLogin(); return; }
    try {
      var me = await api('/users');
      if (!me || !me.user_id) throw new Error('無法取得帳號資料');
      if (ALLOWED_ROLES.indexOf(me.role) < 0) {
        location.replace(me.home || LOGIN_PAGE + '?reason=denied');
        return;
      }
      ME = me;
      $('checking').style.display = 'none';
      $('app').classList.add('ready');
      $('whoami').innerHTML = esc(ME.full_name) + '<br><span class="muted">' + esc(ME.email) + '</span><br>' +
        '<span class="badge ' + esc(ME.role) + '">' + esc(ROLE_LABEL[ME.role] || ME.role) + '</span>';
      $('backLink').href = me.home || LOGIN_PAGE;
      initFilters();
      setMode('month');
    } catch (e) {
      $('checking').innerHTML = '<div class="notice err">' + esc(e.message) +
        '</div><p><a href="' + LOGIN_PAGE + '">返回登入頁</a></p>';
    }
  }

  // ======================================================================
  // 篩選條件
  // ======================================================================
  function fillYearSelect(sel, years, value) {
    sel.innerHTML = years.map(function (y) { return '<option value="' + y + '">' + y + ' 年</option>'; }).join('');
    sel.value = String(value);
  }

  /** 年度選單：從最早一筆訂單的年份到今年（後端 bounds 回來後會再擴充一次） */
  function yearRange() {
    var now = new Date().getFullYear();
    var first = now, last = now;
    var b = state.data && state.data.bounds;
    if (b && b.first) first = Math.min(first, +b.first.slice(0, 4));
    if (b && b.last) last = Math.max(last, +b.last.slice(0, 4));
    var ys = [];
    for (var y = first; y <= last; y++) ys.push(y);
    return ys;
  }

  /** reset = true 時套用預設值（年銷售預設看近 5 年），否則保留使用者目前的選擇 */
  function refreshYearOptions(reset) {
    var ys = yearRange();
    var now = new Date().getFullYear();
    var pick = function (sel, dflt) { return reset || !sel.value ? dflt : +sel.value; };
    fillYearSelect($('fYearFrom'), ys, pick($('fYearFrom'), Math.max(ys[0], now - 4)));
    fillYearSelect($('fYearTo'), ys, pick($('fYearTo'), now));
    fillYearSelect($('fYear'), ys, pick($('fYear'), now));
  }

  function initFilters() {
    var today = new Date();
    refreshYearOptions(true);
    $('fMonth').value = today.getFullYear() + '-' + pad(today.getMonth() + 1);
    applyPreset('30', true);

    document.querySelectorAll('#modeTabs button').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
    });
    document.querySelectorAll('.presets button').forEach(function (b) {
      b.addEventListener('click', function () { applyPreset(b.getAttribute('data-preset')); });
    });
    ['fYearFrom', 'fYearTo', 'fYear', 'fMonth', 'fFrom', 'fTo', 'fGroup'].forEach(function (id) {
      $(id).addEventListener('change', load);
    });
    $('pieDim').addEventListener('change', renderPie);

    var t = null;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () { if (state.data) renderCharts(); }, 150);
    });
  }

  function applyPreset(p, silent) {
    var to = new Date(), from = new Date();
    if (p === 'mtd') from = new Date(to.getFullYear(), to.getMonth(), 1);
    else if (p === 'ytd') from = new Date(to.getFullYear(), 0, 1);
    else from.setDate(to.getDate() - (+p - 1));
    $('fFrom').value = ymd(from);
    $('fTo').value = ymd(to);
    if (!silent) load();
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('#modeTabs button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-mode') === mode);
    });
    document.querySelectorAll('.filters .f').forEach(function (el) {
      el.style.display = el.getAttribute('data-for').split(' ').indexOf(mode) >= 0 ? '' : 'none';
    });
    // 圓餅圖預設維度：期間少（年、季）看期間占比，其餘看商品分類
    $('pieDim').value = (mode === 'year' || mode === 'quarter') ? 'period' : 'category';
    load();
  }

  /** 由目前的模式與篩選條件組出查詢參數 */
  function currentQuery() {
    var m = state.mode, from, to, group, title;
    if (m === 'year') {
      var a = +$('fYearFrom').value, b = +$('fYearTo').value;
      if (a > b) { var x = a; a = b; b = x; }
      from = a + '-01-01'; to = b + '-12-31'; group = 'year';
      title = a === b ? a + ' 年' : a + ' – ' + b + ' 年';
    } else if (m === 'quarter' || m === 'month') {
      var y = $('fYear').value;
      from = y + '-01-01'; to = y + '-12-31'; group = m;
      title = y + ' 年' + (m === 'quarter' ? '各季' : '各月');
    } else if (m === 'day') {
      var ym = $('fMonth').value;
      if (!ym) return null;
      var parts = ym.split('-');
      var last = new Date(+parts[0], +parts[1], 0).getDate();
      from = ym + '-01'; to = ym + '-' + pad(last); group = 'day';
      title = parts[0] + ' 年 ' + (+parts[1]) + ' 月每日';
    } else {
      from = $('fFrom').value; to = $('fTo').value;
      if (!from || !to) return null;
      if (from > to) { var z = from; from = to; to = z; }
      group = $('fGroup').value;
      if (group === 'auto') {
        var d = daysBetween(from, to);
        group = d <= 92 ? 'day' : d <= 731 ? 'month' : d <= 3653 ? 'quarter' : 'year';
      }
      title = from + ' ～ ' + to;
    }
    return { from: from, to: to, group: group, title: title };
  }

  // ======================================================================
  // 期間補齊
  // ======================================================================
  var GROUP_LABEL = { day: '日', month: '月', quarter: '季', year: '年' };

  /** 產生 from~to 之間所有時段的 key（與後端 period 格式相同）與顯示用標籤 */
  function fillPeriods(q, series) {
    var map = {};
    (series || []).forEach(function (r) { map[r.period] = r; });
    var out = [];
    var f = parseYmd(q.from), t = parseYmd(q.to);
    var multiYear = f.getFullYear() !== t.getFullYear();
    var today = ymd(new Date());
    // start = 時段第一天；晚於今天的時段標成 future —— 它不是「賣了 0」，是「還沒發生」
    function push(key, label, start) {
      var r = map[key] || {};
      out.push({ key: key, label: label, orders: num(r.orders), items: num(r.items), revenue: num(r.revenue),
                 future: start > today && !map[key] });
    }
    if (q.group === 'day') {
      for (var d = new Date(f); d <= t; d.setDate(d.getDate() + 1)) {
        push(ymd(d), (multiYear ? d.getFullYear() + '/' : '') + (d.getMonth() + 1) + '/' + d.getDate(), ymd(d));
      }
    } else if (q.group === 'month') {
      // 以「年×12＋月」當流水號，跨年不用另外處理
      for (var idx = f.getFullYear() * 12 + f.getMonth(); idx <= t.getFullYear() * 12 + t.getMonth(); idx++) {
        var y = Math.floor(idx / 12), mo = idx % 12 + 1;
        push(y + '-' + pad(mo), multiYear ? y + '/' + mo : mo + ' 月', y + '-' + pad(mo) + '-01');
      }
    } else if (q.group === 'quarter') {
      var qs = Math.floor(f.getMonth() / 3), qe = Math.floor(t.getMonth() / 3);
      for (var yy = f.getFullYear(); yy <= t.getFullYear(); yy++) {
        var a = yy === f.getFullYear() ? qs : 0, b = yy === t.getFullYear() ? qe : 3;
        for (var k = a; k <= b; k++) push(yy + '-Q' + (k + 1), (multiYear ? yy + ' ' : '') + 'Q' + (k + 1), yy + '-' + pad(k * 3 + 1) + '-01');
      }
    } else {
      for (var y2 = f.getFullYear(); y2 <= t.getFullYear(); y2++) push(String(y2), y2 + ' 年', y2 + '-01-01');
    }
    return out;
  }

  // ======================================================================
  // 載入
  // ======================================================================
  async function load() {
    var q = currentQuery();
    if (!q) return;
    var seq = ++state.reqSeq;
    $('main').classList.add('loading');   // 重新查詢時保留舊圖、淡化，不閃白
    notify('');
    try {
      var data = await api('/staff-dashboard?from=' + q.from + '&to=' + q.to + '&group=' + q.group);
      if (seq !== state.reqSeq) return;   // 使用者已經改了條件，丟掉過時的回應
      var firstLoad = !state.data;
      state.data = data;
      state.query = q;
      state.periods = fillPeriods(q, data.series);
      if (firstLoad) refreshYearOptions(true);   // 拿到資料庫最早年份後重建年度選單
      $('rangeNote').textContent = '分析範圍：' + q.from + ' ～ ' + q.to + '，依' + GROUP_LABEL[q.group] + '統計' +
        (data.bounds && data.bounds.first ? '（資料庫最早訂單 ' + data.bounds.first + '）' : '（目前沒有任何訂單）');
      render();
    } catch (e) {
      if (seq === state.reqSeq) notify(e.message, 'err');
    } finally {
      if (seq === state.reqSeq) $('main').classList.remove('loading');
    }
  }

  function render() {
    renderKpis();
    renderCharts();
    renderTables();
  }

  function renderCharts() {
    var q = state.query;
    $('barSub').textContent = '長條圖 · ' + q.title;
    renderBar();
    renderLine();
    renderPie();
  }

  // ======================================================================
  // KPI
  // ======================================================================
  function renderKpis() {
    var s = state.data.summary;
    var orders = num(s.orders), revenue = num(s.revenue);
    var tiles = [
      { l: '銷售額', v: money(revenue), s: state.query.title, hero: true },
      { l: '訂單數', v: comma(orders), s: '未取消訂單' },
      { l: '銷售件數', v: comma(num(s.items)), s: '商品總件數' },
      { l: '平均客單價', v: orders ? money(Math.round(revenue / orders)) : '—', s: '銷售額 ÷ 訂單數' },
      { l: '已收款', v: money(s.paid_revenue), s: revenue ? '占 ' + Math.round(num(s.paid_revenue) / revenue * 100) + '%' : '—' },
      { l: '已取消', v: comma(num(s.cancelled_orders)) + ' 筆', s: money(s.cancelled_amount) }
    ];
    $('kpis').innerHTML = tiles.map(function (t) {
      return '<div class="kpi' + (t.hero ? ' hero' : '') + '"><div class="l">' + esc(t.l) + '</div>' +
        '<div class="v">' + esc(t.v) + '</div><div class="s">' + esc(t.s) + '</div></div>';
    }).join('');
  }

  // ======================================================================
  // SVG 工具
  // ======================================================================
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function txt(parent, x, y, s, attrs) {
    var t = el('text', Object.assign({ x: x, y: y, 'font-size': 11, fill: cssVar('--muted') }, attrs || {}), parent);
    t.textContent = s;
    return t;
  }
  /** 好讀的刻度：0 / 5,000 / 10,000 … */
  function niceTicks(max, count) {
    if (max <= 0) return [0, 1];
    var raw = max / count;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; }).filter(function (s) { return s >= raw; })[0];
    var ticks = [];
    for (var v = 0; v <= max + step * 0.0001; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
    return ticks;
  }
  /** X 軸標籤太密時只顯示每 n 個 */
  function labelEvery(n, plotW, labelW) {
    return Math.max(1, Math.ceil(n * labelW / plotW));
  }

  // ---------- 提示框 ----------
  var tip;
  function showTip(evt, title, rows) {
    tip = tip || $('tip');
    tip.innerHTML = '';
    var t = document.createElement('div'); t.className = 't'; t.textContent = title; tip.appendChild(t);
    rows.forEach(function (r) {
      var row = document.createElement('div'); row.className = 'r';
      var name = document.createElement('span');
      if (r.color) { var k = document.createElement('span'); k.className = 'lk'; k.style.background = r.color; name.appendChild(k); }
      name.appendChild(document.createTextNode(r.name));
      var v = document.createElement('b'); v.textContent = r.value;
      row.appendChild(name); row.appendChild(v); tip.appendChild(row);
    });
    tip.style.display = 'block';
    var x = evt.clientX + 14, y = evt.clientY + 14;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = evt.clientY - h - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }

  function emptyChart(box, msg) {
    box.innerHTML = '<div class="empty-chart">' + esc(msg) + '</div>';
  }

  // ======================================================================
  // 長條圖：各時段銷售額
  // ======================================================================
  function renderBar() {
    var box = $('barChart');
    var pts = state.periods;
    box.innerHTML = '';
    if (!pts.length) return emptyChart(box, '沒有資料');
    var W = Math.max(box.clientWidth, 300), H = 280;
    var m = { l: 58, r: 12, t: 22, b: 30 };
    var pw = W - m.l - m.r, ph = H - m.t - m.b;
    var max = Math.max.apply(null, pts.map(function (p) { return p.revenue; }));
    var ticks = niceTicks(max, 4), top = ticks[ticks.length - 1];
    var y = function (v) { return m.t + ph - v / top * ph; };
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': '各時段銷售額長條圖' }, box);

    ticks.forEach(function (v, i) {
      el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: i ? cssVar('--grid') : cssVar('--axis'), 'stroke-width': 1 }, svg);
      txt(svg, m.l - 8, y(v) + 4, compact(v), { 'text-anchor': 'end' });
    });

    var band = pw / pts.length;
    var bw = Math.max(2, Math.min(24, band - 2));
    var every = labelEvery(pts.length, pw, 46);
    var color = cssVar('--s1');
    var maxIdx = -1;
    pts.forEach(function (p, i) { if (p.revenue > 0 && (maxIdx < 0 || p.revenue > pts[maxIdx].revenue)) maxIdx = i; });

    pts.forEach(function (p, i) {
      var cx = m.l + band * i + band / 2;
      var bar = null;
      if (p.revenue > 0) {
        var x0 = cx - bw / 2, y0 = y(p.revenue), h = m.t + ph - y0;
        var r = Math.min(4, bw / 2, h);
        // 上方 4px 圓角、底部貼齊基線的直角
        bar = el('path', {
          d: 'M' + x0 + ',' + (m.t + ph) + 'V' + (y0 + r) + 'Q' + x0 + ',' + y0 + ' ' + (x0 + r) + ',' + y0 +
             'H' + (x0 + bw - r) + 'Q' + (x0 + bw) + ',' + y0 + ' ' + (x0 + bw) + ',' + (y0 + r) + 'V' + (m.t + ph) + 'Z',
          fill: color
        }, svg);
      }
      if (i % every === 0) txt(svg, cx, H - 10, p.label, { 'text-anchor': 'middle' });
      // 命中區 = 整個欄位，比長條本身大
      var hit = el('rect', { x: m.l + band * i, y: m.t, width: band, height: ph, fill: 'transparent', tabindex: 0 }, svg);
      var show = function (e) {
        if (bar) bar.setAttribute('opacity', 0.75);
        if (p.future) { showTip(e, p.label, [{ name: '尚未到來', value: '—' }]); return; }
        showTip(e, p.label, [
          { name: '銷售額', value: money(p.revenue) },
          { name: '訂單數', value: comma(p.orders) },
          { name: '銷售件數', value: comma(p.items) }
        ]);
      };
      hit.addEventListener('pointermove', show);
      hit.addEventListener('focus', function () {
        var r = hit.getBoundingClientRect(); show({ clientX: r.left + r.width / 2, clientY: r.top + 20 });
      });
      var off = function () { if (bar) bar.removeAttribute('opacity'); hideTip(); };
      hit.addEventListener('pointerleave', off);
      hit.addEventListener('blur', off);
    });

    // 只標最高的那一根
    if (maxIdx >= 0) {
      var p = pts[maxIdx];
      txt(svg, m.l + band * maxIdx + band / 2, y(p.revenue) - 6, compact(p.revenue),
        { 'text-anchor': 'middle', fill: cssVar('--ink'), 'font-weight': 600 });
    }
    if (max === 0) txt(svg, m.l + pw / 2, m.t + ph / 2, '這段期間沒有銷售', { 'text-anchor': 'middle', 'font-size': 13 });
  }

  // ======================================================================
  // 曲線圖：訂單數與銷售件數（同為「數量」，共用一個 Y 軸）
  // ======================================================================
  function renderLine() {
    var box = $('lineChart');
    var pts = state.periods;
    box.innerHTML = '';
    var series = [
      { name: '訂單數', key: 'orders', color: cssVar('--s1') },
      { name: '銷售件數', key: 'items', color: cssVar('--s2') }
    ];
    $('lineLegend').innerHTML = series.map(function (s) {
      return '<span><span class="k" style="background:' + s.color + '"></span>' + esc(s.name) + '</span>';
    }).join('');
    if (!pts.length) return emptyChart(box, '沒有資料');

    var W = Math.max(box.clientWidth, 300), H = 260;
    var m = { l: 48, r: 16, t: 14, b: 30 };
    var pw = W - m.l - m.r, ph = H - m.t - m.b;
    var max = Math.max.apply(null, pts.map(function (p) { return Math.max(p.orders, p.items); }));
    var ticks = niceTicks(Math.max(max, 1), 4).filter(function (v) { return Number.isInteger(v); });
    if (ticks.length < 2) ticks = [0, 1];
    var top = ticks[ticks.length - 1];
    var n = pts.length;
    var x = function (i) { return n === 1 ? m.l + pw / 2 : m.l + pw * i / (n - 1); };
    var y = function (v) { return m.t + ph - v / top * ph; };
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': '訂單數與銷售件數曲線圖' }, box);

    ticks.forEach(function (v, i) {
      el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: i ? cssVar('--grid') : cssVar('--axis'), 'stroke-width': 1 }, svg);
      txt(svg, m.l - 8, y(v) + 4, comma(v), { 'text-anchor': 'end' });
    });
    var every = labelEvery(n, pw, 46);
    pts.forEach(function (p, i) {
      if (i % every === 0) txt(svg, x(i), H - 10, p.label, { 'text-anchor': i === 0 && n > 1 ? 'start' : (i === n - 1 && n > 1 ? 'end' : 'middle') });
    });

    var surface = cssVar('--surface');
    // 曲線畫到最後一個「已發生」的時段為止，未來的月份不畫成掉到 0
    var lastReal = -1;
    pts.forEach(function (p, i) { if (!p.future) lastReal = i; });
    series.forEach(function (s) {
      if (lastReal < 0) return;
      if (lastReal > 0) {
        var d = pts.slice(0, lastReal + 1).map(function (p, i) { return (i ? 'L' : 'M') + x(i) + ',' + y(p[s.key]); }).join('');
        el('path', { d: d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      }
      // 終點圓點（只有一個時段時就是唯一的點）
      el('circle', { cx: x(lastReal), cy: y(pts[lastReal][s.key]), r: 4, fill: s.color, stroke: surface, 'stroke-width': 2 }, svg);
    });

    // 十字準線：游標找最近的時段，提示框列出所有數列
    var cross = el('line', { y1: m.t, y2: m.t + ph, stroke: cssVar('--axis'), 'stroke-width': 1, visibility: 'hidden' }, svg);
    var dots = series.map(function (s) {
      return el('circle', { r: 4, fill: s.color, stroke: surface, 'stroke-width': 2, visibility: 'hidden' }, svg);
    });
    var overlay = el('rect', { x: m.l - 10, y: m.t, width: pw + 20, height: ph, fill: 'transparent' }, svg);
    overlay.addEventListener('pointermove', function (e) {
      var r = svg.getBoundingClientRect();
      var px = (e.clientX - r.left) * W / r.width;
      var i = n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((px - m.l) / pw * (n - 1))));
      var p = pts[i];
      if (p.future) {
        cross.setAttribute('visibility', 'hidden');
        dots.forEach(function (d) { d.setAttribute('visibility', 'hidden'); });
        showTip(e, p.label, [{ name: '尚未到來', value: '—' }]);
        return;
      }
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      series.forEach(function (s, k) {
        dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(p[s.key])); dots[k].setAttribute('visibility', 'visible');
      });
      showTip(e, p.label, series.map(function (s) { return { name: s.name, value: comma(p[s.key]), color: s.color }; })
        .concat([{ name: '銷售額', value: money(p.revenue) }]));
    });
    overlay.addEventListener('pointerleave', function () {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach(function (d) { d.setAttribute('visibility', 'hidden'); });
      hideTip();
    });
  }

  // ======================================================================
  // 圓餅圖（環形）：銷售額占比，最多 6 塊，其餘併入「其他」
  // ======================================================================
  function pieItems(dim) {
    var d = state.data;
    if (dim === 'period') {
      return state.periods.filter(function (p) { return !p.future; })
        .map(function (p) { return { name: p.label, value: p.revenue }; });
    }
    if (dim === 'payment') {
      return (d.by_payment || []).map(function (r) {
        return { name: PAY_LABEL[r.payment_method] || r.payment_method, value: num(r.revenue) };
      });
    }
    return (d.by_category || []).map(function (r) { return { name: r.category_name, value: num(r.revenue) }; });
  }

  function renderPie() {
    var box = $('pieChart'), legend = $('pieLegend'), note = $('pieNote');
    box.innerHTML = ''; legend.innerHTML = ''; note.textContent = '';
    var dim = $('pieDim').value;
    var periodOpt = $('pieDim').querySelector('option[value="period"]');
    // 期間超過 6 個時，圓餅圖切太碎讀不出來 —— 停用並改看分類
    periodOpt.disabled = state.periods.length > PIE_MAX;
    if (dim === 'period' && periodOpt.disabled) { dim = 'category'; $('pieDim').value = dim; }
    if (periodOpt.disabled) note.textContent = '期間超過 ' + PIE_MAX + ' 個時不提供「依期間」圓餅圖，請看上方長條圖。';

    var items = pieItems(dim).filter(function (it) { return it.value > 0; });
    if (dim !== 'period') items.sort(function (a, b) { return b.value - a.value; });
    var total = items.reduce(function (s, it) { return s + it.value; }, 0);
    if (!total) return emptyChart(box, '這段期間沒有銷售');

    if (items.length > PIE_MAX) {
      var rest = items.slice(PIE_MAX - 1);
      items = items.slice(0, PIE_MAX - 1);
      items.push({ name: '其他（' + rest.length + ' 項）', value: rest.reduce(function (s, it) { return s + it.value; }, 0), other: true });
    }
    items.forEach(function (it, i) { it.color = it.other ? cssVar('--other') : cssVar(SERIES[i]); });

    var S = 220, R = 100, r0 = 62, cx = S / 2, cy = S / 2;
    var surface = cssVar('--surface');
    var svg = el('svg', { viewBox: '0 0 ' + S + ' ' + S, height: S, role: 'img', 'aria-label': '銷售額占比圓餅圖' }, box);
    var a = -Math.PI / 2;
    items.forEach(function (it) {
      var frac = it.value / total;
      var a2 = a + frac * Math.PI * 2;
      var shape;
      if (frac >= 0.9999) {
        shape = el('path', {
          d: 'M' + (cx + R) + ',' + cy + 'A' + R + ',' + R + ' 0 1,1 ' + (cx - R) + ',' + cy + 'A' + R + ',' + R + ' 0 1,1 ' + (cx + R) + ',' + cy +
             'M' + (cx + r0) + ',' + cy + 'A' + r0 + ',' + r0 + ' 0 1,0 ' + (cx - r0) + ',' + cy + 'A' + r0 + ',' + r0 + ' 0 1,0 ' + (cx + r0) + ',' + cy + 'Z',
          fill: it.color, 'fill-rule': 'evenodd'
        }, svg);
      } else {
        var large = a2 - a > Math.PI ? 1 : 0;
        var p = function (rr, ang) { return (cx + rr * Math.cos(ang)) + ',' + (cy + rr * Math.sin(ang)); };
        shape = el('path', {
          d: 'M' + p(R, a) + 'A' + R + ',' + R + ' 0 ' + large + ',1 ' + p(R, a2) +
             'L' + p(r0, a2) + 'A' + r0 + ',' + r0 + ' 0 ' + large + ',0 ' + p(r0, a) + 'Z',
          fill: it.color, stroke: surface, 'stroke-width': 2, 'stroke-linejoin': 'round'
        }, svg);
      }
      var pct = (frac * 100).toFixed(1) + '%';
      shape.addEventListener('pointermove', function (e) {
        shape.setAttribute('opacity', 0.8);
        showTip(e, it.name, [{ name: '銷售額', value: money(it.value) }, { name: '占比', value: pct }]);
      });
      shape.addEventListener('pointerleave', function () { shape.removeAttribute('opacity'); hideTip(); });
      a = a2;
    });
    txt(svg, cx, cy - 4, '總銷售額', { 'text-anchor': 'middle', 'font-size': 11 });
    txt(svg, cx, cy + 16, compact(total), { 'text-anchor': 'middle', 'font-size': 18, 'font-weight': 600, fill: cssVar('--ink') });

    // 圖例兼數值表：顏色以外一定有文字標籤與數字
    items.forEach(function (it) {
      var tr = document.createElement('tr');
      var td1 = document.createElement('td');
      var sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = it.color;
      td1.appendChild(sw); td1.appendChild(document.createTextNode(it.name));
      var td2 = document.createElement('td'); td2.className = 'n'; td2.textContent = money(it.value);
      var td3 = document.createElement('td'); td3.className = 'p'; td3.textContent = (it.value / total * 100).toFixed(1) + '%';
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      legend.appendChild(tr);
    });
  }

  // ======================================================================
  // 表格
  // ======================================================================
  function renderTables() {
    var tb = $('periodTable').querySelector('tbody');
    var pts = state.periods.filter(function (p) { return !p.future; });
    var tot = { orders: 0, items: 0, revenue: 0 };
    tb.innerHTML = pts.map(function (p) {
      tot.orders += p.orders; tot.items += p.items; tot.revenue += p.revenue;
      return '<tr><td>' + esc(p.label) + '</td><td class="n">' + comma(p.orders) + '</td><td class="n">' + comma(p.items) +
        '</td><td class="n">' + esc(money(p.revenue)) + '</td><td class="n">' +
        (p.orders ? esc(money(Math.round(p.revenue / p.orders))) : '—') + '</td></tr>';
    }).join('') + '<tr style="font-weight:bold;"><td>合計</td><td class="n">' + comma(tot.orders) + '</td><td class="n">' +
      comma(tot.items) + '</td><td class="n">' + esc(money(tot.revenue)) + '</td><td class="n">' +
      (tot.orders ? esc(money(Math.round(tot.revenue / tot.orders))) : '—') + '</td></tr>';

    var top = state.data.top_products || [];
    $('topTable').querySelector('tbody').innerHTML = top.length ? top.map(function (r, i) {
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td class="n">' + comma(num(r.items)) +
        '</td><td class="n">' + esc(money(r.revenue)) + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty">這段期間沒有銷售</td></tr>';
  }

  window.DASH = { logout: doLogout, reload: load };
  document.addEventListener('DOMContentLoaded', boot);
})();
