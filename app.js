const DB_NAME='SneakerLedgerV5Test',DB_VERSION=1;
let dbHandle=null,pendingImage='',selectedReportDate=localDate(),calendarCursor=startOfMonth(new Date()),reportPeriod='week',calendarMetric='profit',reportAnchor=new Date();
const $=id=>document.getElementById(id);
const money=n=>'¥'+Number(n||0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const qtyText=n=>Number.isInteger(Number(n))?String(Number(n)):Number(n).toFixed(2).replace(/0+$/,'').replace(/\.$/,'');
const uid=()=>crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeImage=v=>typeof v==='string'&&(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v)||v==='')?v:'';
function localDate(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function parseDate(s){const [y,m,d]=String(s).split('-').map(Number);return new Date(y,m-1,d)}
function startOfMonth(d){return new Date(d.getFullYear(),d.getMonth(),1)}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
function addMonths(d,n){return new Date(d.getFullYear(),d.getMonth()+n,1)}
function addYears(d,n){return new Date(d.getFullYear()+n,d.getMonth(),1)}
function cleanText(v,max=120){if(typeof v!=='string')throw new Error('文本字段格式不正确');const s=v.trim();if(s.length>max)throw new Error('文本字段过长');return s}
function validDate(s){return /^\d{4}-\d{2}-\d{2}$/.test(String(s))}
function eventBuyAmount(e){return e.type==='buy'?Number(e.unitCost||0)*Number(e.qty||0):0}
function eventRevenue(e){return e.type==='sell'?Number(e.net||0):0}
function eventUnitNet(e){return e.type==='sell'?(Number.isFinite(Number(e.unitNet))?Number(e.unitNet):(Number(e.qty)>0?Number(e.net||0)/Number(e.qty):0)):0}
function eventProfit(e){return e.type==='sell'?Number(e.profit||0):0}
function notify(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(notify.timer);notify.timer=setTimeout(()=>t.classList.remove('show'),2200)}

function validateBackup(data){
 if(!data||!Array.isArray(data.products)||!Array.isArray(data.events))throw new Error('格式不正确');
 if(data.products.length>10000||data.events.length>200000)throw new Error('备份数据量异常');
 const products=data.products.map(p=>{if(!p||typeof p!=='object')throw new Error('商品数据损坏');const sku=cleanText(p.sku,80).toUpperCase(),name=cleanText(p.name,160),category=cleanText(p.category||'其他',40);if(!sku||!name)throw new Error('商品缺少货号或名称');return{sku,name,category,image:safeImage(p.image||''),updatedAt:typeof p.updatedAt==='string'?p.updatedAt:new Date().toISOString()}});
 const events=data.events.map(e=>{
  if(!e||typeof e!=='object'||!['buy','sell'].includes(e.type))throw new Error('流水类型不正确');
  const sku=cleanText(e.sku,80).toUpperCase(),variant=cleanText(e.variant||'',100),qty=Number(e.qty),date=cleanText(e.date,20);
  if(!sku||!Number.isFinite(qty)||qty<=0||qty>100000||!validDate(date))throw new Error('流水字段异常');
  const base={id:cleanText(String(e.id||uid()),120),type:e.type,sku,variant,qty,date,createdAt:cleanText(e.createdAt||new Date().toISOString(),60)};
  if(e.type==='buy'){const unitCost=Number(e.unitCost);if(!Number.isFinite(unitCost)||unitCost<0||unitCost>1e9)throw new Error('买入成本异常');return{...base,unitCost}}
  const net=Number(e.net),cost=Number(e.cost),profit=Number(e.profit),unitNet=e.unitNet==null?undefined:Number(e.unitNet);
  if(![net,cost,profit].every(Number.isFinite)||net<0||cost<0||Math.abs(profit)>1e12||(unitNet!==undefined&&(!Number.isFinite(unitNet)||unitNet<0)))throw new Error('卖出金额异常');
  return{...base,net,cost,profit,...(unitNet===undefined?{}:{unitNet})};
 });
 return{products,events};
}

function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=e=>{const db=e.target.result;if(!db.objectStoreNames.contains('products'))db.createObjectStore('products',{keyPath:'sku'});if(!db.objectStoreNames.contains('events')){const s=db.createObjectStore('events',{keyPath:'id'});s.createIndex('date','date');s.createIndex('type','type')}};req.onsuccess=()=>{dbHandle=req.result;resolve(dbHandle)};req.onerror=()=>reject(req.error)})}
function store(name,mode='readonly'){return dbHandle.transaction(name,mode).objectStore(name)}
function getAll(name){return new Promise((res,rej)=>{const r=store(name).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error)})}
function getOne(name,key){return new Promise((res,rej)=>{const r=store(name).get(key);r.onsuccess=()=>res(r.result||null);r.onerror=()=>rej(r.error)})}
function put(name,value){return new Promise((res,rej)=>{const r=store(name,'readwrite').put(value);r.onsuccess=()=>res(value);r.onerror=()=>rej(r.error)})}
function clear(name){return new Promise((res,rej)=>{const r=store(name,'readwrite').clear();r.onsuccess=()=>res();r.onerror=()=>rej(r.error)})}
async function snapshot(){const products=await getAll('products'),events=await getAll('events'),positions=calculatePositions(products,events);return{products,events,positions}}

function calculatePositions(products,events){
 const productMap=Object.fromEntries(products.map(p=>[p.sku,p])),m={};
 const ordered=[...events].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
 for(const e of ordered){const k=e.sku+'||'+(e.variant||'');if(!m[k])m[k]={sku:e.sku,variant:e.variant||'',qty:0,cost:0};if(e.type==='buy'){m[k].qty+=Number(e.qty);m[k].cost+=Number(e.unitCost)*Number(e.qty)}else if(e.type==='sell'){m[k].qty-=Number(e.qty);m[k].cost-=Number(e.cost)}}
 return Object.values(m).filter(x=>x.qty>0.00001).map(x=>({...x,avgCost:x.qty?x.cost/x.qty:0,product:productMap[x.sku]||{sku:x.sku,name:x.sku,category:'其他',image:''}}));
}
function groupedPositions(positions){const groups={};for(const p of positions){groups[p.sku]??={product:p.product,vars:[],qty:0,cost:0};groups[p.sku].vars.push(p);groups[p.sku].qty+=p.qty;groups[p.sku].cost+=p.cost}return Object.values(groups)}
function metrics(events){const buy=events.reduce((a,e)=>a+eventBuyAmount(e),0),revenue=events.reduce((a,e)=>a+eventRevenue(e),0),profit=events.reduce((a,e)=>a+eventProfit(e),0),soldQty=events.filter(e=>e.type==='sell').reduce((a,e)=>a+Number(e.qty),0);return{buy,revenue,profit,soldQty,margin:revenue?profit/revenue*100:0,count:events.length}}
function thumb(product){const img=safeImage(product?.image||'');return img?`<img src="${img}" alt="">`:'无图'}

async function render(){
 const data=await snapshot();renderHome(data);renderHoldings(data);renderReports(data);renderMe(data);
}
function renderHome({products,events,positions}){
 const now=localDate(),month=now.slice(0,7),monthEvents=events.filter(e=>e.date.startsWith(month)),todayEvents=events.filter(e=>e.date===now),monthM=metrics(monthEvents),todayM=metrics(todayEvents),groups=groupedPositions(positions),inventory=positions.reduce((a,p)=>a+p.cost,0),holdingQty=positions.reduce((a,p)=>a+p.qty,0);
 $('inventoryValue').textContent=money(inventory);$('holdingQty').textContent=qtyText(holdingQty);$('holdingProductCount').textContent=String(groups.length);$('monthProfit').textContent=money(monthM.profit);$('monthProfitRate').textContent=monthM.margin.toFixed(1)+'%';$('todayProfit').textContent=money(todayM.profit);$('todayCount').textContent=todayM.count+' 笔';$('monthSales').textContent=money(monthM.revenue);$('monthSoldQty').textContent=qtyText(monthM.soldQty)+' 件';
 renderFlowList('recentList',products,[...events].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,5),'recent');
}
function renderFlowList(id,products,events,mode='day'){
 const pm=Object.fromEntries(products.map(p=>[p.sku,p])),el=$(id);el.className='flow-list'+(events.length?'':' empty-state');
 if(!events.length){el.textContent=mode==='day'?'当天没有流水':'还没有交易流水';return}
 el.innerHTML=events.map(e=>{const p=pm[e.sku]||{},isBuy=e.type==='buy',main=isBuy?-eventBuyAmount(e):eventProfit(e),second=isBuy?`买入 ${money(eventBuyAmount(e))}`:`到账 ${money(eventRevenue(e))}`;return `<div class="flow-row"><div class="thumb">${thumb(p)}</div><div class="flow-copy"><b>${isBuy?'买入':'卖出'} · ${esc(p.name||e.sku)}</b><small>${esc(e.sku)} · ${esc(e.variant||'默认规格')} ×${qtyText(e.qty)}</small></div><div class="flow-right"><b class="${main>0?'positive':main<0?'negative':'neutral'}">${main>0?'+':''}${money(main)}</b><small>${esc(second)} · ${esc(e.date)}</small></div></div>`}).join('');
}

function renderHoldings({positions}){
 let q=$('holdingSearch').value.trim().toLowerCase(),groups=groupedPositions(positions).filter(g=>(g.product.sku+g.product.name+g.vars.map(v=>v.variant).join(' ')).toLowerCase().includes(q)).sort((a,b)=>b.cost-a.cost),el=$('holdingList');
 el.className='holding-list'+(groups.length?'':' empty-state');
 if(!groups.length){el.textContent='暂无持仓';return}
 el.innerHTML=groups.map(g=>`<article class="holding-card"><div class="holding-main"><div class="holding-image">${thumb(g.product)}</div><div class="holding-title"><h3>${esc(g.product.name)}</h3><p>${esc(g.product.sku)} · ${esc(g.product.category)}</p></div><div class="holding-value"><span>持仓</span><b>${qtyText(g.qty)}件</b><small>占用 ${money(g.cost)}</small></div></div><div class="variant-table"><div class="variant-headline"><span>规格</span><span>数量</span><span>均价</span><span>占用</span></div>${g.vars.map(v=>`<div class="variant-row"><b>${esc(v.variant||'默认')}</b><span>${qtyText(v.qty)}</span><span>${money(v.avgCost)}</span><span>${money(v.cost)}</span></div><div class="variant-actions"><button class="sell-small" data-sell="${encodeURIComponent(v.sku)}" data-v="${encodeURIComponent(v.variant)}">卖出</button><button class="restock-small" data-restock="${encodeURIComponent(v.sku)}" data-v="${encodeURIComponent(v.variant)}">补货</button></div>`).join('')}</div></article>`).join('');
 document.querySelectorAll('[data-sell]').forEach(b=>b.onclick=()=>openSell(decodeURIComponent(b.dataset.sell),decodeURIComponent(b.dataset.v)));
 document.querySelectorAll('[data-restock]').forEach(b=>b.onclick=()=>openBuyWithProduct(decodeURIComponent(b.dataset.restock),decodeURIComponent(b.dataset.v)));
}

function periodBounds(anchor,period){
 const a=new Date(anchor.getFullYear(),anchor.getMonth(),anchor.getDate());
 if(period==='week'){const day=(a.getDay()+6)%7,start=addDays(a,-day),end=addDays(start,6);return{start,end,label:`${localDate(start).replaceAll('-','/')} - ${localDate(end).replaceAll('-','/')}`}}
 if(period==='month'){const start=new Date(a.getFullYear(),a.getMonth(),1),end=new Date(a.getFullYear(),a.getMonth()+1,0);return{start,end,label:`${a.getFullYear()}年${String(a.getMonth()+1).padStart(2,'0')}月`}}
 if(period==='year'){const start=new Date(a.getFullYear(),0,1),end=new Date(a.getFullYear(),11,31);return{start,end,label:`${a.getFullYear()}年`}}
 return{start:null,end:null,label:'全部历史'};
}
function filterByBounds(events,b){if(!b.start)return events;const s=localDate(b.start),e=localDate(b.end);return events.filter(x=>x.date>=s&&x.date<=e)}
function shiftReport(step){if(reportPeriod==='week')reportAnchor=addDays(reportAnchor,step*7);else if(reportPeriod==='month')reportAnchor=addMonths(reportAnchor,step);else if(reportPeriod==='year')reportAnchor=addYears(reportAnchor,step);render()}
function renderReports({products,events,positions}){
 const b=periodBounds(reportAnchor,reportPeriod),periodEvents=filterByBounds(events,b),m=metrics(periodEvents);$('reportRange').textContent=b.label;$('reportProfit').textContent=money(m.profit);$('reportMargin').textContent=m.margin.toFixed(2)+'%';$('reportRevenue').textContent=money(m.revenue);$('reportBuy').textContent=money(m.buy);
 renderCalendar(events);const dayEvents=events.filter(e=>e.date===selectedReportDate).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))),dm=metrics(dayEvents);$('selectedDayTitle').textContent=selectedReportDate+' 流水明细';$('selectedDaySummary').textContent=`${dm.count}笔 · 盈${money(dm.profit)}`;renderFlowList('dayFlowList',products,dayEvents,'day');renderSevenDay(events);renderCapital(positions);
}
function renderCalendar(events){
 const y=calendarCursor.getFullYear(),mo=calendarCursor.getMonth(),first=new Date(y,mo,1),days=new Date(y,mo+1,0).getDate(),offset=first.getDay();$('calendarMonth').textContent=`${y}年${String(mo+1).padStart(2,'0')}月`;
 const daily={};for(const e of events){if(!e.date.startsWith(`${y}-${String(mo+1).padStart(2,'0')}`))continue;daily[e.date]??={profit:0,revenue:0,count:0};daily[e.date].profit+=eventProfit(e);daily[e.date].revenue+=eventRevenue(e);daily[e.date].count++}
 const cells=[];for(let i=0;i<offset;i++)cells.push('<button class="day-cell blank" type="button"></button>');
 for(let d=1;d<=days;d++){const key=`${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`,x=daily[key]||{profit:0,revenue:0,count:0},val=calendarMetric==='profit'?x.profit:x.revenue,metric=x.count?(calendarMetric==='profit'?`${val>0?'+':''}${Number(val).toFixed(0)}`:`收${Number(val).toFixed(0)}`):'',cls=calendarMetric==='profit'?(val>0?'positive':val<0?'negative':'neutral'):'neutral';cells.push(`<button class="day-cell ${key===selectedReportDate?'selected':''}" data-day="${key}" type="button"><span class="day-number">${d}</span><span class="day-metric ${cls}">${esc(metric)}</span></button>`)}
 $('calendarGrid').innerHTML=cells.join('');document.querySelectorAll('[data-day]').forEach(btn=>btn.onclick=()=>{selectedReportDate=btn.dataset.day;reportAnchor=parseDate(selectedReportDate);render()});
}
function renderSevenDay(events){
 const end=parseDate(selectedReportDate),days=Array.from({length:7},(_,i)=>addDays(end,i-6)),vals=days.map(d=>{const key=localDate(d);return events.filter(e=>e.date===key).reduce((a,e)=>a+eventProfit(e),0)}),max=Math.max(1,...vals.map(v=>Math.abs(v))),total=vals.reduce((a,b)=>a+b,0);$('sevenDayProfit').textContent=money(total);$('profitBars').innerHTML=days.map((d,i)=>`<div class="bar-col"><div class="bar-track"><div class="bar ${vals[i]<0?'negative-bar':''}" style="height:${Math.max(2,Math.abs(vals[i])/max*100)}%"></div></div><small>${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}</small></div>`).join('');
}
function renderCapital(positions){
 const groups=groupedPositions(positions).sort((a,b)=>b.cost-a.cost).slice(0,5),el=$('capitalTop');el.className='capital-list'+(groups.length?'':' empty-state');if(!groups.length){el.textContent='暂无持仓';return}const max=groups[0].cost||1;el.innerHTML=groups.map(g=>`<div class="capital-item"><div><b>${esc(g.product.sku)} · ${esc(g.product.name)}</b><small>${qtyText(g.qty)}件 · ${esc(g.product.category)}</small></div><b class="amount">${money(g.cost)}</b><div class="capital-progress"><i style="width:${Math.max(4,g.cost/max*100)}%"></i></div></div>`).join('');
}

function renderMe({products,events,positions}){$('productCount').textContent=products.length;$('eventCount').textContent=events.length;$('positionCount').textContent=positions.length}
function nav(page){document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===page));document.querySelectorAll('[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page));window.scrollTo({top:0,behavior:'instant'});if(page==='reports')render()}
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>nav(b.dataset.page));
$('homeGoReport').onclick=()=>nav('reports');$('sellFromHoldings').onclick=()=>{nav('holdings');notify('请选择要卖出的持仓规格')};$('holdingSearch').oninput=render;
$('reportPrev').onclick=()=>shiftReport(-1);$('reportNext').onclick=()=>shiftReport(1);$('calPrev').onclick=()=>{calendarCursor=addMonths(calendarCursor,-1);render()};$('calNext').onclick=()=>{calendarCursor=addMonths(calendarCursor,1);render()};
document.querySelectorAll('#periodTabs [data-period]').forEach(b=>b.onclick=()=>{reportPeriod=b.dataset.period;document.querySelectorAll('#periodTabs button').forEach(x=>x.classList.toggle('active',x===b));render()});
document.querySelectorAll('#calendarMode [data-mode]').forEach(b=>b.onclick=()=>{calendarMetric=b.dataset.mode;document.querySelectorAll('#calendarMode button').forEach(x=>x.classList.toggle('active',x===b));render()});
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());

function renderImage(){const img=safeImage(pendingImage);$('buyImagePreview').innerHTML=img?`<img src="${img}" alt="">`:'暂无图片'}
async function compress(file){return new Promise((resolve,reject)=>{const fr=new FileReader();fr.onerror=reject;fr.onload=()=>{const img=new Image();img.onload=()=>{const max=520,scale=Math.min(1,max/Math.max(img.width,img.height)),c=document.createElement('canvas');c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);c.getContext('2d').drawImage(img,0,0,c.width,c.height);resolve(c.toDataURL('image/jpeg',.72))};img.onerror=reject;img.src=fr.result};fr.readAsDataURL(file)})}
$('buyImage').onchange=async e=>{if(e.target.files[0]){pendingImage=await compress(e.target.files[0]);renderImage()}};$('removeBuyImage').onclick=()=>{pendingImage='';renderImage()};
async function fillProduct(sku,target='buy'){const p=await getOne('products',sku);if(!p)return;if(target==='buy'){$('buySku').value=p.sku;$('buyName').value=p.name;$('buyCategory').value=p.category;pendingImage=p.image||'';renderImage();$('skuSuggestions').innerHTML=''}else{$('batchSku').value=p.sku;$('batchName').value=p.name;$('batchCategory').value=p.category;$('batchSkuSuggestions').innerHTML=''}}
async function bindSuggestions(inputId,listId,target){const q=$(inputId).value.trim().toLowerCase(),products=await getAll('products'),matches=products.filter(p=>(p.sku+p.name).toLowerCase().includes(q)).slice(0,6);$(listId).innerHTML=q?matches.map(p=>`<button type="button" data-lookup="${encodeURIComponent(p.sku)}"><b>${esc(p.sku)}</b><small>${esc(p.name)}</small></button>`).join(''):'';document.querySelectorAll(`#${listId} [data-lookup]`).forEach(b=>b.onclick=()=>fillProduct(decodeURIComponent(b.dataset.lookup),target))}
$('buySku').oninput=()=>bindSuggestions('buySku','skuSuggestions','buy');$('batchSku').oninput=()=>bindSuggestions('batchSku','batchSkuSuggestions','batch');
async function openBuy(){ $('buyForm').reset();$('buyDate').value=localDate();pendingImage='';renderImage();$('skuSuggestions').innerHTML='';$('buyDialog').showModal()}
async function openBuyWithProduct(sku,variant){await openBuy();await fillProduct(sku,'buy');$('buyVariant').value=variant||''}
$('openBuy').onclick=openBuy;
$('buyForm').onsubmit=async e=>{e.preventDefault();const sku=cleanText($('buySku').value,80).toUpperCase(),name=cleanText($('buyName').value,160),category=cleanText($('buyCategory').value,40),variant=cleanText($('buyVariant').value,100),unitCost=Number($('buyPrice').value),qty=Number($('buyQty').value),date=$('buyDate').value;if(!sku||!name||!Number.isFinite(unitCost)||unitCost<0||!Number.isFinite(qty)||qty<=0||!validDate(date))return notify('请检查买入信息');const old=await getOne('products',sku);await put('products',{sku,name,category,image:safeImage(pendingImage||(old?.image||'')),updatedAt:new Date().toISOString()});await put('events',{id:uid(),type:'buy',sku,variant,qty,unitCost,date,createdAt:new Date().toISOString()});$('buyDialog').close();notify('买入已记录');await render()};

function addBatchRow(values={variant:'',cost:'',qty:1}){const row=document.createElement('div');row.className='batch-row';row.innerHTML=`<input class="br-variant" placeholder="42.5" value="${esc(values.variant)}"><input class="br-cost" type="number" min="0" step="0.01" placeholder="成本" value="${esc(values.cost)}"><input class="br-qty" type="number" min="1" step="1" value="${esc(values.qty)}"><button type="button" aria-label="删除">×</button>`;row.querySelector('button').onclick=()=>{if($('batchRows').children.length>1)row.remove();else notify('至少保留一行')};$('batchRows').appendChild(row)}
function openBatch(){ $('batchBuyForm').reset();$('batchDate').value=localDate();$('batchRows').innerHTML='';addBatchRow();addBatchRow();$('batchBuyDialog').showModal()}
$('openBatchBuy').onclick=openBatch;$('addBatchRow').onclick=()=>addBatchRow();
$('batchBuyForm').onsubmit=async e=>{e.preventDefault();const sku=cleanText($('batchSku').value,80).toUpperCase(),name=cleanText($('batchName').value,160),category=cleanText($('batchCategory').value,40),date=$('batchDate').value,rows=[...$('batchRows').children].map(r=>({variant:cleanText(r.querySelector('.br-variant').value,100),cost:Number(r.querySelector('.br-cost').value),qty:Number(r.querySelector('.br-qty').value)})).filter(r=>Number.isFinite(r.cost)&&r.cost>=0&&Number.isFinite(r.qty)&&r.qty>0);if(!sku||!name||!validDate(date)||!rows.length)return notify('请至少填写一行有效买入');const old=await getOne('products',sku);await put('products',{sku,name,category,image:safeImage(old?.image||''),updatedAt:new Date().toISOString()});for(let i=0;i<rows.length;i++)await put('events',{id:uid(),type:'buy',sku,variant:rows[i].variant,qty:rows[i].qty,unitCost:rows[i].cost,date,createdAt:new Date(Date.now()+i).toISOString()});$('batchBuyDialog').close();notify(`已批量记录 ${rows.length} 行`);await render()};

async function openSell(sku,variant){const {products,positions}=await snapshot(),p=products.find(x=>x.sku===sku),pos=positions.find(x=>x.sku===sku&&x.variant===variant);if(!pos)return notify('未找到可售库存');$('sellSku').value=sku;$('sellVariant').value=variant;$('sellQty').value=1;$('sellUnitNet').value='';$('sellDate').value=localDate();$('sellProductBox').innerHTML=`<b>${esc(p?.name||sku)}</b><div>${esc(sku)} · ${esc(variant||'默认规格')}</div><small>库存 ${qtyText(pos.qty)}件 · 平均成本 ${money(pos.avgCost)}</small>`;$('sellDialog').showModal();calcSell()}
async function calcSell(){const {positions}=await snapshot(),pos=positions.find(x=>x.sku===$('sellSku').value&&x.variant===$('sellVariant').value),qty=Number($('sellQty').value)||0,unitNet=Number($('sellUnitNet').value)||0,totalNet=unitNet*qty,totalCost=pos?pos.avgCost*qty:0,profit=totalNet-totalCost;$('sellTotalNet').textContent=money(totalNet);$('sellTotalCost').textContent=money(totalCost);$('sellProfit').textContent=money(profit);$('sellProfit').className=profit>=0?'positive':'negative'}
$('sellQty').oninput=calcSell;$('sellUnitNet').oninput=calcSell;
$('sellForm').onsubmit=async e=>{e.preventDefault();const {positions}=await snapshot(),sku=$('sellSku').value,variant=$('sellVariant').value,pos=positions.find(x=>x.sku===sku&&x.variant===variant),qty=Number($('sellQty').value),unitNet=Number($('sellUnitNet').value),date=$('sellDate').value;if(!pos||!Number.isFinite(qty)||qty<=0||qty>pos.qty)return notify('库存数量不足');if(!Number.isFinite(unitNet)||unitNet<0||!validDate(date))return notify('请检查到账金额和日期');const net=unitNet*qty,cost=pos.avgCost*qty,profit=net-cost;await put('events',{id:uid(),type:'sell',sku,variant,qty,unitNet,net,cost,profit,date,createdAt:new Date().toISOString()});$('sellDialog').close();selectedReportDate=date;calendarCursor=startOfMonth(parseDate(date));reportAnchor=parseDate(date);notify('卖出已记录');await render()};

function parseCsv(text){const rows=[];let row=[],cell='',q=false;for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(c==='"'){if(q&&n==='"'){cell+='"';i++}else q=!q}else if(c===','&&!q){row.push(cell);cell=''}else if((c==='\n'||c==='\r')&&!q){if(c==='\r'&&n==='\n')i++;row.push(cell);cell='';if(row.some(x=>x.trim()!==''))rows.push(row);row=[]}else cell+=c}row.push(cell);if(row.some(x=>x.trim()!==''))rows.push(row);return rows}
async function importCsv(file){try{const rows=parseCsv(await file.text());if(rows.length<2)throw new Error('CSV 没有数据');const headers=rows[0].map(x=>x.trim().toLowerCase()),alias={sku:['sku','货号','款号'],name:['name','商品名','商品名称'],category:['category','品类'],variant:['variant','规格','尺码'],cost:['cost','成本','买入价','买入单价'],qty:['qty','数量'],date:['date','日期']},idx={};for(const [k,names] of Object.entries(alias))idx[k]=headers.findIndex(h=>names.includes(h));for(const k of ['sku','name','cost','qty'])if(idx[k]<0)throw new Error(`缺少列：${k}`);const todayKey=localDate(),valid=[],bad=[];for(let r=1;r<rows.length;r++){const x=rows[r],sku=String(x[idx.sku]||'').trim().toUpperCase(),name=String(x[idx.name]||'').trim(),category=idx.category>=0?String(x[idx.category]||'其他').trim()||'其他':'其他',variant=idx.variant>=0?String(x[idx.variant]||'').trim():'',cost=Number(x[idx.cost]),qty=Number(x[idx.qty]),date=idx.date>=0&&validDate(String(x[idx.date]||'').trim())?String(x[idx.date]).trim():todayKey;if(sku&&name&&Number.isFinite(cost)&&cost>=0&&Number.isFinite(qty)&&qty>0)valid.push({sku,name,category,variant,cost,qty,date});else bad.push(r+1)}if(!valid.length)throw new Error('没有可导入的有效行');if(!confirm(`发现 ${valid.length} 行有效数据${bad.length?`，${bad.length} 行无效将跳过`:''}。确认导入？`))return;for(let i=0;i<valid.length;i++){const x=valid[i],old=await getOne('products',x.sku);await put('products',{sku:x.sku,name:cleanText(x.name,160),category:cleanText(x.category,40),image:safeImage(old?.image||''),updatedAt:new Date().toISOString()});await put('events',{id:uid(),type:'buy',sku:x.sku,variant:cleanText(x.variant,100),qty:x.qty,unitCost:x.cost,date:x.date,createdAt:new Date(Date.now()+i).toISOString()})}notify(`已导入 ${valid.length} 行`);await render()}catch(err){alert('CSV 导入失败：'+err.message)}}
$('openCsvImport').onclick=()=>$('csvImport').click();$('meCsvImport').onclick=()=>$('csvImport').click();$('csvImport').onchange=async e=>{if(e.target.files[0])await importCsv(e.target.files[0]);e.target.value=''};

async function exportBackup(){const data={version:'v5-test-0.2',exportedAt:new Date().toISOString(),products:await getAll('products'),events:await getAll('events')},blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`球鞋账本_V5Test_完整备份_${localDate()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);$('backupStatus').textContent='刚刚已导出完整备份';notify('完整备份已导出')}
$('exportBackup').onclick=exportBackup;$('backupQuick').onclick=exportBackup;
$('importBackup').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const data=validateBackup(JSON.parse(await file.text()));if(!confirm(`将恢复 ${data.products.length} 个商品、${data.events.length} 条流水，并覆盖当前 V5 Test 数据。继续？`))return;await clear('products');await clear('events');for(const p of data.products)await put('products',p);for(const ev of data.events)await put('events',ev);$('backupStatus').textContent='备份恢复成功';notify('备份恢复成功');await render()}catch(err){alert('备份文件无法识别：'+err.message)}e.target.value=''};
$('clearTestData').onclick=async()=>{if(!confirm('确定清空 V5 Test 数据？不会影响正式 V4.1。'))return;await clear('products');await clear('events');notify('V5 Test 数据已清空');await render()};

async function runDataCheck(){const {products,events}=await snapshot(),known=new Set(products.map(p=>p.sku)),issues=[];for(const e of events)if(!known.has(e.sku))issues.push(`流水 ${e.id} 缺少商品资料`);const balances={};for(const e of [...events].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))){const k=e.sku+'||'+(e.variant||'');balances[k]??=0;if(e.type==='buy')balances[k]+=Number(e.qty);else{balances[k]-=Number(e.qty);if(balances[k]<-0.00001)issues.push(`${e.sku} ${e.variant||'默认规格'} 曾出现负库存`)}}$('dataCheckText').textContent=issues.length?`发现 ${issues.length} 个问题`:'未发现明显异常';notify(issues.length?`数据检查：发现 ${issues.length} 个问题`:'数据检查通过')}
$('runDataCheck').onclick=runDataCheck;
document.querySelectorAll('[data-menu]').forEach(b=>b.onclick=()=>{const type=b.dataset.menu;if(type==='backup')$('backupPanel').scrollIntoView({behavior:'smooth'});else if(type==='sku')notify('当前仅使用本地商品库，外部 SKU 接口尚未接入');else if(type==='about')notify('V5 Test 0.2 · 本地 IndexedDB · 禁止对外网络连接');else notify('该入口将在后续测试版继续完善')});

(async()=>{await openDB();await render()})();
