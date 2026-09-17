<?php
// ==============================================================================
// 行動資料庫應用期末專案 - 11 大資料表通用生產級 RESTful API 核心
// ------------------------------------------------------------------------------
// 角色分工：
//   customer 一般消費者 —— 逛商品、購物車、下單、看自己的訂單、找客服
//   manager  營運人員   —— 管理商品/分類、處理客戶訂單、回覆客服聊天室
//   admin    系統管理員 —— manager 的全部權限，另可檢視所有聊天室
//
// 端點命名規則：
//   plain（/products、/categories…） = 前台，多為公開或客戶自用
//   staff-*（/staff-orders…）        = 後台，一律限 manager / admin
// ==============================================================================
header("Content-Type: application/json; charset=UTF-8");
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization, X-Auth-Token, X-Requested-With");

// 🛡️ 安全機制：完美通關 React Native / Web AJAX 的 OPTIONS 預檢請求
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// 🩺 全域例外攔截：沒有這一層的話，任何未攔截的資料庫錯誤都會讓 PHP 吐出 HTML 錯誤頁，
//    前端拿到的就是「伺服器回傳非 JSON 內容」—— 看不出真正的原因。
//    最常見的情況是「程式更新了但資料庫沒跑 migration」，這裡直接把話講白。
set_exception_handler(function ($e) {
    if (!headers_sent()) http_response_code(500);
    $msg = $e->getMessage();
    $schemaIssue = (stripos($msg, 'Unknown column') !== false)
        || (stripos($msg, "doesn't exist") !== false)
        || (stripos($msg, 'Unknown table') !== false);
    echo json_encode([
        "message" => $schemaIssue
            ? "資料庫結構與程式版本不符，請執行 MariaDB-migration.sql\n\n({$msg})"
            : "伺服器內部錯誤：{$msg}"
    ], JSON_UNESCAPED_UNICODE);
});

$config = parse_ini_file('db.ini');
if (!$config) {
    die("錯誤：無法讀取設定檔 db.ini");
}

// ⚠️ db.ini 的鍵名兩種寫法都吃：
//    db_name / dbname、username / user。
//    原本只讀 db_name 與 username，但範例 db.ini 寫的是 dbname 與 user ——
//    等於設定檔改了卻不會生效，一路吃預設值，錯得無聲無息。
$host     = $config['host'] ?? '127.0.0.1';
$db_name  = $config['db_name']  ?? $config['dbname'] ?? 'shop_db';
$username = $config['username'] ?? $config['user']   ?? 'root';
$password = $config['password'] ?? $config['pass']   ?? '';
$port     = $config['port'] ?? 3306;

try {
    $pdo = new PDO("mysql:host=$host;dbname=$db_name;charset=utf8mb4;port=$port", $username, $password);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, false); // 關閉模擬預備陳述式，啟用資料庫真預編譯
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(["error" => "MariaDB 連線失敗: " . $e->getMessage()]);
    exit();
}

// ==============================================================================
// 🔑 登入權杖（HMAC 簽章 + Revoked_Tokens 黑名單）
// ------------------------------------------------------------------------------
// 身分不再由前端送 user_id 自報，改成登入時發一張帶簽章的權杖。
// 之後所有需要身分的請求一律從權杖解出 user_id，前端送的一概忽略。
//
// 簽章是無狀態的：簽出去就收不回來，登出後那張在有效期內仍然驗得過。
// 所以搭配 Revoked_Tokens 黑名單 —— 登出時把權杖雜湊寫進去，驗完簽再查一次。
// ==============================================================================
const TOKEN_TTL = 604800; // 權杖有效期 7 天

// ⚠️ 正式環境請在 db.ini 加一行：token_secret = "一串夠長的隨機字元"
//    沒設定時退而由資料庫帳密推導 —— 重點是「同一台機器每次算出同一組密鑰」，
//    否則簽章驗不過。但這代表密鑰強度等同資料庫密碼，正式上線務必自己設。
$TOKEN_SECRET = $config['token_secret'] ?? hash('sha256', "$db_name|$username|$password");

function b64u_encode($raw) { return rtrim(strtr(base64_encode($raw), '+/', '-_'), '='); }
function b64u_decode($str) { return base64_decode(strtr($str, '-_', '+/')); }

/** 產生權杖：base64url(payload) . '.' . base64url(HMAC-SHA256 簽章) */
function issue_token($user_id, $secret) {
    $payload = json_encode(['uid' => (int)$user_id, 'exp' => time() + TOKEN_TTL]);
    $body = b64u_encode($payload);
    return $body . '.' . b64u_encode(hash_hmac('sha256', $body, $secret, true));
}

/** 驗簽 + 驗過期，通過回傳 payload 陣列（含 uid / exp），失敗回傳 null */
function decode_token($token, $secret) {
    $parts = explode('.', (string)$token);
    if (count($parts) !== 2) return null;

    $expected = b64u_encode(hash_hmac('sha256', $parts[0], $secret, true));
    // 🛡️ 用 hash_equals 而不是 ===：定時比對，不會因為「第幾個字元開始不同」
    //    造成回應時間差異，被拿去一個字元一個字元地猜出簽章。
    if (!hash_equals($expected, $parts[1])) return null;

    $payload = json_decode(b64u_decode($parts[0]), true);
    if (!is_array($payload) || empty($payload['uid'])) return null;
    if ((int)($payload['exp'] ?? 0) < time()) return null; // 已過期

    return $payload;
}

/** 從 Authorization: Bearer 取權杖；Apache 有時會吃掉該標頭，故備援 X-Auth-Token */
function read_bearer_token() {
    $lookup = [];
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) { $lookup[strtolower($k)] = $v; }
    }
    $auth = $lookup['authorization']
        ?? $_SERVER['HTTP_AUTHORIZATION']
        ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
        ?? '';
    if (preg_match('/^Bearer\s+(.+)$/i', trim($auth), $m)) return trim($m[1]);

    return trim($lookup['x-auth-token'] ?? $_SERVER['HTTP_X_AUTH_TOKEN'] ?? '');
}

/**
 * 中止並回傳錯誤。
 * $code 是機器可讀的錯誤代碼（選填）—— 前端要判斷「是不是帳號被停用」時，
 * 比對 code 比比對中文訊息可靠得多（訊息改字前端就壞了）。
 */
function deny($status, $message, $code = null) {
    http_response_code($status);
    $out = ["message" => $message];
    if ($code !== null) $out["code"] = $code;
    echo json_encode($out, JSON_UNESCAPED_UNICODE);
    exit();
}

/**
 * 需要登入的端點呼叫此函式。
 * 回傳 ['user_id' => int, 'full_name' => string, 'role' => string]。
 *
 * 角色刻意「每次從資料庫讀」而不是寫進權杖裡：
 * 這樣停權或降級才會立即生效，不必等使用者手上那張權杖過期。
 */
function require_auth($pdo, $secret) {
    $token = read_bearer_token();
    $payload = decode_token($token, $secret);
    if (!$payload) deny(401, "登入已過期或未登入，請重新登入");

    // 🚫 黑名單比對：登出過的權杖即使簽章正確、還沒過期，也一律拒絕
    $stmt = $pdo->prepare("SELECT 1 FROM Revoked_Tokens WHERE token_hash = ?");
    $stmt->execute([hash('sha256', $token)]);
    if ($stmt->fetch()) deny(401, "此登入階段已登出，請重新登入");

    $stmt = $pdo->prepare("SELECT user_id, full_name, email, role, status FROM Users WHERE user_id = ?");
    $stmt->execute([(int)$payload['uid']]);
    $user = $stmt->fetch();
    if (!$user) deny(401, "帳號不存在或已被移除");

    // 🚫 停用檢查放在這裡（而不是只在登入時檢查）：
    //    角色與狀態都是每次請求現查資料庫，所以 admin 一按「停用」，
    //    對方即使手上握著還沒過期的權杖，下一個動作就會被擋下 —— 不必等他登出。
    if (($user['status'] ?? 'active') !== 'active') {
        deny(403, "此帳號已被停用，請聯繫系統管理員", "ACCOUNT_SUSPENDED");
    }

    $user['user_id'] = (int)$user['user_id'];
    return $user;
}

/** 限定角色，不符合回 403（已登入但權限不足，與 401 未登入要分開） */
function require_role($pdo, $secret, array $roles) {
    $user = require_auth($pdo, $secret);
    if (!in_array($user['role'], $roles, true)) {
        deny(403, "權限不足，此功能限「" . implode(' / ', $roles) . "」使用");
    }
    return $user;
}

/** 商品／分類／會員／客服等「總管」功能：只有 manager 與 admin */
function require_staff($pdo, $secret) {
    return require_role($pdo, $secret, ['manager', 'admin']);
}

/**
 * 訂單相關的後台功能：加上三個營運角色。
 * 他們能「看」訂單清單，但能「改」什麼由 order_transition_rules() 各自限制。
 */
function require_backoffice($pdo, $secret) {
    return require_role($pdo, $secret, BACKOFFICE_ROLES);
}

/**
 * 🛡️ 聊天室成員驗證（需求 9）
 * ------------------------------------------------------------------
 * customer：只有房主本人
 * manager ：未認領的房（manager_id IS NULL）可接手；已認領的只有認領者本人
 * admin   ：可檢視全部（系統管理員需要稽核能力）
 */
function assert_room_member($pdo, $room_id, $me) {
    $stmt = $pdo->prepare("SELECT room_id, customer_id, manager_id, status FROM Chat_Rooms WHERE room_id = ?");
    $stmt->execute([(int)$room_id]);
    $room = $stmt->fetch();
    if (!$room) deny(404, "找不到這間聊天室");

    $uid = (int)$me['user_id'];
    if ($me['role'] === 'admin') return $room;
    if ((int)$room['customer_id'] === $uid) return $room;
    if ($me['role'] === 'manager' && ($room['manager_id'] === null || (int)$room['manager_id'] === $uid)) {
        return $room;
    }

    deny(403, "你不是這間聊天室的成員");
}

/**
 * 允許的支付方式 → 結算型態。
 *
 * 前端可以選，但不能自由填 —— 沒有白名單的話，
 * Payments.payment_method 會被塞進任意字串，日後做報表就無法分類統計。
 * 鍵是穩定的英文代碼，畫面上的中文標籤由 PAYMENT_LABELS 對照。
 *
 *   instant  = 結帳當下就收到錢 → 付款紀錄 'success'、訂單直接轉 'paid'
 *   deferred = 之後才會收到錢   → 付款紀錄 'pending'、訂單留在 'pending'，
 *                                 等後台確認收款才轉 'paid'
 */
const PAYMENT_METHODS = [
    'Credit Card'  => 'instant',   // 信用卡：線上授權即扣款
    'Mobile Pay'   => 'instant',   // 行動支付：同上
    'App Pay'      => 'instant',   // App 內建支付（手機 App 使用）
    'ATM Transfer' => 'deferred',  // ATM 轉帳：要等對方真的匯款進來
    'COD'          => 'deferred',  // 貨到付款：送達收現才算收到錢
];

const PAYMENT_LABELS = [
    'Credit Card'  => '信用卡',
    'Mobile Pay'   => '行動支付',
    'App Pay'      => 'App 支付',
    'ATM Transfer' => 'ATM 轉帳',
    'COD'          => '貨到付款',
];

/**
 * 依角色決定登入後該進哪一個頁面。
 *
 * 路由表刻意放在後端：login.html 只負責「照後端說的跳轉」，
 * 日後新增角色或改檔名，只要動這一個函式，不必去改每一支網頁。
 */
function home_page_for_role($role) {
    switch ($role) {
        case 'admin':     return 'admin.html';     // 系統管理員後台
        case 'manager':   return 'manager.html';   // 營運人員後台
        case 'finance':   return 'finance.html';   // 訂單帳款管理
        case 'warehouse': return 'warehouse.html'; // 倉庫管理
        case 'logistics': return 'logistics.html'; // 物流管理
        default:          return 'index.html';     // customer 一般消費者前台
    }
}

/**
 * 訂單履約狀態流程。
 *
 * ⚠️ 這裡只表示「貨到哪了」，不表示付款 —— 付款狀態獨立在 Payments.status。
 *    訂單一成立就是 awaiting_shipment，不管錢收到了沒有。
 *    （pending / paid 是舊制留下的值，僅存在於歷史資料。）
 */
const ORDER_STATUSES = ['awaiting_shipment', 'shipped', 'completed', 'cancelled'];

/** 系統中所有可指派的角色（admin 在會員清單調整角色時使用） */
const ALL_ROLES = ['customer', 'manager', 'finance', 'warehouse', 'logistics', 'admin'];

/**
 * 後台角色：這些人因為要處理訂單，可以檢視「任何一張」訂單與其明細。
 * customer 只看得到自己的。
 *
 * ⚠️ 曾經因為在各處各寫一次 ['manager','admin'] 而漏掉三個營運角色，
 *    導致財務／倉管／物流點「明細」一律 404。清單集中在此，只此一份。
 */
const BACKOFFICE_ROLES = ['manager', 'admin', 'finance', 'warehouse', 'logistics'];

function is_backoffice($role) {
    return in_array($role, BACKOFFICE_ROLES, true);
}

/**
 * 哪個角色可以把訂單改成什麼狀態，以及「原本必須是什麼狀態」。
 * 這是整條營運流程的權限中樞 —— 倉管不能替物流按完成，物流也不能自己出貨。
 */
function order_transition_rules($role) {
    switch ($role) {
        case 'warehouse':
            // 倉管只做一件事：把待出貨的訂單交給物流
            return ['shipped' => ['awaiting_shipment']];
        case 'logistics':
            // 物流只做一件事：回報客戶已收到貨
            return ['completed' => ['shipped']];
        case 'manager':
        case 'admin':
            // 後台總管可以走任何一步，也可以取消訂單
            return [
                'awaiting_shipment' => ['shipped'],            // 退回重出貨
                'shipped'           => ['awaiting_shipment'],
                'completed'         => ['shipped'],
                'cancelled'         => ['awaiting_shipment', 'shipped'],
            ];
        default:
            return []; // finance 只管帳款，不碰履約狀態
    }
}

/** 金額格式化：整數就不補小數，避免訊息出現 "3580.00" */
function fmt_money($amount) {
    $amount = (float)$amount;
    return (floor($amount) == $amount) ? (string)(int)$amount : number_format($amount, 2, '.', '');
}

/** 分頁參數：固定每頁 20 筆 */
function page_params($per_page = 20) {
    $page = max(1, (int)($_GET['page'] ?? 1));
    return [$page, $per_page, ($page - 1) * $per_page];
}

$method = $_SERVER['REQUEST_METHOD'];
$input = json_decode(file_get_contents('php://input'), true);

// 🛡️ 路由校對：精確過濾問號後的 Query String（如 ?page=2），提取乾淨的資源名詞
$request_uri = $_SERVER['REQUEST_URI'];
$script_name = $_SERVER['SCRIPT_NAME'];
$resource_path = str_replace($script_name, '', strtok($request_uri, '?'));
$resource = trim($resource_path, '/');

if (empty($resource)) {
    http_response_code(400);
    echo json_encode(["message" => "歡迎使用行動電商 API，請指定資源路徑。"]);
    exit();
}

// ⚡ REST 路由指派中心
switch ($resource) {

    // ==========================================
    // 1. Users (使用者表)
    // ==========================================
    case 'users':
        $action = $_GET['action'] ?? ($input['action'] ?? '');

        if ($method === 'POST' && $action === 'login') {
            if (empty($input['email']) || empty($input['password'])) {
                deny(400, "請輸入信箱與密碼");
            }
            $stmt = $pdo->prepare("SELECT user_id, email, full_name, role, status, password_hash FROM Users WHERE email = ?");
            $stmt->execute([$input['email']]);
            $user = $stmt->fetch();

            // 🛡️ bcrypt 雜湊比對，資料庫外洩也無法還原明文密碼
            if ($user && password_verify($input['password'], $user['password_hash'])) {
                // 停用帳號連權杖都不發 —— 密碼對也進不來
                if (($user['status'] ?? 'active') !== 'active') {
                    deny(403, "此帳號已被停用，請聯繫系統管理員", "ACCOUNT_SUSPENDED");
                }
                unset($user['password_hash']); // 絕不把雜湊值回傳給前端
                $user['user_id'] = (int)$user['user_id'];
                http_response_code(200);
                echo json_encode([
                    "message"    => "登入成功",
                    "user_id"    => $user['user_id'],
                    "role"       => $user['role'],
                    // 🧭 由後端決定登入後要導向哪一頁（customer/manager/admin 各有各的入口）
                    "home"       => home_page_for_role($user['role']),
                    // 🔑 這張權杖就是之後所有請求的身分證明，前端必須存起來
                    "token"      => issue_token($user['user_id'], $TOKEN_SECRET),
                    "expires_in" => TOKEN_TTL,
                    "user"       => $user
                ]);
            } else {
                deny(401, "信箱或密碼錯誤");
            }

        } elseif ($method === 'POST' && $action === 'logout') {
            // 🆕 登出：把手上這張權杖寫進黑名單，之後再帶同一張就會被 require_auth 擋下
            $token = read_bearer_token();
            $payload = decode_token($token, $TOKEN_SECRET);
            if (!$payload) {
                // 本來就是無效權杖，等同已登出，回 200 讓前端安心清狀態
                echo json_encode(["message" => "已登出"]);
                break;
            }
            // INSERT IGNORE：重複登出不該報錯（token_hash 是主鍵）
            $stmt = $pdo->prepare(
                "INSERT IGNORE INTO Revoked_Tokens (token_hash, user_id, expires_at) VALUES (?, ?, FROM_UNIXTIME(?))"
            );
            $stmt->execute([hash('sha256', $token), (int)$payload['uid'], (int)$payload['exp']]);
            echo json_encode(["message" => "已登出，此權杖已作廢"]);

        } elseif ($method === 'POST') { // 會員註冊
            if (!empty($input['email']) && !empty($input['password']) && !empty($input['full_name'])) {
                try {
                    $pwd_hash = password_hash($input['password'], PASSWORD_BCRYPT);
                    // 🛡️ role 一律寫死 customer —— 註冊表單送 role:'admin' 也不會生效
                    $stmt = $pdo->prepare("INSERT INTO Users (email, password_hash, full_name, role, created_at) VALUES (?, ?, ?, 'customer', NOW())");
                    $stmt->execute([$input['email'], $pwd_hash, $input['full_name']]);
                    http_response_code(201);
                    echo json_encode(["message" => "用戶註冊成功", "user_id" => (int)$pdo->lastInsertId()]);
                } catch (PDOException $e) {
                    // 🛡️ email 為 UNIQUE 鍵，重複註冊會丟出 23000，
                    //    未攔截的話 PHP 會吐出 HTML 錯誤頁，手機端解析 JSON 直接崩潰
                    http_response_code($e->getCode() === '23000' ? 409 : 500);
                    echo json_encode([
                        "message" => $e->getCode() === '23000' ? "此信箱已被註冊" : "註冊失敗，資料庫寫入異常"
                    ]);
                }
            } else {
                deny(400, "欄位不齊全");
            }

        } elseif ($method === 'GET') {
            // 🛡️ 只能讀自己的資料。全體會員名單請走 staff-users（需 manager / admin）。
            //    各頁面開啟時會打這支確認「我是誰、我該待在哪一頁」。
            $me = require_auth($pdo, $TOKEN_SECRET);
            $stmt = $pdo->prepare("SELECT user_id, email, full_name, role, status, created_at FROM Users WHERE user_id = ?");
            $stmt->execute([$me['user_id']]);
            $self = $stmt->fetch();
            $self['home'] = home_page_for_role($self['role']); // 🧭 角色不符時前端據此跳到正確的頁
            echo json_encode($self);
        }
        break;

    // ==========================================
    // 2. Categories (商品分類表 - 前台唯讀)
    // ==========================================
    case 'categories':
        if ($method === 'GET') { // 公開：App 的分類列、後台商品表單的分類下拉選單都用這支
            $stmt = $pdo->query("SELECT category_id, category_name, description FROM Categories ORDER BY category_id");
            echo json_encode($stmt->fetchAll());
        } else {
            deny(405, "分類的新增/修改/刪除請使用 staff-categories");
        }
        break;

    // ==========================================
    // 3. Products (商品主表 - 前台唯讀，已支援分頁優化)
    // ==========================================
    case 'products':
        if ($method === 'GET') { // 公開：商品目錄本來就要能瀏覽
            $id = $_GET['id'] ?? null;
            if ($id) { // 查詢單一商品詳情
                $stmt = $pdo->prepare("SELECT * FROM Products WHERE product_id = ?");
                $stmt->execute([$id]);
                echo json_encode($stmt->fetch());
            } else { // 核心優化：每頁 20 筆輕量化分頁查詢
                list($page, $limit, $offset) = page_params(20);

                // 🛡️ 安全關鍵：LIMIT 後方必須為純整數，使用 bindValue 強型態綁定
                $sql = "SELECT p.*, c.category_name FROM Products p LEFT JOIN Categories c ON p.category_id = c.category_id ORDER BY p.product_id DESC LIMIT :limit OFFSET :offset";
                $stmt = $pdo->prepare($sql);
                $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
                $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
                $stmt->execute();

                http_response_code(200);
                echo json_encode($stmt->fetchAll());
            }
        } else {
            deny(405, "商品的上架/修改/下架請使用 staff-products");
        }
        break;

    // ==========================================
    // 4. Cart (購物車暫存表)
    // ==========================================
    case 'cart':
        // 🔑 身分只認權杖。前端就算送 ?user_id=999 也不會被採用。
        $me = require_auth($pdo, $TOKEN_SECRET);
        $user_id = $me['user_id'];

        if ($method === 'GET') { // 讀取自己的購物車
            $stmt = $pdo->prepare("SELECT c.*, p.name, p.price, p.stock_quantity FROM Cart c JOIN Products p ON c.product_id = p.product_id WHERE c.user_id = ?");
            $stmt->execute([$user_id]);
            echo json_encode($stmt->fetchAll());

        } elseif ($method === 'POST') { // 加入/追加購物車
            $product_id = (int)($input['product_id'] ?? 0);
            $add_qty    = (int)($input['quantity'] ?? 0);
            if ($product_id <= 0 || $add_qty < 1) {
                deny(400, "需提供 product_id 與大於 0 的 quantity");
            }

            $stmt = $pdo->prepare("SELECT name, stock_quantity FROM Products WHERE product_id = ?");
            $stmt->execute([$product_id]);
            $product = $stmt->fetch();
            if (!$product) deny(404, "找不到此商品");
            $stock = (int)$product['stock_quantity'];

            $stmt = $pdo->prepare("SELECT cart_id, quantity FROM Cart WHERE user_id = ? AND product_id = ?");
            $stmt->execute([$user_id, $product_id]);
            $exists  = $stmt->fetch();
            $current = $exists ? (int)$exists['quantity'] : 0;

            // 🛡️ 庫存檢查：要比對「購物車現有數量 + 本次追加」，只看本次的話
            //    按 10 次「加入購物車」就能把庫存 3 件的商品堆到 10 件。
            if ($current + $add_qty > $stock) {
                deny(409, "「{$product['name']}」庫存不足，目前僅剩 {$stock} 件"
                    . ($current > 0 ? "（購物車已有 {$current} 件）" : ""));
            }

            if ($exists) {
                $stmt = $pdo->prepare("UPDATE Cart SET quantity = quantity + ?, updated_at = NOW() WHERE cart_id = ?");
                $stmt->execute([$add_qty, $exists['cart_id']]);
            } else {
                $stmt = $pdo->prepare("INSERT INTO Cart (user_id, product_id, quantity, updated_at) VALUES (?, ?, ?, NOW())");
                $stmt->execute([$user_id, $product_id, $add_qty]);
            }
            echo json_encode(["message" => "購物車已同步更新"]);

        } elseif ($method === 'PUT') { // 直接指定數量（App 購物車明細的 − / ＋ 按鈕）
            // 注意與上面 POST 的差別：POST 是「累加」(quantity + ?)，PUT 是「覆寫」(quantity = ?)。
            // 明細調整必須用覆寫，否則按 5 次 ＋ 會變成 1+2+3+4+5。
            $cart_id  = (int)($input['cart_id'] ?? 0);
            $quantity = (int)($input['quantity'] ?? 0);
            if ($cart_id <= 0 || $quantity < 1) {
                deny(400, "需提供 cart_id 與大於 0 的 quantity");
            }

            // 🛡️ 一併比對 user_id 確認這筆明細是本人的，避免改到別人的購物車。
            //    不用 UPDATE 的 rowCount 判斷成敗：數量與原值相同時 MySQL 也回 0，會誤判成「找不到」。
            //    順便 JOIN 出庫存，省一次查詢。
            $stmt = $pdo->prepare(
                "SELECT c.cart_id, p.name, p.stock_quantity
                   FROM Cart c JOIN Products p ON p.product_id = c.product_id
                  WHERE c.cart_id = ? AND c.user_id = ?"
            );
            $stmt->execute([$cart_id, $user_id]);
            $row = $stmt->fetch();
            if (!$row) deny(404, "找不到該購物車明細");

            // 🛡️ PUT 是覆寫，直接拿新數量跟庫存比即可（不必加上原有數量）
            if ($quantity > (int)$row['stock_quantity']) {
                deny(409, "「{$row['name']}」庫存不足，目前僅剩 {$row['stock_quantity']} 件");
            }

            $stmt = $pdo->prepare("UPDATE Cart SET quantity = ?, updated_at = NOW() WHERE cart_id = ?");
            $stmt->execute([$quantity, $cart_id]);
            echo json_encode([
                "message"  => "數量已更新",
                "cart_id"  => $cart_id,
                "quantity" => $quantity
            ]);

        } elseif ($method === 'DELETE') { // 移除品項
            // 優先用 cart_id（購物車明細的真正主鍵）；沒帶時才退回 product_id 介面。
            // 兩種都一併比對 user_id 限定只能刪自己的。
            $cart_id = (int)($_GET['cart_id'] ?? 0);
            if ($cart_id > 0) {
                $stmt = $pdo->prepare("DELETE FROM Cart WHERE cart_id = ? AND user_id = ?");
                $stmt->execute([$cart_id, $user_id]);
            } else {
                $stmt = $pdo->prepare("DELETE FROM Cart WHERE user_id = ? AND product_id = ?");
                $stmt->execute([$user_id, $_GET['product_id'] ?? 0]);
            }
            echo json_encode(["message" => "商品已成功移出購物車"]);
        }
        break;

    // ==========================================
    // 5. Orders (訂單主表 - 內建多表寫入安全性事務處理)
    // ==========================================
    case 'orders':
        $me = require_auth($pdo, $TOKEN_SECRET);
        $user_id = $me['user_id'];

        if ($method === 'POST') {
            // 🛡️ 訂單內容一律以「資料庫裡的購物車」為準，
            //    前端送來的 items / price / total_amount 全部忽略。
            //    否則把 price 改成 1 送出去，就能用 $1 買走商品。
            $stmt = $pdo->prepare(
                "SELECT c.product_id, c.quantity, p.name, p.price, p.stock_quantity
                   FROM Cart c JOIN Products p ON p.product_id = c.product_id
                  WHERE c.user_id = ?"
            );
            $stmt->execute([$user_id]);
            $cart = $stmt->fetchAll();

            if (!$cart) deny(400, "購物車是空的，無法結帳");

            $total = 0.0;
            foreach ($cart as $row) {
                $total += (float)$row['price'] * (int)$row['quantity'];
            }

            // 前端算出來的金額只當「確認用」，不當依據：
            // 對不上代表商品在結帳前調價了，讓使用者重新確認，
            // 而不是默默用新價格扣款。
            if (isset($input['expected_total']) && abs((float)$input['expected_total'] - $total) > 0.001) {
                http_response_code(409);
                echo json_encode([
                    "message"      => "商品價格已變動，最新金額為 $" . fmt_money($total) . " TWD，請重新確認",
                    "total_amount" => $total
                ]);
                break;
            }

            $pdo->beginTransaction(); // 🔒 開啟 ACID 事務處理，防止明細寫入失敗黑帳
            try {
                // 📦 訂單一成立就是「待出貨」，不管付款收到了沒有。
                //    訂單狀態只表示履約進度，付款狀況記在 Payments.status。
                $stmt = $pdo->prepare("INSERT INTO Orders (user_id, total_amount, status, created_at) VALUES (?, ?, 'awaiting_shipment', NOW())");
                $stmt->execute([$user_id, $total]);
                $order_id = $pdo->lastInsertId();

                // 6. Order_Items (訂單明細表寫入) + 同步扣減庫存
                $stmtItem  = $pdo->prepare("INSERT INTO Order_Items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)");
                // 🛡️ 「條件式扣減」：把庫存檢查寫進 WHERE，讓「檢查」與「扣減」變成一道
                //    不可分割的 SQL。若先 SELECT 再 UPDATE，兩位使用者同時搶最後一件時
                //    會雙雙通過檢查，造成超賣。
                $stmtStock = $pdo->prepare(
                    "UPDATE Products SET stock_quantity = stock_quantity - ?
                      WHERE product_id = ? AND stock_quantity >= ?"
                );
                $stmtLatest = $pdo->prepare("SELECT stock_quantity FROM Products WHERE product_id = ?");

                foreach ($cart as $row) {
                    $pid = (int)$row['product_id'];
                    $qty = (int)$row['quantity'];

                    $stmtStock->execute([$qty, $pid, $qty]);
                    // 這裡用 rowCount 是正確的：扣減必然改變數值，回 0 就代表 WHERE 沒過（庫存不足）
                    if ($stmtStock->rowCount() === 0) {
                        $stmtLatest->execute([$pid]);
                        $left = $stmtLatest->fetchColumn();
                        throw new Exception("「{$row['name']}」庫存不足（僅剩 " . (int)$left . " 件）", 409);
                    }

                    // 💰 價格取自 Products 當下的售價，不是前端送來的數字。
                    //    寫進 price_at_purchase 當作歷史快照，日後商品調價不影響這張訂單。
                    $stmtItem->execute([$order_id, $pid, $qty, $row['price']]);
                }

                // 清空該用戶購物車
                $stmtClearCart = $pdo->prepare("DELETE FROM Cart WHERE user_id = ?");
                $stmtClearCart->execute([$user_id]);

                $pdo->commit(); // 🔓 訂單 + 明細 + 庫存 + 購物車，四張表同步落盤確認
                http_response_code(201);
                echo json_encode([
                    "message"      => "訂單成立成功",
                    "order_id"     => $order_id,
                    "total_amount" => $total
                ]);
            } catch (Exception $e) {
                $pdo->rollBack(); // ⚠️ 異常發生，時空全面回滾恢復原狀（庫存也會一併還原）
                // 庫存不足是「使用者狀況」不是「伺服器故障」，用 409 而非 500。
                $isStock = ((int)$e->getCode() === 409);
                http_response_code($isStock ? 409 : 500);
                echo json_encode([
                    "message" => $isStock ? $e->getMessage() : "建立訂單失敗: " . $e->getMessage()
                ]);
            }

        } elseif ($method === 'GET') {
            $order_id = (int)($_GET['order_id'] ?? 0);

            // 🆕 帶 order_id → 回傳「單一訂單的完整資訊」：主檔 + 明細 + 付款紀錄。
            //    包成一次請求，前端點開訂單不必連打三支 API。
            if ($order_id > 0) {
                // 🛡️ 客戶只能看自己的；後台人員因為要處理訂單，可以看任何一張
                if (is_backoffice($me['role'])) {
                    $stmt = $pdo->prepare(
                        "SELECT o.*, u.full_name, u.email FROM Orders o
                           JOIN Users u ON u.user_id = o.user_id WHERE o.order_id = ?"
                    );
                    $stmt->execute([$order_id]);
                } else {
                    $stmt = $pdo->prepare(
                        "SELECT o.*, u.full_name, u.email FROM Orders o
                           JOIN Users u ON u.user_id = o.user_id
                          WHERE o.order_id = ? AND o.user_id = ?"
                    );
                    $stmt->execute([$order_id, $user_id]);
                }
                $order = $stmt->fetch();
                if (!$order) deny(404, "找不到這張訂單");

                // 明細（商品可能已被下架，product_id 會是 NULL，所以用 LEFT JOIN）
                $stmt = $pdo->prepare(
                    "SELECT oi.*, p.name, p.image_url
                       FROM Order_Items oi LEFT JOIN Products p ON p.product_id = oi.product_id
                      WHERE oi.order_id = ? ORDER BY oi.item_id"
                );
                $stmt->execute([$order_id]);
                $order['items'] = $stmt->fetchAll();

                // 付款紀錄：理論上一張訂單只會有一筆，取最後一筆最保險
                $stmt = $pdo->prepare(
                    "SELECT payment_id, payment_method, transaction_id, amount, status, paid_at
                       FROM Payments WHERE order_id = ? ORDER BY payment_id DESC LIMIT 1"
                );
                $stmt->execute([$order_id]);
                $pay = $stmt->fetch();
                $order['payment'] = $pay ?: null;

                echo json_encode($order);
                break;
            }

            // 不帶參數 → 自己的訂單列表。身分來自權杖，只可能查到自己的。
            // 後台要看全部訂單請走 staff-orders。
            $stmt = $pdo->prepare("SELECT * FROM Orders WHERE user_id = ? ORDER BY created_at DESC");
            $stmt->execute([$user_id]);
            echo json_encode($stmt->fetchAll());
        }
        break;

    // ==========================================
    // 6. Order_Items (訂單明細表)
    // ==========================================
    case 'order-items':
        $me = require_auth($pdo, $TOKEN_SECRET);

        if ($method === 'GET') {
            $order_id = (int)($_GET['order_id'] ?? 0);
            if ($order_id <= 0) deny(400, "必須提供 order_id");

            // 🛡️ 只憑 order_id 就給明細的話，把網址的號碼改一下就能看到別人買了什麼。
            //    客戶只能看自己的；後台人員因為要處理訂單，可以看任何一張。
            if (is_backoffice($me['role'])) {
                $stmt = $pdo->prepare("SELECT order_id FROM Orders WHERE order_id = ?");
                $stmt->execute([$order_id]);
            } else {
                $stmt = $pdo->prepare("SELECT order_id FROM Orders WHERE order_id = ? AND user_id = ?");
                $stmt->execute([$order_id, $me['user_id']]);
            }
            if (!$stmt->fetch()) deny(404, "找不到這張訂單");

            $stmt = $pdo->prepare("SELECT oi.*, p.name FROM Order_Items oi LEFT JOIN Products p ON oi.product_id = p.product_id WHERE oi.order_id = ?");
            $stmt->execute([$order_id]);
            echo json_encode($stmt->fetchAll());
        }
        break;

    // ==========================================
    // 7. Payments (支付紀錄表)
    // ==========================================
    case 'payments':
        $me = require_auth($pdo, $TOKEN_SECRET);

        if ($method === 'POST') { // 模擬線上刷卡完成回調
            $order_id = (int)($input['order_id'] ?? 0);

            // 🛡️ 支付方式必須是白名單裡的值，不能讓前端自由塞字串。
            //    先驗輸入再查資料庫 —— 格式不對的請求不必浪費一次查詢。
            $payMethod = (string)($input['payment_method'] ?? 'App Pay');
            if (!array_key_exists($payMethod, PAYMENT_METHODS)) {
                deny(400, "不支援的支付方式，可用：" . implode(' / ', array_keys(PAYMENT_METHODS)));
            }
            $isInstant = (PAYMENT_METHODS[$payMethod] === 'instant');
            $payLabel  = PAYMENT_LABELS[$payMethod] ?? $payMethod;

            // 🛡️ 金額不採信前端，直接讀 Orders 的 total_amount；
            //    同時確認這張訂單是本人的、而且還沒付過款（防重複扣款）。
            $stmt = $pdo->prepare("SELECT total_amount, status FROM Orders WHERE order_id = ? AND user_id = ?");
            $stmt->execute([$order_id, $me['user_id']]);
            $order = $stmt->fetch();

            if (!$order) deny(404, "找不到這張訂單");
            // 訂單狀態現在只表示履約進度，不能拿來判斷「付過款沒有」。
            // 這裡只擋掉「已經走完或作廢」的訂單。
            if (in_array($order['status'], ['cancelled', 'completed'], true)) {
                deny(409, "這張訂單已取消或已完成，無法再建立付款");
            }

            // 🛡️ 真正防重複的是這一道：一張訂單只能有一筆付款紀錄。
            //    （延後付款的訂單狀態不會變化，光看訂單狀態擋不住重複送出。）
            $stmt = $pdo->prepare("SELECT payment_id, status FROM Payments WHERE order_id = ?");
            $stmt->execute([$order_id]);
            $existing = $stmt->fetch();
            if ($existing) {
                deny(409, $existing['status'] === 'pending'
                    ? "這張訂單已經在等待付款，請勿重複送出"
                    : "這張訂單已有付款紀錄");
            }

            $pdo->beginTransaction(); // 🔒 付款紀錄與訂單狀態必須同進同退
            try {
                // 🔀 狀態分流：即時扣款寫 success + 付款時間；延後付款寫 pending + 無付款時間
                $stmt = $pdo->prepare(
                    "INSERT INTO Payments (order_id, payment_method, transaction_id, amount, status, paid_at)
                     VALUES (?, ?, ?, ?, ?, ?)"
                );
                $stmt->execute([
                    $order_id,
                    $payMethod,
                    $input['transaction_id'] ?? uniqid('APP-'),
                    $order['total_amount'],       // 💰 以訂單金額為準
                    $isInstant ? 'success' : 'pending',
                    $isInstant ? date('Y-m-d H:i:s') : null
                ]);

                // 📦 付款不再改動訂單狀態 —— 訂單一律停在「待出貨」等倉管處理。
                //    收到錢與否只反映在 Payments.status，兩條流程互不干涉。

                $pdo->commit();
                echo json_encode([
                    "message" => $isInstant
                        ? "{$payLabel}付款成功，訂單已進入待出貨"
                        : ($payMethod === 'COD'
                            ? "訂單已成立並進入待出貨，將於送達時以貨到付款收款"
                            : "訂單已成立並進入待出貨，請完成{$payLabel}；財務確認入帳後付款狀態才會轉為已收款"),
                    "amount"         => $order['total_amount'],
                    "payment_method" => $payMethod,
                    "payment_status" => $isInstant ? 'success' : 'pending',
                    "order_status"   => 'awaiting_shipment'
                ]);
            } catch (Exception $e) {
                $pdo->rollBack();
                http_response_code(500);
                echo json_encode(["message" => "付款寫入失敗: " . $e->getMessage()]);
            }
        }
        break;

    // ==========================================
    // 8. Reviews (商品評價表)
    // ==========================================
    case 'reviews':
        if ($method === 'GET') { // 評價是公開資訊，不需登入
            $product_id = $_GET['product_id'] ?? null;
            $stmt = $pdo->prepare("SELECT r.*, u.full_name FROM Reviews r JOIN Users u ON r.user_id = u.user_id WHERE r.product_id = ? ORDER BY r.created_at DESC");
            $stmt->execute([$product_id]);
            echo json_encode($stmt->fetchAll());

        } elseif ($method === 'POST') {
            // 🔑 作者身分來自權杖，前端不能冒用別人的名義留言
            $me = require_auth($pdo, $TOKEN_SECRET);
            if (!empty($input['comment'])) {
                // 星等夾在 1~5，避免寫進 10 顆星或負數
                $rating = (int)($input['rating'] ?? 5);
                if ($rating < 1 || $rating > 5) { $rating = 5; }

                $stmt = $pdo->prepare("INSERT INTO Reviews (product_id, user_id, rating, comment, created_at) VALUES (?, ?, ?, ?, NOW())");
                $stmt->execute([$input['product_id'], $me['user_id'], $rating, $input['comment']]);
                http_response_code(201);
                echo json_encode(["message" => "感謝您的評價！"]);
            } else {
                deny(400, "評論內容不可留空");
            }
        }
        break;

    // ==========================================
    // 9. Chat_Rooms (客服聊天室主表 —— customer ↔ manager)
    // ==========================================
    case 'chat-rooms':
        $me = require_auth($pdo, $TOKEN_SECRET);
        $uid = $me['user_id'];

        if ($method === 'POST') {
            // 客戶端「發起客服連線」：已經有 open 的房就沿用，沒有才開新的。
            // 這樣同一位客戶不會每次進客服頁就多開一間房。
            if ($me['role'] !== 'customer') {
                deny(403, "客服聊天室由客戶端發起，後台人員請從清單認領既有房間");
            }
            $stmt = $pdo->prepare("SELECT room_id FROM Chat_Rooms WHERE customer_id = ? AND status = 'open' ORDER BY room_id DESC LIMIT 1");
            $stmt->execute([$uid]);
            $room = $stmt->fetch();

            if ($room) {
                echo json_encode(["room_id" => (int)$room['room_id'], "message" => "已接回既有的客服對話"]);
            } else {
                $stmt = $pdo->prepare("INSERT INTO Chat_Rooms (customer_id, status, created_at) VALUES (?, 'open', NOW())");
                $stmt->execute([$uid]);
                http_response_code(201);
                echo json_encode(["room_id" => (int)$pdo->lastInsertId(), "message" => "客服聊天室已建立"]);
            }

        } elseif ($method === 'GET') {
            // 🛡️ 需求 9：只看得到自己是成員的房間
            //    customer → 自己的房
            //    manager  → 未認領的房 + 自己認領的房
            //    admin    → 全部（稽核用）
            if ($me['role'] === 'admin') {
                $where = "1=1";
                $params = [$uid];
            } elseif ($me['role'] === 'manager') {
                $where = "(r.manager_id IS NULL OR r.manager_id = ?)";
                $params = [$uid, $uid];
            } else {
                $where = "r.customer_id = ?";
                $params = [$uid, $uid];
            }

            // 未讀數只算「別人傳給我的」訊息，所以第一個 ? 是自己的 uid
            $sql = "SELECT r.room_id, r.customer_id, r.manager_id, r.status, r.created_at,
                           cu.full_name AS customer_name,
                           mg.full_name AS manager_name,
                           (SELECT COUNT(*) FROM Messages m
                             WHERE m.room_id = r.room_id AND m.is_read = 0 AND m.sender_id <> ?) AS unread_count,
                           (SELECT m2.message_text FROM Messages m2
                             WHERE m2.room_id = r.room_id ORDER BY m2.message_id DESC LIMIT 1) AS last_message,
                           (SELECT m3.created_at FROM Messages m3
                             WHERE m3.room_id = r.room_id ORDER BY m3.message_id DESC LIMIT 1) AS last_at
                      FROM Chat_Rooms r
                      JOIN Users cu ON cu.user_id = r.customer_id
                 LEFT JOIN Users mg ON mg.user_id = r.manager_id
                     WHERE $where
                  ORDER BY (last_at IS NULL), last_at DESC, r.room_id DESC";

            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            echo json_encode($stmt->fetchAll());

        } elseif ($method === 'PUT') {
            // manager 主動認領 / 結案（$me 上面已驗過，這裡只補角色檢查，不重跑一次驗證）
            if (!in_array($me['role'], ['manager', 'admin'], true)) {
                deny(403, "認領與結案限「manager / admin」使用");
            }
            $room_id = (int)($input['room_id'] ?? 0);
            $room = assert_room_member($pdo, $room_id, $me);

            if (($input['action'] ?? '') === 'close') {
                $stmt = $pdo->prepare("UPDATE Chat_Rooms SET status = 'closed' WHERE room_id = ?");
                $stmt->execute([$room_id]);
                echo json_encode(["message" => "聊天室已結案"]);
            } else {
                if ($room['manager_id'] === null) {
                    $stmt = $pdo->prepare("UPDATE Chat_Rooms SET manager_id = ? WHERE room_id = ? AND manager_id IS NULL");
                    $stmt->execute([$me['user_id'], $room_id]);
                }
                echo json_encode(["message" => "已認領此聊天室", "room_id" => $room_id]);
            }
        }
        break;

    // ==========================================
    // 10. Messages (訊息明細表 - AJAX 定時輪詢與即時通訊核心)
    // ==========================================
    case 'messages':
        // 🔑 聊天內容不是公開資料，讀寫都要求登入 + 成員驗證
        $me = require_auth($pdo, $TOKEN_SECRET);

        if ($method === 'GET') { // ⚡ 搭配索引 idx_messages_room 高速掃描
            $room_id = (int)($_GET['room_id'] ?? 0);
            if ($room_id <= 0) deny(400, "必須提供 room_id");
            assert_room_member($pdo, $room_id, $me); // 🛡️ 不是成員就 403

            // 讀取即已讀：把「別人傳給我的、還沒讀的」標記成已讀，
            // 聊天室清單的未讀數才有意義。多數輪詢會是 0 rows，成本很低。
            $stmt = $pdo->prepare("UPDATE Messages SET is_read = 1 WHERE room_id = ? AND sender_id <> ? AND is_read = 0");
            $stmt->execute([$room_id, $me['user_id']]);

            $stmt = $pdo->prepare(
                "SELECT m.*, u.full_name AS sender_name, u.role AS sender_role
                   FROM Messages m JOIN Users u ON m.sender_id = u.user_id
                  WHERE m.room_id = ? ORDER BY m.created_at ASC, m.message_id ASC"
            );
            $stmt->execute([$room_id]);
            echo json_encode($stmt->fetchAll());

        } elseif ($method === 'POST') {
            // 🔑 寄件者身分來自權杖，前端無法冒名發言
            $room_id = (int)($input['room_id'] ?? 0);
            $text = trim((string)($input['message_text'] ?? ''));
            if ($room_id <= 0 || $text === '') deny(400, "需提供 room_id 與 message_text");

            $room = assert_room_member($pdo, $room_id, $me); // 🛡️ 不是成員就 403

            $pdo->beginTransaction();
            try {
                // 後台人員回覆時，若這間房還沒人認領就順手認領 ——
                // 「誰先回覆誰負責」，不必再多一個認領按鈕。
                if ($me['role'] === 'manager' && $room['manager_id'] === null) {
                    $stmt = $pdo->prepare("UPDATE Chat_Rooms SET manager_id = ? WHERE room_id = ? AND manager_id IS NULL");
                    $stmt->execute([$me['user_id'], $room_id]);
                }

                $stmt = $pdo->prepare("INSERT INTO Messages (room_id, sender_id, message_text, is_read, created_at) VALUES (?, ?, ?, 0, NOW())");
                $stmt->execute([$room_id, $me['user_id'], $text]);

                $pdo->commit();
                http_response_code(201);
                echo json_encode(["message" => "訊息傳送成功"]);
            } catch (Exception $e) {
                $pdo->rollBack();
                http_response_code(500);
                echo json_encode(["message" => "訊息寫入失敗: " . $e->getMessage()]);
            }
        }
        break;

    // ==========================================
    // 11. staff-categories (後台：分類管理)
    // ==========================================
    case 'staff-categories':
        require_staff($pdo, $TOKEN_SECRET);

        if ($method === 'GET') {
            // 附上「這個分類底下有幾件商品」，刪除前才知道會影響多少商品
            $stmt = $pdo->query(
                "SELECT c.category_id, c.category_name, c.description,
                        (SELECT COUNT(*) FROM Products p WHERE p.category_id = c.category_id) AS product_count
                   FROM Categories c ORDER BY c.category_id"
            );
            echo json_encode($stmt->fetchAll());

        } elseif ($method === 'POST') {
            $name = trim((string)($input['category_name'] ?? ''));
            if ($name === '') deny(400, "缺少 category_name");
            $stmt = $pdo->prepare("INSERT INTO Categories (category_name, description) VALUES (?, ?)");
            $stmt->execute([$name, $input['description'] ?? '']);
            http_response_code(201);
            echo json_encode(["message" => "分類建立成功", "category_id" => (int)$pdo->lastInsertId()]);

        } elseif ($method === 'PUT') {
            $id = (int)($input['category_id'] ?? 0);
            $name = trim((string)($input['category_name'] ?? ''));
            if ($id <= 0 || $name === '') deny(400, "需提供 category_id 與 category_name");
            $stmt = $pdo->prepare("UPDATE Categories SET category_name = ?, description = ? WHERE category_id = ?");
            $stmt->execute([$name, $input['description'] ?? '', $id]);
            echo json_encode(["message" => "分類已更新"]);

        } elseif ($method === 'DELETE') {
            $id = (int)($_GET['category_id'] ?? 0);
            if ($id <= 0) deny(400, "需提供 category_id");
            // Products.category_id 的外鍵是 ON DELETE SET NULL，
            // 所以底下的商品不會消失，只會變成「未分類」。
            $stmt = $pdo->prepare("DELETE FROM Categories WHERE category_id = ?");
            $stmt->execute([$id]);
            echo json_encode(["message" => "分類已刪除，原本歸屬的商品已改為未分類"]);
        }
        break;

    // ==========================================
    // 12. staff-products (後台：商品管理)
    // ==========================================
    case 'staff-products':
        require_staff($pdo, $TOKEN_SECRET);

        if ($method === 'GET') {
            list($page, $limit, $offset) = page_params(20);
            $total = (int)$pdo->query("SELECT COUNT(*) FROM Products")->fetchColumn();

            $stmt = $pdo->prepare(
                "SELECT p.*, c.category_name
                   FROM Products p LEFT JOIN Categories c ON c.category_id = p.category_id
               ORDER BY p.product_id DESC
                  LIMIT :limit OFFSET :offset"
            );
            $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
            $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
            $stmt->execute();

            echo json_encode([
                "page"        => $page,
                "per_page"    => $limit,
                "total"       => $total,
                "total_pages" => max(1, (int)ceil($total / $limit)),
                "data"        => $stmt->fetchAll()
            ]);

        } elseif ($method === 'POST') {
            $name = trim((string)($input['name'] ?? ''));
            if ($name === '' || !isset($input['price']) || !isset($input['stock_quantity'])) {
                deny(400, "上架失敗，商品名稱 / 價格 / 庫存量為必填");
            }
            $stmt = $pdo->prepare("INSERT INTO Products (category_id, name, description, price, stock_quantity, image_url) VALUES (?, ?, ?, ?, ?, ?)");
            $stmt->execute([
                // 分類允許留空（未分類），外鍵是 ON DELETE SET NULL，NULL 是合法值
                ($input['category_id'] ?? null) ?: null,
                $name,
                $input['description'] ?? '',
                (float)$input['price'],
                (int)$input['stock_quantity'],
                $input['image_url'] ?? 'https://via.placeholder.com/150'
            ]);
            http_response_code(201);
            echo json_encode(["message" => "商品上架成功！", "product_id" => (int)$pdo->lastInsertId()]);

        } elseif ($method === 'PUT') {
            $id = (int)($input['product_id'] ?? 0);
            $name = trim((string)($input['name'] ?? ''));
            if ($id <= 0 || $name === '' || !isset($input['price']) || !isset($input['stock_quantity'])) {
                deny(400, "需提供 product_id、name、price、stock_quantity");
            }
            $stmt = $pdo->prepare(
                "UPDATE Products SET category_id = ?, name = ?, description = ?, price = ?, stock_quantity = ?, image_url = ?
                  WHERE product_id = ?"
            );
            $stmt->execute([
                ($input['category_id'] ?? null) ?: null,
                $name,
                $input['description'] ?? '',
                (float)$input['price'],
                (int)$input['stock_quantity'],
                $input['image_url'] ?? 'https://via.placeholder.com/150',
                $id
            ]);
            echo json_encode(["message" => "商品已更新"]);

        } elseif ($method === 'DELETE') {
            $id = (int)($_GET['product_id'] ?? 0);
            if ($id <= 0) deny(400, "需提供 product_id");
            // Order_Items 的外鍵是 SET NULL，歷史訂單明細不會消失（但商品名稱會查不到）
            $stmt = $pdo->prepare("DELETE FROM Products WHERE product_id = ?");
            $stmt->execute([$id]);
            echo json_encode(["message" => "商品已下架刪除"]);
        }
        break;

    // ==========================================
    // 13. staff-orders (後台：訂單與支付流水)
    // ==========================================
    case 'staff-orders':
        // 三個營運角色也要看得到訂單清單；能改什麼由下面的轉換規則各自限制
        $me = require_backoffice($pdo, $TOKEN_SECRET);

        if ($method === 'GET') {
            // 📄 每 20 筆一頁，依「成立時間」最早的排最前面（先進先出）
            list($page, $limit, $offset) = page_params(20);

            // 🔍 scope：各營運角色的工作佇列，只撈自己要處理的那一批
            $scope = $_GET['scope'] ?? 'all';
            $params = [];
            switch ($scope) {
                case 'finance':   // 財務：還沒收到錢的訂單
                    $where = "pay.status = 'pending'";
                    break;
                case 'warehouse': // 倉管：等著出貨的訂單
                    $where = "o.status = 'awaiting_shipment'";
                    break;
                case 'logistics': // 物流：已出貨、等著回報送達的訂單
                    $where = "o.status = 'shipped'";
                    break;
                default:
                    $where = "1=1";
            }

            // 計數要套用同一組條件，否則分頁的總頁數會對不上
            $countSql = "SELECT COUNT(*) FROM Orders o
                    LEFT JOIN (SELECT order_id, MAX(payment_id) AS payment_id FROM Payments GROUP BY order_id) lp
                           ON lp.order_id = o.order_id
                    LEFT JOIN Payments pay ON pay.payment_id = lp.payment_id
                        WHERE $where";
            $stmt = $pdo->prepare($countSql);
            $stmt->execute($params);
            $total = (int)$stmt->fetchColumn();

            // ⚠️ 一張訂單理論上只會有一筆付款（payments 有 pending 檢查），
            //    但若資料庫裡真有兩筆，直接 LEFT JOIN Payments 會讓該訂單複製成兩列，
            //    分頁的 20 筆就對不上了。先用子查詢挑出「最後一筆付款」再 JOIN。
            $sql = "SELECT o.order_id, o.user_id, o.total_amount, o.status, o.created_at,
                           u.full_name, u.email,
                           pay.payment_id, pay.payment_method, pay.transaction_id,
                           pay.amount AS paid_amount, pay.status AS pay_status, pay.paid_at
                      FROM Orders o
                      JOIN Users u ON u.user_id = o.user_id
                 LEFT JOIN (SELECT order_id, MAX(payment_id) AS payment_id FROM Payments GROUP BY order_id) lp
                        ON lp.order_id = o.order_id
                 LEFT JOIN Payments pay ON pay.payment_id = lp.payment_id
                     WHERE $where
                  ORDER BY o.created_at ASC, o.order_id ASC
                     LIMIT :limit OFFSET :offset";

            $stmt = $pdo->prepare($sql);
            $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
            $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
            $stmt->execute();

            echo json_encode([
                "page"        => $page,
                "per_page"    => $limit,
                "total"       => $total,
                "total_pages" => max(1, (int)ceil($total / $limit)),
                "scope"       => $scope,
                "data"        => $stmt->fetchAll()
            ]);

        } elseif ($method === 'PUT') {
            // 更新訂單履約狀態。誰能做哪一步由 order_transition_rules() 決定：
            //   倉管 → 只能 待出貨 → 已出貨
            //   物流 → 只能 已出貨 → 已完成
            //   manager / admin → 全部，另可取消
            $order_id = (int)($input['order_id'] ?? 0);
            $status = (string)($input['status'] ?? '');
            $rules = order_transition_rules($me['role']);

            if ($order_id <= 0 || !in_array($status, ORDER_STATUSES, true)) {
                deny(400, "需提供 order_id 與合法的 status（" . implode(' / ', ORDER_STATUSES) . "）");
            }
            if (!isset($rules[$status])) {
                deny(403, "你的角色不能把訂單改為「{$status}」");
            }

            $stmt = $pdo->prepare("SELECT status FROM Orders WHERE order_id = ?");
            $stmt->execute([$order_id]);
            $current = $stmt->fetchColumn();
            if ($current === false) deny(404, "找不到這張訂單");
            if ($current === $status) {
                echo json_encode(["message" => "狀態未變更", "status" => $status]);
                break;
            }
            if ($current === 'cancelled') deny(409, "已取消的訂單不能再改狀態");

            // 🛡️ 也要檢查「從什麼狀態來」——
            //    否則物流可以把還沒出貨的訂單直接標成已完成，跳過倉管那一關。
            if (!in_array($current, $rules[$status], true)) {
                deny(409, "訂單目前是「{$current}」，不能直接改為「{$status}」");
            }

            $pdo->beginTransaction();
            try {
                // 🔁 取消訂單要把當初扣掉的庫存還回去，否則商品會憑空消失
                if ($status === 'cancelled') {
                    $stmt = $pdo->prepare("SELECT product_id, quantity FROM Order_Items WHERE order_id = ? AND product_id IS NOT NULL");
                    $stmt->execute([$order_id]);
                    $restore = $pdo->prepare("UPDATE Products SET stock_quantity = stock_quantity + ? WHERE product_id = ?");
                    foreach ($stmt->fetchAll() as $it) {
                        $restore->execute([(int)$it['quantity'], (int)$it['product_id']]);
                    }
                }

                // 還沒入帳就取消 → 那筆付款不會發生了，一併作廢
                if ($status === 'cancelled') {
                    $stmt = $pdo->prepare(
                        "UPDATE Payments SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'"
                    );
                    $stmt->execute([$order_id]);
                }

                $stmt = $pdo->prepare("UPDATE Orders SET status = ? WHERE order_id = ?");
                $stmt->execute([$status, $order_id]);

                $pdo->commit();
                $msg = [
                    'shipped'           => "訂單已出貨，交由物流配送",
                    'completed'         => "訂單已送達客戶，流程完成",
                    'cancelled'         => "訂單已取消，庫存已還原",
                    'awaiting_shipment' => "訂單已退回待出貨",
                ];
                echo json_encode([
                    "message" => $msg[$status] ?? "訂單狀態已更新",
                    "order_id" => $order_id,
                    "status" => $status
                ]);
            } catch (Exception $e) {
                $pdo->rollBack();
                http_response_code(500);
                echo json_encode(["message" => "更新失敗: " . $e->getMessage()]);
            }
        }
        break;

    // ==========================================
    // 13-1. staff-payments (後台：訂單帳款管理 —— 財務專用)
    // ------------------------------------------
    // 「確認收款」從 staff-orders 拆出來獨立成一支端點。
    // 訂單狀態改成純履約進度之後，收款不再是「把訂單改成已付款」，
    // 而是「把付款紀錄從 pending 改成 success」—— 兩者是不同的事，
    // 權限也不同（財務管帳款、倉管管出貨），混在同一支端點會分不開。
    // ==========================================
    case 'staff-payments':
        $me = require_role($pdo, $TOKEN_SECRET, ['finance', 'manager', 'admin']);

        if ($method === 'PUT') {
            $order_id = (int)($input['order_id'] ?? 0);
            $status   = (string)($input['status'] ?? 'success');
            if ($order_id <= 0 || !in_array($status, ['success', 'cancelled'], true)) {
                deny(400, "需提供 order_id 與合法的 status（success / cancelled）");
            }

            $stmt = $pdo->prepare(
                "SELECT p.payment_id, p.status, p.payment_method, p.amount, o.status AS order_status
                   FROM Payments p JOIN Orders o ON o.order_id = p.order_id
                  WHERE p.order_id = ?"
            );
            $stmt->execute([$order_id]);
            $pay = $stmt->fetch();
            if (!$pay) deny(404, "這張訂單沒有付款紀錄");

            if ($pay['status'] === $status) {
                echo json_encode(["message" => "付款狀態未變更", "status" => $status]);
                break;
            }
            // 只允許從「待收款」往前走，避免把已收的款退回成待收（那是退款流程，不在此範圍）
            if ($pay['status'] !== 'pending') {
                deny(409, "這筆付款已是「{$pay['status']}」，不能再變更");
            }

            $paidAt = ($status === 'success') ? date('Y-m-d H:i:s') : null;
            $stmt = $pdo->prepare(
                "UPDATE Payments SET status = ?, paid_at = ? WHERE order_id = ? AND status = 'pending'"
            );
            $stmt->execute([$status, $paidAt, $order_id]);

            echo json_encode([
                "message" => $status === 'success'
                    ? "已確認收款（" . (PAYMENT_LABELS[$pay['payment_method']] ?? $pay['payment_method']) . "）"
                    : "已將此筆款項標記為取消",
                "order_id" => $order_id,
                "payment_status" => $status
            ]);
        }
        break;

    // ==========================================
    // 14. staff-users (後台：會員帳戶清單)
    // ==========================================
    case 'staff-users':
        $me = require_staff($pdo, $TOKEN_SECRET);

        if ($method === 'GET') {
            list($page, $limit, $offset) = page_params(20);
            $total = (int)$pdo->query("SELECT COUNT(*) FROM Users")->fetchColumn();

            // 絕不 SELECT *：password_hash 不該離開資料庫
            $stmt = $pdo->prepare(
                "SELECT u.user_id, u.email, u.full_name, u.role, u.status, u.created_at,
                        (SELECT COUNT(*) FROM Orders o WHERE o.user_id = u.user_id) AS order_count,
                        (SELECT COALESCE(SUM(o2.total_amount), 0) FROM Orders o2
                          WHERE o2.user_id = u.user_id AND o2.status <> 'cancelled') AS total_spent
                   FROM Users u ORDER BY u.user_id ASC LIMIT :limit OFFSET :offset"
            );
            $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
            $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
            $stmt->execute();

            echo json_encode([
                "page"        => $page,
                "per_page"    => $limit,
                "total"       => $total,
                "total_pages" => max(1, (int)ceil($total / $limit)),
                "data"        => $stmt->fetchAll()
            ]);

        } elseif ($method === 'PUT') {
            // 🛡️ 變更角色與停用/重啟帳號都只有 admin 能做 ——
            //    manager 若能自行升級任何人為 admin、或把 admin 停用，角色分層就形同虛設。
            //    （$me 上面已驗過，這裡只補角色檢查）
            if ($me['role'] !== 'admin') {
                deny(403, "變更會員角色或啟用狀態限「admin」使用");
            }

            $target = (int)($input['user_id'] ?? 0);
            if ($target <= 0) deny(400, "需提供 user_id");
            if ($target === $me['user_id']) {
                deny(409, "不能變更自己的角色或啟用狀態，避免把自己鎖在門外");
            }

            $stmt = $pdo->prepare("SELECT user_id, full_name, role, status FROM Users WHERE user_id = ?");
            $stmt->execute([$target]);
            $victim = $stmt->fetch();
            if (!$victim) deny(404, "找不到這位會員");

            $hasRole   = array_key_exists('role', $input);
            $hasStatus = array_key_exists('status', $input);
            if (!$hasRole && !$hasStatus) deny(400, "需提供 role 或 status 其中之一");

            $newRole   = $hasRole   ? (string)$input['role']   : $victim['role'];
            $newStatus = $hasStatus ? (string)$input['status'] : $victim['status'];

            if (!in_array($newRole, ALL_ROLES, true)) {
                deny(400, "role 需為 " . implode(' / ', ALL_ROLES));
            }
            if (!in_array($newStatus, ['active', 'suspended'], true)) {
                deny(400, "status 需為 active（啟用）或 suspended（停用）");
            }

            // 🛡️ 最後一位可用 admin 的保險絲（防禦性，正常情況碰不到）：
            //    呼叫者必須是「啟用中的 admin」才進得來，而上面已經擋掉「改自己」，
            //    所以目標是 admin 時系統至少還有呼叫者本人這位 admin ——
            //    也就是說目前這段永遠不會觸發。
            //    留著是為了防止日後有人拿掉上面的自我保護、或加上「刪除會員」之類的新入口，
            //    讓「系統永遠至少有一位可登入的 admin」這個不變條件不必依賴單一檢查。
            $losesAdmin = ($victim['role'] === 'admin')
                && ($newRole !== 'admin' || $newStatus !== 'active');
            if ($losesAdmin) {
                $stmt = $pdo->prepare(
                    "SELECT COUNT(*) FROM Users WHERE role = 'admin' AND status = 'active' AND user_id <> ?"
                );
                $stmt->execute([$target]);
                if ((int)$stmt->fetchColumn() === 0) {
                    deny(409, "這是系統唯一一位啟用中的管理員，不能停用或降級 —— 否則沒有人能再進入後台");
                }
            }

            $stmt = $pdo->prepare("UPDATE Users SET role = ?, status = ? WHERE user_id = ?");
            $stmt->execute([$newRole, $newStatus, $target]);

            // 停用時把對方手上的權杖一併作廢。
            // 其實 require_auth 每次都會現查 status，停用本來就立即生效；
            // 這裡多做一步是為了讓 Revoked_Tokens 反映真實狀況，
            // 也讓「停用 → 重啟」之後對方必須重新登入，不會沿用舊的登入階段。
            if ($newStatus === 'suspended') {
                $stmt = $pdo->prepare("DELETE FROM Revoked_Tokens WHERE user_id = ? AND expires_at < NOW()");
                $stmt->execute([$target]);
            }

            $verb = !$hasStatus ? "角色已更新"
                  : ($newStatus === 'suspended' ? "帳號已停用" : "帳號已重啟");
            echo json_encode([
                "message" => "「{$victim['full_name']}」{$verb}",
                "user_id" => $target,
                "role"    => $newRole,
                "status"  => $newStatus
            ]);
        }
        break;

    default:
        http_response_code(404);
        echo json_encode(["message" => "找不到此 API 資源端點"]);
        break;
}
?>
