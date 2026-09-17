# 05-App.js 改寫說明：舊語法／舊套件 → 新版本

改寫目標平台：**Expo SDK 57 / React Native 0.86.2 / React 19.2.3 / Android 16 (API 36)**

> 以上為改寫**當時**的版本。現行為 Expo `~57.0.22` / React Native `0.86.3`，並已新增 **iOS** 平台（見第 G 節第 9 輪）。

以下每一條都標明「為什麼非改不可」，方便上課講解。

> ### 📌 本文件的範圍
>
> 這份文件只記錄**第一步**：把原始教材 `05-App.js` 的舊語法與舊套件升級到現行版本。
> 它是一份**歷史紀錄**，不是目前的功能說明。
>
> 之後 App 又經歷多輪功能開發（主選單、購物車明細修改、訂單查詢、登入權杖、
> 支付方式選擇、履約狀態…），目前狀態請看：
>
> | 想知道什麼 | 看哪份 |
> | --- | --- |
> | App 現在有哪些畫面與功能 | [App.js-說明文件.md](App.js-說明文件.md) |
> | 角色權限、後台、API 端點 | [README-角色與後台.md](README-角色與後台.md) |
> | 怎麼打包 Android APK 與 iOS 版 | [README-打包APK.md](README-打包APK.md) |

---

## A. 會直接讓 App 壞掉的（必改）

### A-1. `SafeAreaView` 來源錯誤

```diff
- import { SafeAreaView } from 'react-native';
+ import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
```

React Native 0.80 起，內建的 `SafeAreaView` 已標記淘汰並準備移除，
而且它**在 Android 上根本不做事**（只有 iOS 有效）。
官方指定改用 `react-native-safe-area-context`。

### A-2. `StatusBar.currentHeight` 手動補 padding

```diff
- paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0
+ // 改由 <SafeAreaView edges={['top','bottom','left','right']}> 用真實 insets 處理
```

Android 15（API 35）起系統**強制 edge-to-edge**，
`StatusBar` 的 `backgroundColor` / `translucent` 全部失效，
`StatusBar.currentHeight` 也不再等於實際要避開的高度
（沒算到瀏海、打孔、手勢導覽列）。只有 safe-area insets 是對的。

### A-3. `StatusBar` 元件換成 `expo-status-bar`

```diff
- import { StatusBar } from 'react-native';
- <StatusBar barStyle="dark-content" backgroundColor="#f8f9fa" />
+ import { StatusBar } from 'expo-status-bar';
+ <StatusBar style="dark" />
```

理由同上：`backgroundColor` 在 edge-to-edge 下已無作用，留著只是誤導。

### A-4. 明文 HTTP 被 Android 封鎖

程式碼沒錯，但**打包成 APK 後一定連不上**：Android 9（API 28）起預設封鎖 cleartext HTTP。
已在 `app.json` 補上：

```json
["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]
```

### A-5. `blurOnSubmit` → `submitBehavior`

RN 0.83 起 `TextInput` 的 `blurOnSubmit` 已改名。原檔沒用到，
但聊天輸入框需要「送出後不收鍵盤」的行為，改寫版明確加上 `submitBehavior="submit"`。

---

## B. 舊世代 API（可動但已不推薦）

### B-1. `TouchableOpacity` → `Pressable`

`Pressable` 是 RN 現行推薦的觸控元件，支援 `pressed` / `hovered` / `focused` 多狀態，
也是 New Architecture 的一等公民。改寫版把可點的商品卡片與文字連結都換掉，
並抽出共用的 `<TextLink>`。

### B-2. `import React from 'react'` 已不需要

React 17 起有新的 JSX transform，React 19 更是完全不需要把 `React` 帶進作用域：

```diff
- import React, { useState, useEffect, useRef, useCallback } from 'react';
+ import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
```

### B-3. `isMountedRef` 模式 → `AbortController`

原版三個畫面都有這段：

```js
const isMountedRef = useRef(true);
if (!isMountedRef.current) return;   // 卸載後就丟棄結果
```

這是 React 17 時代為了消除「setState on unmounted component」警告的寫法，
**React 18 起該警告已被官方移除**，這個模式因此變成純粹的技術債
（請求還是照跑完、照吃流量、照耗電，只是結果丟掉）。

改寫版每個畫面持有一顆 `AbortController`，卸載時 `controller.abort()`
**直接中斷飛行中的 fetch**：

```js
useEffect(() => {
  const controller = new AbortController();
  abortRef.current = controller;
  fetchCart();
  return () => controller.abort();
}, [fetchCart]);
```

並用 `isAbort(e)` 過濾掉「因卸載而取消」的錯誤，避免離開頁面時還跳出錯誤視窗。

### B-4. `catch (e)` 沒用到參數

ES2019 起可以直接 `catch {}`，改寫版把三處用不到 `e` 的地方簡化了。

### B-5. `data && (data.message || data.error)` → 可選鏈

```diff
- (data && (data.message || data.error)) || `伺服器錯誤 HTTP ${response.status}`
+ data?.message || data?.error || `伺服器錯誤 HTTP ${response.status}`
```

同樣把 `if (!data || !data.user_id)` 改成 `if (!data?.user_id)`。

### B-6. `refreshing` / `onRefresh` → `refreshControl`

明確給 `<RefreshControl>` 才能控制轉圈顏色。
Android 預設是黑色轉圈，在淺色背景上很醜。

---

## C. 真正的 Bug（不是語法問題）

### C-1. 商品列表用 index 當 key，把重複資料藏起來

```diff
- keyExtractor={(item, index) => `${item.product_id}-${index}`}
+ keyExtractor={(item) => String(item.product_id)}
```

原版註解寫「防範重複主鍵警告」——但那個警告本身就是在**告訴你資料重複了**。
用 index 拼進 key 只是讓 React 閉嘴，畫面上仍然會出現兩張一模一樣的商品卡片。

真正的問題在後端分頁：`api.php` 的 `LIMIT 20 OFFSET n` 若沒有穩定排序，
相鄰兩頁本來就可能吐出同一筆商品。改寫版在資料層做去重：

```js
setProducts((prev) => {
  if (isRefreshAction) return dedupeByProductId(newProducts);
  const seen = new Set(prev.map((p) => String(p.product_id)));
  return [...prev, ...newProducts.filter((p) => !seen.has(String(p.product_id)))];
});
```

### C-2. 聊天輪詢用 `setInterval` 會堆成雪崩

```diff
- const polling = setInterval(fetchMessages, 2000);
+ const tick = async () => {
+   await fetchMessages();
+   if (!controller.signal.aborted) timer = setTimeout(tick, CHAT_POLL_MS);
+ };
```

`setInterval` 不管上一輪跑完沒有，時間到就再發一次。
內網卡頓時（例如每次請求要 5 秒），2 秒一發會不斷堆積請求。
原版雖然有 `inFlightRef` 擋住重複發射，但 interval 本身還是照跳、照排隊。

遞迴 `setTimeout` 從結構上保證「上一輪結束才排下一輪」。

### C-3. 登入成功時多跳一個 Alert 才進首頁

```diff
- Alert.alert('通知', '歡迎登入！');
- onLoginSuccess(data.user_id);
+ onLoginSuccess(data.user_id);
```

`Alert.alert` 不會等使用者按確定就往下跑，所以原版是「彈窗跟換頁同時發生」，
使用者會看到首頁上蓋著一個要手動關掉的通知。登入成功本來就會換頁，不需要再通知一次。

### C-4. 連線設定改完，上面那行字不會更新

原版 `⚙️ 連線設定（目前：{getApiUrl()}）` 直接讀模組變數。
模組變數不是 state，改了不會觸發 re-render。
改寫版把它納入 `useState`（`apiUrl`），存檔後同步更新。

### C-5. 登入頁鍵盤會蓋住輸入框

原版登入頁是 `<View>`，鍵盤彈出來會蓋住密碼欄跟按鈕。
改寫版包上 `KeyboardAvoidingView` + `ScrollView`。

---

## D. 其他改善

| 項目 | 說明 |
|---|---|
| 逾時偵測 | 原版靠 `e.name === 'AbortError'` 判斷逾時，但畫面卸載造成的取消也是 `AbortError`，會誤報「連線逾時」。改寫版用獨立的 `timedOut` 旗標區分兩者 |
| `AbortSignal.timeout()` | **刻意不用**。Hermes 目前沒有這個靜態方法，用了會 crash。改用手動合成 signal |
| `useMemo` 算購物車總價 | 避免每次 re-render 都重跑 reduce |
| `useCallback` 包 `renderItem` | 避免 FlatList 每次 render 都重建函式、拖垮長列表 |
| `placeholderTextColor` | 不指定的話在部分 Android 客製 ROM 上會變成幾乎看不見的淺灰 |
| `inputMode` / `autoComplete` / `textContentType` | 讓系統正確跳出對應鍵盤與自動填入 |
| 表單 `autoCorrect={false}` | 信箱欄位被自動修正過的話會登入失敗 |
| `BackHandler` 加 Platform 判斷 | iOS 沒有實體返回鍵，原版在 iOS 會註冊一個永遠不觸發的監聽 |
| `App` 拆成 `App` + `Router` | `SafeAreaProvider` 必須在使用 insets 的元件外層，拆開才不會層級錯亂 |
| 常數提到模組層 | `PAGE_SIZE`、`CHAT_ROOM_ID`、`CHAT_POLL_MS` 不必每次 render 重建 |
| 樣式抽出 inline style | `style={{ height: 40 }}`、`style={[styles.input, { flex: 1 }]}` 移進 StyleSheet |

---

## E. 原版本來就寫對、予以保留的部分

這幾點值得肯定，改寫版原封不動：

- **`BackHandler.addEventListener(...).remove()`** — RN 0.73 起 `removeEventListener` 已移除，
  原版用的 subscription 寫法就是現行正確寫法。
- **`loadingRef` / `hasMoreRef` 當真實鎖** — 註解說得完全正確：
  直接讀 state 在同一次 render 的閉包裡是舊值，快速滑動會重複發射 AJAX。
- **`@react-native-async-storage/async-storage`** — 這已經是社群維護版，
  被淘汰的是更早以前 `react-native` 內建的那個 `AsyncStorage`。
  （版本由 `npx expo install` 鎖到 SDK 57 對應的 2.2.0，不要手動裝 3.x）
- **API 位址可在 App 內修改並存進 AsyncStorage** — 對 APK 來說這是關鍵設計，
  IP 寫死的話換個教室整包就報廢。

---

## F. 沒有改、但可以再進一步的

- **導覽改用 React Navigation 或 Expo Router**
  目前是 `switch (currentScreen)` 手刻路由。教學上這樣反而好懂，
  而且 Android 實體返回鍵的處理是自己寫的、看得見。
  但如果要加上轉場動畫、deep link、瀏覽器歷史，就該換成正式的導覽套件。

- **聊天室改用 WebSocket**
  2 秒短輪詢對 MariaDB 是持續的無效查詢。正式產品應該用 WebSocket 或 SSE。

- **密碼處理** —— ✅ **後續已完成，且超出當初的建議**
  當初只寫「請確認 `api.php` 有用 `password_hash()`」。後續實作為：
  bcrypt 雜湊比對、HMAC 簽章登入權杖、`Revoked_Tokens` 黑名單、帳號停用即時生效。
  詳見 [README-角色與後台.md](README-角色與後台.md)。
  唯一仍成立的部分：**App 端密碼仍是明文送出，正式環境需要 HTTPS**。

---

## G. 這份改寫之後又做了什麼

為避免誤讀成「App 現況」，簡列後續各輪的主題：

| 輪次 | 主題 |
| --- | --- |
| 1 | 主選單 HomeScreen、購物車明細修改（樂觀更新）、訂單查詢 |
| 2 | 庫存檢查與下單扣庫存（條件式扣減防超賣）、訂單擁有者驗證 |
| 3 | HMAC 登入權杖、金額改由後端計算（前端 `expected_total` 只作對帳） |
| 4 | 帳號停用（`Users.status`），停用立即生效 |
| 5 | 統一登入頁 `login.html`，導向由後端決定 |
| 6 | 支付方式選擇與即時／延後付款分流 |
| 7 | 財務／倉管／物流三角色，訂單狀態改為純履約進度 |
| 8 | 金額千分位（新增 `money()`）、分類列被壓扁修正（`flexShrink: 0`）、後台角色清單收斂為 `BACKOFFICE_ROLES` |
| 9 | iOS 版：EAS 雲端建置、iOS 17 ATS 內網 IP 例外、`.easignore` 擋機密、相依套件對齊 SDK 57（`expo-doctor` 21/21） |

其中與本文件 **A~C 節直接相關**的後續修正：

* **C-2 的遞迴 `setTimeout`** 在後續的 `ChatScreen` 仍然沿用，並額外加上
  「先向後端取得自己的專屬房號」——舊版寫死 `CHAT_ROOM_ID = 1`，所有人擠在同一間房。
* **B-3 的 `AbortController`** 模式擴散到每一個畫面，成為全專案的標準寫法。
* **A-4 的明文 HTTP** 至今仍是內網教學情境的前提；權杖也走同一條明文通道，
  正式環境必須 HTTPS。
  iOS 版對明文 HTTP 更嚴格：iOS 17 起 App Transport Security 預設連 IP 位址都擋，
  必須在 `app.json` 的 `NSExceptionDomains` 逐一放行（目前只放行私有網段）。
* **A 節的 `SafeAreaView` / `expo-status-bar` 改寫**讓 iOS 版幾乎零修改就能跑 ——
  當初是為了 Android 15 的 edge-to-edge，但同一套 safe-area insets 也正好處理了 iPhone 的瀏海與 Home 指示條。
