# -*- coding: utf-8 -*-
# ==============================================================================
# 行動資料庫應用期末專案 - 11 大資料表通用生產級 RESTful API 核心（Python 3 版）
# ------------------------------------------------------------------------------
# 由 api.php 逐段改寫而成，端點、參數、回傳格式、HTTP 狀態碼、錯誤訊息全部與 PHP 版一致；
# 資料庫結構完全沿用 MariaDB.sql，不需任何 migration。
#
# 角色分工：
#   customer 一般消費者 —— 逛商品、購物車、下單、看自己的訂單、找客服
#   manager  營運人員   —— 管理商品/分類、處理客戶訂單、回覆客服聊天室
#   admin    系統管理員 —— manager 的全部權限，另可檢視所有聊天室
#
# 端點命名規則：
#   plain（/products、/categories…） = 前台，多為公開或客戶自用
#   staff-*（/staff-orders…）        = 後台，一律限 manager / admin
#
# 執行方式：
#   pip install -r requirements.txt
#   python api.py                    # 預設 http://0.0.0.0:5000
#
# 網址對照（三種前綴都通，舊前端存在 localStorage 的「api.php」也照樣能用）：
#   PHP 版  http://主機/api.php/products?page=2
#   本版    http://主機:5000/api/products?page=2
#           http://主機:5000/api.php/products?page=2   （相容別名）
#
# 本程式同時代管同目錄的前端網頁（index.html、login.html、後台各頁），
# 網頁與 API 同源，前端用相對路徑「api」即可，完全不會碰到 CORS。
# ==============================================================================
import base64
import configparser
import hashlib
import hmac
import json
import math
import os
import re
import time
from datetime import date, datetime
from decimal import Decimal

import bcrypt
import pymysql
import pymysql.cursors
from flask import Flask, Response, g, request, send_from_directory
from werkzeug.exceptions import HTTPException

HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=None)


# ==============================================================================
# 🧰 PHP 語意相容小工具
# ------------------------------------------------------------------------------
# PHP 的 (int)、empty()、?: 等寫法跟 Python 的直覺不一樣（例如 empty("0") 是 true），
# 改寫時若直接換成 Python 的 int() / not x，邊界情況的行為就會悄悄改變。
# 這裡集中模擬 PHP 的語意，程式其餘部分就能一對一照抄原本的邏輯。
# ==============================================================================
_NUM_RE = re.compile(r'^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?')


def php_float(v):
    """(float)$v"""
    if v is None or v is False:
        return 0.0
    if v is True:
        return 1.0
    if isinstance(v, (int, float, Decimal)):
        return float(v)
    m = _NUM_RE.match(str(v))
    return float(m.group(0)) if m else 0.0


def php_int(v):
    """(int)$v —— "12abc" → 12、"abc" → 0、None → 0、3.9 → 3"""
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    f = php_float(v)
    if math.isnan(f) or math.isinf(f):
        return 0
    return int(f)


def php_truthy(v):
    """PHP 的真假值：None、False、0、0.0、""、"0"、空陣列 都是假"""
    if v is None or v is False:
        return False
    if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool):
        return v != 0
    if isinstance(v, str):
        return v not in ('', '0')
    if isinstance(v, (list, dict, tuple)):
        return len(v) > 0
    return bool(v)


def php_empty(v):
    """empty($v)"""
    return not php_truthy(v)


def php_str(v):
    """(string)$v"""
    if v is None or v is False:
        return ''
    if v is True:
        return '1'
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def to_json_value(v):
    """資料庫值 → JSON：DECIMAL 回字串、時間回 'Y-m-d H:i:s'，與 PHP PDO 的輸出一致"""
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d %H:%M:%S')
    if isinstance(v, date):
        return v.strftime('%Y-%m-%d')
    if isinstance(v, (bytes, bytearray)):
        return v.decode('utf-8', 'replace')
    return v


def clean(obj):
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    return to_json_value(obj)


# ==============================================================================
# 📤 回應與中止
# ==============================================================================
class Deny(Exception):
    """deny()：中止並回傳錯誤（PHP 版是 http_response_code + echo + exit）"""

    def __init__(self, status, message, code=None):
        super().__init__(message)
        self.status, self.message, self.code = status, message, code


def deny(status, message, code=None):
    """
    中止並回傳錯誤。
    code 是機器可讀的錯誤代碼（選填）—— 前端要判斷「是不是帳號被停用」時，
    比對 code 比比對中文訊息可靠得多（訊息改字前端就壞了）。
    """
    raise Deny(status, message, code)


def out(data, status=200):
    """echo json_encode($data)"""
    body = json.dumps(clean(data), ensure_ascii=False)
    return Response(body, status=status, mimetype='application/json')


def empty_response(status=200):
    """PHP 某些分支沒有輸出（例如方法不符），回傳空白本文"""
    return Response('', status=status, mimetype='application/json')


@app.after_request
def cors_headers(resp):
    resp.headers['Content-Type'] = 'application/json; charset=UTF-8' \
        if resp.mimetype == 'application/json' else resp.headers.get('Content-Type')
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = \
        'Content-Type, Authorization, X-Auth-Token, X-Requested-With'
    return resp


@app.errorhandler(Deny)
def handle_deny(e):
    data = {"message": e.message}
    if e.code is not None:
        data["code"] = e.code
    return out(data, e.status)


# 🩺 全域例外攔截：沒有這一層的話，任何未攔截的資料庫錯誤都會讓伺服器吐出 HTML 錯誤頁，
#    前端拿到的就是「伺服器回傳非 JSON 內容」—— 看不出真正的原因。
#    最常見的情況是「程式更新了但資料庫沒跑 migration」，這裡直接把話講白。
@app.errorhandler(Exception)
def handle_any(e):
    if isinstance(e, HTTPException):      # 404 / 405 等路由層錯誤照常回應
        return e
    msg = str(e)
    low = msg.lower()
    schema_issue = ('unknown column' in low) or ("doesn't exist" in low) or ('unknown table' in low)
    return out({
        "message": ("資料庫結構與程式版本不符，請執行 MariaDB-migration.sql\n\n(%s)" % msg)
        if schema_issue else ("伺服器內部錯誤：%s" % msg)
    }, 500)


# ==============================================================================
# ⚙️ 設定檔 db.ini
# ------------------------------------------------------------------------------
# 依序找：環境變數 DB_INI 指定的檔案 → 本程式同目錄的 db.ini → 上一層（原本 api.php 旁邊那一份），
# 這樣不必把含密碼的設定檔複製一份到 py3/。
# ==============================================================================
def load_config():
    candidates = [os.environ.get('DB_INI'), os.path.join(HERE, 'db.ini'), os.path.join(HERE, '..', 'db.ini')]
    for path in [p for p in candidates if p]:
        if os.path.isfile(path):
            cp = configparser.ConfigParser(interpolation=None)
            with open(path, encoding='utf-8') as f:
                text = f.read()
            # parse_ini_file 允許檔案沒有 [section]；configparser 不允許，補一個預設區段
            if not re.search(r'^\s*\[', text, re.M):
                text = '[database]\n' + text
            cp.read_string(text)
            conf = {}
            for sec in cp.sections():        # parse_ini_file 預設會把各區段攤平
                for k, v in cp.items(sec):
                    v = v.strip()
                    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
                        v = v[1:-1]
                    conf[k] = v
            return conf
    return None


CONFIG = load_config()


def cfg(*keys, default=None):
    """$config['a'] ?? $config['b'] ?? default"""
    for k in keys:
        if CONFIG and CONFIG.get(k) is not None:
            return CONFIG[k]
    return default


# ⚠️ db.ini 的鍵名兩種寫法都吃：
#    db_name / dbname、username / user。
DB_HOST = cfg('host', default='127.0.0.1')
DB_NAME = cfg('db_name', 'dbname', default='shop_db')
DB_USER = cfg('username', 'user', default='root')
DB_PASS = cfg('password', 'pass', default='')
DB_PORT = php_int(cfg('port', default=3306)) or 3306


def get_db():
    if 'db' not in g:
        g.db = pymysql.connect(
            host=DB_HOST, user=DB_USER, password=DB_PASS, database=DB_NAME,
            port=DB_PORT, charset='utf8mb4', autocommit=True,
            cursorclass=pymysql.cursors.DictCursor)
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop('db', None)
    if db is not None:
        try:
            db.close()
        except Exception:
            pass


def q(sql, params=()):
    """執行 SQL，回傳 cursor（呼叫端再 fetchone / fetchall）"""
    cur = get_db().cursor()
    cur.execute(sql, params)
    return cur


def fetch(sql, params=()):
    """$stmt->fetch()：沒有資料時回傳 None（PHP 是 false）"""
    return q(sql, params).fetchone()


def fetch_all(sql, params=()):
    return list(q(sql, params).fetchall())


def fetch_column(sql, params=()):
    """$stmt->fetchColumn()：沒有資料時回傳 False（與 PHP 一致）"""
    row = q(sql, params).fetchone()
    if row is None:
        return False
    return next(iter(row.values()))


def begin():
    get_db().begin()


def commit():
    get_db().commit()


def rollback():
    try:
        get_db().rollback()
    except Exception:
        pass


# ==============================================================================
# 🔑 登入權杖（HMAC 簽章 + Revoked_Tokens 黑名單）
# ------------------------------------------------------------------------------
# 身分不再由前端送 user_id 自報，改成登入時發一張帶簽章的權杖。
# 之後所有需要身分的請求一律從權杖解出 user_id，前端送的一概忽略。
#
# 簽章是無狀態的：簽出去就收不回來，登出後那張在有效期內仍然驗得過。
# 所以搭配 Revoked_Tokens 黑名單 —— 登出時把權杖雜湊寫進去，驗完簽再查一次。
#
# 權杖格式、簽章演算法、密鑰推導方式都與 PHP 版完全相同 ——
# 兩版後端可以互換，使用者手上的權杖不必重新登入。
# ==============================================================================
TOKEN_TTL = 604800  # 權杖有效期 7 天

# ⚠️ 正式環境請在 db.ini 加一行：token_secret = "一串夠長的隨機字元"
#    沒設定時退而由資料庫帳密推導 —— 重點是「同一台機器每次算出同一組密鑰」，
#    否則簽章驗不過。但這代表密鑰強度等同資料庫密碼，正式上線務必自己設。
TOKEN_SECRET = cfg('token_secret') or hashlib.sha256(
    ('%s|%s|%s' % (DB_NAME, DB_USER, DB_PASS)).encode('utf-8')).hexdigest()


def b64u_encode(raw):
    return base64.b64encode(raw).decode('ascii').replace('+', '-').replace('/', '_').rstrip('=')


def b64u_decode(s):
    s = s.replace('-', '+').replace('_', '/')
    s = re.sub(r'[^A-Za-z0-9+/]', '', s)       # base64_decode 非嚴格模式會略過非法字元
    s += '=' * (-len(s) % 4)
    try:
        return base64.b64decode(s)
    except Exception:
        return b''


def _sign(body):
    return b64u_encode(hmac.new(TOKEN_SECRET.encode('utf-8'), body.encode('ascii'),
                                hashlib.sha256).digest())


def issue_token(user_id):
    """產生權杖：base64url(payload) . '.' . base64url(HMAC-SHA256 簽章)"""
    payload = json.dumps({'uid': int(user_id), 'exp': int(time.time()) + TOKEN_TTL},
                         separators=(',', ':'))
    body = b64u_encode(payload.encode('utf-8'))
    return body + '.' + _sign(body)


def decode_token(token):
    """驗簽 + 驗過期，通過回傳 payload dict（含 uid / exp），失敗回傳 None"""
    parts = php_str(token).split('.')
    if len(parts) != 2:
        return None
    try:
        expected = _sign(parts[0])
    except Exception:
        return None
    # 🛡️ 用 compare_digest 而不是 ==：定時比對，不會因為「第幾個字元開始不同」
    #    造成回應時間差異，被拿去一個字元一個字元地猜出簽章。
    if not hmac.compare_digest(expected, parts[1]):
        return None
    try:
        payload = json.loads(b64u_decode(parts[0]).decode('utf-8'))
    except Exception:
        return None
    if not isinstance(payload, dict) or php_empty(payload.get('uid')):
        return None
    if php_int(payload.get('exp', 0)) < int(time.time()):  # 已過期
        return None
    return payload


def read_bearer_token():
    """從 Authorization: Bearer 取權杖；部分代理伺服器會吃掉該標頭，故備援 X-Auth-Token"""
    auth = request.headers.get('Authorization', '') or ''
    m = re.match(r'^Bearer\s+(.+)$', auth.strip(), re.I)
    if m:
        return m.group(1).strip()
    return (request.headers.get('X-Auth-Token', '') or '').strip()


def sha256_hex(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def require_auth():
    """
    需要登入的端點呼叫此函式。
    回傳 {'user_id': int, 'full_name': str, 'email': str, 'role': str, 'status': str}。

    角色刻意「每次從資料庫讀」而不是寫進權杖裡：
    這樣停權或降級才會立即生效，不必等使用者手上那張權杖過期。
    """
    token = read_bearer_token()
    payload = decode_token(token)
    if not payload:
        deny(401, "登入已過期或未登入，請重新登入")

    # 🚫 黑名單比對：登出過的權杖即使簽章正確、還沒過期，也一律拒絕
    if fetch("SELECT 1 FROM Revoked_Tokens WHERE token_hash = %s", (sha256_hex(token),)):
        deny(401, "此登入階段已登出，請重新登入")

    user = fetch("SELECT user_id, full_name, email, role, status FROM Users WHERE user_id = %s",
                 (php_int(payload['uid']),))
    if not user:
        deny(401, "帳號不存在或已被移除")

    # 🚫 停用檢查放在這裡（而不是只在登入時檢查）：
    #    角色與狀態都是每次請求現查資料庫，所以 admin 一按「停用」，
    #    對方即使手上握著還沒過期的權杖，下一個動作就會被擋下 —— 不必等他登出。
    if (user.get('status') or 'active') != 'active':
        deny(403, "此帳號已被停用，請聯繫系統管理員", "ACCOUNT_SUSPENDED")

    user['user_id'] = int(user['user_id'])
    return user


def require_role(roles):
    """限定角色，不符合回 403（已登入但權限不足，與 401 未登入要分開）"""
    user = require_auth()
    if user['role'] not in roles:
        deny(403, "權限不足，此功能限「" + ' / '.join(roles) + "」使用")
    return user


def require_staff():
    """商品／分類／會員／客服等「總管」功能：只有 manager 與 admin"""
    return require_role(['manager', 'admin'])


def require_backoffice():
    """
    訂單相關的後台功能：加上三個營運角色。
    他們能「看」訂單清單，但能「改」什麼由 order_transition_rules() 各自限制。
    """
    return require_role(BACKOFFICE_ROLES)


def assert_room_member(room_id, me):
    """
    🛡️ 聊天室成員驗證（需求 9）
    customer：只有房主本人
    manager ：未認領的房（manager_id IS NULL）可接手；已認領的只有認領者本人
    admin   ：可檢視全部（系統管理員需要稽核能力）
    """
    room = fetch("SELECT room_id, customer_id, manager_id, status FROM Chat_Rooms WHERE room_id = %s",
                 (php_int(room_id),))
    if not room:
        deny(404, "找不到這間聊天室")

    uid = int(me['user_id'])
    if me['role'] == 'admin':
        return room
    if php_int(room['customer_id']) == uid:
        return room
    if me['role'] == 'manager' and (room['manager_id'] is None or php_int(room['manager_id']) == uid):
        return room

    deny(403, "你不是這間聊天室的成員")


# ==============================================================================
# 📋 業務規則常數（與 PHP 版相同）
# ==============================================================================
# 允許的支付方式 → 結算型態。
#   instant  = 結帳當下就收到錢 → 付款紀錄 'success'
#   deferred = 之後才會收到錢   → 付款紀錄 'pending'，等後台確認收款才轉 'success'
PAYMENT_METHODS = {
    'Credit Card':  'instant',   # 信用卡：線上授權即扣款
    'Mobile Pay':   'instant',   # 行動支付：同上
    'App Pay':      'instant',   # App 內建支付（手機 App 使用）
    'ATM Transfer': 'deferred',  # ATM 轉帳：要等對方真的匯款進來
    'COD':          'deferred',  # 貨到付款：送達收現才算收到錢
}

PAYMENT_LABELS = {
    'Credit Card':  '信用卡',
    'Mobile Pay':   '行動支付',
    'App Pay':      'App 支付',
    'ATM Transfer': 'ATM 轉帳',
    'COD':          '貨到付款',
}


def home_page_for_role(role):
    """
    依角色決定登入後該進哪一個頁面。
    路由表刻意放在後端：login.html 只負責「照後端說的跳轉」。
    """
    return {
        'admin':     'admin.html',      # 系統管理員後台
        'manager':   'manager.html',    # 營運人員後台
        'finance':   'finance.html',    # 訂單帳款管理
        'warehouse': 'warehouse.html',  # 倉庫管理
        'logistics': 'logistics.html',  # 物流管理
    }.get(role, 'index.html')           # customer 一般消費者前台


# 訂單履約狀態流程（只表示「貨到哪了」，付款狀態獨立在 Payments.status）。
ORDER_STATUSES = ['awaiting_shipment', 'shipped', 'completed', 'cancelled']

# 系統中所有可指派的角色（admin 在會員清單調整角色時使用）
ALL_ROLES = ['customer', 'manager', 'finance', 'warehouse', 'logistics', 'admin']

# 後台角色：這些人因為要處理訂單，可以檢視「任何一張」訂單與其明細。
BACKOFFICE_ROLES = ['manager', 'admin', 'finance', 'warehouse', 'logistics']


def is_backoffice(role):
    return role in BACKOFFICE_ROLES


def order_transition_rules(role):
    """
    哪個角色可以把訂單改成什麼狀態，以及「原本必須是什麼狀態」。
    這是整條營運流程的權限中樞 —— 倉管不能替物流按完成，物流也不能自己出貨。
    """
    if role == 'warehouse':
        # 倉管只做一件事：把待出貨的訂單交給物流
        return {'shipped': ['awaiting_shipment']}
    if role == 'logistics':
        # 物流只做一件事：回報客戶已收到貨
        return {'completed': ['shipped']}
    if role in ('manager', 'admin'):
        # 後台總管可以走任何一步，也可以取消訂單
        return {
            'awaiting_shipment': ['shipped'],            # 退回重出貨
            'shipped':           ['awaiting_shipment'],
            'completed':         ['shipped'],
            'cancelled':         ['awaiting_shipment', 'shipped'],
        }
    return {}  # finance 只管帳款，不碰履約狀態


def fmt_money(amount):
    """金額格式化：整數就不補小數，避免訊息出現 "3580.00" """
    amount = php_float(amount)
    if math.floor(amount) == amount:
        return str(int(amount))
    return '%.2f' % amount


def page_params(per_page=20):
    """分頁參數：固定每頁 20 筆"""
    page = max(1, php_int(request.args.get('page', 1)))
    return page, per_page, (page - 1) * per_page


def password_verify(password, hashed):
    """相容 PHP password_hash 產生的 $2y$ bcrypt 雜湊"""
    try:
        h = php_str(hashed)
        if h.startswith('$2y$'):
            h = '$2b$' + h[4:]
        return bcrypt.checkpw(php_str(password).encode('utf-8'), h.encode('utf-8'))
    except Exception:
        return False


def password_hash(password):
    """與 PHP password_hash(PASSWORD_BCRYPT) 相同格式：$2y$10$…，兩版後端可互通"""
    h = bcrypt.hashpw(php_str(password).encode('utf-8'), bcrypt.gensalt(rounds=10)).decode('ascii')
    return '$2y$' + h[4:] if h.startswith('$2b$') else h


def uniqid(prefix=''):
    """PHP uniqid()：前綴 + 8 位十六進位秒數 + 5 位十六進位微秒"""
    t = time.time()
    sec = int(t)
    usec = int((t - sec) * 1000000)
    return '%s%08x%05x' % (prefix, sec, usec)


def now_str():
    """date('Y-m-d H:i:s')"""
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


class StockError(Exception):
    """庫存不足（對應 PHP 版 throw new Exception(..., 409)）"""


# ==============================================================================
# ⚡ REST 路由指派中心
# ==============================================================================
API_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']


@app.route('/api', methods=API_METHODS, strict_slashes=False, endpoint='api_root')
@app.route('/api.php', methods=API_METHODS, strict_slashes=False, endpoint='api_root_php')
@app.route('/api.py', methods=API_METHODS, strict_slashes=False, endpoint='api_root_py')
def api_root():
    return api('')


@app.route('/api/<path:resource>', methods=API_METHODS)
@app.route('/api.php/<path:resource>', methods=API_METHODS)
@app.route('/api.py/<path:resource>', methods=API_METHODS)
def api(resource):
    # 🛡️ 安全機制：完美通關 React Native / Web AJAX 的 OPTIONS 預檢請求
    if request.method == 'OPTIONS':
        return empty_response(200)

    if CONFIG is None:
        return Response("錯誤：無法讀取設定檔 db.ini", status=200, mimetype='application/json')

    try:
        get_db()
    except Exception as e:
        return out({"error": "MariaDB 連線失敗: " + str(e)}, 500)

    resource = resource.strip('/')
    if resource == '':
        return out({"message": "歡迎使用行動電商 API，請指定資源路徑。"}, 400)

    handler = ROUTES.get(resource)
    if handler is None:
        return out({"message": "找不到此 API 資源端點"}, 404)

    method = request.method
    inp = request.get_json(silent=True, force=True)
    if not isinstance(inp, dict):
        inp = {}  # json_decode 失敗 / 非物件 → 存取任何鍵都是 null
    result = handler(method, inp)
    return result if result is not None else empty_response(200)


# ==========================================
# 1. Users (使用者表)
# ==========================================
def r_users(method, inp):
    # $_GET['action'] ?? ($input['action'] ?? '')
    action = request.args.get('action')
    if action is None:
        action = inp.get('action') if inp.get('action') is not None else ''

    if method == 'POST' and action == 'login':
        if php_empty(inp.get('email')) or php_empty(inp.get('password')):
            deny(400, "請輸入信箱與密碼")
        user = fetch("SELECT user_id, email, full_name, role, status, password_hash FROM Users WHERE email = %s",
                     (inp['email'],))

        # 🛡️ bcrypt 雜湊比對，資料庫外洩也無法還原明文密碼
        if user and password_verify(inp['password'], user['password_hash']):
            # 停用帳號連權杖都不發 —— 密碼對也進不來
            if (user.get('status') or 'active') != 'active':
                deny(403, "此帳號已被停用，請聯繫系統管理員", "ACCOUNT_SUSPENDED")
            user.pop('password_hash', None)  # 絕不把雜湊值回傳給前端
            user['user_id'] = int(user['user_id'])
            return out({
                "message":    "登入成功",
                "user_id":    user['user_id'],
                "role":       user['role'],
                # 🧭 由後端決定登入後要導向哪一頁
                "home":       home_page_for_role(user['role']),
                # 🔑 這張權杖就是之後所有請求的身分證明，前端必須存起來
                "token":      issue_token(user['user_id']),
                "expires_in": TOKEN_TTL,
                "user":       user,
            }, 200)
        deny(401, "信箱或密碼錯誤")

    elif method == 'POST' and action == 'logout':
        # 🆕 登出：把手上這張權杖寫進黑名單，之後再帶同一張就會被 require_auth 擋下
        token = read_bearer_token()
        payload = decode_token(token)
        if not payload:
            # 本來就是無效權杖，等同已登出，回 200 讓前端安心清狀態
            return out({"message": "已登出"})
        # INSERT IGNORE：重複登出不該報錯（token_hash 是主鍵）
        q("INSERT IGNORE INTO Revoked_Tokens (token_hash, user_id, expires_at) VALUES (%s, %s, FROM_UNIXTIME(%s))",
          (sha256_hex(token), php_int(payload['uid']), php_int(payload['exp'])))
        return out({"message": "已登出，此權杖已作廢"})

    elif method == 'POST':  # 會員註冊
        if not php_empty(inp.get('email')) and not php_empty(inp.get('password')) \
                and not php_empty(inp.get('full_name')):
            try:
                pwd_hash = password_hash(inp['password'])
                # 🛡️ role 一律寫死 customer —— 註冊表單送 role:'admin' 也不會生效
                cur = q("INSERT INTO Users (email, password_hash, full_name, role, created_at) "
                        "VALUES (%s, %s, %s, 'customer', NOW())",
                        (inp['email'], pwd_hash, inp['full_name']))
                return out({"message": "用戶註冊成功", "user_id": int(cur.lastrowid)}, 201)
            except pymysql.err.IntegrityError:
                # 🛡️ email 為 UNIQUE 鍵，重複註冊回 409（PHP 版的 SQLSTATE 23000）
                return out({"message": "此信箱已被註冊"}, 409)
            except pymysql.err.MySQLError:
                return out({"message": "註冊失敗，資料庫寫入異常"}, 500)
        deny(400, "欄位不齊全")

    elif method == 'GET':
        # 🛡️ 只能讀自己的資料。全體會員名單請走 staff-users（需 manager / admin）。
        me = require_auth()
        me_row = fetch("SELECT user_id, email, full_name, role, status, created_at FROM Users WHERE user_id = %s",
                       (me['user_id'],))
        me_row['home'] = home_page_for_role(me_row['role'])  # 🧭 角色不符時前端據此跳到正確的頁
        return out(me_row)
    return None


# ==========================================
# 2. Categories (商品分類表 - 前台唯讀)
# ==========================================
def r_categories(method, inp):
    if method == 'GET':  # 公開：App 的分類列、後台商品表單的分類下拉選單都用這支
        if 'page' not in request.args:
            # 不帶 page：維持舊行為回傳完整陣列（下拉選單需要全部分類）
            return out(fetch_all("SELECT category_id, category_name, description FROM Categories ORDER BY category_id"))
        # 🆕 帶 page：顧客商城的分類目錄，每頁 20 筆，附各分類商品數
        page, limit, offset = page_params(20)
        real_total = php_int(fetch_column("SELECT COUNT(*) FROM Categories"))
        # 分類被刪除時商品的 category_id 會變 NULL（ON DELETE SET NULL），
        # 這些商品收進最後一個虛擬分類「未分類」(category_id = 0)，否則顧客永遠看不到
        orphans = php_int(fetch_column("SELECT COUNT(*) FROM Products WHERE category_id IS NULL"))
        total = real_total + (1 if orphans > 0 else 0)

        rows = fetch_all("SELECT c.category_id, c.category_name, c.description, COUNT(p.product_id) AS product_count "
                         "FROM Categories c LEFT JOIN Products p ON p.category_id = c.category_id "
                         "GROUP BY c.category_id, c.category_name, c.description "
                         "ORDER BY c.category_id LIMIT %s OFFSET %s", (int(limit), int(offset)))
        for r in rows:
            r['category_id'] = php_int(r['category_id'])
            r['product_count'] = php_int(r['product_count'])
        if orphans > 0 and len(rows) < limit and offset + len(rows) == real_total:
            rows.append({'category_id': 0, 'category_name': '未分類',
                         'description': None, 'product_count': orphans})
        return out({
            'page': page,
            'per_page': limit,
            'total': total,
            'total_pages': max(1, math.ceil(total / limit)),
            'data': rows,
        })
    deny(405, "分類的新增/修改/刪除請使用 staff-categories")


# ==========================================
# 3. Products (商品主表 - 前台唯讀，已支援分頁優化)
# ==========================================
def r_products(method, inp):
    if method == 'GET':  # 公開：商品目錄本來就要能瀏覽
        pid = request.args.get('id')
        if php_truthy(pid):  # 查詢單一商品詳情
            row = fetch("SELECT * FROM Products WHERE product_id = %s", (pid,))
            return out(row if row is not None else False)
        if 'category_id' in request.args:
            # 🆕 顧客商城：某分類底下的商品，每頁 20 筆，回傳含總頁數的分頁信封
            #    category_id = 0 代表「未分類」（category_id IS NULL）
            page, limit, offset = page_params(20)
            cid = php_int(request.args.get('category_id'))
            where, params = ("p.category_id = %s", (cid,)) if cid > 0 else ("p.category_id IS NULL", ())
            total = php_int(fetch_column("SELECT COUNT(*) FROM Products p WHERE " + where, params))
            rows = fetch_all("SELECT p.*, c.category_name FROM Products p "
                             "LEFT JOIN Categories c ON p.category_id = c.category_id "
                             "WHERE " + where + " ORDER BY p.product_id DESC LIMIT %s OFFSET %s",
                             params + (int(limit), int(offset)))
            return out({
                'page': page,
                'per_page': limit,
                'total': total,
                'total_pages': max(1, math.ceil(total / limit)),
                'data': rows,
            })
        # 核心優化：每頁 20 筆輕量化分頁查詢
        page, limit, offset = page_params(20)
        rows = fetch_all("SELECT p.*, c.category_name FROM Products p "
                         "LEFT JOIN Categories c ON p.category_id = c.category_id "
                         "ORDER BY p.product_id DESC LIMIT %s OFFSET %s", (int(limit), int(offset)))
        return out(rows, 200)
    deny(405, "商品的上架/修改/下架請使用 staff-products")


# ==========================================
# 4. Cart (購物車暫存表)
# ==========================================
def r_cart(method, inp):
    # 🔑 身分只認權杖。前端就算送 ?user_id=999 也不會被採用。
    me = require_auth()
    user_id = me['user_id']

    if method == 'GET':  # 讀取自己的購物車
        return out(fetch_all("SELECT c.*, p.name, p.price, p.stock_quantity FROM Cart c "
                             "JOIN Products p ON c.product_id = p.product_id WHERE c.user_id = %s", (user_id,)))

    elif method == 'POST':  # 加入/追加購物車
        product_id = php_int(inp.get('product_id', 0))
        add_qty = php_int(inp.get('quantity', 0))
        if product_id <= 0 or add_qty < 1:
            deny(400, "需提供 product_id 與大於 0 的 quantity")

        product = fetch("SELECT name, stock_quantity FROM Products WHERE product_id = %s", (product_id,))
        if not product:
            deny(404, "找不到此商品")
        stock = php_int(product['stock_quantity'])

        exists = fetch("SELECT cart_id, quantity FROM Cart WHERE user_id = %s AND product_id = %s",
                       (user_id, product_id))
        current = php_int(exists['quantity']) if exists else 0

        # 🛡️ 庫存檢查：要比對「購物車現有數量 + 本次追加」
        if current + add_qty > stock:
            deny(409, "「%s」庫存不足，目前僅剩 %d 件" % (product['name'], stock)
                 + ("（購物車已有 %d 件）" % current if current > 0 else ""))

        if exists:
            q("UPDATE Cart SET quantity = quantity + %s, updated_at = NOW() WHERE cart_id = %s",
              (add_qty, exists['cart_id']))
        else:
            q("INSERT INTO Cart (user_id, product_id, quantity, updated_at) VALUES (%s, %s, %s, NOW())",
              (user_id, product_id, add_qty))
        return out({"message": "購物車已同步更新"})

    elif method == 'PUT':  # 直接指定數量（App 購物車明細的 − / ＋ 按鈕）
        # POST 是「累加」，PUT 是「覆寫」。明細調整必須用覆寫。
        cart_id = php_int(inp.get('cart_id', 0))
        quantity = php_int(inp.get('quantity', 0))
        if cart_id <= 0 or quantity < 1:
            deny(400, "需提供 cart_id 與大於 0 的 quantity")

        # 🛡️ 一併比對 user_id 確認這筆明細是本人的，避免改到別人的購物車。
        row = fetch("SELECT c.cart_id, p.name, p.stock_quantity "
                    "FROM Cart c JOIN Products p ON p.product_id = c.product_id "
                    "WHERE c.cart_id = %s AND c.user_id = %s", (cart_id, user_id))
        if not row:
            deny(404, "找不到該購物車明細")

        # 🛡️ PUT 是覆寫，直接拿新數量跟庫存比即可
        if quantity > php_int(row['stock_quantity']):
            deny(409, "「%s」庫存不足，目前僅剩 %s 件" % (row['name'], row['stock_quantity']))

        q("UPDATE Cart SET quantity = %s, updated_at = NOW() WHERE cart_id = %s", (quantity, cart_id))
        return out({"message": "數量已更新", "cart_id": cart_id, "quantity": quantity})

    elif method == 'DELETE':  # 移除品項
        # 優先用 cart_id；沒帶時才退回 product_id 介面。兩種都限定只能刪自己的。
        cart_id = php_int(request.args.get('cart_id', 0))
        if cart_id > 0:
            q("DELETE FROM Cart WHERE cart_id = %s AND user_id = %s", (cart_id, user_id))
        else:
            q("DELETE FROM Cart WHERE user_id = %s AND product_id = %s",
              (user_id, request.args.get('product_id', 0)))
        return out({"message": "商品已成功移出購物車"})
    return None


# ==========================================
# 5. Orders (訂單主表 - 內建多表寫入安全性事務處理)
# ==========================================
def r_orders(method, inp):
    me = require_auth()
    user_id = me['user_id']

    if method == 'POST':
        # 🛡️ 訂單內容一律以「資料庫裡的購物車」為準，前端送來的 items / price / total_amount 全部忽略。
        cart = fetch_all("SELECT c.product_id, c.quantity, p.name, p.price, p.stock_quantity "
                         "FROM Cart c JOIN Products p ON p.product_id = c.product_id "
                         "WHERE c.user_id = %s", (user_id,))
        if not cart:
            deny(400, "購物車是空的，無法結帳")

        total = 0.0
        for row in cart:
            total += php_float(row['price']) * php_int(row['quantity'])

        # 前端算出來的金額只當「確認用」：對不上代表商品在結帳前調價了，讓使用者重新確認。
        if inp.get('expected_total') is not None and abs(php_float(inp['expected_total']) - total) > 0.001:
            return out({
                "message": "商品價格已變動，最新金額為 $" + fmt_money(total) + " TWD，請重新確認",
                "total_amount": total,
            }, 409)

        begin()  # 🔒 開啟 ACID 事務處理，防止明細寫入失敗黑帳
        try:
            # 📦 訂單一成立就是「待出貨」，付款狀況記在 Payments.status。
            cur = q("INSERT INTO Orders (user_id, total_amount, status, created_at) "
                    "VALUES (%s, %s, 'awaiting_shipment', NOW())", (user_id, total))
            order_id = str(cur.lastrowid)  # PHP 的 lastInsertId() 回傳字串，保持一致

            for row in cart:
                pid = php_int(row['product_id'])
                qty = php_int(row['quantity'])
                # 🛡️ 「條件式扣減」：把庫存檢查寫進 WHERE，讓「檢查」與「扣減」變成一道不可分割的 SQL。
                c2 = q("UPDATE Products SET stock_quantity = stock_quantity - %s "
                       "WHERE product_id = %s AND stock_quantity >= %s", (qty, pid, qty))
                if c2.rowcount == 0:
                    left = fetch_column("SELECT stock_quantity FROM Products WHERE product_id = %s", (pid,))
                    raise StockError("「%s」庫存不足（僅剩 %d 件）" % (row['name'], php_int(left)))

                # 💰 價格取自 Products 當下的售價，寫進 price_at_purchase 當作歷史快照。
                q("INSERT INTO Order_Items (order_id, product_id, quantity, price_at_purchase) "
                  "VALUES (%s, %s, %s, %s)", (order_id, pid, qty, row['price']))

            # 清空該用戶購物車
            q("DELETE FROM Cart WHERE user_id = %s", (user_id,))

            commit()  # 🔓 訂單 + 明細 + 庫存 + 購物車，四張表同步落盤確認
            return out({"message": "訂單成立成功", "order_id": order_id, "total_amount": total}, 201)
        except Deny:
            rollback()
            raise
        except Exception as e:
            rollback()  # ⚠️ 異常發生，全面回滾恢復原狀（庫存也會一併還原）
            # 庫存不足是「使用者狀況」不是「伺服器故障」，用 409 而非 500。
            if isinstance(e, StockError):
                return out({"message": str(e)}, 409)
            return out({"message": "建立訂單失敗: " + str(e)}, 500)

    elif method == 'GET':
        order_id = php_int(request.args.get('order_id', 0))

        # 🆕 帶 order_id → 回傳「單一訂單的完整資訊」：主檔 + 明細 + 付款紀錄。
        if order_id > 0:
            # 🛡️ 客戶只能看自己的；後台人員因為要處理訂單，可以看任何一張
            if is_backoffice(me['role']):
                order = fetch("SELECT o.*, u.full_name, u.email FROM Orders o "
                              "JOIN Users u ON u.user_id = o.user_id WHERE o.order_id = %s", (order_id,))
            else:
                order = fetch("SELECT o.*, u.full_name, u.email FROM Orders o "
                              "JOIN Users u ON u.user_id = o.user_id "
                              "WHERE o.order_id = %s AND o.user_id = %s", (order_id, user_id))
            if not order:
                deny(404, "找不到這張訂單")

            # 明細（商品可能已被下架，product_id 會是 NULL，所以用 LEFT JOIN）
            order['items'] = fetch_all(
                "SELECT oi.*, p.name, p.image_url "
                "FROM Order_Items oi LEFT JOIN Products p ON p.product_id = oi.product_id "
                "WHERE oi.order_id = %s ORDER BY oi.item_id", (order_id,))

            # 付款紀錄：理論上一張訂單只會有一筆，取最後一筆最保險
            order['payment'] = fetch(
                "SELECT payment_id, payment_method, transaction_id, amount, status, paid_at "
                "FROM Payments WHERE order_id = %s ORDER BY payment_id DESC LIMIT 1", (order_id,))
            return out(order)

        # 不帶參數 → 自己的訂單列表。後台要看全部訂單請走 staff-orders。
        return out(fetch_all("SELECT * FROM Orders WHERE user_id = %s ORDER BY created_at DESC", (user_id,)))
    return None


# ==========================================
# 6. Order_Items (訂單明細表)
# ==========================================
def r_order_items(method, inp):
    me = require_auth()

    if method == 'GET':
        order_id = php_int(request.args.get('order_id', 0))
        if order_id <= 0:
            deny(400, "必須提供 order_id")

        # 🛡️ 客戶只能看自己的；後台人員因為要處理訂單，可以看任何一張。
        if is_backoffice(me['role']):
            found = fetch("SELECT order_id FROM Orders WHERE order_id = %s", (order_id,))
        else:
            found = fetch("SELECT order_id FROM Orders WHERE order_id = %s AND user_id = %s",
                          (order_id, me['user_id']))
        if not found:
            deny(404, "找不到這張訂單")

        return out(fetch_all("SELECT oi.*, p.name FROM Order_Items oi "
                             "LEFT JOIN Products p ON oi.product_id = p.product_id WHERE oi.order_id = %s",
                             (order_id,)))
    return None


# ==========================================
# 7. Payments (支付紀錄表)
# ==========================================
def r_payments(method, inp):
    me = require_auth()

    if method == 'POST':  # 模擬線上刷卡完成回調
        order_id = php_int(inp.get('order_id', 0))

        # 🛡️ 支付方式必須是白名單裡的值，不能讓前端自由塞字串。
        pay_method = php_str(inp['payment_method']) if inp.get('payment_method') is not None else 'App Pay'
        if pay_method not in PAYMENT_METHODS:
            deny(400, "不支援的支付方式，可用：" + ' / '.join(PAYMENT_METHODS.keys()))
        is_instant = PAYMENT_METHODS[pay_method] == 'instant'
        pay_label = PAYMENT_LABELS.get(pay_method, pay_method)

        # 🛡️ 金額不採信前端，直接讀 Orders 的 total_amount；同時確認這張訂單是本人的。
        order = fetch("SELECT total_amount, status FROM Orders WHERE order_id = %s AND user_id = %s",
                      (order_id, me['user_id']))
        if not order:
            deny(404, "找不到這張訂單")
        # 這裡只擋掉「已經走完或作廢」的訂單。
        if order['status'] in ('cancelled', 'completed'):
            deny(409, "這張訂單已取消或已完成，無法再建立付款")

        # 🛡️ 真正防重複的是這一道：一張訂單只能有一筆付款紀錄。
        existing = fetch("SELECT payment_id, status FROM Payments WHERE order_id = %s", (order_id,))
        if existing:
            deny(409, "這張訂單已經在等待付款，請勿重複送出" if existing['status'] == 'pending'
                 else "這張訂單已有付款紀錄")

        begin()  # 🔒 付款紀錄與訂單狀態必須同進同退
        try:
            # 🔀 狀態分流：即時扣款寫 success + 付款時間；延後付款寫 pending + 無付款時間
            txn = inp.get('transaction_id')
            q("INSERT INTO Payments (order_id, payment_method, transaction_id, amount, status, paid_at) "
              "VALUES (%s, %s, %s, %s, %s, %s)",
              (order_id, pay_method, txn if txn is not None else uniqid('APP-'),
               order['total_amount'],  # 💰 以訂單金額為準
               'success' if is_instant else 'pending',
               now_str() if is_instant else None))

            # 📦 付款不再改動訂單狀態 —— 收到錢與否只反映在 Payments.status。
            commit()
            if is_instant:
                msg = "%s付款成功，訂單已進入待出貨" % pay_label
            elif pay_method == 'COD':
                msg = "訂單已成立並進入待出貨，將於送達時以貨到付款收款"
            else:
                msg = "訂單已成立並進入待出貨，請完成%s；財務確認入帳後付款狀態才會轉為已收款" % pay_label
            return out({
                "message":        msg,
                "amount":         order['total_amount'],
                "payment_method": pay_method,
                "payment_status": 'success' if is_instant else 'pending',
                "order_status":   'awaiting_shipment',
            })
        except Exception as e:
            rollback()
            return out({"message": "付款寫入失敗: " + str(e)}, 500)
    return None


# ==========================================
# 8. Reviews (商品評價表)
# ==========================================
def r_reviews(method, inp):
    if method == 'GET':  # 評價是公開資訊，不需登入
        return out(fetch_all("SELECT r.*, u.full_name FROM Reviews r JOIN Users u ON r.user_id = u.user_id "
                             "WHERE r.product_id = %s ORDER BY r.created_at DESC",
                             (request.args.get('product_id'),)))

    elif method == 'POST':
        # 🔑 作者身分來自權杖，前端不能冒用別人的名義留言
        me = require_auth()
        if not php_empty(inp.get('comment')):
            # 星等夾在 1~5，避免寫進 10 顆星或負數
            rating = php_int(inp['rating']) if inp.get('rating') is not None else 5
            if rating < 1 or rating > 5:
                rating = 5
            q("INSERT INTO Reviews (product_id, user_id, rating, comment, created_at) "
              "VALUES (%s, %s, %s, %s, NOW())", (inp.get('product_id'), me['user_id'], rating, inp['comment']))
            return out({"message": "感謝您的評價！"}, 201)
        deny(400, "評論內容不可留空")
    return None


# ==========================================
# 9. Chat_Rooms (客服聊天室主表 —— customer ↔ manager)
# ==========================================
def r_chat_rooms(method, inp):
    me = require_auth()
    uid = me['user_id']

    if method == 'POST':
        # 客戶端「發起客服連線」：已經有 open 的房就沿用，沒有才開新的。
        if me['role'] != 'customer':
            deny(403, "客服聊天室由客戶端發起，後台人員請從清單認領既有房間")
        room = fetch("SELECT room_id FROM Chat_Rooms WHERE customer_id = %s AND status = 'open' "
                     "ORDER BY room_id DESC LIMIT 1", (uid,))
        if room:
            return out({"room_id": int(room['room_id']), "message": "已接回既有的客服對話"})
        cur = q("INSERT INTO Chat_Rooms (customer_id, status, created_at) VALUES (%s, 'open', NOW())", (uid,))
        return out({"room_id": int(cur.lastrowid), "message": "客服聊天室已建立"}, 201)

    elif method == 'GET':
        # 🛡️ 需求 9：只看得到自己是成員的房間
        if me['role'] == 'admin':
            where, params = "1=1", (uid,)
        elif me['role'] == 'manager':
            where, params = "(r.manager_id IS NULL OR r.manager_id = %s)", (uid, uid)
        else:
            where, params = "r.customer_id = %s", (uid, uid)

        # 未讀數只算「別人傳給我的」訊息，所以第一個參數是自己的 uid
        sql = ("SELECT r.room_id, r.customer_id, r.manager_id, r.status, r.created_at, "
               "cu.full_name AS customer_name, mg.full_name AS manager_name, "
               "(SELECT COUNT(*) FROM Messages m "
               "  WHERE m.room_id = r.room_id AND m.is_read = 0 AND m.sender_id <> %s) AS unread_count, "
               "(SELECT m2.message_text FROM Messages m2 "
               "  WHERE m2.room_id = r.room_id ORDER BY m2.message_id DESC LIMIT 1) AS last_message, "
               "(SELECT m3.created_at FROM Messages m3 "
               "  WHERE m3.room_id = r.room_id ORDER BY m3.message_id DESC LIMIT 1) AS last_at "
               "FROM Chat_Rooms r "
               "JOIN Users cu ON cu.user_id = r.customer_id "
               "LEFT JOIN Users mg ON mg.user_id = r.manager_id "
               "WHERE " + where + " "
               "ORDER BY (last_at IS NULL), last_at DESC, r.room_id DESC")
        return out(fetch_all(sql, params))

    elif method == 'PUT':
        # manager 主動認領 / 結案
        if me['role'] not in ('manager', 'admin'):
            deny(403, "認領與結案限「manager / admin」使用")
        room_id = php_int(inp.get('room_id', 0))
        room = assert_room_member(room_id, me)

        if (inp.get('action') or '') == 'close':
            q("UPDATE Chat_Rooms SET status = 'closed' WHERE room_id = %s", (room_id,))
            return out({"message": "聊天室已結案"})
        if room['manager_id'] is None:
            q("UPDATE Chat_Rooms SET manager_id = %s WHERE room_id = %s AND manager_id IS NULL",
              (me['user_id'], room_id))
        return out({"message": "已認領此聊天室", "room_id": room_id})
    return None


# ==========================================
# 10. Messages (訊息明細表 - AJAX 定時輪詢與即時通訊核心)
# ==========================================
def r_messages(method, inp):
    # 🔑 聊天內容不是公開資料，讀寫都要求登入 + 成員驗證
    me = require_auth()

    if method == 'GET':  # ⚡ 搭配索引 idx_messages_room 高速掃描
        room_id = php_int(request.args.get('room_id', 0))
        if room_id <= 0:
            deny(400, "必須提供 room_id")
        assert_room_member(room_id, me)  # 🛡️ 不是成員就 403

        # 讀取即已讀：把「別人傳給我的、還沒讀的」標記成已讀
        q("UPDATE Messages SET is_read = 1 WHERE room_id = %s AND sender_id <> %s AND is_read = 0",
          (room_id, me['user_id']))

        return out(fetch_all("SELECT m.*, u.full_name AS sender_name, u.role AS sender_role "
                             "FROM Messages m JOIN Users u ON m.sender_id = u.user_id "
                             "WHERE m.room_id = %s ORDER BY m.created_at ASC, m.message_id ASC", (room_id,)))

    elif method == 'POST':
        # 🔑 寄件者身分來自權杖，前端無法冒名發言
        room_id = php_int(inp.get('room_id', 0))
        text = php_str(inp.get('message_text')).strip()
        if room_id <= 0 or text == '':
            deny(400, "需提供 room_id 與 message_text")

        room = assert_room_member(room_id, me)  # 🛡️ 不是成員就 403

        begin()
        try:
            # 後台人員回覆時，若這間房還沒人認領就順手認領 ——「誰先回覆誰負責」。
            if me['role'] == 'manager' and room['manager_id'] is None:
                q("UPDATE Chat_Rooms SET manager_id = %s WHERE room_id = %s AND manager_id IS NULL",
                  (me['user_id'], room_id))
            q("INSERT INTO Messages (room_id, sender_id, message_text, is_read, created_at) "
              "VALUES (%s, %s, %s, 0, NOW())", (room_id, me['user_id'], text))
            commit()
            return out({"message": "訊息傳送成功"}, 201)
        except Exception as e:
            rollback()
            return out({"message": "訊息寫入失敗: " + str(e)}, 500)
    return None


# ==========================================
# 11. staff-categories (後台：分類管理)
# ==========================================
def r_staff_categories(method, inp):
    require_staff()

    if method == 'GET':
        # 附上「這個分類底下有幾件商品」，刪除前才知道會影響多少商品
        return out(fetch_all(
            "SELECT c.category_id, c.category_name, c.description, "
            "(SELECT COUNT(*) FROM Products p WHERE p.category_id = c.category_id) AS product_count "
            "FROM Categories c ORDER BY c.category_id"))

    elif method == 'POST':
        name = php_str(inp.get('category_name')).strip()
        if name == '':
            deny(400, "缺少 category_name")
        desc = inp.get('description')
        cur = q("INSERT INTO Categories (category_name, description) VALUES (%s, %s)",
                (name, desc if desc is not None else ''))
        return out({"message": "分類建立成功", "category_id": int(cur.lastrowid)}, 201)

    elif method == 'PUT':
        cid = php_int(inp.get('category_id', 0))
        name = php_str(inp.get('category_name')).strip()
        if cid <= 0 or name == '':
            deny(400, "需提供 category_id 與 category_name")
        desc = inp.get('description')
        q("UPDATE Categories SET category_name = %s, description = %s WHERE category_id = %s",
          (name, desc if desc is not None else '', cid))
        return out({"message": "分類已更新"})

    elif method == 'DELETE':
        cid = php_int(request.args.get('category_id', 0))
        if cid <= 0:
            deny(400, "需提供 category_id")
        # Products.category_id 的外鍵是 ON DELETE SET NULL，底下的商品只會變成「未分類」。
        q("DELETE FROM Categories WHERE category_id = %s", (cid,))
        return out({"message": "分類已刪除，原本歸屬的商品已改為未分類"})
    return None


# ==========================================
# 12. staff-products (後台：商品管理)
# ==========================================
def _product_fields(inp):
    cat = inp.get('category_id')
    img = inp.get('image_url')
    desc = inp.get('description')
    return (
        # 分類允許留空（未分類），外鍵是 ON DELETE SET NULL，NULL 是合法值
        cat if php_truthy(cat) else None,
        desc if desc is not None else '',
        php_float(inp.get('price')),
        php_int(inp.get('stock_quantity')),
        img if img is not None else 'https://via.placeholder.com/150',
    )


def r_staff_products(method, inp):
    require_staff()

    if method == 'GET':
        page, limit, offset = page_params(20)
        total = php_int(fetch_column("SELECT COUNT(*) FROM Products"))
        rows = fetch_all("SELECT p.*, c.category_name "
                         "FROM Products p LEFT JOIN Categories c ON c.category_id = p.category_id "
                         "ORDER BY p.product_id DESC LIMIT %s OFFSET %s", (int(limit), int(offset)))
        return out({
            "page": page, "per_page": limit, "total": total,
            "total_pages": max(1, int(math.ceil(total / limit))),
            "data": rows,
        })

    elif method == 'POST':
        name = php_str(inp.get('name')).strip()
        if name == '' or inp.get('price') is None or inp.get('stock_quantity') is None:
            deny(400, "上架失敗，商品名稱 / 價格 / 庫存量為必填")
        cat, desc, price, stock, img = _product_fields(inp)
        cur = q("INSERT INTO Products (category_id, name, description, price, stock_quantity, image_url) "
                "VALUES (%s, %s, %s, %s, %s, %s)", (cat, name, desc, price, stock, img))
        return out({"message": "商品上架成功！", "product_id": int(cur.lastrowid)}, 201)

    elif method == 'PUT':
        pid = php_int(inp.get('product_id', 0))
        name = php_str(inp.get('name')).strip()
        if pid <= 0 or name == '' or inp.get('price') is None or inp.get('stock_quantity') is None:
            deny(400, "需提供 product_id、name、price、stock_quantity")
        cat, desc, price, stock, img = _product_fields(inp)
        q("UPDATE Products SET category_id = %s, name = %s, description = %s, price = %s, "
          "stock_quantity = %s, image_url = %s WHERE product_id = %s",
          (cat, name, desc, price, stock, img, pid))
        return out({"message": "商品已更新"})

    elif method == 'DELETE':
        pid = php_int(request.args.get('product_id', 0))
        if pid <= 0:
            deny(400, "需提供 product_id")
        # Order_Items 的外鍵是 SET NULL，歷史訂單明細不會消失（但商品名稱會查不到）
        q("DELETE FROM Products WHERE product_id = %s", (pid,))
        return out({"message": "商品已下架刪除"})
    return None


# ==========================================
# 13. staff-orders (後台：訂單與支付流水)
# ==========================================
def r_staff_orders(method, inp):
    # 三個營運角色也要看得到訂單清單；能改什麼由下面的轉換規則各自限制
    me = require_backoffice()

    if method == 'GET':
        # 📄 每 20 筆一頁，依「成立時間」最早的排最前面（先進先出）
        page, limit, offset = page_params(20)

        # 🔍 scope：各營運角色的工作佇列，只撈自己要處理的那一批
        scope = request.args.get('scope', 'all')
        where = {
            'finance':   "pay.status = 'pending'",            # 財務：還沒收到錢的訂單
            'warehouse': "o.status = 'awaiting_shipment'",    # 倉管：等著出貨的訂單
            'logistics': "o.status = 'shipped'",              # 物流：已出貨、等著回報送達的訂單
        }.get(scope, "1=1")

        join_pay = ("LEFT JOIN (SELECT order_id, MAX(payment_id) AS payment_id FROM Payments GROUP BY order_id) lp "
                    "ON lp.order_id = o.order_id "
                    "LEFT JOIN Payments pay ON pay.payment_id = lp.payment_id ")

        # 計數要套用同一組條件，否則分頁的總頁數會對不上
        total = php_int(fetch_column("SELECT COUNT(*) FROM Orders o " + join_pay + "WHERE " + where))

        # 先用子查詢挑出「最後一筆付款」再 JOIN，避免一張訂單被複製成兩列
        rows = fetch_all(
            "SELECT o.order_id, o.user_id, o.total_amount, o.status, o.created_at, "
            "u.full_name, u.email, "
            "pay.payment_id, pay.payment_method, pay.transaction_id, "
            "pay.amount AS paid_amount, pay.status AS pay_status, pay.paid_at "
            "FROM Orders o JOIN Users u ON u.user_id = o.user_id " + join_pay +
            "WHERE " + where + " "
            "ORDER BY o.created_at ASC, o.order_id ASC LIMIT %s OFFSET %s", (int(limit), int(offset)))

        return out({
            "page": page, "per_page": limit, "total": total,
            "total_pages": max(1, int(math.ceil(total / limit))),
            "scope": scope,
            "data": rows,
        })

    elif method == 'PUT':
        # 更新訂單履約狀態。誰能做哪一步由 order_transition_rules() 決定。
        order_id = php_int(inp.get('order_id', 0))
        status = php_str(inp.get('status'))
        rules = order_transition_rules(me['role'])

        if order_id <= 0 or status not in ORDER_STATUSES:
            deny(400, "需提供 order_id 與合法的 status（" + ' / '.join(ORDER_STATUSES) + "）")
        if status not in rules:
            deny(403, "你的角色不能把訂單改為「%s」" % status)

        current = fetch_column("SELECT status FROM Orders WHERE order_id = %s", (order_id,))
        if current is False:
            deny(404, "找不到這張訂單")
        if current == status:
            return out({"message": "狀態未變更", "status": status})
        if current == 'cancelled':
            deny(409, "已取消的訂單不能再改狀態")

        # 🛡️ 也要檢查「從什麼狀態來」—— 否則物流可以跳過倉管那一關。
        if current not in rules[status]:
            deny(409, "訂單目前是「%s」，不能直接改為「%s」" % (current, status))

        begin()
        try:
            if status == 'cancelled':
                # 🔁 取消訂單要把當初扣掉的庫存還回去，否則商品會憑空消失
                for it in fetch_all("SELECT product_id, quantity FROM Order_Items "
                                    "WHERE order_id = %s AND product_id IS NOT NULL", (order_id,)):
                    q("UPDATE Products SET stock_quantity = stock_quantity + %s WHERE product_id = %s",
                      (php_int(it['quantity']), php_int(it['product_id'])))
                # 還沒入帳就取消 → 那筆付款不會發生了，一併作廢
                q("UPDATE Payments SET status = 'cancelled' WHERE order_id = %s AND status = 'pending'",
                  (order_id,))

            q("UPDATE Orders SET status = %s WHERE order_id = %s", (status, order_id))
            commit()
            msg = {
                'shipped':           "訂單已出貨，交由物流配送",
                'completed':         "訂單已送達客戶，流程完成",
                'cancelled':         "訂單已取消，庫存已還原",
                'awaiting_shipment': "訂單已退回待出貨",
            }
            return out({"message": msg.get(status, "訂單狀態已更新"), "order_id": order_id, "status": status})
        except Exception as e:
            rollback()
            return out({"message": "更新失敗: " + str(e)}, 500)
    return None


# ==========================================
# 13-1. staff-payments (後台：訂單帳款管理 —— 財務專用)
# ------------------------------------------
# 收款是「把付款紀錄從 pending 改成 success」，與訂單履約狀態是兩回事，權限也不同。
# ==========================================
def r_staff_payments(method, inp):
    require_role(['finance', 'manager', 'admin'])

    if method == 'PUT':
        order_id = php_int(inp.get('order_id', 0))
        status = php_str(inp['status']) if inp.get('status') is not None else 'success'
        if order_id <= 0 or status not in ('success', 'cancelled'):
            deny(400, "需提供 order_id 與合法的 status（success / cancelled）")

        pay = fetch("SELECT p.payment_id, p.status, p.payment_method, p.amount, o.status AS order_status "
                    "FROM Payments p JOIN Orders o ON o.order_id = p.order_id WHERE p.order_id = %s",
                    (order_id,))
        if not pay:
            deny(404, "這張訂單沒有付款紀錄")

        if pay['status'] == status:
            return out({"message": "付款狀態未變更", "status": status})
        # 只允許從「待收款」往前走，避免把已收的款退回成待收（那是退款流程，不在此範圍）
        if pay['status'] != 'pending':
            deny(409, "這筆付款已是「%s」，不能再變更" % pay['status'])

        paid_at = now_str() if status == 'success' else None
        q("UPDATE Payments SET status = %s, paid_at = %s WHERE order_id = %s AND status = 'pending'",
          (status, paid_at, order_id))

        return out({
            "message": ("已確認收款（" + PAYMENT_LABELS.get(pay['payment_method'], pay['payment_method']) + "）")
            if status == 'success' else "已將此筆款項標記為取消",
            "order_id": order_id,
            "payment_status": status,
        })
    return None


# ==========================================
# 14. staff-users (後台：會員帳戶清單)
# ==========================================
def r_staff_users(method, inp):
    me = require_staff()

    if method == 'GET':
        page, limit, offset = page_params(20)
        total = php_int(fetch_column("SELECT COUNT(*) FROM Users"))
        # 絕不 SELECT *：password_hash 不該離開資料庫
        rows = fetch_all(
            "SELECT u.user_id, u.email, u.full_name, u.role, u.status, u.created_at, "
            "(SELECT COUNT(*) FROM Orders o WHERE o.user_id = u.user_id) AS order_count, "
            "(SELECT COALESCE(SUM(o2.total_amount), 0) FROM Orders o2 "
            "  WHERE o2.user_id = u.user_id AND o2.status <> 'cancelled') AS total_spent "
            "FROM Users u ORDER BY u.user_id ASC LIMIT %s OFFSET %s", (int(limit), int(offset)))
        return out({
            "page": page, "per_page": limit, "total": total,
            "total_pages": max(1, int(math.ceil(total / limit))),
            "data": rows,
        })

    elif method == 'PUT':
        # 🛡️ 變更角色與停用/重啟帳號都只有 admin 能做
        if me['role'] != 'admin':
            deny(403, "變更會員角色或啟用狀態限「admin」使用")

        target = php_int(inp.get('user_id', 0))
        if target <= 0:
            deny(400, "需提供 user_id")
        if target == me['user_id']:
            deny(409, "不能變更自己的角色或啟用狀態，避免把自己鎖在門外")

        victim = fetch("SELECT user_id, full_name, role, status FROM Users WHERE user_id = %s", (target,))
        if not victim:
            deny(404, "找不到這位會員")

        has_role = 'role' in inp
        has_status = 'status' in inp
        if not has_role and not has_status:
            deny(400, "需提供 role 或 status 其中之一")

        new_role = php_str(inp['role']) if has_role else victim['role']
        new_status = php_str(inp['status']) if has_status else victim['status']

        if new_role not in ALL_ROLES:
            deny(400, "role 需為 " + ' / '.join(ALL_ROLES))
        if new_status not in ('active', 'suspended'):
            deny(400, "status 需為 active（啟用）或 suspended（停用）")

        # 🛡️ 最後一位可用 admin 的保險絲（防禦性，正常情況碰不到）
        loses_admin = victim['role'] == 'admin' and (new_role != 'admin' or new_status != 'active')
        if loses_admin:
            others = php_int(fetch_column(
                "SELECT COUNT(*) FROM Users WHERE role = 'admin' AND status = 'active' AND user_id <> %s",
                (target,)))
            if others == 0:
                deny(409, "這是系統唯一一位啟用中的管理員，不能停用或降級 —— 否則沒有人能再進入後台")

        q("UPDATE Users SET role = %s, status = %s WHERE user_id = %s", (new_role, new_status, target))

        # 停用時順便清掉對方已過期的黑名單紀錄（require_auth 每次都現查 status，停用本來就立即生效）
        if new_status == 'suspended':
            q("DELETE FROM Revoked_Tokens WHERE user_id = %s AND expires_at < NOW()", (target,))

        if not has_status:
            verb = "角色已更新"
        else:
            verb = "帳號已停用" if new_status == 'suspended' else "帳號已重啟"
        return out({
            "message": "「%s」%s" % (victim['full_name'], verb),
            "user_id": target,
            "role": new_role,
            "status": new_status,
        })
    return None


ROUTES = {
    'users':            r_users,
    'categories':       r_categories,
    'products':         r_products,
    'cart':             r_cart,
    'orders':           r_orders,
    'order-items':      r_order_items,
    'payments':         r_payments,
    'reviews':          r_reviews,
    'chat-rooms':       r_chat_rooms,
    'messages':         r_messages,
    'staff-categories': r_staff_categories,
    'staff-products':   r_staff_products,
    'staff-orders':     r_staff_orders,
    'staff-payments':   r_staff_payments,
    'staff-users':      r_staff_users,
}


# ==============================================================================
# 🌐 前端網頁（與 API 同源）
# ------------------------------------------------------------------------------
# PHP 版是 Apache 同時放網頁與 api.php；Python 版由本程式一併提供。
# 只開放網頁會用到的副檔名 —— db.ini、*.py 等絕不能被下載。
# ==============================================================================
# 副檔名 → MIME 明確指定：Windows 的 mimetypes 會讀登錄檔，.js 常被判成 text/plain
STATIC_EXT = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
}


@app.route('/')
def static_index():
    return send_from_directory(HERE, 'index.html', mimetype='text/html')


@app.route('/<path:filename>')
def static_files(filename):
    ext = os.path.splitext(filename)[1].lower()
    if ext not in STATIC_EXT or not os.path.isfile(os.path.join(HERE, filename)):
        return Response('Not Found', status=404, mimetype='text/plain')
    return send_from_directory(HERE, filename, mimetype=STATIC_EXT[ext])


if __name__ == '__main__':
    host = os.environ.get('API_HOST', '0.0.0.0')
    port = int(os.environ.get('API_PORT', '5000'))
    print('MobileShop API (Python 3) → http://%s:%d/api   資料庫 %s@%s:%s/%s'
          % (host, port, DB_USER, DB_HOST, DB_PORT, DB_NAME))
    app.run(host=host, port=port, debug=False, threaded=True)
