const DB_NAME='SneakerLedgerV5Test',DB_VERSION=1;
let dbHandle=null, pendingImage='';
const $=id=>document.getElementById(id);
const today=()=>new Date().toISOString().slice(0,10);
const money=n=>'¥'+Number(n||0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const uid=()=>crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeImage=v=>typeof v==='string' && (/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v) || v==='') ? v : '';
const cleanText=(v,max=120)=>{
  if(typeof v!=='string') throw new Error('文本字段格式不正确');
  const s=v.trim();
  if(s.length>max) throw new Error('文本字段过长');
  return s;
};
function validateBackup(data){
  if(!data || !Array.isArray(data.products) || !Array.isArray(data.events)) throw new Error('格式不正确');
  if(data.products.length>10000 || data.events.length>200000) throw new Error('备份数据量异常');
  const products=data.products.map(p=>{
    if(!p || typeof p!=='object') throw new Error('商品数据损坏');
    const sku=cleanText(p.sku,80).toUpperCase();
    const name=cleanText(p.name,160);
    const category=cleanText(p.category||'其他',40);
    if(!sku || !name) throw new Error('商品缺少货号或名称');
    return {sku,name,category,image:safeImage(p.image||''),updatedAt:typeof p.updatedAt==='string'?p.updatedAt:new Date().toISOString()};
  });
  const events=data.events.map(e=>{
    if(!e || typeof e!=='object' || !['buy','sell'].includes(e.type)) throw new Error('流水类型不正确');
    const sku=cleanText(e.sku,80).toUpperCase();
    const variant=cleanText(e.variant||'',100);
    const qty=Number(e.qty);
    if(!sku || !Number.isFinite(qty) || qty<=0 || qty>100000) throw new Error('流水数量异常');
    const base={id:cleanText(String(e.id||uid()),120),type:e.type,sku,variant,qty,date:cleanText(e.date,20),createdAt:cleanText(e.createdAt||new Date().toISOString(),60)};
    if(e.type==='buy'){
      const unitCost=Number(e.unitCost);
      if(!Number.isFinite(unitCost) || unitCost<0 || unitCost>1e9) throw new Error('买入成本异常');
      return {...base,unitCost};
    }
    const net=Number(e.net),cost=Number(e.cost),profit=Number(e.profit);
    if(![net,cost,profit].every(Number.isFinite) || net<0 || cost<0 || Math.abs(profit)>1e12) throw new Error('卖出金额异常');
    return {...base,net,cost,profit};
  });
  return {products,events};
}

function openDB(){
 return new Promise((resolve,reject)=>{
  const req=indexedDB.open(DB_NAME,DB_VERSION);
  req.onupgradeneeded=e=>{
   const db=e.target.result;
   if(!db.objectStoreNames.contains('products')) db.createObjectStore('products',{keyPath:'sku'});
   if(!db.objectStoreNames.contains('events')) {
    const s=db.createObjectStore('events',{keyPath:'id'});
    s.createIndex('date','date');
    s.createIndex('type','type');
   }
  };
  req.onsuccess=()=>{dbHandle=req.result;resolve(dbHandle)};
  req.onerror=()=>reject(req.error);
 });
}
function store(name,mode='readonly'){return dbHandle.transaction(name,mode).objectStore(name)}
function getAll(name){return new Promise((res,rej)=>{const r=store(name).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)})}
function getOne(name,key){return new Promise((res,rej)=>{const r=store(name).get(key);r.onsuccess=()=>res(r.result||null);r.onerror=()=>rej(r.error)})}
function put(name,value){return new Promise((res,rej)=>{const r=store(name,'readwrite').put(value);r.onsuccess=()=>res(value);r.onerror=()=>rej(r.error)})}
function del(name,key){return new Promise((res,rej)=>{const r=store(name,'readwrite').delete(key);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
function clear(name){return new Promise((res,rej)=>{const r=store(name,'readwrite').clear();r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}

async function snapshot(){
 const products=await getAll('products'), events=await getAll('events');
 const positions=calculatePositions(products,events);
 return {products,events,positions};
}
function calculatePositions(products,events){
 const productMap=Object.fromEntries(products.map(p=>[p.sku,p]));
 const m={};
 const ordered=[...events].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
 for(const e of ordered){
  const k=e.sku+'||'+(e.variant||'');
  if(!m[k]) m[k]={sku:e.sku,variant:e.variant||'',qty:0,cost:0};
  if(e.type==='buy'){m[k].qty+=e.qty;m[k].cost+=e.unitCost*e.qty}
  if(e.type==='sell'){m[k].qty-=e.qty;m[k].cost-=e.cost}
 }
 return Object.values(m).filter(x=>x.qty>0.00001).map(x=>({
  ...x,avgCost:x.cost/x.qty,product:productMap[x.sku]||{sku:x.sku,name:x.sku,category:'其他',image:''}
 }));
}
function stats(events){
 const month=today().slice(0,7),td=today();
 const monthSells=events.filter(e=>e.type==='sell'&&e.date.startsWith(month));
 const todayBuys=events.filter(e=>e.type==='buy'&&e.date===td);
 const todaySells=events.filter(e=>e.type==='sell'&&e.date===td);
 return {
  monthProfit:monthSells.reduce((a,e)=>a+e.profit,0),
  todayBuy:todayBuys.reduce((a,e)=>a+e.unitCost*e.qty,0),
  todaySell:todaySells.reduce((a,e)=>a+e.net,0),
  todayProfit:todaySells.reduce((a,e)=>a+e.profit,0),
  todayCount:todayBuys.length+todaySells.length
 };
}
async function render(){
 const {products,events,positions}=await snapshot(), s=stats(events);
 $('monthProfit').textContent=money(s.monthProfit);$('todayBuy').textContent=money(s.todayBuy);
 $('todaySell').textContent=money(s.todaySell);$('todayProfit').textContent=money(s.todayProfit);
 $('inventoryValue').textContent=money(positions.reduce((a,p)=>a+p.cost,0));$('todayCount').textContent=s.todayCount+' 笔';
 $('productCount').textContent=products.length;$('buyCount').textContent=events.filter(e=>e.type==='buy').length;
 $('sellCount').textContent=events.filter(e=>e.type==='sell').length;$('positionCount').textContent=positions.length;
 renderToday(products,events);renderHoldings(products,events);renderTransactions(products,events);
}
function thumb(product){const img=safeImage(product?.image||'');return img?`<img src="${img}" alt="">`:'无图'}
function renderToday(products,events){
 const pm=Object.fromEntries(products.map(p=>[p.sku,p]));
 const arr=events.filter(e=>e.date===today()).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
 $('todayList').className='list'+(arr.length?'':' empty');
 $('todayList').innerHTML=arr.length?arr.map(e=>{const p=pm[e.sku]||{};const val=e.type==='buy'?-(e.unitCost*e.qty):e.profit;return `<div class="flow"><div class="thumb">${thumb(p)}</div><div><b>${e.type==='buy'?'买入':'卖出'} · ${esc(p.name||e.sku)}</b><small>${esc(e.sku)} · ${esc(e.variant||'默认规格')} ×${e.qty}</small></div><div class="right"><b class="${val>=0?'positive':'negative'}">${val>=0?'+':''}${money(val)}</b><small>${e.date}</small></div></div>`}).join(''):'今天还没有记录';
}
function renderHoldings(products,events){
 let positions=calculatePositions(products,events),q=$('holdingSearch').value.trim().toLowerCase();
 positions=positions.filter(x=>(x.sku+x.product.name+x.variant).toLowerCase().includes(q));
 const groups={};for(const p of positions){groups[p.sku]??={product:p.product,vars:[],qty:0,cost:0};groups[p.sku].vars.push(p);groups[p.sku].qty+=p.qty;groups[p.sku].cost+=p.cost}
 const arr=Object.values(groups).sort((a,b)=>b.cost-a.cost);
 $('holdingList').className='holding-list'+(arr.length?'':' empty');
 $('holdingList').innerHTML=arr.length?arr.map(g=>`<div class="holding"><div class="holding-main"><div class="holding-image">${thumb(g.product)}</div><div><h3>${esc(g.product.name)}</h3><p>${esc(g.product.sku)} · ${esc(g.product.category)} · ${g.qty}件</p></div><div class="holding-value"><b>${money(g.cost)}</b><small>资金占用</small></div></div><div class="variant-list">${g.vars.map(v=>`<div class="variant-row"><div class="variant-head"><b>${esc(v.variant||'默认规格')}</b><span>${v.qty}件 · 均价 ${money(v.avgCost)}</span></div><div class="variant-actions"><button data-sell="${encodeURIComponent(v.sku)}" data-v="${encodeURIComponent(v.variant)}">直接卖出</button></div></div>`).join('')}</div></div>`).join(''):'暂无持仓';
 document.querySelectorAll('[data-sell]').forEach(b=>b.addEventListener('click',()=>openSell(decodeURIComponent(b.dataset.sell),decodeURIComponent(b.dataset.v))));
}
function renderTransactions(products,events){
 const pm=Object.fromEntries(products.map(p=>[p.sku,p]));let q=$('txnSearch').value.trim().toLowerCase(),t=$('txnType').value;
 let arr=[...events].filter(e=>(t==='all'||e.type===t)&&((e.sku+(pm[e.sku]?.name||'')+(e.variant||'')).toLowerCase().includes(q))).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
 $('txnList').className='list'+(arr.length?'':' empty');$('txnList').innerHTML=arr.length?arr.map(e=>{const p=pm[e.sku]||{};const val=e.type==='buy'?-(e.unitCost*e.qty):e.profit;return `<div class="txn"><div class="thumb">${thumb(p)}</div><div><b>${e.type==='buy'?'买入':'卖出'} · ${esc(p.name||e.sku)}</b><small>${e.date} · ${esc(e.sku)} · ${esc(e.variant||'默认规格')} ×${e.qty}</small></div><div class="right"><b class="${val>=0?'positive':'negative'}">${val>=0?'+':''}${money(val)}</b></div></div>`}).join(''):'暂无流水';
}
function nav(page){document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===page));document.querySelectorAll('[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page))}
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>nav(b.dataset.page)));
$('goHoldings').onclick=()=>nav('holdings');$('goTransactions').onclick=()=>nav('transactions');$('goMe').onclick=()=>nav('me');
$('holdingSearch').oninput=render;$('txnSearch').oninput=render;$('txnType').onchange=render;
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());

function renderImage(){ const img=safeImage(pendingImage);$('buyImagePreview').innerHTML=img?`<img src="${img}" alt="">`:'暂无图片' }
async function compress(file){
 return new Promise((resolve,reject)=>{
  const fr=new FileReader();fr.onerror=reject;fr.onload=()=>{const img=new Image();img.onload=()=>{const max=520,scale=Math.min(1,max/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);c.getContext('2d').drawImage(img,0,0,c.width,c.height);resolve(c.toDataURL('image/jpeg',.72))};img.onerror=reject;img.src=fr.result};fr.readAsDataURL(file);
 });
}
$('buyImage').onchange=async e=>{if(e.target.files[0]){pendingImage=await compress(e.target.files[0]);renderImage()}};
$('removeBuyImage').onclick=()=>{pendingImage='';renderImage()};

async function openBuy(){
 $('buyForm').reset();$('buyDate').value=today();pendingImage='';renderImage();$('skuSuggestions').innerHTML='';$('buyDialog').showModal()
}
$('openBuy').onclick=openBuy;
$('buySku').oninput=async()=>{
 const q=$('buySku').value.trim().toLowerCase(),products=await getAll('products');
 const matches=products.filter(p=>(p.sku+p.name).toLowerCase().includes(q)).slice(0,6);
 $('skuSuggestions').innerHTML=q?matches.map(p=>`<button type="button" data-s="${encodeURIComponent(p.sku)}"><b>${esc(p.sku)}</b><small>${esc(p.name)}</small></button>`).join(''):'';
 document.querySelectorAll('#skuSuggestions [data-s]').forEach(b=>b.onclick=async()=>{const p=await getOne('products',decodeURIComponent(b.dataset.s));$('buySku').value=p.sku;$('buyName').value=p.name;$('buyCategory').value=p.category;pendingImage=p.image||'';renderImage();$('skuSuggestions').innerHTML=''});
};
$('buyForm').onsubmit=async e=>{
 e.preventDefault();const sku=$('buySku').value.trim().toUpperCase(),name=$('buyName').value.trim(),category=$('buyCategory').value,variant=$('buyVariant').value.trim(),unitCost=+$('buyPrice').value,qty=+$('buyQty').value,date=$('buyDate').value;
 if(!sku||!name||qty<=0||unitCost<0)return;
 await put('products',{sku:cleanText(sku,80),name:cleanText(name,160),category:cleanText(category,40),image:safeImage(pendingImage||((await getOne('products',sku))?.image||'')),updatedAt:new Date().toISOString()});
 await put('events',{id:uid(),type:'buy',sku,variant,qty,unitCost,date,createdAt:new Date().toISOString()});
 $('buyDialog').close();await render();
};

async function openSell(sku,variant){
 const {products,events,positions}=await snapshot(),p=products.find(x=>x.sku===sku),pos=positions.find(x=>x.sku===sku&&x.variant===variant);
 if(!pos)return alert('未找到可售库存');
 $('sellSku').value=sku;$('sellVariant').value=variant;$('sellQty').value=1;$('sellNet').value='';$('sellDate').value=today();
 $('sellProductBox').innerHTML=`<b>${esc(p?.name||sku)}</b><div>${esc(sku)} · ${esc(variant||'默认规格')}</div><small>库存 ${pos.qty}件 · 平均成本 ${money(pos.avgCost)}</small>`;
 $('sellDialog').showModal();calcSell();
}
async function calcSell(){
 const {positions}=await snapshot(),pos=positions.find(x=>x.sku===$('sellSku').value&&x.variant===$('sellVariant').value),q=+$('sellQty').value||0,net=+$('sellNet').value||0;
 $('sellProfit').textContent=pos?money(net-pos.avgCost*q):money(0);
}
$('sellQty').oninput=calcSell;$('sellNet').oninput=calcSell;
$('sellForm').onsubmit=async e=>{
 e.preventDefault();const {positions}=await snapshot(),sku=$('sellSku').value,variant=$('sellVariant').value,pos=positions.find(x=>x.sku===sku&&x.variant===variant),qty=+$('sellQty').value,net=+$('sellNet').value,date=$('sellDate').value;
 if(!pos||qty<=0||qty>pos.qty)return alert('库存数量不足');
 const cost=pos.avgCost*qty,profit=net-cost;
 await put('events',{id:uid(),type:'sell',sku,variant,qty,net,cost,profit,date,createdAt:new Date().toISOString()});
 $('sellDialog').close();await render();
};

async function exportBackup(){
 const data={version:'v5-test-0.1.1',exportedAt:new Date().toISOString(),...(await snapshot())};
 delete data.positions;
 const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
 const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`球鞋账本_V5Test_完整备份_${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
 $('backupStatus').textContent='已导出完整备份';
}
$('exportBackup').onclick=exportBackup;$('backupQuick').onclick=exportBackup;
$('importBackup').onchange=async e=>{
 const file=e.target.files[0];if(!file)return;
 try{
  const raw=JSON.parse(await file.text());
  const data=validateBackup(raw);
  if(!confirm(`将导入 ${data.products.length} 个商品、${data.events.length} 条流水，并覆盖当前 V5 Test 数据。继续？`))return;
  await clear('products');await clear('events');
  for(const p of data.products)await put('products',p);for(const ev of data.events)await put('events',ev);
  $('backupStatus').textContent='备份恢复成功';await render();
 }catch(err){alert('备份文件无法识别：'+err.message)}
 e.target.value='';
};
$('clearTestData').onclick=async()=>{if(!confirm('确定清空 V5 Test 数据？不会影响正式 V4.1。'))return;await clear('products');await clear('events');await render()};
(async()=>{await openDB();await render()})();