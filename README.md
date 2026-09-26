# 參拜足跡｜全台玄天上帝廟朝聖地圖與參拜筆記系統

本專案為記錄全台 **732 間玄天上帝廟**參拜過程之專屬 Web 應用系統，特別針對「**外勤參拜、偏鄉離線可用、現場拍照打卡、心得筆記與進度追蹤**」進行量身設計。

本系統採用現代化無伺服器（Serverless）架構：
**GitHub Pages 靜態託管 + GitHub Actions CI/CD 自動發布 + Firebase 雲端即時同步（Firestore + Storage + Google 登入）**。

---

## 🌐 線上正式網站

👉 **[https://merace1984.github.io/xuantian-pilgrimage/](https://merace1984.github.io/xuantian-pilgrimage/)**

- **手機體驗 (PWA)**：使用手機瀏覽器開啟後，可點選「加入主畫面」（iOS Safari）或「安裝應用程式」（Android Chrome），即可全螢幕離線使用。
- **離線優先機制**：預設採用瀏覽器本機 IndexedDB 快取，偏遠山區無網路訊號時亦可正常打卡、拍照與撰寫筆記。

---

## ⚙️ 雲端同步設定指引（Firebase 免費方案）

若欲啟用跨裝置（手機、平板、電腦）即時資料同步與雲端圖床儲存，請依照以下步驟綁定 Firebase：

### 第一步：建立 Firebase 專案
1. 前往 [Firebase Console](https://console.firebase.google.com/)，點選 **「建立專案」**（選擇免費 Spark 方案即可）。
2. **啟用 Firestore Database**：
   - 點選左側選單「Firestore Database」 $\rightarrow$「建立資料庫」。
   - 地區建議選擇 `asia-east1 (台灣)`。
   - 點選「規則 (Rules)」頁籤，將本專案目錄下 `firebase/firestore.rules` 的內容貼上並按「發布」。
3. **啟用 Storage（相片圖床）**：
   - 點選左側選單「Storage」 $\rightarrow$「開始使用」。
   - 點選「規則 (Rules)」頁籤，將本專案目錄下 `firebase/storage.rules` 的內容貼上並按「發布」。
4. **啟用 Google 登入**：
   - 點選左側選單「Authentication」 $\rightarrow$「開始使用」 $\rightarrow$「登入方法」。
   - 選擇 **Google** 並啟用，設定專案支援電子郵件後儲存。
   - 在下方「已授權網域」中，新增授權網域：`merace1984.github.io`。

### 第二步：維護私密金鑰與上傳指引 (Zero Secrets in Repo)
為嚴格落實資安防護與個人權限隔離，本專案將所有敏感金鑰（APIKey、Project ID、管理員權限憑證）皆自版本控制中排除：

1. **私密設定檔相對路徑**：
   - 前端 Web 金鑰：`private/config/firebase-config.js`
   - 後台管理憑證：`private/config/firebase-service-account.json`
   - 系統機密環境變數：`private/config/env.secrets`
2. **填寫金鑰**：
   在 Firebase Console 取得 `firebaseConfig` 物件後，請開啟地端私密檔案 `private/config/firebase-config.js` 填入實際金鑰。
3. **上傳至網站目錄或資料庫**：
   - **本地端測試／自行託管**：可將 `private/config/firebase-config.js` 複製覆蓋至相對路徑 `web/firebase-config.js`（請注意勿將填寫後之檔案 commit 推送）。
   - **線上正式發布**：正式 Repo 之 `web/firebase-config.js` 保留安全介面（預設自動運行於無風險的「本機離線模式」）。管理者可自行將金鑰上傳至網站伺服器根目錄，或於 GitHub Actions Secrets 設置變數注入。

---

## 📂 系統核心結構一覽

- **`private/`**：地端專屬私密目錄（受 `.gitignore` 隔離，永不上傳）：
  - **`private/config/firebase-config.js`**：真實 Firebase 雲端金鑰地端保管檔。
  - **`private/config/firebase-service-account.json`**：最高權限 Service Account 私密金鑰範本。
  - **`private/config/env.secrets`**：系統環境變數與管理員 UID 機密清單。
  - **`private/` 行程規劃檔案**：在地專屬路線、規劃表與機車行程資料。
- **`.github/workflows/deploy.yml`**：GitHub Actions 自動化發布至 GitHub Pages 的 CI/CD 流程。
- **`firebase/firestore.rules`**：Firestore 資料庫安全防護規則（防止未授權存取與篡改）。
- **`firebase/storage.rules`**：Cloud Storage 相片安全上傳規則（限制圖片格式與檔案大小）。
- **`web/firebase-config.js`**：Firebase 雲端連線公開介面（參照相對路徑 `../private/config/firebase-config.js`）。
- **`web/index.html`**：整合 Google 登入、全台地圖與打卡視窗之響應式 (RWD) 介面。
- **`web/app.js`**：Leaflet 地圖引擎、Firebase 即時同步、Dexie 本機快取與相片壓縮引擎。
- **`web/temples_data.js`**：全台 732 間玄天上帝廟唯讀結構化資料庫（個資與聯絡資訊已完全剔除）。
- **`全台玄天上帝廟宇名錄.csv`**：全台 732 間原始詳細名錄數據（負責人姓名與聯絡電話已全數移除）。
