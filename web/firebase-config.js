// =========================================================================
// 【正式發布檔案】Firebase 雲端連線設定介面 (firebase-config.js)
// =========================================================================
// 安全隔離說明：
// 為確保系統權限與 API 金鑰絕對不進入版本控制，本檔案在 Git Repo 中僅保留
// 公開安全介面與預設佔位符，系統預設將自動採用安全的「本機離線模式」運作。
//
// 實際機密金鑰存放位置：
//   👉 相對路徑：../private/config/firebase-config.js
//
// 上傳與部署指引：
// 1. 若您欲在本地端或私有主機啟用雲端即時同步，請將上述相對路徑之私密檔案
//    複製覆蓋至本相對路徑 (./web/firebase-config.js)。
// 2. 若欲於 GitHub Pages 線上網站啟用雲端連線，可由管理者自行將私密檔案內容
//    上傳至網站根目錄，或於 GitHub Secrets 設定注入，確保 Git 歷史永遠零敏感資訊。
// =========================================================================

window.FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "" // Google Analytics 4 評估 ID (例如: G-XXXXXXXXXX，選填)
};

// 亦可在此獨立指定全域 GA 評估 ID (若未使用 Firebase Analytics)
window.GA_MEASUREMENT_ID = "";

/**
 * 檢查 Firebase 是否已完成實質設定
 * 若未設定，系統自動無縫降級為瀏覽器本機 IndexedDB 快取模式
 */
window.isFirebaseConfigured = function() {
  const cfg = window.FIREBASE_CONFIG;
  return cfg &&
         cfg.apiKey &&
         cfg.apiKey !== "YOUR_API_KEY" &&
         !cfg.apiKey.includes("...") &&
         cfg.projectId &&
         cfg.projectId !== "YOUR_PROJECT_ID";
};
