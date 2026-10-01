-- ==============================================================================
-- 行動資料庫應用期末專案 — 全新安裝用結構
-- ------------------------------------------------------------------------------
-- ⚠️ 這份是「從零建立」用的。若資料庫已經存在且有資料，
--    請改跑 MariaDB-migration.sql，不要跑這一份（CREATE TABLE 會直接失敗）。
-- ==============================================================================
CREATE DATABASE IF NOT EXISTS shop_db CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_as_cs;
USE shop_db;

-- 1. Users (使用者表)
CREATE TABLE Users (
    user_id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(50) NOT NULL,
    -- 六種角色：
    --    customer  一般消費者
    --    manager   營運人員   —— 商品/分類管理、客服聊天室、訂單總覽
    --    finance   財務       —— 訂單帳款管理：審核 ATM 入帳、貨到付款收現
    --    warehouse 倉管       —— 倉庫管理：把待出貨的訂單交給物流
    --    logistics 物流       —— 物流管理：回報客戶已收到貨
    --    admin     系統管理員 —— 最高權限，可檢視所有聊天室與調整角色
    role ENUM('customer', 'manager', 'finance', 'warehouse', 'logistics', 'admin') DEFAULT 'customer',
    -- 🆕 帳號啟用狀態：admin 可在後台「停用 / 重啟」會員。
    --    停用不是刪除 —— 訂單、評價、聊天記錄全部保留，只是這個人登不進來。
    --    （真的刪除的話，外鍵 ON DELETE CASCADE 會把他的訂單一起帶走。）
    status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    -- 註：原本的 auth_token / token_expired_at 兩欄已移除。
    --     現在採用 HMAC 簽章權杖（無狀態），不需要把權杖存進資料庫；
    --     要作廢權杖是靠下面的 Revoked_Tokens 黑名單。
);

-- 2. Categories (商品分類表)
CREATE TABLE Categories (
    category_id INT AUTO_INCREMENT PRIMARY KEY,
    category_name VARCHAR(50) NOT NULL,
    description TEXT
);

-- 3. Products (商品主表 - 已內建主鍵聚簇索引)
CREATE TABLE Products (
    product_id INT AUTO_INCREMENT PRIMARY KEY,
    category_id INT,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    stock_quantity INT NOT NULL,
    image_url VARCHAR(255),
    FOREIGN KEY (category_id) REFERENCES Categories(category_id) ON DELETE SET NULL
);

-- 4. Cart (購物車暫存表)
CREATE TABLE Cart (
    cart_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    product_id INT,
    quantity INT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES Products(product_id) ON DELETE CASCADE,
    -- 同一位使用者對同一件商品只該有一筆明細（api.php 的加入購物車是「找到就累加」）
    UNIQUE KEY uk_cart_user_product (user_id, product_id)
);

-- 5. Orders (訂單主表)
CREATE TABLE Orders (
    order_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    total_amount DECIMAL(10, 2) NOT NULL,
    -- 🆕 訂單狀態現在只表示「履約進度」，不再表示付款 ——
    --    付款狀態獨立在 Payments.status，兩者互不干涉。
    --    訂單一成立就是 awaiting_shipment（待出貨），不管付款收到了沒有：
    --
    --      awaiting_shipment 待出貨 → 倉管出貨給物流
    --      shipped           已出貨 → 物流送達並回報
    --      completed         已完成
    --      cancelled         已取消（庫存會還原）
    --
    --    pending / paid 是舊制留下的值，僅供歷史資料使用，新訂單不會再產生。
    status ENUM('awaiting_shipment', 'shipped', 'completed', 'cancelled', 'pending', 'paid')
           NOT NULL DEFAULT 'awaiting_shipment',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE
);

-- 6. Order_Items (訂單明細表)
CREATE TABLE Order_Items (
    item_id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT,
    product_id INT,
    quantity INT NOT NULL,
    price_at_purchase DECIMAL(10, 2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES Orders(order_id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES Products(product_id) ON DELETE SET NULL
);

-- 7. Payments (支付紀錄表)
CREATE TABLE Payments (
    payment_id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT,
    payment_method VARCHAR(50) NOT NULL,
    transaction_id VARCHAR(100) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    -- 🆕 status 依支付方式分流：
    --    信用卡 / 行動支付 / App 支付 → 即時扣款，建立時就是 'success'
    --    ATM 轉帳 / 貨到付款          → 先寫 'pending'，後台確認收款後才轉 'success'
    --    訂單取消時，還沒入帳的付款會被標為 'cancelled'
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- 🆕 必須允許 NULL：還沒入帳的付款沒有「付款時間」。
    --    原本是 TIMESTAMP DEFAULT CURRENT_TIMESTAMP（MySQL 預設 NOT NULL），
    --    會讓未入帳的紀錄硬生生帶上一個假的付款時間。
    paid_at TIMESTAMP NULL DEFAULT NULL,
    FOREIGN KEY (order_id) REFERENCES Orders(order_id) ON DELETE CASCADE,
    -- 一張訂單只該有一筆付款紀錄，防止重複送出結帳產生兩筆
    UNIQUE KEY uk_payments_order (order_id)
);

-- 8. Reviews (商品評價表)
CREATE TABLE Reviews (
    review_id INT AUTO_INCREMENT PRIMARY KEY,
    product_id INT,
    user_id INT,
    rating INT CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES Products(product_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE
);

-- 9. Chat_Rooms (客服聊天室主表)
CREATE TABLE Chat_Rooms (
    room_id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT,
    -- 🆕 原本叫 admin_id，改名為 manager_id：
    --    客服對話是「customer ↔ manager」，由 manager 認領處理。
    --    NULL 代表這間房還沒有人認領，任何 manager 都看得到、都可以接手；
    --    一旦有 manager 回覆就會寫入他的 user_id，之後只有他（與 admin）看得到。
    manager_id INT NULL,
    status ENUM('open', 'closed') DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES Users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (manager_id) REFERENCES Users(user_id) ON DELETE SET NULL
);

-- 10. Messages (訊息明細表)
CREATE TABLE Messages (
    message_id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT,
    sender_id INT,
    message_text TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES Chat_Rooms(room_id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES Users(user_id) ON DELETE CASCADE
);

-- 11. 🆕 Revoked_Tokens (權杖黑名單)
-- ------------------------------------------------------------------------------
-- HMAC 簽章權杖是無狀態的，簽出去就無法收回，登出後那張在有效期內仍然驗得過。
-- 這張表就是「作廢清單」：登出時把權杖的雜湊寫進來，
-- 每次驗證權杖後多查一次這裡，命中就視為失效。
--
-- 只存 SHA-256 雜湊、不存權杖原文 —— 這張表若被讀走，也拿不到可用的權杖。
-- expires_at 記的是「權杖本身的到期時間」：過了那個時間權杖本來就失效，
-- 這筆黑名單就沒有存在意義，可以安全清掉（見檔案最後的清理範例）。
CREATE TABLE Revoked_Tokens (
    token_hash CHAR(64) PRIMARY KEY,
    user_id INT NULL,
    revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE
);

-- ⚡ 效能優化：針對 AJAX 高頻率即時通訊輪詢的欄位建立 B-Tree 索引
CREATE INDEX idx_messages_room ON Messages(room_id);
-- 🆕 客服中心會用「這位客戶的房間」「還沒人認領的房間」兩種條件掃描
CREATE INDEX idx_chatrooms_customer ON Chat_Rooms(customer_id, status);
CREATE INDEX idx_chatrooms_manager ON Chat_Rooms(manager_id, status);
-- 🆕 後台訂單流水是「依成立時間由舊到新」分頁，沒有索引會整表排序
CREATE INDEX idx_orders_created ON Orders(created_at);
-- 🆕 倉管／物流的工作佇列是「依狀態篩選 + 依成立時間排序」
CREATE INDEX idx_orders_status_created ON Orders(status, created_at);
-- 🆕 財務的待收款佇列是「依付款狀態篩選」
CREATE INDEX idx_payments_status ON Payments(status);
-- 🆕 黑名單清理用
CREATE INDEX idx_revoked_expires ON Revoked_Tokens(expires_at);

-- ==============================================================================
-- 📋 植入教學用初始基礎測試資料
-- ------------------------------------------------------------------------------
-- ⚠️ 原本的 seed 密碼雜湊對不上任何密碼（那三個帳號其實登不進去）。
--    以下改用實際可用的 bcrypt 雜湊，密碼如註解所示。正式環境請立即改掉。
-- ==============================================================================
-- 密碼：admin123
INSERT INTO Users (email, password_hash, full_name, role) VALUES
  ('admin@shop.com',   '$2y$10$Xfa7lksQhZ9k6/cXxqs0AuD3wgiYn92CruOMtsS0gj47m7LLtL4J.', '系統管理員', 'admin');
-- 密碼：manager123
INSERT INTO Users (email, password_hash, full_name, role) VALUES
  ('manager@shop.com', '$2y$10$Ou0.ougANOkjgsVCt68q6OmW9m0t5Zd0qJFOhJTtr63b2tJuOYEVC', '客服主管 林經理', 'manager');
-- 密碼：customer123
INSERT INTO Users (email, password_hash, full_name, role) VALUES
  ('customer@shop.com','$2y$10$/OGbJbRzVxGr21YLR6SMqOhlB5Tnqz5YaLQTiFRu.21QAKD5P3saS', '王小明', 'customer');
-- 密碼：finance123
INSERT INTO Users (email, password_hash, full_name, role) VALUES
  ('finance@shop.com','$2y$10$YYt2BQeahB6V0ggKm2fmJOJdEsEJNlPYOzyTw/vxeyQlY5YBF0oOO', '財務 陳會計', 'finance');
-- 密碼：warehouse123
INSERT INTO Users (email, password_hash, full_name, role) VALUES
  ('warehouse@shop.com','$2y$10$LlJfOyY8Z9A5QYTA2jjaJeyZT7NfJmYxM07sGWiUKIo8WZqIVPxvW', '倉管 張倉儲', 'warehouse');
-- 密碼：logistics123
INSERT INTO Users (email, password_hash, full_name, role) VALUES
  ('logistics@shop.com','$2y$10$KRlOBvgltQRofV1sbpA78.BFuPjPkCFA7L/145mW.OksyhxYUP2qe', '物流 李配送', 'logistics');

INSERT INTO Categories (category_name, description) VALUES
  ('3C電子', '智慧型手機與周邊配件'),
  ('流行服飾', '男女潮流服飾與配件');

INSERT INTO Products (category_id, name, description, price, stock_quantity, image_url) VALUES
  (1, '藍芽降噪耳機', '主動降噪，續航 30 小時', 1790, 25, 'https://via.placeholder.com/150'),
  (1, '無線滑鼠',     '靜音微動，2.4G + 藍芽雙模', 410, 40, 'https://via.placeholder.com/150'),
  (2, '純棉素T',       '台灣製，四色可選',         390, 100, 'https://via.placeholder.com/150');

-- ==============================================================================
-- 🧹 選用：定期清掉已經過期的黑名單（權杖本來就失效了，留著只是佔空間）
-- ------------------------------------------------------------------------------
-- DELETE FROM Revoked_Tokens WHERE expires_at < NOW();
--
-- 若 MariaDB 已開啟 event_scheduler（SET GLOBAL event_scheduler = ON），
-- 可以改成每天自動跑：
--
-- CREATE EVENT IF NOT EXISTS ev_purge_revoked_tokens
--   ON SCHEDULE EVERY 1 DAY
--   DO DELETE FROM Revoked_Tokens WHERE expires_at < NOW();
-- ==============================================================================
