/* ==========================================================================
 * 營運角色共用邏輯 —— finance.html / warehouse.html / logistics.html 共用
 * --------------------------------------------------------------------------
 * 三個頁面的骨架完全一樣：一張「我該處理的訂單」工作佇列 + 一個動作按鈕。
 * 差別只在三件事，各自的 HTML 在載入本檔之前先設定：
 *
 *     window.OPS_MODE = 'finance';   // 或 'warehouse' / 'logistics'
 *
 * 其餘（篩選條件、動作、按鈕文字、確認訊息）全部由下面的 MODES 決定。
 * 抄成三份的話，日後改一個 bug 就要記得改三個地方。
 *
 * 🔐 登入在 login.html。本檔只守門：沒權杖 → login.html；角色不符 → 導向 me.home。
 * 🛡️ 前端的角色判斷只是「不要讓看不懂的畫面出現」，不是安全機制 ——
 *    真正的把關在 api.php 的 order_transition_rules()，
 *    倉管拿工具直接打「標記完成」一樣會被 403 擋下。
 * ========================================================================== */
(function () {
  'use strict';

  var LOGIN_PAGE = 'login.html';
  var DEFAULT_API = 'api.php';
  var API_URL = localStorage.getItem('shop_api_url') || DEFAULT_API;
  var TOKEN = localStorage.getItem('shop_token') || null;
  var ME = null;

  var ROLE_LABEL = {
    customer: '一般會員', manager: '營運人員', finance: '財務',
    warehouse: '倉管', logistics: '物流', admin: '系統管理員'
  };

  var ORDER_STATUS_LABEL = {
    awaiting_shipment: '待出貨', shipped: '已出貨', completed: '已完成',
    cancelled: '已取消', pending: '待付款(舊)', paid: '已付款(舊)'
  };
  var PAY_METHOD_LABEL = {
    'Credit Card': '信用卡', 'Mobile Pay': '行動支付', 'App Pay': 'App 支付',
    'ATM Transfer': 'ATM 轉帳', 'COD': '貨到付款'
  };
  var PAY_STATUS_LABEL = { success: '已收款', pending: '待收款', cancelled: '已取消' };

  // ======================================================================
  // 三種模式的差異全部集中在這裡
  // ======================================================================
  var MODES = {
    finance: {
      role: 'finance',
      title: '訂單帳款管理',
      icon: '💰',
      scope: 'finance',
      queueHint: '以下是「尚未收到款項」的訂單。ATM 轉帳查到入帳、貨到付款收到現金後，' +
                 '按「確認收款」把付款狀態由待收款改為已收款。',
      emptyText: '目前沒有待收款的訂單 🎉',
      actionLabel: '確認收款',
      // 動作：改的是「付款紀錄」，不是訂單狀態
      run: function (o) {
        return api('/staff-payments', { method: 'PUT', body: { order_id: o.order_id, status: 'success' } });
      },
      confirmText: function (o) {
        return '確認已收到訂單 #' + o.order_id + ' 的款項嗎？\n\n' +
               '客戶：' + o.full_name + '\n' +
               '支付方式：' + (PAY_METHOD_LABEL[o.payment_method] || o.payment_method || '未指定') + '\n' +
               '金額：' + money(o.total_amount) + '\n\n' +
               '確認後付款狀態會改為「已收款」，並記錄收款時間。';
      },
      // 這一欄要特別強調的資訊
      focusColumn: { head: '支付方式', cell: function (o) {
        return o.payment_id
          ? esc(PAY_METHOD_LABEL[o.payment_method] || o.payment_method) +
            '<br><span class="muted">' + esc(o.transaction_id || '') + '</span>'
          : '<span class="muted">無付款紀錄</span>';
      } }
    },

    warehouse: {
      role: 'warehouse',
      title: '倉庫管理',
      icon: '📦',
      scope: 'warehouse',
      queueHint: '以下是「待出貨」的訂單，依成立時間由早到晚排列（先進先出）。' +
                 '揀貨包裝完成、交給物流公司後，按「出貨」把狀態改為已出貨。',
      emptyText: '目前沒有待出貨的訂單 🎉',
      actionLabel: '出貨',
      run: function (o) {
        return api('/staff-orders', { method: 'PUT', body: { order_id: o.order_id, status: 'shipped' } });
      },
      confirmText: function (o) {
        var unpaid = o.pay_status === 'pending';
        return '確認訂單 #' + o.order_id + ' 已交給物流公司嗎？\n\n' +
               '客戶：' + o.full_name + '\n' +
               '金額：' + money(o.total_amount) + '\n' +
               (unpaid
                 ? '\n⚠️ 這張訂單尚未收款（' +
                   (PAY_METHOD_LABEL[o.payment_method] || o.payment_method) + '）。\n' +
                   '　 貨到付款屬正常情形；若是 ATM 轉帳，請先與財務確認。\n'
                 : '') +
               '\n出貨後狀態會改為「已出貨」，交由物流回報送達。';
      },
      focusColumn: { head: '付款狀況', cell: function (o) {
        if (!o.payment_id) return '<span class="tag cancelled">無付款紀錄</span>';
        var ps = o.pay_status || '';
        // 未收款的訂單標紅，讓倉管出貨前先看一眼
        return '<span class="tag ' + (ps === 'success' ? 'paid' : ps === 'pending' ? 'pending' : 'cancelled') + '">' +
               esc(PAY_STATUS_LABEL[ps] || ps) + '</span>' +
               '<br><span class="muted">' + esc(PAY_METHOD_LABEL[o.payment_method] || o.payment_method) + '</span>';
      } }
    },

    logistics: {
      role: 'logistics',
      title: '物流管理',
      icon: '🚚',
      scope: 'logistics',
      queueHint: '以下是「已出貨」、等待送達回報的訂單。實際送達並由客戶簽收後，' +
                 '按「回報送達」把狀態改為已完成。',
      emptyText: '目前沒有待配送的訂單 🎉',
      actionLabel: '回報送達',
      run: function (o) {
        return api('/staff-orders', { method: 'PUT', body: { order_id: o.order_id, status: 'completed' } });
      },
      confirmText: function (o) {
        var cod = o.payment_method === 'COD' && o.pay_status === 'pending';
        return '確認訂單 #' + o.order_id + ' 已送達客戶手中嗎？\n\n' +
               '客戶：' + o.full_name + '\n' +
               '金額：' + money(o.total_amount) + '\n' +
               (cod ? '\n⚠️ 這是貨到付款且尚未收款，請確認已向客戶收取現金，\n　 並通知財務登錄收款。\n' : '') +
               '\n回報後訂單狀態會改為「已完成」。';
      },
      focusColumn: { head: '配送資訊', cell: function (o) {
        var cod = o.payment_method === 'COD';
        return esc(o.email) +
          (cod ? '<br><span class="tag pending">貨到付款 ' + money(o.total_amount) + '</span>' : '');
      } }
    }
  };

  var MODE = MODES[window.OPS_MODE];

  // ======================================================================
  // 工具
  // ======================================================================

  /** 🛡️ 一律經過這裡再塞進 innerHTML —— 客戶姓名、信箱都是使用者輸入 */
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) {
    var v = Number(n || 0);
    if (!isFinite(v)) v = 0;
    // 整數不補小數點，有小數才顯示兩位 —— 商品價格多為整數，補 .00 只是雜訊
    var s = Math.abs(v).toFixed(Number.isInteger(v) ? 0 : 2);
    var dot = s.indexOf('.');
    var whole = dot < 0 ? s : s.slice(0, dot);
    var frac = dot < 0 ? '' : s.slice(dot);
    // 千分位：在「右邊剛好還剩 3 的倍數個數字」的位置插逗號，
    // \B 確保不會插在字串最前面（1000 → 1,000 而不是 ,1,000）
    return (v < 0 ? '-$' : '$') + whole.replace(/\B(?=(\d{3})+$)/g, ',') + frac;
  }
  function when(v) { return v ? String(v).replace('T', ' ').slice(0, 19) : '—'; }
  function $(id) { return document.getElementById(id); }

  function notify(msg, kind) {
    var el = $('opsMsg');
    if (!el) return;
    el.innerHTML = msg ? '<div class="notice ' + (kind || 'ok') + '">' + esc(msg) + '</div>' : '';
    if (kind === 'ok') setTimeout(function () { el.innerHTML = ''; }, 4000);
  }

  // ======================================================================
  // API
  // ======================================================================
  async function api(path, options) {
    options = options || {};
    var headers = {};
    if (options.body) headers['Content-Type'] = 'application/json';
    if (TOKEN) {
      headers['Authorization'] = 'Bearer ' + TOKEN;
      headers['X-Auth-Token'] = TOKEN; // Apache 有時會吃掉 Authorization
    }
    var res = await fetch(API_URL + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    var text = await res.text();
    var data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch (e) { throw new Error('伺服器回傳非 JSON 內容（HTTP ' + res.status + '）\n' + text.slice(0, 200)); }
    }
    if (res.status === 401 || (data && data.code === 'ACCOUNT_SUSPENDED')) {
      bounceToLogin((data && data.code === 'ACCOUNT_SUSPENDED') ? 'suspended' : 'expired');
      throw new Error((data && data.message) || '登入已過期');
    }
    if (!res.ok) throw new Error((data && data.message) || ('伺服器錯誤 HTTP ' + res.status));
    return data;
  }

  // ======================================================================
  // 守門
  // ======================================================================
  function bounceToLogin(reason) {
    TOKEN = null; ME = null;
    localStorage.removeItem('shop_token');
    location.replace(LOGIN_PAGE + (reason ? '?reason=' + encodeURIComponent(reason) : ''));
  }

  function doLogout() {
    var old = TOKEN;
    if (old) {
      // 告訴後端把權杖列入黑名單。不等結果 —— 本機已經清掉了。
      fetch(API_URL + '/users?action=logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + old, 'X-Auth-Token': old }
      }).catch(function () {});
    }
    bounceToLogin('logout');
  }

  async function boot() {
    if (!MODE) {
      document.body.innerHTML = '<div class="notice err" style="margin:40px;">' +
        'ops.js 沒有拿到有效的 OPS_MODE，請檢查頁面設定。</div>';
      return;
    }
    if (!TOKEN) { bounceToLogin(); return; }

    try {
      var me = await api('/users');
      if (!me || !me.user_id) throw new Error('無法取得帳號資料');
      if (me.role !== MODE.role) {
        // 走錯門就送去對的那一頁（me.home 是後端算好的）
        location.replace(me.home || LOGIN_PAGE + '?reason=denied');
        return;
      }
      ME = me;
      showApp();
    } catch (e) {
      var box = $('checking');
      if (box) {
        box.innerHTML = '<div class="gate-card"><div class="gate-error">' + esc(e.message) +
          '</div><p><a href="' + LOGIN_PAGE + '">返回登入頁</a></p></div>';
      }
    }
  }

  function showApp() {
    $('checking').style.display = 'none';
    $('app').classList.add('ready');
    $('whoami').innerHTML =
      esc(ME.full_name) + '<br>' +
      '<span class="muted">' + esc(ME.email) + '</span><br>' +
      '<span class="badge ' + esc(ME.role) + '">' + esc(ROLE_LABEL[ME.role] || ME.role) + '</span>';
    $('opsTitle').textContent = MODE.icon + ' ' + MODE.title;
    $('opsHint').textContent = MODE.queueHint;
    $('focusHead').textContent = MODE.focusColumn.head;
    $('actionHead').textContent = '操作';
    loadQueue(1);
  }

  // ======================================================================
  // 工作佇列
  // ======================================================================
  var rowsCache = {}; // { [order_id]: 該列的原始資料 } —— 動作要用到客戶名、金額等

  async function loadQueue(page) {
    var tbody = document.querySelector('#opsTable tbody');
    tbody.innerHTML = '<tr><td colspan="7" class="empty">載入中...</td></tr>';
    try {
      var res = await api('/staff-orders?scope=' + MODE.scope + '&page=' + (page || 1));
      var rows = res.data || [];
      rowsCache = {};

      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">' + esc(MODE.emptyText) + '</td></tr>';
      } else {
        tbody.innerHTML = rows.map(function (o) {
          rowsCache[String(o.order_id)] = o;
          var st = String(o.status || '');
          return '<tr>' +
            '<td>' + esc(o.order_id) + '</td>' +
            '<td>' + esc(o.full_name) + '<br><span class="muted">' + esc(o.email) + '</span></td>' +
            '<td class="num">' + money(o.total_amount) + '</td>' +
            '<td><span class="tag ' + esc(st) + '">' + esc(ORDER_STATUS_LABEL[st] || st) + '</span></td>' +
            '<td>' + esc(when(o.created_at)) + '</td>' +
            '<td>' + MODE.focusColumn.cell(o) + '</td>' +
            '<td><div class="btn-row">' +
              '<button class="small" onclick="OPS.act(' + esc(o.order_id) + ')">' + esc(MODE.actionLabel) + '</button>' +
              '<button class="small secondary" onclick="OPS.detail(' + esc(o.order_id) + ')">明細</button>' +
            '</div></td>' +
            '</tr>' +
            '<tr class="detail-row" id="od-' + esc(o.order_id) + '" style="display:none;"><td colspan="7"></td></tr>';
        }).join('');
      }
      renderPager(res);
      $('queueCount').textContent = '待處理 ' + (res.total || 0) + ' 筆';
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">' + esc(e.message) + '</td></tr>';
    }
  }

  function renderPager(meta) {
    var el = $('opsPager');
    if (!meta || meta.total_pages <= 1) {
      el.innerHTML = '<span class="info">共 ' + esc(meta ? meta.total : 0) + ' 筆</span>';
      return;
    }
    var p = meta.page;
    el.innerHTML =
      '<button ' + (p <= 1 ? 'disabled' : '') + ' onclick="OPS.load(1)">« 第一頁</button>' +
      '<button ' + (p <= 1 ? 'disabled' : '') + ' onclick="OPS.load(' + (p - 1) + ')">‹ 上一頁</button>' +
      '<span class="info">第 ' + p + ' / ' + meta.total_pages + ' 頁（共 ' + meta.total + ' 筆，每頁 ' + meta.per_page + ' 筆）</span>' +
      '<button ' + (p >= meta.total_pages ? 'disabled' : '') + ' onclick="OPS.load(' + (p + 1) + ')">下一頁 ›</button>' +
      '<button ' + (p >= meta.total_pages ? 'disabled' : '') + ' onclick="OPS.load(' + meta.total_pages + ')">最後一頁 »</button>';
  }

  /** 執行本角色的動作（確認收款 / 出貨 / 回報送達） */
  async function act(orderId) {
    var o = rowsCache[String(orderId)];
    if (!o) return;
    if (!confirm(MODE.confirmText(o))) return;
    try {
      var r = await MODE.run(o);
      notify((r && r.message) || '已完成', 'ok');
      loadQueue(1); // 處理完就會離開本佇列，重載回第一頁
    } catch (e) {
      notify(e.message, 'err');
      loadQueue(1);
    }
  }

  /** 展開訂單完整資訊（主檔 + 明細 + 付款） */
  async function detail(orderId) {
    var row = $('od-' + orderId);
    if (!row) return;
    if (row.style.display !== 'none') { row.style.display = 'none'; return; }
    row.style.display = 'table-row';
    var cell = row.firstElementChild;
    cell.innerHTML = '載入中...';
    try {
      var d = await api('/orders?order_id=' + orderId);
      var items = (d.items || []).map(function (it) {
        var unit = Number(it.price_at_purchase != null ? it.price_at_purchase : it.price || 0);
        var qty = Number(it.quantity || 0);
        return '<tr><td>' + esc(it.name || ('商品 #' + it.product_id)) + '</td>' +
               '<td class="num">' + qty + '</td>' +
               '<td class="num">' + money(unit) + '</td>' +
               '<td class="num">' + money(unit * qty) + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="muted">沒有明細資料</td></tr>';

      var pay = d.payment
        ? '支付方式：' + esc(PAY_METHOD_LABEL[d.payment.payment_method] || d.payment.payment_method) +
          '　付款狀態：' + esc(PAY_STATUS_LABEL[d.payment.status] || d.payment.status) +
          '　收款時間：' + esc(when(d.payment.paid_at)) +
          '<br>交易序號：<span class="muted">' + esc(d.payment.transaction_id) + '</span>'
        : '<span class="muted">尚無付款紀錄</span>';

      cell.innerHTML =
        '<table style="margin:0;"><thead><tr><th>商品</th><th>數量</th><th>成交單價</th><th>小計</th></tr></thead>' +
        '<tbody>' + items + '</tbody></table>' +
        '<p style="margin:8px 0 0;font-size:12px;">' + pay + '</p>';
    } catch (e) {
      cell.innerHTML = '<div class="notice err">' + esc(e.message) + '</div>';
    }
  }

  // ======================================================================
  window.OPS = {
    load: loadQueue,
    act: act,
    detail: detail,
    refresh: function () { loadQueue(1); },
    logout: doLogout
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
