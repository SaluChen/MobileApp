/* ==========================================================================
 * 後台共用邏輯 —— admin.html 與 manager.html 共用
 * --------------------------------------------------------------------------
 * 兩支後台的畫面與功能相同，差別只在「允許進入的角色」。
 * 各自的 HTML 在載入本檔之前先設定：
 *     window.BACKOFFICE_ROLE = 'admin';   // 或 'manager'
 * 把同一份邏輯抄成兩份的話，日後改一個 bug 就要記得改兩個地方。
 *
 * 🔐 登入功能已抽離到 login.html。本檔只負責「守門」：
 *      沒有權杖         → 導向 login.html
 *      角色不符本頁     → 導向後端指定的那一頁（me.home）
 *      權杖過期/被停用  → 導向 login.html?reason=...
 *    好處是登入表單與驗證邏輯只有一份，不必在三支網頁各維護一次。
 *
 * 🛡️ 前端的角色檢查只是「不要讓看不懂的畫面出現」，不是安全機制。
 *    真正的把關在 api.php：每支後台端點都會用權杖驗身分與角色，
 *    直接用工具打 API 一樣會被 401 / 403 擋下。
 * ========================================================================== */
(function () {
  'use strict';

  var REQUIRED_ROLE = window.BACKOFFICE_ROLE;
  var ROLE_LABEL = {
    customer: '一般會員', manager: '營運人員', finance: '財務',
    warehouse: '倉管', logistics: '物流', admin: '系統管理員'
  };
  var ASSIGNABLE_ROLES = ['customer', 'manager', 'finance', 'warehouse', 'logistics', 'admin'];
  var LOGIN_PAGE = 'login.html';

  // API 位址預設用「與本頁同目錄的 api.php」——
  // 後台頁面通常就跟 api.php 放在同一台伺服器，走相對路徑可以完全避開 CORS。
  // 位址是在 login.html 設定的，這裡只讀。
  var DEFAULT_API = 'api.php';
  var API_URL = localStorage.getItem('shop_api_url') || DEFAULT_API;
  var TOKEN = localStorage.getItem('shop_token') || null;
  var ME = null;

  var chatTimer = null;
  var activeRoomId = null;
  var editingProductId = null;
  var editingCategoryId = null;

  // ======================================================================
  // 工具
  // ======================================================================

  /** 🛡️ 一律經過這裡再塞進 innerHTML。
   *  聊天訊息、商品名稱、會員姓名都是使用者輸入，
   *  沒跳脫的話對方打一段 <img onerror=...> 就會在後台執行 —— 典型的儲存型 XSS。 */
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  function when(value) {
    if (!value) return '—';
    return String(value).replace('T', ' ').slice(0, 19);
  }

  function $(id) { return document.getElementById(id); }

  function notify(containerId, message, kind) {
    var el = $(containerId);
    if (!el) return;
    if (!message) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="notice ' + (kind || 'info') + '">' + esc(message) + '</div>';
    if (kind === 'ok') {
      setTimeout(function () { if (el.firstChild) el.innerHTML = ''; }, 4000);
    }
  }

  // ======================================================================
  // API 請求層
  // ======================================================================
  async function api(path, options) {
    options = options || {};
    var headers = {};
    if (options.body) headers['Content-Type'] = 'application/json';
    if (TOKEN) {
      headers['Authorization'] = 'Bearer ' + TOKEN;
      // Apache 在部分設定下會吃掉 Authorization，補一個不會被過濾的備援
      headers['X-Auth-Token'] = TOKEN;
    }

    var res = await fetch(API_URL + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    // 先取純文字再自己 parse：PHP 若噴 warning，回應會是「HTML + JSON」，
    // 直接 res.json() 只會拿到看不懂的 parse error。
    var text = await res.text();
    var data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('伺服器回傳非 JSON 內容（HTTP ' + res.status + '）\n' + text.slice(0, 200));
      }
    }

    // 401 = 權杖過期；ACCOUNT_SUSPENDED（403）= 帳號被停用。兩者都要回登入頁。
    // 用後端給的 code 判斷而不是比對中文訊息 —— 訊息改字前端就不會壞。
    if (res.status === 401 || (data && data.code === 'ACCOUNT_SUSPENDED')) {
      var why = (data && data.code === 'ACCOUNT_SUSPENDED') ? 'suspended' : 'expired';
      bounceToLogin(why);
      throw new Error((data && data.message) || '登入已過期，請重新登入');
    }
    if (!res.ok) {
      throw new Error((data && data.message) || ('伺服器錯誤 HTTP ' + res.status));
    }
    return data;
  }

  // ======================================================================
  // 守門（登入功能已移至 login.html）
  // ======================================================================

  /** 清掉本機登入狀態並回到登入頁。reason 讓 login.html 顯示原因。 */
  function bounceToLogin(reason) {
    TOKEN = null;
    ME = null;
    localStorage.removeItem('shop_token');
    stopChatPolling();
    location.replace(LOGIN_PAGE + (reason ? '?reason=' + encodeURIComponent(reason) : ''));
  }

  function showApp() {
    $('app').classList.add('ready');
    var checking = $('checking');
    if (checking) checking.style.display = 'none';
    $('whoami').innerHTML =
      esc(ME.full_name) + '<br>' +
      '<span class="muted">' + esc(ME.email) + '</span><br>' +
      '<span class="badge ' + esc(ME.role) + '">' + esc(ROLE_LABEL[ME.role] || ME.role) + '</span>';
    switchTab('tab-products');
  }

  /** 使用者主動登出：先請後端把權杖列入黑名單，再回登入頁 */
  function doLogout() {
    var old = TOKEN;
    // 不等結果也不擋流程 —— 就算網路失敗，本機已經清掉了，
    // 那張權杖最多 7 天後也會自然過期。
    if (old) {
      fetch(API_URL + '/users?action=logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + old, 'X-Auth-Token': old }
      }).catch(function () {});
    }
    bounceToLogin('logout');
  }

  /**
   * 開頁守門：
   *   沒權杖         → login.html
   *   角色不符本頁   → 後端指定的那一頁（me.home），而不是丟一句錯誤讓人卡住
   *   權杖無效       → login.html?reason=expired（由 api() 內部處理）
   */
  async function boot() {
    if (!TOKEN) { bounceToLogin(); return; }
    try {
      var me = await api('/users');
      if (!me || !me.user_id) throw new Error('無法取得帳號資料');

      if (me.role !== REQUIRED_ROLE) {
        // 走錯門就直接送到對的那一頁；me.home 是後端算好的
        location.replace(me.home || LOGIN_PAGE + '?reason=denied');
        return;
      }
      ME = me;
      showApp();
    } catch (e) {
      // api() 收到 401/停用時已經跳轉了，這裡處理其他錯誤（例如連不上伺服器）
      var checking = $('checking');
      if (checking) {
        checking.innerHTML = '<div class="notice err">' + esc(e.message) +
          '</div><p><a href="' + LOGIN_PAGE + '">返回登入頁</a></p>';
      }
    }
  }

  // ======================================================================
  // 頁籤切換
  // ======================================================================
  function switchTab(tabId) {
    var panels = document.querySelectorAll('.tab-panel');
    for (var i = 0; i < panels.length; i++) panels[i].classList.remove('active');
    var links = document.querySelectorAll('.sidebar a[data-tab]');
    for (var j = 0; j < links.length; j++) links[j].classList.remove('active');

    var panel = $(tabId);
    if (panel) panel.classList.add('active');
    var link = document.querySelector('.sidebar a[data-tab="' + tabId + '"]');
    if (link) link.classList.add('active');

    stopChatPolling(); // 離開客服頁就停止輪詢，不要在背景一直打 API

    if (tabId === 'tab-products') { loadCategoryOptions(); loadProducts(1); }
    if (tabId === 'tab-categories') loadCategories();
    if (tabId === 'tab-orders') loadOrders(1);
    if (tabId === 'tab-users') loadUsers(1);
    if (tabId === 'tab-chat') startChat();
  }

  // ======================================================================
  // 分頁列
  // ======================================================================
  function renderPager(containerId, meta, goFnName) {
    var el = $(containerId);
    if (!el) return;
    if (!meta || meta.total_pages <= 1) {
      el.innerHTML = '<span class="info">共 ' + esc(meta ? meta.total : 0) + ' 筆</span>';
      return;
    }
    var p = meta.page;
    el.innerHTML =
      '<button ' + (p <= 1 ? 'disabled' : '') + ' onclick="' + goFnName + '(1)">« 第一頁</button>' +
      '<button ' + (p <= 1 ? 'disabled' : '') + ' onclick="' + goFnName + '(' + (p - 1) + ')">‹ 上一頁</button>' +
      '<span class="info">第 ' + p + ' / ' + meta.total_pages + ' 頁（共 ' + meta.total + ' 筆，每頁 ' + meta.per_page + ' 筆）</span>' +
      '<button ' + (p >= meta.total_pages ? 'disabled' : '') + ' onclick="' + goFnName + '(' + (p + 1) + ')">下一頁 ›</button>' +
      '<button ' + (p >= meta.total_pages ? 'disabled' : '') + ' onclick="' + goFnName + '(' + meta.total_pages + ')">最後一頁 »</button>';
  }

  // ======================================================================
  // 一、商品管理
  // ======================================================================

  /** 需求 4：分類欄位改用 listbox，選項同時列出 category_id 與 category_name */
  async function loadCategoryOptions(selectedId) {
    var sel = $('pCatId');
    try {
      var cats = await api('/categories');
      var html = '<option value="">（未分類）</option>';
      (cats || []).forEach(function (c) {
        html += '<option value="' + esc(c.category_id) + '">'
          + esc(c.category_id) + ' - ' + esc(c.category_name) + '</option>';
      });
      sel.innerHTML = html;
      if (selectedId !== undefined && selectedId !== null) sel.value = String(selectedId);
    } catch (e) {
      sel.innerHTML = '<option value="">（分類載入失敗）</option>';
    }
  }

  async function loadProducts(page) {
    var tbody = document.querySelector('#productsTable tbody');
    tbody.innerHTML = '<tr><td colspan="8" class="empty">載入中...</td></tr>';
    try {
      var res = await api('/staff-products?page=' + (page || 1));
      var rows = res.data || [];
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty">目前沒有商品</td></tr>';
      } else {
        tbody.innerHTML = rows.map(function (p) {
          return '<tr>' +
            '<td>' + esc(p.product_id) + '</td>' +
            '<td>' + esc(p.name) + '</td>' +
            '<td>' + (p.category_name
              ? esc(p.category_id) + ' - ' + esc(p.category_name)
              : '<span class="muted">未分類</span>') + '</td>' +
            '<td class="num">' + money(p.price) + '</td>' +
            '<td class="num">' + esc(p.stock_quantity) + '</td>' +
            '<td class="muted">' + esc((p.description || '').slice(0, 30)) + '</td>' +
            '<td><div class="btn-row">' +
              '<button class="small secondary" onclick="BO.editProduct(' + esc(p.product_id) + ')">編輯</button>' +
              '<button class="small danger" onclick="BO.deleteProduct(' + esc(p.product_id) + ', \'' + esc(p.name).replace(/'/g, '&#39;') + '\')">刪除</button>' +
            '</div></td>' +
            '</tr>';
        }).join('');
      }
      renderPager('productsPager', res, 'BO.loadProducts');
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">' + esc(e.message) + '</td></tr>';
    }
  }

  async function editProduct(id) {
    notify('productMsg', '', null);
    try {
      var p = await api('/products?id=' + id);
      if (!p || !p.product_id) throw new Error('找不到商品');
      editingProductId = p.product_id;
      $('pName').value = p.name || '';
      $('pPrice').value = p.price || '';
      $('pStock').value = p.stock_quantity || 0;
      $('pDesc').value = p.description || '';
      $('pImage').value = p.image_url || '';
      await loadCategoryOptions(p.category_id === null ? '' : p.category_id);
      $('productFormTitle').textContent = '編輯商品 #' + p.product_id;
      $('productSubmitBtn').textContent = '儲存變更';
      $('productCancelBtn').style.display = 'inline-block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      notify('productMsg', e.message, 'err');
    }
  }

  function resetProductForm() {
    editingProductId = null;
    $('productForm').reset();
    $('productFormTitle').textContent = '新商品上架';
    $('productSubmitBtn').textContent = '確認上架';
    $('productCancelBtn').style.display = 'none';
    loadCategoryOptions();
  }

  async function submitProduct(event) {
    event.preventDefault();
    var btn = $('productSubmitBtn');
    btn.disabled = true;
    try {
      var payload = {
        // listbox 的空字串代表「未分類」，要送 null 而不是 0（外鍵沒有 0 這筆）
        category_id: $('pCatId').value === '' ? null : parseInt($('pCatId').value, 10),
        name: $('pName').value,
        price: parseFloat($('pPrice').value),
        stock_quantity: parseInt($('pStock').value, 10),
        description: $('pDesc').value,
        image_url: $('pImage').value || undefined
      };

      if (editingProductId) {
        payload.product_id = editingProductId;
        await api('/staff-products', { method: 'PUT', body: payload });
        notify('productMsg', '商品 #' + editingProductId + ' 已更新', 'ok');
      } else {
        var r = await api('/staff-products', { method: 'POST', body: payload });
        notify('productMsg', '商品已上架，編號 #' + (r && r.product_id), 'ok');
      }
      resetProductForm();
      loadProducts(1);
    } catch (e) {
      notify('productMsg', e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteProduct(id, name) {
    if (!confirm('確定要刪除商品「' + name + '」(#' + id + ') 嗎？\n歷史訂單明細會保留，但會查不到商品名稱。')) return;
    try {
      await api('/staff-products?product_id=' + id, { method: 'DELETE' });
      notify('productMsg', '商品 #' + id + ' 已刪除', 'ok');
      loadProducts(1);
    } catch (e) {
      notify('productMsg', e.message, 'err');
    }
  }

  // ======================================================================
  // 二、分類管理
  // ======================================================================
  async function loadCategories() {
    var tbody = document.querySelector('#categoriesTable tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="empty">載入中...</td></tr>';
    try {
      var rows = await api('/staff-categories');
      if (!rows || !rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">還沒有任何分類</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (c) {
        return '<tr>' +
          '<td>' + esc(c.category_id) + '</td>' +
          '<td>' + esc(c.category_name) + '</td>' +
          '<td class="muted">' + esc(c.description || '') + '</td>' +
          '<td class="num">' + esc(c.product_count) + '</td>' +
          '<td><div class="btn-row">' +
            '<button class="small secondary" onclick="BO.editCategory(' + esc(c.category_id) + ', \'' + esc(c.category_name).replace(/'/g, '&#39;') + '\', \'' + esc(c.description || '').replace(/'/g, '&#39;') + '\')">編輯</button>' +
            '<button class="small danger" onclick="BO.deleteCategory(' + esc(c.category_id) + ', \'' + esc(c.category_name).replace(/'/g, '&#39;') + '\', ' + esc(c.product_count) + ')">刪除</button>' +
          '</div></td>' +
          '</tr>';
      }).join('');
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">' + esc(e.message) + '</td></tr>';
    }
  }

  function editCategory(id, name, desc) {
    editingCategoryId = id;
    $('cName').value = name;
    $('cDesc').value = desc;
    $('categoryFormTitle').textContent = '編輯分類 #' + id;
    $('categorySubmitBtn').textContent = '儲存變更';
    $('categoryCancelBtn').style.display = 'inline-block';
  }

  function resetCategoryForm() {
    editingCategoryId = null;
    $('categoryForm').reset();
    $('categoryFormTitle').textContent = '新增分類';
    $('categorySubmitBtn').textContent = '新增分類';
    $('categoryCancelBtn').style.display = 'none';
  }

  async function submitCategory(event) {
    event.preventDefault();
    var btn = $('categorySubmitBtn');
    btn.disabled = true;
    try {
      var payload = { category_name: $('cName').value, description: $('cDesc').value };
      if (editingCategoryId) {
        payload.category_id = editingCategoryId;
        await api('/staff-categories', { method: 'PUT', body: payload });
        notify('categoryMsg', '分類 #' + editingCategoryId + ' 已更新', 'ok');
      } else {
        await api('/staff-categories', { method: 'POST', body: payload });
        notify('categoryMsg', '分類已新增', 'ok');
      }
      resetCategoryForm();
      loadCategories();
    } catch (e) {
      notify('categoryMsg', e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteCategory(id, name, productCount) {
    var warn = productCount > 0
      ? '\n\n⚠️ 這個分類底下有 ' + productCount + ' 件商品，刪除後它們會變成「未分類」（商品本身不會消失）。'
      : '';
    if (!confirm('確定要刪除分類「' + name + '」(#' + id + ') 嗎？' + warn)) return;
    try {
      await api('/staff-categories?category_id=' + id, { method: 'DELETE' });
      notify('categoryMsg', '分類 #' + id + ' 已刪除', 'ok');
      loadCategories();
    } catch (e) {
      notify('categoryMsg', e.message, 'err');
    }
  }

  // ======================================================================
  // 三、訂單與支付流水（需求 7：每 20 筆一頁，最早成立的排最前面）
  // ======================================================================
  // 訂單狀態現在只表示履約進度（付款狀態獨立在 Payments.status）。
  // pending / paid 是舊制留下的值，只會出現在歷史資料，不列入可選清單。
  var ORDER_STATUS = ['awaiting_shipment', 'shipped', 'completed', 'cancelled'];
  var ORDER_STATUS_LABEL = {
    awaiting_shipment: '待出貨', shipped: '已出貨', completed: '已完成',
    cancelled: '已取消', pending: '待付款(舊)', paid: '已付款(舊)'
  };
  var PAY_METHOD_LABEL = {
    'Credit Card': '信用卡', 'Mobile Pay': '行動支付', 'App Pay': 'App 支付',
    'ATM Transfer': 'ATM 轉帳', 'COD': '貨到付款'
  };
  var PAY_STATUS_LABEL = { success: '已收款', pending: '待收款', cancelled: '已取消' };
  var ORDERS_COLSPAN = 10;

  async function loadOrders(page) {
    var tbody = document.querySelector('#ordersTable tbody');
    tbody.innerHTML = '<tr><td colspan="' + ORDERS_COLSPAN + '" class="empty">載入中...</td></tr>';
    try {
      var res = await api('/staff-orders?page=' + (page || 1));
      var rows = res.data || [];
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="' + ORDERS_COLSPAN + '" class="empty">目前沒有訂單</td></tr>';
      } else {
        tbody.innerHTML = rows.map(function (o) {
          var st = String(o.status || '');
          var ps = String(o.pay_status || '');
          var opts = ORDER_STATUS.map(function (s) {
            return '<option value="' + s + '"' + (s === st ? ' selected' : '') + '>' + (ORDER_STATUS_LABEL[s] || s) + '</option>';
          }).join('');

          // 付款狀態欄：待收款時給一顆「確認收款」——
          // ATM 轉帳查到入帳、貨到付款收到現金時按這個。
          var payCell;
          if (!o.payment_id) {
            payCell = '<span class="muted">無付款紀錄</span>';
          } else if (ps === 'pending') {
            payCell = '<span class="tag pending">' + esc(PAY_STATUS_LABEL[ps] || ps) + '</span>' +
              '<br><button class="small" style="margin-top:4px;" ' +
              'onclick="BO.confirmPayment(' + esc(o.order_id) + ', \'' +
              esc(PAY_METHOD_LABEL[o.payment_method] || o.payment_method) + '\', \'' +
              esc(money(o.total_amount)) + '\')">確認收款</button>';
          } else {
            payCell = '<span class="tag ' + (ps === 'cancelled' ? 'cancelled' : 'paid') + '">' +
              esc(PAY_STATUS_LABEL[ps] || ps) + '</span>';
          }

          return '<tr>' +
            '<td>' + esc(o.order_id) + '</td>' +
            '<td>' + esc(o.full_name) + '<br><span class="muted">' + esc(o.email) + '</span></td>' +
            '<td class="num">' + money(o.total_amount) + '</td>' +
            '<td><span class="tag ' + esc(st) + '">' + esc(ORDER_STATUS_LABEL[st] || st) + '</span></td>' +
            '<td>' + esc(when(o.created_at)) + '</td>' +
            '<td>' + (o.payment_id
              ? esc(PAY_METHOD_LABEL[o.payment_method] || o.payment_method) +
                '<br><span class="muted">' + esc(o.transaction_id) + '</span>'
              : '<span class="muted">未付款</span>') + '</td>' +
            '<td>' + payCell + '</td>' +
            '<td>' + (o.paid_at ? esc(when(o.paid_at)) : '<span class="muted">—</span>') + '</td>' +
            '<td><select class="small" onchange="BO.changeOrderStatus(' + esc(o.order_id) + ', this.value)"' +
              (st === 'cancelled' ? ' disabled' : '') + '>' + opts + '</select></td>' +
            '<td><button class="small secondary" onclick="BO.toggleOrderItems(' + esc(o.order_id) + ')">明細</button></td>' +
            '</tr>' +
            '<tr class="detail-row" id="orderItems-' + esc(o.order_id) + '" style="display:none;">' +
              '<td colspan="' + ORDERS_COLSPAN + '">點「明細」載入中...</td>' +
            '</tr>';
        }).join('');
      }
      renderPager('ordersPager', res, 'BO.loadOrders');
      $('ordersSortHint').textContent =
        '依「成立時間」由最早排到最晚，每頁 ' + (res.per_page || 20) + ' 筆。';
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="' + ORDERS_COLSPAN + '" class="empty">' + esc(e.message) + '</td></tr>';
    }
  }

  /**
   * 確認收款：把付款紀錄從 pending 改成 success。
   * 走的是 staff-payments 而不是 staff-orders —— 訂單狀態現在只表示履約進度，
   * 收款不會、也不該去動它。（財務角色有專屬頁面 finance.html 做同一件事。）
   */
  async function confirmPayment(orderId, methodLabel, amount) {
    if (!confirm('確認已收到訂單 #' + orderId + ' 的款項嗎？\n\n' +
                 '支付方式：' + methodLabel + '\n金額：' + amount + '\n\n' +
                 '確認後付款狀態會改為「已收款」並記錄收款時間。\n' +
                 '訂單的出貨進度不受影響。')) return;
    try {
      var r = await api('/staff-payments', { method: 'PUT', body: { order_id: orderId, status: 'success' } });
      notify('orderMsg', (r && r.message) || '已確認收款', 'ok');
      loadOrders(1);
    } catch (e) {
      notify('orderMsg', e.message, 'err');
      loadOrders(1);
    }
  }

  async function toggleOrderItems(orderId) {
    var row = $('orderItems-' + orderId);
    if (!row) return;
    if (row.style.display !== 'none') { row.style.display = 'none'; return; }
    row.style.display = 'table-row';
    row.innerHTML = '<td colspan="9">載入明細中...</td>';
    try {
      var items = await api('/order-items?order_id=' + orderId);
      if (!items || !items.length) {
        row.innerHTML = '<td colspan="9" class="muted">這張訂單沒有明細資料</td>';
        return;
      }
      var html = '<td colspan="9"><table style="margin:0;"><thead><tr>' +
        '<th>商品</th><th>數量</th><th>成交單價</th><th>小計</th></tr></thead><tbody>';
      items.forEach(function (it) {
        var unit = Number(it.price_at_purchase != null ? it.price_at_purchase : it.price || 0);
        var qty = Number(it.quantity || 0);
        html += '<tr><td>' + esc(it.name || ('商品 #' + it.product_id)) + '</td>' +
          '<td class="num">' + qty + '</td>' +
          '<td class="num">' + money(unit) + '</td>' +
          '<td class="num">' + money(unit * qty) + '</td></tr>';
      });
      html += '</tbody></table></td>';
      row.innerHTML = html;
    } catch (e) {
      row.innerHTML = '<td colspan="9" class="notice err">' + esc(e.message) + '</td>';
    }
  }

  async function changeOrderStatus(orderId, status) {
    if (status === 'cancelled' &&
        !confirm('確定要取消訂單 #' + orderId + ' 嗎？\n系統會把這張訂單扣掉的庫存全部還原，且之後無法再改狀態。')) {
      loadOrders(1);
      return;
    }
    try {
      var r = await api('/staff-orders', { method: 'PUT', body: { order_id: orderId, status: status } });
      notify('orderMsg', (r && r.message) || '狀態已更新', 'ok');
      loadOrders(1);
    } catch (e) {
      notify('orderMsg', e.message, 'err');
      loadOrders(1); // 失敗時重載，讓下拉選單回到資料庫的真實狀態
    }
  }

  // ======================================================================
  // 四、會員帳戶清單
  // ======================================================================
  var STATUS_LABEL = { active: '啟用中', suspended: '已停用' };
  var USERS_COLSPAN = 9;

  async function loadUsers(page) {
    var tbody = document.querySelector('#usersTable tbody');
    // 只有 admin 能調角色與停用/重啟（後端也會再擋一次）
    var canManage = REQUIRED_ROLE === 'admin';
    tbody.innerHTML = '<tr><td colspan="' + USERS_COLSPAN + '" class="empty">載入中...</td></tr>';
    try {
      var res = await api('/staff-users?page=' + (page || 1));
      var rows = res.data || [];
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="' + USERS_COLSPAN + '" class="empty">沒有會員資料</td></tr>';
      } else {
        tbody.innerHTML = rows.map(function (u) {
          var isSelf = ME && u.user_id === ME.user_id;
          var status = u.status || 'active';
          var suspended = status === 'suspended';

          // --- 角色欄 ---
          var roleCell;
          if (canManage && !isSelf) {
            roleCell = '<select onchange="BO.changeUserRole(' + esc(u.user_id) + ', this.value)">' +
              ASSIGNABLE_ROLES.map(function (r) {
                return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + (ROLE_LABEL[r] || r) + '</option>';
              }).join('') + '</select>';
          } else {
            roleCell = '<span class="tag ' + esc(u.role) + '">' + esc(ROLE_LABEL[u.role] || u.role) + '</span>' +
              (isSelf ? ' <span class="muted">（你自己）</span>' : '');
          }

          // --- 狀態欄 ---
          var statusCell = '<span class="tag ' + (suspended ? 'suspended' : 'active') + '">' +
            esc(STATUS_LABEL[status] || status) + '</span>';

          // --- 操作欄 ---
          var actionCell;
          if (!canManage) {
            actionCell = '<span class="muted">唯讀</span>';
          } else if (isSelf) {
            actionCell = '<span class="muted">—</span>';
          } else {
            var safeName = esc(u.full_name).replace(/'/g, '&#39;');
            actionCell = suspended
              ? '<button class="small" onclick="BO.changeUserStatus(' + esc(u.user_id) + ', \'active\', \'' + safeName + '\')">重啟</button>'
              : '<button class="small danger" onclick="BO.changeUserStatus(' + esc(u.user_id) + ', \'suspended\', \'' + safeName + '\')">停用</button>';
          }

          // 停用的列整列淡化，一眼看得出誰被關掉了
          return '<tr' + (suspended ? ' style="opacity:.55;"' : '') + '>' +
            '<td>' + esc(u.user_id) + '</td>' +
            '<td>' + esc(u.email) + '</td>' +
            '<td>' + esc(u.full_name) + '</td>' +
            '<td>' + roleCell + '</td>' +
            '<td>' + statusCell + '</td>' +
            '<td class="num">' + esc(u.order_count) + '</td>' +
            '<td class="num">' + money(u.total_spent) + '</td>' +
            '<td>' + esc(when(u.created_at)) + '</td>' +
            '<td>' + actionCell + '</td>' +
            '</tr>';
        }).join('');
      }
      renderPager('usersPager', res, 'BO.loadUsers');
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="' + USERS_COLSPAN + '" class="empty">' + esc(e.message) + '</td></tr>';
    }
  }

  async function changeUserRole(userId, role) {
    try {
      var r = await api('/staff-users', { method: 'PUT', body: { user_id: userId, role: role } });
      notify('userMsg', (r && r.message) || '角色已更新', 'ok');
      loadUsers(1);
    } catch (e) {
      notify('userMsg', e.message, 'err');
      loadUsers(1); // 失敗時重載，讓下拉選單回到資料庫的真實狀態
    }
  }

  async function changeUserStatus(userId, status, name) {
    var msg = status === 'suspended'
      ? '確定要停用「' + name + '」(#' + userId + ') 嗎？\n\n' +
        '· 他將無法登入，已登入的階段也會立刻失效\n' +
        '· 訂單、評價、聊天記錄全部保留，隨時可以重啟\n' +
        '· 這不是刪除帳號'
      : '確定要重啟「' + name + '」(#' + userId + ') 的帳號嗎？\n\n他將可以重新登入。';
    if (!confirm(msg)) return;

    try {
      var r = await api('/staff-users', { method: 'PUT', body: { user_id: userId, status: status } });
      notify('userMsg', (r && r.message) || '狀態已更新', 'ok');
      loadUsers(1);
    } catch (e) {
      notify('userMsg', e.message, 'err');
      loadUsers(1);
    }
  }

  // ======================================================================
  // 五、客服即時通訊中心（customer ↔ manager）
  // ======================================================================
  function stopChatPolling() {
    if (chatTimer) { clearTimeout(chatTimer); chatTimer = null; }
  }

  function startChat() {
    activeRoomId = null;
    $('chatMessages').innerHTML = '<p class="empty">請從左側挑一間聊天室開始對話</p>';
    chatTick();
  }

  /** 遞迴 setTimeout 而非 setInterval：保證「上一輪跑完才排下一輪」，網路慢時不會堆成雪崩 */
  async function chatTick() {
    stopChatPolling();
    try {
      await loadRooms();
      if (activeRoomId) await loadMessages();
    } catch (e) {
      /* 輪詢失敗保持靜默，避免每 2 秒彈一次錯誤 */
    }
    if ($('tab-chat').classList.contains('active')) {
      chatTimer = setTimeout(chatTick, 2500);
    }
  }

  async function loadRooms() {
    var rooms = await api('/chat-rooms');
    var el = $('roomList');
    if (!rooms || !rooms.length) {
      el.innerHTML = '<p class="empty">目前沒有客服對話</p>';
      return;
    }
    el.innerHTML = rooms.map(function (r) {
      var claimed = r.manager_id
        ? '<span class="claimed">✓ ' + esc(r.manager_name || '已認領') + '</span>'
        : '<span class="unclaimed">● 待接手</span>';
      var unread = Number(r.unread_count || 0) > 0
        ? '<span class="unread">' + esc(r.unread_count) + '</span>' : '';
      return '<div class="room-item ' + (String(r.room_id) === String(activeRoomId) ? 'active' : '') + '"' +
        ' onclick="BO.selectRoom(' + esc(r.room_id) + ')">' +
        '<div class="room-title"><span>🚪 #' + esc(r.room_id) + ' ' + esc(r.customer_name) + '</span>' + unread + '</div>' +
        '<div class="room-last">' + esc(r.last_message || '（尚無訊息）') + '</div>' +
        '<div>' + claimed + ' <span class="muted" style="font-size:10px;">' + esc(when(r.last_at)) + '</span></div>' +
        '</div>';
    }).join('');
  }

  async function selectRoom(roomId) {
    activeRoomId = roomId;
    $('chatRoomTitle').textContent = '聊天室 #' + roomId;
    $('chatInput').disabled = false;
    $('chatSendBtn').disabled = false;
    $('chatCloseBtn').style.display = 'inline-block';
    await loadRooms();
    await loadMessages();
  }

  async function loadMessages() {
    if (!activeRoomId) return;
    var msgs = await api('/messages?room_id=' + activeRoomId);
    var box = $('chatMessages');
    if (!msgs || !msgs.length) {
      box.innerHTML = '<p class="empty">這間聊天室還沒有訊息，先打個招呼吧</p>';
      return;
    }
    box.innerHTML = msgs.map(function (m) {
      var mine = ME && String(m.sender_id) === String(ME.user_id);
      return '<div class="msg ' + (mine ? 'mine' : 'other') + '">' +
        '<span class="who">' + esc(m.sender_name) +
        (m.sender_role && m.sender_role !== 'customer' ? '（客服）' : '') +
        ' · ' + esc(when(m.created_at)) + '</span>' +
        esc(m.message_text) + '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  async function sendMessage() {
    var input = $('chatInput');
    var text = (input.value || '').trim();
    if (!text || !activeRoomId) return;
    input.value = '';
    try {
      // 後端會用權杖認出寄件者，並在這間房還沒人認領時自動把它記在你名下
      await api('/messages', { method: 'POST', body: { room_id: activeRoomId, message_text: text } });
      await loadMessages();
      await loadRooms();
    } catch (e) {
      input.value = text; // 送出失敗把內容還給使用者
      notify('chatMsg', e.message, 'err');
    }
  }

  async function closeRoom() {
    if (!activeRoomId) return;
    if (!confirm('確定要結案聊天室 #' + activeRoomId + ' 嗎？\n客戶下次發問時系統會自動開一間新的。')) return;
    try {
      await api('/chat-rooms', { method: 'PUT', body: { room_id: activeRoomId, action: 'close' } });
      notify('chatMsg', '聊天室 #' + activeRoomId + ' 已結案', 'ok');
      activeRoomId = null;
      $('chatRoomTitle').textContent = '尚未選擇聊天室';
      $('chatInput').disabled = true;
      $('chatSendBtn').disabled = true;
      $('chatCloseBtn').style.display = 'none';
      $('chatMessages').innerHTML = '<p class="empty">請從左側挑一間聊天室開始對話</p>';
      await loadRooms();
    } catch (e) {
      notify('chatMsg', e.message, 'err');
    }
  }

  // ======================================================================
  // 對外掛載（HTML 的 onclick 需要）
  // ======================================================================
  window.BO = {
    switchTab: switchTab,
    logout: doLogout,
    loadProducts: loadProducts,
    editProduct: editProduct,
    deleteProduct: deleteProduct,
    resetProductForm: resetProductForm,
    submitProduct: submitProduct,
    loadCategories: loadCategories,
    editCategory: editCategory,
    deleteCategory: deleteCategory,
    resetCategoryForm: resetCategoryForm,
    submitCategory: submitCategory,
    loadOrders: loadOrders,
    toggleOrderItems: toggleOrderItems,
    changeOrderStatus: changeOrderStatus,
    confirmPayment: confirmPayment,
    loadUsers: loadUsers,
    changeUserRole: changeUserRole,
    changeUserStatus: changeUserStatus,
    selectRoom: selectRoom,
    sendMessage: sendMessage,
    closeRoom: closeRoom
  };

  document.addEventListener('DOMContentLoaded', function () {
    $('productForm').addEventListener('submit', submitProduct);
    $('categoryForm').addEventListener('submit', submitCategory);
    $('chatInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
    });
    boot();
  });
})();
