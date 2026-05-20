// ====== CẤU HÌNH TELEGRAM ======
const TELEGRAM_BOT_TOKEN = "8749670439:AAG1OOz8bjKkBU_VVinprigfJsAIBt_uNHc"; 
const TELEGRAM_CHAT_ID = "-5143704269";

let notifiedOrderIds = new Set(JSON.parse(localStorage.getItem('notifiedOrders') || '[]'));
let isFirstLoadForTele = notifiedOrderIds.size === 0;

function sendTelegramNotification(msg) {
    if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN.includes('ĐIỀN') || !TELEGRAM_CHAT_ID) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    }).catch(err => console.error("Lỗi gửi Tele:", err));
}

function checkAndNotifyNewOrders(orders) {
    let hasNew = false;
    orders.forEach(po => {
        const oid = String(po.id);
        if (!notifiedOrderIds.has(oid)) {
            notifiedOrderIds.add(oid);
            hasNew = true;
            
            // Không báo các đơn cũ từ trước khi mở tab
            if (!isFirstLoadForTele) {
                const sideStr = String(po.side) === '0' ? '🟢 ĐƠN MUA' : '🔴 ĐƠN BÁN';
                const amount = parseFloat(po.amount || 0).toLocaleString();
                const qty = parseFloat(po.quantity || po.current_usdt || 0).toFixed(2);
                const msg = `🚨 <b>CÓ ${sideStr} MỚI!</b>\n\n` +
                            `🆔 ID: <code>${po.id}</code>\n` +
                            `👤 Nick: <b>${po.account_name}</b>\n` +
                            `💵 Giá trị: <b>${amount} ${po.currencyId || '?'}</b> (~ ${qty} USDT)\n` +
                            `💳 PTTT: <b>${po.payment_method_name}</b>\n` +
                            `⏳ Lúc: ${new Date().toLocaleTimeString('vi-VN')}`;
                sendTelegramNotification(msg);
            }
        }
    });

    if (hasNew) {
        // Giữ lại 500 ID gần nhất để tránh nặng bộ nhớ trình duyệt
        let arr = [...notifiedOrderIds];
        if (arr.length > 500) arr = arr.slice(arr.length - 500);
        notifiedOrderIds = new Set(arr);
        localStorage.setItem('notifiedOrders', JSON.stringify([...notifiedOrderIds]));
    }
    isFirstLoadForTele = false;
}
// ==================================
let currentCoreGroup = window.APP_CONFIG ? window.APP_CONFIG.coreGroup : ""; 
let currentAccountsList = []; 
let isEditMode = !currentCoreGroup; 
let autoRefreshTimer = null; 
let currentRefPrice = 0; 

let globalAllGroups = [], globalConfirmedOrders = {}; 
let globalActiveOrders = {}, globalArchivingOrders = {}, globalArchivedOrders = {}; 
let globalActiveSellOrders = {}, globalArchivingSellOrders = {}, globalArchivedSellOrders = {};
let latestConfigs = [], latestBuyAds = [], globalAllAds = [], globalAllPendingOrders = [];
let globalLinkedSellAds = {}, globalLinkedSellOrders = {}; 

// SET lưu trạng thái QC nào đang Update để chống spam API
let updatingAds = new Set(); 
let creatingSellAds = new Set(); // Chặn spam API tạo nhiều QC bán cho 1 đơn
let cancellingSellAds = new Set(); // Chặn spam API xóa QC

// HÀM LƯU/ĐỌC TRẠNG THÁI AUTO UPDATE GIÁ (Lưu vào bộ nhớ trình duyệt)
function isAutoUpdateAd(adId) {
    let set = new Set(JSON.parse(localStorage.getItem('autoUpdateAdIds') || '[]'));
    return set.has(String(adId));
}
function toggleAutoUpdateAd(adId, isChecked) {
    let set = new Set(JSON.parse(localStorage.getItem('autoUpdateAdIds') || '[]'));
    if(isChecked) set.add(String(adId));
    else set.delete(String(adId));
    localStorage.setItem('autoUpdateAdIds', JSON.stringify([...set]));
    Toast.fire({ icon: isChecked ? 'success' : 'info', title: isChecked ? 'Đã BẬT Auto Update Giá' : 'Đã TẮT Auto Update Giá' });
    checkAndRunAutoUpdates(); // Kích hoạt kiểm tra liền
}

const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, showCloseButton: true, timer: 5000, timerProgressBar: true, customClass: { popup: 'custom-dark-toast' } });
function showErrorToast(msg) { Toast.fire({ icon: 'error', title: msg, customClass: { popup: 'custom-dark-toast toast-error-bg' } }); }

window.onload = function() { 
    fetchGroups(); loadProxy(); startCountdownTimer();
    document.getElementById('apiUrlDisplay').innerText = window.location.origin + '/api/export_orders';
    document.getElementById('apiConfirmUrlDisplay').innerText = window.location.origin + '/api/confirm_order';
};

function startCountdownTimer() {
    setInterval(() => {
        let needsReRender = false; const now = Date.now();
        Object.keys(globalArchivingOrders).forEach(id => { if (now - globalArchivingOrders[id].archiveStartTime >= 3600000) { globalArchivedOrders[id] = globalArchivingOrders[id]; delete globalArchivingOrders[id]; needsReRender = true; } });
        Object.keys(globalArchivingSellOrders).forEach(id => { if (now - globalArchivingSellOrders[id].archiveStartTime >= 3600000) { globalArchivedSellOrders[id] = globalArchivingSellOrders[id]; delete globalArchivingSellOrders[id]; needsReRender = true; } });
        if (needsReRender) { renderDashboardUI(); renderArchiveTab(); }
        
        document.querySelectorAll('.archive-countdown').forEach(el => {
            const start = parseInt(el.getAttribute('data-start')); const remain = 3600000 - (Date.now() - start);
            if(remain > 0) { const m = Math.floor(remain / 60000); const s = Math.floor((remain % 60000) / 1000); el.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`; } else { el.innerText = "Hết hạn"; }
        });

        // --- ĐOẠN THÊM MỚI: ĐẾM NGƯỢC THỜI GIAN THANH TOÁN ---
        document.querySelectorAll('.payment-countdown').forEach(el => {
            const expire = parseInt(el.getAttribute('data-expire'));
            const remainMs = expire - Date.now();
            if(remainMs > 0) {
                const m = Math.floor(remainMs / 60000);
                const s = Math.floor((remainMs % 60000) / 1000);
                // Sửa hiển thị tại đây:
                el.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            } else {
                el.innerText = `00:00`;
            }
        });
    }, 1000);
}

// HÀM ÉP LƯU TRỮ NGAY LẬP TỨC BỎ QUA 60 PHÚT
function forceArchiveOrder(orderId, isSell) {
    // 1. Lưu vào LocalStorage để khi F5 không bị lấy lại
    let set = new Set(JSON.parse(localStorage.getItem('forceArchivedOrders') || '[]'));
    set.add(String(orderId));
    let arr = [...set];
    if (arr.length > 2000) arr = arr.slice(arr.length - 2000); // Giữ tối đa 2000 đơn để không nặng máy
    localStorage.setItem('forceArchivedOrders', JSON.stringify(arr));

    // 2. Chuyển UI ngay lập tức
    if (isSell) {
        if (globalArchivingSellOrders[orderId]) {
            globalArchivedSellOrders[orderId] = globalArchivingSellOrders[orderId];
            delete globalArchivingSellOrders[orderId];
        }
    } else {
        if (globalArchivingOrders[orderId]) {
            globalArchivedOrders[orderId] = globalArchivingOrders[orderId];
            delete globalArchivingOrders[orderId];
        }
    }
    renderDashboardUI();
    renderArchiveTab();
    Toast.fire({ icon: 'success', title: 'Đã chuyển vào Lưu trữ!' });
}

function renderArchiveTab() {
    const contentDiv = document.getElementById('archiveOrdersContent'), orders = Object.values(globalArchivedOrders), sellOrders = Object.values(globalArchivedSellOrders);
    if(orders.length === 0 && sellOrders.length === 0) { contentDiv.innerHTML = `<div class="text-center py-5 text-muted"><i class="bi bi-inbox fs-1"></i><br>Chưa có đơn nào.</div>`; } else {
        let html = '<div class="list-group shadow-sm p-2">'; orders.forEach(po => { html += generateOrderRowHtml(po, {fiat: po.currencyId||'?', coin: po.tokenId||'USDT'}, false, true); }); sellOrders.forEach(spo => { html += generateSellOrderHtml(spo, false, true); }); html += '</div>'; contentDiv.innerHTML = html;
    }
}

function addTerminalLog(msg, type="info") { 
    const term = document.getElementById('terminalLogs'); const time = new Date().toLocaleTimeString('vi-VN', {hour12: false}); 
    let colorClass = type === 'error' ? 'log-error' : (type === 'success' ? 'log-success' : (type === 'warn' ? 'log-warn' : 'log-info'));
    term.innerHTML += `<div><span class="log-time">[${time}]</span> <span class="${colorClass}">${msg}</span></div>`; term.scrollTop = term.scrollHeight; 
}

function calculateFiatLimits() { 
    const minUsdt = parseFloat(document.getElementById('cfgMinUsdt').value) || 0, maxUsdt = parseFloat(document.getElementById('cfgMaxUsdt').value) || 0; 
    document.getElementById('cfgMin').value = (currentRefPrice > 0 && minUsdt > 0) ? +(minUsdt * currentRefPrice).toFixed(2) : ''; 
    document.getElementById('cfgMax').value = (currentRefPrice > 0 && maxUsdt > 0) ? +(maxUsdt * currentRefPrice).toFixed(2) : ''; 
}

function loadProxy() { fetch('/api/get_proxy').then(r => r.json()).then(d => { if(d.status === 'success'){ ['proxyIp','proxyPort','proxyUser','proxyPass'].forEach(k => document.getElementById(k).value = d.proxy[k.replace('proxy','').toLowerCase()] || ''); document.getElementById('proxyDisplayText').innerText = d.proxy.ip || "Chưa cấu hình"; } }); }
function saveProxy() { const data = { ip: document.getElementById('proxyIp').value.trim(), port: document.getElementById('proxyPort').value.trim(), user: document.getElementById('proxyUser').value.trim(), pass: document.getElementById('proxyPass').value.trim() }; fetch('/api/save_proxy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json()).then(d => { Toast.fire({ icon: 'success', title: d.message }); addTerminalLog("Đã lưu Proxy.", "success"); document.getElementById('proxyDisplayText').innerText = data.ip || "Chưa cấu hình"; }); }

function fetchGroups() {
    fetch('/api/get_groups').then(res => res.json()).then(data => {
        const select = document.getElementById('groupSelect'); select.innerHTML = '<option value="">-- Chọn --</option>';
        if (data.status === 'success' && data.groups) {
            globalAllGroups = data.groups; data.groups.forEach(g => select.innerHTML += `<option value="${g}" ${g === currentCoreGroup ? 'selected' : ''}>${g.toUpperCase()}</option>`);
            if (currentCoreGroup) { select.disabled = true; document.getElementById('btnLoadAccounts').disabled = true; document.getElementById('btnEditConfig').style.display = 'block'; isEditMode = false; document.getElementById('proxyDisplayArea').classList.replace('d-none', 'd-flex'); document.getElementById('proxyEditArea').classList.replace('d-flex', 'd-none'); loadAccounts(); document.getElementById('buyAdsCard').style.display = 'block'; loadBuyAdsDashboard(); } 
            else { select.disabled = false; document.getElementById('btnLoadAccounts').disabled = false; document.getElementById('btnEditConfig').style.display = 'none'; isEditMode = true; document.getElementById('proxyDisplayArea').classList.replace('d-flex', 'd-none'); document.getElementById('proxyEditArea').classList.replace('d-none', 'd-flex'); }
        } else { select.innerHTML = '<option value="">Lỗi kết nối</option>'; }
    });
}

function enableEdit() { isEditMode = true; document.getElementById('groupSelect').disabled = false; document.getElementById('btnLoadAccounts').disabled = false; document.getElementById('btnEditConfig').style.display = 'none'; document.getElementById('proxyDisplayArea').classList.replace('d-flex', 'd-none'); document.getElementById('proxyEditArea').classList.replace('d-none', 'd-flex'); document.querySelectorAll('.role-select').forEach(s => s.disabled = false); renderAccounts(); if (currentAccountsList.length > 0) document.getElementById('saveActionArea').style.display = 'block'; }
function handleGroupChange() { document.getElementById('accountsArea').innerHTML = `<div class="text-muted small fst-italic ms-4">Bấm tải lại.</div>`; document.getElementById('accCount').innerText = "0"; document.getElementById('saveActionArea').style.display = 'none'; document.getElementById('buyAdsCard').style.display = 'none'; document.getElementById('dashboardAdsContent').innerHTML = '<div class="text-center py-4 text-muted small">Bấm "Làm mới Bảng"</div>'; currentAccountsList = []; globalActiveOrders = {}; globalArchivingOrders = {}; globalActiveSellOrders = {}; globalArchivingSellOrders = {}; if (autoRefreshTimer) clearInterval(autoRefreshTimer); document.getElementById('updateTimeText').innerHTML = ''; }

function loadAccounts() {
    const group = document.getElementById('groupSelect').value; if (!group) return; document.getElementById('btnLoadAccounts').disabled = true; document.getElementById('accountsArea').style.display = 'none'; document.getElementById('loadingArea').style.display = 'block';
    fetch(`/api/get_accounts?group=${group}`).then(r => r.json()).then(data => {
        document.getElementById('loadingArea').style.display = 'none'; if(isEditMode) document.getElementById('btnLoadAccounts').disabled = false;
        if (data.status === 'success' && data.accounts) { currentAccountsList = data.accounts; renderAccounts(); document.getElementById('accountsArea').style.display = 'block'; if (isEditMode && currentAccountsList.length > 0) document.getElementById('saveActionArea').style.display = 'block'; } else document.getElementById('accountsArea').innerHTML = `<div class="text-danger small fst-italic ms-4">Lỗi: ${data.message}</div>`;
    });
}

function renderAccounts() {
    const accArea = document.getElementById('accountsArea'); document.getElementById('accCount').innerText = `${currentAccountsList.length}`; if (currentAccountsList.length === 0) { accArea.innerHTML = '<div class="text-muted small fst-italic ms-4">Không có.</div>'; return; }
    let html = '<div class="row g-2">'; currentAccountsList.forEach((acc, i) => { let apiText = acc.masked_api ? (isEditMode ? `<span class="text-success ms-2" style="font-size: 0.8rem;">(API: ${acc.masked_api})</span>` : `<span class="text-success ms-2 fw-bold" style="font-size: 0.85rem;"><i class="bi bi-check-circle-fill"></i> API OK</span>`) : `<span class="text-danger ms-2 fw-bold" style="font-size: 0.85rem;"><i class="bi bi-x-circle-fill"></i> Lỗi API</span>`; html += `<div class="col-xl-3 col-lg-4 col-md-6 col-sm-6"><div class="d-flex justify-content-between align-items-center border rounded px-2 py-2 bg-white shadow-sm"><div class="d-flex align-items-center text-truncate me-2" title="${acc.email}"><i class="bi bi-person-circle text-primary fs-6 me-1"></i><span class="fw-bold text-dark" style="font-size: 0.95rem;">${acc.email}</span>${apiText}</div><select class="form-select form-select-sm role-select ${getRoleClass(acc.role)}" id="role_${i}" onchange="updateRoleClass(this)" style="width: 105px; font-size: 0.8rem; padding: 0.1rem 1rem 0.1rem 0.4rem;" ${isEditMode?'':'disabled'}><option value="none" ${acc.role==='none'?'selected':''}>TRỐNG</option><option value="buy" ${acc.role==='buy'?'selected':''}>ACC MUA</option><option value="sell" ${acc.role==='sell'?'selected':''}>ACC BÁN</option></select></div></div>`; }); accArea.innerHTML = html + '</div>';
}

function getRoleClass(role) { return role==='buy'?'role-buy':(role==='sell'?'role-sell':'role-none'); }
function updateRoleClass(el) { el.classList.remove('role-buy','role-sell','role-none'); el.classList.add(getRoleClass(el.value)); }
function copyAdId(id) { navigator.clipboard.writeText(id).then(() => Toast.fire({ icon: 'success', title: `Đã copy: ${id}`})); }

function saveConfiguration() {
    const group = document.getElementById('groupSelect').value; const btn = document.getElementById('btnSaveConfig'); btn.innerHTML = 'Đang lưu...'; btn.disabled = true; let payload = currentAccountsList.map((acc, i) => ({ email: acc.email, role: document.getElementById(`role_${i}`).value }));
    fetch('/api/save_config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ core_group: group, accounts: payload }) }).then(r => r.json()).then(data => { btn.innerHTML = '<i class="bi bi-floppy-fill me-1"></i> LƯU CẤU HÌNH'; btn.disabled = false; if (data.status === 'success') { Toast.fire({ icon: 'success', title: data.message }); fetchGroups(); } });
}

function openAdConfig(fiat, ptttStr, refPrice) {
    const group = document.getElementById('groupSelect').value; currentRefPrice = parseFloat(refPrice) || 0; 
    if(document.getElementById('dispFiat')) document.getElementById('dispFiat').innerText = fiat; 
    if(document.getElementById('cfgFiat')) document.getElementById('cfgFiat').value = fiat; 
    if(document.getElementById('dispPttt')) document.getElementById('dispPttt').innerText = ptttStr; 
    if(document.getElementById('dispRefPrice')) document.getElementById('dispRefPrice').innerText = currentRefPrice > 0 ? currentRefPrice.toLocaleString('en-US') : 'N/A';
    
    fetch(`/api/get_ad_config?group=${group}&fiat=${fiat}`).then(r => r.json()).then(d => {
        let data = d.status === 'success' ? d.data : {};
        if(document.getElementById('cfgMinUsdt')) document.getElementById('cfgMinUsdt').value = data.minUsdt || '';
        if(document.getElementById('cfgMaxUsdt')) document.getElementById('cfgMaxUsdt').value = data.maxUsdt || '';
        if(document.getElementById('cfgQty')) document.getElementById('cfgQty').value = data.quantity || '';
        if(document.getElementById('cfgQuantity')) document.getElementById('cfgQuantity').value = data.quantity || '';
        if(document.getElementById('cfgMargin')) document.getElementById('cfgMargin').value = data.margin || '0'; // Thêm dòng đọc Margin
        if(document.getElementById('cfgRemark')) document.getElementById('cfgRemark').value = data.remark || '';
        
        const tp = data.tradingPreferenceSet || {}; 
        
        if(document.getElementById('tpKyc')) document.getElementById('tpKyc').checked = String(tp.isKyc) === "1"; 
        if(document.getElementById('tpEmail')) document.getElementById('tpEmail').checked = String(tp.isEmail) === "1"; 
        if(document.getElementById('tpMobile')) document.getElementById('tpMobile').checked = String(tp.isMobile) === "1"; 

        if(document.getElementById('tpUnpost')) document.getElementById('tpUnpost').checked = String(tp.hasUnPostAd) === "1"; 
        if(document.getElementById('tpReg')) document.getElementById('tpReg').checked = String(tp.hasRegisterTime) === "1"; 
        if(document.getElementById('tpRegDay')) { document.getElementById('tpRegDay').disabled = String(tp.hasRegisterTime) !== "1"; document.getElementById('tpRegDay').value = tp.registerTimeThreshold || "0"; }
        if(document.getElementById('tpOrder')) document.getElementById('tpOrder').checked = String(tp.hasOrderFinishNumberDay30) === "1"; 
        if(document.getElementById('tpOrderNum')) { document.getElementById('tpOrderNum').disabled = String(tp.hasOrderFinishNumberDay30) !== "1"; document.getElementById('tpOrderNum').value = tp.orderFinishNumberDay30 || "0"; }
        if(document.getElementById('tpRate')) document.getElementById('tpRate').checked = String(tp.hasCompleteRateDay30) === "1"; 
        if(document.getElementById('tpRateNum')) { document.getElementById('tpRateNum').disabled = String(tp.hasCompleteRateDay30) !== "1"; document.getElementById('tpRateNum').value = tp.completeRateDay30 || "0"; }
        
        calculateFiatLimits(); 
        const modalEl = document.getElementById('configAdModal');
        if(modalEl) { const modal = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl); modal.show(); }
    }).catch(err => {
        console.error(err); const modalEl = document.getElementById('configAdModal');
        if(modalEl) { const modal = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl); modal.show(); }
    });
}

function submitAdConfig() {
    const qtyVal = document.getElementById('cfgQty') ? document.getElementById('cfgQty').value : (document.getElementById('cfgQuantity') ? document.getElementById('cfgQuantity').value : '');
    const p = { 
        group: document.getElementById('groupSelect').value, 
        fiat: document.getElementById('cfgFiat').value, 
        minUsdt: document.getElementById('cfgMinUsdt').value, 
        maxUsdt: document.getElementById('cfgMaxUsdt').value, 
        quantity: qtyVal, 
        margin: document.getElementById('cfgMargin') ? document.getElementById('cfgMargin').value : '0', // Thêm dòng gửi Margin
        paymentPeriod: "30", 
        remark: document.getElementById('cfgRemark').value, 
        tradingPreferenceSet: { 
            isKyc: document.getElementById('tpKyc') && document.getElementById('tpKyc').checked ? "1" : "0", 
            isEmail: document.getElementById('tpEmail') && document.getElementById('tpEmail').checked ? "1" : "0", 
            isMobile: document.getElementById('tpMobile') && document.getElementById('tpMobile').checked ? "1" : "0", 
            hasUnPostAd: document.getElementById('tpUnpost') && document.getElementById('tpUnpost').checked ? "1" : "0", 
            hasRegisterTime: document.getElementById('tpReg') && document.getElementById('tpReg').checked ? "1" : "0", 
            registerTimeThreshold: document.getElementById('tpRegDay') ? document.getElementById('tpRegDay').value : "0", 
            hasOrderFinishNumberDay30: document.getElementById('tpOrder') && document.getElementById('tpOrder').checked ? "1" : "0", 
            orderFinishNumberDay30: document.getElementById('tpOrderNum') ? document.getElementById('tpOrderNum').value : "0", 
            hasCompleteRateDay30: document.getElementById('tpRate') && document.getElementById('tpRate').checked ? "1" : "0", 
            completeRateDay30: document.getElementById('tpRateNum') ? document.getElementById('tpRateNum').value : "0" 
        } 
    };
    
    fetch('/api/save_ad_config', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(p) 
    }).then(r => r.json()).then(d => { 
        if(d.status === 'success'){ 
            Toast.fire({ icon: 'success', title: 'Đã lưu' }); 
            bootstrap.Modal.getInstance(document.getElementById('configAdModal')).hide(); 
        } else {
            showErrorToast(d.message); 
        }
    });
}

function submitAdConfig() {
    const qtyVal = document.getElementById('cfgQty') ? document.getElementById('cfgQty').value : (document.getElementById('cfgQuantity') ? document.getElementById('cfgQuantity').value : '');
    const p = { 
        group: document.getElementById('groupSelect').value, 
        fiat: document.getElementById('cfgFiat').value, 
        minUsdt: document.getElementById('cfgMinUsdt').value, 
        maxUsdt: document.getElementById('cfgMaxUsdt').value, 
        quantity: qtyVal, 
        paymentPeriod: "30", 
        remark: document.getElementById('cfgRemark').value, 
        tradingPreferenceSet: { 
            isKyc: document.getElementById('tpKyc') && document.getElementById('tpKyc').checked ? "1" : "0", 
            isEmail: document.getElementById('tpEmail') && document.getElementById('tpEmail').checked ? "1" : "0", 
            isMobile: document.getElementById('tpMobile') && document.getElementById('tpMobile').checked ? "1" : "0", 
            hasUnPostAd: document.getElementById('tpUnpost') && document.getElementById('tpUnpost').checked ? "1" : "0", 
            hasRegisterTime: document.getElementById('tpReg') && document.getElementById('tpReg').checked ? "1" : "0", 
            registerTimeThreshold: document.getElementById('tpRegDay') ? document.getElementById('tpRegDay').value : "0", 
            hasOrderFinishNumberDay30: document.getElementById('tpOrder') && document.getElementById('tpOrder').checked ? "1" : "0", 
            orderFinishNumberDay30: document.getElementById('tpOrderNum') ? document.getElementById('tpOrderNum').value : "0", 
            hasCompleteRateDay30: document.getElementById('tpRate') && document.getElementById('tpRate').checked ? "1" : "0", 
            completeRateDay30: document.getElementById('tpRateNum') ? document.getElementById('tpRateNum').value : "0" 
        } 
    };
    
    fetch('/api/save_ad_config', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(p) 
    }).then(r => r.json()).then(d => { 
        if(d.status === 'success'){ 
            Toast.fire({ icon: 'success', title: 'Đã lưu' }); 
            bootstrap.Modal.getInstance(document.getElementById('configAdModal')).hide(); 
        } else {
            showErrorToast(d.message); 
        }
    });
}

function triggerCreateAd(fiat, ptttStr) { 
    const group = document.getElementById('groupSelect').value; 
    Toast.fire({ icon: 'info', title: `Đang tạo QC...` }); 
    addTerminalLog(`--- GỬI LỆNH TẠO QC MUA CHO THỊ TRƯỜNG ${fiat} ---`, "warn"); 
    fetch('/api/auto_create_ad', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group, fiat, pttt_str: ptttStr }) }).then(r => r.json()).then(d => { 
        if(d.logs) d.logs.forEach(l => { let t = 'info'; if(l.toLowerCase().includes('lỗi')||l.toLowerCase().includes('thất bại')) t = 'error'; else if(l.toLowerCase().includes('thành công')) t = 'success'; addTerminalLog(l, t); }); 
        if(d.status === 'success') { Toast.fire({ icon: 'success', title: d.message }); loadBuyAdsDashboard(true); } else showErrorToast(d.message); 
    }).catch(e => {
        showErrorToast("Lỗi mạng, vui lòng thử lại!");
        addTerminalLog(`Lỗi gọi API Tạo QC ${fiat}: ${e.message}`, "error");
    }); 
}
function triggerCancelAd(group, email, itemId) { Toast.fire({ icon: 'info', title: `Đang gửi lệnh Xóa...` }); addTerminalLog(`--- GỬI LỆNH XÓA QC (ID: ${itemId}) ---`, "warn"); fetch('/api/cancel_ad', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group, email, item_id: itemId }) }).then(r => r.json()).then(d => { if(d.logs) d.logs.forEach(l => { let t = 'info'; if(l.toLowerCase().includes('lỗi')||l.toLowerCase().includes('thất bại')) t = 'error'; else if(l.toLowerCase().includes('thành công')) t = 'success'; addTerminalLog(l, t); }); if(d.status === 'success') { Toast.fire({ icon: 'success', title: d.message }); loadBuyAdsDashboard(true); } else showErrorToast(d.message); }); }
function triggerCreateSellAd(orderId, accountEmail, fiat, ptttName, amount, price, isAuto = false) { 
    const group = document.getElementById('groupSelect').value; 
    if(!isAuto) Toast.fire({ icon: 'info', title: 'Đang tạo QC Bán...' }); 
    addTerminalLog(`--- GỬI LỆNH TẠO QC BÁN TỪ ĐƠN ${orderId} ---`, "warn"); 
    
    creatingSellAds.add(String(orderId)); // Khóa lại không cho tạo đúp

    fetch('/api/create_sell_ad_from_order', { 
        method: 'POST', headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ order_id: orderId, account_email: accountEmail, group, fiat, pttt_name: ptttName, fiat_amount: amount, price }) 
    }).then(r => r.json()).then(d => { 
        if(d.logs) d.logs.forEach(l => { 
            let t = 'info'; 
            if(l.toLowerCase().includes('lỗi')||l.toLowerCase().includes('thất bại')) t = 'error'; 
            else if(l.toLowerCase().includes('thành công')) t = 'success'; 
            addTerminalLog(l, t); 
        }); 
        if (d.status === 'success') { 
            if(!isAuto) Toast.fire({ icon: 'success', title: 'Đã tạo QC Bán!' }); 
            loadBuyAdsDashboard(true); 
        } else { 
            creatingSellAds.delete(String(orderId)); // Thất bại thì mở khóa để lần sau tạo lại
            if(!isAuto) showErrorToast('Lỗi: ' + d.message); 
        } 
    }).catch(e => {
        creatingSellAds.delete(String(orderId));
    }); 
}

// ====== AUTO XÓA QC BÁN KHI ĐƠN BỊ HỦY HOẶC HOÀN THÀNH ======
function processAutoCancelAdsForCancelledOrders() {
    const group = document.getElementById('groupSelect').value;
    if (!group) return;

    // Quét cả đơn đang pending và đơn đang lưu trữ
    const allOrders = [...Object.values(globalActiveOrders), ...Object.values(globalArchivingOrders)];
    
    allOrders.forEach(po => {
        let st = String(po.status);
        // Trạng thái 40: Người dùng hủy, 80: Hệ thống hủy, 50: Đã hoàn thành
        if (st === '40' || st === '80' || st === '50') {
            if (globalLinkedSellAds[po.id]) {
                let ad = globalLinkedSellAds[po.id];
                let adId = String(ad.itemId || ad.id);
                
                if (!cancellingSellAds.has(adId)) {
                    cancellingSellAds.add(adId);
                    
                    // Phân biệt lý do để báo log cho rõ ràng
                    let reason = (st === '50') ? 'ĐÃ HOÀN THÀNH' : 'ĐÃ HỦY';
                    addTerminalLog(`[AUTO-XÓA-QC] Đơn mua ${po.id} ${reason}. Tiến hành tự động xóa QC Bán đính kèm: ${adId}`, 'warn');
                    
                    let email = ad.account_email || ad.account || po.account_name;
                    
                    fetch('/api/cancel_ad', { 
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json' }, 
                        body: JSON.stringify({ group, email, item_id: adId }) 
                    }).then(r => r.json()).then(d => {
                        if(d.status === 'success') {
                            addTerminalLog(`[AUTO-XÓA-QC] ✅ Đã dọn dẹp thành công QC Bán ${adId}`, 'success');
                            loadBuyAdsDashboard(true); // Làm mới lại bảng
                        } else {
                            addTerminalLog(`[AUTO-XÓA-QC] ❌ Lỗi xóa QC ${adId}: ${d.message}`, 'error');
                            cancellingSellAds.delete(adId); // Mở khóa để lần sau quét lại
                        }
                    }).catch(e => {
                        addTerminalLog(`[AUTO-XÓA-QC] ❌ Lỗi mạng xóa QC ${adId}: ${e.message}`, 'error');
                        cancellingSellAds.delete(adId);
                    });
                }
            }
        }
    });
}
// ============================================

// ====== AUTO TẠO QC BÁN ======
function toggleAutoCreateSellAd(isChecked) {
    let config = JSON.parse(localStorage.getItem('autoCreateSellAdConfig') || '{"enabled":false}');
    config.enabled = isChecked;
    localStorage.setItem('autoCreateSellAdConfig', JSON.stringify(config));
    Toast.fire({ icon: isChecked ? 'success' : 'info', title: isChecked ? 'Đã BẬT Auto Tạo QC Bán' : 'Đã TẮT Auto Tạo QC Bán' });
    processAutoCreateSellAds(); 
}

// ====== AUTO TẠO QC BÁN ======
function processAutoCreateSellAds() {
    let config = JSON.parse(localStorage.getItem('autoCreateSellAdConfig') || '{"enabled":false}');
    if (!config.enabled) return;

    const allPendingOrders = [...Object.values(globalActiveOrders), ...Object.values(globalArchivingOrders)];
    
    latestConfigs.forEach(cfg => {
        let matchedPending = allPendingOrders.filter(po => String(po.side) === '0' && (po.currencyId || '').toUpperCase() === cfg.fiat.toUpperCase() && cfg.payments_active.includes(po.payment_method_name));
        
        matchedPending.forEach((po, index) => {
            let st = String(po.status);
            
            // CHỈ TẠO QC BÁN KHI ĐƠN ĐANG SỐNG (Bỏ qua 40: Người dùng Hủy, 80: Hệ thống Hủy, 50: Đã hoàn thành)
            if (st !== '40' && st !== '80' && st !== '50') {
                
                // Điều kiện: Đơn Mua + ĐÃ XÁC NHẬN + CHƯA có QC Bán + CHƯA nằm trong hàng chờ tạo
                // Điều kiện: Đơn Mua + ĐÃ XÁC NHẬN + CHƯA có QC Bán + CHƯA nằm trong hàng chờ tạo
                if (globalConfirmedOrders[po.id] && !globalLinkedSellAds[po.id] && !creatingSellAds.has(String(po.id))) {
                    creatingSellAds.add(String(po.id));
                    
                    // -- TÍNH TOÁN GIÁ UNIQUE TRƯỚC KHI TẠO --
                    let expectedPrice = parseFloat(po.expected_sell_price || cfg.ref_price);
                    let decimalPlaces = String(expectedPrice).includes('.') ? String(expectedPrice).split('.')[1].length : 2;
                    if (decimalPlaces < 2) decimalPlaces = 2; // Mặc định ít nhất 2 số thập phân
                    let uniquePrice = getUniquePrice(expectedPrice, po.account_name, '1', cfg.fiat, decimalPlaces);

                    setTimeout(() => {
                        addTerminalLog(`[AUTO-SELL-AD] Tự động tạo QC bán cho đơn ${po.id} với giá ${uniquePrice}`, 'info');
                        triggerCreateSellAd(po.id, po.account_name, cfg.fiat, po.payment_method_name, po.amount, uniquePrice, true);
                    }, index * 2000); // Trễ 2s mỗi đơn để sàn không báo lỗi spam
                }
                
            }
        });
    });
}

function syncOrderStateToBackend() { 
    const group = document.getElementById('groupSelect').value; if (!group) return; 
    const combined = [...Object.values(globalActiveOrders), ...Object.values(globalArchivingOrders), ...Object.values(globalActiveSellOrders), ...Object.values(globalArchivingSellOrders)].map(o => ({ id: o.id, owner_account: o.account_name, owner_group: group, status: o.status })); 
    fetch('/api/sync_front_state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group, orders: combined }) }); 
}

function fetchOrderInfo(email, orderId, isSell = false) { 
    const group = document.getElementById('groupSelect').value; 
    fetch('/api/get_order_info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group, email, order_id: orderId }) }).then(r => r.json()).then(d => { 
        if(d.status === 'success' && d.data) { 
            if(!isSell && globalArchivingOrders[orderId]) globalArchivingOrders[orderId].status = d.data.status; 
            if(isSell && globalArchivingSellOrders[orderId]) globalArchivingSellOrders[orderId].status = d.data.status; 
            renderDashboardUI(); 
            // Chạy kiểm tra xem đơn vừa được cập nhật có bị Hủy không
            processAutoCancelAdsForCancelledOrders();
        } 
    }); 
}

function loadBuyAdsDashboard(isSilent = false) {
    const group = document.getElementById('groupSelect').value; if (!group) return; if (autoRefreshTimer) clearInterval(autoRefreshTimer); document.getElementById('updateTimeText').innerHTML = `Đang tải...`;
    if (!isSilent && document.getElementById('dashboardAdsContent').innerHTML.includes('Bấm "Làm mới Bảng"')) { document.getElementById('dashboardAdsContent').style.display = 'none'; document.getElementById('adsLoadingArea').style.display = 'block'; }
    fetch(`/api/get_buy_ads_dashboard?group=${group}`).then(res => res.json()).then(data => {
        document.getElementById('adsLoadingArea').style.display = 'none'; document.getElementById('updateTimeText').innerHTML = `${new Date().toLocaleTimeString('vi-VN')} (Tự động 30s)`; autoRefreshTimer = setInterval(() => loadBuyAdsDashboard(true), 30000);
        if(data.status === 'success') {
            window.recentlyAssignedPrices = new Set(); // Thêm dòng này để xóa cache né giá cũ
            latestConfigs = data.configs || []; latestBuyAds = data.buy_ads || []; globalAllAds = data.all_ads || []; globalAllPendingOrders = data.all_pending_orders || [];
            
            // --- GỌI HÀM CHECK VÀ BÁO TELEGRAM TẠI ĐÂY ---
            if(globalAllPendingOrders.length > 0) {
                checkAndNotifyNewOrders(globalAllPendingOrders);
            }
            // ----------------------------------------------

            // === TỰ ĐỘNG BẬT "AUTO GIÁ" CHO CÁC QUẢNG CÁO MỚI TẠO ===
            let knownAdsSet = new Set(JSON.parse(localStorage.getItem('knownAdIds') || '[]'));
            let autoUpdateSet = new Set(JSON.parse(localStorage.getItem('autoUpdateAdIds') || '[]'));
            let hasNewAd = false;
            let isFirstTimeKnownAds = knownAdsSet.size === 0; // Tránh bật auto cho các QC cũ ở lần chạy code đầu tiên
            
            globalAllAds.forEach(ad => {
                let adId = String(ad.id);
                if (!knownAdsSet.has(adId)) {
                    knownAdsSet.add(adId);
                    if (!isFirstTimeKnownAds) {
                        autoUpdateSet.add(adId); // Tự động bật Auto Giá
                    }
                    hasNewAd = true;
                }
            });
            
            if (hasNewAd) {
                // Chỉ giữ lại 1000 ID gần nhất để trình duyệt không bị nặng
                let arr = [...knownAdsSet];
                if (arr.length > 1000) arr = arr.slice(arr.length - 1000);
                localStorage.setItem('knownAdIds', JSON.stringify(arr));
                
                if (!isFirstTimeKnownAds) {
                    localStorage.setItem('autoUpdateAdIds', JSON.stringify([...autoUpdateSet]));
                    // Optional: Hiển thị thông báo nhỏ nếu muốn
                    // Toast.fire({ icon: 'success', title: 'Đã tự động bật Auto Giá cho QC mới!' });
                }
            }
            // =======================================================

            // Lấy danh sách ID đơn đã ép lưu trữ từ LocalStorage
            let forceArchivedSet = new Set(JSON.parse(localStorage.getItem('forceArchivedOrders') || '[]'));

            // ---> LOGIC KHÔI PHỤC LỊCH SỬ ĐƠN TỪ BACKEND <---
            if (data.saved_orders_history) {
                const now = Date.now();
                data.saved_orders_history.forEach(dbOrd => {
                    const st = String(dbOrd.db_status);
                    // Các trạng thái Hủy/Hoàn thành (Bybit: 3, 4, 5, 40, 80, 50, Completed, Cancelled)
                    if (!['1', '2', '10', '20', 'New', 'Pending', 'InProgress'].includes(st)) {
                        const updatedTimeMs = (dbOrd.updated_at || (now / 1000)) * 1000;
                        const remainMs = 3600000 - (now - updatedTimeMs);
                        
                        dbOrd.status = st;

                        // Nếu thời gian đếm ngược > 0 VÀ đơn này CHƯA BỊ ÉP LƯU TRỮ bởi User
                        if (remainMs > 0 && !forceArchivedSet.has(String(dbOrd.id))) {
                            if (String(dbOrd.side) === '0') {
                                if (!globalArchivingOrders[dbOrd.id] && !globalArchivedOrders[dbOrd.id]) {
                                    dbOrd.archiveStartTime = updatedTimeMs;
                                    globalArchivingOrders[dbOrd.id] = dbOrd;
                                }
                            } else {
                                if (!globalArchivingSellOrders[dbOrd.id] && !globalArchivedSellOrders[dbOrd.id]) {
                                    dbOrd.archiveStartTime = updatedTimeMs;
                                    globalArchivingSellOrders[dbOrd.id] = dbOrd;
                                }
                            }
                        } else {
                            // Đã hết 60p HOẶC đã bị User bấm nút "Lưu ngay"
                            if (String(dbOrd.side) === '0') {
                                globalArchivedOrders[dbOrd.id] = dbOrd;
                            } else {
                                globalArchivedSellOrders[dbOrd.id] = dbOrd;
                            }
                        }
                    }
                });
            }
            // --------------------------------------------------------

            const currentBuyIds = new Set((data.pending_orders || []).map(o => String(o.id)));
            (data.pending_orders || []).forEach(po => { globalActiveOrders[po.id] = po; if (globalArchivingOrders[po.id]) delete globalArchivingOrders[po.id]; });
            Object.keys(globalActiveOrders).forEach(id => { 
                if (!currentBuyIds.has(id)) { 
                    let po = globalActiveOrders[id]; 
                    delete globalActiveOrders[id]; 
                    if (!globalArchivingOrders[id] && !globalArchivedOrders[id]) { 
                        // Nếu user đã ấn Lưu Ngay từ trước thì cho vào kho Lưu Trữ luôn
                        if (forceArchivedSet.has(String(id))) {
                            globalArchivedOrders[id] = po;
                        } else {
                            globalArchivingOrders[id] = { ...po, archiveStartTime: Date.now() }; 
                            fetchOrderInfo(po.account_name, id, false); 
                        }
                    } 
                } 
            });
            
            if(data.linked_sell_orders) { globalLinkedSellOrders = data.linked_sell_orders; Object.keys(globalLinkedSellOrders).forEach(buyId => { globalLinkedSellOrders[buyId].forEach(spo => { spo.linked_buy_order_id = buyId; }); }); } else { globalLinkedSellOrders = {}; }
            let currentSellObjects = {}; (data.all_pending_orders || []).forEach(o => { if (String(o.side) === '1') currentSellObjects[o.id] = o; });
            Object.keys(globalLinkedSellOrders).forEach(buyId => { globalLinkedSellOrders[buyId].forEach(spo => { if (currentSellObjects[spo.id]) currentSellObjects[spo.id].linked_buy_order_id = buyId; }); });

            const currentSellIds = new Set(Object.keys(currentSellObjects));
            Object.keys(globalActiveSellOrders).forEach(id => { 
                if (!currentSellIds.has(id)) { 
                    let spo = globalActiveSellOrders[id]; 
                    delete globalActiveSellOrders[id]; 
                    if (!globalArchivingSellOrders[id] && !globalArchivedSellOrders[id]) { 
                        // Nếu user đã ấn Lưu Ngay từ trước thì cho vào kho Lưu Trữ luôn
                        if (forceArchivedSet.has(String(id))) {
                            globalArchivedSellOrders[id] = spo;
                        } else {
                            globalArchivingSellOrders[id] = { ...spo, archiveStartTime: Date.now() }; 
                            fetchOrderInfo(spo.account_name, id, true); 
                        }
                    } 
                } 
            });
            Object.keys(currentSellObjects).forEach(id => { globalActiveSellOrders[id] = currentSellObjects[id]; if (globalArchivingSellOrders[id]) delete globalArchivingSellOrders[id]; });

            renderDashboardUI();
            processAutoCreateSellAds();
            processAutoCancelAdsForCancelledOrders();
            processAutoStopAds(); // Đã thêm ở đây
        }
    });
}

function confirmOrder(orderId) { fetch('/api/confirm_order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: orderId, action: 'confirmed', note: 'UI' }) }).then(r => r.json()).then(d => { if (d.status === 'success') { Toast.fire({ icon: 'success', title: 'Xác nhận!' }); globalConfirmedOrders[orderId] = true; renderDashboardUI(); } else showErrorToast(d.message); }); }
function unconfirmOrder(orderId) { if (confirm("Gỡ xác nhận?")) { fetch('/api/confirm_order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: orderId, action: 'unconfirmed', note: 'UI' }) }).then(r => r.json()).then(d => { if (d.status === 'success') { Toast.fire({ icon: 'success', title: 'Đã gỡ!' }); delete globalConfirmedOrders[orderId]; renderDashboardUI(); } else showErrorToast(d.message); }); } }

function generateSellOrderHtml(spo, isArchiving, isArchiveView = false) {
    const fPrice = parseFloat(spo.price || 0).toLocaleString('en-US'); 
    const fAmount = parseFloat(spo.amount || 0).toLocaleString('en-US'); 
    const usdtVal = parseFloat(spo.quantity || spo.current_usdt || 0);
    const usdt = usdtVal.toFixed(2); 
    
    // --- 1. SỬA ĐỊNH DẠNG TRẠNG THÁI (Giống hệt đơn mua) ---
    let st = String(spo.status); 
    let sbText = "Không rõ", sbColor = "bg-secondary";
    if(st === '5') { sbText = "Chờ Web3"; sbColor = "bg-info text-dark"; }
    else if(st === '10') { sbText = "Chờ Mua Pay"; sbColor = "bg-warning text-dark"; }
    else if(st === '20') { sbText = "Chờ Bán Nhả"; sbColor = "bg-primary"; }
    else if(st === '30') { sbText = "Khiếu nại"; sbColor = "bg-danger"; }
    else if(st === '40' || st === '80') { sbText = "Đã Hủy"; sbColor = "bg-dark"; }
    else if(st === '50') { sbText = "Đã hoàn thành"; sbColor = "bg-success"; }
    let sb = `<span class="badge ${sbColor} shadow-sm">Trạng thái: ${st} - ${sbText}</span>`;
    
    // --- 2. SỬA GIAO DIỆN T.GIAN CHUYỂN LƯU TRỮ ---
    let archiveHtml = '';
    if (isArchiving) {
        archiveHtml = `
            <div class="text-danger mt-2 fw-bold d-flex flex-column gap-1" style="font-size: 0.85rem;">
                <div class="d-flex align-items-center gap-1">
                    <i class="bi bi-clock-history"></i> T.gian chuyển lưu trữ: <span class="archive-countdown ms-1" data-start="${spo.archiveStartTime || Date.now()}">--:--</span>
                </div>
                <button class="btn btn-sm btn-danger py-0 px-2 fw-bold shadow-sm" style="font-size: 0.75rem; width: fit-content;" onclick="forceArchiveOrder('${spo.id}', true)">Lưu trữ ngay</button>
            </div>
        `;
    }
    
    // --- 3. SỬA GIAO DIỆN T.GIAN THANH TOÁN ---
    let paymentCountdownHtml = '<span class="text-danger fw-bold ms-1">N/A</span>';
    if(spo.transferLastSeconds !== undefined && spo.transferLastSeconds !== null) {
        const expireTime = Date.now() + (parseInt(spo.transferLastSeconds) * 1000);
        const m = Math.floor(spo.transferLastSeconds / 60).toString().padStart(2, '0');
        const s = (spo.transferLastSeconds % 60).toString().padStart(2, '0');
        paymentCountdownHtml = `<span class="text-danger fw-bold ms-1 payment-countdown" data-expire="${expireTime}">${m}:${s}</span>`;
    }
    
    let confirmedBadge = ''; 
    if (globalConfirmedOrders[spo.id]) { confirmedBadge = '<div class="mt-2 d-flex align-items-center gap-1"><div class="badge bg-success text-white border border-success flex-grow-1 py-2 shadow-sm" style="font-size: 0.85rem;"><i class="bi bi-check-circle-fill"></i> ĐÃ XN</div><button class="btn btn-sm btn-outline-danger shadow-sm" style="font-size: 0.85rem;" onclick="unconfirmOrder(\'' + spo.id + '\')"><i class="bi bi-x-lg"></i></button></div>'; } 
    else { confirmedBadge = '<div class="mt-2"><button class="btn btn-sm btn-primary w-100 py-1 shadow-sm fw-bold" style="font-size: 0.85rem;" onclick="confirmOrder(\'' + spo.id + '\')"><i class="bi bi-check2-square"></i> XÁC NHẬN</button></div>'; }

    let createTimeStr = spo.createDate ? new Date(parseInt(spo.createDate)).toLocaleString('vi-VN') : 'Không rõ';

    // --- 4. TÍNH TOÁN LÃI USDT (Chênh lệch so với đơn Mua gốc) ---
    let diffUHtml = '';
    if (spo.linked_buy_order_id) {
        let parentBuyOrder = globalActiveOrders[spo.linked_buy_order_id] || globalArchivingOrders[spo.linked_buy_order_id] || globalArchivedOrders[spo.linked_buy_order_id];
        if (parentBuyOrder) {
            let buyQty = parseFloat(parentBuyOrder.current_usdt || parentBuyOrder.quantity || 0);
            let diff = (buyQty - usdtVal).toFixed(2);
            let diffSign = diff >= 0 ? '+' : '';
            let diffColor = diff >= 0 ? 'text-success' : 'text-danger';
            diffUHtml = `<div class="mt-2 pt-1 border-top border-danger border-opacity-25" style="font-size: 0.8rem;">Lãi: <b class="${diffColor}">${diffSign}${diff} USDT</b></div>`;
        }
    }

    // --- RÁP VÀO BODY HTML ---
    let bodyHtml = '<div class="row align-items-center g-3 p-3 bg-danger bg-opacity-10 m-0" style="font-size: 0.85rem;">' +
        '<div class="col-12 d-flex justify-content-between align-items-center mb-1 border-bottom border-danger border-opacity-25 pb-2">' +
            '<div class="text-danger fw-bold"><i class="bi bi-link-45deg me-1"></i> ĐƠN BÁN KHỚP LỆNH: <span class="copy-id text-danger user-select-all" onclick="copyAdId(\'' + spo.id + '\')">' + spo.id + '</span> <span class="badge bg-danger ms-2">BÁN</span></div>' +
            '<div class="text-end fw-bold text-danger"><i class="bi bi-robot"></i> ' + (spo.account_name || spo.nickName || 'N/A') + '<br><span class="text-secondary fw-normal" style="font-size: 0.75rem;"><i class="bi bi-calendar-plus"></i> Thời gian tạo: ' + createTimeStr + '</span></div>' +
        '</div>' +
        '<div class="col-sm-3 border-end border-danger border-opacity-25 px-2">' +
            '<div class="text-danger fw-bold"><i class="bi bi-credit-card"></i> ' + (spo.payment_method_name||'N/A') + '</div>' +
            '<div class="mt-2">' + sb + '</div>' +
            '<div class="text-muted mt-2 fw-semibold d-flex align-items-center gap-1"><i class="bi bi-clock"></i> T.gian thanh toán: ' + paymentCountdownHtml + '</div>' + 
            archiveHtml + 
        '</div>' +
        '<div class="col-sm-3 text-sm-center border-end border-danger border-opacity-25 px-2">' +
            '<div class="text-danger fw-bold">Giá: ' + fPrice + ' <span class="text-secondary fw-normal">' + (spo.currencyId||'?') + '/' + (spo.tokenId||'?') + '</span></div>' +
            '<div class="text-muted mt-1">(Giá Khớp)</div>' +
        '</div>' +
        '<div class="col-sm-3 text-sm-center border-end border-danger border-opacity-25 px-2">' +
            '<div class="fw-semibold text-dark mb-1">Tổng Nhận</div>' +
            '<div class="bg-white border border-danger rounded shadow-sm text-dark mx-auto text-start px-3 py-2" style="width: fit-content;">' +
                'Số tiền: <b class="text-danger">' + fAmount + ' ' + (spo.currencyId||'?') + '</b><br>' +
                'Số lượng: <b class="text-success">' + usdt + ' ' + (spo.tokenId||'USDT') + '</b>' +
                diffUHtml +
            '</div>' +
        '</div>' +
        '<div class="col-sm-3 px-2 text-center">' + confirmedBadge + '</div>' +
    '</div>';
    
    return '<div class="border-top border-danger border-opacity-50">' + bodyHtml + '</div>';
}


function generateOrderRowHtml(po, cfg, isArchiving, isArchiveView = false) {
    const fPrice = parseFloat(po.price || 0).toLocaleString('en-US'); const fAmount = parseFloat(po.amount || 0).toLocaleString('en-US'); const usdt = parseFloat(po.current_usdt || po.quantity || 0).toLocaleString('en-US');
    
    let paymentCountdownHtml = '<span class="text-danger fw-bold ms-1">N/A</span>';
    if(po.transferLastSeconds !== undefined && po.transferLastSeconds !== null) {
        const expireTime = Date.now() + (parseInt(po.transferLastSeconds) * 1000);
        const m = Math.floor(po.transferLastSeconds / 60).toString().padStart(2, '0');
        const s = (po.transferLastSeconds % 60).toString().padStart(2, '0');
        paymentCountdownHtml = `<span class="text-danger fw-bold ms-1 payment-countdown" data-expire="${expireTime}">${m}:${s}</span>`;
    }

    let st = String(po.status); 
    let sbText = "Không rõ", sbColor = "bg-secondary";
    if(st === '5') { sbText = "Chờ Web3"; sbColor = "bg-info text-dark"; }
    else if(st === '10') { sbText = "Chờ thanh toán"; sbColor = "bg-warning text-dark"; }
    else if(st === '20') { sbText = "Chờ mở khóa"; sbColor = "bg-primary"; }
    else if(st === '30') { sbText = "Đang khiếu nại"; sbColor = "bg-danger"; }
    else if(st === '40') { sbText = "Đã hủy (User)"; sbColor = "bg-dark"; }
    else if(st === '50') { sbText = "Đã hoàn thành"; sbColor = "bg-success"; }
    else if(st === '60') { sbText = "Đang thanh toán"; sbColor = "bg-info text-dark"; }
    else if(st === '70') { sbText = "Lỗi thanh toán"; sbColor = "bg-danger"; }
    else if(st === '80') { sbText = "Đã hủy (Ngoại lệ)"; sbColor = "bg-dark"; }
    else if(st === '90') { sbText = "Chờ người mua chọn Coin"; sbColor = "bg-secondary"; }
    else if(st === '100') { sbText = "Đang phản đối"; sbColor = "bg-danger"; }
    else if(st === '110') { sbText = "Chờ người dùng phản đối"; sbColor = "bg-warning text-dark"; }
    let sb = `<span class="badge ${sbColor} shadow-sm">Trạng thái: ${st} - ${sbText}</span>`;

    let archiveHtml = '';
    if (isArchiving) {
        // Kiểm tra xem đây là đơn bán hay đơn mua để lấy đúng thời gian đếm ngược và truyền tham số
        let isSellOrder = String(po.side) === '1';
        let startTime = isSellOrder 
            ? (globalArchivingSellOrders[po.id]?.archiveStartTime || Date.now()) 
            : (globalArchivingOrders[po.id]?.archiveStartTime || Date.now());

        archiveHtml = `
            <div class="text-danger mt-2 fw-bold d-flex flex-column gap-1" style="font-size: 0.85rem;">
                <div class="d-flex align-items-center gap-1">
                    <i class="bi bi-clock-history"></i> T.gian chuyển lưu trữ: <span class="archive-countdown ms-1" data-start="${startTime}">--:--</span>
                </div>
                <!-- Truyền linh hoạt biến isSellOrder (true/false) vào hàm -->
                <button class="btn btn-sm btn-danger py-0 px-2 fw-bold shadow-sm" style="font-size: 0.75rem; width: fit-content;" onclick="forceArchiveOrder('${po.id}', ${isSellOrder})">Lưu trữ ngay</button>
            </div>
        `;
    }

    let confirmedBadge = ''; let linkedAdHtml = ''; let sellOrdersHtml = '';
    
    if (String(po.side) === '1') { 
        if (globalConfirmedOrders[po.id]) { confirmedBadge = '<div class="mt-2 d-flex align-items-center gap-1"><div class="badge bg-success text-white border border-success flex-grow-1 py-2 shadow-sm" style="font-size: 0.85rem;"><i class="bi bi-check-circle-fill"></i> ĐÃ XN</div><button class="btn btn-sm btn-outline-danger shadow-sm" style="font-size: 0.85rem;" onclick="unconfirmOrder(\'' + po.id + '\')"><i class="bi bi-x-lg"></i></button></div>'; } 
        else { confirmedBadge = '<div class="mt-2"><button class="btn btn-sm btn-primary w-100 py-1 shadow-sm fw-bold" style="font-size: 0.85rem;" onclick="confirmOrder(\'' + po.id + '\')"><i class="bi bi-check2-square"></i> XÁC NHẬN</button></div>'; }
    } else {
        let allSpoForThisBuy = [];
        if (globalLinkedSellOrders[po.id]) allSpoForThisBuy.push(...globalLinkedSellOrders[po.id]);
        Object.values(globalArchivingSellOrders).forEach(spo => { if (spo.linked_buy_order_id === po.id) allSpoForThisBuy.push(spo); });
        
        let uniqueSpoMap = {};
        allSpoForThisBuy.forEach(spo => { uniqueSpoMap[spo.id] = spo; });
        Object.values(uniqueSpoMap).forEach(spo => { sellOrdersHtml += generateSellOrderHtml(spo, !!globalArchivingSellOrders[spo.id], false); });

        if (globalConfirmedOrders[po.id]) {
            let sellAdBtn = '';
            if (globalLinkedSellAds[po.id]) {
                let sAd = globalLinkedSellAds[po.id]; let group = document.getElementById('groupSelect').value; let adId = sAd.itemId || sAd.id || 'N/A'; let account = sAd.account || sAd.account_email || po.account_name; let pttt = sAd.paymentTerms && sAd.paymentTerms.length > 0 ? sAd.paymentTerms.map(p => p.paymentConfig ? p.paymentConfig.paymentName : p.paymentType).join(', ') : (sAd.mapped_payments_str || po.payment_method_name || 'N/A'); let statusText = sAd.status ? String(sAd.status) : '10'; let statusHtml = statusText === '10' ? '<span class="badge bg-success bg-opacity-10 text-success border border-success px-3 py-1 shadow-sm" style="cursor: pointer; font-size: 0.85rem;" onclick="showAdDetails(\'' + group + '\', \'' + account + '\', \'' + adId + '\')">ONLINE</span>' : '<span class="badge bg-secondary px-3 py-1 shadow-sm" style="font-size: 0.85rem;" onclick="showAdDetails(\'' + group + '\', \'' + account + '\', \'' + adId + '\')">TT: ' + statusText + '</span>';
                
                let adQty = parseFloat(sAd.quantity || sAd.lastQuantity || 0);
                let buyQty = parseFloat(po.current_usdt || po.quantity || 0);
                let diffU = (buyQty - adQty).toFixed(2);
                let diffHtml = diffU >= 0 ? `<span class="text-success fw-bold">+${diffU}</span>` : `<span class="text-danger fw-bold">${diffU}</span>`;

                let switchAutoUpdate = `<div class="form-check form-switch m-0 d-flex align-items-center gap-1"><input class="form-check-input m-0 border-warning" type="checkbox" id="autoUpdate_${adId}" ${isAutoUpdateAd(adId)?'checked':''} onchange="toggleAutoUpdateAd('${adId}', this.checked)"><label class="form-check-label text-dark fw-bold mb-0" style="font-size: 0.8rem; cursor:pointer;" for="autoUpdate_${adId}">Auto Giá</label></div>`;
                
                let rankHtml = '';
                let currentAdPrice = parseFloat(sAd.price || 0);
                let expectedPrice = parseFloat(po.expected_sell_price || cfg.ref_price || 0);
                
                // Lấy thông tin Mốc cắt lãi từ biến lưu vĩnh viễn toàn cục
                window.adCutLevels = window.adCutLevels || {};
                let savedCutLevel = window.adCutLevels[adId] || 0;
                let cutProfitBadge = '';
                if (savedCutLevel > 0) {
                    cutProfitBadge = `<span class="badge bg-warning text-dark ms-2 border border-warning shadow-sm" style="font-size: 0.7rem;"><i class="bi bi-scissors"></i> [Cắt lãi xả hàng] - Mốc ${savedCutLevel}</span>`;
                }
                
                if (currentAdPrice > 0 && expectedPrice > 0 && Math.abs(currentAdPrice - expectedPrice) < 0.000001) {
                    let rRank = po.raw_rank !== undefined ? po.raw_rank : '--';
                    let fRank = po.filtered_rank !== undefined ? po.filtered_rank : '--';
                    rankHtml = `<div class="text-primary fw-bold mt-1" style="font-size: 0.75rem;"><i class="bi bi-bar-chart-fill"></i> (Top raw: ${rRank} | Filtered: ${fRank})</div>`;
                }
            
                linkedAdHtml = `
                <div class="bg-warning bg-opacity-10 border-top border-bottom mt-0 pt-3 pb-3 px-3" style="font-size: 0.85rem;">
                    <div class="d-flex justify-content-between align-items-center mb-3 border-bottom border-warning pb-2">
                        <div class="fw-bold text-danger d-flex align-items-center gap-1">
                            <i class="bi bi-arrow-return-right"></i> QC BÁN ĐANG CHẠY: 
                            <span class="user-select-all bg-white px-2 py-1 ms-1 rounded border border-danger shadow-sm fw-bold text-dark" style="cursor: pointer;" onclick="copyAdId('${adId}')" title="Click để Copy">${adId}</span>
                        </div>
                        <div class="d-flex gap-2 align-items-center">
                            ${switchAutoUpdate}
                            <button class="btn btn-sm btn-outline-success fw-bold shadow-sm py-0 px-2" style="font-size: 0.75rem;" onclick="showAdDetails('${group}', '${account}', '${adId}')">ONLINE</button>
                            <button class="btn btn-sm btn-outline-danger fw-bold shadow-sm py-0 px-2" style="font-size: 0.75rem;" onclick="triggerCancelAd('${group}', '${account}', '${adId}')"><i class="bi bi-trash"></i></button>
                        </div>
                    </div>
                    <div class="row text-center g-2 align-items-center">
                        <div class="col-sm-3 border-end border-warning text-start">
                            <div class="fw-bold text-primary mb-1"><i class="bi bi-robot"></i> ${account}</div>
                            <div class="text-muted"><i class="bi bi-credit-card"></i> ${po.payment_method_name}</div>
                        </div>
                        <div class="col-sm-4 border-end border-warning">
                            <div class="text-muted mb-1">Giá & Giới hạn</div>
                            <div class="fw-bold text-dark">Giá Bán: <span class="text-danger">${parseFloat(sAd.price || 0).toLocaleString('en-US')}</span> <span class="text-secondary fw-normal">${po.currencyId || cfg.fiat || '?'}/${po.tokenId || cfg.coin || 'USDT'}</span>${rankHtml}</div>
                            <div class="text-muted" style="font-size: 0.8rem;">Giới hạn: ${parseFloat(sAd.minAmount || 0).toLocaleString('en-US')} - ${parseFloat(sAd.maxAmount || 0).toLocaleString('en-US')} ${po.currencyId || cfg.fiat || '?'}</div>
                        </div>
                        <div class="col-sm-5">
                            <div class="text-muted mb-1">Số dư USDT</div>
                            <div class="fw-bold text-dark" style="font-size: 0.8rem;">Khả dụng: <span class="text-success">${parseFloat(sAd.lastQuantity || sAd.quantity || 0).toLocaleString('en-US')}</span> <span class="text-muted fw-normal">USDT</span> | Khóa: <span class="text-dark">${parseFloat(sAd.frozenQuantity || 0).toLocaleString('en-US')}</span> <span class="text-muted fw-normal">USDT</span></div>
                            <div class="mt-1" style="font-size: 0.8rem;">Chênh lệch: ${diffHtml} <span class="text-muted fw-normal">USDT</span>${cutProfitBadge}</div>
                        </div>
                    </div>
                </div>`;
            } else { sellAdBtn = '<button class="btn btn-sm btn-warning w-100 mt-2 py-1 shadow-sm fw-bold text-dark" style="font-size: 0.85rem;" onclick="triggerCreateSellAd(\'' + po.id + '\', \'' + po.account_name + '\', \'' + cfg.fiat + '\', \'' + po.payment_method_name + '\', ' + po.amount + ', ' + (po.expected_sell_price || cfg.ref_price) + ')"><i class="bi bi-megaphone-fill"></i> TẠO QC BÁN</button>'; }
            confirmedBadge = '<div class="mt-2 d-flex align-items-center gap-1"><div class="badge bg-success text-white border border-success flex-grow-1 py-2 shadow-sm" style="font-size: 0.85rem;"><i class="bi bi-check-circle-fill"></i> ĐÃ XN</div><button class="btn btn-sm btn-outline-danger shadow-sm" style="font-size: 0.85rem;" onclick="unconfirmOrder(\'' + po.id + '\')"><i class="bi bi-x-lg"></i></button></div>' + sellAdBtn;
        } else { confirmedBadge = '<div class="mt-2"><button class="btn btn-sm btn-primary w-100 py-1 shadow-sm fw-bold" style="font-size: 0.85rem;" onclick="confirmOrder(\'' + po.id + '\')"><i class="bi bi-check2-square"></i> XÁC NHẬN</button></div>'; }
    }

    let createTimeStr = po.createDate ? new Date(parseInt(po.createDate)).toLocaleString('vi-VN') : 'Không rõ';

    let headerHtml = ''; let bodyHtml = '';
    if (String(po.side) === '0') {
        headerHtml = '<div class="bg-warning bg-opacity-25 text-dark px-3 py-2 fw-bold border-bottom border-warning d-flex justify-content-between align-items-center" style="font-size: 0.85rem;"><div><i class="bi bi-hourglass-split"></i> ĐƠN PENDING MUA: <span class="user-select-all text-primary ms-1 fs-6">' + po.id + '</span> <span class="badge bg-success ms-2">MUA</span></div><div class="text-end"><i class="bi bi-robot"></i> ' + po.account_name + '<br><span class="text-secondary fw-normal" style="font-size: 0.75rem;"><i class="bi bi-calendar-plus"></i> Thời gian tạo: ' + createTimeStr + '</span></div></div>';
        
        bodyHtml = '<div class="row align-items-center g-3 p-3 m-0" style="font-size: 0.85rem;">' +
            '<div class="col-sm-3 border-end border-light px-2">' +
                '<div class="text-danger fw-bold"><i class="bi bi-credit-card"></i> ' + po.payment_method_name + '</div>' +
                '<div class="mt-2">' + sb + '</div>' +
                '<div class="text-muted mt-2 fw-semibold d-flex align-items-center gap-1"><i class="bi bi-clock"></i> T.gian thanh toán: ' + paymentCountdownHtml + '</div>' +
                archiveHtml +
            '</div>' +
            '<div class="col-sm-4 text-center border-end border-light px-2">' +
                '<div class="text-success fw-bold mb-2">Giá: ' + fPrice + ' <span class="text-secondary fw-normal">' + (cfg.fiat||'?') + '/' + (cfg.coin||'USDT') + '</span></div>' +
                '<div class="text-danger fw-bold">Giá bán dự kiến: ' + parseFloat(po.expected_sell_price || cfg.ref_price || 0).toLocaleString('en-US') + ' <span class="text-secondary fw-normal">' + (cfg.fiat||'?') + '/' + (cfg.coin||'USDT') + '</span></div>' +
            '</div>' +
            '<div class="col-sm-3 text-center border-end border-light px-2">' +
                '<div class="text-muted mb-1 fw-bold">Số Tiền Giao Dịch</div>' +
                '<div class="border rounded p-2 bg-light shadow-sm">' +
                    '<div class="text-danger fw-bold">Số tiền: ' + fAmount + ' ' + (cfg.fiat||'?') + '</div>' +
                    '<div class="text-success fw-bold mt-1">Số lượng: ' + usdt + ' ' + (cfg.coin||'USDT') + '</div>' +
                '</div>' +
            '</div>' +
            '<div class="col-sm-2 px-2">' + confirmedBadge + '</div>' +
        '</div>'; 
    } else {
        headerHtml = '<div class="bg-danger bg-opacity-25 text-dark px-3 py-2 fw-bold border-bottom border-danger d-flex justify-content-between align-items-center" style="font-size: 0.85rem;"><div><i class="bi bi-link-45deg me-1"></i> ĐƠN PENDING BÁN: <span class="copy-id text-danger user-select-all" onclick="copyAdId(\'' + po.id + '\')">' + po.id + '</span> <span class="badge bg-danger ms-2">BÁN</span></div><div class="text-end"><i class="bi bi-robot text-danger"></i> ' + po.account_name + '<br><span class="text-secondary fw-normal" style="font-size: 0.75rem;"><i class="bi bi-calendar-plus"></i> Thời gian tạo: ' + createTimeStr + '</span></div></div>';
        bodyHtml = '<div class="row align-items-center g-3 p-3 m-0" style="font-size: 0.85rem;"><div class="col-sm-3 border-end border-light px-2"><div class="text-danger fw-bold"><i class="bi bi-credit-card"></i> ' + (po.payment_method_name||'N/A') + '</div><div class="mt-2">' + sb + '</div><div class="text-danger mt-2 fw-semibold"><i class="bi bi-clock"></i> Còn: ' + paymentCountdownHtml + '</div>' + archiveHtml + '</div><div class="col-sm-3 text-sm-center border-end border-light px-2"><div class="text-danger fw-bold">Giá: ' + fPrice + ' <span class="text-secondary fw-normal">' + (po.currencyId||cfg.fiat) + '/' + (po.tokenId||cfg.coin) + '</span></div></div><div class="col-sm-3 text-sm-center border-end border-light px-2"><div class="fw-semibold text-dark mb-1">Số Tiền Giao Dịch</div><div class="bg-white border border-danger rounded shadow-sm text-dark mx-auto text-start px-3 py-2" style="width: fit-content;">Số tiền: <b class="text-danger">' + fAmount + ' ' + (po.currencyId||cfg.fiat) + '</b><br>Số lượng: <b class="text-success">' + usdt + ' ' + (po.tokenId||cfg.coin) + '</b></div></div><div class="col-sm-3 px-2 text-center">' + confirmedBadge + '</div></div>';
    }

    return '<div class="list-group-item ' + (isArchiving ? "archiving-list-item" : "pending-list-item") + ' p-0 mb-3 border rounded shadow-sm overflow-hidden" style="border-width: 2px !important; ' + (String(po.side)==='0'?'border-color: #ffc107 !important;':'border-color: #dc3545 !important;') + '">' + headerHtml + bodyHtml + linkedAdHtml + sellOrdersHtml + '</div>';
}

function generateAdRowHtml(ad, group, cfg = {}) {
    const pPrice = Number(ad.price || 0);
    const pMin = Number(ad.minAmount || 0);
    const pMax = Number(ad.maxAmount || 0);
    const minUsdt = pPrice > 0 ? (pMin / pPrice).toLocaleString('en-US', {maximumFractionDigits: 2}) : 0;
    const maxUsdt = pPrice > 0 ? (pMax / pPrice).toLocaleString('en-US', {maximumFractionDigits: 2}) : 0;
    const pAvail = Number(ad.lastQuantity || 0);
    const pFrozen = Number(ad.frozenQuantity || 0);
    const fiat = ad.currencyId || cfg.fiat || '?';
    const coin = ad.tokenId || cfg.coin || '?';
    const isBuy = String(ad.side) === '0';
    
    const sideBadge = isBuy ? '<span class="badge bg-success shadow-sm">MUA</span>' : '<span class="badge bg-danger shadow-sm">BÁN</span>';
    const priceText = isBuy ? 'Giá Mua' : 'Giá Bán';
    const priceColor = isBuy ? 'text-success' : 'text-danger';
    const ptttStr = ad.mapped_payments_str || 'N/A';

    const tp = ad.tradingPreferenceSet || {};
    let tpBadges = [];
    if (String(tp.hasUnPostAd) === "1") tpBadges.push('<span class="badge bg-warning text-dark border border-warning shadow-sm py-1 px-2" style="font-size: 0.85rem; font-weight: 500;"><i class="bi bi-person-x-fill"></i> Nhà QC</span>');
    if (String(tp.hasRegisterTime) === "1") tpBadges.push(`<span class="badge bg-light text-dark border shadow-sm py-1 px-2" style="font-size: 0.85rem; font-weight: 500;"><i class="bi bi-calendar-check"></i> Đăng ký >= ${tp.registerTimeThreshold} ngày</span>`);
    if (String(tp.hasOrderFinishNumberDay30) === "1") tpBadges.push(`<span class="badge bg-light text-dark border shadow-sm py-1 px-2" style="font-size: 0.85rem; font-weight: 500;"><i class="bi bi-bag-check"></i> >= ${tp.orderFinishNumberDay30} GD (30 ngày)</span>`);
    if (String(tp.hasCompleteRateDay30) === "1") tpBadges.push(`<span class="badge bg-light text-dark border shadow-sm py-1 px-2" style="font-size: 0.85rem; font-weight: 500;"><i class="bi bi-percent"></i> Hoàn thành >= ${tp.completeRateDay30}%</span>`);
    
    const tpWrap = tpBadges.length > 0 ? `<div class="mt-3 pt-3 border-top border-light d-flex flex-wrap gap-2 align-items-center"><span class="text-muted fw-bold"><i class="bi bi-shield-check"></i> Điều kiện GD:</span> ${tpBadges.join('')}</div>` : '';

    return `
    <div class="list-group-item ad-list-item py-3 px-3 shadow-sm mb-3 rounded border bg-white" style="font-size: 0.85rem;">
        <div class="row align-items-center g-3">
            <div class="col-sm-3 border-end border-light">
                <div class="fw-bold text-primary mb-2"><i class="bi bi-robot me-1"></i>${ad.account_email || 'Unknown'}</div>
                <!-- ID QC đã được làm nổi bật -->
                <div class="d-flex align-items-center gap-1 mb-2 text-muted" style="font-size: 0.8rem; cursor: pointer;" onclick="copyAdId('${ad.id}')" title="Click để Copy">
                    <span class="fw-bold">ID:</span> 
                    <span class="user-select-all bg-light px-2 py-1 rounded border border-secondary shadow-sm fw-bold text-dark">${ad.id}</span>
                </div>
                <div class="text-danger fw-bold mt-1"><i class="bi bi-credit-card me-1"></i>${ptttStr}</div>
            </div>
            <div class="col-sm-3 text-sm-center border-end border-light">
                <div class="text-muted mb-2 fw-bold">Loại QC: ${sideBadge}</div>
                <div class="fw-bold ${priceColor}">${priceText}: ${pPrice.toLocaleString('en-US')} <span class="text-secondary fw-normal">${fiat}/${coin}</span></div>
            </div>
            <div class="col-sm-4 text-sm-center border-end border-light">
                <div class="fw-semibold text-dark mb-2">
                    Giới hạn: ${pMin.toLocaleString('en-US')} - ${pMax.toLocaleString('en-US')} ${fiat}<br>
                    <span class="text-secondary opacity-75 fw-normal">(~ ${minUsdt} - ${maxUsdt} USDT)</span>
                </div>
                <div class="d-inline-block px-3 py-1 bg-light border rounded shadow-sm text-dark">
                    Khả dụng: <b class="text-success">${pAvail.toLocaleString('en-US')} USDT</b> <span class="text-muted mx-1">|</span> Khóa: <b class="text-warning text-dark">${pFrozen.toLocaleString('en-US')} USDT</b>
                </div>
            </div>
            <div class="col-sm-2 text-sm-end text-center">
                <div class="d-flex flex-sm-column flex-row justify-content-center justify-content-sm-end gap-2">
                    <button class="btn btn-sm btn-success fw-bold shadow-sm" style="font-size: 0.85rem;" onclick="showAdDetails('${group}', '${ad.account_email}', '${ad.id}')"><i class="bi bi-eye"></i> ONLINE</button>
                    <button class="btn btn-sm btn-outline-danger fw-bold shadow-sm" style="font-size: 0.85rem;" onclick="triggerCancelAd('${group}', '${ad.account_email}', '${ad.id}')"><i class="bi bi-trash"></i> XÓA QC</button>
                </div>
                <!-- CÔNG TẮC AUTO UPDATE GIÁ -->
                <div class="form-check form-switch mt-3 d-flex justify-content-sm-end justify-content-center align-items-center gap-1">
                    <input class="form-check-input m-0 border-primary shadow-sm" type="checkbox" id="autoUpdate_${ad.id}" ${isAutoUpdateAd(ad.id)?'checked':''} onchange="toggleAutoUpdateAd('${ad.id}', this.checked)">
                    <label class="form-check-label text-primary fw-bold mb-0" style="font-size: 0.8rem; cursor:pointer;" for="autoUpdate_${ad.id}">Auto Giá</label>
                </div>
            </div>
        </div>
        ${tpWrap}
    </div>`;
}

// HÀM NGẦM UPDATE GIÁ
function silentUpdateAdPrice(ad, targetPrice, group, email, reasonTag = "") {
    let adId = String(ad.id || ad.itemId);
    if(updatingAds.has(adId)) return; // Đang chạy update rồi thì bỏ qua
    updatingAds.add(adId);

    // Ghép nhãn nếu có (ví dụ: [AUTO-UPDATE] [Cắt lãi xả hàng MỐC 1])
    let logPrefix = reasonTag ? `[AUTO-UPDATE] ${reasonTag}` : `[AUTO-UPDATE]`;

    addTerminalLog(`${logPrefix} Đang cập nhật giá QC ${adId}. Giá cũ: ${ad.price} -> Giá mới: ${targetPrice}`, 'warn');

    const tp = ad.tradingPreferenceSet || {};
    const pIds = ad.paymentTerms ? ad.paymentTerms.map(p => String(p.paymentType)).filter(id => id && id !== "undefined" && id !== "null" && id !== "-1") : [];
    const ptttStr = ad.mapped_payments_str || (ad.paymentTerms ? ad.paymentTerms.map(p => p.paymentConfig ? p.paymentConfig.paymentName : p.paymentType).join(', ') : "");

    // --- LOGIC TÍNH TOÁN LẠI SỐ LƯỢNG USDT (QUANTITY) THEO GIÁ MỚI ---
    let targetPriceNum = Number(targetPrice);
    let maxFiat = Number(ad.maxAmount || 0);
    let newQuantityStr = String(ad.quantity || ad.lastQuantity || 0);

    if (targetPriceNum > 0 && maxFiat > 0) {
        let requiredQty = maxFiat / targetPriceNum;
        requiredQty = Math.ceil(requiredQty * 10000) / 10000; 
        newQuantityStr = requiredQty.toString();
        addTerminalLog(`${logPrefix} Tự động điều chỉnh Số lượng: ${newQuantityStr} USDT (để giữ nguyên Limit Max Fiat: ${maxFiat})`, 'info');
    }

    const payload = {
        group: group, email: email, id: adId,
        price: targetPrice.toString(),
        quantity: newQuantityStr, // Dùng số lượng USDT đã tính lại
        minAmount: String(ad.minAmount || 0),
        maxAmount: String(ad.maxAmount || 0),
        remark: ad.remark || "",
        paymentPeriod: String(ad.paymentPeriod || 15),
        pttt_str: ptttStr, paymentIds: pIds,
        tradingPreferenceSet: {
            isKyc: String(tp.isKyc) === "1" ? "1" : "0",
            isEmail: String(tp.isEmail) === "1" ? "1" : "0",
            isMobile: String(tp.isMobile) === "1" ? "1" : "0",
            hasUnPostAd: String(tp.hasUnPostAd) === "1" ? "1" : "0",
            hasRegisterTime: String(tp.hasRegisterTime) === "1" ? "1" : "0",
            registerTimeThreshold: String(tp.registerTimeThreshold || "0"),
            hasOrderFinishNumberDay30: String(tp.hasOrderFinishNumberDay30) === "1" ? "1" : "0",
            orderFinishNumberDay30: String(tp.orderFinishNumberDay30 || "0"),
            hasCompleteRateDay30: String(tp.hasCompleteRateDay30) === "1" ? "1" : "0",
            completeRateDay30: String(tp.completeRateDay30 || "0")
        }
    };

    fetch('/api/update_ad', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }).then(r => r.json()).then(d => {
        updatingAds.delete(adId);
        if(d.status === 'success') {
            addTerminalLog(`${logPrefix} ✅ Cập nhật thành công QC ${adId} (Giá: ${targetPrice}, Qty: ${newQuantityStr})`, 'success');
            // Cập nhật lại UI ngay lập tức cả Giá và USDT
            ad.price = targetPrice.toString(); 
            ad.quantity = newQuantityStr;
            ad.lastQuantity = newQuantityStr;
            renderDashboardUI(); 
        } else {
            addTerminalLog(`${logPrefix} ❌ Lỗi QC ${adId}: ${d.message}`, 'error');
        }
    }).catch(e => {
        updatingAds.delete(adId);
        addTerminalLog(`${logPrefix} ❌ Lỗi mạng QC ${adId}: ${e.message}`, 'error');
    });
}

// HÀM KIỂM TRA & KÍCH HOẠT AUTO UPDATE
function checkAndRunAutoUpdates() {
    const group = document.getElementById('groupSelect').value;
    if(!group) return;
    let autoUpdateSet = new Set(JSON.parse(localStorage.getItem('autoUpdateAdIds') || '[]'));
    if(autoUpdateSet.size === 0) return;
    
    window.adCutLevels = window.adCutLevels || {}; // Biến toàn cục lưu nhãn cắt lãi

    // 1. Kiểm tra QC MUA
    latestConfigs.forEach(cfg => {
        let matchedAds = globalAllAds.filter(ad => ad.status == 10 && String(ad.side) === '0' && (ad.currencyId || '').toUpperCase() === cfg.fiat.toUpperCase() && (ad.mapped_payments_str ? ad.mapped_payments_str.split(', ') : []).some(p => cfg.payments_active.includes(p)));
        
        let targetPriceStr = (cfg.ref_price_str || "0").toString().replace(/,/g, '');
        let targetPriceNum = Number(targetPriceStr);
        
        if(targetPriceNum > 0) {
            matchedAds.forEach(ad => {
                if(autoUpdateSet.has(String(ad.id))) {
                    let currentPrice = Number(ad.price || 0);
                    if(currentPrice > 0 && Math.abs(currentPrice - targetPriceNum) > 0.000001) {
                        silentUpdateAdPrice(ad, targetPriceStr, group, ad.account_email || ad.account);
                    }
                }
            });
        }
    });

    // 2. Kiểm tra QC BÁN (Linked Sell Ads)
    const allPendingOrders = [...Object.values(globalActiveOrders), ...Object.values(globalArchivingOrders)];
    Object.keys(globalLinkedSellAds).forEach(poId => {
        let sAd = globalLinkedSellAds[poId];
        let sAdId = String(sAd.itemId || sAd.id);
        
        if(sAd && sAd.status == 10 && autoUpdateSet.has(sAdId)) {
            let po = allPendingOrders.find(o => String(o.id) === String(poId));
            if(po) {
                let st = String(po.status);
                if (st === '40' || st === '80' || st === '50') return;
                
                let hasPendingSellOrders = globalLinkedSellOrders[poId] && globalLinkedSellOrders[poId].length > 0;

                let targetPriceNum = Number(po.expected_sell_price || 0);
                let isCuttingProfit = false; 
                let appliedLevel = 0;
                
                if (targetPriceNum > 0) {
                    let reduceConfig = getAutoReduceConfig();
                    if (reduceConfig.enabled) {
                        
                        // --- SỬA LẠI: TÍNH THẲNG TỪ THỜI GIAN TẠO ĐƠN GỐC ---
                        let createTimeMs = parseInt(po.createDate);
                        let elapsedMinutes = (Date.now() - createTimeMs) / 60000;
                        
                        let highestLvl = null;
                        let highestIdx = -1;
                        // Quét xem thời gian đã trôi qua đạt mốc nào cao nhất
                        for(let i = 0; i < reduceConfig.levelsCount; i++) {
                            let lvl = reduceConfig.levels[i];
                            if (elapsedMinutes >= lvl.minutes) {
                                if (!highestLvl || lvl.minutes > highestLvl.minutes) {
                                    highestLvl = lvl;
                                    highestIdx = i + 1; // Mốc 1, 2, 3
                                }
                            }
                        }
                        
                        if (highestLvl) {
                            if (hasPendingSellOrders) return;
                            
                            let buyQty = parseFloat(po.current_usdt || po.quantity || 0);
                            let adFiat = parseFloat(sAd.maxAmount || po.amount || 0);
                            let originalTargetAdUsdt = adFiat / targetPriceNum;
                            let originalProfitUsdt = buyQty - originalTargetAdUsdt;
                            
                            if (originalProfitUsdt > 0) {
                                let newProfitUsdt = originalProfitUsdt * (highestLvl.percent / 100);
                                let newTargetAdUsdt = buyQty - newProfitUsdt;
                                let cutPrice = adFiat / newTargetAdUsdt;
                                
                                targetPriceNum = cutPrice; 
                                isCuttingProfit = true;
                                appliedLevel = highestIdx;
                            }
                        } else {
                            if (hasPendingSellOrders) return; 
                        }
                    } else {
                        if (hasPendingSellOrders) return; 
                    }
                } else {
                    if (hasPendingSellOrders) return;
                }

                let currentPrice = Number(sAd.price || 0);
                let oldPriceStr = String(sAd.price || '0');
                let decimalPlaces = 0;
                if (oldPriceStr.includes('.')) {
                    decimalPlaces = oldPriceStr.split('.')[1].length;
                }
                if (decimalPlaces < 2) decimalPlaces = 2; // Fix cứng tối thiểu 2 số thập phân

                targetPriceNum = Number(targetPriceNum.toFixed(decimalPlaces));

                // -- SỬ DỤNG HÀM TẠO GIÁ UNIQUE ĐỂ NẾU TRÙNG SẼ TỰ LỆCH 0.01 --
                let fiat = sAd.currencyId || po.currencyId || '';
                let accEmail = sAd.account_email || sAd.account || po.account_name;
                targetPriceNum = getUniquePrice(targetPriceNum, accEmail, '1', fiat, decimalPlaces, sAdId);

                if(targetPriceNum > 0 && currentPrice > 0 && Math.abs(currentPrice - targetPriceNum) > Math.pow(10, -(decimalPlaces + 1))) {
                    let targetPriceStr = targetPriceNum.toFixed(decimalPlaces);
                    
                    let reasonTag = "";
                    if (isCuttingProfit) {
                        reasonTag = `[Cắt lãi xả hàng MỐC ${appliedLevel}]`;
                        window.adCutLevels[sAdId] = appliedLevel; // Ghi đè nhãn mới
                    } else {
                        delete window.adCutLevels[sAdId]; // Hủy nhãn
                    }
                    
                    // Truyền thêm reasonTag vào hàm silentUpdateAdPrice
                    silentUpdateAdPrice(sAd, targetPriceStr, group, sAd.account_email || sAd.account || po.account_name, reasonTag);
                } else {
                    if (isCuttingProfit) {
                        window.adCutLevels[sAdId] = appliedLevel;
                    } else {
                        delete window.adCutLevels[sAdId];
                    }
                }
            }
        }
    });
}

function renderDashboardUI() {
    const content = document.getElementById('dashboardAdsContent'); const group = document.getElementById('groupSelect').value;
    if(latestConfigs.length === 0) { content.innerHTML = '<div class="text-warning small fst-italic">Chưa có cấu hình.</div>'; content.style.display = 'block'; return; }

    let html = ''; 

    // --- PANEL ĐIỀU KHIỂN AUTO ---
    let autoSellConfig = JSON.parse(localStorage.getItem('autoCreateSellAdConfig') || '{"enabled":false}');
    let autoStopAdsConfig = JSON.parse(localStorage.getItem('autoStopAdsConfig') || '{"perConfigLimit":false, "xValue":3, "globalLimit":false, "yValue":10, "autoResume":false}');
    
    // --- Lấy cấu hình cắt lãi (ĐA CẤP) ---
    let reduceConfig = getAutoReduceConfig();
    let levelsHtml = '';
    for(let i = 0; i < 3; i++) {
        let display = (i < reduceConfig.levelsCount) ? 'block' : 'none';
        let lvl = reduceConfig.levels[i];
        levelsHtml += `
        <div class="mt-2 text-dark fw-semibold" id="reduceLevelRow_${i}" style="font-size: 0.85rem; display: ${display};">
            <span class="badge ${i===0 ? 'bg-secondary' : i===1 ? 'bg-warning text-dark' : 'bg-danger'}">Mốc ${i+1}</span> 
            Sau <input type="number" class="form-control form-control-sm d-inline-block text-center fw-bold text-danger border-danger px-1 py-0 mx-1" style="width: 45px;" value="${lvl.minutes}" oninput="updateAutoReduceLevel(${i}, 'min', this.value)"> p, 
            giữ <input type="number" class="form-control form-control-sm d-inline-block text-center fw-bold text-success border-success px-1 py-0 mx-1" style="width: 45px;" value="${lvl.percent}" oninput="updateAutoReduceLevel(${i}, 'pct', this.value)"> % lãi.
        </div>`;
    }
    
    // Đã làm nhỏ các nút gán nhóm và tạo qc bán để tiết kiệm diện tích
    html += `<div class="card mb-3 shadow-sm border-info bg-light">
        <div class="card-body py-2 px-3 d-flex flex-wrap justify-content-between align-items-center gap-2">
            <div class="d-flex flex-wrap align-items-center gap-3">
                <!-- Công tắc Tạo QC Bán (Thu nhỏ) -->
                <div class="form-check form-switch m-0 d-flex align-items-center gap-1">
                    <input class="form-check-input m-0 border-warning" type="checkbox" id="autoCreateSellSwitch" ${autoSellConfig.enabled ? 'checked' : ''} onchange="toggleAutoCreateSellAd(this.checked)">
                    <label class="form-check-label fw-bold text-dark" for="autoCreateSellSwitch" style="cursor: pointer; font-size: 0.8rem;">Auto tạo QC Bán</label>
                </div>

                <!-- Nút Tắt Quảng Cáo -->
                <div class="dropdown border-start border-secondary ps-2">
                    <button class="btn btn-sm btn-danger dropdown-toggle fw-bold shadow-sm" style="font-size: 0.8rem;" type="button" data-bs-toggle="dropdown" aria-expanded="false"><i class="bi bi-power"></i> TẮT QC</button>
                    <ul class="dropdown-menu shadow">
                        <li><a class="dropdown-item fw-bold text-success" href="#" onclick="turnOffAds('buy')"><i class="bi bi-cart-x-fill me-2"></i> Tắt QC MUA</a></li>
                        <li><a class="dropdown-item fw-bold text-danger" href="#" onclick="turnOffAds('sell')"><i class="bi bi-tags-fill me-2"></i> Tắt QC BÁN</a></li>
                        <li><a class="dropdown-item fw-bold text-dark" href="#" onclick="turnOffAds('all')"><i class="bi bi-x-octagon-fill me-2"></i> Tắt TẤT CẢ</a></li>
                    </ul>
                </div>

                <!-- Nút Chống quá tải Mua -->
                <div class="dropdown border-start border-secondary ps-2">
                    <button class="btn btn-sm btn-outline-danger dropdown-toggle fw-bold shadow-sm" style="font-size: 0.8rem;" type="button" data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false"><i class="bi bi-shield-lock-fill"></i> CHỐNG QUÁ TẢI MUA</button>
                    <ul class="dropdown-menu shadow p-3 border-danger" style="width: 350px;">
                        <li>
                            <div class="form-check form-switch m-0 d-flex align-items-center gap-2">
                                <input class="form-check-input fs-5 m-0 border-danger" type="checkbox" id="autoStopConfigSwitch" ${autoStopAdsConfig.perConfigLimit ? 'checked' : ''} onchange="toggleAutoStopConfig(this.checked)">
                                <label class="form-check-label fw-bold text-dark" for="autoStopConfigSwitch" style="cursor: pointer; font-size: 0.9rem;">Tắt QC Mua của Cấu hình đó nếu đạt</label>
                            </div>
                            <div class="d-flex align-items-center gap-2 mt-2 ms-5">
                                <input type="number" class="form-control form-control-sm text-center fw-bold text-danger border-danger shadow-sm" style="width: 60px;" value="${autoStopAdsConfig.xValue}" oninput="updateAutoStopX(this.value)">
                                <span class="text-muted fw-bold" style="font-size: 0.85rem;">đơn pending</span>
                            </div>
                        </li>
                        <li><hr class="dropdown-divider my-3"></li>
                        <li>
                            <div class="form-check form-switch m-0 d-flex align-items-center gap-2">
                                <input class="form-check-input fs-5 m-0 border-danger" type="checkbox" id="autoStopGlobalSwitch" ${autoStopAdsConfig.globalLimit ? 'checked' : ''} onchange="toggleAutoStopGlobal(this.checked)">
                                <label class="form-check-label fw-bold text-dark" for="autoStopGlobalSwitch" style="cursor: pointer; font-size: 0.9rem;">Tắt TOÀN BỘ QC Mua nếu Tổng đạt</label>
                            </div>
                            <div class="d-flex align-items-center gap-2 mt-2 ms-5">
                                <input type="number" class="form-control form-control-sm text-center fw-bold text-danger border-danger shadow-sm" style="width: 60px;" value="${autoStopAdsConfig.yValue}" oninput="updateAutoStopY(this.value)">
                                <span class="text-muted fw-bold" style="font-size: 0.85rem;">đơn pending</span>
                            </div>
                        </li>
                        <li><hr class="dropdown-divider my-3"></li>
                        <li>
                            <div class="form-check form-switch m-0 d-flex align-items-center gap-2">
                                <input class="form-check-input fs-5 m-0 border-success" type="checkbox" id="autoResumeSwitch" ${autoStopAdsConfig.autoResume ? 'checked' : ''} onchange="toggleAutoResume(this.checked)">
                                <label class="form-check-label fw-bold text-dark" for="autoResumeSwitch" style="cursor: pointer; font-size: 0.9rem;">Tự động TẠO LẠI QC Mua khi hết quá tải</label>
                            </div>
                        </li>
                    </ul>
                </div>

                <!-- Nút Tự động Cắt Lãi (ĐA CẤP) -->
                <div class="dropdown border-start border-secondary ps-2">
                    <button class="btn btn-sm btn-outline-warning dropdown-toggle fw-bold text-dark shadow-sm" style="font-size: 0.8rem;" type="button" data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false"><i class="bi bi-scissors"></i> CẮT LÃI XẢ HÀNG</button>
                    <ul class="dropdown-menu shadow p-3 border-warning" style="width: 360px;">
                        <li>
                            <div class="form-check form-switch m-0 d-flex align-items-center gap-2 mb-2 border-bottom pb-2">
                                <input class="form-check-input fs-5 m-0 border-warning" type="checkbox" id="autoReduceProfitSwitch" ${reduceConfig.enabled ? 'checked' : ''} onchange="toggleAutoReduceProfit(this.checked)">
                                <label class="form-check-label fw-bold text-dark" for="autoReduceProfitSwitch" style="cursor: pointer; font-size: 0.9rem;">Bật tự động giảm giá bán (cắt lãi)</label>
                            </div>
                            <div class="mt-1 d-flex align-items-center">
                                <label class="fw-bold text-dark" style="font-size: 0.85rem;">Số mốc giảm:</label>
                                <select class="form-select form-select-sm d-inline-block w-auto ms-2 fw-bold border-secondary shadow-sm" onchange="updateAutoReduceLevelsCount(this.value)">
                                    <option value="1" ${reduceConfig.levelsCount === 1 ? 'selected' : ''}>1 Mốc</option>
                                    <option value="2" ${reduceConfig.levelsCount === 2 ? 'selected' : ''}>2 Mốc</option>
                                    <option value="3" ${reduceConfig.levelsCount === 3 ? 'selected' : ''}>3 Mốc</option>
                                </select>
                            </div>
                            ${levelsHtml}
                        </li>
                    </ul>
                </div>
            </div>
        </div>
    </div>`;

    const allPendingOrders = [...Object.values(globalActiveOrders), ...Object.values(globalArchivingOrders)];
    
    // --- Lấy cấu hình Chống Quá Tải để kiểm tra vô hiệu hóa nút bấm ---
    let autoStopAdsConfigObj = JSON.parse(localStorage.getItem('autoStopAdsConfig') || '{"perConfigLimit":false, "xValue":3, "globalLimit":false, "yValue":10, "autoResume":false}');
    let validGlobalPendingBuyOrders = allPendingOrders.filter(po => String(po.side) === '0' && !['40','80','50'].includes(String(po.status)));
    let isGlobalOverloaded = autoStopAdsConfigObj.globalLimit && validGlobalPendingBuyOrders.length >= autoStopAdsConfigObj.yValue;
    // -----------------------------------------------------------------

    let matchedAdIds = new Set(); let matchedOrderIds = new Set();
    
    latestConfigs.forEach(cfg => {
        let matchedAds = globalAllAds.filter(ad => ad.status == 10 && String(ad.side) === '0' && (ad.currencyId || '').toUpperCase() === cfg.fiat.toUpperCase() && (ad.mapped_payments_str ? ad.mapped_payments_str.split(', ') : []).some(p => cfg.payments_active.includes(p)));
        let matchedPending = allPendingOrders.filter(po => String(po.side) === '0' && (po.currencyId || '').toUpperCase() === cfg.fiat.toUpperCase() && cfg.payments_active.includes(po.payment_method_name));
        let paymentsHtml = cfg.payments_active.map(p => '<span class="badge payment-badge rounded-pill shadow-sm mb-1">' + p + '</span>').join(' '); const rawPtttStr = cfg.payments_active.join(', ');
        let marketPrice = cfg.ref_price_str || 'N/A';
        
        // --- THÊM HIỂN THỊ MARGIN ---
        let marginVal = parseFloat(cfg.margin || 0);
        let offsetStr = cfg.offset_str || "";
        let marginHtml = (marginVal > 0 && offsetStr !== "") ? `<span class="text-warning ms-1 fw-bold" style="font-size: 0.85rem;">(${offsetStr})</span>` : '';

        // Lọc các đơn đang sống để xét quá tải cục bộ
        let validMatchedPendingBuy = matchedPending.filter(po => !['40','80','50'].includes(String(po.status)));
        let isConfigOverloaded = autoStopAdsConfigObj.perConfigLimit && validMatchedPendingBuy.length >= autoStopAdsConfigObj.xValue;

        // Tự động Disable nút Tạo QC nếu đang bị quá tải
        let createAdBtnHtml = '';
        if (isGlobalOverloaded) {
            createAdBtnHtml = `
                <button class="btn btn-sm btn-secondary fw-bold shadow-sm" disabled><i class="bi bi-rocket-takeoff"></i> Tạo QC Mua</button>
                <div class="text-danger text-center fw-bold mt-1" style="font-size: 0.75rem; line-height: 1.2;"><i class="bi bi-shield-lock-fill"></i> Đang khóa:<br>Quá tải toàn cục</div>
            `;
        } else if (isConfigOverloaded) {
            createAdBtnHtml = `
                <button class="btn btn-sm btn-secondary fw-bold shadow-sm" disabled><i class="bi bi-rocket-takeoff"></i> Tạo QC Mua</button>
                <div class="text-danger text-center fw-bold mt-1" style="font-size: 0.75rem; line-height: 1.2;"><i class="bi bi-shield-lock-fill"></i> Đang khóa:<br>Đạt giới hạn đơn</div>
            `;
        } else {
            createAdBtnHtml = `<button class="btn btn-sm btn-primary fw-bold shadow-sm" onclick="triggerCreateAd('${cfg.fiat}', '${rawPtttStr}')"><i class="bi bi-rocket-takeoff"></i> Tạo QC Mua</button>`;
        }

        matchedAds.forEach(ad => matchedAdIds.add(String(ad.id)));
        matchedPending.forEach(po => { 
            matchedOrderIds.add(String(po.id)); 
            if(globalLinkedSellOrders[po.id]) globalLinkedSellOrders[po.id].forEach(spo => matchedOrderIds.add(String(spo.id))); 
            Object.values(globalArchivingSellOrders).forEach(spo => { if (spo.linked_buy_order_id === po.id) matchedOrderIds.add(String(spo.id)); });
            if(globalLinkedSellAds[po.id]) matchedAdIds.add(String(globalLinkedSellAds[po.id].itemId || globalLinkedSellAds[po.id].id)); 
        });

        // Nối thêm cái biến marginHtml vào đằng sau marketPrice:
        html += '<div class="card market-card mb-4 border border-light shadow-sm"><div class="row g-0 h-100"><div class="col-lg-2 col-md-3 market-left p-3 d-flex flex-column border-end bg-light"><div class="text-success fw-bold fs-5 mb-1"><i class="bi bi-globe-americas"></i> ' + cfg.fiat + '/' + cfg.coin + '</div><div class="text-primary fw-bold mb-2" style="font-size: 0.9rem;">Giá Mua: <span class="fs-5 text-danger">' + marketPrice + '</span>' + marginHtml + '</div><div class="d-flex flex-wrap gap-1 mt-1 mb-3">' + paymentsHtml + '</div><div class="d-flex flex-column gap-2"><button class="btn btn-sm btn-dark fw-bold shadow-sm" onclick="openAdConfig(\'' + cfg.fiat + '\', \'' + rawPtttStr + '\', ' + (cfg.ref_price || 0) + ')"><i class="bi bi-gear"></i> Cấu hình QC</button>' + createAdBtnHtml + '</div></div><div class="col-lg-10 col-md-9 bg-white"><div class="list-group list-group-flush h-100">';

        if(matchedAds.length > 0) {
            html += '<div class="p-3 bg-white">';
            matchedAds.forEach(ad => { html += generateAdRowHtml(ad, group, cfg); });
            html += '</div>';
        } else { html += '<div class="p-4 text-center text-muted fst-italic">Chưa có QC Online khớp.</div>'; }

        if(matchedPending.length > 0) { html += '<div class="bg-light text-dark px-3 py-2 fw-bold border-top border-bottom shadow-sm" style="font-size: 0.85rem;"><i class="bi bi-list-check"></i> ĐƠN PENDING</div><div class="p-3">'; matchedPending.forEach(po => { html += generateOrderRowHtml(po, cfg, !!globalArchivingOrders[po.id], false); }); html += '</div>'; }
        html += '</div></div></div></div>';
    }); 

    const allSellOrders = [...Object.values(globalActiveSellOrders), ...Object.values(globalArchivingSellOrders)];
    let orphanAds = globalAllAds.filter(ad => ad.status == 10 && !matchedAdIds.has(String(ad.id)));
    let allCombinedOrders = [...allPendingOrders, ...allSellOrders];
    let orphanOrders = allCombinedOrders.filter(o => !matchedOrderIds.has(String(o.id)));

    html += '<div class="card market-card mb-4 border border-secondary shadow-sm" style="border-style: dashed !important;"><div class="card-header bg-secondary text-white fw-bold"><i class="bi bi-inboxes"></i> CÁC ĐƠN VÀ QUẢNG CÁO NGOÀI LỀ (Không thuộc cấu hình nào bên trên)</div><div class="list-group list-group-flush">';
    
    if (orphanAds.length === 0 && orphanOrders.length === 0) {
        html += '<div class="p-4 text-center text-muted fst-italic">Mọi thứ đều sạch sẽ, không có đơn hay QC nào đi lạc!</div>';
    } else {
        if(orphanAds.length > 0) {
            html += '<div class="p-3 bg-light">';
            orphanAds.forEach(ad => { html += generateAdRowHtml(ad, group, {}); });
            html += '</div>';
        }
        if(orphanOrders.length > 0) {
            html += '<div class="p-3 border-top border-secondary">';
            orphanOrders.forEach(po => { html += generateOrderRowHtml(po, { fiat: po.currencyId || '?', coin: po.tokenId || 'USDT', ref_price: 0 }, !!(globalArchivingOrders[po.id] || globalArchivingSellOrders[po.id]), false); });
            html += '</div>';
        }
    }
    
    html += '</div></div>';
    content.innerHTML = html; content.style.display = 'block'; syncOrderStateToBackend();

    // KIỂM TRA XEM CÓ CẦN AUTO UPDATE NGAY SAU KHI RENDER XONG KHÔNG
    checkAndRunAutoUpdates();
}

function calcInlineUsdt() {
    const price = parseFloat(document.getElementById('inlineEditPrice')?.value) || 0;
    const min = parseFloat(document.getElementById('inlineEditMin')?.value) || 0;
    const max = parseFloat(document.getElementById('inlineEditMax')?.value) || 0;
    
    if (price > 0) {
        if (document.getElementById('inlineEditMinUsdt')) {
            const minUsdt = (min / price).toLocaleString('en-US', {maximumFractionDigits: 2});
            document.getElementById('inlineEditMinUsdt').innerText = `(~ ${minUsdt} USDT)`;
        }
        if (document.getElementById('inlineEditMaxUsdt')) {
            const maxUsdt = (max / price).toLocaleString('en-US', {maximumFractionDigits: 2});
            document.getElementById('inlineEditMaxUsdt').innerText = `(~ ${maxUsdt} USDT)`;
        }
        
        // --- TỰ ĐỘNG NHẢY SỐ LƯỢNG USDT KHI GÕ GIÁ THỦ CÔNG ---
        let requiredQty = 0;
        if (max > 0) {
            requiredQty = max / price;
            requiredQty = Math.ceil(requiredQty * 10000) / 10000; // Làm tròn lên 4 chữ số
            
            const qtyInput = document.getElementById('inlineEditQuantity');
            if (qtyInput) {
                qtyInput.value = requiredQty;
            }
        }

        // --- CẬP NHẬT CHÊNH LỆCH U KHI SỬA GIÁ/SỐ LƯỢNG ---
        const buyQtyStr = document.getElementById('inlineEditBuyQty')?.value;
        const diffDisplay = document.getElementById('inlineEditDiffU');
        if (buyQtyStr && diffDisplay) {
            let bQ = parseFloat(buyQtyStr);
            if (bQ > 0) {
                let currentSellQty = parseFloat(document.getElementById('inlineEditQuantity')?.value || 0);
                let diffU = (bQ - currentSellQty).toFixed(2);
                let sign = diffU >= 0 ? '+' : '';
                let diffHtml = diffU >= 0 ? `<span class="text-success fw-bold">${sign}${diffU} U</span>` : `<span class="text-danger fw-bold">${diffU} U</span>`;
                diffDisplay.innerHTML = `Chênh lệch: ${diffHtml}`;
                diffDisplay.classList.remove('d-none');
            }
        }
    }
}


function toggleEditMode(isEdit) {
    document.querySelectorAll('.view-el').forEach(el => el.classList.toggle('d-none', isEdit));
    document.querySelectorAll('.edit-el').forEach(el => el.classList.toggle('d-none', !isEdit));
    document.getElementById('btnSwitchToEdit').classList.toggle('d-none', isEdit);
    document.getElementById('editActionButtons').classList.toggle('d-none', !isEdit);
    if(isEdit) calcInlineUsdt();
}

function submitInlineEditAd() {
    const pIdsStr = document.getElementById('inlineEditPaymentIds').value;
    const paymentIds = pIdsStr ? pIdsStr.split(',').filter(id => id.trim() !== "") : [];
    const ptttStr = document.getElementById('inlineEditPtttStr').value;

    let targetPriceNum = Number(document.getElementById('inlineEditPrice').value);
    let maxFiat = Number(document.getElementById('inlineEditMax').value);
    let qtyVal = Number(document.getElementById('inlineEditQuantity').value);

    // --- BỌC THÉP LẦN CUỐI TRƯỚC KHI GỬI (Đề phòng lỡ tay xóa số lượng) ---
    if (targetPriceNum > 0 && maxFiat > 0) {
        let requiredQty = maxFiat / targetPriceNum;
        requiredQty = Math.ceil(requiredQty * 10000) / 10000;
        if (qtyVal < requiredQty) {
            qtyVal = requiredQty; // Ép số lượng phải đủ lớn
        }
    }

    const payload = {
        group: document.getElementById('inlineEditGroup').value,
        email: document.getElementById('inlineEditEmail').value,
        id: document.getElementById('inlineEditAdId').value,
        price: targetPriceNum.toString(),
        quantity: qtyVal.toString(),
        minAmount: document.getElementById('inlineEditMin').value,
        maxAmount: document.getElementById('inlineEditMax').value,
        remark: document.getElementById('inlineEditRemark').value,
        paymentPeriod: document.getElementById('inlineEditPaymentPeriod').value,
        pttt_str: ptttStr,
        paymentIds: paymentIds,
        tradingPreferenceSet: {
            isKyc: document.getElementById('inlineEditIsKyc').value,
            isEmail: document.getElementById('inlineEditIsEmail').value,
            isMobile: document.getElementById('inlineEditIsMobile').value,
            hasUnPostAd: document.getElementById('inlineEditUnpost').checked ? "1" : "0",
            hasRegisterTime: document.getElementById('inlineEditReg').checked ? "1" : "0",
            registerTimeThreshold: document.getElementById('inlineEditRegDay').value,
            hasOrderFinishNumberDay30: document.getElementById('inlineEditOrder').checked ? "1" : "0",
            orderFinishNumberDay30: document.getElementById('inlineEditOrderNum').value,
            hasCompleteRateDay30: document.getElementById('inlineEditRate').checked ? "1" : "0",
            completeRateDay30: document.getElementById('inlineEditRateNum').value
        }
    };

    Toast.fire({ icon: 'info', title: 'Đang gửi lệnh cập nhật...' });
    addTerminalLog(`--- ĐANG GỬI LỆNH SỬA QC ID: ${payload.id} ---`, "warn");
    
    fetch('/api/update_ad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).then(r => r.json()).then(d => {
        if(d.logs && Array.isArray(d.logs)) {
            d.logs.forEach(l => { 
                let t = 'info'; 
                if(l.toLowerCase().includes('lỗi') || l.toLowerCase().includes('thất bại')) t = 'error'; 
                else if(l.toLowerCase().includes('thành công')) t = 'success'; 
                addTerminalLog(l, t); 
            });
        }

        if(d.status === 'success') {
            Toast.fire({ icon: 'success', title: 'Đã cập nhật Quảng Cáo thành công!' });
            bootstrap.Modal.getInstance(document.getElementById('adDetailsModal')).hide();
            loadBuyAdsDashboard(true);
        } else {
            showErrorToast('Sửa thất bại: Xem Terminal Log');
        }
    }).catch(e => {
        showErrorToast('Lỗi mạng: ' + e.message);
        addTerminalLog(`Lỗi mạng khi gọi API Update: ${e.message}`, "error");
    });
}


function showAdDetails(group, email, itemId) {
    const contentDiv = document.getElementById('adDetailsContent'); 
    const modalTitle = document.querySelector('#adDetailsModal .modal-title');
    if(modalTitle) modalTitle.innerHTML = '<i class="bi bi-card-text"></i> Chi tiết quảng cáo';

    contentDiv.innerHTML = `<div class="p-4 text-center"><div class="spinner-border text-success"></div><div class="mt-2 text-muted">Đang lấy dữ liệu...</div></div>`; 
    new bootstrap.Modal(document.getElementById('adDetailsModal')).show();
    
    fetch('/api/get_ad_info', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ group, email, item_id: itemId }) 
    }).then(r => r.json()).then(d => {
        if(d.status === 'success') {
            const data = d.data; 
            const tp = data.tradingPreferenceSet || {}; 
            const coin = data.tokenId || 'USDT';
            const fiat = data.currencyId || '???';
            
            const pPrice = Number(data.price || 0);
            const pQty = Number(data.quantity || data.lastQuantity || 0);
            const pMin = Number(data.minAmount || 0);
            const pMax = Number(data.maxAmount || 0);
            const pAvail = Number(data.lastQuantity || 0);
            const pFrozen = Number(data.frozenQuantity || 0);

            // TÌM XEM QC BÁN NÀY ĐƯỢC GẮN VỚI ĐƠN MUA NÀO ĐỂ LẤY SỐ LƯỢNG USDT
            let buyQty = 0;
            for (let pid in globalLinkedSellAds) {
                let a = globalLinkedSellAds[pid];
                if (String(a.itemId || a.id) === String(itemId)) {
                    const allPendingOrders = [...Object.values(globalActiveOrders), ...Object.values(globalArchivingOrders)];
                    let po = allPendingOrders.find(o => String(o.id) === String(pid));
                    if (po) buyQty = parseFloat(po.current_usdt || po.quantity || 0);
                    break;
                }
            }

            // TÍNH CHÊNH LỆCH CHO CHẾ ĐỘ VIEW (CHỈ ĐỌC)
            let viewDiffHtml = '';
            if (buyQty > 0) {
                let dU = (buyQty - pQty).toFixed(2);
                let colorClass = dU >= 0 ? 'text-success' : 'text-danger';
                let sign = dU >= 0 ? '+' : '';
                viewDiffHtml = `<div class="view-el mt-1 fw-semibold" style="font-size:0.85rem">Chênh lệch: <span class="${colorClass} fw-bold">${sign}${dU} U</span></div>`;
            }

            let statusHtml = '';
            if (data.status === 10) statusHtml = '<span class="badge bg-success">Online</span>';
            else if (data.status === 20) statusHtml = '<span class="badge bg-secondary">Offline</span>';
            else if (data.status === 30) statusHtml = '<span class="badge bg-primary">Completed</span>';
            else statusHtml = `<span class="badge bg-dark">${data.status}</span>`;
            const updateTime = data.updateDate ? new Date(parseInt(data.updateDate)).toLocaleString('vi-VN') : 'Không rõ';

            let paymentsHtml = data.paymentTerms && data.paymentTerms.length > 0 ? '<div class="table-responsive"><table class="table table-sm table-bordered mb-0"><thead class="table-light"><tr><th>PTTT</th><th>Tên thật</th><th>Số TK/Email</th><th>Ngân hàng/Branch</th></tr></thead><tbody>' + data.paymentTerms.map(p => `<tr><td class="fw-bold">${p.paymentConfig?p.paymentConfig.paymentName:p.paymentType}</td><td>${p.realName||'-'}</td><td class="text-primary fw-semibold">${p.accountNo||p.payMessage||'-'}</td><td>${p.bankName||''} ${p.branchName||''}</td></tr>`).join('') + '</tbody></table></div>' : '<div class="text-muted small">Không có.</div>';
            
            const reqKyc = String(tp.isKyc) === "1" ? '<span class="fw-bold text-success">Bắt buộc</span>' : 'Không';
            const reqEmail = String(tp.isEmail) === "1" ? '<span class="fw-bold text-success">Bắt buộc</span>' : 'Không';
            const reqMobile = String(tp.isMobile) === "1" ? '<span class="fw-bold text-success">Bắt buộc</span>' : 'Không';
            const reqRegTime = String(tp.hasRegisterTime) === "1" ? `<span class="fw-bold text-warning text-dark">>= ${tp.registerTimeThreshold} ngày</span>` : 'Không';
            const reqOrder30d = String(tp.hasOrderFinishNumberDay30) === "1" ? `<span class="fw-bold text-warning text-dark">>= ${tp.orderFinishNumberDay30} đơn</span>` : 'Không';
            const reqRate30d = String(tp.hasCompleteRateDay30) === "1" ? `<span class="fw-bold text-warning text-dark">>= ${tp.completeRateDay30}%</span>` : 'Không';
            const reqUnpost = String(tp.hasUnPostAd) === "1" ? '<span class="fw-bold text-warning text-dark">Có</span>' : 'Không';

            const ptttStr = data.paymentTerms ? data.paymentTerms.map(p => p.paymentConfig ? p.paymentConfig.paymentName : p.paymentType).join(', ') : "";
            const pIds = data.paymentTerms ? data.paymentTerms.map(p => String(p.paymentType)).filter(id => id && id !== "undefined" && id !== "null" && id !== "-1") : [];
            const pIdsStr = pIds.join(',');

            const paymentPeriod = data.paymentPeriod || 15;
            const isKyc = String(tp.isKyc) === "1" ? "1" : "0";
            const isEmail = String(tp.isEmail) === "1" ? "1" : "0";
            const isMobile = String(tp.isMobile) === "1" ? "1" : "0";

            contentDiv.innerHTML = `
            <div class="p-3 bg-white text-dark">
                <input type="hidden" id="inlineEditAdId" value="${data.id}">
                <input type="hidden" id="inlineEditEmail" value="${email}">
                <input type="hidden" id="inlineEditGroup" value="${group}">
                <input type="hidden" id="inlineEditPtttStr" value="${ptttStr}">
                <input type="hidden" id="inlineEditPaymentIds" value="${pIdsStr}">
                <input type="hidden" id="inlineEditPaymentPeriod" value="${paymentPeriod}">
                <input type="hidden" id="inlineEditIsKyc" value="${isKyc}">
                <input type="hidden" id="inlineEditIsEmail" value="${isEmail}">
                <input type="hidden" id="inlineEditIsMobile" value="${isMobile}">
                <input type="hidden" id="inlineEditBuyQty" value="${buyQty}">

                <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mt-2 mb-3">
                    <h6 class="fw-bold text-primary mb-0"><i class="bi bi-info-circle"></i> 1. THÔNG TIN CƠ BẢN</h6>
                    <button id="btnSwitchToEdit" class="btn btn-sm btn-warning fw-bold shadow-sm" onclick="toggleEditMode(true)"><i class="bi bi-pencil-square"></i> SỬA QUẢNG CÁO NÀY</button>
                    <div id="editActionButtons" class="d-none">
                        <button class="btn btn-sm btn-secondary fw-bold shadow-sm me-2" onclick="toggleEditMode(false)">HỦY</button>
                        <button class="btn btn-sm btn-success fw-bold shadow-sm" onclick="submitInlineEditAd()"><i class="bi bi-floppy"></i> LƯU THAY ĐỔI</button>
                    </div>
                </div>
                
                <div class="row g-2 mb-3" style="font-size: 0.95rem;">
                    <div class="col-md-3 mb-1"><strong>Ads ID:</strong> <span class="text-secondary">${data.id}</span></div>
                    <div class="col-md-3 mb-1 text-truncate" title="UID gốc Bybit: ${data.userId}"><strong>Mã TK:</strong> <span class="text-primary fw-bold">${email.split('@')[0].toLowerCase()}</span></div>
                    <div class="col-md-3 mb-1"><strong>Trạng thái:</strong> ${statusHtml}</div>
                    <div class="col-md-3 mb-1"><strong>Cập nhật:</strong> <span class="text-muted" style="font-size: 0.85rem;">${updateTime}</span></div>

                    <div class="col-md-3 mt-1"><strong>Loại QC:</strong> ${String(data.side)==='0'?'<span class="badge bg-success">MUA</span>':'<span class="badge bg-danger">BÁN</span>'}</div>
                    <div class="col-md-3 mt-1"><strong>T.gian GD:</strong> <span class="fw-semibold">${paymentPeriod} phút</span></div>
                    <div class="col-md-3 mt-1"><strong>Khả dụng:</strong> <span class="text-success fw-bold">${pAvail.toLocaleString('en-US')}</span> <span class="text-muted" style="font-size: 0.8rem;">${coin}</span></div>
                    <div class="col-md-3 mt-1"><strong>Đóng băng:</strong> <span class="text-warning text-dark fw-bold">${pFrozen.toLocaleString('en-US')}</span> <span class="text-muted" style="font-size: 0.8rem;">${coin}</span></div>
                </div>

                <div class="row g-2 mb-4 p-3 bg-light border rounded shadow-sm" style="font-size: 0.95rem;">
                    <div class="col-md-3">
                        <strong class="text-danger">Giá (${fiat}/${coin}):</strong><br>
                        <span class="view-el text-danger fw-bold fs-5 mt-1 d-inline-block">${pPrice.toLocaleString('en-US')}</span>
                        <input type="number" step="0.0001" id="inlineEditPrice" class="edit-el form-control form-control-sm text-danger fw-bold border-danger d-none mt-1" value="${pPrice}" oninput="calcInlineUsdt()">
                    </div>
                    <div class="col-md-3">
                        <strong class="text-success">Số lượng (${coin}):</strong><br>
                        <span class="view-el text-dark fw-bold mt-1 d-inline-block">${pQty.toLocaleString('en-US')}</span>
                        ${viewDiffHtml}
                        <input type="number" step="0.01" id="inlineEditQuantity" class="edit-el form-control form-control-sm text-success fw-bold border-success d-none mt-1" value="${pQty}" oninput="calcInlineUsdt()">
                        <div id="inlineEditDiffU" class="edit-el mt-1 fw-semibold d-none" style="font-size: 0.85rem;"></div>
                    </div>
                    <div class="col-md-3">
                        <strong class="text-primary">Min ${fiat}:</strong><br>
                        <span class="view-el text-dark fw-bold mt-1 d-inline-block">${pMin.toLocaleString('en-US')}</span>
                        <input type="number" step="0.01" id="inlineEditMin" class="edit-el form-control form-control-sm border-primary d-none mt-1" value="${pMin}" oninput="calcInlineUsdt()">
                        <div id="inlineEditMinUsdt" class="edit-el text-muted mt-1 fw-bold d-none" style="font-size: 0.8rem;"></div>
                    </div>
                    <div class="col-md-3">
                        <strong class="text-primary">Max ${fiat}:</strong><br>
                        <span class="view-el text-dark fw-bold mt-1 d-inline-block">${pMax.toLocaleString('en-US')}</span>
                        <input type="number" step="0.01" id="inlineEditMax" class="edit-el form-control form-control-sm border-primary d-none mt-1" value="${pMax}" oninput="calcInlineUsdt()">
                        <div id="inlineEditMaxUsdt" class="edit-el text-muted mt-1 fw-bold d-none" style="font-size: 0.8rem;"></div>
                    </div>
                </div>

                <h6 class="fw-bold border-bottom pb-2 text-secondary"><i class="bi bi-shield-check"></i> 2. ĐIỀU KIỆN GIAO DỊCH</h6>
                
                <div class="view-el d-flex flex-wrap gap-2 mb-4 mt-2" style="font-size: 0.9rem;">
                    <div class="border rounded px-2 py-1 bg-light shadow-sm"><span class="text-muted me-1">KYC:</span> ${reqKyc}</div>
                    <div class="border rounded px-2 py-1 bg-light shadow-sm"><span class="text-muted me-1">Liên kết Email:</span> ${reqEmail}</div>
                    <div class="border rounded px-2 py-1 bg-light shadow-sm"><span class="text-muted me-1">Liên kết SĐT:</span> ${reqMobile}</div>
                    <div class="border rounded px-2 py-1 bg-light shadow-sm"><span class="text-muted me-1">Đối tác phải là nhà quảng cáo:</span> ${reqUnpost}</div>
                    <div class="border rounded px-2 py-1 bg-light shadow-sm"><span class="text-muted me-1">Đăng ký tài khoản:</span> ${reqRegTime}</div>
                    <div class="border rounded px-2 py-1 bg-light shadow-sm"><span class="text-muted me-1">Hoàn thành 30 ngày:</span> ${reqOrder30d}</div>
                    <div class="border rounded px-2 py-1 bg-light shadow-sm"><span class="text-muted me-1">Tỉ lệ hoàn thành 30 ngày:</span> ${reqRate30d}</div>
                </div>

                <div class="edit-el row g-2 mb-4 mt-2 align-items-center d-none" style="font-size: 0.9rem;">
                    <div class="col-md-4 mt-2"><div class="form-check form-switch"><input class="form-check-input bg-secondary border-secondary" type="checkbox" ${isKyc==="1"?"checked":""} disabled><label class="form-check-label fw-bold text-muted">Bắt buộc KYC</label></div></div>
                    <div class="col-md-4 mt-2"><div class="form-check form-switch"><input class="form-check-input bg-secondary border-secondary" type="checkbox" ${isEmail==="1"?"checked":""} disabled><label class="form-check-label fw-bold text-muted">Bắt buộc Email</label></div></div>
                    <div class="col-md-4 mt-2"><div class="form-check form-switch"><input class="form-check-input bg-secondary border-secondary" type="checkbox" ${isMobile==="1"?"checked":""} disabled><label class="form-check-label fw-bold text-muted">Bắt buộc Mobile</label></div></div>

                    <div class="col-md-6 mt-3"><div class="form-check form-switch"><input class="form-check-input border-warning" type="checkbox" id="inlineEditUnpost" ${String(tp.hasUnPostAd) === "1" ? "checked" : ""}><label class="form-check-label fw-bold">Đối tác phải là nhà quảng cáo</label></div></div>
                    <div class="col-md-6 mt-3 d-flex align-items-center gap-2"><div class="form-check form-switch"><input class="form-check-input border-warning" type="checkbox" id="inlineEditReg" onchange="document.getElementById('inlineEditRegDay').disabled = !this.checked" ${String(tp.hasRegisterTime) === "1" ? "checked" : ""}><label class="form-check-label fw-bold text-nowrap">Đăng ký tài khoản (Ngày):</label></div>
                        <select class="form-select form-select-sm border-warning fw-bold text-dark w-auto" id="inlineEditRegDay" ${String(tp.hasRegisterTime) !== "1" ? "disabled" : ""}><option value="15" ${tp.registerTimeThreshold == "15" ? "selected" : ""}>15</option><option value="30" ${tp.registerTimeThreshold == "30" ? "selected" : ""}>30</option><option value="90" ${tp.registerTimeThreshold == "90" ? "selected" : ""}>90</option><option value="180" ${tp.registerTimeThreshold == "180" ? "selected" : ""}>180</option></select>
                    </div>
                    <div class="col-md-6 mt-2 d-flex align-items-center gap-2"><div class="form-check form-switch"><input class="form-check-input border-warning" type="checkbox" id="inlineEditOrder" onchange="document.getElementById('inlineEditOrderNum').disabled = !this.checked" ${String(tp.hasOrderFinishNumberDay30) === "1" ? "checked" : ""}><label class="form-check-label fw-bold text-nowrap">Hoàn thành 30 ngày (Đơn):</label></div>
                        <select class="form-select form-select-sm border-warning fw-bold text-dark w-auto" id="inlineEditOrderNum" ${String(tp.hasOrderFinishNumberDay30) !== "1" ? "disabled" : ""}><option value="5" ${tp.orderFinishNumberDay30 == "5" ? "selected" : ""}>5</option><option value="10" ${tp.orderFinishNumberDay30 == "10" ? "selected" : ""}>10</option><option value="40" ${tp.orderFinishNumberDay30 == "40" ? "selected" : ""}>40</option><option value="60" ${tp.orderFinishNumberDay30 == "60" ? "selected" : ""}>60</option></select>
                    </div>
                    <div class="col-md-6 mt-2 d-flex align-items-center gap-2"><div class="form-check form-switch"><input class="form-check-input border-warning" type="checkbox" id="inlineEditRate" onchange="document.getElementById('inlineEditRateNum').disabled = !this.checked" ${String(tp.hasCompleteRateDay30) === "1" ? "checked" : ""}><label class="form-check-label fw-bold text-nowrap">Tỉ lệ HT 30 ngày (%):</label></div>
                        <select class="form-select form-select-sm border-warning fw-bold text-dark w-auto" id="inlineEditRateNum" ${String(tp.hasCompleteRateDay30) !== "1" ? "disabled" : ""}><option value="50" ${tp.completeRateDay30 == "50" ? "selected" : ""}>50%</option><option value="85" ${tp.completeRateDay30 == "85" ? "selected" : ""}>85%</option><option value="90" ${tp.completeRateDay30 == "90" ? "selected" : ""}>90%</option><option value="95" ${tp.completeRateDay30 == "95" ? "selected" : ""}>95%</option></select>
                    </div>
                </div>

                <h6 class="fw-bold border-bottom pb-2 text-success"><i class="bi bi-credit-card"></i> 3. PHƯƠNG THỨC THANH TOÁN</h6>
                <div class="mb-4 mt-2">${paymentsHtml}</div>
                
                <h6 class="fw-bold border-bottom pb-2 text-warning text-dark"><i class="bi bi-chat-text"></i> 4. GHI CHÚ</h6>
                <div class="view-el bg-light border rounded p-3 text-dark mb-2 mt-2" style="font-size: 0.95rem; white-space: pre-wrap;">${data.remark||'Không có ghi chú'}</div>
                <div class="edit-el mb-3 mt-2 d-none">
                    <textarea class="form-control border-warning" id="inlineEditRemark" rows="3">${data.remark||''}</textarea>
                </div>
            </div>`;
            calcInlineUsdt();
        } else {
            contentDiv.innerHTML = `<div class="p-4 text-center"><div class="text-danger fw-bold">Lỗi: ${d.message}</div></div>`;
        }
    });
}

function turnOffAds(type) {
    const group = document.getElementById('groupSelect').value;
    if (!group) {
        showErrorToast("Chưa chọn nhóm!");
        return;
    }

    let typeText = type === 'buy' ? 'MUA' : (type === 'sell' ? 'BÁN' : 'TẤT CẢ (MUA & BÁN)');
    let typeColor = type === 'buy' ? '#198754' : (type === 'sell' ? '#dc3545' : '#212529'); 

    Swal.fire({
        title: `TẮT QUẢNG CÁO ${typeText}?`,
        text: "Hành động này sẽ XÓA tất cả các Quảng Cáo hệ thống đang Online (Không bao gồm QC ngoài lề).",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: typeColor,
        cancelButtonColor: '#6c757d',
        confirmButtonText: 'Đồng ý, Tắt ngay!',
        cancelButtonText: 'Hủy bỏ'
    }).then((result) => {
        if (result.isConfirmed) {
            Toast.fire({ icon: 'info', title: `Đang tắt quảng cáo ${typeText}...` });
            addTerminalLog(`--- GỬI LỆNH TẮT HÀNG LOẠT QUẢNG CÁO [${typeText}] ---`, "warn");

            fetch('/api/turn_off_ads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group: group, type: type })
            }).then(r => r.json()).then(d => {
                if(d.logs) {
                    d.logs.forEach(l => {
                        let t = 'info'; 
                        if(l.toLowerCase().includes('lỗi')||l.toLowerCase().includes('thất bại')) t = 'error'; 
                        else if(l.toLowerCase().includes('thành công')) t = 'success'; 
                        addTerminalLog(l, t); 
                    });
                }
                if (d.status === 'success') {
                    Toast.fire({ icon: 'success', title: `Đã tắt QC ${typeText} thành công!` });
                    loadBuyAdsDashboard(true); // Làm mới lại bảng
                } else {
                    showErrorToast('Lỗi: ' + d.message);
                }
            }).catch(e => {
                showErrorToast('Lỗi mạng: ' + e.message);
                addTerminalLog(`Lỗi gọi API tắt QC: ${e.message}`, "error");
            });
        }
    });
}

// ====== CHỨC NĂNG CHỐNG QUÁ TẢI MUA ======
function toggleAutoStopConfig(isChecked) {
    let config = JSON.parse(localStorage.getItem('autoStopAdsConfig') || '{"perConfigLimit":false, "xValue":3, "globalLimit":false, "yValue":10, "autoResume":false}');
    config.perConfigLimit = isChecked; localStorage.setItem('autoStopAdsConfig', JSON.stringify(config));
    Toast.fire({ icon: isChecked ? 'success' : 'info', title: isChecked ? 'Đã BẬT Giới hạn Cục bộ' : 'Đã TẮT Giới hạn Cục bộ' });
    processAutoStopAds();
}
function updateAutoStopX(val) {
    let config = JSON.parse(localStorage.getItem('autoStopAdsConfig') || '{"perConfigLimit":false, "xValue":3, "globalLimit":false, "yValue":10, "autoResume":false}');
    config.xValue = parseInt(val) || 3; localStorage.setItem('autoStopAdsConfig', JSON.stringify(config));
    processAutoStopAds();
}
function toggleAutoStopGlobal(isChecked) {
    let config = JSON.parse(localStorage.getItem('autoStopAdsConfig') || '{"perConfigLimit":false, "xValue":3, "globalLimit":false, "yValue":10, "autoResume":false}');
    config.globalLimit = isChecked; localStorage.setItem('autoStopAdsConfig', JSON.stringify(config));
    Toast.fire({ icon: isChecked ? 'success' : 'info', title: isChecked ? 'Đã BẬT Giới hạn Toàn cục' : 'Đã TẮT Giới hạn Toàn cục' });
    processAutoStopAds();
}
function updateAutoStopY(val) {
    let config = JSON.parse(localStorage.getItem('autoStopAdsConfig') || '{"perConfigLimit":false, "xValue":3, "globalLimit":false, "yValue":10, "autoResume":false}');
    config.yValue = parseInt(val) || 10; localStorage.setItem('autoStopAdsConfig', JSON.stringify(config));
    processAutoStopAds();
}
function toggleAutoResume(isChecked) {
    let config = JSON.parse(localStorage.getItem('autoStopAdsConfig') || '{"perConfigLimit":false, "xValue":3, "globalLimit":false, "yValue":10, "autoResume":false}');
    config.autoResume = isChecked; localStorage.setItem('autoStopAdsConfig', JSON.stringify(config));
    Toast.fire({ icon: isChecked ? 'success' : 'info', title: isChecked ? 'Đã BẬT Tự tạo lại QC Mua' : 'Đã TẮT Tự tạo lại QC Mua' });
    processAutoStopAds();
}

// ====== CẤU HÌNH CẮT LÃI ĐA CẤP ======
function getAutoReduceConfig() {
    let cfg = JSON.parse(localStorage.getItem('autoReduceProfitConfig') || '{}');
    if (cfg.xMinutes !== undefined) { // Convert từ bản cũ sang bản mới
        cfg = { enabled: cfg.enabled||false, levelsCount: 1, levels: [{minutes: cfg.xMinutes, percent: cfg.yPercent}, {minutes: 10, percent: 30}, {minutes: 15, percent: 10}] };
    }
    if (!cfg.levels) cfg = { enabled: false, levelsCount: 1, levels: [{minutes: 5, percent: 50}, {minutes: 10, percent: 30}, {minutes: 15, percent: 10}] };
    return cfg;
}
function toggleAutoReduceProfit(isChecked) {
    let cfg = getAutoReduceConfig(); cfg.enabled = isChecked; localStorage.setItem('autoReduceProfitConfig', JSON.stringify(cfg));
    Toast.fire({ icon: isChecked ? 'success' : 'info', title: isChecked ? 'Đã BẬT Tự động cắt lãi' : 'Đã TẮT Tự động cắt lãi' });
}
function updateAutoReduceLevelsCount(val) {
    let cfg = getAutoReduceConfig(); cfg.levelsCount = parseInt(val) || 1; localStorage.setItem('autoReduceProfitConfig', JSON.stringify(cfg));
    for (let i=0; i<3; i++) {
        let el = document.getElementById('reduceLevelRow_'+i);
        if (el) el.style.display = (i < cfg.levelsCount) ? 'block' : 'none';
    }
}
function updateAutoReduceLevel(idx, field, val) {
    let cfg = getAutoReduceConfig();
    if(field === 'min') cfg.levels[idx].minutes = parseInt(val) || 0;
    if(field === 'pct') cfg.levels[idx].percent = parseInt(val) || 0;
    localStorage.setItem('autoReduceProfitConfig', JSON.stringify(cfg));
}
// =====================================

let isGlobalCancelling = false; // Biến khóa chống spam API gọi tắt nhiều lần
let isAutoCreatingBuyAd = new Set(); // Chống spam tạo QC Mua liên tục

// ====== CHỨC NĂNG CHỐNG QUÁ TẢI MUA ======
function processAutoStopAds() {
    let config = JSON.parse(localStorage.getItem('autoStopAdsConfig') || '{"perConfigLimit":false, "xValue":3, "globalLimit":false, "yValue":10, "autoResume":false}');
    if (!config.perConfigLimit && !config.globalLimit && !config.autoResume) return;
    
    const group = document.getElementById('groupSelect').value;
    if (!group) return;

    // Lọc ra CÁC ĐƠN MUA ĐANG PENDING
    const allOrders = [...Object.values(globalActiveOrders), ...Object.values(globalArchivingOrders)];
    let pendingBuyOrders = allOrders.filter(po => String(po.side) === '0' && String(po.status) !== '40' && String(po.status) !== '80' && String(po.status) !== '50');

    // 1. KIỂM TRA TOÀN CỤC
    if (config.globalLimit && pendingBuyOrders.length >= config.yValue) {
        let hasOnlineBuyAds = globalAllAds.some(ad => String(ad.status) === '10' && String(ad.side) === '0');
        if (hasOnlineBuyAds && !isGlobalCancelling) {
            isGlobalCancelling = true;
            addTerminalLog(`[CHỐNG-QUÁ-TẢI] TỔNG ĐƠN MUA đạt ${pendingBuyOrders.length}/${config.yValue}. Đang TẮT TOÀN BỘ QC MUA!`, 'error');
            
            let configsToPause = new Set();
            latestConfigs.forEach(cfg => {
                // TẠO KEY ĐỊNH DANH DUY NHẤT BAO GỒM CẢ FIAT VÀ PTTT
                let cfgKey = cfg.fiat.toUpperCase() + '_' + cfg.payments_active.join(',');
                let hasAd = globalAllAds.some(ad => 
                    String(ad.status) === '10' && String(ad.side) === '0' && 
                    (ad.currencyId || '').toUpperCase() === cfg.fiat.toUpperCase() &&
                    (ad.mapped_payments_str ? ad.mapped_payments_str.split(',').some(p => cfg.payments_active.includes(p.trim())) : true)
                );
                if(hasAd) configsToPause.add(cfgKey);
            });

            fetch('/api/turn_off_ads', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group: group, type: 'buy' })
            }).then(r => r.json()).then(d => {
                isGlobalCancelling = false;
                if(d.status === 'success') {
                    addTerminalLog(`✅ Đã tắt toàn bộ QC Mua thành công (Global Limit)`, 'success');
                    // Lưu Key định danh vào bộ nhớ
                    let currentPaused = new Set(JSON.parse(localStorage.getItem('overloadPausedConfigs') || '[]'));
                    configsToPause.forEach(f => currentPaused.add(f));
                    localStorage.setItem('overloadPausedConfigs', JSON.stringify([...currentPaused]));
                    loadBuyAdsDashboard(true);
                }
            }).catch(e => { isGlobalCancelling = false; });
        }
        return; // Quá tải toàn cục thì không cần xét tiếp cục bộ
    }

    // 2. KIỂM TRA CỤC BỘ & TỰ ĐỘNG TẠO LẠI
    latestConfigs.forEach(cfg => {
        // TẠO KEY ĐỊNH DANH DUY NHẤT CHO TỪNG CẤU HÌNH
        let cfgKey = cfg.fiat.toUpperCase() + '_' + cfg.payments_active.join(',');
        
        let matchedPending = pendingBuyOrders.filter(po => 
            (po.currencyId || '').toUpperCase() === cfg.fiat.toUpperCase() && 
            cfg.payments_active.includes(po.payment_method_name)
        );

        let isConfigOverloaded = config.perConfigLimit && matchedPending.length >= config.xValue;
        
        // --- NẾU ĐANG BỊ QUÁ TẢI CỤC BỘ ---
        if (isConfigOverloaded) {
            let matchedAds = globalAllAds.filter(ad => 
                String(ad.status) === '10' && String(ad.side) === '0' && 
                (ad.currencyId || '').toUpperCase() === cfg.fiat.toUpperCase() && 
                (ad.mapped_payments_str ? ad.mapped_payments_str.split(',').some(p => cfg.payments_active.includes(p.trim())) : true)
            );

            if (matchedAds.length > 0) {
                matchedAds.forEach(ad => {
                    let adId = String(ad.id);
                    if (!cancellingSellAds.has(adId)) {
                        cancellingSellAds.add(adId);
                        addTerminalLog(`[CHỐNG-QUÁ-TẢI] Cấu hình ${cfg.fiat} đạt ${matchedPending.length}/${config.xValue} đơn. Tự động tắt QC ${adId}`, 'warn');
                        
                        fetch('/api/cancel_ad', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ group: group, email: ad.account_email || ad.account, item_id: adId })
                        }).then(r => r.json()).then(d => {
                            if(d.status === 'success') {
                                addTerminalLog(`✅ Đã tắt QC Mua ${adId} (Cục bộ)`, 'success');
                                // Lưu Key định danh vào bộ nhớ để nhớ khôi phục
                                let currentPaused = new Set(JSON.parse(localStorage.getItem('overloadPausedConfigs') || '[]'));
                                currentPaused.add(cfgKey);
                                localStorage.setItem('overloadPausedConfigs', JSON.stringify([...currentPaused]));
                                loadBuyAdsDashboard(true);
                            } else {
                                cancellingSellAds.delete(adId);
                            }
                        }).catch(e => { cancellingSellAds.delete(adId); });
                    }
                });
            }
        } 
        // --- NẾU HẾT QUÁ TẢI & TÍNH NĂNG KHÔI PHỤC ĐƯỢC BẬT ---
        else {
            if (config.autoResume) {
                let currentPaused = new Set(JSON.parse(localStorage.getItem('overloadPausedConfigs') || '[]'));
                // Kiểm tra theo Key định danh thay vì tên Fiat
                if (currentPaused.has(cfgKey)) {
                    // Cải tiến: Check thêm cả PTTT để không bị nhầm QC của cấu hình khác
                    let hasOnlineBuyAds = globalAllAds.some(ad => 
                        String(ad.status) === '10' && String(ad.side) === '0' && 
                        (ad.currencyId || '').toUpperCase() === cfg.fiat.toUpperCase() &&
                        (ad.mapped_payments_str ? ad.mapped_payments_str.split(',').some(p => cfg.payments_active.includes(p.trim())) : true)
                    );

                    if (!hasOnlineBuyAds && !isAutoCreatingBuyAd.has(cfgKey)) {
                        isAutoCreatingBuyAd.add(cfgKey);
                        let rawPtttStr = cfg.payments_active.join(',');
                        
                        // --- CƠ CHẾ XẾP HÀNG (STAGGERING) CHỐNG CHẾT SERVER ---
                        window.autoResumeQueueCounter = window.autoResumeQueueCounter || 0;
                        let currentDelay = window.autoResumeQueueCounter * 3000; // Mỗi cấu hình cách nhau 3 giây
                        window.autoResumeQueueCounter++;
                        
                        setTimeout(() => {
                            // Chạy xong thì giảm số người xếp hàng đi
                            window.autoResumeQueueCounter = Math.max(0, window.autoResumeQueueCounter - 1);
                            
                            addTerminalLog(`[AUTO-RESUME] Cấu hình ${cfg.fiat} (${rawPtttStr}) đã hết quá tải (${matchedPending.length} đơn). Đang tự động TẠO LẠI QC Mua!`, 'info');
                            
                            currentPaused.delete(cfgKey);
                            localStorage.setItem('overloadPausedConfigs', JSON.stringify([...currentPaused]));

                            fetch('/api/auto_create_ad', {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ group: group, fiat: cfg.fiat, pttt_str: rawPtttStr })
                            }).then(r => r.json()).then(d => {
                                isAutoCreatingBuyAd.delete(cfgKey);
                                if(d.logs) d.logs.forEach(l => { 
                                    let t = 'info'; if(l.toLowerCase().includes('lỗi')||l.toLowerCase().includes('thất bại')) t = 'error'; else if(l.toLowerCase().includes('thành công')) t = 'success'; addTerminalLog(l, t); 
                                }); 
                                if (d.status === 'success') {
                                    Toast.fire({ icon: 'success', title: `Đã khôi phục QC Mua ${cfg.fiat}!` });
                                    loadBuyAdsDashboard(true);
                                }
                            }).catch(e => { 
                                isAutoCreatingBuyAd.delete(cfgKey); 
                                addTerminalLog(`[AUTO-RESUME] Lỗi mạng khi tạo QC ${cfg.fiat}: ${e.message}`, 'error');
                            });
                        }, currentDelay);
                    } else if (hasOnlineBuyAds) {
                        currentPaused.delete(cfgKey);
                        localStorage.setItem('overloadPausedConfigs', JSON.stringify([...currentPaused]));
                    }
                }
            }
        }
    });
}
// ==========================================
// ====== HÀM TẠO GIÁ UNIQUE (Tránh trùng lặp giá dẫn đến lỗi Bybit) ======
function getUniquePrice(targetPriceNum, accountEmail, side, fiat, decimalPlaces, currentAdId = null) {
    let usedPrices = new Set();
    
    // 1. Lấy giá từ các QC đang có trên bảng
    globalAllAds.forEach(ad => {
        if (ad.account_email === accountEmail && String(ad.side) === String(side) && (ad.currencyId || '').toUpperCase() === fiat.toUpperCase()) {
            if (currentAdId && String(ad.id) === String(currentAdId)) return; // Bỏ qua chính nó
            usedPrices.add(Number(ad.price));
        }
    });

    // 2. Lấy giá từ các QC vừa được lệnh tạo/update (chưa kịp đồng bộ API lên bảng)
    if (window.recentlyAssignedPrices) {
        window.recentlyAssignedPrices.forEach(key => {
            let parts = key.split('_');
            if (parts[0] === accountEmail && parts[1] === String(side) && parts[2] === fiat.toUpperCase()) {
                // CHẶN LOOP: Nếu giá trong bộ nhớ đệm là của chính cái QC này vừa được cấp, thì bỏ qua không đưa vào danh sách trùng
                if (currentAdId && parts[4] === String(currentAdId)) return; 
                usedPrices.add(Number(parts[3]));
            }
        });
    }

    let step = Math.pow(10, -decimalPlaces);
    if (step >= 1) step = 0.01; 

    let newPrice = targetPriceNum;
    let isUp = true;
    let multiplier = 1;

    // Nếu giá đã bị trùng, tiến hành cộng/trừ ngẫu nhiên từng đơn vị nhỏ nhất (+1, -1, +2, -2...)
    while (usedPrices.has(Number(newPrice.toFixed(decimalPlaces)))) {
        let offset = (isUp ? 1 : -1) * Math.ceil(multiplier / 2) * step;
        newPrice = targetPriceNum + offset;
        isUp = !isUp;
        multiplier++;
        if (multiplier > 50) break; // Tránh lặp vô hạn
    }
    
    let finalPrice = Number(newPrice.toFixed(decimalPlaces));
    
    // Lưu lại vào cache tạm thời để các đơn sau trong cùng 1 nhịp chạy không bị trùng
    // CẢI TIẾN: Lưu thêm cái ID của QC vào đuôi để nhận diện
    window.recentlyAssignedPrices = window.recentlyAssignedPrices || new Set();
    window.recentlyAssignedPrices.add(`${accountEmail}_${side}_${fiat.toUpperCase()}_${finalPrice}_${currentAdId || 'new'}`);
    
    return finalPrice;
}
