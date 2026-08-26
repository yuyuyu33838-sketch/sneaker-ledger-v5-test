(() => {
'use strict';

const CFG = window.SNEAKER_V6_CONFIG;
if (!CFG?.supabaseUrl || !CFG?.publishableKey) throw new Error('V6 配置缺失');

const $ = id => document.getElementById(id);
const SESSION_KEY = 'slv6_session';
const DEVICE_KEY = 'slv6_device_id';
const DEST_KEY = 'slv6_destination_id';
const OUTBOX_KEY = 'slv6_outbox';
const ACCOUNT_KEY_PREFIX = 'slv6_account_';

const state = {
  session: null,
  userId: '',
  devices: [], accounts: [], deviceAccounts: [], destinations: [], products: [], purchases: [],
  currentDeviceId: localStorage.getItem(DEVICE_KEY) || '',
  selectedProductId: '',
  selectedVariant: '',
  loading: false
};

function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function money(n) { return '¥' + Number(n || 0).toLocaleString('zh-CN', {minimumFractionDigits:2, maximumFractionDigits:2}); }
function qty(n) { const x = Number(n || 0); return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/,'').replace(/\.$/,''); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
function notify(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(notify.timer); notify.timer = setTimeout(() => t.classList.remove('show'), 2400); }
function platformName(v) { return v === 'jd' ? '京东' : '淘宝'; }
function formatTime(v) { try { return new Date(v).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); } catch { return v || ''; } }
function getOutbox() { try { const v = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function setOutbox(v) { localStorage.setItem(OUTBOX_KEY, JSON.stringify(v)); renderSyncBadge(); }
function currentDevice() { return state.devices.find(x => x.id === state.currentDeviceId) || null; }
function currentAccountIdKey() { return ACCOUNT_KEY_PREFIX + (state.currentDeviceId || 'none'); }
function currentAccountId() { return $('currentAccount')?.value || localStorage.getItem(currentAccountIdKey()) || ''; }
function productById(id) { return state.products.find(x => x.id === id); }
function accountById(id) { return state.accounts.find(x => x.id === id); }
function destinationById(id) { return state.destinations.find(x => x.id === id); }

function decodeJwtSub(token) {
  try {
    const raw = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
    return JSON.parse(decodeURIComponent(Array.from(atob(padded)).map(c => '%' + c.charCodeAt(0).toString(16).padStart(2,'0')).join(''))).sub || '';
  } catch { return ''; }
}

function saveSession(s) {
  state.session = s || null;
  state.userId = s?.user?.id || decodeJwtSub(s?.access_token || '') || '';
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY);
}

function loadStoredSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (s?.access_token && s?.refresh_token) saveSession(s);
  } catch { saveSession(null); }
}

async function authRequest(path, body) {
  const res = await fetch(CFG.supabaseUrl + path, {
    method: 'POST',
    headers: {'apikey': CFG.publishableKey, 'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.error_description || data.message || `认证失败 ${res.status}`);
  return data;
}

async function refreshSession() {
  if (!state.session?.refresh_token) throw new Error('登录已失效');
  const data = await authRequest('/auth/v1/token?grant_type=refresh_token', {refresh_token: state.session.refresh_token});
  saveSession({...data, user: data.user || state.session.user});
  return true;
}

async function api(path, options = {}, retried = false) {
  if (!state.session?.access_token) throw new Error('请先登录');
  const headers = {
    'apikey': CFG.publishableKey,
    'Authorization': `Bearer ${state.session.access_token}`,
    ...(options.headers || {})
  };
  const res = await fetch(CFG.supabaseUrl + '/rest/v1/' + path, {...options, headers});
  if (res.status === 401 && !retried) {
    await refreshSession();
    return api(path, options, true);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || data.hint || `数据库请求失败 ${res.status}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function userFilter(extra = '') {
  return `owner_id=eq.${encodeURIComponent(state.userId)}${extra ? '&' + extra : ''}`;
}

async function selectRows(table, extra = '') {
  return api(`${table}?select=*&${userFilter(extra)}`);
}

async function insertRow(table, row, {ignoreDuplicates = false} = {}) {
  const suffix = ignoreDuplicates ? '?on_conflict=id' : '';
  const prefer = ignoreDuplicates ? 'resolution=ignore-duplicates,return=representation' : 'return=representation';
  const result = await api(`${table}${suffix}`, {
    method:'POST',
    headers:{'Content-Type':'application/json','Prefer':prefer},
    body:JSON.stringify(row)
  });
  return Array.isArray(result) ? result[0] : result;
}

async function deleteRows(table, filters) {
  await api(`${table}?${userFilter(filters)}`, {method:'DELETE', headers:{'Prefer':'return=minimal'}});
}

async function loadAllData({quiet = false} = {}) {
  if (!state.userId || state.loading) return;
  state.loading = true;
  try {
    const [devices, accounts, deviceAccounts, destinations, products, purchases] = await Promise.all([
      selectRows('devices', 'order=code.asc'),
      selectRows('accounts', 'order=created_at.asc'),
      selectRows('device_accounts', 'order=created_at.asc'),
      selectRows('destinations', 'order=sort_order.asc,created_at.asc'),
      selectRows('products', 'order=created_at.desc'),
      selectRows('purchases', 'order=purchased_at.desc&limit=500')
    ]);
    state.devices = devices || [];
    state.accounts = accounts || [];
    state.deviceAccounts = deviceAccounts || [];
    state.destinations = destinations || [];
    state.products = products || [];
    state.purchases = purchases || [];
    if (state.currentDeviceId && !state.devices.some(d => d.id === state.currentDeviceId)) {
      state.currentDeviceId = '';
      localStorage.removeItem(DEVICE_KEY);
    }
    renderAll();
    await flushOutbox();
    if (!quiet) notify('数据已刷新');
  } catch (e) {
    notify(e.message || '加载失败');
  } finally { state.loading = false; }
}

async function flushOutbox() {
  if (!navigator.onLine || !state.userId) return;
  const box = getOutbox();
  if (!box.length) return;
  const keep = [];
  let synced = 0;
  for (const row of box) {
    try {
      await api('purchases?on_conflict=id', {
        method:'POST',
        headers:{'Content-Type':'application/json','Prefer':'resolution=ignore-duplicates,return=minimal'},
        body:JSON.stringify(row)
      });
      synced++;
      if (!state.purchases.some(p => p.id === row.id)) state.purchases.unshift(row);
    } catch {
      keep.push(row);
    }
  }
  setOutbox(keep);
  renderPurchases();
  if (synced) notify(`已同步 ${synced} 笔离线采购`);
}

function renderNetwork() {
  const el = $('networkBadge');
  if (navigator.onLine) { el.textContent = '在线'; el.classList.remove('offline'); }
  else { el.textContent = '离线'; el.classList.add('offline'); }
}
function renderSyncBadge() { $('syncBadge').textContent = `待同步 ${getOutbox().length}`; }

function boundAccountIds() {
  if (!state.currentDeviceId) return [];
  return state.deviceAccounts.filter(x => x.device_id === state.currentDeviceId).map(x => x.account_id);
}
function boundAccounts() {
  const ids = new Set(boundAccountIds());
  return state.accounts.filter(a => a.is_active && ids.has(a.id));
}

function fillSelect(el, rows, labelFn, placeholder, selected) {
  const old = selected ?? el.value;
  el.innerHTML = `<option value="">${esc(placeholder)}</option>` + rows.map(x => `<option value="${esc(x.id)}">${esc(labelFn(x))}</option>`).join('');
  if (rows.some(x => x.id === old)) el.value = old;
}

function renderAll() {
  const dev = currentDevice();
  $('deviceBadge').textContent = dev ? `${dev.code}${dev.name ? ' · ' + dev.name : ''}` : '未绑定设备';
  $('currentDeviceText').textContent = dev ? `${dev.code}${dev.name ? ' · ' + dev.name : ''}` : '未设置';
  $('setupWarning').classList.toggle('hidden', !!dev);
  $('savePurchase').disabled = !dev;
  $('userEmailText').textContent = state.session?.user?.email || '已登录';

  fillSelect($('deviceSelect'), state.devices.filter(d => d.is_active), d => `${d.code}${d.name ? ' · ' + d.name : ''}`, '请选择', state.currentDeviceId);

  const bound = boundAccounts();
  const savedAccount = localStorage.getItem(currentAccountIdKey()) || '';
  fillSelect($('currentAccount'), bound, a => `${platformName(a.platform)} · ${a.nickname}`, '先选择账号', savedAccount);
  fillSelect($('currentDestination'), state.destinations.filter(d => d.is_active), d => d.name, '未指定', localStorage.getItem(DEST_KEY) || '');
  fillSelect($('ledgerAccount'), state.accounts.filter(a => a.is_active), a => `${platformName(a.platform)} · ${a.nickname}`, '全部账号');
  fillSelect($('ledgerProduct'), state.products.filter(p => p.is_active), p => `${p.shortcut ? p.shortcut + ' · ' : ''}${p.sku} · ${p.name}`, '全部商品');

  renderManagement();
  renderSelectedProduct();
  renderPurchases();
  renderSyncBadge();
}

function renderManagement() {
  $('accountCount').textContent = `${state.accounts.length} 个`;
  $('destinationCount').textContent = `${state.destinations.length} 个`;
  $('productCount').textContent = `${state.products.length} 个`;

  const bound = new Set(boundAccountIds());
  const accountList = $('accountList');
  if (!state.accounts.length) { accountList.className = 'manage-list empty'; accountList.textContent = '还没有账号'; }
  else {
    accountList.className = 'manage-list';
    accountList.innerHTML = state.accounts.map(a => `<div class="manage-row"><div><b>${esc(platformName(a.platform))} · ${esc(a.nickname)}</b><small>${bound.has(a.id) ? '已绑定当前设备' : '未绑定当前设备'}</small></div><div class="manage-row-actions">${state.currentDeviceId ? `<button class="tiny-btn ${bound.has(a.id) ? 'active' : ''}" data-bind-account="${a.id}" type="button">${bound.has(a.id) ? '解绑' : '绑定'}</button>` : ''}</div></div>`).join('');
    accountList.querySelectorAll('[data-bind-account]').forEach(btn => btn.onclick = () => toggleAccountBinding(btn.dataset.bindAccount));
  }

  const dl = $('destinationList');
  if (!state.destinations.length) { dl.className = 'manage-list empty'; dl.textContent = '还没有收货地'; }
  else { dl.className = 'manage-list'; dl.innerHTML = state.destinations.map(d => `<div class="manage-row"><div><b>${esc(d.name)}</b><small>${esc(d.code)}</small></div></div>`).join(''); }

  const pl = $('productList');
  if (!state.products.length) { pl.className = 'manage-list empty'; pl.textContent = '还没有商品'; }
  else {
    pl.className = 'manage-list';
    pl.innerHTML = state.products.slice(0,30).map(p => `<div class="manage-row"><div><b>${esc(p.shortcut ? p.shortcut + ' · ' : '')}${esc(p.sku)}</b><small>${esc(p.brand || '')}${p.brand ? ' · ' : ''}${esc(p.name)}${p.variants?.length ? ' · ' + esc(p.variants.join('/')) : ''}</small></div></div>`).join('');
  }
}

function renderSelectedProduct() {
  const p = productById(state.selectedProductId);
  const box = $('selectedProduct');
  const vb = $('variantButtons');
  if (!p) {
    box.classList.add('hidden');
    vb.innerHTML = '';
    $('manualVariant').classList.remove('hidden');
    return;
  }
  box.innerHTML = `<b>${esc(p.name)}</b><small>${esc(p.shortcut ? p.shortcut + ' · ' : '')}${esc(p.sku)}${p.brand ? ' · ' + esc(p.brand) : ''}</small>`;
  box.classList.remove('hidden');
  const vars = Array.isArray(p.variants) ? p.variants.filter(Boolean) : [];
  vb.innerHTML = vars.map(v => `<button data-variant="${encodeURIComponent(v)}" class="${state.selectedVariant === v ? 'active' : ''}" type="button">${esc(v)}</button>`).join('');
  vb.querySelectorAll('[data-variant]').forEach(btn => btn.onclick = () => {
    state.selectedVariant = decodeURIComponent(btn.dataset.variant);
    $('manualVariant').value = '';
    renderSelectedProduct();
  });
  $('manualVariant').classList.toggle('hidden', vars.length > 0);
}

function combinedPurchases() {
  const pending = getOutbox().map(x => ({...x, _pending:true}));
  const ids = new Set(state.purchases.map(x => x.id));
  return [...pending.filter(x => !ids.has(x.id)), ...state.purchases].sort((a,b) => String(b.purchased_at).localeCompare(String(a.purchased_at)));
}

function purchaseHtml(p) {
  const product = productById(p.product_id) || {name:'未知商品', sku:'—'};
  const account = accountById(p.account_id) || {platform:'', nickname:'未知账号'};
  const destination = destinationById(p.destination_id);
  const per = Number(p.quantity) ? Number(p.total_paid) / Number(p.quantity) : 0;
  const status = p.status === 'cancelled' ? '已取消' : p.status === 'refunded' ? '已退款' : p.status === 'refund_pending' ? '退款中' : p.status === 'received' ? '已到货' : '已下单';
  return `<div class="record ${['cancelled','refunded'].includes(p.status) ? 'cancelled' : ''}"><div class="record-main"><b>${esc(product.name)} · ${esc(p.variant || '默认规格')} ×${qty(p.quantity)}</b><small>${esc(product.sku)} · ${esc(platformName(account.platform))} · ${esc(account.nickname)}${destination ? ' · ' + esc(destination.name) : ''}<br>${esc(formatTime(p.purchased_at))} · ${esc(status)}${p._pending ? ' · <span class="pending-tag">待同步</span>' : ''}</small></div><div class="record-side"><b>${money(p.total_paid)}</b><small>均 ${money(per)}</small></div></div>`;
}

function renderPurchases() {
  const all = combinedPurchases();
  const recent = $('recentPurchases');
  if (!all.length) { recent.className = 'record-list empty'; recent.textContent = '还没有采购记录'; }
  else { recent.className = 'record-list'; recent.innerHTML = all.slice(0,7).map(purchaseHtml).join(''); }

  const aid = $('ledgerAccount').value;
  const pid = $('ledgerProduct').value;
  const filtered = all.filter(p => (!aid || p.account_id === aid) && (!pid || p.product_id === pid));
  const effective = filtered.filter(p => !['cancelled','refunded'].includes(p.status));
  $('ledgerQty').textContent = qty(effective.reduce((a,p) => a + Number(p.quantity || 0), 0));
  $('ledgerPaid').textContent = money(effective.reduce((a,p) => a + Number(p.total_paid || 0), 0));
  $('ledgerCount').textContent = String(filtered.length);
  const list = $('ledgerList');
  if (!filtered.length) { list.className = 'record-list empty'; list.textContent = '暂无数据'; }
  else { list.className = 'record-list'; list.innerHTML = filtered.map(purchaseHtml).join(''); }
}

function selectProduct(p) {
  state.selectedProductId = p.id;
  state.selectedVariant = '';
  $('productSearch').value = p.shortcut || p.sku;
  $('productSuggestions').classList.add('hidden');
  $('manualVariant').value = '';
  renderSelectedProduct();
}

function updateProductSuggestions() {
  const q = $('productSearch').value.trim().toLowerCase();
  const sug = $('productSuggestions');
  if (!q) { sug.classList.add('hidden'); return; }
  const matches = state.products.filter(p => p.is_active && `${p.shortcut || ''} ${p.sku} ${p.name} ${p.brand || ''}`.toLowerCase().includes(q)).slice(0,6);
  const exact = state.products.find(p => p.is_active && [p.shortcut || '', p.sku].some(v => v.toLowerCase() === q));
  if (exact) { selectProduct(exact); return; }
  if (!matches.length) { sug.classList.add('hidden'); return; }
  sug.innerHTML = matches.map(p => `<button type="button" data-product="${p.id}"><b>${esc(p.shortcut ? p.shortcut + ' · ' : '')}${esc(p.sku)}</b><small>${esc(p.brand || '')}${p.brand ? ' · ' : ''}${esc(p.name)}</small></button>`).join('');
  sug.classList.remove('hidden');
  sug.querySelectorAll('[data-product]').forEach(btn => btn.onclick = () => selectProduct(productById(btn.dataset.product)));
}

async function savePurchase() {
  const device = currentDevice();
  if (!device) return notify('先设置当前设备');
  const accountId = $('currentAccount').value;
  if (!accountId) return notify('请选择当前账号');
  const product = productById(state.selectedProductId);
  if (!product) return notify('请选择商品');
  const variant = (state.selectedVariant || $('manualVariant').value.trim()).slice(0,100);
  const quantity = Number($('purchaseQty').value);
  const totalPaid = Number($('purchasePaid').value);
  if (!Number.isFinite(quantity) || quantity <= 0) return notify('数量不正确');
  if (!Number.isFinite(totalPaid) || totalPaid < 0) return notify('请输入实付金额');

  const row = {
    id: uuid(), owner_id: state.userId, account_id: accountId, device_id: device.id,
    product_id: product.id, destination_id: $('currentDestination').value || null,
    variant, quantity, total_paid: totalPaid, status:'ordered', purchased_at:new Date().toISOString()
  };

  localStorage.setItem(currentAccountIdKey(), accountId);
  if ($('currentDestination').value) localStorage.setItem(DEST_KEY, $('currentDestination').value); else localStorage.removeItem(DEST_KEY);

  try {
    if (!navigator.onLine) throw new Error('offline');
    await api('purchases?on_conflict=id', {
      method:'POST',
      headers:{'Content-Type':'application/json','Prefer':'resolution=ignore-duplicates,return=minimal'},
      body:JSON.stringify(row)
    });
    state.purchases.unshift(row);
    notify('采购已保存');
  } catch {
    const box = getOutbox();
    if (!box.some(x => x.id === row.id)) box.push(row);
    setOutbox(box);
    notify('网络异常，已放入本地待同步');
  }

  state.selectedVariant = '';
  $('manualVariant').value = '';
  $('purchasePaid').value = '';
  $('purchaseQty').value = '1';
  renderSelectedProduct();
  renderPurchases();
  $('purchasePaid').focus();
}

async function addDevice() {
  const code = $('newDeviceCode').value.trim().toUpperCase();
  const name = $('newDeviceName').value.trim();
  if (!code) return notify('请输入设备编号');
  try {
    const row = await insertRow('devices', {owner_id:state.userId, code, name:name || null});
    state.devices.push(row);
    state.currentDeviceId = row.id;
    localStorage.setItem(DEVICE_KEY, row.id);
    $('newDeviceCode').value = '';
    $('newDeviceName').value = '';
    renderAll();
    notify(`已创建并切换到 ${code}`);
  } catch(e) { notify(e.message); }
}

async function addAccount() {
  const platform = $('newAccountPlatform').value;
  const nickname = $('newAccountName').value.trim();
  if (!nickname) return notify('请输入账号昵称');
  try {
    const row = await insertRow('accounts', {owner_id:state.userId, platform, nickname});
    state.accounts.push(row);
    $('newAccountName').value = '';
    if (state.currentDeviceId) {
      try {
        const bind = {owner_id:state.userId, device_id:state.currentDeviceId, account_id:row.id};
        await api('device_accounts', {method:'POST', headers:{'Content-Type':'application/json','Prefer':'return=minimal'}, body:JSON.stringify(bind)});
        state.deviceAccounts.push(bind);
      } catch {}
    }
    renderAll();
    notify('账号已新增' + (state.currentDeviceId ? '并绑定当前设备' : ''));
  } catch(e) { notify(e.message); }
}

async function toggleAccountBinding(accountId) {
  if (!state.currentDeviceId) return notify('先选择当前设备');
  const exists = state.deviceAccounts.some(x => x.device_id === state.currentDeviceId && x.account_id === accountId);
  try {
    if (exists) {
      await deleteRows('device_accounts', `device_id=eq.${encodeURIComponent(state.currentDeviceId)}&account_id=eq.${encodeURIComponent(accountId)}`);
      state.deviceAccounts = state.deviceAccounts.filter(x => !(x.device_id === state.currentDeviceId && x.account_id === accountId));
      if (localStorage.getItem(currentAccountIdKey()) === accountId) localStorage.removeItem(currentAccountIdKey());
      notify('已解绑');
    } else {
      const row = {owner_id:state.userId, device_id:state.currentDeviceId, account_id:accountId};
      await api('device_accounts', {method:'POST',headers:{'Content-Type':'application/json','Prefer':'return=minimal'},body:JSON.stringify(row)});
      state.deviceAccounts.push(row);
      notify('已绑定');
    }
    renderAll();
  } catch(e) { notify(e.message); }
}

async function addDestination() {
  const code = $('newDestinationCode').value.trim().toUpperCase();
  const name = $('newDestinationName').value.trim();
  if (!code || !name) return notify('请输入地点代号和名称');
  try {
    const row = await insertRow('destinations', {owner_id:state.userId, code, name, sort_order:state.destinations.length});
    state.destinations.push(row);
    $('newDestinationCode').value = '';
    $('newDestinationName').value = '';
    renderAll(); notify('地点已新增');
  } catch(e) { notify(e.message); }
}

async function addProduct() {
  const sku = $('newProductSku').value.trim().toUpperCase();
  const shortcut = $('newProductShortcut').value.trim();
  const brand = $('newProductBrand').value.trim();
  const name = $('newProductName').value.trim();
  const variants = $('newProductVariants').value.split(/[,，]/).map(x => x.trim()).filter(Boolean).slice(0,50);
  if (!sku || !name) return notify('货号和商品名称必填');
  try {
    const row = await insertRow('products', {owner_id:state.userId, sku, shortcut:shortcut || null, brand:brand || null, name, variants});
    state.products.unshift(row);
    ['newProductSku','newProductShortcut','newProductBrand','newProductName','newProductVariants'].forEach(id => $(id).value='');
    renderAll(); notify('商品已加入字典');
  } catch(e) { notify(e.message); }
}

function showPage(name) {
  const map = {quick:'quickPage',ledger:'ledgerPage',manage:'managePage'};
  Object.values(map).forEach(id => $(id).classList.remove('active'));
  $(map[name] || map.quick).classList.add('active');
  document.querySelectorAll('.bottom-nav [data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  if (name === 'ledger') renderPurchases();
  window.scrollTo({top:0,behavior:'smooth'});
}

async function signIn(email, password) {
  const data = await authRequest('/auth/v1/token?grant_type=password', {email, password});
  saveSession(data);
  enterApp();
  await loadAllData({quiet:true});
  notify('登录成功');
}

async function signUp(email, password) {
  const data = await authRequest('/auth/v1/signup', {email, password});
  if (data.access_token) {
    saveSession(data); enterApp(); await loadAllData({quiet:true}); notify('V6 账号已创建');
  } else {
    $('authHint').textContent = '注册请求已提交。请检查邮箱完成确认；确认后回到这里登录。测试阶段若确认后跳转页面打不开，账号通常仍已完成确认。';
    notify('请检查确认邮件');
  }
}

async function signOut() {
  try {
    if (state.session?.access_token) await fetch(CFG.supabaseUrl + '/auth/v1/logout', {method:'POST',headers:{'apikey':CFG.publishableKey,'Authorization':`Bearer ${state.session.access_token}`}});
  } catch {}
  saveSession(null);
  state.devices=[];state.accounts=[];state.deviceAccounts=[];state.destinations=[];state.products=[];state.purchases=[];
  $('appShell').classList.add('hidden'); $('authView').classList.remove('hidden');
  notify('已退出 V6');
}

function enterApp() {
  $('authView').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  $('userEmailText').textContent = state.session?.user?.email || '已登录';
  renderNetwork(); renderSyncBadge();
}

function parseAuthHash() {
  if (!location.hash.includes('access_token=')) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  const access_token = p.get('access_token'), refresh_token = p.get('refresh_token');
  if (!access_token || !refresh_token) return false;
  saveSession({access_token, refresh_token, token_type:p.get('token_type') || 'bearer', expires_in:Number(p.get('expires_in') || 3600), user:{id:decodeJwtSub(access_token),email:''}});
  history.replaceState(null,'',location.pathname + location.search);
  return true;
}

function bindEvents() {
  $('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('authEmail').value.trim(), password = $('authPassword').value;
    if (!email || password.length < 8) return notify('请输入邮箱和至少 8 位密码');
    $('signInBtn').disabled = true;
    try { await signIn(email,password); } catch(err) { notify(err.message); }
    finally { $('signInBtn').disabled = false; }
  });
  $('signUpBtn').onclick = async () => {
    const email = $('authEmail').value.trim(), password = $('authPassword').value;
    if (!email || password.length < 8) return notify('请输入邮箱和至少 8 位密码');
    $('signUpBtn').disabled = true;
    try { await signUp(email,password); } catch(err) { notify(err.message); }
    finally { $('signUpBtn').disabled = false; }
  };
  $('signOutBtn').onclick = signOut;
  $('savePurchase').onclick = savePurchase;
  $('addDevice').onclick = addDevice;
  $('addAccount').onclick = addAccount;
  $('addDestination').onclick = addDestination;
  $('addProduct').onclick = addProduct;
  $('refreshData').onclick = () => loadAllData();

  $('deviceSelect').onchange = () => {
    state.currentDeviceId = $('deviceSelect').value;
    if (state.currentDeviceId) localStorage.setItem(DEVICE_KEY,state.currentDeviceId); else localStorage.removeItem(DEVICE_KEY);
    renderAll();
  };
  $('currentAccount').onchange = () => { if ($('currentAccount').value) localStorage.setItem(currentAccountIdKey(), $('currentAccount').value); else localStorage.removeItem(currentAccountIdKey()); };
  $('currentDestination').onchange = () => { if ($('currentDestination').value) localStorage.setItem(DEST_KEY,$('currentDestination').value); else localStorage.removeItem(DEST_KEY); };
  $('ledgerAccount').onchange = renderPurchases;
  $('ledgerProduct').onchange = renderPurchases;
  $('productSearch').oninput = () => { state.selectedProductId=''; state.selectedVariant=''; renderSelectedProduct(); updateProductSuggestions(); };
  $('manualVariant').oninput = () => { state.selectedVariant = ''; renderSelectedProduct(); };
  $('purchasePaid').addEventListener('keydown', e => { if (e.key === 'Enter') savePurchase(); });

  document.querySelectorAll('.bottom-nav [data-page]').forEach(btn => btn.onclick = () => showPage(btn.dataset.page));
  document.querySelectorAll('[data-go]').forEach(btn => btn.onclick = () => showPage(btn.dataset.go));
  window.addEventListener('online', () => { renderNetwork(); flushOutbox(); });
  window.addEventListener('offline', renderNetwork);
  document.addEventListener('click', e => { if (!e.target.closest('.product-search-label')) $('productSuggestions').classList.add('hidden'); });
}

async function init() {
  bindEvents();
  parseAuthHash();
  if (!state.session) loadStoredSession();
  renderNetwork(); renderSyncBadge();
  if (state.session?.access_token) {
    enterApp();
    try {
      await loadAllData({quiet:true});
    } catch {
      try { await refreshSession(); await loadAllData({quiet:true}); }
      catch { saveSession(null); $('appShell').classList.add('hidden'); $('authView').classList.remove('hidden'); }
    }
  }
}

init();
})();
