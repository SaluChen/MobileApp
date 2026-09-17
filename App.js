/**
 * 行動商城 App —— Expo SDK 57 / React Native 0.86 / React 19 版
 * ---------------------------------------------------------------
 * 後端：02-api.php（MariaDB + PDO）
 * 本檔與專案根目錄的 05-App.js 內容相同，是同一份教材檔案。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Button,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
// ⬆️ 注意：RN 0.80 起 react-native 內建的 SafeAreaView 已標記淘汰，
//    官方指定改用 react-native-safe-area-context。
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
// ⬆️ Android 15（API 35）起強制 edge-to-edge，
//    react-native 的 StatusBar backgroundColor / translucent 已失效，改用 expo-status-bar。
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ==========================================
// 0. 連線設定中心（APK 版關鍵改寫）
// ------------------------------------------
// 把 IP 寫死在常數裡，一旦編譯成 APK 就無法更改，
// 換個教室 / 換條 Wi-Fi 整包 App 就報廢。
// 這裡改成「預設值 + 可在登入頁修改 + AsyncStorage 永久保存」。
// ==========================================
const DEFAULT_API_URL = 'http://192.168.8.88/api.php'; // ⚠️ 請依實際內網環境調整 IP
const API_URL_STORAGE_KEY = '@mobile_shop/api_url';
const REQUEST_TIMEOUT_MS = 10000;

let API_URL = DEFAULT_API_URL;

export function getApiUrl() {
  return API_URL;
}

export async function setApiUrl(url) {
  API_URL = (url || '').trim().replace(/\/+$/, '') || DEFAULT_API_URL;
  try {
    await AsyncStorage.setItem(API_URL_STORAGE_KEY, API_URL);
  } catch {
    // 儲存失敗不影響本次執行，僅是下次開啟需重設
    // （ES2019 起 catch 可省略參數，不用再宣告用不到的 e）
  }
}

async function restoreApiUrl() {
  try {
    const saved = await AsyncStorage.getItem(API_URL_STORAGE_KEY);
    if (saved) API_URL = saved;
  } catch {
    /* 使用預設值 */
  }
  return API_URL;
}

// ==========================================
// 0-0. 登入權杖
// ------------------------------------------
// 舊版每支 API 都把 user_id 當參數送出去，改個數字就能操作別人的資料。
// 現在登入成功時後端會發一張 HMAC 簽章的權杖，之後所有請求帶著它，
// 身分由後端自己從權杖解出來，前端送的 user_id 一律被忽略。
//
// 刻意不存進 AsyncStorage：權杖等同帳號密碼，落地就多一個外洩面。
// 目前 currentUserId 本來也只活在記憶體裡，關掉 App 就要重新登入，行為一致。
// ==========================================
let AUTH_TOKEN = null;

export function setAuthToken(token) {
  AUTH_TOKEN = token || null;
}

export function getAuthToken() {
  return AUTH_TOKEN;
}

/**
 * 主動登出：告訴後端把這張權杖寫進 Revoked_Tokens 黑名單。
 *
 * 只清掉前端的變數是不夠的 —— 權杖是 HMAC 簽章、無狀態的，
 * 沒通知後端的話那張在 7 天有效期內仍然驗得過（被側錄就等於沒登出）。
 *
 * 刻意不 await、也不用 apiRequest：
 *   · apiRequest 會附掛 AUTH_TOKEN，但這裡剛把它清掉了
 *   · 登出失敗不該卡住畫面，本機狀態已經清乾淨了
 */
export function revokeAuthToken() {
  const token = AUTH_TOKEN;
  AUTH_TOKEN = null;
  if (!token) return;
  fetch(`${getApiUrl()}/users?action=logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Auth-Token': token },
  }).catch(() => {
    /* 網路失敗也無妨：這張權杖最多 7 天後自然過期 */
  });
}

// 權杖過期時（HTTP 401）由 Router 註冊的回呼把畫面踢回登入頁，
// 否則每個畫面都要自己判斷「這個錯誤是不是該登出」。
let onUnauthorized = null;

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

// ==========================================
// 0-1. 統一 API 請求層
// ------------------------------------------
// 集中處理：逾時中斷、外部取消、非 JSON 回應、HTTP 錯誤碼、連線失敗訊息中文化。
// 每個畫面都用同一顆 AbortController 生態系，卸載時整批取消。
// ==========================================

async function apiRequest(path, { method = 'GET', body, signal: externalSignal } = {}) {
  // 合成一顆 signal：畫面卸載（externalSignal）或逾時，任一發生就中斷 fetch。
  // 不使用 AbortSignal.timeout() / AbortSignal.any()，因為 Hermes 尚未提供這兩個靜態方法。
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) forwardAbort();
    else externalSignal.addEventListener('abort', forwardAbort);
  }
  const signal = controller.signal;

  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (AUTH_TOKEN) {
    headers.Authorization = `Bearer ${AUTH_TOKEN}`;
    // Apache 在部分設定下會把 Authorization 標頭吃掉，補一個不會被過濾的備援
    headers['X-Auth-Token'] = AUTH_TOKEN;
  }

  try {
    const response = await fetch(`${getApiUrl()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    const rawText = await response.text();
    let data = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(
          `伺服器回傳非 JSON 內容（HTTP ${response.status}），請檢查 api.php 是否有 PHP 錯誤訊息`
        );
      }
    }

    // 401 = 權杖過期或無效；ACCOUNT_SUSPENDED（403）= 帳號被管理員停用。
    // 兩者都代表「這個登入階段已經不能用了」，一律清掉權杖並踢回登入頁。
    // 用後端給的 code 判斷而不是比對中文訊息 —— 訊息改字前端就不會壞。
    if (response.status === 401 || data?.code === 'ACCOUNT_SUSPENDED') {
      setAuthToken(null);
      onUnauthorized?.();
      throw new Error(data?.message || '登入已過期，請重新登入');
    }

    if (!response.ok) {
      throw new Error(data?.message || data?.error || `伺服器錯誤 HTTP ${response.status}`);
    }
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') {
      if (timedOut) throw new Error('連線逾時，請確認手機與伺服器位於同一個內網');
      throw e; // 畫面已卸載造成的取消，交給呼叫端用 isAbort() 忽略
    }
    if (String(e?.message).includes('Network request failed')) {
      throw new Error(
        `無法連線至 ${getApiUrl()}\n請確認：\n` +
          `1. IP 位址正確\n` +
          `2. 手機與電腦在同一個 Wi-Fi\n` +
          `3. 伺服器防火牆已開放 80 埠\n` +
          `4. 若後端是 https 憑證不合法，請改用 http`
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}

/** 呼叫端用來判斷「這個錯誤只是畫面卸載造成的取消」，不必彈窗。 */
const isAbort = (e) => e?.name === 'AbortError';

/** 陣列型回應的保險絲：後端若回傳非陣列（例如錯誤物件），避免 FlatList 直接崩潰 */
function asArray(data) {
  return Array.isArray(data) ? data : [];
}

/**
 * 金額顯示：千分位加逗號。
 *
 * 刻意不用 toLocaleString —— Hermes 的 Intl 支援視建置設定而定，
 * 在部分 Android 裝置上會退化成不分組，畫面就會跟網頁版不一致。
 * 這裡的字串處理沒有環境差異，與 index.html / backoffice.js / ops.js 的 money() 同行為。
 *
 * 整數不補小數（$1,234），有小數才顯示兩位（$1,234.50）。
 */
function money(n) {
  const v = Number(n || 0);
  const safe = Number.isFinite(v) ? v : 0;
  const s = Math.abs(safe).toFixed(Number.isInteger(safe) ? 0 : 2);
  const dot = s.indexOf('.');
  const whole = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? '' : s.slice(dot);
  // \B 確保逗號不會插在最前面（1000 → 1,000 而不是 ,1,000）
  return (safe < 0 ? '-$' : '$') + whole.replace(/\B(?=(\d{3})+$)/g, ',') + frac;
}

// ==========================================
// 0-2. 共用元件
// ------------------------------------------
// TouchableOpacity 是舊世代 API，RN 官方現在推薦 Pressable
// （支援 hover / pressed / focused 多狀態，也是 New Architecture 的一等公民）。
// ==========================================
function TextLink({ children, onPress, disabled, style }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [pressed && styles.pressed, disabled && styles.disabled]}
      accessibilityRole="link"
    >
      <Text style={style}>{children}</Text>
    </Pressable>
  );
}

// ==========================================
// 1. 會員登入註冊模組 (Users)
// ==========================================
export function LoginScreen({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [busy, setBusy] = useState(false);

  // APK 版新增：連線設定面板
  const [showSettings, setShowSettings] = useState(false);
  const [apiUrl, setApiUrlState] = useState(getApiUrl());
  const [apiUrlDraft, setApiUrlDraft] = useState(getApiUrl());

  const saveApiUrl = async () => {
    await setApiUrl(apiUrlDraft);
    setApiUrlState(getApiUrl());
    setApiUrlDraft(getApiUrl());
    setShowSettings(false);
    Alert.alert('已儲存', `API 位址已設定為\n${getApiUrl()}`);
  };

  const handleAuth = async () => {
    if (!email || !password || (isRegister && !fullName)) {
      Alert.alert('提示', '請填寫完整表單');
      return;
    }
    setBusy(true);
    try {
      if (isRegister) {
        await apiRequest('/users', {
          method: 'POST',
          body: { email, password, full_name: fullName },
        });
        Alert.alert('通知', '註冊成功，請前往登入');
        setIsRegister(false);
        setPassword('');
      } else {
        const data = await apiRequest('/users?action=login', {
          method: 'POST',
          body: { action: 'login', email, password },
        });
        if (!data?.user_id) {
          throw new Error('登入回應缺少 user_id，請確認後端已加入 login 分支');
        }
        if (!data?.token) {
          throw new Error('登入回應缺少 token，請確認伺服器上的 api.php 是最新版');
        }
        // 先設權杖再換頁：下一個畫面一掛載就會發請求，晚一步會整批 401
        setAuthToken(data.token);
        onLoginSuccess(data.user_id);
      }
    } catch (e) {
      if (!isAbort(e)) Alert.alert(isRegister ? '註冊失敗' : '登入失敗', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.loginBody}>
        <Text style={styles.title}>{isRegister ? '新會員註冊' : '會員登入'}</Text>

        {isRegister && (
          <TextInput
            style={styles.input}
            placeholder="姓名"
            placeholderTextColor="#9aa5ac"
            value={fullName}
            onChangeText={setFullName}
            textContentType="name"
            autoComplete="name"
          />
        )}
        <TextInput
          style={styles.input}
          placeholder="信箱"
          placeholderTextColor="#9aa5ac"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
          inputMode="email"
        />
        <TextInput
          style={styles.input}
          placeholder="密碼"
          placeholderTextColor="#9aa5ac"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          onSubmitEditing={handleAuth}
        />

        {busy ? (
          <ActivityIndicator size="large" color="#3498db" />
        ) : (
          <Button title={isRegister ? '送出註冊' : '登入'} onPress={handleAuth} />
        )}

        <TextLink
          style={styles.linkText}
          onPress={() => setIsRegister((v) => !v)}
          disabled={busy}
        >
          {isRegister ? '返回登入' : '建立新帳號'}
        </TextLink>

        <View style={styles.divider} />

        <TextLink style={styles.settingsToggle} onPress={() => setShowSettings((v) => !v)}>
          {`⚙️ 連線設定（目前：${apiUrl}）`}
        </TextLink>

        {showSettings && (
          <View style={styles.settingsBox}>
            <Text style={styles.settingsHint}>
              APK 安裝後可在此直接更改後端位址，不必重新編譯。
            </Text>
            <TextInput
              style={styles.input}
              placeholder="http://192.168.x.x/api.php"
              placeholderTextColor="#9aa5ac"
              value={apiUrlDraft}
              onChangeText={setApiUrlDraft}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputMode="url"
            />
            <Button title="儲存連線設定" onPress={saveApiUrl} color="#34495e" />
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ==========================================
// 1-1. 登入後主選單（功能中樞）
// ------------------------------------------
// 原版登入成功直接跳商品列表，訂單、客服這些「平行功能」只能從商品頁角落的小按鈕進入，
// 使用者不容易發現，返回鍵的語意也很混亂（子頁該退回哪裡？）。
// 改成中央主選單後：登入 → HOME → 各功能，返回鍵一律「退回上一頁」即可。
// ==========================================

// 選單設定表：要加功能只要往這個陣列補一筆，不必動 JSX
const MENU_ITEMS = [
  { key: 'PRODUCT_LIST', icon: '🛍️', title: '商品瀏覽', desc: '無限滾動分頁商品清單', color: '#3498db' },
  { key: 'PRODUCT_DETAIL', icon: '🔍', title: '商品詳情', desc: '看評價、寫評價、加入購物車', color: '#16a085', needsProduct: true },
  { key: 'CART', icon: '🛒', title: '我的購物車', desc: '改數量、刪明細、行動支付結帳', color: '#2ecc71' },
  { key: 'ORDER_LIST', icon: '📋', title: '訂單查詢', desc: '歷史訂單與消費明細', color: '#e67e22' },
  { key: 'CHAT', icon: '💬', title: '即時客服', desc: '專人線上對話', color: '#9b59b6' },
];

export function HomeScreen({ userId, selectedProduct, onNavigate, onLogout }) {
  return (
    <View style={styles.screen}>
      <View style={styles.homeHeader}>
        <Text style={styles.title}>行動商城</Text>
        <Text style={styles.homeSubtitle}>{`會員編號 #${userId ?? '-'}`}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.menuGrid} showsVerticalScrollIndicator={false}>
        {MENU_ITEMS.map((item) => {
          // 商品詳情頁需要一個 product 物件才能渲染，還沒挑過商品就先鎖住並說明原因，
          // 比讓使用者點進去看到空白畫面好。
          const locked = item.needsProduct && !selectedProduct;
          return (
            <Pressable
              key={item.key}
              onPress={() => onNavigate(item.key)}
              disabled={locked}
              accessibilityRole="button"
              accessibilityLabel={item.title}
              style={({ pressed }) => [
                styles.menuCard,
                { borderLeftColor: item.color },
                pressed && styles.pressed,
                locked && styles.disabled,
              ]}
            >
              <Text style={styles.menuIcon}>{item.icon}</Text>
              <View style={styles.menuTextBox}>
                <Text style={styles.menuTitle}>{item.title}</Text>
                <Text style={styles.menuDesc} numberOfLines={2}>
                  {locked
                    ? '請先從「商品瀏覽」挑選一件商品'
                    : item.needsProduct
                      ? `最近瀏覽：${selectedProduct.name}`
                      : item.desc}
                </Text>
              </View>
              <Text style={styles.menuArrow}>›</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <Button title="登出" onPress={onLogout} color="#e74c3c" />
    </View>
  );
}

// ==========================================
// 2. 🔥 核心亮點：無限滾動加載商品首頁 (Products & Categories)
// ==========================================
const PAGE_SIZE = 20; // 需與 api.php 的 $limit 一致

export function ProductListScreen({ onSelectProduct, onViewCart, onViewChat, onBack }) {
  const [products, setProducts] = useState([]); // 累加的商品總大陣列
  const [categories, setCategories] = useState([]); // 分類資料
  const [page, setPage] = useState(1); // 當前 MariaDB 的分頁頁碼
  const [loadingMore, setLoadingMore] = useState(false); // 是否正在 AJAX 加載中
  const [isRefreshing, setIsRefreshing] = useState(false); // 下拉刷新狀態機
  const [hasMoreData, setHasMoreData] = useState(true); // 資料庫是否還有剩餘存貨
  const [errorMsg, setErrorMsg] = useState(null);

  // 🛡️ 用 ref 當作真實鎖：直接讀 state 的話，在同一次 render 的閉包裡永遠是舊值，
  //    快速滑動時會同時發射多次 AJAX，造成同一頁商品重複疊加。
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(true);
  // 🛡️ 取代舊版 isMountedRef：畫面卸載直接中止飛行中的請求，
  //    而不是讓請求跑完再丟棄結果（省電、省流量）。
  const abortRef = useRef(null);

  // AJAX 核心分頁請求處理
  const loadProductsPagination = useCallback(async (targetPage, isRefreshAction = false) => {
    if (loadingRef.current) return;
    if (!hasMoreRef.current && !isRefreshAction) return;

    loadingRef.current = true;
    setLoadingMore(true);
    try {
      // ⚡ 向 PHP 發送 ?page=X 請求，後端自動 LIMIT 20 OFFSET X 裁切
      const newProducts = asArray(
        await apiRequest(`/products?page=${targetPage}`, { signal: abortRef.current?.signal })
      );

      // 邊界條件：回傳少於 20 筆代表遠端資料庫已無資料，關閉無限滾動引擎
      if (newProducts.length < PAGE_SIZE) {
        hasMoreRef.current = false;
        setHasMoreData(false);
      }

      // 資料同步：下拉刷新則覆蓋，底部追加則去重後拼接。
      // 去重是必要的：MariaDB 分頁若沒有穩定排序，相鄰兩頁可能吐出同一筆商品，
      // 舊版用 `${product_id}-${index}` 當 key 只是把重複資料藏起來，畫面上仍會出現兩張一樣的卡片。
      setProducts((prev) => {
        if (isRefreshAction) return dedupeByProductId(newProducts);
        const seen = new Set(prev.map((p) => String(p.product_id)));
        return [...prev, ...newProducts.filter((p) => !seen.has(String(p.product_id)))];
      });
      setPage(targetPage);
      setErrorMsg(null);
    } catch (e) {
      if (!isAbort(e)) setErrorMsg(e.message);
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    apiRequest('/categories', { signal: controller.signal })
      .then((data) => setCategories(asArray(data)))
      .catch(() => {
        /* 分類載入失敗不阻斷主畫面 */
      });

    loadProductsPagination(1, true); // 載入第一頁

    // 🛡️ 畫面卸載即中止所有請求，杜絕 Android 實機上的 memory leak 與多餘流量
    return () => controller.abort();
  }, [loadProductsPagination]);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    hasMoreRef.current = true;
    setHasMoreData(true);
    loadProductsPagination(1, true);
  }, [loadProductsPagination]);

  // 滑到底部自動觸發：自動請求 page + 1
  const handleLoadMore = useCallback(() => {
    if (!loadingRef.current && hasMoreRef.current) {
      loadProductsPagination(page + 1, false);
    }
  }, [loadProductsPagination, page]);

  const renderItem = useCallback(
    ({ item }) => (
      <Pressable
        style={({ pressed }) => [styles.productCard, pressed && styles.pressed]}
        onPress={() => onSelectProduct(item)}
        accessibilityRole="button"
      >
        <Text style={styles.productName}>{item.name}</Text>
        {!!item.category_name && (
          <Text style={styles.productCategory}>{item.category_name}</Text>
        )}
        <View style={styles.productBottomRow}>
          <Text style={styles.productPrice}>{`${money(item.price)} TWD`}</Text>
          {/* 庫存直接標在卡片上，使用者不必點進去才發現已售完 */}
          {item.stock_quantity !== undefined && item.stock_quantity !== null && (
            <Text
              style={
                Number(item.stock_quantity) > 0 ? styles.productStock : styles.productSoldOut
              }
            >
              {Number(item.stock_quantity) > 0 ? `庫存 ${item.stock_quantity} 件` : '已售完'}
            </Text>
          )}
        </View>
      </Pressable>
    ),
    [onSelectProduct]
  );

  const renderFooter = () => {
    if (loadingMore) {
      return (
        <View style={styles.loadingFooter}>
          <ActivityIndicator size="small" color="#3498db" />
          <Text style={styles.loadingFooterText}>
            {` 正在從 MariaDB 讀取下一頁 ${PAGE_SIZE} 筆商品...`}
          </Text>
        </View>
      );
    }
    if (!hasMoreData && products.length > 0) {
      return (
        <View style={styles.loadingFooter}>
          <Text style={styles.loadingFooterText}>{`— 已載入全部 ${products.length} 筆商品 —`}</Text>
        </View>
      );
    }
    return null;
  };

  const renderEmpty = () => {
    if (loadingMore) return null;
    return (
      <View style={styles.emptyBox}>
        <Text style={styles.emptyText}>
          {errorMsg ? `載入失敗\n\n${errorMsg}` : '目前沒有商品資料，可下拉重新整理'}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.navRow}>
        <Button title="← 主選單" onPress={onBack} color="#7f8c8d" />
        <Button title="購物車" onPress={onViewCart} color="#2ecc71" />
        <Button title="客服" onPress={onViewChat} color="#9b59b6" />
      </View>

      {categories.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.categoryRow}
          contentContainerStyle={styles.categoryRowContent}
        >
          {categories.map((c) => (
            <View key={String(c.category_id)} style={styles.categoryBadge}>
              <Text style={styles.categoryBadgeText}>{c.category_name}</Text>
            </View>
          ))}
        </ScrollView>
      )}

      <Text style={styles.sectionTitle}>商品清單 (無限滾動分頁版)</Text>

      <FlatList
        data={products}
        keyExtractor={(item) => String(item.product_id)}
        renderItem={renderItem}
        // 💡 無限滾動三劍客核心屬性
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5} // 距離底部剩一半高度時，提早背景發射 AJAX
        ListFooterComponent={renderFooter}
        ListEmptyComponent={renderEmpty}
        // RefreshControl 明寫，才能同時控制轉圈顏色（Android 預設是黑色，在淺色背景很醜）
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            colors={['#3498db']}
            tintColor="#3498db"
          />
        }
        contentContainerStyle={products.length === 0 && styles.flexGrow}
        keyboardShouldPersistTaps="handled"
      />
    </View>
  );
}

function dedupeByProductId(list) {
  const seen = new Set();
  return list.filter((p) => {
    const key = String(p.product_id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ==========================================
// 3. 商品詳情與評價發表模組 (Reviews)
// ==========================================
// userId 已不再需要：加入購物車與送出評價的身分都由權杖決定
export function ProductDetailScreen({ product, onBack }) {
  const [reviews, setReviews] = useState([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(null);

  const productId = product?.product_id;
  // 商品列表帶進來的庫存快照。沒有這個欄位時（例如舊版後端）不做售完判斷，
  // 讓後端的 409 庫存檢查當最後一道關卡。
  const soldOut =
    product?.stock_quantity !== undefined &&
    product?.stock_quantity !== null &&
    Number(product.stock_quantity) <= 0;

  const fetchReviews = useCallback(async () => {
    try {
      const data = await apiRequest(`/reviews?product_id=${productId}`, {
        signal: abortRef.current?.signal,
      });
      setReviews(asArray(data));
    } catch (e) {
      // 評價載入失敗不彈窗打斷瀏覽，保持商品資訊可讀
      if (!isAbort(e)) setReviews([]);
    }
  }, [productId]);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    fetchReviews();
    return () => controller.abort();
  }, [fetchReviews]);

  const addToCart = async () => {
    setBusy(true);
    try {
      await apiRequest('/cart', {
        method: 'POST',
        body: { product_id: productId, quantity: 1 },
      });
      Alert.alert('成功', '已加至購物車');
    } catch (e) {
      if (!isAbort(e)) Alert.alert('加入購物車失敗', e.message);
    } finally {
      setBusy(false);
    }
  };

  const submitReview = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await apiRequest('/reviews', {
        method: 'POST',
        body: { product_id: productId, rating: 5, comment },
      });
      setComment('');
      await fetchReviews(); // 局部無刷新渲染新評論
    } catch (e) {
      if (!isAbort(e)) Alert.alert('評價送出失敗', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView keyboardShouldPersistTaps="handled">
        <Button title="← 返回上一頁" onPress={onBack} />
        <Text style={styles.detailTitle}>{product?.name}</Text>
        <Text style={styles.detailDesc}>{product?.description}</Text>
        <Text style={styles.detailPrice}>{`${money(product?.price)} TWD`}</Text>
        {/* 售完時直接鎖住按鈕，比讓使用者按下去再收到 409 好 */}
        {soldOut ? (
          <Text style={styles.productSoldOut}>此商品目前已售完</Text>
        ) : (
          <Text style={styles.productStock}>{`庫存 ${product?.stock_quantity ?? '—'} 件`}</Text>
        )}
        <Button
          title={soldOut ? '已售完' : '加入購物車'}
          onPress={addToCart}
          color="#e67e22"
          disabled={busy || soldOut}
        />

        <View style={styles.divider} />

        <Text style={styles.sectionTitle}>商品評價流</Text>
        <TextInput
          style={styles.input}
          placeholder="寫下對本商品的看法..."
          placeholderTextColor="#9aa5ac"
          value={comment}
          onChangeText={setComment}
          multiline
        />
        <Button title="送出評價" onPress={submitReview} disabled={busy || !comment.trim()} />

        {reviews.length === 0 && (
          <Text style={styles.emptyInline}>尚無評價，成為第一位留言者</Text>
        )}
        {reviews.map((r) => (
          <View key={String(r.review_id)} style={styles.reviewCard}>
            <Text>{`${'⭐'.repeat(Number(r.rating) || 5)} ${r.full_name}: ${r.comment}`}</Text>
          </View>
        ))}

        <View style={styles.bottomSpacer} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ==========================================
// 4. 購物車與結帳事務模組 (Cart, Orders, Payments)
// ------------------------------------------
// 新增「明細修改」：每一筆可以 − / ＋ 調整數量，也可以單筆刪除。
// 採樂觀更新（Optimistic UI）：畫面先動、請求在背景送，
// 內網延遲 200~500ms 的情況下，使用者不會覺得每按一下都要等。
// ==========================================
// 支付方式選項。code 必須落在 api.php 的 PAYMENT_METHODS 白名單內，
// deferred = 結帳當下還沒真的收到錢（訂單留在待付款，等後台確認收款）。
const PAY_OPTIONS = [
  { code: 'App Pay', label: 'App 支付', icon: '📲', deferred: false },
  { code: 'Credit Card', label: '信用卡', icon: '💳', deferred: false },
  { code: 'Mobile Pay', label: '行動支付', icon: '📱', deferred: false },
  { code: 'ATM Transfer', label: 'ATM 轉帳', icon: '🏧', deferred: true },
  { code: 'COD', label: '貨到付款', icon: '📦', deferred: true },
];

const PAY_HINT = {
  'ATM Transfer': '訂單成立後請完成轉帳，款項入帳確認後才會轉為已付款。',
  COD: '商品送達時付款，客服收款後訂單才會轉為已付款。',
};

// userId 已不再需要：後端從權杖認人，購物車與訂單都只會操作到本人的資料
export function CartScreen({ onBack }) {
  const [cartItems, setCartItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingIds, setPendingIds] = useState(() => new Set()); // 哪幾筆明細正在送出
  const [payMethod, setPayMethod] = useState('App Pay');
  const abortRef = useRef(null);

  /** 標記／解除某一筆明細的「送出中」狀態，用來鎖住該列的按鈕防連點 */
  const markPending = useCallback((cartId, on) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(String(cartId));
      else next.delete(String(cartId));
      return next;
    });
  }, []);

  // silent = true 時不顯示整頁轉圈，供「操作失敗後靜默重新同步」使用
  const fetchCart = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await apiRequest('/cart', { signal: abortRef.current?.signal });
      setCartItems(asArray(data));
    } catch (e) {
      // 靜默模式是「操作失敗後的補救查詢」，呼叫端已經彈過一次窗了，這裡不再疊第二個
      if (!isAbort(e) && !silent) {
        Alert.alert('購物車讀取失敗', e.message);
        setCartItems([]);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    fetchCart();
    return () => controller.abort();
  }, [fetchCart]);

  // 🔧 明細修改 1／2：刪除單筆
  const removeItem = useCallback(
    async (item) => {
      const cartId = String(item.cart_id);
      markPending(cartId, true);
      setCartItems((list) => list.filter((i) => String(i.cart_id) !== cartId)); // 先從畫面移除
      try {
        await apiRequest(`/cart?cart_id=${item.cart_id}`, { method: 'DELETE' });
      } catch (e) {
        if (!isAbort(e)) {
          Alert.alert('刪除失敗', e.message);
          // 刪除失敗時不猜「原本排在第幾筆」，直接以伺服器為準重新同步
          await fetchCart(true);
        }
      } finally {
        markPending(cartId, false);
      }
    },
    [fetchCart, markPending]
  );

  const confirmRemove = useCallback(
    (item) => {
      Alert.alert('移除商品', `確定要把「${item.name}」從購物車移除嗎？`, [
        { text: '取消', style: 'cancel' },
        { text: '移除', style: 'destructive', onPress: () => removeItem(item) },
      ]);
    },
    [removeItem]
  );

  // 🔧 明細修改 2／2：數量增減
  const changeQuantity = useCallback(
    async (item, delta) => {
      const cartId = String(item.cart_id);
      if (pendingIds.has(cartId)) return; // 同一筆還在送出就別連點
      const nextQty = Number(item.quantity || 0) + delta;
      if (nextQty < 1) {
        confirmRemove(item); // 減到 0 等同移除，先問過使用者
        return;
      }

      const applyDelta = (d) =>
        setCartItems((list) =>
          list.map((i) =>
            String(i.cart_id) === cartId ? { ...i, quantity: Number(i.quantity || 0) + d } : i
          )
        );

      applyDelta(delta); // 樂觀更新：畫面先動
      markPending(cartId, true);
      try {
        // PUT 是「覆寫數量」，不是像 POST 那樣累加
        await apiRequest('/cart', {
          method: 'PUT',
          body: { cart_id: item.cart_id, quantity: nextQty },
        });
      } catch (e) {
        if (!isAbort(e)) {
          // 用「反向 delta」回滾，比記住整份陣列快照更耐得住連續點擊
          applyDelta(-delta);
          Alert.alert('數量更新失敗', e.message);
        }
      } finally {
        markPending(cartId, false);
      }
    },
    [confirmRemove, markPending, pendingIds]
  );

  // useMemo：購物車有幾十筆時，不必每次 re-render 都重算總價
  const total = useMemo(
    () => cartItems.reduce((sum, i) => sum + Number(i.price || 0) * Number(i.quantity || 0), 0),
    [cartItems]
  );
  const totalCount = useMemo(
    () => cartItems.reduce((sum, i) => sum + Number(i.quantity || 0), 0),
    [cartItems]
  );

  const renderItem = useCallback(
    ({ item }) => {
      const unitPrice = Number(item.price || 0);
      const qty = Number(item.quantity || 0);
      const pending = pendingIds.has(String(item.cart_id));

      return (
        <View style={styles.cartItem}>
          <View style={styles.cartItemTopRow}>
            <Text style={styles.cartItemName} numberOfLines={2}>{`📦 ${item.name}`}</Text>
            <Text style={styles.cartItemPrice}>{`${money(unitPrice * qty)} TWD`}</Text>
          </View>

          <View style={styles.cartItemBottomRow}>
            <Text style={styles.cartItemUnit}>{`單價 ${money(unitPrice)}`}</Text>

            <View style={styles.qtyBox}>
              <Pressable
                onPress={() => changeQuantity(item, -1)}
                disabled={pending}
                accessibilityRole="button"
                accessibilityLabel={`減少 ${item.name} 的數量`}
                style={({ pressed }) => [
                  styles.qtyBtn,
                  pressed && styles.pressed,
                  pending && styles.disabled,
                ]}
              >
                <Text style={styles.qtyBtnText}>−</Text>
              </Pressable>

              {pending ? (
                <ActivityIndicator size="small" color="#3498db" style={styles.qtyValue} />
              ) : (
                <Text style={styles.qtyValue}>{qty}</Text>
              )}

              <Pressable
                onPress={() => changeQuantity(item, 1)}
                disabled={pending}
                accessibilityRole="button"
                accessibilityLabel={`增加 ${item.name} 的數量`}
                style={({ pressed }) => [
                  styles.qtyBtn,
                  pressed && styles.pressed,
                  pending && styles.disabled,
                ]}
              >
                <Text style={styles.qtyBtnText}>＋</Text>
              </Pressable>
            </View>

            <TextLink
              style={styles.removeText}
              onPress={() => confirmRemove(item)}
              disabled={pending}
            >
              🗑 刪除
            </TextLink>
          </View>
        </View>
      );
    },
    [changeQuantity, confirmRemove, pendingIds]
  );

  const handleCheckout = async () => {
    setBusy(true);
    try {
      // 後端 Orders 為 ACID 事務：主檔 + 明細 + 扣庫存 + 清空購物車一次落盤。
      // 💰 不再送 items 與 total_amount —— 訂單內容與金額都由後端讀資料庫的購物車自行計算，
      //    前端只把自己算出來的 expected_total 送過去當「對帳用」：
      //    對不上代表結帳前商品調價了，後端會回 409 要求重新確認，而不是默默用新價格扣款。
      const orderData = await apiRequest('/orders', {
        method: 'POST',
        body: { expected_total: total },
      });

      if (!orderData?.order_id) {
        throw new Error('訂單建立回應缺少 order_id');
      }

      // 金額同樣不送，後端會直接讀該訂單的 total_amount
      const pay = await apiRequest('/payments', {
        method: 'POST',
        body: {
          order_id: orderData.order_id,
          payment_method: payMethod,
          transaction_id: `APP-${Date.now()}`,
        },
      });

      const paid = orderData.total_amount ?? total;
      // 即時扣款與延後付款的說法不同，訊息直接用後端回的 ——
      // 由後端統一決定比前端各自拼字串可靠。
      const settled = pay?.payment_status === 'success';
      Alert.alert(
        settled ? '結帳成功' : '訂單已成立',
        `訂單編號 #${orderData.order_id}\n金額 ${money(paid)} TWD\n\n${pay?.message || ''}`
      );
      setCartItems([]);
    } catch (e) {
      if (!isAbort(e)) {
        Alert.alert('結帳失敗', e.message);
        // 價格變動或庫存不足都會讓購物車的顯示過時，重抓一次讓使用者看到最新狀態
        await fetchCart(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <Button title="← 返回上一頁" onPress={onBack} />
      <Text style={styles.title}>我的購物車</Text>

      {loading ? (
        <ActivityIndicator size="large" color="#3498db" />
      ) : (
        <FlatList
          data={cartItems}
          keyExtractor={(item) => String(item.cart_id)}
          renderItem={renderItem}
          ListEmptyComponent={<Text style={styles.emptyInline}>購物車是空的</Text>}
          keyboardShouldPersistTaps="handled"
        />
      )}

      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>{`訂單總計（${totalCount} 件）`}</Text>
        <Text style={styles.totalValue}>{`${money(total)} TWD`}</Text>
      </View>

      {/* RN 沒有 <select>，用一排可點的膠囊代替：全部選項一眼可見，
          也不必為了下拉選單多裝一個套件。 */}
      <Text style={styles.payLabel}>支付方式</Text>
      <View style={styles.payRow}>
        {PAY_OPTIONS.map((opt) => {
          const active = opt.code === payMethod;
          return (
            <Pressable
              key={opt.code}
              onPress={() => setPayMethod(opt.code)}
              disabled={busy}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              style={({ pressed }) => [
                styles.payChip,
                active && styles.payChipActive,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.payChipText, active && styles.payChipTextActive]}>
                {`${opt.icon} ${opt.label}`}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {!!PAY_HINT[payMethod] && <Text style={styles.payHint}>{PAY_HINT[payMethod]}</Text>}

      <Button
        title={busy ? '結帳處理中...' : '確認成立訂單並結帳'}
        onPress={handleCheckout}
        color="#2ecc71"
        disabled={busy || cartItems.length === 0}
      />
    </View>
  );
}

// ==========================================
// 4-1. 訂單查詢模組 (Orders 歷史查詢)
// ------------------------------------------
// 結帳後訂單就進了資料庫，原版卻沒有任何地方看得到，
// 使用者無從確認「我到底買了什麼、付了多少」。
// 這裡做成「列表 + 點擊展開明細」，明細採 lazy load：
// 一次列 30 張訂單也不會一開頁就打 30 個請求。
// ==========================================
// 訂單狀態只表示出貨進度；付款狀況看 PAY_STATUS_LABEL（兩者互不干涉）。
// pending / paid 是舊制留下的值，只會出現在歷史訂單。
const ORDER_STATUS_LABEL = {
  awaiting_shipment: '待出貨',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
  pending: '待付款(舊)',
  paid: '已付款(舊)',
};
const PAY_METHOD_LABEL = {
  'App Pay': 'App 支付',
  'Credit Card': '信用卡',
  'Mobile Pay': '行動支付',
  'ATM Transfer': 'ATM 轉帳',
  COD: '貨到付款',
};
const PAY_STATUS_LABEL = { success: '✅ 已收款', pending: '⏳ 待收款', cancelled: '✖ 已取消' };
const PAY_STATUS_COLOR = { success: '#27ae60', pending: '#e67e22', cancelled: '#95a5a6' };

const ORDER_STATUS_COLOR = {
  awaiting_shipment: '#8e44ad',
  shipped: '#3498db',
  completed: '#27ae60',
  cancelled: '#e74c3c',
  pending: '#f39c12',
  paid: '#2ecc71',
};

/**
 * 明細來自 api.php 的 `order-items` 端點（回傳陣列），
 * 但也相容包成 `{ items: [...] }` 的寫法，換後端不必動這裡。
 */
function pickOrderItems(data) {
  return Array.isArray(data) ? data : asArray(data?.items);
}

/**
 * 訂單明細的單價欄位在 Order_Items 表叫 `price_at_purchase`（下單當時的價格快照，
 * 不是 Products 的現價），舊寫法可能只給 `price`，兩者都吃。
 */
function orderItemUnitPrice(item) {
  return Number(item?.price_at_purchase ?? item?.price ?? 0);
}

/** MariaDB DATETIME（'2026-08-14 13:05:22'）或 ISO 字串 → 'YYYY-MM-DD HH:mm' */
function formatOrderTime(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').slice(0, 16);
}

// userId 已不再需要：後端只會回傳權杖持有者自己的訂單
export function OrderListScreen({ onBack }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [expandedId, setExpandedId] = useState(null); // 目前展開的訂單（一次只展開一張）
  const [detailMap, setDetailMap] = useState({}); // { [order_id]: { loading, items, error } }
  const abortRef = useRef(null);

  const fetchOrders = useCallback(async () => {
    try {
      const data = await apiRequest('/orders', { signal: abortRef.current?.signal });
      setOrders(asArray(data));
      setErrorMsg(null);
    } catch (e) {
      if (!isAbort(e)) {
        setErrorMsg(e.message);
        setOrders([]);
      }
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    fetchOrders();
    return () => controller.abort();
  }, [fetchOrders]);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    setDetailMap({}); // 明細快取一併作廢，避免刷新後看到舊明細
    setExpandedId(null);
    fetchOrders();
  }, [fetchOrders]);

  // 展開才去撈明細；已抓過的留在 detailMap 當快取，收合再展開不重打
  const toggleOrder = useCallback(
    async (order) => {
      const id = String(order.order_id);
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      if (detailMap[id]?.detail) return;

      setDetailMap((m) => ({ ...m, [id]: { loading: true } }));
      try {
        // 一次拿齊主檔 + 明細 + 付款紀錄。
        // （早期版本要分別打 /order-items 才拿得到明細，付款資訊則完全拿不到。）
        // 後端會用權杖確認這張訂單是本人的，非本人回 404。
        const data = await apiRequest(`/orders?order_id=${order.order_id}`, {
          signal: abortRef.current?.signal,
        });
        setDetailMap((m) => ({ ...m, [id]: { loading: false, detail: data } }));
      } catch (e) {
        if (!isAbort(e)) {
          setDetailMap((m) => ({ ...m, [id]: { loading: false, error: e.message } }));
        }
      }
    },
    [detailMap, expandedId]
  );

  // 累計消費統計：跟購物車總價同理，用 useMemo 避免每次 re-render 重跑 reduce
  const summary = useMemo(
    () => ({
      count: orders.length,
      amount: orders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0),
    }),
    [orders]
  );

  const renderOrder = useCallback(
    ({ item }) => {
      const id = String(item.order_id);
      const expanded = expandedId === id;
      const detail = detailMap[id];
      const statusKey = String(item.status || '').toLowerCase();

      return (
        <View style={styles.orderCard}>
          <Pressable
            onPress={() => toggleOrder(item)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            style={({ pressed }) => [styles.orderHeader, pressed && styles.pressed]}
          >
            <View style={styles.orderHeaderLeft}>
              <Text style={styles.orderNo}>{`訂單 #${item.order_id}`}</Text>
              <Text style={styles.orderDate}>
                {formatOrderTime(item.order_date || item.created_at) || '（無日期資料）'}
              </Text>
            </View>

            <View style={styles.orderHeaderRight}>
              <Text style={styles.orderAmount}>{`${money(item.total_amount)} TWD`}</Text>
              {!!statusKey && (
                <Text
                  style={[
                    styles.orderStatus,
                    { backgroundColor: ORDER_STATUS_COLOR[statusKey] || '#7f8c8d' },
                  ]}
                >
                  {ORDER_STATUS_LABEL[statusKey] || item.status}
                </Text>
              )}
            </View>

            <Text style={styles.orderChevron}>{expanded ? '▾' : '▸'}</Text>
          </Pressable>

          {expanded && (
            <View style={styles.orderDetailBox}>
              {detail?.loading && <ActivityIndicator size="small" color="#3498db" />}
              {!!detail?.error && (
                <Text style={styles.orderDetailError}>{`明細載入失敗：${detail.error}`}</Text>
              )}

              {!!detail?.detail && (() => {
                const d = detail.detail;
                const items = pickOrderItems(d);
                const pay = d.payment;
                const payKey = String(pay?.status || '').toLowerCase();
                return (
                  <>
                    <Text style={styles.orderSectionTitle}>商品明細</Text>
                    {items.length === 0 && (
                      <Text style={styles.emptyInline}>這張訂單沒有明細資料</Text>
                    )}
                    {items.map((it, idx) => (
                      // Order_Items 的主鍵在 MariaDB.sql 叫 item_id；相容 order_item_id 命名，
                      // 兩者都沒有就退而用 product_id，全缺才用 index 當最後保險
                      <View
                        key={String(it.item_id ?? it.order_item_id ?? it.product_id ?? idx)}
                        style={styles.orderDetailRow}
                      >
                        <Text style={styles.orderDetailName} numberOfLines={1}>
                          {`${it.name ?? it.product_name ?? `商品 #${it.product_id}`} x ${it.quantity}`}
                        </Text>
                        <Text style={styles.orderDetailPrice}>
                          {`${money(orderItemUnitPrice(it) * Number(it.quantity || 0))}`}
                        </Text>
                      </View>
                    ))}

                    <Text style={styles.orderSectionTitle}>付款資訊</Text>
                    {pay ? (
                      <>
                        <View style={styles.orderDetailRow}>
                          <Text style={styles.orderDetailName}>支付方式</Text>
                          <Text style={styles.orderDetailPrice}>
                            {PAY_METHOD_LABEL[pay.payment_method] || pay.payment_method}
                          </Text>
                        </View>
                        <View style={styles.orderDetailRow}>
                          <Text style={styles.orderDetailName}>付款狀態</Text>
                          <Text
                            style={[
                              styles.payStatus,
                              { color: PAY_STATUS_COLOR[payKey] || '#7f8c8d' },
                            ]}
                          >
                            {PAY_STATUS_LABEL[payKey] || pay.status}
                          </Text>
                        </View>
                        <View style={styles.orderDetailRow}>
                          <Text style={styles.orderDetailName}>收款時間</Text>
                          {/* 未入帳的付款沒有 paid_at，不要顯示假時間 */}
                          <Text style={styles.orderDetailPrice}>
                            {formatOrderTime(pay.paid_at) || '—'}
                          </Text>
                        </View>
                        {payKey === 'pending' && !!PAY_HINT[pay.payment_method] && (
                          <Text style={styles.payPendingNote}>
                            {PAY_HINT[pay.payment_method]}
                          </Text>
                        )}
                      </>
                    ) : (
                      <Text style={styles.emptyInline}>尚無付款紀錄</Text>
                    )}
                  </>
                );
              })()}
            </View>
          )}
        </View>
      );
    },
    [detailMap, expandedId, toggleOrder]
  );

  return (
    <View style={styles.screen}>
      <Button title="← 返回上一頁" onPress={onBack} />
      <Text style={styles.title}>訂單查詢</Text>

      <View style={styles.orderSummary}>
        <Text style={styles.orderSummaryText}>{`共 ${summary.count} 張訂單`}</Text>
        <Text style={styles.orderSummaryAmount}>{`累計消費 ${money(summary.amount)} TWD`}</Text>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#3498db" />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => String(item.order_id)}
          renderItem={renderOrder}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              colors={['#3498db']}
              tintColor="#3498db"
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>
                {errorMsg ? `載入失敗\n\n${errorMsg}` : '還沒有任何訂單，快去挑幾件商品吧'}
              </Text>
            </View>
          }
          contentContainerStyle={orders.length === 0 && styles.flexGrow}
        />
      )}
    </View>
  );
}

// ==========================================
// 5. 線上客服即時對話模組 (Chat_Rooms, Messages)
// ------------------------------------------
// 舊版寫死 CHAT_ROOM_ID = 1，所有人擠在同一間房 —— 等於每位客戶都看得到
// 別人跟客服講了什麼。改成「每位客戶有自己的房，由 manager 認領回覆」：
//   進入畫面 → POST /chat-rooms → 後端找出自己 open 的房，沒有才開新的
//   之後所有訊息都綁在那個 room_id，後端每次都會驗你是不是這間房的成員。
// ==========================================
const CHAT_POLL_MS = 2000;

export function ChatScreen({ userId, onBack }) {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [roomId, setRoomId] = useState(null); // 開房完成前為 null
  const [roomError, setRoomError] = useState(null);

  const listRef = useRef(null);
  const abortRef = useRef(null);
  const inFlightRef = useRef(false); // 避免網路慢時輪詢請求互相堆疊

  const fetchMessages = useCallback(async (targetRoomId) => {
    if (!targetRoomId || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const data = asArray(
        await apiRequest(`/messages?room_id=${targetRoomId}`, { signal: abortRef.current?.signal })
      );
      setMessages(data);
    } catch {
      // 輪詢失敗保持靜默，避免每 2 秒彈一次警告視窗
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    let timer = null;
    let cancelled = false;

    // ⚡ AJAX 短輪詢：改用「遞迴 setTimeout」而非 setInterval。
    //    setInterval 在網路變慢時會不斷把請求排進佇列，堆成雪崩；
    //    遞迴 setTimeout 保證「上一輪跑完才排下一輪」。
    const start = async () => {
      let id = null;
      try {
        // 取得（或建立）屬於自己的客服房。後端保證同一位客戶只會有一間 open 的房。
        const room = await apiRequest('/chat-rooms', {
          method: 'POST',
          signal: controller.signal,
        });
        id = room?.room_id;
        if (!id) throw new Error('伺服器沒有回傳 room_id');
      } catch (e) {
        if (!isAbort(e) && !cancelled) setRoomError(e.message);
        return; // 開房失敗就不要開始輪詢，否則每 2 秒噴一次同樣的錯
      }
      if (cancelled) return;
      setRoomId(id);
      setRoomError(null);

      const tick = async () => {
        await fetchMessages(id);
        if (!controller.signal.aborted) timer = setTimeout(tick, CHAT_POLL_MS);
      };
      tick();
    };
    start();

    // 🛡️ 內存釋放：離開客服頁面時中止請求並清除定時器，徹底杜絕發燙與記憶體洩漏
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [fetchMessages]);

  const handleSendMessage = async () => {
    const text = inputText.trim();
    if (!text || !roomId) return;
    setInputText('');
    try {
      // sender_id 不再由前端指定，後端從權杖取，避免冒名發言
      await apiRequest('/messages', {
        method: 'POST',
        body: { room_id: roomId, message_text: text },
      });
      await fetchMessages(roomId);
    } catch (e) {
      if (!isAbort(e)) {
        setInputText(text); // 送出失敗把內容還給使用者，不要吃掉他打的字
        Alert.alert('訊息傳送失敗', e.message);
      }
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Button title="← 關閉客服" onPress={onBack} color="#7f8c8d" />
      <Text style={styles.title}>專人即時線上客服</Text>
      {!!roomId && (
        <Text style={styles.chatRoomHint}>{`對話編號 #${roomId} — 僅你與客服人員看得到`}</Text>
      )}

      {roomError ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>{`無法連上客服\n\n${roomError}`}</Text>
        </View>
      ) : !roomId ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#3498db" />
          <Text style={styles.loadingFooterText}>正在為你接通客服...</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => String(item.message_id)}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          renderItem={({ item }) => (
            <View
              style={
                String(item.sender_id) === String(userId) ? styles.myMessage : styles.otherMessage
              }
            >
              <Text style={styles.messageSender}>
                {/* 後端會一併回 sender_role，客服訊息掛個徽章讓客戶知道是誰在回 */}
                {item.sender_role && item.sender_role !== 'customer'
                  ? `🎧 ${item.sender_name}（客服）`
                  : item.sender_name}
              </Text>
              <Text>{item.message_text}</Text>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyInline}>留言給客服，專人會盡快回覆</Text>
          }
          keyboardShouldPersistTaps="handled"
        />
      )}

      <View style={styles.chatInputRow}>
        <TextInput
          style={[styles.input, styles.chatInput]}
          placeholder="請輸入訊息..."
          placeholderTextColor="#9aa5ac"
          value={inputText}
          onChangeText={setInputText}
          onSubmitEditing={handleSendMessage}
          editable={!!roomId}
          // RN 0.83 起 blurOnSubmit 改名為 submitBehavior；'submit' = 送出後不收鍵盤
          submitBehavior="submit"
        />
        <Button title="發送" onPress={handleSendMessage} disabled={!roomId} />
      </View>
    </KeyboardAvoidingView>
  );
}

// ==========================================
// 🎛️ App 核心總路由中心
// ==========================================
function Router() {
  // 加了主選單之後，畫面關係從「單層」變成「HOME → 各功能 → 更深層（商品詳情）」，
  // 再用單一字串記位置就會出現「這頁該退回哪裡？」的歧義
  // （購物車可能是從 HOME 進來、也可能是從商品列表進來）。
  // 改成最小的歷史堆疊：navigate() push、goBack() pop，語意自然就對了。
  const [history, setHistory] = useState(['LOGIN']);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [ready, setReady] = useState(false); // 等待 AsyncStorage 讀回 API 位址

  const currentScreen = history[history.length - 1];

  const navigate = useCallback((screen) => {
    // 已經在同一頁就不重複 push，避免連點兩下要按兩次返回才離開
    setHistory((h) => (h[h.length - 1] === screen ? h : [...h, screen]));
  }, []);

  const goBack = useCallback(() => {
    setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));
  }, []);

  /** 清空堆疊並落在指定畫面（登入成功／登出用，避免返回鍵退回已失效的頁面） */
  const resetTo = useCallback((screen) => setHistory([screen]), []);

  useEffect(() => {
    restoreApiUrl().finally(() => setReady(true));
  }, []);

  const handleLoginSuccess = useCallback(
    (id) => {
      setCurrentUserId(id);
      resetTo('HOME');
    },
    [resetTo]
  );

  /** 只清本機狀態 —— 用於「權杖已經無效」的情況（過期、帳號被停用） */
  const clearSession = useCallback(() => {
    setAuthToken(null);
    setCurrentUserId(null);
    setSelectedProduct(null); // 一併清掉，避免下一位使用者看到上一位的瀏覽紀錄
    resetTo('LOGIN');
  }, [resetTo]);

  /** 使用者主動登出：先請後端把權杖列入黑名單，再清本機 */
  const handleLogout = useCallback(() => {
    revokeAuthToken();
    clearSession();
  }, [clearSession]);

  // 權杖過期或帳號被停用時（任一請求收到 401 / ACCOUNT_SUSPENDED）自動踢回登入頁。
  // 這裡用 clearSession 而不是 handleLogout —— 那張權杖本來就已經無效了，
  // 再打一次登出 API 只是白費一個請求。
  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  const confirmLogout = useCallback(() => {
    Alert.alert('確認登出', '要離開商城並返回登入頁嗎？', [
      { text: '取消', style: 'cancel' },
      { text: '登出', style: 'destructive', onPress: handleLogout },
    ]);
  }, [handleLogout]);

  // 🤖 Android 實體返回鍵：不做處理的話，任何頁面按下都會直接關閉 App
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;

    const onBackPress = () => {
      if (currentScreen === 'LOGIN') return false; // 登入頁交還系統 → 離開 App
      if (currentScreen === 'HOME') {
        confirmLogout(); // 主選單是登入後的根畫面，再退就是離開商城
        return true;
      }
      goBack(); // 其餘畫面一律退回堆疊上一層
      return true;
    };

    // RN 0.73 起 BackHandler.removeEventListener 已移除，
    // 必須改用 addEventListener 回傳的 subscription.remove()。
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  }, [confirmLogout, currentScreen, goBack]);

  const handleSelectProduct = useCallback(
    (p) => {
      setSelectedProduct(p);
      navigate('PRODUCT_DETAIL');
    },
    [navigate]
  );

  if (!ready) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#3498db" />
      </View>
    );
  }

  switch (currentScreen) {
    case 'HOME':
      return (
        <HomeScreen
          userId={currentUserId}
          selectedProduct={selectedProduct}
          onNavigate={navigate}
          onLogout={confirmLogout}
        />
      );
    case 'PRODUCT_LIST':
      return (
        <ProductListScreen
          onSelectProduct={handleSelectProduct}
          onViewCart={() => navigate('CART')}
          onViewChat={() => navigate('CHAT')}
          onBack={goBack}
        />
      );
    case 'PRODUCT_DETAIL':
      return <ProductDetailScreen product={selectedProduct} onBack={goBack} />;
    case 'CART':
      return <CartScreen onBack={goBack} />;
    case 'ORDER_LIST':
      return <OrderListScreen onBack={goBack} />;
    case 'CHAT':
      return <ChatScreen userId={currentUserId} onBack={goBack} />;
    case 'LOGIN':
    default:
      return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }
}

export default function App() {
  // SafeAreaProvider + SafeAreaView（safe-area-context）取代原本硬寫的
  // paddingTop: StatusBar.currentHeight。Android 15 起系統強制 edge-to-edge，
  // 只有 insets 才能正確避開瀏海 / 打孔螢幕 / 手勢導覽列。
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
        <StatusBar style="dark" />
        <Router />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

// ==========================================
// 🎨 跨平台 UI 樣式表
// ==========================================
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f8f9fa' },
  screen: { flex: 1, padding: 20, backgroundColor: '#f8f9fa' },
  loginBody: { paddingBottom: 24 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  flexGrow: { flexGrow: 1 },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
  title: { fontSize: 22, fontWeight: 'bold', marginBottom: 20, textAlign: 'center', color: '#2c3e50' },
  sectionTitle: { fontSize: 16, fontWeight: 'bold', marginTop: 15, marginBottom: 10 },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 10, borderRadius: 5, marginBottom: 10, backgroundColor: '#fff', color: '#2c3e50' },
  linkText: { color: '#3498db', textAlign: 'center', marginTop: 15, fontWeight: '500' },
  navRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  // ⚠️ flexShrink: 0 不能省 —— RN 的 ScrollView 內建樣式是 flexGrow:1 + flexShrink:1，
  // 只寫 flexGrow:0 擋得住「變高」卻擋不住「被壓扁」。同一欄裡的 FlatList 也要空間，
  // Yoga 就會回頭壓縮這條分類列，把徽章下緣連同文字一起裁掉（實際發生過）。
  categoryRow: { flexGrow: 0, flexShrink: 0, marginBottom: 4 },
  categoryRowContent: { paddingVertical: 4, alignItems: 'center' },
  categoryBadge: { backgroundColor: '#34495e', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 15, marginRight: 6 },
  // lineHeight 明寫：中文字的下伸部比拉丁字母深，交給預設行高在 Android 上會壓到底線
  categoryBadgeText: { color: '#fff', fontSize: 12, lineHeight: 16 },
  productCard: { backgroundColor: '#fff', padding: 20, borderRadius: 8, marginBottom: 12, borderWidth: 1, borderColor: '#eee' },
  productName: { fontSize: 16, fontWeight: 'bold', color: '#333' },
  productCategory: { fontSize: 11, color: '#95a5a6', marginTop: 2 },
  productBottomRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 5 },
  productPrice: { color: '#e74c3c', fontWeight: '600' },
  productStock: { fontSize: 11, color: '#7f8c8d' },
  productSoldOut: { fontSize: 11, color: '#e74c3c', fontWeight: '600' },
  detailTitle: { fontSize: 22, fontWeight: 'bold', marginVertical: 10 },
  detailDesc: { fontSize: 15, color: '#666', marginBottom: 10 },
  detailPrice: { fontSize: 18, color: '#e74c3c', fontWeight: 'bold', marginBottom: 15 },
  divider: { height: 1, backgroundColor: '#ddd', marginVertical: 15 },
  reviewCard: { backgroundColor: '#fff', padding: 10, borderRadius: 5, marginVertical: 4, borderLeftWidth: 4, borderLeftColor: '#3498db' },
  cartItem: { padding: 12, backgroundColor: '#fff', marginBottom: 8, borderRadius: 6, borderWidth: 1, borderColor: '#eee' },
  cartItemTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  cartItemBottomRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
  cartItemName: { flex: 1, marginRight: 8, color: '#2c3e50' },
  cartItemPrice: { color: '#e74c3c', fontWeight: '600' },
  cartItemUnit: { fontSize: 11, color: '#95a5a6', width: 76 },
  qtyBox: { flexDirection: 'row', alignItems: 'center' },
  qtyBtn: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: '#bdc3c7', backgroundColor: '#f8f9fa', justifyContent: 'center', alignItems: 'center' },
  qtyBtnText: { fontSize: 18, lineHeight: 22, color: '#2c3e50', fontWeight: '600' },
  qtyValue: { minWidth: 40, textAlign: 'center', fontSize: 15, fontWeight: '600', color: '#2c3e50' },
  removeText: { color: '#e74c3c', fontSize: 12, width: 62, textAlign: 'right' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#ddd', marginTop: 8 },
  totalLabel: { fontSize: 16, fontWeight: 'bold', color: '#2c3e50' },
  totalValue: { fontSize: 20, fontWeight: 'bold', color: '#e74c3c' },
  myMessage: { alignSelf: 'flex-end', backgroundColor: '#dcf8c6', padding: 10, borderRadius: 10, marginVertical: 4, maxWidth: '80%' },
  otherMessage: { alignSelf: 'flex-start', backgroundColor: '#fff', padding: 10, borderRadius: 10, marginVertical: 4, maxWidth: '80%', borderWidth: 1, borderColor: '#ddd' },
  messageSender: { fontSize: 10, color: '#777' },
  chatRoomHint: { fontSize: 11, color: '#95a5a6', textAlign: 'center', marginBottom: 8 },
  chatInputRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  chatInput: { flex: 1, marginBottom: 0 },
  loadingFooter: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 15 },
  loadingFooterText: { fontSize: 11, color: '#7f8c8d', marginLeft: 5 },
  emptyBox: { padding: 30, alignItems: 'center' },
  emptyText: { color: '#7f8c8d', textAlign: 'center', lineHeight: 20 },
  emptyInline: { color: '#95a5a6', textAlign: 'center', marginVertical: 20 },
  settingsToggle: { color: '#34495e', fontSize: 12, textAlign: 'center' },
  settingsBox: { marginTop: 12, padding: 12, backgroundColor: '#ecf0f1', borderRadius: 8 },
  settingsHint: { fontSize: 11, color: '#7f8c8d', marginBottom: 8 },
  bottomSpacer: { height: 40 },

  // 主選單
  homeHeader: { alignItems: 'center', marginBottom: 8 },
  homeSubtitle: { fontSize: 12, color: '#7f8c8d', marginTop: -12, marginBottom: 12 },
  menuGrid: { paddingBottom: 12 },
  menuCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 16, borderRadius: 10, marginBottom: 10, borderWidth: 1, borderColor: '#eee', borderLeftWidth: 5 },
  menuIcon: { fontSize: 26, marginRight: 14 },
  menuTextBox: { flex: 1 },
  menuTitle: { fontSize: 16, fontWeight: 'bold', color: '#2c3e50' },
  menuDesc: { fontSize: 12, color: '#7f8c8d', marginTop: 3 },
  menuArrow: { fontSize: 24, color: '#bdc3c7', marginLeft: 8 },

  // 訂單查詢
  orderSummary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#ecf0f1', borderRadius: 8, marginBottom: 10 },
  orderSummaryText: { fontSize: 13, color: '#34495e' },
  orderSummaryAmount: { fontSize: 13, fontWeight: 'bold', color: '#e74c3c' },
  orderCard: { backgroundColor: '#fff', borderRadius: 8, marginBottom: 8, borderWidth: 1, borderColor: '#eee', overflow: 'hidden' },
  orderHeader: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  orderHeaderLeft: { flex: 1 },
  orderHeaderRight: { alignItems: 'flex-end', marginRight: 8 },
  orderNo: { fontSize: 15, fontWeight: 'bold', color: '#2c3e50' },
  orderDate: { fontSize: 11, color: '#95a5a6', marginTop: 3 },
  orderAmount: { fontSize: 15, fontWeight: '600', color: '#e74c3c' },
  orderStatus: { fontSize: 10, color: '#fff', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden', marginTop: 4 },
  orderChevron: { fontSize: 16, color: '#bdc3c7', width: 14, textAlign: 'center' },
  orderDetailBox: { borderTopWidth: 1, borderTopColor: '#eee', backgroundColor: '#fbfcfc', paddingHorizontal: 14, paddingVertical: 10 },
  orderDetailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  orderDetailName: { flex: 1, fontSize: 13, color: '#34495e', marginRight: 8 },
  orderDetailPrice: { fontSize: 13, color: '#7f8c8d' },
  orderDetailError: { fontSize: 12, color: '#e74c3c', lineHeight: 18 },
  orderSectionTitle: { fontSize: 11, fontWeight: 'bold', color: '#34495e', marginTop: 8, marginBottom: 4, borderBottomWidth: 1, borderBottomColor: '#e4e7eb', paddingBottom: 3 },
  payStatus: { fontSize: 13, fontWeight: 'bold' },
  payPendingNote: { marginTop: 6, padding: 7, backgroundColor: '#fef5e7', borderLeftWidth: 3, borderLeftColor: '#e67e22', borderRadius: 3, color: '#7d6608', fontSize: 11, lineHeight: 16 },

  // 支付方式選擇
  payLabel: { fontSize: 12, fontWeight: 'bold', color: '#2c3e50', marginTop: 4, marginBottom: 6 },
  payRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  payChip: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: '#bdc3c7', backgroundColor: '#fff' },
  payChipActive: { backgroundColor: '#2c3e50', borderColor: '#2c3e50' },
  payChipText: { fontSize: 12, color: '#34495e' },
  payChipTextActive: { color: '#fff', fontWeight: 'bold' },
  payHint: { fontSize: 11, color: '#7d6608', backgroundColor: '#fef5e7', borderLeftWidth: 3, borderLeftColor: '#e67e22', borderRadius: 3, padding: 7, marginBottom: 8, lineHeight: 16 },
});
