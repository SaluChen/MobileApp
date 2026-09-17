-- ==============================================================================
-- 重設／建立教學用測試帳號
-- ------------------------------------------------------------------------------
-- ⚠️ 這支腳本會「覆寫既有帳號的密碼」，所以刻意跟 MariaDB-migration.sql 分開。
--    migration 是結構升級，不該偷偷改任何人的密碼。
--
-- 為什麼需要這支：
--   舊版 MariaDB.sql 種的密碼雜湊是 $2y$10$eImiTxHXb/.gJdMvC3B14eR4O37wXU2W57fR0P1x...
--   這串對不上任何密碼 —— 也就是說 admin@shop.com 從一開始就登不進去。
--   migration 只會「新增」manager@shop.com，不會去動既有帳號，
--   所以升級後 admin 仍然是那串壞掉的雜湊。
--
-- 執行方式：
--   C:\xampp\mysql\bin\mysql.exe -h 192.168.8.88 -u admin -p shop_db < MariaDB-seed-accounts.sql
--
-- 密碼（正式環境請立刻改掉）：
--   admin@shop.com    / admin123     角色 admin
--   manager@shop.com  / manager123   角色 manager
--   customer@shop.com / customer123  角色 customer
-- ==============================================================================

-- 1. admin@shop.com —— 有就重設密碼，沒有就建立
INSERT INTO Users (email, password_hash, full_name, role)
SELECT 'admin@shop.com', '$2y$10$Xfa7lksQhZ9k6/cXxqs0AuD3wgiYn92CruOMtsS0gj47m7LLtL4J.', '系統管理員', 'admin'
 WHERE NOT EXISTS (SELECT 1 FROM Users WHERE email = 'admin@shop.com');

UPDATE Users
   SET password_hash = '$2y$10$Xfa7lksQhZ9k6/cXxqs0AuD3wgiYn92CruOMtsS0gj47m7LLtL4J.',
       role = 'admin'
 WHERE email = 'admin@shop.com';

-- 2. manager@shop.com
INSERT INTO Users (email, password_hash, full_name, role)
SELECT 'manager@shop.com', '$2y$10$Ou0.ougANOkjgsVCt68q6OmW9m0t5Zd0qJFOhJTtr63b2tJuOYEVC', '客服主管 林經理', 'manager'
 WHERE NOT EXISTS (SELECT 1 FROM Users WHERE email = 'manager@shop.com');

UPDATE Users
   SET password_hash = '$2y$10$Ou0.ougANOkjgsVCt68q6OmW9m0t5Zd0qJFOhJTtr63b2tJuOYEVC',
       role = 'manager'
 WHERE email = 'manager@shop.com';

-- 3. customer@shop.com
INSERT INTO Users (email, password_hash, full_name, role)
SELECT 'customer@shop.com', '$2y$10$/OGbJbRzVxGr21YLR6SMqOhlB5Tnqz5YaLQTiFRu.21QAKD5P3saS', '王小明', 'customer'
 WHERE NOT EXISTS (SELECT 1 FROM Users WHERE email = 'customer@shop.com');

UPDATE Users
   SET password_hash = '$2y$10$/OGbJbRzVxGr21YLR6SMqOhlB5Tnqz5YaLQTiFRu.21QAKD5P3saS',
       role = 'customer'
 WHERE email = 'customer@shop.com';

-- 4. 這三個帳號重設密碼後，手上舊的權杖應該一併作廢
--    （不然改密碼等於沒改 —— 有舊權杖的人照樣進得來）
DELETE FROM Revoked_Tokens
 WHERE user_id IN (SELECT user_id FROM Users WHERE email IN
       ('admin@shop.com', 'manager@shop.com', 'customer@shop.com'))
   AND expires_at < NOW();

-- 5. 驗收
SELECT user_id, email, full_name, role, LEFT(password_hash, 14) AS hash_prefix
  FROM Users
 WHERE email IN ('admin@shop.com', 'manager@shop.com', 'customer@shop.com')
 ORDER BY FIELD(role, 'admin', 'manager', 'customer');

-- ==============================================================================
-- 💡 想自訂密碼？用 PHP 產生 bcrypt 雜湊再貼進來：
--    php -r "echo password_hash('你的密碼', PASSWORD_BCRYPT);"
--    UPDATE Users SET password_hash = '產生出來的字串' WHERE email = '...';
--
--    ⚠️ 不要用 MySQL 的 SHA2() / MD5() —— api.php 是用 PHP 的 password_verify()
--       比對 bcrypt，格式不同會永遠對不上。
-- ==============================================================================
