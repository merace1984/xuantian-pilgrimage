// =========================================================================
// 參拜足跡 核心應用邏輯 (app.js)
// 支援：IndexedDB 本機離線優先 + Firebase 雲端雙向即時同步
// =========================================================================

// === 1. 本地資料庫初始化 (Dexie.js) ===
const db = new Dexie("XuanTianPilgrimageDB");
db.version(1).stores({
  records: "templeId, status, visitDate, updatedAt",
  photos: "++id, templeId, createdAt"
});
db.version(2).stores({
  records: "templeId, status, visitDate, updatedAt",
  photos: "++id, templeId, createdAt",
  itineraries: "id, createdAt, name, status"
});

// === 2. 全域狀態 ===
let userRecordsMap = {};      // templeId -> record
let templePhotosMap = {};     // templeId -> array of { id, dataUrl }
let currentActiveTemple = null;
let currentTempPhotos = [];   // modal 暫存照片

let map = null;
let markersCluster = null;
let markersMap = {};          // templeId -> marker

// 智能路線規劃器狀態
let plannerStartPoint = null;          // { type: 'gps'|'temple'|'custom', name: '', lat: 0, lon: 0 }
let plannerSelectedDistricts = new Set(); // Set of "county:district" e.g. "臺南市:中西區"
let plannerCurrentCounty = "臺南市";
let plannerCalculatedRoute = [];       // array of temple objects in optimized sequence
let activeNavItinerary = null;         // currently active itinerary displayed on map
let activeRoutePolyline = null;
let activeRouteMarkers = [];
let activeRouteStopIndex = 0;

// Firebase 實例與狀態
let fbApp = null;
let fbDb = null;
let fbStorage = null;
let fbAuth = null;
let currentUser = null;
let itinerariesUnsubscribe = null;
let userRecordsUnsubscribe = null;

// 讀取外部設定檔 (firebase-config.js) 注入之管理員白名單，避免將 Email 硬編碼於程式中
function getAllowedAdminEmails() {
  if (Array.isArray(window.ALLOWED_ADMIN_EMAILS)) {
    return window.ALLOWED_ADMIN_EMAILS;
  }
  if (window.FIREBASE_CONFIG && Array.isArray(window.FIREBASE_CONFIG.allowedEmails)) {
    return window.FIREBASE_CONFIG.allowedEmails;
  }
  return [];
}

function isEmailAllowed(email) {
  const allowed = getAllowedAdminEmails();
  // 若未設定白名單（例如本機未配置或公開訪客模式），則不進行前端信箱過濾
  if (!allowed || allowed.length === 0) return true;
  if (!email) return false;
  return allowed.map(e => String(e).toLowerCase().trim()).includes(String(email).toLowerCase().trim());
}

// === 2.5 行動裝置動態可視高度自適應 (防網址列推擠造成底部導覽列隱形) ===
function adjustViewportHeight() {
  const vh = window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${vh}px`);
  if (typeof map !== "undefined" && map) {
    map.invalidateSize();
  }
}
window.addEventListener("resize", adjustViewportHeight);
window.addEventListener("orientationchange", adjustViewportHeight);
adjustViewportHeight();

// === 3. 頁面載入啟動 ===
document.addEventListener("DOMContentLoaded", async () => {
  if (window.lucide) lucide.createIcons();
  updateAuthUI(null);
  
  // 1. 優先同步填入各選單與綁定事件，確保任何狀況下下拉選單皆完整可用
  populateCountySelect();
  bindEvents();
  
  // 2. 載入本地 IndexedDB 快取 (保證 0.1 秒秒開)
  try {
    await loadUserDataFromLocal();
  } catch (err) {
    console.warn("載入本地 IndexedDB 快取異常:", err);
  }
  
  // 3. 初始化地圖與各視圖
  try {
    initMap();
  } catch (err) {
    console.warn("地圖初始化異常:", err);
  }
  renderAllViews();

  // 4. 初始化 Firebase 雲端引擎
  initFirebaseEngine();

  // 5. 初始化 Google Analytics 4 流量追蹤
  initGoogleAnalytics();
});

window.addEventListener("load", () => {
  if (map) map.invalidateSize();
});

// === 3.5 安全防禦與 XSS 過濾器 ===
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeImageUrl(url) {
  if (!url) return "";
  const s = String(url).trim();
  if (s.startsWith("data:image/") || s.startsWith("https://")) {
    return encodeURI(s);
  }
  return "";
}

// === 4. 本地資料庫載入 (Local-First) ===
async function loadUserDataFromLocal() {
  try {
    const allRecords = await db.records.toArray();
    userRecordsMap = {};
    allRecords.forEach(r => {
      userRecordsMap[r.templeId] = r;
    });

    const allPhotos = await db.photos.toArray();
    templePhotosMap = {};
    allPhotos.forEach(p => {
      if (!templePhotosMap[p.templeId]) templePhotosMap[p.templeId] = [];
      templePhotosMap[p.templeId].push(p);
    });

    // 自動校準「規劃中」廟宇狀態與已存行程之一致性
    await reconcilePlannedStatus();
  } catch (err) {
    console.error("載入本地 IndexedDB 失敗:", err);
  }
}

// =========================================================================
// === 4.5 Google Analytics 4 (GA4) 流量統計與事件追蹤模組 ===
// =========================================================================
let gaInitialized = false;

function initGoogleAnalytics() {
  const measurementId = window.GA_MEASUREMENT_ID || 
                        window.FIREBASE_CONFIG?.measurementId;

  if (!measurementId || measurementId.trim() === "" || measurementId.includes("...")) {
    return;
  }

  try {
    // 1. 動態非同步載入 gtag.js
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.appendChild(script);

    // 2. 初始化 dataLayer
    window.dataLayer = window.dataLayer || [];
    window.gtag = function() {
      window.dataLayer.push(arguments);
    };
    window.gtag("js", new Date());

    // 3. 配置 GA4 參數 (若在本地端，加入除錯標記)
    const isLocal = window.location.hostname === "localhost" || 
                    window.location.hostname === "127.0.0.1" || 
                    window.location.protocol === "file:";

    window.gtag("config", measurementId, {
      send_page_view: false, // 改由 SPA 手動精準發送 virtual page view
      debug_mode: isLocal
    });

    gaInitialized = true;
    trackGAPageView("map");
  } catch (err) {
    console.warn("GA4 初始化異常:", err);
  }
}

function trackGAPageView(viewName) {
  const titles = {
    map: "朝聖地圖",
    list: "廟宇名冊",
    planner: "智能路線規劃",
    dashboard: "參拜統計儀表板",
    timeline: "朝聖時間軸",
    settings: "系統設定與備份"
  };
  const title = titles[viewName] || viewName;
  const path = `/#view-${viewName}`;

  if (window.gtag && gaInitialized) {
    window.gtag("event", "page_view", {
      page_title: `參拜足跡 - ${title}`,
      page_path: path,
      page_location: window.location.origin + window.location.pathname + path
    });
  }

  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    console.debug(`[GA4 PageView] ${viewName} (${title}) -> ${path}`);
  }
}

function trackGAEvent(eventName, params = {}) {
  if (window.gtag && gaInitialized) {
    window.gtag("event", eventName, params);
  }
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    console.debug(`[GA4 Event] ${eventName}`, params);
  }
}

// === 5. Firebase 雲端引擎初始化與雙向同步 ===
function initFirebaseEngine() {
  const statusBadge = document.getElementById("cloud-status-badge");
  const indicator = document.getElementById("cloud-indicator");
  const statusText = document.getElementById("cloud-status-text");
  const settingsBadge = document.getElementById("settings-firebase-badge");
  const settingsDesc = document.getElementById("settings-firebase-desc");
  const guideBox = document.getElementById("firebase-guide-box");

  if (!window.isFirebaseConfigured || !window.isFirebaseConfigured()) {
    // 尚未配置 Firebase，自動降級為純本機離線模式
    if (indicator) indicator.className = "w-2 h-2 rounded-full bg-slate-400";
    if (statusText) statusText.textContent = "本機離線模式";
    if (settingsBadge) {
      settingsBadge.className = "text-xs px-2.5 py-1 rounded-full font-bold bg-slate-100 text-slate-600";
      settingsBadge.textContent = "未配置 (本機模式)";
    }
    if (settingsDesc) {
      settingsDesc.textContent = "目前使用瀏覽器本機 IndexedDB 儲存。若需手機拍照隨時上傳並與電腦同步，請依下方說明啟用 Firebase。";
    }
    if (guideBox) guideBox.classList.remove("hidden");
    return;
  }

  try {
    if (!firebase.apps.length) {
      fbApp = firebase.initializeApp(window.FIREBASE_CONFIG);
    } else {
      fbApp = firebase.app();
    }

    fbDb = firebase.firestore();
    fbStorage = firebase.storage();
    fbAuth = firebase.auth();

    // 限制 Firebase Storage 重試逾時上限 (預設 10 分鐘，縮短為 6 秒防呆防凍結)
    if (fbStorage) {
      try {
        fbStorage.setMaxUploadRetryTime(6000);
        fbStorage.setMaxOperationRetryTime(6000);
      } catch (stErr) {
        console.warn("Storage retry 設定警示:", stErr);
      }
    }

    // 啟用 Firestore 離線持久化 (斷網暫存，連網自動同步)
    fbDb.enablePersistence({ synchronizeTabs: true }).catch((err) => {
      console.warn("Firestore 離線快取初始化:", err.code);
    });

    // 監聽登入狀態
    fbAuth.onAuthStateChanged(async (user) => {
      if (user && !isEmailAllowed(user.email)) {
        console.warn("未授權帳號嘗試連線，系統自動登出:", user.email);
        alert(`⚠️【存取權限提醒】\n帳號 (${user.email}) 尚未列於允許訪問名單中。\n\n系統已自動為您登出，如需授權請聯絡系統管理員。`);
        try { await fbAuth.signOut(); } catch (_) {}
        currentUser = null;
        updateAuthUI(null);
        return;
      }
      currentUser = user;
      updateAuthUI(user);
      setupUserDataSync(user);
    });

    // 監聽 Firestore 即時快訊 (Real-time Snapshot)
    fbDb.collection("pilgrimages").onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const data = change.doc.data();
        const tid = change.doc.id;

        if (change.type === "added" || change.type === "modified") {
          userRecordsMap[tid] = data;
          db.records.put(data); // 同步鏡像至本機

          if (data.photos && Array.isArray(data.photos)) {
            const validPhotos = data.photos.filter(p => p.dataUrl && typeof p.dataUrl === "string" && (p.dataUrl.startsWith("http") || p.dataUrl.startsWith("data:image/")));
            if (validPhotos.length > 0) {
              templePhotosMap[tid] = validPhotos;
            }
          }
        } else if (change.type === "removed") {
          delete userRecordsMap[tid];
          delete templePhotosMap[tid];
          db.records.delete(tid);
        }
      });

      renderAllViews();
      setCloudStatus("online", "雲端已連線");
    }, (error) => {
      console.warn("Firestore 監聽失敗 (可能處於離線狀態):", error);
      setCloudStatus("offline", "離線快取中");
    });

    if (settingsBadge) {
      settingsBadge.className = "text-xs px-2.5 py-1 rounded-full font-bold bg-emerald-100 text-emerald-700";
      settingsBadge.textContent = "已連線 (雲端同步中)";
    }
    if (settingsDesc) {
      settingsDesc.textContent = "Firebase 雲端引擎正常運作中，所有打卡、筆記與壓縮照片將自動備份至雲端。";
    }
    if (guideBox) guideBox.classList.add("hidden");

  } catch (e) {
    console.error("Firebase 初始化異常:", e);
    setCloudStatus("offline", "連線失敗");
  }
}

function setCloudStatus(state, text) {
  const indicator = document.getElementById("cloud-indicator");
  const statusText = document.getElementById("cloud-status-text");
  const settingsBadge = document.getElementById("settings-firebase-badge");
  const settingsDesc = document.getElementById("settings-firebase-desc");

  if (indicator) {
    if (state === "online") {
      indicator.className = "w-2 h-2 rounded-full bg-emerald-400";
    } else if (state === "syncing") {
      indicator.className = "w-2 h-2 rounded-full bg-amber-400 animate-ping";
    } else {
      indicator.className = "w-2 h-2 rounded-full bg-rose-400";
    }
  }
  if (statusText) statusText.textContent = text;

  if (settingsBadge) {
    if (state === "online") {
      settingsBadge.className = "text-xs px-2.5 py-1 rounded-full font-bold bg-emerald-100 text-emerald-700";
      settingsBadge.textContent = "🟢 雲端已連線";
    } else if (state === "syncing") {
      settingsBadge.className = "text-xs px-2.5 py-1 rounded-full font-bold bg-amber-100 text-amber-700";
      settingsBadge.textContent = "🟡 同步中...";
    } else {
      settingsBadge.className = "text-xs px-2.5 py-1 rounded-full font-bold bg-rose-100 text-rose-700";
      settingsBadge.textContent = "🔴 離線 / 未連線";
    }
  }
  if (settingsDesc && text) {
    settingsDesc.textContent = `當前狀態：${text}。`;
  }
}

// 使用者個人資料與規劃路線之雲端雙向即時同步
function setupUserDataSync(user) {
  if (itinerariesUnsubscribe) {
    try { itinerariesUnsubscribe(); } catch (_) {}
    itinerariesUnsubscribe = null;
  }
  if (userRecordsUnsubscribe) {
    try { userRecordsUnsubscribe(); } catch (_) {}
    userRecordsUnsubscribe = null;
  }

  if (!user || !fbDb) return;

  // 1. 雙向同步使用者個人規劃路線 (Itineraries)
  try {
    itinerariesUnsubscribe = fbDb.collection("users").doc(user.uid).collection("itineraries")
      .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
          const itin = change.doc.data();
          const id = change.doc.id;
          if (change.type === "added" || change.type === "modified") {
            await db.itineraries.put({ ...itin, id });
          } else if (change.type === "removed") {
            await db.itineraries.delete(id);
          }
        });
        updateSavedItinerariesCount();
        reconcilePlannedStatus();
      }, (err) => {
        console.warn("行程同步監聽提醒:", err);
      });
  } catch (err) {
    console.warn("初始化行程監聽失敗:", err);
  }

  // 2. 雙向同步使用者個人打卡與筆記 (Records)
  try {
    userRecordsUnsubscribe = fbDb.collection("users").doc(user.uid).collection("records")
      .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
          const rec = change.doc.data();
          const tid = change.doc.id;
          if (change.type === "added" || change.type === "modified") {
            userRecordsMap[tid] = rec;
            await db.records.put(rec);
            if (rec.photos && Array.isArray(rec.photos)) {
              const validPhotos = rec.photos.filter(p => p.dataUrl && typeof p.dataUrl === "string" && (p.dataUrl.startsWith("http") || p.dataUrl.startsWith("data:image/")));
              if (validPhotos.length > 0) {
                templePhotosMap[tid] = validPhotos;
                await db.photos.where("templeId").equals(tid).delete();
                await db.photos.bulkAdd(validPhotos);
              }
            }
          } else if (change.type === "removed") {
            delete userRecordsMap[tid];
            delete templePhotosMap[tid];
            await db.records.delete(tid);
            await db.photos.where("templeId").equals(tid).delete();
          }
        });
        renderAllViews();
        reconcilePlannedStatus();
      }, (err) => {
        console.warn("個人紀錄同步監聽提醒:", err);
      });
  } catch (err) {
    console.warn("初始化紀錄監聽失敗:", err);
  }

  // 3. 自動執行本地快取與雲端庫雙向補足對齊 (防止跨裝置登入時資料脫節)
  reconcileLocalDataToCloud(user, false);
}

// === 3.6 本地快取自動對齊並同步至雲端庫 (防止跨裝置進度落差) ===
async function reconcileLocalDataToCloud(user, isManual = false) {
  if (!user || !fbDb) return;
  const syncBtn = document.getElementById("btn-force-sync");
  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.innerHTML = '<span class="inline-block animate-spin mr-1">🔄</span>同步中...';
  }
  setCloudStatus("syncing", "雲端對齊中...");

  try {
    const localRecords = await db.records.toArray();
    const localItineraries = await db.itineraries.toArray();

    // 1. 同步本機已參拜紀錄與相片至雲端
    if (localRecords.length > 0) {
      for (const rec of localRecords) {
        // 從本機 db.photos 獲取該廟宇完整相片快取 (含 Base64)
        const realPhotos = await db.photos.where("templeId").equals(rec.templeId).toArray();
        let photosUpdated = false;

        // 若啟用 Cloud Storage，嘗試將尚未上傳的 Base64 相片上傳轉成永久 URL
        if (fbStorage && realPhotos.length > 0) {
          for (let i = 0; i < realPhotos.length; i++) {
            const p = realPhotos[i];
            if (p.dataUrl && !p.dataUrl.startsWith("http") && p.dataUrl.startsWith("data:image/")) {
              try {
                const blob = dataURLtoBlob(p.dataUrl);
                if (blob) {
                  const fileName = `photo_${Date.now()}_${i}.webp`;
                  const storageRef = fbStorage.ref(`photos/${rec.templeId}/${fileName}`);
                  await withTimeout(
                    storageRef.put(blob, { contentType: blob.type || "image/webp" }),
                    8000,
                    "相片雲端上傳逾時"
                  );
                  const downloadUrl = await withTimeout(
                    storageRef.getDownloadURL(),
                    5000,
                    "取得相片下載網址逾時"
                  );
                  p.dataUrl = downloadUrl;
                  photosUpdated = true;
                }
              } catch (upErr) {
                console.warn(`同步上傳相片第 ${i + 1} 張略過:`, upErr);
              }
            }
          }
        }

        // 若有相片成功轉為雲端 URL，同步更新本機資料庫
        if (photosUpdated) {
          await db.photos.where("templeId").equals(rec.templeId).delete();
          await db.photos.bulkAdd(realPhotos);
          templePhotosMap[rec.templeId] = realPhotos;
          rec.photos = realPhotos;
          await db.records.put(rec);
          userRecordsMap[rec.templeId] = rec;
        }

        const firestoreRecord = {
          ...rec
        };

        // 關鍵安全防護：只有當本機確實持有相片快取時，才更新雲端的 photos 陣列；
        // 嚴格防止剛登入的手機端因本機尚無照片快取，而將雲端既有的相片覆蓋成空陣列！
        if (realPhotos && realPhotos.length > 0) {
          const totalBase64Length = realPhotos.reduce((sum, p) => sum + (p.dataUrl?.length || 0), 0);
          const allowDirectFirestorePhotos = totalBase64Length < 680000;
          firestoreRecord.photos = realPhotos.map(p => {
            if (p.dataUrl && (p.dataUrl.startsWith("http") || allowDirectFirestorePhotos)) return p;
            return {
              templeId: p.templeId,
              isLocalCache: true,
              createdAt: p.createdAt || new Date().toISOString()
            };
          });
        } else {
          // 本機無相片快取，不包含 photos 欄位，由 Firestore { merge: true } 妥善保留雲端既有相片
          delete firestoreRecord.photos;
        }
        await withTimeout(
          Promise.all([
            fbDb.collection("users").doc(user.uid).collection("records").doc(rec.templeId).set(firestoreRecord, { merge: true }),
            fbDb.collection("pilgrimages").doc(rec.templeId).set(firestoreRecord, { merge: true })
          ]),
          6000,
          "同步雲端紀錄逾時"
        );
      }
    }

    // 2. 同步本機規劃行程至雲端
    if (localItineraries.length > 0) {
      for (const itin of localItineraries) {
        await withTimeout(
          fbDb.collection("users").doc(user.uid).collection("itineraries").doc(itin.id).set(itin, { merge: true }),
          5000,
          "同步雲端行程逾時"
        );
      }
    }

    setCloudStatus("online", `雲端已連線 (${localRecords.length} 筆同步)`);
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.innerHTML = '<i data-lucide="refresh-cw" class="w-4 h-4"></i> 立即強制同步';
      if (window.lucide) lucide.createIcons();
    }
    if (isManual) {
      alert(`✅ 雲端雙向同步成功！已將本機 ${localRecords.length} 筆打卡紀錄與 ${localItineraries.length} 條自訂行程完整推播至雲端庫。`);
    }
  } catch (err) {
    console.warn("自動對齊雲端紀錄提醒:", err);
    const errMsg = String(err?.message || err);
    if (errMsg.includes("NOT_FOUND") || errMsg.includes("does not exist") || errMsg.includes("404")) {
      setCloudStatus("offline", "資料庫未建立");
      if (isManual) {
        alert("⚠️ 雲端資料庫尚未在 Firebase 建立！\n\n檢測到您的 Firebase 專案中尚未建立 Cloud Firestore 資料庫。\n請依照「設定備份」頁面中的說明前往 Firebase Console 啟用 Firestore，才能跨裝置同步。");
      }
    } else {
      setCloudStatus("offline", "連線延遲 (已存本地)");
      if (isManual) {
        alert("⚠️ 雲端同步提醒：網路連線稍有延遲或權限設定中，本機資料已安全保存。");
      }
    }
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.innerHTML = '<i data-lucide="refresh-cw" class="w-4 h-4"></i> 重新嘗試同步';
      if (window.lucide) lucide.createIcons();
    }
  }
}

window.forceSyncNow = function() {
  if (!currentUser) {
    alert("權限不足：請先登入 Google 帳號後才能進行雲端同步！");
    return;
  }
  reconcileLocalDataToCloud(currentUser, true);
};

function updateAuthUI(user) {
  const btnLogin = document.getElementById("btn-login");
  const userProfile = document.getElementById("user-profile");
  const userAvatar = document.getElementById("user-avatar");
  const plannerLockedBox = document.getElementById("planner-locked-box");
  const plannerContentBox = document.getElementById("planner-content-box");
  const settingsLockedBox = document.getElementById("settings-locked-box");
  const settingsContentBox = document.getElementById("settings-content-box");
  const settingsUserEmail = document.getElementById("settings-user-email");

  if (user) {
    if (btnLogin) btnLogin.classList.add("hidden");
    if (userProfile) {
      userProfile.classList.remove("hidden");
      userProfile.classList.add("flex");
    }
    if (userAvatar) userAvatar.src = user.photoURL || "https://ui-avatars.com/api/?name=" + encodeURIComponent(user.displayName || "User");
    
    // 路線規劃解鎖
    if (plannerLockedBox) plannerLockedBox.classList.add("hidden");
    if (plannerContentBox) plannerContentBox.classList.remove("hidden");

    // 設定頁解鎖
    if (settingsLockedBox) settingsLockedBox.classList.add("hidden");
    if (settingsContentBox) settingsContentBox.classList.remove("hidden");
    if (settingsUserEmail) settingsUserEmail.textContent = user.email || user.displayName || "管理員已連線";
  } else {
    if (btnLogin) btnLogin.classList.remove("hidden");
    if (userProfile) {
      userProfile.classList.add("hidden");
      userProfile.classList.remove("flex");
    }
    
    // 路線規劃鎖定
    if (plannerLockedBox) plannerLockedBox.classList.remove("hidden");
    if (plannerContentBox) plannerContentBox.classList.add("hidden");

    // 設定頁鎖定
    if (settingsLockedBox) settingsLockedBox.classList.remove("hidden");
    if (settingsContentBox) settingsContentBox.classList.add("hidden");

    // 若有活動中導航抽屜，登出時關閉並清理地圖路線折線
    if (activeNavItinerary) {
      closeRouteNavDrawer();
      clearRouteLayersOnly();
    }
  }

  // 若當前廟宇彈窗開啟中，即時重新套用權限模式
  const modal = document.getElementById("temple-modal");
  if (currentActiveTemple && modal && !modal.classList.contains("hidden")) {
    openTempleModal(currentActiveTemple.id);
  }

  if (window.lucide) lucide.createIcons();
}

// Google 登入
async function loginWithGoogle() {
  if (!window.isFirebaseConfigured || !window.isFirebaseConfigured()) {
    alert("目前尚未設定 Firebase 雲端金鑰。\n\n請依照指引在 private/config/firebase-config.js 填入您的 Firebase 專案設定並重新啟動本地伺服器，或在 GitHub Secrets 設定，即可啟用 Google 帳號管理員驗證！");
    return;
  }
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    const result = await fbAuth.signInWithPopup(provider);
    const user = result.user;
    if (!isEmailAllowed(user.email)) {
      alert(`⚠️【存取權限提醒】\n帳號 (${user.email}) 尚未列於允許訪問名單中。\n\n系統已自動為您登出，如需授權請聯絡系統管理員。`);
      try { await fbAuth.signOut(); } catch (_) {}
      currentUser = null;
      updateAuthUI(null);
      return;
    }
    currentUser = user;
    updateAuthUI(currentUser);
    setupUserDataSync(currentUser);
    trackGAEvent("login", { method: "Google" });
    alert("🎉 登入成功！已驗證管理員身分，開啟設定與編輯權限。");
  } catch (err) {
    console.error("Google 登入失敗:", err);
    if (err.code === "auth/popup-blocked") {
      alert("⚠️ 登入視窗被瀏覽器封鎖，請允許本網站開啟彈出式視窗後重試。");
    } else if (err.code === "auth/unauthorized-domain") {
      alert("⚠️ 授權網域未設定：當前網站網域尚未加入 Firebase Authentication 授權網域白名單。\n\n請至 Firebase Console > Authentication > Settings > Authorized Domains 新增目前網址（如 localhost 或 GitHub Pages 網址）。");
    } else if (err.code === "auth/configuration-not-found" || err.message?.includes("configuration-not-found")) {
      alert("⚠️ 登入提供者尚未啟用：Firebase 後台尚未開啟「Google 登入」。\n\n請前往 Firebase Console > Authentication > Sign-in method，點選「Google」切換為「啟用」，選取專案支援電子郵件並點擊「儲存」，即可立即生效！");
    } else {
      alert("登入失敗: " + err.message);
    }
  }
}

// Google 登出
async function logoutGoogle() {
  if (fbAuth) {
    if (itinerariesUnsubscribe) {
      try { itinerariesUnsubscribe(); } catch (_) {}
      itinerariesUnsubscribe = null;
    }
    if (userRecordsUnsubscribe) {
      try { userRecordsUnsubscribe(); } catch (_) {}
      userRecordsUnsubscribe = null;
    }
    await fbAuth.signOut();
    currentUser = null;
    updateAuthUI(null);
    trackGAEvent("logout", {});
    alert("已登出 Google 帳號。目前切換為訪客唯讀狀態。");
  }
}

// === 6. 地圖核心邏輯 (Leaflet) ===
function initMap() {
  const mapContainer = document.getElementById("map");
  if (!mapContainer) return;

  const googleStreet = L.tileLayer("https://mt{s}.google.com/vt/lyrs=m&hl=zh-TW&x={x}&y={y}&z={z}", {
    subdomains: ["0", "1", "2", "3"],
    attribution: '&copy; Google Maps',
    maxZoom: 20
  });

  const nlscEmap = L.tileLayer("https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}", {
    attribution: '&copy; <a href="https://maps.nlsc.gov.tw/">內政部國土測繪圖資服務雲</a>',
    maxZoom: 20
  });

  const osmStandard = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19
  });

  const cartoVoyager = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", {
    subdomains: "abcd",
    attribution: '&copy; CARTO &copy; OSM',
    maxZoom: 19
  });

  map = L.map("map", {
    center: [23.5, 120.8],
    zoom: 8,
    layers: [osmStandard],
    zoomControl: false,
    scrollWheelZoom: true
  });

  // 將縮放控制項移至右下角 (bottomright)，徹底避開左上角搜尋與篩選面板
  L.control.zoom({ position: "bottomright" }).addTo(map);

  const baseLayers = {
    "OpenStreetMap 標準圖 (預設)": osmStandard,
    "Google 街道圖": googleStreet,
    "臺灣通用電子地圖 (國土測繪)": nlscEmap,
    "Carto 典雅淺色圖": cartoVoyager
  };
  L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);

  markersCluster = L.markerClusterGroup({
    maxClusterRadius: 45,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true
  });

  map.addLayer(markersCluster);
  renderMapMarkers();

  setTimeout(() => map.invalidateSize(), 50);
  setTimeout(() => map.invalidateSize(), 250);
  setTimeout(() => map.invalidateSize(), 600);
}

window.addEventListener("resize", () => {
  if (map) map.invalidateSize();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && map) {
    map.invalidateSize();
  }
});

function createPinIcon(status) {
  let bgColor = "#1b3b52";
  let borderColor = "#ffffff";

  if (status === "visited") {
    bgColor = "#059669";
    borderColor = "#a7f3d0";
  } else if (status === "planned") {
    bgColor = "#d97706";
    borderColor = "#fde68a";
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="30" height="30">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.3"/>
        </filter>
      </defs>
      <path fill="${bgColor}" stroke="${borderColor}" stroke-width="1.8" filter="url(#shadow)"
        d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
      <circle cx="12" cy="9" r="3.2" fill="#ffffff" />
    </svg>
  `;

  return L.divIcon({
    html: svg,
    className: "custom-temple-pin",
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28]
  });
}

function renderMapMarkers() {
  if (!markersCluster) return;
  markersCluster.clearLayers();
  markersMap = {};

  const countyFilter = document.getElementById("filter-county")?.value || "";
  const statusFilter = document.getElementById("filter-status")?.value || "all";
  const searchKey = document.getElementById("map-search")?.value.trim().toLowerCase() || "";

  let visibleCount = 0;

  TEMPLES_DATA.forEach(t => {
    if (!t.lat || !t.lon) return;

    const record = userRecordsMap[t.id];
    const status = record?.status || "unvisited";

    if (countyFilter && t.county !== countyFilter) return;
    if (statusFilter !== "all" && status !== statusFilter) return;
    if (searchKey) {
      const match = t.name.toLowerCase().includes(searchKey) ||
                    t.district.toLowerCase().includes(searchKey) ||
                    t.address.toLowerCase().includes(searchKey);
      if (!match) return;
    }

    visibleCount++;
    const icon = createPinIcon(status);
    const marker = L.marker([t.lat, t.lon], { icon });

    const statusLabel = status === "visited" ? '<span class="inline-flex items-center gap-1 text-emerald-700 bg-emerald-100 font-bold px-2 py-0.5 rounded-full text-[11px]">🟢 已參拜</span>' :
                        status === "planned" ? '<span class="inline-flex items-center gap-1 text-amber-700 bg-amber-100 font-bold px-2 py-0.5 rounded-full text-[11px]">🟡 規劃中</span>' :
                        '<span class="inline-flex items-center gap-1 text-slate-600 bg-slate-100 font-bold px-2 py-0.5 rounded-full text-[11px]">⚪ 未參拜</span>';

    const popupHtml = `
      <div class="text-xs space-y-2.5 font-sans w-[280px] sm:w-[310px] select-text">
        <!-- 頂部標題列：廟名享有完整空間，右側預留 pr-8 避讓關閉按鈕 -->
        <div class="pr-8">
          <strong class="text-[15px] font-bold text-slate-900 leading-snug tracking-tight block">${escapeHtml(t.name)}</strong>
        </div>

        <!-- 狀態與縣市行政區列：徹底垂直分離於關閉按鈕下方，完全避免重疊與誤觸 -->
        <div class="flex items-center gap-2 flex-wrap">
          ${statusLabel}
          <span class="text-slate-500 font-medium text-xs flex items-center gap-1">
            <span class="w-1 h-1 rounded-full bg-slate-300"></span>
            ${escapeHtml(t.county)} ${escapeHtml(t.district)}
          </span>
        </div>

        <!-- 地址欄位：卡片化淺底色與圖示襯托，完整清晰折行 -->
        <div class="text-[12px] text-slate-600 leading-relaxed break-words bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-100 flex items-start gap-1.5">
          <span class="shrink-0 text-slate-400 mt-0.5">📍</span>
          <span>${escapeHtml(t.address || "無詳細地址紀錄")}</span>
        </div>

        <!-- 操作按鈕列：擴大觸控面積與圓角質感 -->
        <div class="flex gap-2 pt-1">
          <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(t.lat)},${encodeURIComponent(t.lon)}" target="_blank"
             class="flex-1 text-center py-2 bg-sky-500 hover:bg-sky-600 active:scale-95 text-white rounded-xl font-bold text-xs shadow-sm transition flex items-center justify-center gap-1">
            <span>導航</span>
          </a>
          <button onclick="openTempleModal('${escapeHtml(t.id)}')"
             class="flex-1 py-2 bg-brand-600 hover:bg-brand-500 active:scale-95 text-white rounded-xl font-bold text-xs shadow-sm transition flex items-center justify-center gap-1">
            <span>打卡記事</span>
          </button>
        </div>
      </div>
    `;

    marker.bindPopup(popupHtml, {
      minWidth: 280,
      maxWidth: 350,
      autoPanPadding: [30, 30]
    });
    markersCluster.addLayer(marker);
    markersMap[t.id] = marker;
  });

  const countBadge = document.getElementById("filtered-count");
  if (countBadge) countBadge.textContent = visibleCount;
}

function populateCountySelect() {
  const mapSelect = document.getElementById("filter-county");
  const listSelect = document.getElementById("list-filter-county");

  const countyCounts = {};
  TEMPLES_DATA.forEach(t => {
    countyCounts[t.county] = (countyCounts[t.county] || 0) + 1;
  });

  const sorted = Object.entries(countyCounts).sort((a, b) => b[1] - a[1]);
  const optionsHtml = '<option value="">全部縣市 (732)</option>' +
    sorted.map(([c, cnt]) => `<option value="${c}">${c} (${cnt})</option>`).join("");

  if (mapSelect) {
    const cur = mapSelect.value;
    mapSelect.innerHTML = optionsHtml;
    if (cur) mapSelect.value = cur;
  }
  if (listSelect) {
    const cur = listSelect.value;
    listSelect.innerHTML = optionsHtml;
    if (cur) listSelect.value = cur;
  }
}

function updateListDistrictSelect(selectedCounty) {
  const districtSelect = document.getElementById("list-filter-district");
  if (!districtSelect) return;

  if (!selectedCounty) {
    districtSelect.innerHTML = '<option value="">請先選擇縣市</option>';
    districtSelect.disabled = true;
    districtSelect.value = "";
    return;
  }

  const districtCounts = {};
  let totalInCounty = 0;
  TEMPLES_DATA.forEach(t => {
    if (t.county === selectedCounty) {
      totalInCounty++;
      districtCounts[t.district] = (districtCounts[t.district] || 0) + 1;
    }
  });

  const sorted = Object.entries(districtCounts).sort((a, b) => b[1] - a[1]);
  districtSelect.innerHTML = `<option value="">全部鄉鎮市區 (${totalInCounty})</option>` +
    sorted.map(([d, cnt]) => `<option value="${d}">${d} (${cnt})</option>`).join("");
  districtSelect.disabled = false;
  districtSelect.value = "";
}

window.quickFilterList = function(countyName) {
  const countySelect = document.getElementById("list-filter-county");
  if (countySelect) {
    if (countySelect.options.length <= 1) {
      populateCountySelect();
    }
    countySelect.value = countyName;
    updateListDistrictSelect(countyName);
    renderListView();
  }
};

window.switchCounty = function(countyName) {
  const select = document.getElementById("filter-county");
  if (select) {
    select.value = countyName;
    renderMapMarkers();
    flyToCounty(countyName);
  }
};

function flyToCounty(countyName) {
  const targetTemples = TEMPLES_DATA.filter(t => t.county === countyName && t.lat && t.lon);
  if (targetTemples.length > 0 && map) {
    const group = L.featureGroup(targetTemples.map(t => L.marker([t.lat, t.lon])));
    map.fitBounds(group.getBounds().pad(0.15));
  }
}

// === 7. 視圖切換 (Tab Switcher) ===
window.switchView = function(viewName) {
  const views = ["map", "list", "planner", "dashboard", "timeline", "settings"];
  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.classList.toggle("hidden", v !== viewName);
  });

  document.querySelectorAll(".nav-tab").forEach(tab => {
    const isTarget = tab.getAttribute("onclick")?.includes(`'${viewName}'`);
    if (isTarget) {
      tab.classList.add("bg-amber-100/70", "text-brand-600", "font-bold");
      tab.classList.remove("text-slate-500", "hover:bg-slate-50", "font-medium");
    } else {
      tab.classList.remove("bg-amber-100/70", "text-brand-600", "font-bold");
      tab.classList.add("text-slate-500", "hover:bg-slate-50", "font-medium");
    }
  });

  // 發送 GA4 虛擬頁面瀏覽 (Virtual Page View)
  trackGAPageView(viewName);

  if (viewName === "map") {
    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 100);
  } else if (viewName === "list") {
    renderListView();
  } else if (viewName === "planner") {
    initPlannerView();
  } else if (viewName === "dashboard") {
    renderDashboardView();
  } else if (viewName === "timeline") {
    renderTimelineView();
  }
};

// === 8. 廟宇打卡視窗與相片上傳處理 ===
window.openTempleModal = async function(templeId) {
  const t = TEMPLES_DATA.find(x => x.id === templeId);
  if (!t) return;

  currentActiveTemple = t;

  // 發送 GA4 廟宇詳情檢視事件
  trackGAEvent("temple_detail_view", {
    temple_id: t.id,
    temple_name: t.name,
    county: t.county,
    district: t.district
  });
  const record = userRecordsMap[templeId] || {
    status: "unvisited",
    visitDate: "",
    tags: "",
    notes: ""
  };

  currentTempPhotos = [...(templePhotosMap[templeId] || [])];

  document.getElementById("modal-title").textContent = t.name;
  document.getElementById("modal-county-district").textContent = `${t.county} ${t.district}`;
  document.getElementById("modal-address").textContent = t.address || "無詳細地址";
  document.getElementById("meta-main-deity").textContent = t.mainDeity || "玄天上帝";
  document.getElementById("meta-year").textContent = t.year ? `${t.year} 年` : "未詳載";
  document.getElementById("meta-source").href = t.sourceUrl || "#";

  const navBtn = document.getElementById("btn-navigate");
  if (t.lat && t.lon) {
    navBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lon}`;
    navBtn.classList.remove("opacity-50", "pointer-events-none");
  } else {
    navBtn.href = "#";
    navBtn.classList.add("opacity-50", "pointer-events-none");
  }

  updateModalStatusBadge(record.status);

  // 權限控管：判斷是否具備管理員編輯權限
  const actionBar = document.getElementById("modal-action-bar");
  const toggleBtn = document.getElementById("btn-toggle-status");
  const visitorBanner = document.getElementById("modal-visitor-banner");
  const readonlyRecord = document.getElementById("modal-readonly-record");
  const editBox = document.getElementById("modal-edit-box");
  const footerEdit = document.getElementById("modal-footer-edit");
  const footerReadonly = document.getElementById("modal-footer-readonly");

  if (currentUser) {
    // === 管理者模式：解鎖編輯、上傳與刪除權限 ===
    if (actionBar) actionBar.className = "grid grid-cols-2 gap-3";
    if (toggleBtn) toggleBtn.classList.remove("hidden");
    if (visitorBanner) visitorBanner.classList.add("hidden");
    if (readonlyRecord) readonlyRecord.classList.add("hidden");
    if (editBox) editBox.classList.remove("hidden");
    if (footerEdit) footerEdit.classList.remove("hidden");
    if (footerReadonly) footerReadonly.classList.add("hidden");

    document.getElementById("input-visit-date").value = record.visitDate || new Date().toISOString().slice(0, 10);
    document.getElementById("input-tag").value = record.tags || "";
    document.getElementById("input-notes").value = record.notes || "";
    renderModalPhotos();
  } else {
    // === 訪客模式：唯讀展示，隱藏所有編輯與儲存元件 ===
    if (actionBar) actionBar.className = "grid grid-cols-1 gap-3";
    if (toggleBtn) toggleBtn.classList.add("hidden");
    if (visitorBanner) visitorBanner.classList.remove("hidden");
    if (editBox) editBox.classList.add("hidden");
    if (footerEdit) footerEdit.classList.add("hidden");
    if (footerReadonly) footerReadonly.classList.remove("hidden");

    // 若本廟有既有參拜紀錄或相片，展示唯讀內容
    if (record.status === "visited" || (currentTempPhotos && currentTempPhotos.length > 0) || record.notes) {
      if (readonlyRecord) {
        readonlyRecord.classList.remove("hidden");
        const metaEl = document.getElementById("modal-readonly-meta");
        const notesEl = document.getElementById("modal-readonly-notes");
        const photosEl = document.getElementById("modal-readonly-photos");

        if (metaEl) {
          metaEl.innerHTML = `
            ${record.visitDate ? `<span class="text-[11px] bg-brand-gold/20 text-brand-600 font-bold px-2 py-0.5 rounded-full">📅 ${escapeHtml(record.visitDate)}</span>` : ''}
            ${record.tags ? `<span class="text-[11px] bg-slate-200 text-slate-700 px-2 py-0.5 rounded-md">🏷️ ${escapeHtml(record.tags)}</span>` : ''}
          `;
        }

        if (notesEl) {
          notesEl.textContent = (record.notes && record.notes.trim()) ? record.notes.trim() : "（未留下心得筆記）";
        }

        if (photosEl) {
          const validVisiblePhotos = currentTempPhotos.filter(p => p.dataUrl && typeof p.dataUrl === "string" && p.dataUrl.length > 0);
          if (validVisiblePhotos.length > 0) {
            photosEl.innerHTML = validVisiblePhotos.map(p => {
              const safeUrl = sanitizeImageUrl(p.dataUrl);
              if (!safeUrl) return '';
              return `
                <div class="aspect-square rounded-xl overflow-hidden border border-slate-200 bg-slate-100 shadow-sm">
                  <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="block w-full h-full">
                    <img src="${safeUrl}" class="w-full h-full object-cover hover:scale-105 transition duration-300" alt="相片" />
                  </a>
                </div>
              `;
            }).join("");
          } else {
            photosEl.innerHTML = '<p class="col-span-3 text-center text-xs text-slate-400 py-2">無現場相片</p>';
          }
        }
      }
    } else {
      if (readonlyRecord) readonlyRecord.classList.add("hidden");
    }
  }

  document.getElementById("temple-modal").classList.remove("hidden");
  if (window.lucide) lucide.createIcons();
};

function updateModalStatusBadge(status) {
  const badge = document.getElementById("modal-status-badge");
  const toggleBtn = document.getElementById("btn-toggle-status");

  if (status === "visited") {
    badge.className = "text-xs font-semibold px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700";
    badge.textContent = "🟢 已參拜";
    toggleBtn.innerHTML = '<i data-lucide="check-check" class="w-4 h-4"></i> 改為規劃中';
    toggleBtn.className = "flex items-center justify-center gap-2 py-2.5 px-4 bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-bold text-sm shadow transition";
  } else if (status === "planned") {
    badge.className = "text-xs font-semibold px-2 py-0.5 rounded-md bg-amber-100 text-amber-700";
    badge.textContent = "🟡 規劃中";
    toggleBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i> 標記為已參拜';
    toggleBtn.className = "flex items-center justify-center gap-2 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm shadow transition";
  } else {
    badge.className = "text-xs font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-600";
    badge.textContent = "⚪ 未參拜";
    toggleBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i> 標記為已參拜';
    toggleBtn.className = "flex items-center justify-center gap-2 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm shadow transition";
  }
  if (window.lucide) lucide.createIcons();
}

function renderModalPhotos() {
  const container = document.getElementById("photos-container");
  if (!container) return;

  const validPhotos = currentTempPhotos.filter(p => p.dataUrl && typeof p.dataUrl === "string" && p.dataUrl.length > 0);

  if (validPhotos.length === 0) {
    container.innerHTML = '<p id="no-photos-hint" class="col-span-3 text-center text-xs text-slate-400 py-4">尚未上傳照片</p>';
    return;
  }

  container.innerHTML = validPhotos.map((p, idx) => {
    const safeUrl = sanitizeImageUrl(p.dataUrl);
    if (!safeUrl) return '';
    // 找到原始索引以確保刪除操作正確
    const originalIdx = currentTempPhotos.indexOf(p);
    return `
    <div class="relative group rounded-lg overflow-hidden border border-slate-200 aspect-square bg-slate-100">
      <img src="${safeUrl}" class="w-full h-full object-cover" />
      <button onclick="removePhoto(${originalIdx})" class="absolute top-1 right-1 bg-black/70 hover:bg-rose-600 text-white p-1 rounded-full text-[10px] transition">
        ✕
      </button>
    </div>
  `;
  }).join("");
}

window.removePhoto = function(index) {
  currentTempPhotos.splice(index, 1);
  renderModalPhotos();
};

async function compressImage(file, maxDimension = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (e) => {
      const img = new Image();
      img.src = e.target.result;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height && width > maxDimension) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else if (height > maxDimension) {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        const compressedDataUrl = canvas.toDataURL("image/webp", quality);
        resolve(compressedDataUrl);
      };
      img.onerror = reject;
    };
    reader.onerror = reject;
  });
}

// 通用非同步逾時保護工具，確保網路或 Storage 異常時絕不阻塞主執行緒
function withTimeout(promise, ms = 6000, errorMsg = "操作逾時") {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMsg)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// 輔助：將 Base64 DataURL 轉成 Blob 供 Firebase Storage 上傳
function dataURLtoBlob(dataurl) {
  if (!dataurl || typeof dataurl !== "string") return null;
  const parts = dataurl.split(',');
  if (parts.length < 2) return null;
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : "image/webp";
  try {
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  } catch (e) {
    console.warn("Base64 轉 Blob 失敗:", e);
    return null;
  }
}

// 儲存紀錄 (採 Local-First 離線優先架構，保證本地秒存永不遺失，雲端非同步同步)
async function saveCurrentRecord() {
  if (!currentUser) {
    alert("權限不足：請先使用 Google 帳號登入後才能儲存參拜紀錄！");
    return;
  }
  if (!currentActiveTemple) return;
  const tid = currentActiveTemple.id;

  const existing = userRecordsMap[tid];
  const visitDate = document.getElementById("input-visit-date").value;
  const tags = document.getElementById("input-tag").value.trim();
  const notes = document.getElementById("input-notes").value.trim();

  let status = existing?.status || "visited";
  if (status === "unvisited") status = "visited";

  const saveBtn = document.getElementById("btn-save-record");
  if (!saveBtn) return;
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="inline-block animate-spin mr-1">⏳</span>正在保存本地快取...';

  let cloudPhotoUploadedCount = 0;
  let cloudPhotoFailed = false;
  let cloudSyncFailed = false;

  try {
    // ---------------------------------------------------------
    // 步驟 1：【本機優先】第一時間寫入本地 IndexedDB (秒級完成，保證資料永不卡死)
    // ---------------------------------------------------------
    const localPhotos = currentTempPhotos.map(p => ({
      templeId: tid,
      dataUrl: p.dataUrl,
      createdAt: p.createdAt || new Date().toISOString()
    }));

    const record = {
      templeId: tid,
      templeName: currentActiveTemple.name,
      county: currentActiveTemple.county,
      district: currentActiveTemple.district,
      status,
      visitDate,
      tags,
      notes,
      photos: localPhotos,
      userId: currentUser ? currentUser.uid : null,
      updatedAt: new Date().toISOString()
    };

    // 寫入本地 Dexie IndexedDB
    await db.records.put(record);
    userRecordsMap[tid] = record;

    await db.photos.where("templeId").equals(tid).delete();
    if (localPhotos.length > 0) {
      await db.photos.bulkAdd(localPhotos);
      templePhotosMap[tid] = localPhotos;
    } else {
      delete templePhotosMap[tid];
    }

    // ---------------------------------------------------------
    // 步驟 2：【雲端相片同步】若啟用 Firebase 且有相片，嘗試上傳至 Cloud Storage
    // ---------------------------------------------------------
    const isCloudEnabled = fbStorage && fbDb && currentUser;

    if (isCloudEnabled && localPhotos.length > 0) {
      saveBtn.innerHTML = '<span class="inline-block animate-spin mr-1">☁️</span>正在同步雲端相片...';
      setCloudStatus("syncing", "同步相片中...");

      for (let i = 0; i < localPhotos.length; i++) {
        const p = localPhotos[i];
        if (p.dataUrl && p.dataUrl.startsWith("http")) {
          // 已經是遠端網址
          cloudPhotoUploadedCount++;
          continue;
        }

        // 本地 Base64，嘗試上傳至 Firebase Cloud Storage (單張最長 6 秒逾時防凍結)
        try {
          const blob = dataURLtoBlob(p.dataUrl);
          if (!blob) {
            console.warn(`第 ${i + 1} 張相片轉換 Blob 失敗，保留本機快取`);
            continue;
          }
          const fileName = `photo_${Date.now()}_${i}.webp`;
          const storageRef = fbStorage.ref(`photos/${tid}/${fileName}`);

          await withTimeout(
            storageRef.put(blob, { contentType: blob.type || "image/webp" }),
            6000,
            "Cloud Storage 上傳逾時"
          );

          const downloadUrl = await withTimeout(
            storageRef.getDownloadURL(),
            4000,
            "取得相片下載網址逾時"
          );

          p.dataUrl = downloadUrl;
          cloudPhotoUploadedCount++;
        } catch (uploadErr) {
          console.warn(`第 ${i + 1} 張相片雲端上傳略過或逾時 (已妥善保留本機 WebP 快取):`, uploadErr);
          cloudPhotoFailed = true;
        }
      }

      // 若有相片成功轉為雲端 URL，更新本地 IndexedDB 中對應的 URL
      if (cloudPhotoUploadedCount > 0) {
        record.photos = localPhotos;
        await db.records.put(record);
        await db.photos.where("templeId").equals(tid).delete();
        await db.photos.bulkAdd(localPhotos);
        userRecordsMap[tid] = record;
        templePhotosMap[tid] = localPhotos;
      }
    }

    // ---------------------------------------------------------
    // 步驟 3：【Firestore 雲端寫入】同步紀錄至個人專屬庫與全域鏡像
    // ---------------------------------------------------------
    if (isCloudEnabled) {
      saveBtn.innerHTML = '<span class="inline-block animate-spin mr-1">☁️</span>同步雲端紀錄中...';
      setCloudStatus("syncing", "同步紀錄中...");

      // 體積安全檢驗：若整體相片體積小於 680KB (安全低於 Firestore 1MB 限制)，直接將 Base64 實體寫入 Firestore 達成跨裝置無縫同步
      const totalBase64Length = (record.photos || []).reduce((sum, p) => sum + (p.dataUrl?.length || 0), 0);
      const allowDirectFirestorePhotos = totalBase64Length < 680000;

      const firestoreRecord = {
        ...record,
        photos: (record.photos || []).map(p => {
          if (p.dataUrl && (p.dataUrl.startsWith("http") || allowDirectFirestorePhotos)) {
            return p;
          }
          return {
            templeId: p.templeId,
            isLocalCache: true,
            createdAt: p.createdAt || new Date().toISOString()
          };
        })
      };

      try {
        await withTimeout(
          Promise.all([
            fbDb.collection("users").doc(currentUser.uid).collection("records").doc(tid).set(firestoreRecord, { merge: true }),
            fbDb.collection("pilgrimages").doc(tid).set(firestoreRecord, { merge: true })
          ]),
          5000,
          "Firestore 寫入逾時"
        );
        setCloudStatus("online", "雲端已連線");
      } catch (fsErr) {
        console.warn("Firestore 同步提醒 (本地已優先安全儲存):", fsErr);
        cloudSyncFailed = true;
        setCloudStatus("offline", "雲端連線延遲 (已存本地)");
      }
    }

    // 若當前有活動行程且打卡為目前站點，自動推進至下一站
    if (activeNavItinerary && record.status === "visited") {
      const stops = activeNavItinerary.templeIds;
      if (stops[activeRouteStopIndex] === tid) {
        activeRouteStopIndex++;
      }
      updateRouteNavDrawer();
    }

    // 發送 GA4 參拜打卡紀錄事件
    trackGAEvent("pilgrimage_checkin", {
      temple_id: tid,
      temple_name: currentActiveTemple.name,
      county: currentActiveTemple.county,
      district: currentActiveTemple.district,
      status: status,
      has_notes: !!notes,
      photos_count: localPhotos.length
    });

    // 關閉 Modal 並重新渲染所有視圖
    const modal = document.getElementById("temple-modal");
    if (modal) modal.classList.add("hidden");
    renderAllViews();

    // 提示回饋
    if (!isCloudEnabled) {
      alert("🎉 參拜紀錄與相片已成功儲存於本機！");
    } else if (cloudPhotoFailed || cloudSyncFailed) {
      alert("🎉 參拜紀錄與相片已安全保存於本機！\n\n💡 提示：因雲端連線逾時或權限問題，相片已轉為瀏覽器本機離線安全快取，完全不影響本機瀏覽與管理。");
    } else {
      alert("🎉 參拜紀錄與相片已成功儲存並同步至雲端！");
    }

  } catch (err) {
    console.error("儲存失敗:", err);
    alert("儲存過程發生異常: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i data-lucide="save" class="w-4 h-4 inline mr-1"></i>儲存紀錄';
    if (window.lucide) lucide.createIcons();
  }
}

// 刪除紀錄
async function deleteCurrentRecord() {
  if (!currentUser) {
    alert("權限不足：請先使用 Google 帳號登入後才能清除紀錄！");
    return;
  }
  if (!currentActiveTemple) return;
  if (!confirm("確定要刪除此廟宇的參拜紀錄與相片嗎？")) return;

  const tid = currentActiveTemple.id;
  try {
    // 刪除本地
    await db.records.delete(tid);
    await db.photos.where("templeId").equals(tid).delete();
    delete userRecordsMap[tid];
    delete templePhotosMap[tid];

    // 刪除雲端 (同時刪除個人專屬紀錄與全域展示層鏡像)
    if (fbDb && currentUser) {
      await fbDb.collection("users").doc(currentUser.uid).collection("records").doc(tid).delete().catch(console.warn);
      await fbDb.collection("pilgrimages").doc(tid).delete().catch(console.warn);
    }

    document.getElementById("temple-modal").classList.add("hidden");
    renderAllViews();
    alert("已清除紀錄");
  } catch (err) {
    console.error("刪除失敗:", err);
    alert("刪除失敗: " + err.message);
  }
}

// === 9. 列表、儀表板與時間軸渲染 ===
function renderListView() {
  const container = document.getElementById("temple-list-container");
  if (!container) return;

  const listCountyEl = document.getElementById("list-filter-county");
  if (listCountyEl && listCountyEl.options.length <= 1) {
    populateCountySelect();
  }

  const countyFilter = listCountyEl?.value || "";
  const districtFilter = document.getElementById("list-filter-district")?.value || "";
  const statusFilter = document.getElementById("list-filter-status")?.value || "all";
  const searchKey = document.getElementById("list-filter-search")?.value.trim().toLowerCase() || "";

  const list = TEMPLES_DATA.filter(t => {
    const record = userRecordsMap[t.id];
    const status = record?.status || "unvisited";
    if (countyFilter && t.county !== countyFilter) return false;
    if (districtFilter && t.district !== districtFilter) return false;
    if (statusFilter !== "all" && status !== statusFilter) return false;
    if (searchKey) {
      const match = t.name.toLowerCase().includes(searchKey) ||
                    t.district.toLowerCase().includes(searchKey) ||
                    (t.address && t.address.toLowerCase().includes(searchKey));
      if (!match) return false;
    }
    return true;
  });

  const badge = document.getElementById("list-total-badge");
  if (badge) badge.textContent = `顯示 ${list.length} / 732 間`;

  if (list.length === 0) {
    container.innerHTML = `
      <div class="col-span-1 md:col-span-2 text-center text-slate-400 py-16 bg-white rounded-3xl border border-slate-200">
        <i data-lucide="map-pin-off" class="w-12 h-12 mx-auto mb-3 text-slate-300"></i>
        <h4 class="font-bold text-slate-700">無符合篩選條件的廟宇</h4>
        <p class="text-xs text-slate-400 mt-1">請嘗試清除關鍵字或切換其他縣市／鄉鎮市區進行查找。</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  container.innerHTML = list.map(t => {
    const record = userRecordsMap[t.id];
    const status = record?.status || "unvisited";
    const statusBadge = status === "visited" ? '<span class="text-xs font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">已參拜</span>' :
                        status === "planned" ? '<span class="text-xs font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">規劃中</span>' :
                        '<span class="text-xs font-bold text-slate-500 bg-slate-200 px-2 py-0.5 rounded-full">未參拜</span>';

    const photoCount = templePhotosMap[t.id]?.length || 0;
    const photoBadge = photoCount > 0 ? `<span class="text-[11px] text-brand-600 bg-brand-50 px-1.5 py-0.5 rounded flex items-center gap-1"><i data-lucide="image" class="w-3 h-3"></i> ${photoCount} 張</span>` : '';

    return `
      <div class="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm hover:shadow-md transition flex flex-col justify-between">
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-xs text-brand-600 font-bold">${escapeHtml(t.county)} ${escapeHtml(t.district)}</span>
            ${statusBadge}
          </div>
          <h4 class="font-bold text-base text-slate-800">${escapeHtml(t.name)}</h4>
          <p class="text-xs text-slate-500 line-clamp-1">${escapeHtml(t.address || "無詳細地址")}</p>
          ${record?.notes && record.notes.trim() ? `<p class="text-xs text-slate-600 bg-slate-50 p-2 rounded-lg border border-slate-100 line-clamp-2">💬 ${escapeHtml(record.notes.trim())}</p>` : ''}
        </div>

        <div class="flex items-center justify-between pt-3 mt-2 border-t border-slate-100">
          <div class="flex items-center gap-2">
            ${photoBadge}
            ${record?.visitDate ? `<span class="text-[11px] text-slate-400">📅 ${escapeHtml(record.visitDate)}</span>` : ''}
          </div>
          <div class="flex gap-2">
            ${t.lat && t.lon ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(t.lat)},${encodeURIComponent(t.lon)}" target="_blank" class="px-2.5 py-1 bg-sky-50 text-sky-600 hover:bg-sky-100 text-xs font-bold rounded-lg transition">導航</a>` : ''}
            <button onclick="openTempleModal('${escapeHtml(String(t.id || ''))}')" class="px-3 py-1 bg-brand-600 text-white hover:bg-brand-500 text-xs font-bold rounded-lg transition">${currentUser ? '打卡/編輯' : '詳情'}</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  if (window.lucide) lucide.createIcons();
}

// === 儀表板全域狀態與控制 ===
let currentDashboardScope = "all"; // "all" 或縣市名稱 (如 "臺南市")
let currentDashboardSort = "total-desc"; // "total-desc", "percent-desc", "visited-desc", "name-asc"

// 切換統計範圍 (全台或指定縣市)
window.setDashboardScope = function(scope) {
  currentDashboardScope = scope;
  const select = document.getElementById("dash-scope-select");
  if (select && select.value !== scope) {
    select.value = scope;
  }
  renderDashboardView();
};

// 儀表板控制元件初始化
function initDashboardControls() {
  const scopeSelect = document.getElementById("dash-scope-select");
  if (scopeSelect && scopeSelect.options.length <= 1) {
    const countyCounts = {};
    TEMPLES_DATA.forEach(t => {
      countyCounts[t.county] = (countyCounts[t.county] || 0) + 1;
    });
    const sorted = Object.entries(countyCounts).sort((a, b) => b[1] - a[1]);

    sorted.forEach(([cName, count]) => {
      const opt = document.createElement("option");
      opt.value = cName;
      opt.textContent = `${cName} (${count} 間)`;
      scopeSelect.appendChild(opt);
    });

    scopeSelect.addEventListener("change", (e) => {
      window.setDashboardScope(e.target.value);
    });
  }

  const sortSelect = document.getElementById("dash-sort-select");
  if (sortSelect) {
    sortSelect.value = currentDashboardSort;
    sortSelect.onchange = (e) => {
      currentDashboardSort = e.target.value;
      renderDashboardCountyList();
    };
  }

  const btnList = document.getElementById("dash-btn-view-list");
  if (btnList) {
    btnList.onclick = window.jumpToCountyList;
  }
  const btnMap = document.getElementById("dash-btn-view-map");
  if (btnMap) {
    btnMap.onclick = window.jumpToCountyMap;
  }
}

// 快速跳轉至名錄 (支援目前所選縣市)
window.jumpToCountyList = function() {
  const targetCounty = currentDashboardScope === "all" ? "" : currentDashboardScope;
  window.quickFilterList(targetCounty);
  switchView("list");
};

// 快速跳轉至地圖
window.jumpToCountyMap = function() {
  if (currentDashboardScope !== "all") {
    window.switchCounty(currentDashboardScope);
  }
  switchView("map");
};

// 快速跳轉至指定鄉鎮區的名錄
window.jumpToDistrictList = function(county, district) {
  const countySelect = document.getElementById("list-filter-county");
  if (countySelect) {
    countySelect.value = county;
    updateListDistrictSelect(county);
    const distSelect = document.getElementById("list-filter-district");
    if (distSelect) distSelect.value = district;
    renderListView();
  }
  switchView("list");
};

// 渲染快捷切換標籤列
function renderDashboardChips() {
  const container = document.getElementById("dash-quick-chips");
  if (!container) return;

  const topCounties = ["all", "臺南市", "高雄市", "雲林縣", "嘉義縣", "彰化縣", "屏東縣", "南投縣", "新北市", "臺中市"];
  const countyCounts = { all: TEMPLES_DATA.length };
  TEMPLES_DATA.forEach(t => {
    countyCounts[t.county] = (countyCounts[t.county] || 0) + 1;
  });

  container.innerHTML = topCounties.map(c => {
    const isAll = c === "all";
    const label = isAll ? "全台灣" : c;
    const count = countyCounts[c] || 0;
    const isActive = currentDashboardScope === c;

    const baseClass = "px-3 py-1 rounded-xl font-bold transition text-xs shrink-0 cursor-pointer flex items-center gap-1.5 ";
    const activeClass = isActive 
      ? "bg-brand-600 text-white shadow-sm border border-brand-700 ring-2 ring-brand-300"
      : "bg-white text-slate-700 hover:bg-slate-100 border border-slate-200";

    return `
      <button onclick="setDashboardScope('${c}')" class="${baseClass} ${activeClass}">
        <span>${escapeHtml(label)}</span>
        <span class="text-[10px] ${isActive ? 'text-amber-200' : 'text-slate-400'}">(${count})</span>
      </button>
    `;
  }).join("");
}

// 渲染焦點核心卡片 (動態支援 全台 或 特定縣市)
function renderDashboardSpotlight() {
  const isAll = currentDashboardScope === "all";
  const targetTemples = isAll ? TEMPLES_DATA : TEMPLES_DATA.filter(t => t.county === currentDashboardScope);
  const total = targetTemples.length;

  let visited = 0;
  let planned = 0;
  let unvisited = 0;

  targetTemples.forEach(t => {
    const s = userRecordsMap[t.id]?.status;
    if (s === "visited") visited++;
    else if (s === "planned") planned++;
    else unvisited++;
  });

  const percent = total > 0 ? ((visited / total) * 100).toFixed(1) : "0.0";
  const scopeName = isAll ? "全台" : currentDashboardScope;

  // 更新標籤與標題
  const tagEl = document.getElementById("dash-spotlight-tag");
  const subtagEl = document.getElementById("dash-spotlight-subtag");
  const scopeNameEl = document.getElementById("dash-spotlight-scope-name");
  const visitedEl = document.getElementById("dash-spotlight-visited");
  const totalEl = document.getElementById("dash-spotlight-total");
  const percentEl = document.getElementById("dash-spotlight-percent");

  if (tagEl) tagEl.textContent = isAll ? "全台總體進度" : `${currentDashboardScope} 轄區進度`;
  if (subtagEl) subtagEl.textContent = isAll ? `全台 22 縣市・共 ${total} 間` : `轄內宮廟 ${total} 間`;
  if (scopeNameEl) scopeNameEl.textContent = scopeName;
  if (visitedEl) visitedEl.textContent = visited;
  if (totalEl) totalEl.textContent = `/ ${total} 間`;
  if (percentEl) percentEl.textContent = `${percent}%`;

  // 更新右側進度條與指標
  const cardTitle = document.getElementById("dash-spotlight-card-title");
  const ratioEl = document.getElementById("dash-spotlight-ratio");
  const barEl = document.getElementById("dash-spotlight-bar");
  const statVisited = document.getElementById("dash-stat-visited");
  const statPlanned = document.getElementById("dash-stat-planned");
  const statUnvisited = document.getElementById("dash-stat-unvisited");

  if (cardTitle) cardTitle.textContent = isAll ? "全台達成率指標" : `${currentDashboardScope} 達成率`;
  if (ratioEl) ratioEl.textContent = `${visited} / ${total}`;
  if (barEl) barEl.style.width = `${percent}%`;
  if (statVisited) statVisited.textContent = visited;
  if (statPlanned) statPlanned.textContent = planned;
  if (statUnvisited) statUnvisited.textContent = unvisited;

  // 按鈕文字更新
  const btnList = document.getElementById("dash-btn-view-list");
  if (btnList) {
    const listSpan = btnList.querySelector("span");
    if (listSpan) listSpan.textContent = isAll ? "查看全台名錄" : `查看 ${currentDashboardScope} 名錄`;
  }
  const btnMap = document.getElementById("dash-btn-view-map");
  if (btnMap) {
    const mapSpan = btnMap.querySelector("span");
    if (mapSpan) mapSpan.textContent = isAll ? "全台地圖總覽" : `地圖聚焦 ${currentDashboardScope}`;
  }

  // 向後相容舊有元件
  const oldVisitedBig = document.getElementById("dash-visited-big");
  const oldPercentBig = document.getElementById("dash-percent-big");
  const oldTainanRatio = document.getElementById("dash-tainan-ratio");
  const oldTainanBar = document.getElementById("dash-tainan-bar");
  if (oldVisitedBig) oldVisitedBig.textContent = visited;
  if (oldPercentBig) oldPercentBig.textContent = `${percent}%`;
  if (oldTainanRatio) {
    const tainanTemples = TEMPLES_DATA.filter(t => t.county === "臺南市");
    const tVisited = tainanTemples.filter(t => userRecordsMap[t.id]?.status === "visited").length;
    oldTainanRatio.textContent = `${tVisited} / 96`;
    if (oldTainanBar) oldTainanBar.style.width = `${Math.round((tVisited / 96) * 100)}%`;
  }
}

// 渲染選定縣市的轄內各鄉鎮區進度細分
function renderDashboardDistricts() {
  const section = document.getElementById("dash-district-section");
  const list = document.getElementById("dash-district-list");
  if (!section || !list) return;

  if (currentDashboardScope === "all") {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  const titleEl = document.getElementById("dash-district-title");
  const countBadge = document.getElementById("dash-district-count-badge");

  const countyTemples = TEMPLES_DATA.filter(t => t.county === currentDashboardScope);
  const distMap = {};
  countyTemples.forEach(t => {
    const d = t.district || "其他";
    if (!distMap[d]) {
      distMap[d] = { name: d, total: 0, visited: 0, planned: 0 };
    }
    distMap[d].total++;
    const s = userRecordsMap[t.id]?.status;
    if (s === "visited") distMap[d].visited++;
    else if (s === "planned") distMap[d].planned++;
  });

  const districts = Object.values(distMap).sort((a, b) => b.total - a.total);

  if (titleEl) titleEl.textContent = `${currentDashboardScope} 各鄉鎮市區完成度`;
  if (countBadge) countBadge.textContent = `共 ${districts.length} 個行政區`;

  list.innerHTML = districts.map(d => {
    const p = Math.round((d.visited / d.total) * 100);
    return `
      <div onclick="jumpToDistrictList('${escapeHtml(currentDashboardScope)}', '${escapeHtml(d.name)}')" 
           class="p-3.5 bg-slate-50 hover:bg-white rounded-2xl border border-slate-200 hover:border-brand-300 hover:shadow-md transition group cursor-pointer">
        <div class="flex items-center justify-between">
          <div class="font-bold text-slate-800 text-sm group-hover:text-brand-600 transition flex items-center gap-1.5">
            <span>${escapeHtml(d.name)}</span>
            <i data-lucide="chevron-right" class="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition text-brand-600"></i>
          </div>
          <span class="text-xs font-black ${p > 0 ? 'text-brand-600' : 'text-slate-400'}">${p}%</span>
        </div>
        <div class="w-full bg-slate-200 h-2 rounded-full mt-2.5 overflow-hidden">
          <div class="bg-brand-600 h-full rounded-full transition-all duration-300" style="width: ${p}%"></div>
        </div>
        <div class="flex items-center justify-between text-[11px] text-slate-500 mt-2.5 pt-1 border-t border-slate-100/60">
          <span class="font-medium">${d.visited} / ${d.total} 間</span>
          <div class="flex items-center gap-1.5 text-[10px]">
            <span class="text-emerald-700 font-bold">🟢 ${d.visited}</span>
            ${d.planned > 0 ? `<span class="text-amber-700 font-bold">🟡 ${d.planned}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// 渲染各縣市參拜完成度列表 (22 縣市比較與排序)
function renderDashboardCountyList() {
  const container = document.getElementById("county-progress-list");
  if (!container) return;

  const countyStats = {};
  TEMPLES_DATA.forEach(t => {
    if (!countyStats[t.county]) {
      countyStats[t.county] = { county: t.county, total: 0, visited: 0, planned: 0, unvisited: 0 };
    }
    const stat = countyStats[t.county];
    stat.total++;
    const s = userRecordsMap[t.id]?.status;
    if (s === "visited") stat.visited++;
    else if (s === "planned") stat.planned++;
    else stat.unvisited++;
  });

  const list = Object.values(countyStats);

  // 排序
  list.sort((a, b) => {
    if (currentDashboardSort === "percent-desc") {
      const pA = a.total > 0 ? a.visited / a.total : 0;
      const pB = b.total > 0 ? b.visited / b.total : 0;
      if (pB !== pA) return pB - pA;
      return b.total - a.total;
    } else if (currentDashboardSort === "visited-desc") {
      if (b.visited !== a.visited) return b.visited - a.visited;
      return b.total - a.total;
    } else if (currentDashboardSort === "name-asc") {
      return a.county.localeCompare(b.county, "zh-Hant");
    } else {
      // total-desc (預設)
      return b.total - a.total;
    }
  });

  container.innerHTML = list.map(stat => {
    const p = Math.round((stat.visited / stat.total) * 100);
    const isSelected = currentDashboardScope === stat.county;

    const cardClass = isSelected
      ? "bg-brand-50/60 border-brand-400 ring-2 ring-brand-400 shadow-sm"
      : "bg-slate-50 hover:bg-white border-slate-200 hover:border-brand-200 hover:shadow-sm";

    return `
      <div onclick="setDashboardScope('${escapeHtml(stat.county)}')" 
           class="p-4 rounded-2xl border transition cursor-pointer group space-y-2.5 ${cardClass}">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="font-extrabold text-sm text-slate-800 group-hover:text-brand-700 transition flex items-center gap-1">
              ${escapeHtml(stat.county)}
              ${isSelected ? '<span class="text-[10px] bg-brand-600 text-white px-1.5 py-0.5 rounded font-medium">焦點</span>' : ''}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs font-black ${p > 0 ? 'text-brand-600' : 'text-slate-400'}">${p}%</span>
            <button onclick="event.stopPropagation(); quickFilterList('${escapeHtml(stat.county)}'); switchView('list');" 
                    title="在廟宇名錄中查看"
                    class="text-[11px] text-slate-400 hover:text-brand-600 px-1.5 py-0.5 rounded hover:bg-slate-100 transition">
              名錄 ↗
            </button>
          </div>
        </div>

        <div class="w-full bg-slate-200/80 h-2.5 rounded-full overflow-hidden">
          <div class="bg-brand-600 h-full rounded-full transition-all duration-300" style="width: ${p}%"></div>
        </div>

        <div class="flex items-center justify-between text-xs text-slate-500 pt-1">
          <span class="font-medium text-slate-600">${stat.visited} / ${stat.total} 間</span>
          <div class="flex items-center gap-2 text-[11px]">
            <span class="text-emerald-700 font-semibold">🟢 ${stat.visited}</span>
            <span class="text-amber-700 font-semibold">🟡 ${stat.planned}</span>
            <span class="text-slate-400 font-medium">⚪ ${stat.unvisited}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// 渲染儀表板主要視圖
function renderDashboardView() {
  initDashboardControls();
  renderDashboardChips();
  renderDashboardSpotlight();
  renderDashboardDistricts();
  renderDashboardCountyList();
  if (window.lucide) lucide.createIcons();
}

function renderTimelineView() {
  const container = document.getElementById("timeline-container");
  if (!container) return;

  const logs = Object.values(userRecordsMap)
    .filter(r => r.status === "visited")
    .sort((a, b) => (b.visitDate || "").localeCompare(a.visitDate || ""));

  if (logs.length === 0) {
    container.innerHTML = `
      <div class="bg-white rounded-3xl p-8 text-center text-slate-400 border border-slate-200">
        <i data-lucide="compass" class="w-12 h-12 mx-auto mb-3 text-slate-300"></i>
        <h4 class="font-bold text-slate-600">尚無參拜記錄</h4>
        <p class="text-xs text-slate-400 mt-1">至「朝聖地圖」點選任一廟宇進行現場打卡與拍照吧！</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  container.innerHTML = logs.map(log => {
    const t = TEMPLES_DATA.find(x => x.id === log.templeId) || {};
    const photos = (templePhotosMap[log.templeId] || []).filter(p => p.dataUrl && typeof p.dataUrl === "string" && p.dataUrl.length > 0);

    const photosGrid = photos.length > 0 ? `
      <div class="grid grid-cols-2 md:grid-cols-3 gap-2 mt-3">
        ${photos.map(p => {
          const safeUrl = sanitizeImageUrl(p.dataUrl);
          if (!safeUrl) return '';
          return `
          <div class="aspect-square rounded-xl overflow-hidden border border-slate-200 bg-slate-100 shadow-sm">
            <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="block w-full h-full">
              <img src="${safeUrl}" class="w-full h-full object-cover hover:scale-105 transition duration-300 cursor-pointer" alt="參拜照片" />
            </a>
          </div>
        `}).join("")}
      </div>
    ` : '';

    return `
      <div class="bg-white rounded-3xl p-5 md:p-6 border border-slate-200 shadow-sm space-y-3">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <div class="flex items-center gap-2">
            <span class="text-xs bg-brand-gold/20 text-brand-600 font-bold px-2.5 py-1 rounded-full">
              📅 ${escapeHtml(log.visitDate || "未填日期")}
            </span>
            ${log.tags ? `<span class="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md">🏷️ ${escapeHtml(log.tags)}</span>` : ''}
          </div>
          <button onclick="openTempleModal('${escapeHtml(String(t.id || ''))}')" class="text-xs text-brand-600 hover:underline font-bold">${currentUser ? '編輯' : '查看詳情'}</button>
        </div>

        <div>
          <div class="text-xs text-slate-400">${escapeHtml(t.county || "")} ${escapeHtml(t.district || "")}</div>
          <h3 class="font-extrabold text-xl text-slate-800">${escapeHtml(t.name || "")}</h3>
          <p class="text-xs text-slate-500 mt-0.5">${escapeHtml(t.address || "")}</p>
        </div>

        ${log.notes && log.notes.trim() ? `
          <div class="text-sm text-slate-700 bg-slate-50 p-3.5 md:p-4 rounded-2xl border border-slate-100 whitespace-pre-wrap leading-relaxed break-words">${escapeHtml(log.notes.trim())}</div>
        ` : ''}

        ${photosGrid}
      </div>
    `;
  }).join("");

  if (window.lucide) lucide.createIcons();
}

function renderAllViews() {
  const visitedCount = Object.values(userRecordsMap).filter(r => r.status === "visited").length;
  const percent = ((visitedCount / TEMPLES_DATA.length) * 100).toFixed(1);

  const headerVisited = document.getElementById("header-visited-count");
  const headerPercent = document.getElementById("header-percent");
  if (headerVisited) headerVisited.textContent = visitedCount;
  if (headerPercent) headerPercent.textContent = `${percent}%`;

  renderMapMarkers();
  renderListView();
  renderDashboardView();
  renderTimelineView();
}

// === 10. 事件監聽綁定 ===
function bindEvents() {
  document.getElementById("filter-county")?.addEventListener("change", () => {
    renderMapMarkers();
    const c = document.getElementById("filter-county").value;
    if (c) flyToCounty(c);
  });

  document.getElementById("filter-status")?.addEventListener("change", renderMapMarkers);

  const searchInput = document.getElementById("map-search");
  const clearBtn = document.getElementById("clear-search");
  searchInput?.addEventListener("input", (e) => {
    clearBtn.classList.toggle("hidden", !e.target.value);
    renderMapMarkers();
  });
  clearBtn?.addEventListener("click", () => {
    searchInput.value = "";
    clearBtn.classList.add("hidden");
    renderMapMarkers();
  });

  document.getElementById("btn-recenter")?.addEventListener("click", () => {
    map.setView([23.5, 120.8], 8);
    document.getElementById("filter-county").value = "";
    document.getElementById("filter-status").value = "all";
    document.getElementById("map-search").value = "";
    renderMapMarkers();
  });

  // 廟宇名錄篩選事件
  document.getElementById("list-filter-county")?.addEventListener("change", (e) => {
    updateListDistrictSelect(e.target.value);
    renderListView();
  });

  document.getElementById("list-filter-district")?.addEventListener("change", renderListView);
  document.getElementById("list-filter-status")?.addEventListener("change", renderListView);

  const listSearchInput = document.getElementById("list-filter-search");
  const listClearBtn = document.getElementById("list-clear-search");
  listSearchInput?.addEventListener("input", (e) => {
    listClearBtn?.classList.toggle("hidden", !e.target.value);
    renderListView();
  });
  listClearBtn?.addEventListener("click", () => {
    if (listSearchInput) listSearchInput.value = "";
    listClearBtn?.classList.add("hidden");
    renderListView();
  });

  document.getElementById("btn-list-reset")?.addEventListener("click", () => {
    const c = document.getElementById("list-filter-county");
    const d = document.getElementById("list-filter-district");
    const s = document.getElementById("list-filter-status");
    const q = document.getElementById("list-filter-search");
    const clr = document.getElementById("list-clear-search");
    if (c) c.value = "";
    if (d) {
      d.innerHTML = '<option value="">請先選擇縣市</option>';
      d.disabled = true;
      d.value = "";
    }
    if (s) s.value = "all";
    if (q) q.value = "";
    if (clr) clr.classList.add("hidden");
    renderListView();
  });

  document.getElementById("modal-close")?.addEventListener("click", () => {
    document.getElementById("temple-modal").classList.add("hidden");
  });

  document.getElementById("btn-toggle-status")?.addEventListener("click", () => {
    if (!currentUser) {
      alert("權限不足：請先使用 Google 帳號登入後才能進行參拜打卡！");
      return;
    }
    if (!currentActiveTemple) return;
    const tid = currentActiveTemple.id;
    const cur = userRecordsMap[tid]?.status || "unvisited";
    const nextStatus = cur === "visited" ? "planned" : "visited";
    
    if (!userRecordsMap[tid]) {
      userRecordsMap[tid] = { templeId: tid, status: nextStatus, visitDate: new Date().toISOString().slice(0, 10), tags: "", notes: "" };
    } else {
      userRecordsMap[tid].status = nextStatus;
    }
    updateModalStatusBadge(nextStatus);
  });

  document.getElementById("btn-save-record")?.addEventListener("click", saveCurrentRecord);
  document.getElementById("btn-delete-record")?.addEventListener("click", deleteCurrentRecord);

  // Google 登入/登出
  document.getElementById("btn-login")?.addEventListener("click", loginWithGoogle);
  document.getElementById("btn-logout")?.addEventListener("click", logoutGoogle);

  // 相片選擇與壓縮 (限制管理員)
  document.getElementById("input-photo")?.addEventListener("change", async (e) => {
    if (!currentUser) {
      alert("權限不足：請先使用 Google 帳號登入後才能上傳照片！");
      e.target.value = "";
      return;
    }
    const files = Array.from(e.target.files);
    if (!files.length) return;

    for (const file of files) {
      try {
        const compressed = await compressImage(file, 1200, 0.82);
        currentTempPhotos.push({
          templeId: currentActiveTemple.id,
          dataUrl: compressed
        });
      } catch (err) {
        console.error("相片壓縮失敗:", err);
      }
    }
    renderModalPhotos();
    e.target.value = "";
  });

  // 匯出/匯入備份 (限制管理員)
  document.getElementById("btn-export-backup")?.addEventListener("click", async () => {
    if (!currentUser) {
      alert("權限不足：請先使用 Google 帳號登入後才能匯出備份資料！");
      return;
    }
    const allRecords = await db.records.toArray();
    const allPhotos = await db.photos.toArray();
    const allItineraries = await db.itineraries.toArray();
    const backupData = {
      version: "2.1",
      exportDate: new Date().toISOString(),
      records: allRecords,
      photos: allPhotos,
      itineraries: allItineraries
    };

    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `參拜足跡備份_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("input-import-backup")?.addEventListener("change", (e) => {
    if (!currentUser) {
      alert("權限不足：請先使用 Google 帳號登入後才能匯入備份！");
      e.target.value = "";
      return;
    }
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const backup = JSON.parse(evt.target.result);
        if (!backup.records) throw new Error("備份檔案格式不正確");

        const itinCount = backup.itineraries?.length || 0;
        if (confirm(`確認匯入備份？包含 ${backup.records.length} 筆參拜紀錄、${backup.photos?.length || 0} 張相片與 ${itinCount} 條自訂行程。`)) {
          await db.records.clear();
          await db.photos.clear();
          await db.itineraries.clear();
          if (backup.records.length) await db.records.bulkAdd(backup.records);
          if (backup.photos?.length) await db.photos.bulkAdd(backup.photos);
          if (backup.itineraries?.length) await db.itineraries.bulkAdd(backup.itineraries);
          updateSavedItinerariesCount();
          await loadUserDataFromLocal();
          renderAllViews();
          alert("備份還原成功！");
        }
      } catch (err) {
        alert("匯入失敗：" + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  document.getElementById("btn-reset-db")?.addEventListener("click", async () => {
    if (!currentUser) {
      alert("權限不足：請先使用 Google 帳號登入後才能重設本機紀錄！");
      return;
    }
    if (confirm("⚠️ 警告：這將會清除您在本機所有的暫存參拜打卡紀錄、相片與自訂行程，確認清除？")) {
      await db.records.clear();
      await db.photos.clear();
      await db.itineraries.clear();
      userRecordsMap = {};
      templePhotosMap = {};
      updateSavedItinerariesCount();
      renderAllViews();
      alert("已重設本機紀錄");
    }
  });
}

// =========================================================================
// === 13. 智能朝聖路線規劃系統 (Route Planner Engine) ===
// =========================================================================

// 球面距離公式 (Haversine formula, 單位: km)
function calculateHaversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // 地球半徑 (km)
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// TSP 啟發式最佳化演算法 (Nearest Neighbor + 2-Opt 消除交叉路徑)
function optimizePilgrimageRoute(start, candidateTemples, maxStops = 999) {
  if (!start || candidateTemples.length === 0) return [];

  // 第一階段：以起點為出發點的最近鄰點法 (Nearest Neighbor)
  const pool = [...candidateTemples];
  const route = [];
  let currentPos = { lat: start.lat, lon: start.lon };

  const targetCount = Math.min(pool.length, maxStops);
  for (let step = 0; step < targetCount; step++) {
    let nearestIdx = -1;
    let minDistance = Infinity;

    for (let i = 0; i < pool.length; i++) {
      const d = calculateHaversineKm(currentPos.lat, currentPos.lon, pool[i].lat, pool[i].lon);
      if (d < minDistance) {
        minDistance = d;
        nearestIdx = i;
      }
    }

    if (nearestIdx >= 0) {
      const selected = pool.splice(nearestIdx, 1)[0];
      route.push(selected);
      currentPos = { lat: selected.lat, lon: selected.lon };
    }
  }

  // 第二階段：2-Opt 局部搜尋消除折線交錯 (2-Opt Local Search)
  if (route.length >= 4) {
    let improved = true;
    let maxIters = 40;
    while (improved && maxIters > 0) {
      improved = false;
      maxIters--;
      for (let i = 0; i < route.length - 1; i++) {
        for (let k = i + 1; k < route.length; k++) {
          const prevA = (i === 0) ? start : route[i - 1];
          const nodeA = route[i];
          const nodeB = route[k];
          const nextB = (k === route.length - 1) ? null : route[k + 1];

          const currentD = calculateHaversineKm(prevA.lat, prevA.lon, nodeA.lat, nodeA.lon) +
                           (nextB ? calculateHaversineKm(nodeB.lat, nodeB.lon, nextB.lat, nextB.lon) : 0);
          const newD = calculateHaversineKm(prevA.lat, prevA.lon, nodeB.lat, nodeB.lon) +
                       (nextB ? calculateHaversineKm(nodeA.lat, nodeA.lon, nextB.lat, nextB.lon) : 0);

          if (newD < currentD - 0.005) {
            const segment = route.slice(i, k + 1).reverse();
            route.splice(i, segment.length, ...segment);
            improved = true;
          }
        }
      }
    }
  }

  return route;
}

// 初始化路線規劃視圖
window.initPlannerView = function() {
  initPlannerRegionUI();
  populateStartTempleDropdowns();
  updateSavedItinerariesCount();

  if (!plannerStartPoint) {
    setPresetStart("台南北極殿(大上帝廟)", 22.9951, 120.2072);
  }
  if (window.lucide) lucide.createIcons();
};

// 起點模式切換
window.setStartMode = function(mode) {
  const modes = ['gps', 'temple', 'custom'];
  modes.forEach(m => {
    const btn = document.getElementById(`btn-start-mode-${m}`);
    const panel = document.getElementById(`start-panel-${m}`);
    if (btn) {
      if (m === mode) {
        btn.className = "py-2 rounded-lg bg-white text-brand-600 shadow-sm transition flex items-center justify-center gap-1 font-bold";
      } else {
        btn.className = "py-2 rounded-lg text-slate-600 hover:text-slate-900 transition flex items-center justify-center gap-1";
      }
    }
    if (panel) panel.classList.toggle("hidden", m !== mode);
  });
};

// GPS 定位請求
window.requestCurrentLocation = function() {
  const statusEl = document.getElementById("gps-status-text");
  if (!navigator.geolocation) {
    if (statusEl) statusEl.textContent = "您的瀏覽器不支援 GPS 定位";
    return;
  }
  if (statusEl) statusEl.textContent = "正在取得 GPS 定位中...";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      plannerStartPoint = { type: 'gps', name: '我的目前位置 (GPS)', lat, lon };
      if (statusEl) statusEl.innerHTML = `<span class="text-emerald-700 font-bold">✓ 已定位 (${lat.toFixed(4)}, ${lon.toFixed(4)})</span>`;
      updatePlannerStartStatusUI();
    },
    (err) => {
      if (statusEl) statusEl.textContent = "定位失敗，請確認是否允許存取位置權限。";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

// 填入指定廟宇作為起點的下拉選單
function populateStartTempleDropdowns() {
  const countySelect = document.getElementById("start-temple-county");
  if (!countySelect || countySelect.options.length > 1) return;

  const counties = [...new Set(TEMPLES_DATA.map(t => t.county))].filter(Boolean);
  counties.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    countySelect.appendChild(opt);
  });
}

window.onStartTempleCountyChange = function(county) {
  const templeSelect = document.getElementById("start-temple-select");
  if (!templeSelect) return;
  if (!county) {
    templeSelect.innerHTML = '<option value="">請先選擇縣市</option>';
    templeSelect.disabled = true;
    return;
  }

  const filtered = TEMPLES_DATA.filter(t => t.county === county && t.lat && t.lon);
  templeSelect.innerHTML = '<option value="">請選擇廟宇作為起點</option>' +
    filtered.map(t => `<option value="${t.id}">${escapeHtml(t.name)} (${escapeHtml(t.district)})</option>`).join("");
  templeSelect.disabled = false;
};

window.onStartTempleSelect = function(templeId) {
  const t = TEMPLES_DATA.find(x => x.id === templeId);
  if (t) {
    plannerStartPoint = { type: 'temple', name: t.name, lat: t.lat, lon: t.lon, templeId: t.id };
    updatePlannerStartStatusUI();
  }
};

window.setPresetStart = function(name, lat, lon) {
  plannerStartPoint = { type: 'preset', name, lat, lon };
  updatePlannerStartStatusUI();
};

window.geocodeCustomAddress = async function() {
  const input = document.getElementById("start-custom-address");
  const query = input?.value.trim();
  if (!query) {
    alert("請輸入起點地址或地標關鍵字");
    return;
  }

  // 1. 優先本地比對全台 740 間玄天上帝廟資料庫 (0 毫秒極速且精準)
  const qLower = query.toLowerCase();
  const localMatch = TEMPLES_DATA.find(t => 
    t.name.toLowerCase() === qLower || 
    t.name.toLowerCase().includes(qLower) ||
    (t.address && t.address.toLowerCase().includes(qLower))
  );

  // 若完全相符或關鍵字明確，直接採用本地資料庫座標
  if (localMatch && (localMatch.name.toLowerCase() === qLower || qLower.length >= 3)) {
    plannerStartPoint = { 
      type: 'custom', 
      name: `${localMatch.name} (${localMatch.county}${localMatch.district})`, 
      lat: localMatch.lat, 
      lon: localMatch.lon 
    };
    updatePlannerStartStatusUI();
    alert(`已成功定位起點（宮廟資料庫）：「${localMatch.name}」(${localMatch.county}${localMatch.district})`);
    return;
  }

  const btn = document.querySelector("#start-panel-custom button");
  const origText = btn ? btn.textContent : "搜尋定位";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "定位中...";
  }

  try {
    let found = false;

    // 2. 呼叫支援全網 CORS 的 Photon (OpenStreetMap 台灣地理編碼引擎)
    try {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1`, {
        signal: ctrl.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        if (data && data.features && data.features.length > 0) {
          const coords = data.features[0].geometry.coordinates; // [lon, lat]
          const lon = parseFloat(coords[0]);
          const lat = parseFloat(coords[1]);
          const placeName = data.features[0].properties.name || query;
          plannerStartPoint = { type: 'custom', name: placeName, lat, lon };
          updatePlannerStartStatusUI();
          alert(`已成功定位起點：「${placeName}」`);
          found = true;
        }
      }
    } catch (_) {}

    if (found) return;

    // 3. 次選：備援呼叫 OpenStreetMap Nominatim 引擎
    try {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`, {
        signal: ctrl.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        if (data && data.length > 0) {
          const lat = parseFloat(data[0].lat);
          const lon = parseFloat(data[0].lon);
          plannerStartPoint = { type: 'custom', name: query, lat, lon };
          updatePlannerStartStatusUI();
          alert(`已成功定位起點：「${query}」`);
          found = true;
        }
      }
    } catch (_) {}

    if (found) return;

    // 4. 若外部查詢無結果但本地有部分模糊相符，採用本地符合之宮廟
    if (localMatch) {
      plannerStartPoint = { 
        type: 'custom', 
        name: `${localMatch.name} (${localMatch.county}${localMatch.district})`, 
        lat: localMatch.lat, 
        lon: localMatch.lon 
      };
      updatePlannerStartStatusUI();
      alert(`查無外部地圖精確坐標，已為您自動配對宮廟起點：「${localMatch.name}」(${localMatch.county}${localMatch.district})`);
      return;
    }

    alert("查無此地標座標，請嘗試更精確的行政區或路名（例如：台南火車站、台中高鐵站）");
  } catch (err) {
    alert("搜尋定位連線異常，請嘗試選擇宮廟或點選推薦快捷起點");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
};

function updatePlannerStartStatusUI() {
  const statusEl = document.getElementById("planner-start-status");
  if (statusEl && plannerStartPoint) {
    statusEl.textContent = `✓ 已設定起點：${plannerStartPoint.name}`;
  }
}

// 初始化區域選擇 UI (所有縣市 Chips)
function initPlannerRegionUI() {
  const countyChipsContainer = document.getElementById("planner-county-chips");
  if (!countyChipsContainer || countyChipsContainer.children.length > 0) return;

  const allCounties = [
    "臺南市", "高雄市", "雲林縣", "嘉義縣", "彰化縣", "屏東縣", "南投縣", "新北市",
    "臺中市", "苗栗縣", "澎湖縣", "金門縣", "嘉義市", "宜蘭縣", "臺東縣", "花蓮縣",
    "桃園市", "臺北市", "連江縣", "基隆市", "新竹市", "新竹縣"
  ];

  countyChipsContainer.innerHTML = allCounties.map(c => `
    <button type="button" onclick="switchPlannerCounty('${c}')" id="chip-county-${c}"
      class="county-chip px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition ${c === plannerCurrentCounty ? 'bg-brand-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">
      ${c}
    </button>
  `).join("");

  switchPlannerCounty(plannerCurrentCounty);
  if (plannerSelectedDistricts.size === 0) {
    selectAllDistrictsInCurrentCounty();
  }
}

window.switchPlannerCounty = function(county) {
  plannerCurrentCounty = county;
  document.querySelectorAll(".county-chip").forEach(btn => {
    const isCur = btn.id === `chip-county-${county}`;
    btn.className = `county-chip px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition ${isCur ? 'bg-brand-600 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`;
  });

  const labelEl = document.getElementById("planner-current-county-label");
  if (labelEl) labelEl.textContent = `${county} 行政區選擇`;

  renderDistrictChipsForCounty(county);
};

function renderDistrictChipsForCounty(county) {
  const container = document.getElementById("planner-district-chips");
  if (!container) return;

  const countyTemples = TEMPLES_DATA.filter(t => t.county === county && t.district);
  const distCounts = {};
  countyTemples.forEach(t => {
    distCounts[t.district] = (distCounts[t.district] || 0) + 1;
  });

  const sortedDistricts = Object.keys(distCounts).sort();
  container.innerHTML = sortedDistricts.map(d => {
    const key = `${county}:${d}`;
    const isSelected = plannerSelectedDistricts.has(key);
    return `
      <button type="button" onclick="toggleDistrictSelection('${county}', '${d}')" id="chip-dist-${county}-${d}"
        class="px-2.5 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1 ${isSelected ? 'bg-amber-500 text-white shadow-sm font-bold' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'}">
        <span>${d}</span>
        <span class="text-[10px] opacity-75">(${distCounts[d]})</span>
      </button>
    `;
  }).join("");

  updatePlannerRegionSummary();
}

window.toggleDistrictSelection = function(county, district) {
  const key = `${county}:${district}`;
  if (plannerSelectedDistricts.has(key)) {
    plannerSelectedDistricts.delete(key);
  } else {
    plannerSelectedDistricts.add(key);
  }
  renderDistrictChipsForCounty(plannerCurrentCounty);
  updatePlannerRegionSummary();
};

window.selectAllDistrictsInCurrentCounty = function() {
  const countyTemples = TEMPLES_DATA.filter(t => t.county === plannerCurrentCounty && t.district);
  countyTemples.forEach(t => {
    plannerSelectedDistricts.add(`${plannerCurrentCounty}:${t.district}`);
  });
  renderDistrictChipsForCounty(plannerCurrentCounty);
  updatePlannerRegionSummary();
};

window.deselectAllDistrictsInCurrentCounty = function() {
  const countyTemples = TEMPLES_DATA.filter(t => t.county === plannerCurrentCounty && t.district);
  countyTemples.forEach(t => {
    plannerSelectedDistricts.delete(`${plannerCurrentCounty}:${t.district}`);
  });
  renderDistrictChipsForCounty(plannerCurrentCounty);
  updatePlannerRegionSummary();
};

window.toggleAllDistrictsInCurrentCounty = function() {
  const countyTemples = TEMPLES_DATA.filter(t => t.county === plannerCurrentCounty && t.district);
  const distSet = new Set(countyTemples.map(t => t.district));
  const allSelected = Array.from(distSet).every(d => plannerSelectedDistricts.has(`${plannerCurrentCounty}:${d}`));

  if (allSelected) {
    distSet.forEach(d => plannerSelectedDistricts.delete(`${plannerCurrentCounty}:${d}`));
  } else {
    distSet.forEach(d => plannerSelectedDistricts.add(`${plannerCurrentCounty}:${d}`));
  }
  renderDistrictChipsForCounty(plannerCurrentCounty);
  updatePlannerRegionSummary();
};

window.clearAllSelectedDistricts = function() {
  plannerSelectedDistricts.clear();
  renderDistrictChipsForCounty(plannerCurrentCounty);
  updatePlannerRegionSummary();
};

function updatePlannerRegionSummary() {
  const statsEl = document.getElementById("planner-region-stats");
  const summaryBox = document.getElementById("planner-selected-summary");

  let unvisitedCount = 0;
  let totalCount = 0;

  TEMPLES_DATA.forEach(t => {
    const key = `${t.county}:${t.district}`;
    if (plannerSelectedDistricts.has(key)) {
      totalCount++;
      const s = userRecordsMap[t.id]?.status || "unvisited";
      if (s === "unvisited") unvisitedCount++;
    }
  });

  if (statsEl) {
    statsEl.textContent = `已選 ${plannerSelectedDistricts.size} 個行政區（未參拜 ${unvisitedCount} 廟 / 共 ${totalCount} 廟）`;
  }

  if (summaryBox) {
    if (plannerSelectedDistricts.size === 0) {
      summaryBox.classList.add("hidden");
    } else {
      summaryBox.classList.remove("hidden");
      const list = Array.from(plannerSelectedDistricts);
      summaryBox.innerHTML = `
        <div class="w-full flex items-center justify-between pb-1.5 mb-1 border-b border-amber-200/70 text-[11px] text-amber-900 font-bold">
          <span>已選取 ${list.length} 個行政區</span>
          <button type="button" onclick="clearAllSelectedDistricts()" class="text-rose-600 hover:text-rose-700 hover:underline flex items-center gap-1 font-bold cursor-pointer transition">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            <span>清空所有已選</span>
          </button>
        </div>
      ` + list.map(item => {
        const [c, d] = item.split(":");
        return `
          <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-100/80 text-amber-800 rounded-md text-xs font-semibold">
            ${c} ${d}
            <button type="button" onclick="toggleDistrictSelection('${c}', '${d}')" class="hover:text-rose-600 font-black cursor-pointer">×</button>
          </span>
        `;
      }).join("");
    }
  }
}

// 開始計算最佳化路線
window.calculateOptimizedRoute = function() {
  if (!currentUser) {
    alert("權限不足：智能路線規劃功能需要登入 Google 帳號才能使用！");
    switchView("planner");
    return;
  }

  if (!plannerStartPoint) {
    alert("請先選擇出發起點（可使用 GPS 目前定位、指定廟宇或推薦快捷起點）");
    return;
  }

  if (plannerSelectedDistricts.size === 0) {
    alert("請至少選擇一個欲造訪的區域或鄉鎮！");
    return;
  }

  const includePlanned = document.getElementById("planner-include-planned")?.checked ?? true;
  const maxStops = parseInt(document.getElementById("planner-max-count")?.value || "999", 10);

  // 篩選目標廟宇 (未參拜過，且具備有效經緯度)
  const candidateTemples = TEMPLES_DATA.filter(t => {
    const key = `${t.county}:${t.district}`;
    if (!plannerSelectedDistricts.has(key)) return false;
    if (!t.lat || !t.lon) return false;

    // 若為起點本身，排除
    if (plannerStartPoint.templeId && t.id === plannerStartPoint.templeId) return false;

    const s = userRecordsMap[t.id]?.status || "unvisited";
    if (s === "visited") return false; // 排除已參拜過
    if (!includePlanned && s === "planned") return false;

    return true;
  });

  if (candidateTemples.length === 0) {
    alert("在您所勾選的區域內，目前沒有符合條件的「未參拜」廟宇！您可以勾選更多鄉鎮或放寬篩選條件。");
    return;
  }

  // 執行 TSP 啟發式路徑計算
  plannerCalculatedRoute = optimizePilgrimageRoute(plannerStartPoint, candidateTemples, maxStops);

  // 自動命名路線
  const nameInput = document.getElementById("route-name-input");
  if (nameInput) {
    nameInput.value = `${plannerCurrentCounty}玄帝朝聖巡禮 (${plannerCalculatedRoute.length}廟)`;
  }

  renderRouteStops();

  // 發送 GA4 路線規劃事件
  trackGAEvent("route_planned", {
    county: plannerCurrentCounty,
    stops_count: plannerCalculatedRoute.length
  });

  // 切換至結果卡片
  document.getElementById("planner-config-card")?.classList.add("hidden");
  document.getElementById("planner-result-card")?.classList.remove("hidden");
};

// 重新整理/計算目前路線統計
window.recalculateCurrentRoute = function() {
  if (!plannerStartPoint || plannerCalculatedRoute.length === 0) return;
  plannerCalculatedRoute = optimizePilgrimageRoute(plannerStartPoint, plannerCalculatedRoute, plannerCalculatedRoute.length);
  renderRouteStops();
};

// 返回修改條件
window.resetPlannerToConfig = function() {
  document.getElementById("planner-result-card")?.classList.add("hidden");
  document.getElementById("planner-config-card")?.classList.remove("hidden");
};

// 渲染站點編輯清單
function renderRouteStops() {
  const container = document.getElementById("route-stops-container");
  if (!container) return;

  let totalKm = 0;
  let prevPos = { lat: plannerStartPoint.lat, lon: plannerStartPoint.lon };

  const stopsHtml = [
    // 起點標記卡片
    `
      <div class="flex items-center justify-between p-3 bg-emerald-50 rounded-xl border border-emerald-200 text-xs">
        <div class="flex items-center gap-2">
          <span class="w-6 h-6 rounded-full bg-emerald-600 text-white font-bold flex items-center justify-center text-xs">🏁</span>
          <div>
            <strong class="text-emerald-900 font-bold">出發起點：${escapeHtml(plannerStartPoint.name)}</strong>
            <p class="text-[11px] text-emerald-700">座標 (${plannerStartPoint.lat.toFixed(4)}, ${plannerStartPoint.lon.toFixed(4)})</p>
          </div>
        </div>
        <span class="text-[11px] text-emerald-600 font-semibold">起點出發</span>
      </div>
    `
  ];

  plannerCalculatedRoute.forEach((t, idx) => {
    const legKm = calculateHaversineKm(prevPos.lat, prevPos.lon, t.lat, t.lon);
    totalKm += legKm;
    prevPos = { lat: t.lat, lon: t.lon };

    stopsHtml.push(`
      <div class="flex items-center justify-between p-3 bg-white rounded-xl border border-slate-200 hover:border-amber-400 text-xs shadow-sm transition">
        <div class="flex items-center gap-3">
          <span class="w-6 h-6 rounded-full bg-brand-gold text-brand-600 font-black flex items-center justify-center text-xs shrink-0 shadow-inner">
            ${idx + 1}
          </span>
          <div>
            <strong class="text-sm font-bold text-slate-800">${escapeHtml(t.name)}</strong>
            <p class="text-[11px] text-slate-500">${escapeHtml(t.county)} ${escapeHtml(t.district)}・${escapeHtml(t.address || "無詳細地址")}</p>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <span class="text-[11px] text-amber-700 font-bold bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200">
            +${legKm.toFixed(1)} km
          </span>
          <div class="flex items-center gap-1">
            <button type="button" onclick="moveRouteStop(${idx}, -1)" ${idx === 0 ? 'disabled class="opacity-25 p-1"' : 'class="p-1 hover:bg-slate-100 rounded text-slate-600"'} title="上移">
              ▲
            </button>
            <button type="button" onclick="moveRouteStop(${idx}, 1)" ${idx === plannerCalculatedRoute.length - 1 ? 'disabled class="opacity-25 p-1"' : 'class="p-1 hover:bg-slate-100 rounded text-slate-600"'} title="下移">
              ▼
            </button>
            <button type="button" onclick="removeRouteStop(${idx})" class="p-1 hover:bg-rose-50 text-rose-500 rounded" title="從路線中移除">
              🗑️
            </button>
          </div>
        </div>
      </div>
    `);
  });

  container.innerHTML = stopsHtml.join("");

  // 更新統計數據
  const stopsEl = document.getElementById("route-stat-stops");
  const kmEl = document.getElementById("route-stat-km");
  const timeEl = document.getElementById("route-stat-time");

  if (stopsEl) stopsEl.textContent = plannerCalculatedRoute.length;
  if (kmEl) kmEl.textContent = totalKm.toFixed(1);

  if (timeEl) {
    const rideMins = Math.round((totalKm / 25) * 60);
    const worshipMins = plannerCalculatedRoute.length * 15;
    const totalMins = rideMins + worshipMins;
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    timeEl.textContent = h > 0 ? `約 ${h} 小時 ${m} 分` : `約 ${m} 分鐘`;
  }

  updateGoogleMultiNavUrl();
  if (window.lucide) lucide.createIcons();
}

window.moveRouteStop = function(index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= plannerCalculatedRoute.length) return;
  const temp = plannerCalculatedRoute[index];
  plannerCalculatedRoute[index] = plannerCalculatedRoute[targetIndex];
  plannerCalculatedRoute[targetIndex] = temp;
  renderRouteStops();
};

window.removeRouteStop = function(index) {
  if (plannerCalculatedRoute.length <= 1) {
    alert("路線中至少需保留一間廟宇！");
    return;
  }
  plannerCalculatedRoute.splice(index, 1);
  renderRouteStops();
};

// 產生 Google Maps 全程連續多點導航 URL
function updateGoogleMultiNavUrl() {
  const btn = document.getElementById("btn-export-google-multi");
  if (!btn || !plannerStartPoint || plannerCalculatedRoute.length === 0) return;

  const origin = `${plannerStartPoint.lat},${plannerStartPoint.lon}`;
  const lastStop = plannerCalculatedRoute[plannerCalculatedRoute.length - 1];
  const dest = `${lastStop.lat},${lastStop.lon}`;

  const middleStops = plannerCalculatedRoute.slice(0, -1);
  const waypoints = middleStops.map(t => `${t.lat},${t.lon}`).join("|");

  let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}`;
  if (waypoints) {
    url += `&waypoints=${encodeURIComponent(waypoints)}`;
  }
  btn.href = url;
}

// 儲存並列入規劃中行程
window.saveAndActivateRoute = async function() {
  if (!currentUser) {
    alert("權限不足：儲存路線並啟動導航需要登入 Google 帳號才能使用！");
    switchView("planner");
    return;
  }

  if (!plannerStartPoint || plannerCalculatedRoute.length === 0) return;

  const routeName = document.getElementById("route-name-input")?.value.trim() || `${plannerCurrentCounty}朝聖行程`;

  // 1. 批次將未參拜廟宇更新為 planned
  let updatedCount = 0;
  for (const t of plannerCalculatedRoute) {
    const existing = userRecordsMap[t.id];
    if (!existing || existing.status !== "visited") {
      const rec = {
        templeId: t.id,
        status: "planned",
        visitDate: existing?.visitDate || "",
        tags: existing?.tags || "",
        notes: existing?.notes || "",
        updatedAt: new Date().toISOString()
      };
      userRecordsMap[t.id] = rec;
      await db.records.put(rec);
      updatedCount++;

      if (currentUser && fbDb) {
        fbDb.collection("users").doc(currentUser.uid).collection("records").doc(t.id).set(rec, { merge: true }).catch(console.warn);
        fbDb.collection("pilgrimages").doc(t.id).set(rec, { merge: true }).catch(console.warn);
      }
    }
  }

  // 2. 建立行程紀錄物件
  const itinId = "itin_" + Date.now();
  const itinerary = {
    id: itinId,
    name: routeName,
    createdAt: new Date().toISOString(),
    startPoint: plannerStartPoint,
    templeIds: plannerCalculatedRoute.map(t => t.id),
    status: "active"
  };

  await db.itineraries.put(itinerary);
  if (currentUser && fbDb) {
    fbDb.collection("users").doc(currentUser.uid).collection("itineraries").doc(itinId).set(itinerary).catch(console.warn);
  }

  updateSavedItinerariesCount();
  renderAllViews();

  // 發送 GA4 行程儲存事件
  trackGAEvent("route_saved", {
    route_name: routeName,
    stops_count: plannerCalculatedRoute.length
  });

  // 3. 在地圖上展示並啟動導航抽屜
  activateRouteOnMap(itinerary);
  switchView("map");
};

// 在地圖上繪製活動路線與啟動導航
function activateRouteOnMap(itinerary) {
  activeNavItinerary = itinerary;
  activeRouteStopIndex = 0;

  if (!map) return;

  clearRouteLayersOnly();

  const stops = itinerary.templeIds.map(id => TEMPLES_DATA.find(x => x.id === id)).filter(Boolean);
  if (stops.length === 0) return;

  // 1. 繪製折線 Polyline (金色高雅虛線)
  const latlngs = [
    [itinerary.startPoint.lat, itinerary.startPoint.lon],
    ...stops.map(t => [t.lat, t.lon])
  ];

  activeRoutePolyline = L.polyline(latlngs, {
    color: "#b89025",
    weight: 5,
    opacity: 0.9,
    dashArray: "6, 8",
    lineCap: "round"
  }).addTo(map);

  // 2. 繪製起點圖釘
  const startIcon = L.divIcon({
    className: "custom-start-pin",
    html: `<div style="background:#059669;color:#fff;font-weight:bold;font-size:11px;padding:3px 8px;border-radius:12px;border:2px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,0.3);white-space:nowrap;display:flex;align-items:center;gap:3px;">🏁 起點</div>`,
    iconAnchor: [20, 20]
  });
  const startMarker = L.marker([itinerary.startPoint.lat, itinerary.startPoint.lon], { icon: startIcon });
  startMarker.addTo(map);
  activeRouteMarkers.push(startMarker);

  // 3. 繪製各站序號圖釘
  stops.forEach((t, idx) => {
    const numIcon = L.divIcon({
      className: "custom-route-step-pin",
      html: `
        <div style="background:#d4af37;color:#132c3f;font-weight:900;font-size:12px;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,0.35);">
          ${idx + 1}
        </div>
      `,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
    const m = L.marker([t.lat, t.lon], { icon: numIcon, zIndexOffset: 1000 + idx });
    m.bindPopup(`
      <div class="text-xs p-1 space-y-1">
        <strong class="text-sm font-bold text-slate-800">第 ${idx + 1} 站：${escapeHtml(t.name)}</strong>
        <p class="text-slate-500">${escapeHtml(t.county)} ${escapeHtml(t.district)}</p>
        <div class="flex gap-1.5 pt-1">
          <a href="https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lon}" target="_blank" class="flex-1 text-center py-1 bg-sky-500 text-white rounded font-bold">導航前往</a>
          <button onclick="openTempleModal('${t.id}')" class="flex-1 py-1 bg-brand-600 text-white rounded font-bold">打卡記事</button>
        </div>
      </div>
    `);
    m.addTo(map);
    activeRouteMarkers.push(m);
  });

  map.fitBounds(activeRoutePolyline.getBounds().pad(0.2));
  updateRouteNavDrawer();
}

function clearRouteLayersOnly() {
  if (activeRoutePolyline && map) {
    map.removeLayer(activeRoutePolyline);
    activeRoutePolyline = null;
  }
  if (activeRouteMarkers.length > 0 && map) {
    activeRouteMarkers.forEach(m => map.removeLayer(m));
    activeRouteMarkers = [];
  }
}

window.clearActiveRoute = function() {
  if (confirm("確認結束並從地圖上清除此路線展示？（已儲存之行程與打卡狀態依然完整保留）")) {
    clearRouteLayersOnly();
    activeNavItinerary = null;
    document.getElementById("active-route-drawer")?.classList.add("hidden");
  }
};

// 更新導航抽屜內容
function updateRouteNavDrawer() {
  const drawer = document.getElementById("active-route-drawer");
  if (!drawer || !activeNavItinerary) return;

  const stops = activeNavItinerary.templeIds.map(id => TEMPLES_DATA.find(x => x.id === id)).filter(Boolean);
  if (activeRouteStopIndex >= stops.length) {
    drawer.innerHTML = `
      <div class="text-center p-3 space-y-2">
        <h4 class="font-bold text-sm text-emerald-800 flex items-center justify-center gap-1.5">
          🎉 恭喜！本趟朝聖路線已全數參拜圓滿！
        </h4>
        <p class="text-xs text-slate-500">已拜訪全數 ${stops.length} 間廟宇。</p>
        <button onclick="clearActiveRoute()" class="px-4 py-2 bg-brand-600 text-white text-xs font-bold rounded-xl shadow">結束路線</button>
      </div>
    `;
    drawer.classList.remove("hidden");
    return;
  }

  drawer.classList.remove("hidden");
  const curStop = stops[activeRouteStopIndex];

  document.getElementById("drawer-route-title").textContent = activeNavItinerary.name;
  document.getElementById("drawer-step-index").textContent = `下一站（第 ${activeRouteStopIndex + 1} / ${stops.length} 站）`;
  document.getElementById("drawer-current-name").textContent = curStop.name;

  const prevCoords = activeRouteStopIndex === 0
    ? activeNavItinerary.startPoint
    : stops[activeRouteStopIndex - 1];
  const dist = calculateHaversineKm(prevCoords.lat, prevCoords.lon, curStop.lat, curStop.lon);
  document.getElementById("drawer-current-dist").textContent = `距離前站約 ${dist.toFixed(1)} 公里 (${curStop.county}${curStop.district})`;

  const navStopBtn = document.getElementById("drawer-btn-nav-stop");
  if (navStopBtn) {
    navStopBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${curStop.lat},${curStop.lon}`;
  }

  const navMultiBtn = document.getElementById("drawer-btn-nav-multi");
  if (navMultiBtn) {
    const origin = `${activeNavItinerary.startPoint.lat},${activeNavItinerary.startPoint.lon}`;
    const dest = `${stops[stops.length - 1].lat},${stops[stops.length - 1].lon}`;
    const waypoints = stops.slice(0, -1).map(t => `${t.lat},${t.lon}`).join("|");
    navMultiBtn.href = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&waypoints=${encodeURIComponent(waypoints)}`;
  }

  renderDrawerStopsList(stops);
  if (window.lucide) lucide.createIcons();
}

function renderDrawerStopsList(stops) {
  const listEl = document.getElementById("drawer-stops-list");
  if (!listEl) return;
  listEl.innerHTML = stops.map((t, idx) => {
    const isPast = idx < activeRouteStopIndex;
    const isCurrent = idx === activeRouteStopIndex;
    return `
      <div class="flex items-center justify-between p-1.5 rounded-lg ${isCurrent ? 'bg-amber-100/70 font-bold' : isPast ? 'opacity-50' : ''}">
        <div class="flex items-center gap-2">
          <span class="w-4 h-4 rounded-full ${isPast ? 'bg-emerald-500' : isCurrent ? 'bg-amber-500' : 'bg-slate-300'} text-white text-[10px] flex items-center justify-center font-bold">
            ${isPast ? '✓' : idx + 1}
          </span>
          <span class="line-clamp-1">${escapeHtml(t.name)}</span>
        </div>
        <a href="https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lon}" target="_blank" class="text-sky-600 text-[11px] font-bold hover:underline">導航</a>
      </div>
    `;
  }).join("");
}

window.toggleRouteDrawerList = function() {
  const el = document.getElementById("drawer-stops-list");
  if (el) el.classList.toggle("hidden");
};

// 打卡當前站點
window.checkinCurrentStop = function() {
  if (!activeNavItinerary) return;
  const stops = activeNavItinerary.templeIds.map(id => TEMPLES_DATA.find(x => x.id === id)).filter(Boolean);
  const curStop = stops[activeRouteStopIndex];
  if (curStop) {
    openTempleModal(curStop.id);
  }
};

// 自動校準「規劃中 (planned)」廟宇狀態與已存行程之一致性
async function reconcilePlannedStatus() {
  try {
    const allItineraries = await db.itineraries.toArray();
    const activePlannedTempleIds = new Set();
    allItineraries.forEach(itin => {
      if (Array.isArray(itin.templeIds)) {
        itin.templeIds.forEach(tid => activePlannedTempleIds.add(tid));
      }
    });

    let changed = false;
    const templesToRevert = [];

    for (const tid in userRecordsMap) {
      const rec = userRecordsMap[tid];
      if (rec && rec.status === "planned") {
        if (!activePlannedTempleIds.has(tid)) {
          templesToRevert.push(tid);
        }
      }
    }

    for (const tid of templesToRevert) {
      const rec = userRecordsMap[tid];
      const hasUserData = (rec.notes && rec.notes.trim()) || 
                          (rec.tags && rec.tags.trim()) || 
                          (rec.visitDate && rec.visitDate.trim()) || 
                          (templePhotosMap[tid] && templePhotosMap[tid].length > 0);

      if (!hasUserData) {
        delete userRecordsMap[tid];
        await db.records.delete(tid);
        if (currentUser && fbDb) {
          fbDb.collection("users").doc(currentUser.uid).collection("records").doc(tid).delete().catch(console.warn);
          fbDb.collection("pilgrimages").doc(tid).delete().catch(console.warn);
        }
      } else {
        rec.status = "unvisited";
        rec.updatedAt = new Date().toISOString();
        userRecordsMap[tid] = rec;
        await db.records.put(rec);
        if (currentUser && fbDb) {
          fbDb.collection("users").doc(currentUser.uid).collection("records").doc(tid).set(rec, { merge: true }).catch(console.warn);
          fbDb.collection("pilgrimages").doc(tid).set(rec, { merge: true }).catch(console.warn);
        }
      }
      changed = true;
    }

    if (changed) {
      renderAllViews();
    }
  } catch (err) {
    console.warn("校準規劃狀態異常:", err);
  }
}

// 已存行程管理
async function updateSavedItinerariesCount() {
  try {
    const count = await db.itineraries.count();
    const countBadge = document.getElementById("saved-itin-count");
    if (countBadge) countBadge.textContent = count;
  } catch (e) {
    console.warn("無法取得已存行程數量:", e);
  }
}

window.openSavedItinerariesModal = async function() {
  if (!currentUser) {
    alert("權限不足：檢視已存行程清單需要登入 Google 帳號才能使用！");
    switchView("planner");
    return;
  }

  // 每次開啟已存行程視窗時自動校準規劃中數據
  await reconcilePlannedStatus();

  const modal = document.getElementById("saved-itineraries-modal");
  const container = document.getElementById("saved-itineraries-list");
  if (!modal || !container) return;

  try {
    const itineraries = await db.itineraries.orderBy("createdAt").reverse().toArray();
    if (itineraries.length === 0) {
      container.innerHTML = '<p class="text-center text-slate-400 py-8 text-xs">目前尚未儲存任何規劃行程。可在規劃器運算後點擊「儲存」！</p>';
    } else {
      container.innerHTML = itineraries.map(itin => {
        const stopsCount = itin.templeIds.length;
        const dateStr = itin.createdAt ? new Date(itin.createdAt).toLocaleDateString("zh-TW") : "";
        return `
          <div class="p-4 bg-slate-50 hover:bg-white rounded-2xl border border-slate-200 shadow-sm transition space-y-2.5">
            <div class="flex items-start justify-between gap-2">
              <div>
                <strong class="text-sm font-bold text-slate-800">${escapeHtml(itin.name)}</strong>
                <p class="text-[11px] text-slate-400">建立時間：${dateStr}・共 ${stopsCount} 間廟宇</p>
              </div>
              <button onclick="deleteSavedItinerary('${itin.id}')" class="text-rose-500 hover:text-rose-700 text-xs p-1" title="刪除行程">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            </div>
            <div class="flex gap-2 pt-1">
              <button onclick="loadSavedItinerary('${itin.id}')" class="flex-1 py-1.5 bg-amber-500 hover:bg-amber-600 active:scale-95 text-white font-bold text-xs rounded-xl shadow-sm transition flex items-center justify-center gap-1">
                <i data-lucide="map" class="w-3.5 h-3.5"></i> 載入地圖導航
              </button>
            </div>
          </div>
        `;
      }).join("");
      if (window.lucide) lucide.createIcons();
    }
  } catch (err) {
    container.innerHTML = `<p class="text-rose-500 text-xs py-4">讀取行程異常：${err.message}</p>`;
  }

  modal.classList.remove("hidden");
};

window.closeSavedItinerariesModal = function() {
  document.getElementById("saved-itineraries-modal")?.classList.add("hidden");
};

window.loadSavedItinerary = async function(id) {
  if (!currentUser) {
    alert("權限不足：載入行程導航需要登入 Google 帳號才能使用！");
    return;
  }
  const itin = await db.itineraries.get(id);
  if (!itin) return;
  closeSavedItinerariesModal();
  activateRouteOnMap(itin);
  switchView("map");
};

window.deleteSavedItinerary = async function(id) {
  if (confirm("確認刪除此已存行程？")) {
    await db.itineraries.delete(id);
    if (currentUser && fbDb) {
      fbDb.collection("users").doc(currentUser.uid).collection("itineraries").doc(id).delete().catch(console.warn);
    }
    // 若地圖正顯示此行程，關閉抽屜並清除路線折線
    if (activeNavItinerary && activeNavItinerary.id === id) {
      closeRouteNavDrawer();
      clearRouteLayersOnly();
      activeNavItinerary = null;
    }
    // 立即校準規劃中狀態，將已無所屬行程的廟宇重設為未參拜
    await reconcilePlannedStatus();
    updateSavedItinerariesCount();
    openSavedItinerariesModal();
    renderAllViews();
  }
};

// 增補廟宇至目前行程
window.openAddTempleToRouteModal = function() {
  const modal = document.getElementById("add-temple-to-route-modal");
  const input = document.getElementById("add-temple-search-input");
  if (input) input.value = "";
  filterAddTempleList("");
  if (modal) modal.classList.remove("hidden");
};

window.closeAddTempleToRouteModal = function() {
  document.getElementById("add-temple-to-route-modal")?.classList.add("hidden");
};

window.filterAddTempleList = function(keyword) {
  const container = document.getElementById("add-temple-results-list");
  if (!container) return;

  const q = keyword.trim().toLowerCase();
  const existingIds = new Set(plannerCalculatedRoute.map(t => t.id));

  const candidates = TEMPLES_DATA.filter(t => {
    if (existingIds.has(t.id)) return false;
    if (!t.lat || !t.lon) return false;
    if (!q) return t.county === plannerCurrentCounty;
    return t.name.toLowerCase().includes(q) ||
           t.district.toLowerCase().includes(q) ||
           (t.address && t.address.toLowerCase().includes(q));
  }).slice(0, 30);

  if (candidates.length === 0) {
    container.innerHTML = '<p class="text-center text-slate-400 py-6 text-xs">查無符合關鍵字的未加入廟宇</p>';
    return;
  }

  container.innerHTML = candidates.map(t => `
    <div class="flex items-center justify-between p-2.5 bg-slate-50 hover:bg-white rounded-xl border border-slate-200 text-xs transition">
      <div>
        <strong class="text-slate-800 font-bold">${escapeHtml(t.name)}</strong>
        <p class="text-[11px] text-slate-500">${escapeHtml(t.county)} ${escapeHtml(t.district)}</p>
      </div>
      <button onclick="addTempleToCalculatedRoute('${t.id}')" class="px-3 py-1 bg-brand-600 hover:bg-brand-500 text-white rounded-lg font-bold text-xs shadow-sm transition">
        ＋ 加入
      </button>
    </div>
  `).join("");
};

window.addTempleToCalculatedRoute = function(templeId) {
  const t = TEMPLES_DATA.find(x => x.id === templeId);
  if (!t) return;
  plannerCalculatedRoute.push(t);
  renderRouteStops();
  closeAddTempleToRouteModal();
};
