-- ==============================================================================
-- 既有資料庫升級腳本（不會刪資料）
-- ------------------------------------------------------------------------------
-- 適用對象：資料庫已經照舊版 MariaDB.sql 建好、而且裡面已經有資料的環境。
-- 全新安裝請直接跑 MariaDB.sql，不要跑這一份。
--
-- ✅ 本腳本是「冪等」的：每個步驟都會先查 information_schema 確認需不需要做，
--    重複執行不會報錯、也不會中途中斷。跑第二次只會看到一整排「已存在，略過」。
--
-- 執行方式（XAMPP 為例）：
--   C:\xampp\mysql\bin\mysql.exe -h 192.168.8.88 -u admin -p shop_db < MariaDB-migration.sql
--
-- ⚠️ 跑之前請先備份：
--   C:\xampp\mysql\bin\mysqldump.exe -h 192.168.8.88 -u admin -p shop_db > shop_db_backup.sql
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Users.role 加入 manager
-- ------------------------------------------------------------------------------
-- MODIFY 會重建欄位定義，既有資料只要落在新的 ENUM 清單內就不受影響。
-- 這行本身就是冪等的（改成已經是的樣子 = 沒事發生）。
ALTER TABLE Users
  MODIFY COLUMN role ENUM('customer', 'manager', 'finance', 'warehouse', 'logistics', 'admin')
  NOT NULL DEFAULT 'customer';
SELECT '1. Users.role 已含 manager / finance / warehouse / logistics' AS step;

-- ------------------------------------------------------------------------------
-- 2. 移除舊版遺留、現在用不到的兩個欄位
-- ------------------------------------------------------------------------------
-- 改用 HMAC 無狀態權杖 + Revoked_Tokens 黑名單，不需要把權杖存在 Users 上。
SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Users' AND COLUMN_NAME = 'auth_token'),
  'ALTER TABLE Users DROP COLUMN auth_token',
  'SELECT ''2a. Users.auth_token 不存在，略過'' AS step'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Users' AND COLUMN_NAME = 'token_expired_at'),
  'ALTER TABLE Users DROP COLUMN token_expired_at',
  'SELECT ''2b. Users.token_expired_at 不存在，略過'' AS step'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SELECT '2. 舊權杖欄位已清理' AS step;

-- ------------------------------------------------------------------------------
-- 2-1. 🆕 Users.status（帳號停用 / 重啟）
-- ------------------------------------------------------------------------------
-- 停用不是刪除 —— 訂單、評價、聊天記錄全部保留，只是這個人登不進來。
-- 既有會員一律預設 'active'，升級後行為不變。
SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Users' AND COLUMN_NAME = 'status'),
  'SELECT ''2-1. Users.status 已存在，略過'' AS step',
  'ALTER TABLE Users ADD COLUMN status ENUM(''active'', ''suspended'') NOT NULL DEFAULT ''active'' AFTER role'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SELECT '2-1. Users.status 完成' AS step;

-- ------------------------------------------------------------------------------
-- 3. Orders.status 改為「履約進度」語意
-- ------------------------------------------------------------------------------
-- 訂單狀態不再表示付款 —— 付款狀態獨立在 Payments.status。
-- 訂單一成立就是 awaiting_shipment（待出貨），不管錢收到了沒有：
--
--   awaiting_shipment 待出貨 → 倉管出貨給物流
--   shipped           已出貨 → 物流送達並回報
--   completed         已完成
--   cancelled         已取消
--
-- pending / paid 保留在 ENUM 內只是為了讓下面的 UPDATE 跑得動（先擴充再搬資料），
-- 搬完之後就不會再有任何一列使用它們。
ALTER TABLE Orders
  MODIFY COLUMN status ENUM('awaiting_shipment', 'shipped', 'completed', 'cancelled', 'pending', 'paid')
  NOT NULL DEFAULT 'awaiting_shipment';
SELECT '3. Orders.status 已含 awaiting_shipment' AS step;

-- 舊制的 pending / paid 都代表「還沒出貨」，一律搬成 awaiting_shipment。
-- 這些訂單的付款狀況不會遺失 —— 它記在 Payments.status。
-- shipped / completed / cancelled 維持原樣。
UPDATE Orders SET status = 'awaiting_shipment' WHERE status IN ('pending', 'paid');
SELECT CONCAT('3-1. 已將 ', ROW_COUNT(), ' 筆舊訂單搬為待出貨') AS step;

-- 沒有付款紀錄的舊訂單（結帳到一半放棄的）補一筆待收款，
-- 否則財務頁看不到它們、倉管也不知道該不該出貨。
INSERT INTO Payments (order_id, payment_method, transaction_id, amount, status, paid_at)
SELECT o.order_id, 'ATM Transfer', CONCAT('LEGACY-', o.order_id), o.total_amount, 'pending', NULL
  FROM Orders o
 WHERE o.status <> 'cancelled'
   AND NOT EXISTS (SELECT 1 FROM Payments p WHERE p.order_id = o.order_id);
SELECT CONCAT('3-2. 已為 ', ROW_COUNT(), ' 筆無付款紀錄的舊訂單補上待收款') AS step;

-- ------------------------------------------------------------------------------
-- 3-1. 🆕 Payments 支援「未入帳」狀態
-- ------------------------------------------------------------------------------
-- 支付方式分流後，ATM 轉帳與貨到付款在結帳當下並沒有真的收到錢，
-- 付款紀錄要能停在 'pending' 且「沒有付款時間」。
-- 原本 paid_at 是 TIMESTAMP DEFAULT CURRENT_TIMESTAMP（MySQL 預設 NOT NULL），
-- 會讓未入帳的紀錄硬生生帶上一個假的付款時間。
ALTER TABLE Payments MODIFY COLUMN paid_at TIMESTAMP NULL DEFAULT NULL;
ALTER TABLE Payments MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending';
SELECT '3-1. Payments.paid_at 已可為 NULL' AS step;

-- 既有資料一律視為已完成付款（它們是舊制即時扣款產生的）
UPDATE Payments SET status = 'success' WHERE status IS NULL OR status = '';

-- 一張訂單只該有一筆付款紀錄。
-- ⚠️ 若舊資料已有重複，加索引會失敗；先跑這段只留最後一筆：
--   DELETE p FROM Payments p
--     JOIN (SELECT order_id, MAX(payment_id) AS keep_id
--             FROM Payments GROUP BY order_id HAVING COUNT(*) > 1) d
--       ON p.order_id = d.order_id
--    WHERE p.payment_id <> d.keep_id;
SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Payments' AND INDEX_NAME = 'uk_payments_order'),
  'SELECT ''3-2. Payments 唯一鍵已存在，略過'' AS step',
  'ALTER TABLE Payments ADD UNIQUE KEY uk_payments_order (order_id)'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SELECT '3-2. Payments 唯一鍵完成' AS step;

-- ------------------------------------------------------------------------------
-- 4. Chat_Rooms.admin_id 改名為 manager_id
-- ------------------------------------------------------------------------------
-- 客服對話是「customer ↔ manager」，欄位名稱跟著語意調整。
-- CHANGE 只在「admin_id 還在、manager_id 還沒出現」時才執行。
SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Chat_Rooms' AND COLUMN_NAME = 'admin_id')
  AND NOT EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Chat_Rooms' AND COLUMN_NAME = 'manager_id'),
  'ALTER TABLE Chat_Rooms CHANGE COLUMN admin_id manager_id INT NULL',
  'SELECT ''4. Chat_Rooms.manager_id 已就緒，略過'' AS step'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SELECT '4. Chat_Rooms.manager_id 完成' AS step;

-- ------------------------------------------------------------------------------
-- 5. 新增 Revoked_Tokens（權杖黑名單）
-- ------------------------------------------------------------------------------
-- HMAC 簽章權杖是無狀態的，簽出去就無法收回，登出後那張在有效期內仍然驗得過。
-- 這張表就是「作廢清單」：登出時把權杖的雜湊寫進來，驗完簽再查一次這裡。
-- 只存 SHA-256 雜湊、不存原文 —— 這張表被讀走也拿不到可用的權杖。
CREATE TABLE IF NOT EXISTS Revoked_Tokens (
    token_hash CHAR(64) PRIMARY KEY,
    user_id INT NULL,
    revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE
);
SELECT '5. Revoked_Tokens 已建立' AS step;

-- ------------------------------------------------------------------------------
-- 6. 購物車唯一鍵（同一人同一商品只該有一筆）
-- ------------------------------------------------------------------------------
-- ⚠️ 若舊資料已有重複列，加索引會失敗。先跑這兩段把重複的合併起來：
--
--   UPDATE Cart c
--     JOIN (SELECT user_id, product_id, MIN(cart_id) AS keep_id, SUM(quantity) AS total_qty
--             FROM Cart GROUP BY user_id, product_id HAVING COUNT(*) > 1) d
--       ON c.cart_id = d.keep_id
--      SET c.quantity = d.total_qty;
--
--   DELETE c FROM Cart c
--     JOIN (SELECT user_id, product_id, MIN(cart_id) AS keep_id
--             FROM Cart GROUP BY user_id, product_id HAVING COUNT(*) > 1) d
--       ON c.user_id = d.user_id AND c.product_id = d.product_id
--    WHERE c.cart_id <> d.keep_id;
--
SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Cart' AND INDEX_NAME = 'uk_cart_user_product'),
  'SELECT ''6. Cart 唯一鍵已存在，略過'' AS step',
  'ALTER TABLE Cart ADD UNIQUE KEY uk_cart_user_product (user_id, product_id)'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SELECT '6. Cart 唯一鍵完成' AS step;

-- ------------------------------------------------------------------------------
-- 7. 新增索引
-- ------------------------------------------------------------------------------
-- MariaDB 的 CREATE INDEX 沒有 IF NOT EXISTS（10.6 起才有），
-- 為了相容舊版，一律先查 information_schema 再決定要不要建。
SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Chat_Rooms' AND INDEX_NAME = 'idx_chatrooms_customer'),
  'SELECT ''idx_chatrooms_customer 已存在'' AS info',
  'CREATE INDEX idx_chatrooms_customer ON Chat_Rooms(customer_id, status)'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Chat_Rooms' AND INDEX_NAME = 'idx_chatrooms_manager'),
  'SELECT ''idx_chatrooms_manager 已存在'' AS info',
  'CREATE INDEX idx_chatrooms_manager ON Chat_Rooms(manager_id, status)'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Orders' AND INDEX_NAME = 'idx_orders_created'),
  'SELECT ''idx_orders_created 已存在'' AS info',
  'CREATE INDEX idx_orders_created ON Orders(created_at)'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Revoked_Tokens' AND INDEX_NAME = 'idx_revoked_expires'),
  'SELECT ''idx_revoked_expires 已存在'' AS info',
  'CREATE INDEX idx_revoked_expires ON Revoked_Tokens(expires_at)'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 🆕 倉管／物流的工作佇列：依狀態篩選 + 依成立時間排序
SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Orders' AND INDEX_NAME = 'idx_orders_status_created'),
  'SELECT ''idx_orders_status_created 已存在'' AS info',
  'CREATE INDEX idx_orders_status_created ON Orders(status, created_at)'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 🆕 財務的待收款佇列：依付款狀態篩選
SET @sql = (SELECT IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Payments' AND INDEX_NAME = 'idx_payments_status'),
  'SELECT ''idx_payments_status 已存在'' AS info',
  'CREATE INDEX idx_payments_status ON Payments(status)'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SELECT '7. 索引完成' AS step;

-- ------------------------------------------------------------------------------
-- 8. 建立一個 manager 帳號
-- ------------------------------------------------------------------------------
-- 密碼：manager123（正式環境請立刻改掉）
INSERT INTO Users (email, password_hash, full_name, role)
SELECT 'manager@shop.com', '$2y$10$Ou0.ougANOkjgsVCt68q6OmW9m0t5Zd0qJFOhJTtr63b2tJuOYEVC', '客服主管 林經理', 'manager'
 WHERE NOT EXISTS (SELECT 1 FROM Users WHERE email = 'manager@shop.com');
SELECT '8. manager@shop.com 已就緒（密碼 manager123）' AS step;

-- 🆕 三個營運角色的帳號（密碼分別為 finance123 / warehouse123 / logistics123）
INSERT INTO Users (email, password_hash, full_name, role)
SELECT 'finance@shop.com', '$2y$10$YYt2BQeahB6V0ggKm2fmJOJdEsEJNlPYOzyTw/vxeyQlY5YBF0oOO', '財務 陳會計', 'finance'
 WHERE NOT EXISTS (SELECT 1 FROM Users WHERE email = 'finance@shop.com');

INSERT INTO Users (email, password_hash, full_name, role)
SELECT 'warehouse@shop.com', '$2y$10$LlJfOyY8Z9A5QYTA2jjaJeyZT7NfJmYxM07sGWiUKIo8WZqIVPxvW', '倉管 張倉儲', 'warehouse'
 WHERE NOT EXISTS (SELECT 1 FROM Users WHERE email = 'warehouse@shop.com');

INSERT INTO Users (email, password_hash, full_name, role)
SELECT 'logistics@shop.com', '$2y$10$KRlOBvgltQRofV1sbpA78.BFuPjPkCFA7L/145mW.OksyhxYUP2qe', '物流 李配送', 'logistics'
 WHERE NOT EXISTS (SELECT 1 FROM Users WHERE email = 'logistics@shop.com');
SELECT '8-1. finance / warehouse / logistics 帳號已就緒' AS step;

-- 或者把現有的某個帳號升級為某個角色：
-- UPDATE Users SET role = 'finance' WHERE email = '你的帳號@example.com';

-- ------------------------------------------------------------------------------
-- 9. 驗收
-- ------------------------------------------------------------------------------
SELECT '=== 驗收 ===' AS step;
SHOW COLUMNS FROM Users LIKE 'role';
SHOW COLUMNS FROM Users LIKE 'status';
SHOW COLUMNS FROM Orders LIKE 'status';
SHOW COLUMNS FROM Chat_Rooms LIKE 'manager_id';
SHOW TABLES LIKE 'Revoked_Tokens';
SELECT role, COUNT(*) AS 人數 FROM Users GROUP BY role;
