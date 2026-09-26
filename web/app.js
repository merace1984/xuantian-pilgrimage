// =========================================================================
// 玄帝足跡 核心應用邏輯 (app.js)
// 支援：IndexedDB 本機離線優先 + Firebase 雲端雙向即時同步
// =========================================================================

// === 1. 本地資料庫初始化 (Dexie.js) ===
const db = new Dexie("XuanTianPilgrimageDB");
db.version(1).stores({
  records: "templeId, status, visitDate, updatedAt",
  photos: "++id, templeId, createdAt"
});

// === 2. 全域狀態 ===
let userRecordsMap = {};      // templeId -> record
let templePhotosMap = {};     // templeId -> array of { id, dataUrl }
let currentActiveTemple = null;
let currentTempPhotos = [];   // modal 暫存照片

let map = null;
let markersCluster = null;
let markersMap = {};          // templeId -> marker

// Firebase 實例與狀態
let fbApp = null;
let fbDb = null;
let fbStorage = null;
let fbAuth = null;
let currentUser = null;

// === 3. 頁面載入啟動 ===
document.addEventListener("DOMContentLoaded", async () => {
  if (window.lucide) lucide.createIcons();
  updateAuthUI(null);
  
  // 優先載入本地 IndexedDB 快取 (保證 0.1 秒秒開)
  await loadUserDataFromLocal();
  
  // 初始化地圖與各視圖
  initMap();
  populateCountySelect();
  bindEvents();
  renderAllViews();

  // 初始化 Firebase 雲端引擎
  initFirebaseEngine();
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
  } catch (err) {
    console.error("載入本地 IndexedDB 失敗:", err);
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

    // 啟用 Firestore 離線持久化 (斷網暫存，連網自動同步)
    fbDb.enablePersistence({ synchronizeTabs: true }).catch((err) => {
      console.warn("Firestore 離線快取初始化:", err.code);
    });

    // 監聽登入狀態
    fbAuth.onAuthStateChanged((user) => {
      currentUser = user;
      updateAuthUI(user);
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
            templePhotosMap[tid] = data.photos;
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

  if (indicator) {
    if (state === "online") {
      indicator.className = "w-2 h-2 rounded-full bg-emerald-400";
    } else if (state === "syncing") {
      indicator.className = "w-2 h-2 rounded-full bg-amber-400 animate-ping";
    } else {
      indicator.className = "w-2 h-2 rounded-full bg-slate-400";
    }
  }
  if (statusText) statusText.textContent = text;
}

function updateAuthUI(user) {
  const btnLogin = document.getElementById("btn-login");
  const userProfile = document.getElementById("user-profile");
  const userAvatar = document.getElementById("user-avatar");
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
    
    // 設定頁鎖定
    if (settingsLockedBox) settingsLockedBox.classList.remove("hidden");
    if (settingsContentBox) settingsContentBox.classList.add("hidden");
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
    alert("目前尚未設定 Firebase 雲端金鑰。\n\n請依照指引在 private/config/firebase-config.js 填入您的 Firebase 專案設定並上傳至網站根目錄，即可啟用 Google 帳號管理員驗證！");
    return;
  }
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    const result = await fbAuth.signInWithPopup(provider);
    currentUser = result.user;
    updateAuthUI(currentUser);
    alert("🎉 登入成功！已驗證管理員身分，開啟設定與編輯權限。");
  } catch (err) {
    console.error("Google 登入失敗:", err);
    alert("登入失敗: " + err.message);
  }
}

// Google 登出
async function logoutGoogle() {
  if (fbAuth) {
    await fbAuth.signOut();
    currentUser = null;
    updateAuthUI(null);
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
    layers: [googleStreet],
    zoomControl: true,
    scrollWheelZoom: true
  });

  const baseLayers = {
    "Google 街道圖 (推薦)": googleStreet,
    "臺灣通用電子地圖 (國土測繪)": nlscEmap,
    "OpenStreetMap 標準圖": osmStandard,
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

    const statusLabel = status === "visited" ? '<span class="text-emerald-700 bg-emerald-100 font-bold px-1.5 py-0.5 rounded text-[10px]">🟢 已參拜</span>' :
                        status === "planned" ? '<span class="text-amber-700 bg-amber-100 font-bold px-1.5 py-0.5 rounded text-[10px]">🟡 規劃中</span>' :
                        '<span class="text-slate-600 bg-slate-100 font-bold px-1.5 py-0.5 rounded text-[10px]">⚪ 未參拜</span>';

    const popupHtml = `
      <div class="text-xs p-1 space-y-1.5 font-sans min-w-[190px]">
        <div class="flex items-center justify-between gap-1">
          <strong class="text-sm font-bold text-slate-800">${escapeHtml(t.name)}</strong>
          ${statusLabel}
        </div>
        <p class="text-slate-500">${escapeHtml(t.county)}${escapeHtml(t.district)}</p>
        <p class="text-[11px] text-slate-400 line-clamp-1">${escapeHtml(t.address || "無詳細地址")}</p>
        <div class="flex gap-1.5 pt-1">
          <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(t.lat)},${encodeURIComponent(t.lon)}" target="_blank"
             class="flex-1 text-center py-1 bg-sky-500 hover:bg-sky-600 text-white rounded font-bold text-[11px]">導航</a>
          <button onclick="openTempleModal('${escapeHtml(t.id)}')"
             class="flex-1 py-1 bg-brand-600 hover:bg-brand-500 text-white rounded font-bold text-[11px]">打卡記事</button>
        </div>
      </div>
    `;

    marker.bindPopup(popupHtml);
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

  if (mapSelect) mapSelect.innerHTML = optionsHtml;
  if (listSelect) listSelect.innerHTML = optionsHtml;
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
  const views = ["map", "list", "dashboard", "timeline", "settings"];
  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.classList.toggle("hidden", v !== viewName);
  });

  document.querySelectorAll(".nav-tab").forEach(tab => {
    const isTarget = tab.getAttribute("onclick").includes(`'${viewName}'`);
    tab.classList.toggle("text-brand-600", isTarget);
    tab.classList.toggle("text-slate-500", !isTarget);
  });

  if (viewName === "map") {
    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 100);
  } else if (viewName === "list") {
    renderListView();
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
          notesEl.textContent = record.notes || "（未留下心得筆記）";
        }

        if (photosEl) {
          if (currentTempPhotos.length > 0) {
            photosEl.innerHTML = currentTempPhotos.map(p => {
              const safeUrl = sanitizeImageUrl(p.dataUrl);
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

  if (currentTempPhotos.length === 0) {
    container.innerHTML = '<p id="no-photos-hint" class="col-span-3 text-center text-xs text-slate-400 py-4">尚未上傳照片</p>';
    return;
  }

  container.innerHTML = currentTempPhotos.map((p, idx) => `
    <div class="relative group rounded-lg overflow-hidden border border-slate-200 aspect-square bg-slate-100">
      <img src="${sanitizeImageUrl(p.dataUrl)}" class="w-full h-full object-cover" />
      <button onclick="removePhoto(${idx})" class="absolute top-1 right-1 bg-black/70 hover:bg-rose-600 text-white p-1 rounded-full text-[10px] transition">
        ✕
      </button>
    </div>
  `).join("");
}

window.removePhoto = function(index) {
  currentTempPhotos.splice(index, 1);
  renderModalPhotos();
};

async function compressImage(file, maxDimension = 1200, quality = 0.8) {
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

// 輔助：將 Base64 DataURL 轉成 Blob 供 Firebase Storage 上傳
function dataURLtoBlob(dataurl) {
  const arr = dataurl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

// 儲存紀錄 (整合 Firebase 雲端與 Dexie 本地持久化)
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
  saveBtn.disabled = true;
  saveBtn.innerHTML = '正在儲存...';

  try {
    const finalPhotoUrls = [];

    // 若已啟用 Firebase 且使用者已登入，上傳相片至 Cloud Storage
    const isCloudEnabled = fbStorage && fbDb && currentUser;

    if (isCloudEnabled && currentTempPhotos.length > 0) {
      setCloudStatus("syncing", "上傳相片中...");
      for (let i = 0; i < currentTempPhotos.length; i++) {
        const p = currentTempPhotos[i];
        if (p.dataUrl.startsWith("http")) {
          // 已是遠端 URL，保留
          finalPhotoUrls.push(p);
        } else {
          // 本地 Base64，上傳至 Cloud Storage
          const blob = dataURLtoBlob(p.dataUrl);
          const fileName = `photo_${Date.now()}_${i}.webp`;
          const storageRef = fbStorage.ref(`photos/${tid}/${fileName}`);
          await storageRef.put(blob);
          const downloadUrl = await storageRef.getDownloadURL();
          finalPhotoUrls.push({
            templeId: tid,
            dataUrl: downloadUrl,
            createdAt: new Date().toISOString()
          });
        }
      }
    } else {
      // 離線或未登入模式：保留本地 WebP DataURL
      currentTempPhotos.forEach((p, idx) => {
        finalPhotoUrls.push({
          templeId: tid,
          dataUrl: p.dataUrl,
          createdAt: new Date().toISOString()
        });
      });
    }

    const record = {
      templeId: tid,
      templeName: currentActiveTemple.name,
      county: currentActiveTemple.county,
      district: currentActiveTemple.district,
      status,
      visitDate,
      tags,
      notes,
      photos: finalPhotoUrls,
      userId: currentUser ? currentUser.uid : null,
      updatedAt: new Date().toISOString()
    };

    // 1. 寫入本地 IndexedDB (秒速完成)
    await db.records.put(record);
    userRecordsMap[tid] = record;

    await db.photos.where("templeId").equals(tid).delete();
    if (finalPhotoUrls.length > 0) {
      await db.photos.bulkAdd(finalPhotoUrls);
      templePhotosMap[tid] = finalPhotoUrls;
    } else {
      delete templePhotosMap[tid];
    }

    // 2. 寫入 Firebase Firestore (雲端同步)
    if (fbDb && currentUser) {
      setCloudStatus("syncing", "雲端同步中...");
      await fbDb.collection("pilgrimages").doc(tid).set(record, { merge: true });
      setCloudStatus("online", "雲端已連線");
    }

    document.getElementById("temple-modal").classList.add("hidden");
    renderAllViews();
    alert("🎉 參拜紀錄儲存成功！" + (isCloudEnabled ? "（已同步至雲端）" : ""));
  } catch (err) {
    console.error("儲存失敗:", err);
    alert("儲存失敗: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '儲存紀錄';
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

    // 刪除雲端
    if (fbDb && currentUser) {
      await fbDb.collection("pilgrimages").doc(tid).delete();
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

  const countyFilter = document.getElementById("list-filter-county")?.value || "";
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
          ${record?.notes ? `<p class="text-xs text-slate-600 bg-slate-50 p-2 rounded-lg border border-slate-100 line-clamp-2">💬 ${escapeHtml(record.notes)}</p>` : ''}
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

function renderDashboardView() {
  const visitedTemples = Object.values(userRecordsMap).filter(r => r.status === "visited");
  const totalVisited = visitedTemples.length;
  const percent = ((totalVisited / TEMPLES_DATA.length) * 100).toFixed(1);

  document.getElementById("dash-visited-big").textContent = totalVisited;
  document.getElementById("dash-percent-big").textContent = `${percent}%`;

  const tainanTotal = 96;
  const tainanVisited = visitedTemples.filter(r => {
    const t = TEMPLES_DATA.find(x => x.id === r.templeId);
    return t && t.county === "臺南市";
  }).length;
  const tainanPercent = Math.round((tainanVisited / tainanTotal) * 100);

  document.getElementById("dash-tainan-ratio").textContent = `${tainanVisited} / ${tainanTotal}`;
  document.getElementById("dash-tainan-bar").style.width = `${tainanPercent}%`;

  const countyStats = {};
  TEMPLES_DATA.forEach(t => {
    if (!countyStats[t.county]) countyStats[t.county] = { total: 0, visited: 0 };
    countyStats[t.county].total++;
    if (userRecordsMap[t.id]?.status === "visited") {
      countyStats[t.county].visited++;
    }
  });

  const sortedCounties = Object.entries(countyStats).sort((a, b) => b[1].total - a[1].total);
  const container = document.getElementById("county-progress-list");
  if (!container) return;

  container.innerHTML = sortedCounties.map(([c, stat]) => {
    const p = Math.round((stat.visited / stat.total) * 100);
    return `
      <div class="space-y-1">
        <div class="flex items-center justify-between text-xs">
          <span class="font-bold text-slate-700">${escapeHtml(c)}</span>
          <span class="text-slate-500">${stat.visited} / ${stat.total} 間 (${p}%)</span>
        </div>
        <div class="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
          <div class="bg-brand-600 h-full rounded-full transition-all duration-300" style="width: ${p}%"></div>
        </div>
      </div>
    `;
  }).join("");
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
    const photos = templePhotosMap[log.templeId] || [];

    const photosGrid = photos.length > 0 ? `
      <div class="grid grid-cols-2 md:grid-cols-3 gap-2 mt-3">
        ${photos.map(p => {
          const safeUrl = sanitizeImageUrl(p.dataUrl);
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

        ${log.notes ? `
          <div class="text-sm text-slate-700 bg-slate-50 p-3.5 rounded-2xl border border-slate-100 whitespace-pre-wrap leading-relaxed">
            ${escapeHtml(log.notes)}
          </div>
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
    const backupData = {
      version: "2.0",
      exportDate: new Date().toISOString(),
      records: allRecords,
      photos: allPhotos
    };

    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `玄帝足跡參拜備份_${new Date().toISOString().slice(0, 10)}.json`;
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

        if (confirm(`確認匯入備份？包含 ${backup.records.length} 筆參拜紀錄及 ${backup.photos?.length || 0} 張相片。`)) {
          await db.records.clear();
          await db.photos.clear();
          if (backup.records.length) await db.records.bulkAdd(backup.records);
          if (backup.photos?.length) await db.photos.bulkAdd(backup.photos);
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
    if (confirm("⚠️ 警告：這將會清除您在本機所有的暫存參拜打卡紀錄與相片，確認清除？")) {
      await db.records.clear();
      await db.photos.clear();
      userRecordsMap = {};
      templePhotosMap = {};
      renderAllViews();
      alert("已重設本機紀錄");
    }
  });
}
