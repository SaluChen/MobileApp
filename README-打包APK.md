# 行動商城 App — 打包說明（Android APK · iOS）

Expo SDK `~57.0.22` / React Native `0.86.3` / React 19.2.3
後端：同目錄的 [api.php](api.php)（MariaDB + PDO）

| 平台 | 建置方式 | 章節 | 目前版本 |
| --- | --- | --- | --- |
| Android | 本機 Gradle（`android/` 手動維護） | 第一～九節 | 1.2.3（versionCode 6） |
| iOS | EAS 雲端建置（`ios/` 由雲端 prebuild 產生） | 第十節 | 1.2.3（buildNumber 1，模擬器版） |

> 檔名保留 `README-打包APK.md` 是為了不讓其他文件的連結失效。

---

## ⚠️ 開工前必看：專案不能放在含中文的路徑

這是**硬性限制**，不是建議。實測結果：

放在 `F:\Salu\11501-行動資料庫應用-資應五甲\...` 底下執行 `gradlew`，會直接被 Android Gradle Plugin 擋下：

```
Your project path contains non-ASCII characters.
This will most likely cause the build to fail on Windows.
```

就算加上 `android.overridePathCheck=true` 硬闖，Kotlin 編譯器仍會把中文路徑吃成亂碼而失敗
（實測錯誤訊息：`u884Cu52D5u8CC7u6599u5EABu61C9u7528`，就是「行動資料庫應用」被編碼壞掉）。
用 `mklink /J` 做 ASCII 捷徑**也沒有用**，Gradle 會把 junction 解析回真實的中文路徑。

**唯一解法：把整個 `MobileShopApp` 資料夾實體複製到純英數路徑再編譯。**

目前專案已經放在純英數路徑，這個問題已解決：

```
F:\dev\MobileShopApp
```

> ⚠️ **從別的位置複製專案過來時，一定要排除 `android\build`。**
> 實測踩過一次：`android\build\generated\autolinking\autolinking.json` 裡面存的是
> **產生當下的絕對路徑**。從 `C:\dev\MobileShopApp` 複製過來後沒清掉，Gradle 就會去找
> `C:\dev\MobileShopApp\node_modules\react-native-safe-area-context\android`
> 然後直接失敗：
>
> ```
> Configuring project ':react-native-safe-area-context' without an existing directory is not allowed.
> ```
>
> 解法是把產生物整個刪掉重跑：
>
> ```powershell
> Remove-Item -Recurse -Force android\build, android\.gradle, android\app\build
> ```
>
> 複製專案時請這樣排除：
>
> ```powershell
> robocopy "<來源>" "F:\dev\MobileShopApp" /MIR /MT:32 `
>          /XD android\build android\.gradle android\app\build .git .expo node_modules
> ```

---

## 一、環境需求

| 項目 | 需要版本 | 這台電腦目前狀態 |
|---|---|---|
| Node.js | 20+ | ✅ v26.7.0 |
| **JDK** | **17 或 21（不能用 25）** | ✅ `F:\dev\jdk21\jdk-21.0.12+8`（Temurin 免安裝版） |
| Gradle | 9.3.1 | ✅ 由 `gradlew` 自動下載 |
| Android SDK Platform | android-36 | ✅ 已安裝 |
| Android build-tools | 36.0.0 | ✅ 已安裝 |
| **NDK** | **27.1.12297006** | ✅ 已安裝（約 2.5 GB） |
| CMake | 3.22.1 | ✅ 已安裝 |

### 🔴 JDK 25 不能用（這一條之前寫錯了，實測後更正）

舊版這份文件寫「JDK 25 亦可，實測 Gradle 9.3.1 接受」——**那個實測只跑到
`:app:signingReport`，根本沒摸到 C++ 編譯**，所以結論是錯的。

完整 `assembleRelease` 在 JDK 25 下必定失敗：

```
Execution failed for task ':app:configureCMakeRelWithDebInfo[arm64-v8a]'.
> WARNING: A restricted method in java.lang.System has been called
```

原因：AGP 會**另外開一個 JVM** 去跑 Prefab（`com.google.prefab.cli`，見
`app\.cxx\...\prefab_config.json`），用來解出 `react-android` / `hermes-android` / `fbjni`
這三個 AAR 內附的原生標頭與 `.so`。JDK 24 起這個 JVM 會往 stderr 印一行
restricted-method 警告，而 **AGP 把 Prefab 的任何 stderr 一律當成失敗**。

錯誤訊息只有那句 WARNING、看起來完全不像編譯錯誤，很容易誤判成 NDK 或 CMake 壞掉，
實際上跟它們無關，純粹是 JDK 版本太新。AGP 8.x 官方支援的是 JDK 17 / 21。

取得免安裝版 JDK 21（不動 PATH、不寫登錄檔、可隨時整個資料夾刪掉）：

```powershell
$ProgressPreference='SilentlyContinue'
Invoke-WebRequest -MaximumRedirection 10 `
  -Uri 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse' `
  -OutFile 'F:\dev\temurin21.zip'
Expand-Archive 'F:\dev\temurin21.zip' -DestinationPath 'F:\dev\jdk21' -Force
Remove-Item 'F:\dev\temurin21.zip'
```

> 換 JDK 之後記得 `.\gradlew.bat --stop`，否則會沿用舊 JDK 起的 daemon。

#### 🔴 系統 `JAVA_HOME` 可能指向舊 JDK（實際踩過）

即使 `java -version` 顯示 21 或 25，Gradle **看的是 `JAVA_HOME` 而不是 PATH**。
這台電腦的系統變數是 `JAVA_HOME=C:\Java\java-se-8u41`，所以直接跑 `gradlew` 會立刻失敗：

```
FAILURE: Build failed with an exception.
* What went wrong:
Gradle requires JVM 17 or later to run. Your build is currently configured to use JVM 8.
```

訊息很明確，但容易誤以為「我明明裝了 JDK 21」而往錯的方向查。

**建議只在建置指令內覆蓋，不要改系統變數** —— 機器上可能有其他東西依賴 JDK 8：

```bash
# Git Bash
JAVA_HOME="C:/Program Files/Java/jdk-21.0.12" ./gradlew assembleRelease
```

```powershell
# PowerShell（只影響目前這個 shell）
$env:JAVA_HOME = 'F:\dev\jdk21\jdk-21.0.12+8'
.\gradlew.bat assembleRelease
```

以上版本號不是猜的，是實際跑 `gradlew` 時 Expo 自己印出來的：

```
[ExpoRootProject] Using the following versions:
  - buildTools:  36.0.0
  - minSdk:      24
  - compileSdk:  36
  - targetSdk:   36
  - ndk:         27.1.12297006
  - kotlin:      2.1.20
  - ksp:         2.1.20-2.0.1
```

### 目前驗證到哪一步

✅ **已完整跑完 `assembleRelease`，兩個 APK 都產出並通過驗證**（344 個 task）。

實測耗時（同一台機器）：

| 情境 | 耗時 | 說明 |
| --- | --- | --- |
| 首次 / 冷快取 | 47 ~ 74 分鐘 | 要編 C++、跑 codegen、下載相依 |
| 只改 App.js（增量） | 16 ~ 23 分鐘 | 大部分 task `UP-TO-DATE`，重跑約 35~53 個 |

> 增量建置仍要十幾分鐘是因為 lint 與 dex 都會重跑。
> 開發階段請用 Expo Go（見第六節），不要每次都打包。

> **為什麼一定要 NDK？**
> Expo SDK 57 起 New Architecture（Fabric + TurboModules）為強制啟用，
> 建置過程會用 codegen 產生 C++ 並實際編譯，所以本機打包躲不掉 NDK。

### 補裝缺少的元件

```powershell
$env:JAVA_HOME = 'F:\dev\jdk21\jdk-21.0.12+8'
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$sdkmanager = "$sdk\cmdline-tools\latest\bin\sdkmanager.bat"

("y`n" * 60) | & $sdkmanager --sdk_root="$sdk" `
    "platforms;android-36" "build-tools;36.0.0" `
    "ndk;27.1.12297006" "cmake;3.22.1"
```

> `("y\`n" * 60) |` 是把 60 個「y」餵進去自動同意授權條款。
> 少了這段，sdkmanager 會停在 licence 提示等你打字；
> 在腳本或自動化環境裡沒有 stdin，就會直接卡死或失敗。
> 已經裝好的元件會自動略過，這串指令可以安全重跑。

> Gradle 其實也會自己下載這些元件，但 NDK 有 2.5 GB，
> 中途若被 Ctrl+C 或 timeout 打斷，會留下一個殘缺的
> `Sdk\ndk\27.1.12297006\` 空目錄，之後每次 build 都報
> `did not have a source.properties`。
> 遇到這個錯就把那個目錄整個刪掉重來：
>
> ```powershell
> Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Android\Sdk\ndk\27.1.12297006"
> ```
>
> 建議還是用上面的 `sdkmanager` 先裝好，比較好掌握進度。

### 🔴 磁碟空間警告

這台機器 C: 空間非常吃緊。打包過程實測的消長：

| 時間點 | C: 可用空間 |
|---|---|
| 開工前 | 11 GB |
| 裝完 NDK 27 等元件 | 7.7 GB |
| 刪掉用不到的 NDK 30-beta | 9.2 GB |
| **打包完成後** | **3.0 GB** |

打包完的實際佔用分布（`du -sh` 量的）：

| 位置 | 大小 | 在哪個磁碟 |
|---|---|---|
| `C:\Users\Chen\.gradle`（Gradle 快取） | 4.5 GB | **C:** |
| Android SDK 的 NDK 27 | 2.5 GB | **C:** |
| `android\app\build`（建置中間產物） | 862 MB | F: |
| `android\build` | 178 KB | F: |

⚠️ **注意方向**：專案的建置產物在 F: 上（還有 28 GB），刪掉它們對 C: 毫無幫助。
吃掉 C: 的是 Gradle 快取與 Android SDK。想放鬆 C: 就要處理那兩個，別去清 `android\build`。

順帶一提：Android SDK 裡如果留著**這個專案用不到的舊 NDK**，可以直接刪掉回收空間。
本機原本有一份 `ndk\30.0.15729638`（r30-beta2），Expo SDK 57 寫死要 27.1.12297006，
30 完全用不到，刪掉就多出 3 GB：

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Android\Sdk\ndk\30.0.15729638"
```

C: 不夠時，把 Gradle 快取**搬**到 F:。注意是 `Move-Item` 搬移、不是刪除，
所以相依套件不必重新下載，下次建置速度也不受影響：

```powershell
cd F:\dev\MobileShopApp\android
.\gradlew.bat --stop                                   # 先停掉佔用檔案的 daemon
Move-Item "$env:USERPROFILE\.gradle" 'F:\gradle-home'
[Environment]::SetEnvironmentVariable('GRADLE_USER_HOME', 'F:\gradle-home', 'User')
```

C: 可回收約 4.5 GB。環境變數要**開新的終端機**才會生效。

---

## 二、打包指令

```powershell
$env:JAVA_HOME = 'F:\dev\jdk21\jdk-21.0.12+8'      # ⚠️ 必須是 JDK 17 或 21
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

cd F:\dev\MobileShopApp\android
.\gradlew.bat --stop                                # 清掉可能用舊 JDK 起的 daemon
.\gradlew.bat assembleRelease
```

產出位置（**一次跑完就會有兩包**）：

```
F:\dev\MobileShopApp\android\app\build\outputs\apk\release\
├── app-arm64-v8a-release.apk    25.2 MB   → 實體 Android 手機
└── app-x86_64-release.apk       25.6 MB   → PC 上的 Android Emulator
```

另外我複製了一份檔名比較好認的放在 `F:\dev\MobileShopApp\dist\`。

### 為什麼會剛好切成兩包？

`android/app/build.gradle` 裡加了 ABI splits：

```gradle
splits {
    abi {
        enable true
        reset()                              // 先清掉 AGP 預設清單
        include 'arm64-v8a', 'x86_64'        // 只要這兩種
        universalApk false                   // 不產生四合一的肥大萬用包
    }
}
```

同時把 `android/gradle.properties` 的架構清單從四種砍成兩種：

```properties
reactNativeArchitectures=arm64-v8a,x86_64
```

砍掉的 `armeabi-v7a` 與 `x86` 是早已停產的 32 位元架構。
**兩者要一起改**：`splits` 決定「切成幾包」，`reactNativeArchitectures`
決定「React Native 編譯哪幾種 `.so`」。只改前者的話，Gradle 仍會白編兩份用不到的原生函式庫。

成果：每包只塞自己需要的 `.so`，體積從四合一的約 70 MB 降到約 25 MB。

### 用 Android Studio 圖形介面打包

1. Android Studio → **Open** → 選 `F:\dev\MobileShopApp\android`
2. **File → Settings → Build Tools → Gradle → Gradle JDK** 選 **JDK 21**
   （Android Studio 內建的 JBR 是 25，會踩到上面那個 Prefab 問題）
3. 等 Gradle sync 完成
4. **Build → Generate Signed App Bundle / APK → APK**
5. 選 **Choose existing**，keystore 路徑填 `F:\dev\MobileShopApp\android\app\release.keystore`
6. 密碼與別名見下一節
7. Build Variant 選 **release** → Finish

---

## 三、簽章金鑰

已經幫你產好一組自簽金鑰（有效期 10000 天）：

| 項目 | 值 |
|---|---|
| 金鑰檔 | `android/app/release.keystore` |
| Store password | `mobileshop2026` |
| Key alias | `mobileshop` |
| Key password | `mobileshop2026` |
| 憑證 DN | `CN=MobileShop, OU=IM5A, O=Salu, L=Taipei, ST=Taiwan, C=TW` |

密碼寫在 `android/gradle.properties` 的 `MOBILESHOP_*` 三個變數，
`android/app/build.gradle` 的 `signingConfigs.release` 會去讀它們。

> **⚠️ 這組金鑰請自己保管好。**
> Android 規定「同一個 App 的後續更新必須用同一把金鑰簽章」，
> 金鑰弄丟 = 使用者只能移除舊版重裝，無法覆蓋更新。
>
> 真的要上 Google Play 的話，請把那三行密碼從 `gradle.properties` 搬到
> `C:\Users\Chen\.gradle\gradle.properties`，不要跟著程式碼進版控。

`build.gradle` 裡我加了一個保護：**若 `release.keystore` 不存在，release 會自動退回 debug 簽章**，
所以把專案傳給同學（不附金鑰）時，對方仍然編得起來。

---

## 四、安裝

⚠️ **兩包不能裝錯。** 兩者的套件名同樣是 `com.salu.mobileshop`，
但各自只帶一種 CPU 的原生函式庫。裝錯的話**可以裝得起來，卻會在開啟的瞬間閃退**，
Logcat 會出現 `UnsatisfiedLinkError: couldn't find "libreactnative.so"`。

### A. 實體 Android 手機 → `app-arm64-v8a-release.apk`

1. 手機 → 設定 → 允許「安裝不明來源的應用程式」
2. 把 APK 傳到手機點開安裝

或用 adb（手機需先開啟「開發人員選項 → USB 偵錯」）：

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb install -r "F:\dev\MobileShopApp\android\app\build\outputs\apk\release\app-arm64-v8a-release.apk"
```

> 2017 年後出廠的 Android 手機幾乎都是 arm64-v8a。
> 不確定的話可以查：`& $adb shell getprop ro.product.cpu.abi`

### B. PC 上的 Android Emulator → `app-x86_64-release.apk`

模擬器跑的是 PC 的 x86_64 CPU，**不是** arm64。

1. Android Studio → **Device Manager** 建立並啟動一台 AVD
   （System Image 請選 **x86_64** 的版本，API 24 以上）
2. 直接把 APK 檔拖曳到模擬器視窗即可安裝

或用 adb：

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb devices                       # 確認模擬器已連上（emulator-5554）
& $adb install -r "F:\dev\MobileShopApp\dist\MobileShop-1.0.0-PC模擬器-x86_64.apk"
```

> **模擬器連後端要用 `10.0.2.2`，不是 `127.0.0.1`。**
> 模擬器裡的 `127.0.0.1` 指的是模擬器自己，不是你的 PC。
> Android Emulator 固定用 `10.0.2.2` 代表宿主機，所以登入頁的「⚙️ 連線設定」
> 要填 `http://10.0.2.2/api.php`。
>
> 若你的 Mac/PC 用 Apple Silicon 之類的 ARM 主機跑模擬器，
> 那模擬器會是 arm64-v8a，該裝的是手機那一包。用上面的 `getprop` 指令確認最準。

---

## 五、連線設定（APK 版最重要的一點）

原本 IP 寫死在程式裡，編成 APK 後換教室、換 Wi-Fi 就整包報廢。

現在改成：**登入頁最下方有「⚙️ 連線設定」，可直接改後端位址，用 AsyncStorage 永久記住。**

- 預設值：`http://192.168.8.88/api.php`（在 `App.js` 的 `DEFAULT_API_URL`）
- 手機與電腦必須在**同一個 Wi-Fi / 內網**
- 電腦端防火牆要開放 80 埠
- 用 `ipconfig` 查電腦的內網 IP，填進去即可

### 為什麼 http 不會被 Android 擋掉？

Android 9（API 28）起預設封鎖明文 HTTP。本專案已在 `app.json` 用
`expo-build-properties` 開啟例外：

```json
["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]
```

產生的 `AndroidManifest.xml` 會帶 `android:usesCleartextTraffic="true"`（已驗證）。

---

## 六、開發時的快速測試（不用打包）

改 UI 的時候不需要每次都跑 5 分鐘的 Gradle：

```powershell
cd F:\dev\MobileShopApp
npx expo start
```

手機裝 **Expo Go**（Play 商店搜尋）掃 QR code 即可即時預覽。

> 注意：Expo Go 只支援 Expo SDK 內建的模組。本專案用到的
> `@react-native-async-storage/async-storage` 與 `react-native-safe-area-context`
> 都在 Expo Go 內，所以可以正常跑。

---

## 七、專案檔案結構

```
MobileShopApp/
├── App.js                    ← 主程式（Android / iOS 共用同一份）
├── index.js                  ← 進入點
├── app.json                  ← Expo 設定：套件名、版號、Android 明文 HTTP、iOS ATS 例外
├── eas.json                  ← EAS 雲端建置設定檔（iOS 用 ios-simulator / preview / production）
├── .easignore                ← ★ EAS 上傳排除清單（擋 db.ini 等機密，見第十節）
├── package.json
├── assets/                   ← 圖示（icon.png 1024×1024 無 alpha，App Store 規格）
├── dist/                     ← APK 複本：app-*-release.apk 為 1.2.3；MobileShop-1.0.0-*.apk 為首版留存
├── ios-build/                ← iOS 建置產物（.tar.gz，不上傳、不入版控）
├── android/                  ← prebuild 產生的原生專案（手動維護，不再 prebuild）
    ├── settings.gradle       ← rootProject.name 已改 ASCII
    ├── local.properties      ← ★ sdk.dir，本機專用不進版控
    ├── gradle.properties     ← SDK 版本、簽章密碼、JVM 記憶體、ABI 清單
    └── app/
        ├── build.gradle      ← 已接上 release 簽章 + ABI splits
        ├── release.keystore  ← 簽章金鑰
        └── src/main/AndroidManifest.xml
```

> `android/local.properties` 若不存在，Gradle 會找不到 Android SDK。
> 這個檔案不進版控（每台機器的 SDK 路徑不同），clone 專案後要自己補：
>
> ```properties
> sdk.dir=C\:\\Users\\<你的帳號>\\AppData\\Local\\Android\\Sdk
> ```
>
> （路徑的反斜線與冒號都要跳脫，這是 Java properties 檔的格式規定。）
> 或者設好 `ANDROID_HOME` 環境變數也可以。

### 改版號：**兩個地方都要改**

`app.json` 的 `version` / `versionCode` 只有在 `expo prebuild` 時才會寫進
`android/app/build.gradle`。但本專案的 `android/` **不能重新 prebuild**（理由見下），
所以改版號時**兩個檔案都要手動改**，否則 APK 內的版號不會變：

| 檔案 | 欄位 |
| --- | --- |
| `app.json` | `expo.version`、`expo.android.versionCode` |
| `android/app/build.gradle` | `versionName`、`versionCode` |
| `app.json`（iOS） | `expo.ios.buildNumber` —— iOS 自己一條版號線，雲端 prebuild 會自動寫入，不必改其他檔 |

改完用 `aapt2 dump badging` 確認 APK 裡的值真的變了。

> ⚠️ **`android/` 在 `.gitignore` 裡（第 41 行），也在 `.easignore` 裡，但它含有手動加入的內容** ——
> `release.keystore` 簽章設定與 ABI splits 設定都是後來手寫進 `build.gradle` 的。
> 哪天執行 `npx expo prebuild` 會把這些覆蓋掉。目前的作法是**不再 prebuild**，
> 直接維護 `android/`。

### 修改 App.js 之後

`android/` 目錄不需要重新產生，直接 `assembleRelease` 即可（JS 會重新打包進去）。

只有在**改了 `app.json` 的 Android 相關設定**（例如換套件名、加權限、加原生套件）時，才需要：

```powershell
cd F:\dev\MobileShopApp
npx expo prebuild --platform android --clean
```

⚠️ `--clean` 會刪掉整個 `android/`，**包含 `release.keystore`、build.gradle 的簽章設定
與 ABI splits 設定**。執行前請先備份 `android/app/release.keystore`，事後再把那兩段補回去。

> 只改 `app.json` 的 **`ios` 區塊**（ATS 例外、`buildNumber`…）**不需要**動 `android/`：
> iOS 的原生專案每次都在 EAS 雲端依 `app.json` 重新產生。

---

## 八、打包成果驗證

兩個 APK 都用 `aapt2` / `apksigner` / `apkanalyzer` 實際驗過，不是「編得出來就算了」：

| 驗證項目 | arm64-v8a 版 | x86_64 版 | 用什麼驗 |
|---|---|---|---|
| 套件名 | `com.salu.mobileshop` | 同左 | `aapt2 dump badging` |
| 版本 | 目前 1.2.3 (versionCode 6) | 同左 | 同上 |
| App 名稱 | 行動商城 | 同左 | 同上 |
| minSdk / targetSdk | 24 / 36 | 同左 | 同上 |
| **原生架構** | **只有 `arm64-v8a`** | **只有 `x86_64`** | 同上 |
| 簽章 | v2，`CN=MobileShop, OU=IM5A, O=Salu…` | 同左 | `apksigner verify --print-certs` |
| INTERNET 權限 | ✅ 有 | 同左 | `aapt2 dump permissions` |
| 明文 HTTP | `usesCleartextTraffic=true` | 同左 | `aapt2 dump xmltree` |
| JS bundle 已內嵌 | ✅ `/assets/index.android.bundle` | 同左 | `apkanalyzer files list` |
| 檔案大小 | 25.2 MB | 25.6 MB | — |

重點是**簽章那一行**：`app/build.gradle` 寫成「找不到 `release.keystore` 就自動退回 debug 簽章」，
所以編得出 APK **不代表**用的是正式金鑰。憑證 DN 顯示 `CN=MobileShop` 才確定是正式簽的；
如果印出來是 `CN=Android Debug`，就表示 `MOBILESHOP_*` 三個密碼變數沒被讀到。

自己重跑一次驗證：

```powershell
$bt = "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.0.0"
$apk = "F:\dev\MobileShopApp\android\app\build\outputs\apk\release\app-arm64-v8a-release.apk"

& "$bt\aapt2.exe" dump badging $apk | Select-String "package:|native-code|SdkVersion"
& "$bt\apksigner.bat" verify --print-certs $apk
```

### 驗證「新程式碼真的打包進去了」

版號對、簽章對，不代表 JS 有更新。要確認就直接翻 bundle 裡的字串：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$apk = "F:\dev\MobileShopApp\android\app\build\outputs\apk\release\app-arm64-v8a-release.apk"
$zip = [System.IO.Compression.ZipFile]::OpenRead($apk)
$e = $zip.Entries | Where-Object { $_.FullName -eq 'assets/index.android.bundle' }
$ms = New-Object System.IO.MemoryStream
$e.Open().CopyTo($ms); $zip.Dispose()
$b = $ms.ToArray()

$u8  = [System.Text.Encoding]::UTF8.GetString($b)
$u16 = [System.Text.Encoding]::Unicode.GetString($b)
foreach ($t in @('ATM Transfer', '待出貨', '已收款')) {
  $ok = $u8.Contains($t) -or $u16.Contains($t)
  Write-Output ("{0} {1}" -f $(if($ok){'OK  '}else{'MISS'}), $t)
}
```

> 🔴 **中文字串一定要用 UTF-16 讀。**
> bundle 是 Hermes bytecode（開頭 magic `C6 1F BC 03`），
> 字串表把 ASCII 存成 UTF-8、**非 ASCII 存成 UTF-16**。
> 只用 UTF-8 搜尋的話中文一律 MISS，會誤判成「程式碼沒打包進去」——
> 這個坑實際踩過一次。

---

## 九、版本歷程

| 版本 | versionCode | 內容 |
|---|---|---|
| 1.0.0 | 1 | 首次打包成功（主選單、無限滾動、購物車明細修改、訂單查詢） |
| 1.1.0 | 2 | 登出撤銷權杖、商品庫存顯示與售完鎖定、帳號停用自動登出（`ACCOUNT_SUSPENDED`） |
| 1.2.0 | 3 | 購物車支付方式選擇（五種）、訂單查詢加上付款資訊區塊 |
| 1.2.1 | 4 | 訂單狀態標籤跟上履約流程（`awaiting_shipment` → 待出貨） |
| 1.2.2 | 5 | 金額顯示改為千分位（新增 `money()`，與網頁端三支共用同一套格式） |
| 1.2.3 | 6 | 修正商品瀏覽頁「分類」列被壓扁、徽章文字下緣裁切（`flexShrink: 0`） |

> 每次改版都要**同時**更新 `app.json` 與 `android/app/build.gradle`（見第七節），
> 否則 APK 內的版號不會變。

---

## 十、iOS 版（EAS 雲端建置）

同一份 `App.js` 直接產出 iOS 版，**程式碼不用改**。差別全在建置方式與設定。

### 為什麼不能像 APK 一樣在本機打包

iOS 編譯必須用 macOS + Xcode，這台 Windows 做不到。改用 **EAS Build**：
把專案上傳到 Expo 的 macOS 雲端主機（SDK 57 使用 `macos-tahoe-26.5-xcode-26.6` 映像檔）編譯。

| 需要 | 說明 |
|---|---|
| Expo 帳號 | 已登入（`eas whoami` → `saluchen`） |
| eas-cli | 已安裝 21.7.0 |
| Apple Developer Program | **裝到實機或上架才需要**（US$99／年）。模擬器版不需要 |
| Mac | **只有模擬器版需要**：`.app` 只能在 Mac 的 iOS Simulator 執行 |

### 三種建置目標

| 設定檔 | 產出 | 需要 Apple 付費帳號 | 能在哪裡跑 |
|---|---|---|---|
| `ios-simulator` | `.app` | ❌ | Mac 上的 iOS Simulator |
| `preview` | `.ipa`（Ad Hoc） | ✅ | 事先登記 UDID 的 iPhone |
| `production` | `.ipa`（App Store） | ✅ | TestFlight／App Store |

### 指令

本專案**不是 git repository**，所以每次都要帶 `EAS_NO_VCS=1`（eas-cli 會改用 `.easignore` 決定上傳內容）：

```powershell
cd F:\dev\MobileShopApp
$env:EAS_NO_VCS = '1'

eas build --platform ios --profile ios-simulator   # 不需 Apple 付費帳號
eas build --platform ios --profile preview         # 實機測試
eas build --platform ios --profile production      # 上架
```

> ⚠️ 前面第一節提到「專案不能放在含中文路徑」是 Android Gradle 的限制；
> iOS 在雲端 macOS 上建置，不受影響。

### 雲端怎麼產生 `ios/`

`.gitignore` 與 `.easignore` 都排除了 `/ios` 與 `/android`，EAS 因此把專案當作
Continuous Native Generation 專案，在雲端依 `app.json` 執行 `npx expo prebuild` 產生 `ios/`。

所以 **iOS 的原生設定全部改 `app.json`**，不要在本機產生 `ios/` 再手改 ——
這跟 Android 的做法（手動維護 `android/`，不再 prebuild）剛好相反。
本機的 `android/` 不會上傳，雲端 iOS 建置碰不到 `release.keystore`。

### 🔴 `.easignore`：上傳前必須擋掉機密

`eas build` 會把專案資料夾打包上傳到 Expo 的伺服器。本專案根目錄同時放著後端，
沒擋的話會一起送出去：

| 檔案 | 風險 |
|---|---|
| `db.ini` | **資料庫密碼與權杖簽章密鑰**（`api.php` 第 53、81 行讀取） |
| `api.php`、`*.sql` | 後端原始碼、測試帳號種子資料 |
| `.claude/` | 本機工具設定 |
| `Mobile_DB_Course/`、`*.pptx` | 與 App 無關，共數十 MB |

⚠️ **`.easignore` 存在時，EAS 完全不讀 `.gitignore`**（eas-cli `vcs/local.js` 原始碼確認）。
所以 `.easignore` 開頭把 `.gitignore` 全部抄了一遍，那一段不能刪。

實際會上傳的只有：`App.js` `index.js` `app.json` `eas.json` `package.json` `package-lock.json` `assets/` `LICENSE`

### 🔴 iOS 17 起連不到 IP 位址（ATS）

App 預設連 `http://192.168.8.88/api.php` —— **IP 位址 + 明文 HTTP**，iOS 會擋兩次：

1. App Transport Security 預設要求 HTTPS
2. Apple 文件原文：*"In iOS 17, iPadOS 17, and macOS 14, ATS no longer allows connections to IP addresses by default. Add individual IP addresses and CIDR ranges in the `NSExceptionDomains` dictionary."*

原本只設了 `NSAllowsLocalNetworking`，所以補上逐一例外：

```json
"NSExceptionDomains": {
  "192.168.8.88":   { "NSExceptionAllowsInsecureHTTPLoads": true },
  "192.168.0.0/16": { "NSExceptionAllowsInsecureHTTPLoads": true },
  "10.0.0.0/8":     { "NSExceptionAllowsInsecureHTTPLoads": true },
  "172.16.0.0/12":  { "NSExceptionAllowsInsecureHTTPLoads": true }
}
```

三段 CIDR 是全部的私有網段 —— 使用者在 App 的「連線設定」改成別的內網 IP 也能連。
**刻意不開放公網 IP**：部署到雲端主機時請走 HTTPS，否則權杖與密碼會以明文經過網際網路。

### app.json 的 iOS 設定一覽

| 欄位 | 值 | 原因 |
|---|---|---|
| `bundleIdentifier` | `com.salu.mobileshop` | 與 Android `package` 相同 |
| `buildNumber` | `"1"` | 對應 `CFBundleVersion`；iOS 自己一條版號線，與 Android `versionCode` 無關 |
| `requireFullScreen` | `true` | App 只支援直向，iPad 又開了 `supportsTablet`；不鎖全螢幕，上傳 App Store 時會因 iPad 多工需支援所有方向而被退 |
| `config.usesNonExemptEncryption` | `false` | 只用系統內建的 HTTPS，沒有自製加密（HMAC 簽章在伺服器端）。設好就不必每次在 TestFlight 回答出口管制問題 |

驗證方式（Windows 可跑，不需 Mac）：

```powershell
npx expo config --type introspect --json
```

輸出的 `ios.infoPlist` 裡應看到 `NSExceptionDomains`、`UIRequiresFullScreen: true`、
`ITSAppUsesNonExemptEncryption: false`、`CFBundleVersion: 1`。

### iOS 上看起來不一樣的地方（不是 bug）

- **`<Button color="...">` 在 iOS 是文字顏色，不是底色**。App 裡 12 個按鈕在 iOS 會變成彩色文字連結，
  這是 React Native `Button` 對應原生 `UIButton` 的正常行為。
- **沒有實體返回鍵**。`BackHandler` 只在 Android 註冊（`App.js` 已判斷 `Platform.OS`），
  iOS 靠畫面上的「← 主選單」按鈕返回。

### 建置前先跑 `expo-doctor`

EAS 建置流程中有一步 `expo doctor`。**它失敗不會中止建置**（第一次 iOS 建置就是紅字但狀態仍為 `finished`），
所以很容易被忽略或誤判為建置失敗。實際踩過的是 SDK patch 版本落後：

| 套件 | 當時 | SDK 57 預期 |
|---|---|---|
| `expo` | 57.0.12 | ~57.0.22 |
| `expo-build-properties` | 57.0.10 | ~57.0.17 |
| `react-native` | 0.86.2 | 0.86.3 |

送出建置前在本機先確認：

```powershell
npx -y expo-doctor          # 應顯示 21/21 checks passed
npx expo install --fix      # 若有落後，用這個對齊（不要手動改 package.json 版號）
```

> ⚠️ `react-native` 版本變動會影響 **Android 本機打包**：`android/` 是手動維護的，
> Gradle 直接吃 `node_modules/react-native`。升版後下一次打 APK 要重新走第八節的驗證。

### iOS 建置紀錄

| 版本 | buildNumber | 設定檔 | 結果 |
|---|---|---|---|
| 1.2.3 | 1 | `ios-simulator` | ✅ 2026-09-13，建置 3 分 27 秒；產物存於 `ios-build/MobileShopApp-1.2.3-b1-simulator.tar.gz` |

驗證（下載產物後以 Python `plistlib` 與 Mach-O 標頭解析，Windows 可做）：

| 項目 | 結果 |
|---|---|
| 平台 | `iphonesimulator26.5`，執行檔 `x86_64` + `arm64` 雙架構，兩段皆標記 iOS Simulator |
| 最低 iOS | 16.4 —— iOS 16 預設允許 IP、17 起需例外，兩者都已涵蓋 |
| ATS | `NSExceptionDomains` 四筆皆在 Info.plist 內 |
| JS bundle | Hermes（`c61fbc03`），含千分位 regex 與預設 API 位址 |

**安裝方式（需 Mac）**：解壓得到 `app.app`，拖進已開啟的 iOS Simulator 視窗即可安裝。
或在 Mac 上執行 `eas build:run --platform ios --latest` 自動下載並安裝。

> 模擬器與 Mac 在同一個網路，App 預設的 `http://192.168.8.88/api.php` 可以直接連；
> 若後端跑在同一台 Mac 上，到「連線設定」改成 Mac 的內網 IP。
