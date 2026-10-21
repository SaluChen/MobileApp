# 行動電商後端 —— Python 3 版（由 api.php 改寫）

## 內容

| 檔案 | 說明 |
|---|---|
| `api.py` | 後端主程式（Flask + PyMySQL），取代 `api.php`；同時提供前端網頁 |
| `requirements.txt` | 相依套件 |
| `login.html`、`index.html`、`admin.html`、`manager.html`、`finance.html`、`warehouse.html`、`logistics.html` | 網頁前端（已配合改寫） |
| `backoffice.js`、`ops.js`、`backoffice.css` | 後台共用程式與樣式 |
| `App.js` | 手機 App（Expo）原始碼，已改 API 預設網址 |

資料庫結構**完全沿用 `../MariaDB.sql`**，不需要任何 migration。

## 安裝與啟動

```bash
cd py3
pip install -r requirements.txt
python api.py            # 預設 http://0.0.0.0:5000
```

- 設定檔：依序讀 環境變數 `DB_INI` 指定的檔案 → `py3/db.ini` → 上一層的 `db.ini`（原本 PHP 用的那份）。
  鍵名與 PHP 版相同（`host`、`user`/`username`、`password`/`pass`、`dbname`/`db_name`、`port`、`token_secret`）。
- 連接埠：環境變數 `API_PORT`（預設 5000）、`API_HOST`（預設 0.0.0.0）。
- 正式環境建議用 waitress：`pip install waitress` 後執行
  `waitress-serve --port=5000 api:app`。

## 網址

| PHP 版 | Python 版 |
|---|---|
| `http://主機/login.html` | `http://主機:5000/login.html` |
| `http://主機/api.php/products?page=2` | `http://主機:5000/api/products?page=2` |

`/api.php/…` 與 `/api.py/…` 也保留為相容別名，瀏覽器裡已存的舊 API 位址照樣可用。

## 與 PHP 版的相容性

- 端點、參數、HTTP 狀態碼、回應 JSON、錯誤訊息全部相同。
  （以同一份初始資料庫、127 個操作步驟逐筆比對 PHP 原版，結果完全一致。）
- 登入權杖格式與簽章方式相同：兩版共用同一個 `token_secret` 時，權杖可以互通。
- 密碼雜湊格式相同（`$2y$10$…`）：Python 版註冊的帳號，PHP 版也能登入，反之亦然。
- 只開放網頁會用到的副檔名（.html/.css/.js/圖片），`db.ini`、`.py` 原始碼不會被下載。

## 顧客商城的分類目錄與分頁（新增）

顧客登入 `index.html` 後，商品目錄先依 `category_id` 列出分類，點分類才列出底下的商品；兩層都是每頁 20 筆。

| 請求 | 回應 |
|---|---|
| `GET /api/categories` | 不帶 `page`：完整分類陣列（後台下拉選單、App 照舊使用） |
| `GET /api/categories?page=N` | 分頁信封 `{page, per_page, total, total_pages, data}`，每筆多一個 `product_count` |
| `GET /api/products?category_id=C&page=N` | 該分類商品的分頁信封，依 `product_id` 由新到舊 |
| `GET /api/products?page=N` | 不帶 `category_id`：舊行為，回傳陣列 |

分類被刪除後，商品的 `category_id` 會變成 NULL。這些商品會收在最後一個虛擬分類「未分類」（`category_id = 0`）。
