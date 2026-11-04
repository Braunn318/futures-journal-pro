'use strict';
// Swingový CFD deník – rozhraní (docs/ZADANI_SWING_CFD.md kroky 2–4) a záložka
// „Pozice/Příkazy" s čekajícími příkazy (ruční limitky + cTrader přes MCP, jen čtení).
//
// Načítá se po hlavním skriptu index.html a používá jeho globální funkce
// ($, esc, commitJournal, ensureActiveJournalData, showToast, showConfirm, load,
// storeScreenshot, thumbImgHTML, nameRecordImages, openModal, openSetupModal …).
// Výpočty jsou v app/swing.js (FJSwing). Všechny zápisy jdou přes commitJournal.
// Žádné alert / confirm / prompt.

// ---------- typ deníku ----------
function activeJournalProfile(){return journalProfiles.find(j=>j.id===activeJournalId)||null}
function activeJournalType(){
 const fileType=db?.data?.journalType;
 return FJSwing.journalTypeOf(fileType?{journalType:fileType}:activeJournalProfile());
}
function isSwingJournalActive(){return activeJournalType()===FJSwing.JOURNAL_TYPES.CFD_SWING}
function syncProfileJournalType(type){
 const p=activeJournalProfile();
 if(!p)return;
 const t=FJSwing.journalTypeOf({journalType:type});
 if(FJSwing.journalTypeOf(p)!==t||p.journalType!==t){p.journalType=t;saveJournalProfiles()}
}
// Migrace typu deníku (§2): záloha → zápis → značka. Idempotentní: se značkou nic.
// Nový deník bez dat se nezálohuje (není co), typ dostane z profilu (výběr při založení).
async function runJournalTypeMigration(){
 const data=await ensureActiveJournalData();
 if(Number(data.journalTypeVersion||0)>=FJSwing.JOURNAL_TYPE_VERSION){
  syncProfileJournalType(data.journalType);
  return {skipped:true};
 }
 const initial=FJSwing.journalTypeOf(data.journalType?{journalType:data.journalType}:activeJournalProfile());
 const hasData=(data.trades||[]).length>0||(data.settings||[]).length>0||Object.keys(data.dayNotes||{}).length>0;
 if(hasData){
  const r=await window.desktopAPI?.backupJournal?.(activeJournalId,'pred-typem-deniku');
  if(!r||r.ok!==true)throw new Error(r?.error||'Zálohu deníku před zápisem typu nelze vytvořit.');
 }
 await commitJournal(j=>{
  j.journalType=FJSwing.journalTypeOf(j.journalType?{journalType:j.journalType}:{journalType:initial});
  j.journalTypeVersion=FJSwing.JOURNAL_TYPE_VERSION;
 });
 syncProfileJournalType(db.data.journalType);
 return {migrated:true,type:db.data.journalType,backedUp:hasData};
}
// Změna typu u existujícího deníku: data obchodů se nemění, jen typ.
async function changeActiveJournalType(nextType){
 const t=FJSwing.journalTypeOf({journalType:nextType});
 if(t===activeJournalType())return true;
 const data=await ensureActiveJournalData();
 const n=(data.trades||[]).length;
 if(n){
  const ok=await showConfirm(`Deník má ${n} záznamů. Změna typu na „${FJSwing.JOURNAL_TYPE_LABELS[t]}“ nezmění žádná data obchodů – jen to, co deník ukazuje a počítá. Futures obchody se ve swing deníku nezobrazují (a naopak), dokud typ nevrátíš.\n\nZměnit typ deníku?`,{title:'Změnit typ deníku',ok:'Změnit typ'});
  if(!ok)return false;
  const r=await window.desktopAPI?.backupJournal?.(activeJournalId,'pred-zmenou-typu-deniku');
  if(!r||r.ok!==true){showToast('Zálohu deníku nelze vytvořit, typ zůstal beze změny.');return false}
 }
 await commitJournal(j=>{j.journalType=t;j.journalTypeVersion=FJSwing.JOURNAL_TYPE_VERSION});
 syncProfileJournalType(t);
 return true;
}

// ---------- CSS a vzhled podle typu ----------
(function injectSwingCss(){
 const css=`
 .swing-badge{display:inline-block;margin-left:8px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.06em;background:rgba(var(--yellow-rgb),.2);color:var(--yellow);border:1px solid rgba(var(--yellow-rgb),.55);vertical-align:middle}
 body.swing-journal .futures-only{display:none!important}
 body:not(.swing-journal) .swing-only{display:none!important}
 .swing-card{border:1px solid var(--line);border-radius:14px;padding:14px 16px;background:var(--card,transparent)}
 .swing-card-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
 .swing-card-head b{font-size:15px}
 .swing-kpis{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font-size:13px}
 .swing-kpis span .sub{display:block;font-size:11px}
 .swing-legs{margin-top:8px;font-size:12px}
 .swing-legs td,.swing-legs th{padding:3px 8px}
 .swing-rows{display:grid;gap:6px;margin-top:6px}
 .swing-row{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end}
 .swing-row .field{margin:0}
 .swing-row input,.swing-row select{min-width:0}
 .swing-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
 .swing-derived{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;margin-top:8px;opacity:.9}
 .swing-actions{display:flex;flex-wrap:wrap;gap:6px}
 .swing-actions .btn{padding:4px 10px;font-size:12px}
 .swing-modal .modalbox{max-width:980px;max-height:92vh;overflow:auto}
 .swing-section{margin-top:14px;border-top:1px solid var(--line);padding-top:10px}
 .swing-section h3{margin:0 0 6px;font-size:14px}
 .swing-imgs{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
 .swing-imgs img{width:140px;height:84px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
 .swing-imgs .img-wrap{position:relative}
 .swing-imgs .img-wrap button{position:absolute;top:2px;right:2px;padding:0 6px}
 .src-pill{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--line)}
 `;
 const s=document.createElement('style');s.textContent=css;document.head.appendChild(s);
})();

function applyJournalTypeUi(){
 const swing=isSwingJournalActive();
 document.body.classList.toggle('swing-journal',swing);
 const title=$('pageTitle');
 let badge=$('swingBadge');
 if(!badge&&title){badge=document.createElement('span');badge.id='swingBadge';badge.className='swing-badge';badge.textContent='SWING · CFD';title.insertAdjacentElement('afterend',badge)}
 if(badge)badge.style.display=swing?'':'none';
 const sub=title?.parentElement?.querySelector('.sub');
 if(sub)sub.textContent=swing?'Swingový deník CFD':'Obchodní deník pro futures';
 // intraday prvky ve swing deníku skrýt (data zůstávají)
 for(const id of ['addSetupBtn','dayContextBtn','filterResult','filterSide','filterSkipLive','filterFill'])$(id)?.classList.add('futures-only');
 // Deník: futures filtry a nástroje (sloučení nohou, import NT8, přidat den, kontrola dat) swing nepoužívá
 const journalSec=$('journal');
 if(journalSec){
  $('filterDataCheck')?.closest('.toolbar-group')?.classList.add('futures-only');
  $('filterDate')?.closest('.toolbar-group')?.classList.add('futures-only');
  journalSec.querySelector('[data-include-scope="journal"]')?.closest('.toolbar-group')?.classList.add('futures-only');
  journalSec.querySelectorAll('.toolbar-row')[1]?.classList.add('futures-only');
  journalSec.querySelector('.toolbar-hint')?.classList.add('futures-only');
 }
 const riskCard=$('riskMaxDailyDrawdown')?.closest('.card');if(riskCard)riskCard.classList.add('futures-only');
 const note=$('swingOverviewNote');if(note)note.style.display=swing?'':'none';
 renderSwingSettings();
}

// ---------- formát ----------
function swingInstruments(){return FJSwing.instrumentsOf(settings)}
function swingInstrumentOf(symbol){return FJSwing.findInstrument(symbol,swingInstruments())}
function fmtPrice(v,symbol){
 if(v===null||v===undefined||v===''||!Number.isFinite(Number(v)))return '—';
 const d=swingInstrumentOf(symbol)?.priceDecimals;
 return Number(v).toLocaleString('cs-CZ',d!=null?{minimumFractionDigits:d,maximumFractionDigits:d}:{maximumFractionDigits:8});
}
function fmtNum(v,dec=2){return v===null||v===undefined||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString('cs-CZ',{maximumFractionDigits:dec})}
function swingCurrency(){return settings.swingCurrency||'USD'}
function fmtMoney(v){
 if(v===null||v===undefined||!Number.isFinite(Number(v)))return '—';
 try{return new Intl.NumberFormat('cs-CZ',{style:'currency',currency:swingCurrency(),maximumFractionDigits:2}).format(Number(v))}catch{return fmtNum(v)}
}
function fmtLocal(v){
 const p=FJSwing.splitLocal(v);
 if(!p)return '—';
 const [y,m,d]=p.date.split('-');return `${Number(d)}. ${Number(m)}. ${y} ${p.time}`;
}
const signCls=v=>v>0?'pos':v<0?'neg':'';
const dirPill=d=>`<span class="pill side-pill ${d==='short'?'short':'long'}">${d==='short'?'SHORT':'LONG'}</span>`;

// ---------- záznamy ----------
function swingRows(){return (db?.data?.trades||[]).filter(FJSwing.isSwingRecord)}
function swingDerivedOf(t){return FJSwing.swingDerived(t,swingInstrumentOf(t.symbol))}
function swingOpenPositions(){return swingRows().filter(t=>t.recordType!=='SETUP_ONLY'&&FJSwing.status(t)==='OPEN')}

// ---------- seznam v Deníku ----------
function swingCardHTML(t){
 const d=swingDerivedOf(t);
 const setup=t.recordType==='SETUP_ONLY';
 const missing=FJSwing.swingMissing(t);
 const statusPill=setup?'<span class="pill hypo-pill">Setup bez vstupu · nenaplněno</span>':d.status==='OPEN'?'<span class="pill be">OTEVŘENÁ</span>':'<span class="pill">UZAVŘENÁ</span>';
 const legs=(t.exits||[]).slice().sort((a,b)=>String(a.closedAt).localeCompare(String(b.closedAt)));
 const legsHtml=legs.length?`<table class="swing-legs"><thead><tr><th>Výstup</th><th>Cena</th><th>Objem</th><th>Důvod</th><th>P/L</th><th>Swap</th><th>Komise</th><th>Netto</th></tr></thead><tbody>${legs.map(e=>{const n=FJSwing.legPnlNet(e);return `<tr><td>${fmtLocal(e.closedAt)}</td><td>${fmtPrice(e.price,t.symbol)}</td><td>${fmtNum(e.volume,4)}</td><td>${esc(FJSwing.EXIT_REASON_LABELS[e.reason]||'—')}</td><td class="${signCls(e.pnl)}">${fmtMoney(e.pnl)}</td><td class="${signCls(e.swap)}">${fmtMoney(e.swap)}</td><td class="${signCls(e.commission)}">${fmtMoney(e.commission)}</td><td class="${signCls(n)}"><b>${fmtMoney(n)}</b></td></tr>`}).join('')}</tbody></table>`:'';
 const imgs=(t.images||[]).length?`<div class="swing-imgs">${t.images.map(r=>thumbImgHTML(r)).join('')}</div>`:'';
 return `<div class="swing-card" data-swing-id="${esc(t.id)}">
  <div class="swing-card-head">
   <div><b>${esc(t.symbol||'—')}</b> ${dirPill(t.direction)} ${statusPill}
    ${missing.length?`<span class="pill incomplete-pill" title="Chybí: ${esc(missing.map(k=>FJSwing.MISSING_LABELS[k]).join(', '))}">⚠ Neúplné · ${missing.length}</span>`:''}
    ${d.volumeError?'<span class="pill loss" title="Součet objemů výstupů je větší než objem pozice">Objem výstupů &gt; objem</span>':''}
    ${t.source==='CTRADER'?'<span class="src-pill">cTrader</span>':''}</div>
   <div class="swing-actions">
    ${!setup&&d.status==='OPEN'?`<button class="btn" data-swing-exit="${esc(t.id)}">＋ Výstup</button><button class="btn" data-swing-sl="${esc(t.id)}">Posunout SL</button>`:''}
    <button class="btn" data-swing-edit="${esc(t.id)}">Upravit</button>
    <button class="btn danger" data-swing-del="${esc(t.id)}">🗑️</button>
   </div>
  </div>
  <div class="swing-kpis">
   <span><span class="sub">Otevřeno</span>${fmtLocal(t.openedAt)}</span>
   ${d.closedAt?`<span><span class="sub">Uzavřeno</span>${fmtLocal(d.closedAt)}</span>`:''}
   <span><span class="sub">Vstup</span>${fmtPrice(t.entryPrice,t.symbol)}</span>
   <span><span class="sub">Objem</span>${fmtNum(t.volume,4)}${d.status==='OPEN'&&legs.length?` (zbývá ${fmtNum(d.remainingVolume,4)})`:''}</span>
   <span><span class="sub">SL při otevření / aktuální</span>${fmtPrice(t.slInitial,t.symbol)} / ${fmtPrice(d.currentSl,t.symbol)}</span>
   <span><span class="sub">SL (pipy)</span>${fmtNum(d.slPips,1)}</span>
   ${!setup?`<span><span class="sub">Držení</span>${fmtNum(d.holdingDays,1)} d · ${d.nightsHeld??'—'} nocí</span>`:''}
   ${d.pipsPerUnit!=null?`<span><span class="sub">Pipy / jednotku</span>${fmtNum(d.pipsPerUnit,1)}</span>`:''}
   <span><span class="sub">R z ceny</span><b class="${signCls(d.rPrice)}">${d.rPrice!=null?fmtNum(d.rPrice,2)+' R':'—'}</b></span>
   ${legs.length?`<span><span class="sub">Netto</span><b class="${signCls(d.pnlNetTotal)}">${fmtMoney(d.pnlNetTotal)}</b></span>`:''}
   ${d.rMoney!=null?`<span><span class="sub">R z peněz</span>${fmtNum(d.rMoney,2)} R</span>`:''}
   ${t.riskAmount!=null?`<span><span class="sub">Riziko</span>${fmtMoney(t.riskAmount)}</span>`:''}
   ${t.swingSetup?`<span><span class="sub">Setup</span>${esc(t.swingSetup)}</span>`:''}
   ${t.grade?`<span><span class="sub">Známka</span>${esc(t.grade)}</span>`:''}
   ${d.slSlippagePips!=null?`<span><span class="sub">Skluz za SL</span>${fmtNum(d.slSlippagePips,1)} pipů</span>`:''}
  </div>
  ${legsHtml}
  ${t.comment?`<div class="sub" style="margin-top:6px;white-space:pre-line">${esc(t.comment)}</div>`:''}
  ${imgs}
 </div>`;
}
function renderSwingTrades(){
 const target=$('tradeList');
 if(!target)return;
 const q=($('search')?.value||'').toLowerCase();
 const rows=swingRows().filter(t=>!q||((t.symbol||'')+' '+(t.comment||'')+' '+(t.swingSetup||'')).toLowerCase().includes(q))
  .sort((a,b)=>String(b.openedAt||'').localeCompare(String(a.openedAt||'')));
 target.innerHTML=rows.length?rows.map(swingCardHTML).join(''):'<div class="empty">Zatím žádný swing obchod. „＋ Přidat obchod“ otevře novou pozici.</div>';
 wireSwingButtons(target);
}
function wireSwingButtons(root){
 root.querySelectorAll('[data-swing-edit]').forEach(b=>b.onclick=()=>openSwingModal(findSwing(b.dataset.swingEdit)));
 root.querySelectorAll('[data-swing-exit]').forEach(b=>b.onclick=()=>openSwingModal(findSwing(b.dataset.swingExit),{focus:'exit'}));
 root.querySelectorAll('[data-swing-sl]').forEach(b=>b.onclick=()=>openSwingModal(findSwing(b.dataset.swingSl),{focus:'sl'}));
 root.querySelectorAll('[data-swing-del]').forEach(b=>b.onclick=()=>void deleteSwing(b.dataset.swingDel));
}
function findSwing(id){return swingRows().find(t=>t.id===id)||null}
async function deleteSwing(id){
 const t=findSwing(id);if(!t)return;
 if(!(await showConfirm(`Smazat swing obchod ${t.symbol||''} z ${fmtLocal(t.openedAt)}?`,{title:'Smazat obchod',ok:'Smazat'})))return;
 await commitJournal(j=>{j.trades=(j.trades||[]).filter(x=>x?.id!==id)});
 await load();
}

// ---------- záložka Pozice/Příkazy ----------
function renderSwingPositions(){
 const target=$('swingOpenPositions');
 if(!target)return;
 const rows=swingOpenPositions().sort((a,b)=>String(a.openedAt).localeCompare(String(b.openedAt)));
 target.innerHTML=rows.length?rows.map(t=>{
  const d=swingDerivedOf(t);
  const age=FJSwing.instantOf(t.openedAt);
  const days=age!=null?(Date.now()-age)/864e5:null;
  return `<tr>
   <td><b>${esc(t.symbol)}</b>${t.swingSetup?`<div class="sub">${esc(t.swingSetup)}</div>`:''}</td>
   <td>${dirPill(t.direction)}</td>
   <td>${fmtLocal(t.openedAt)}<div class="sub">${days!=null?fmtNum(days,1)+' d':''}</div></td>
   <td>${fmtPrice(t.entryPrice,t.symbol)}</td>
   <td>${fmtPrice(t.slInitial,t.symbol)}<div class="sub">aktuální ${fmtPrice(d.currentSl,t.symbol)}</div></td>
   <td>${fmtNum(d.remainingVolume??t.volume,4)}${(t.exits||[]).length?`<div class="sub">z ${fmtNum(t.volume,4)}</div>`:''}</td>
   <td>${t.riskAmount!=null?fmtMoney(t.riskAmount):'—'}</td>
   <td class="swing-actions"><button class="btn" data-swing-exit="${esc(t.id)}">＋ Výstup</button><button class="btn" data-swing-sl="${esc(t.id)}">Posunout SL</button><button class="btn" data-swing-edit="${esc(t.id)}">Upravit</button></td>
  </tr>`;
 }).join(''):'<tr><td colspan="8" class="sub">Žádná otevřená swing pozice. Novou otevřeš tlačítkem „＋ Otevřít pozici“.</td></tr>';
 wireSwingButtons(target);
}

// Ruční limitky deníku + limitky z cTraderu (MCP, jen čtení).
const MCP_SETTINGS_KEY='FJ_ctraderMcp';
function mcpSettings(){
 try{const v=JSON.parse(localStorage.getItem(MCP_SETTINGS_KEY)||'{}');return {enabled:v.enabled===true,url:typeof v.url==='string'&&v.url?v.url:'http://127.0.0.1:9876/mcp/'}}catch{return {enabled:false,url:'http://127.0.0.1:9876/mcp/'}}
}
function setMcpSettings(patch){try{localStorage.setItem(MCP_SETTINGS_KEY,JSON.stringify({...mcpSettings(),...patch}))}catch{}}
let mcpState={available:null,orders:[],account:null,fetchedAt:null};
let mcpTimer=null;
async function refreshMcpOrders(){
 const s=mcpSettings();
 if(!s.enabled||!window.desktopAPI?.ctraderPendingOrders){mcpState={available:null,orders:[],account:null,fetchedAt:null};renderPendingOrders();return}
 try{
  const r=await window.desktopAPI.ctraderPendingOrders(s.url);
  mcpState=r?.available?{available:true,orders:(r.orders||[]).map(FJSwing.pendingFromMcp).filter(Boolean),account:r.account||null,fetchedAt:r.fetchedAt}:{available:false,orders:[],account:null,fetchedAt:null,error:r?.error||null};
 }catch{mcpState={available:false,orders:[],account:null,fetchedAt:null}}
 renderPendingOrders();
}
function positionsTabOpen(){return $('openPositions')?.classList.contains('active')}
function startMcpPolling(){
 stopMcpPolling();
 void refreshMcpOrders();
 mcpTimer=setInterval(()=>{if(positionsTabOpen())void refreshMcpOrders();else stopMcpPolling()},60000);
}
function stopMcpPolling(){if(mcpTimer){clearInterval(mcpTimer);mcpTimer=null}}
function manualPendingOrders(){return (Array.isArray(db?.data?.pendingOrders)?db.data.pendingOrders:[]).map(o=>FJSwing.sanitizePendingOrder(o,o.placedAt)).filter(Boolean)}
function renderPendingOrders(){
 const target=$('pendingOrdersRows');
 if(!target)return;
 const s=mcpSettings();
 const status=$('mcpOrdersStatus');
 if(status){
  if(!s.enabled)status.innerHTML='Limitky z cTraderu jsou vypnuté (Integrace → cTrader → „Limitky z cTraderu přes MCP“).';
  else if(mcpState.available===null)status.textContent='cTrader: načítám…';
  else if(!mcpState.available)status.innerHTML='<span title="Zapni v cTraderu Settings → Advanced → MCP server → Enable MCP server">cTrader nevypadá spuštěný (MCP server neodpovídá).</span>';
  else{const a=mcpState.account||{};status.textContent=`cTrader: ${mcpState.orders.length} limitek · aktivní účet ${a.broker||'?'} · ${a.currency||''} · zůstatek ${fmtNum(a.balance)} · načteno ${new Date(mcpState.fetchedAt).toLocaleTimeString('cs-CZ')}`}
 }
 const rows=[...manualPendingOrders(),...(s.enabled&&mcpState.available?mcpState.orders:[])];
 target.innerHTML=rows.length?rows.map(o=>`<tr>
  <td><span class="src-pill">${o.source==='CTRADER'?'cTrader':'ručně'}</span></td>
  <td><b>${esc(o.symbol)}</b>${o.note?`<div class="sub">${esc(o.note)}</div>`:''}</td>
  <td>${dirPill(o.direction)}</td>
  <td>${o.orderType==='STOP'?'Stop':'Limit'}</td>
  <td>${fmtPrice(o.price,o.symbol)}${o.currentPrice!=null?`<div class="sub">teď ${fmtPrice(o.currentPrice,o.symbol)}</div>`:''}</td>
  <td>${fmtPrice(o.sl,o.symbol)}</td>
  <td>${fmtPrice(o.tp,o.symbol)}</td>
  <td>${fmtNum(o.volume,4)}</td>
  <td>${o.placedAt?fmtLocal(o.placedAt):'—'}</td>
  <td>${o.expiresAt?fmtLocal(o.expiresAt):'—'}</td>
  <td class="swing-actions">
   <button class="btn" data-order-filled="${esc(o.id)}" title="Limitka se naplnila – předvyplní novou pozici">Naplněno</button>
   <button class="btn" data-order-nofill="${esc(o.id)}" title="Limitka zmizela bez naplnění – předvyplní setup bez vstupu (nenaplněno)">Nenaplněno</button>
   ${o.source==='MANUAL'?`<button class="btn" data-order-edit="${esc(o.id)}">Upravit</button><button class="btn danger" data-order-del="${esc(o.id)}">🗑️</button>`:''}
  </td></tr>`).join(''):'<tr><td colspan="11" class="sub">Žádné čekající příkazy.</td></tr>';
 const byId=id=>rows.find(o=>o.id===id);
 target.querySelectorAll('[data-order-filled]').forEach(b=>b.onclick=()=>orderToTrade(byId(b.dataset.orderFilled),true));
 target.querySelectorAll('[data-order-nofill]').forEach(b=>b.onclick=()=>orderToTrade(byId(b.dataset.orderNofill),false));
 target.querySelectorAll('[data-order-edit]').forEach(b=>b.onclick=()=>openOrderModal(byId(b.dataset.orderEdit)));
 target.querySelectorAll('[data-order-del]').forEach(b=>b.onclick=()=>void deletePendingOrder(byId(b.dataset.orderDel)));
}
// Naplněno / Nenaplněno: jen předvyplní formulář. Uloží až uživatel; ruční limitka se
// ze seznamu odebere se stejným zápisem (jen ve swing deníku – futures formulář ji nezná).
function orderToTrade(o,filled){
 if(!o)return;
 if(isSwingJournalActive()){
  openSwingModal(FJSwing.draftFromPendingOrder(o,filled),{fromOrder:o.source==='MANUAL'?o.id:null,title:filled?'Otevřít pozici z limitky':'Nenaplněná limitka'});
  return;
 }
 const date=(FJSwing.splitLocal(o.placedAt)||{}).date||new Date().toISOString().slice(0,10);
 if(filled){
  openModal({instrument:o.symbol,side:o.direction,entryPrice:o.price,slPrice:o.sl,targetLevel1:o.tp!=null?{price:o.tp,types:[]}:undefined,contracts:o.volume,date},{title:'Nový obchod z limitky'});
 }else{
  openSetupModal({instrument:o.symbol,side:o.direction,plannedEntryPrice:o.price,slPrice:o.sl,targetLevel1:o.tp!=null?{price:o.tp,types:[]}:undefined,fillStatus:'NO_FILL',date,entryTime:(FJSwing.splitLocal(o.placedAt)||{}).time||''});
 }
 if(o.source==='MANUAL')showToast('Po uložení obchodu limitku smaž ze seznamu Příkazy (🗑️).');
}
async function deletePendingOrder(o){
 if(!o)return;
 if(!(await showConfirm(`Smazat limitku ${o.symbol} @ ${fmtPrice(o.price,o.symbol)}?`,{title:'Smazat limitku',ok:'Smazat'})))return;
 await commitJournal(j=>{j.pendingOrders=(j.pendingOrders||[]).filter(x=>x?.id!==o.id)});
 renderPendingOrders();
}

function renderPositionsTab(){
 renderSwingPositions();
 renderPendingOrders();
}

// ---------- modal: ruční limitka ----------
function ensureOrderModal(){
 if($('orderModal'))return;
 const m=document.createElement('div');m.className='modal';m.id='orderModal';
 m.innerHTML=`<div class="modalbox" style="max-width:640px">
  <div class="modalhead"><h2 id="orderModalTitle">Ruční limitka</h2><button class="icon" id="orderModalClose">✕</button></div>
  <input type="hidden" id="ofId">
  <div class="swing-grid">
   <div class="field"><label>Symbol</label><input id="ofSymbol" list="swingSymbolList" autocomplete="off"></div>
   <div class="field"><label>Směr</label><select id="ofDirection"><option value="long">Long (buy)</option><option value="short">Short (sell)</option></select></div>
   <div class="field"><label>Typ</label><select id="ofType"><option value="LIMIT">Limit</option><option value="STOP">Stop</option></select></div>
   <div class="field"><label>Cena</label><input id="ofPrice" type="number" step="any"></div>
   <div class="field"><label>SL</label><input id="ofSl" type="number" step="any"></div>
   <div class="field"><label>TP</label><input id="ofTp" type="number" step="any"></div>
   <div class="field"><label>Objem (loty)</label><input id="ofVolume" type="number" step="any" min="0"></div>
   <div class="field"><label>Zadáno</label><input id="ofPlaced" type="datetime-local"></div>
   <div class="field"><label>Expirace</label><input id="ofExpires" type="datetime-local"></div>
  </div>
  <div class="field"><label>Poznámka</label><input id="ofNote" maxlength="500"></div>
  <div id="ofError" class="alert red" style="display:none"></div>
  <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn" id="ofCancel">Zrušit</button><button class="btn primary" id="ofSave">Uložit</button></div>
 </div>`;
 document.body.appendChild(m);
 const close=()=>m.classList.remove('open');
 $('orderModalClose').onclick=close;$('ofCancel').onclick=close;
 m.addEventListener('click',e=>{if(e.target===m)close()});
 m.addEventListener('keydown',e=>{if(e.key==='Escape')close();if(e.key==='Enter'&&(e.ctrlKey||e.target.tagName==='INPUT')){e.preventDefault();void saveOrderModal()}});
 $('ofSave').onclick=()=>void saveOrderModal();
}
function openOrderModal(o){
 ensureOrderModal();ensureSymbolList();
 const x=o||{};
 $('orderModalTitle').textContent=o?'Upravit limitku':'Nová ruční limitka';
 $('ofId').value=x.id||'';
 $('ofSymbol').value=x.symbol||'';$('ofDirection').value=x.direction||'long';$('ofType').value=x.orderType||'LIMIT';
 for(const [id,k] of [['ofPrice','price'],['ofSl','sl'],['ofTp','tp'],['ofVolume','volume']])$(id).value=x[k]!=null?x[k]:'';
 $('ofPlaced').value=x.placedAt||FJSwing.berlinNowLocal();$('ofExpires').value=x.expiresAt||'';$('ofNote').value=x.note||'';
 $('ofError').style.display='none';
 $('orderModal').classList.add('open');
 setTimeout(()=>$('ofSymbol').focus(),30);
}
async function saveOrderModal(){
 const raw={id:$('ofId').value||undefined,source:'MANUAL',symbol:$('ofSymbol').value,direction:$('ofDirection').value,orderType:$('ofType').value,
  price:$('ofPrice').value,sl:$('ofSl').value,tp:$('ofTp').value,volume:$('ofVolume').value,placedAt:$('ofPlaced').value,expiresAt:$('ofExpires').value,note:$('ofNote').value};
 const o=FJSwing.sanitizePendingOrder(raw);
 const err=$('ofError');
 if(!o){err.textContent='Zadej symbol.';err.style.display='block';return}
 if(o.price==null){err.textContent='Zadej cenu limitky.';err.style.display='block';return}
 await commitJournal(j=>{
  const list=Array.isArray(j.pendingOrders)?j.pendingOrders:(j.pendingOrders=[]);
  const i=list.findIndex(x=>x?.id===o.id);
  if(i>=0)list[i]=o;else list.push(o);
 });
 $('orderModal').classList.remove('open');
 renderPendingOrders();
}

// ---------- modal: swing obchod (Otevřít pozici / Přidat výstup / Posunout SL) ----------
function ensureSymbolList(){
 let dl=$('swingSymbolList');
 if(!dl){dl=document.createElement('datalist');dl.id='swingSymbolList';document.body.appendChild(dl)}
 dl.innerHTML=swingInstruments().map(i=>`<option value="${esc(i.symbol)}">`).join('');
 let sl=$('swingSetupList');
 if(!sl){sl=document.createElement('datalist');sl.id='swingSetupList';document.body.appendChild(sl)}
 const used=[...new Set(swingRows().map(t=>t.swingSetup).filter(Boolean))];
 sl.innerHTML=[...new Set([...FJSwing.SWING_SETUP_SUGGESTIONS,...used])].map(s=>`<option value="${esc(s)}">`).join('');
}
const reasonOptions=(list,labels,val)=>['',...list].map(k=>`<option value="${k}" ${k===(val||'')?'selected':''}>${k?esc(labels[k]):'—'}</option>`).join('');
function exitRowHTML(e={}){
 return `<div class="swing-row" data-row="exit">
  <div class="field"><label>Uzavřeno</label><input type="datetime-local" data-k="closedAt" value="${esc(e.closedAt||'')}"></div>
  <div class="field"><label>Cena</label><input type="number" step="any" data-k="price" value="${e.price??''}" style="width:110px"></div>
  <div class="field"><label>Objem</label><input type="number" step="any" min="0" data-k="volume" value="${e.volume??''}" style="width:90px"></div>
  <div class="field"><label>Důvod</label><select data-k="reason">${reasonOptions(FJSwing.EXIT_REASONS,FJSwing.EXIT_REASON_LABELS,e.reason)}</select></div>
  <div class="field"><label>P/L</label><input type="number" step="any" data-k="pnl" value="${e.pnl??''}" style="width:95px" title="Z výpisu brokera se znaménkem"></div>
  <div class="field"><label>Swap</label><input type="number" step="any" data-k="swap" value="${e.swap??''}" style="width:85px" title="Se znaménkem jako u brokera (náklad = záporné)"></div>
  <div class="field"><label>Komise</label><input type="number" step="any" data-k="commission" value="${e.commission??''}" style="width:85px" title="Se znaménkem jako u brokera (náklad = záporné)"></div>
  <button class="btn" type="button" data-remove-row title="Odebrat">✕</button></div>`;
}
function slRowHTML(m={}){
 return `<div class="swing-row" data-row="sl">
  <div class="field"><label>Kdy</label><input type="datetime-local" data-k="at" value="${esc(m.at||'')}"></div>
  <div class="field"><label>Nový SL</label><input type="number" step="any" data-k="price" value="${m.price??''}" style="width:120px"></div>
  <div class="field"><label>Důvod</label><select data-k="reason">${reasonOptions(FJSwing.SL_MOVE_REASONS,FJSwing.SL_MOVE_REASON_LABELS,m.reason)}</select></div>
  ${m.timeApprox?'<span class="sub" title="Čas posunu není přesný (zjištěno při synchronizaci)">≈ čas</span>':''}
  <button class="btn" type="button" data-remove-row title="Odebrat">✕</button></div>`;
}
function targetRowHTML(g={}){
 return `<div class="swing-row" data-row="target">
  <div class="field"><label>Cíl</label><input type="number" step="any" data-k="price" value="${g.price??''}" style="width:120px"></div>
  <div class="field"><label>Typ hladiny</label><input data-k="levelType" value="${esc(g.levelType||'')}" placeholder="VPOC 4h, Gap…"></div>
  <button class="btn" type="button" data-remove-row title="Odebrat">✕</button></div>`;
}
function ensureSwingModal(){
 if($('swingModal'))return;
 const m=document.createElement('div');m.className='modal swing-modal';m.id='swingModal';
 m.innerHTML=`<div class="modalbox">
  <div class="modalhead"><h2 id="swingModalTitle">Otevřít pozici</h2><button class="icon" id="swingModalClose">✕</button></div>
  <input type="hidden" id="swId">
  <div class="swing-grid">
   <div class="field"><label>Symbol</label><input id="swSymbol" list="swingSymbolList" autocomplete="off"></div>
   <div class="field" id="swPipBox" style="display:none"><label>Pip size (neznámý symbol)</label><input id="swPipSize" type="number" step="any" min="0" placeholder="např. 0.0001"><div class="sub">Uloží se do tabulky CFD instrumentů.</div></div>
   <div class="field"><label>Směr</label><select id="swDirection"><option value="long">Long</option><option value="short">Short</option></select></div>
   <div class="field"><label>Otevřeno (Berlín)</label><input id="swOpenedAt" type="datetime-local"></div>
   <div class="field"><label>Vstup</label><input id="swEntry" type="number" step="any"></div>
   <div class="field"><label>Objem (loty)</label><input id="swVolume" type="number" step="any" min="0"></div>
   <div class="field"><label>SL při otevření</label><input id="swSlInitial" type="number" step="any" title="Základ R – nikdy se nepřepisuje posunem SL"></div>
   <div class="field"><label>Riziko (peníze)</label><input id="swRisk" type="number" step="any" min="0" title="Kolik stojí plný SL podle platformy brokera"></div>
   <div class="field"><label>Záznam</label><select id="swRecordType"><option value="">Obchod</option><option value="SETUP_ONLY">Setup bez vstupu (nenaplněno)</option></select></div>
  </div>
  <div class="swing-section"><h3>Plánované cíle <button class="btn" type="button" id="swAddTarget">＋ cíl</button></h3><div class="swing-rows" id="swTargets"></div></div>
  <div class="swing-section"><h3>Výstupy <button class="btn" type="button" id="swAddExit">＋ výstup</button></h3><div class="sub">P/L, swap a komisi opiš z výpisu brokera se znaménkem. Netto = P/L + swap + komise.</div><div class="swing-rows" id="swExits"></div></div>
  <div class="swing-section"><h3>Posuny SL <button class="btn" type="button" id="swAddSl">＋ posun SL</button></h3><div class="swing-rows" id="swSlMoves"></div></div>
  <div class="swing-section"><h3>Kontext</h3>
   <div class="swing-grid">
    <div class="field"><label>Setup</label><input id="swSetup" list="swingSetupList" autocomplete="off"></div>
    <div class="field"><label>Známka</label><select id="swGrade"><option value="">—</option><option>A</option><option>B</option><option>C</option></select></div>
    <div class="field"><label>MAE (pipy)</label><input id="swMae" type="number" step="any"></div>
    <div class="field"><label>MFE (pipy)</label><input id="swMfe" type="number" step="any"></div>
    <div class="field"><label>Nejdéle v mínusu (dny)</label><input id="swDaysAgainst" type="number" step="any" min="0"></div>
   </div>
   <div class="field"><label>Komentář</label><textarea id="swComment" rows="3"></textarea></div>
   <div class="field"><label>Screenshoty (daily + 4h při vstupu; vložení Ctrl+V)</label><input id="swImageInput" type="file" accept="image/*" multiple><div class="swing-imgs" id="swImages"></div></div>
  </div>
  <div class="swing-derived" id="swDerived"></div>
  <div id="swError" class="alert red" style="display:none"></div>
  <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><span class="sub" style="margin-right:auto">Ctrl+Enter uloží · Esc zavře</span><button class="btn" id="swCancel">Zrušit</button><button class="btn primary" id="swSave">Uložit</button></div>
 </div>`;
 document.body.appendChild(m);
 const close=()=>m.classList.remove('open');
 $('swingModalClose').onclick=close;$('swCancel').onclick=close;
 m.addEventListener('click',e=>{if(e.target===m)close()});
 m.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close()}if(e.key==='Enter'&&e.ctrlKey){e.preventDefault();void saveSwingModal()}});
 $('swSave').onclick=()=>void saveSwingModal();
 const add=(box,html)=>{$(box).insertAdjacentHTML('beforeend',html);wireRows();return $(box).lastElementChild};
 $('swAddExit').onclick=()=>focusRow(add('swExits',exitRowHTML(newExitDefaults())));
 $('swAddSl').onclick=()=>focusRow(add('swSlMoves',slRowHTML({at:FJSwing.berlinNowLocal()})));
 $('swAddTarget').onclick=()=>focusRow(add('swTargets',targetRowHTML()));
 m.addEventListener('input',()=>renderSwingDerivedPreview());
 m.addEventListener('change',()=>renderSwingDerivedPreview());
 $('swSymbol').addEventListener('input',updatePipBox);
 $('swImageInput').onchange=async e=>{for(const f of [...e.target.files])await addSwingImageFile(f);e.target.value=''};
 document.addEventListener('paste',async e=>{
  if(!m.classList.contains('open'))return;
  const items=[...((e.clipboardData||{}).items||[])].filter(it=>it.type&&it.type.startsWith('image/'));
  if(!items.length)return;
  e.preventDefault();e.stopImmediatePropagation();
  for(const it of items){const f=it.getAsFile();if(f)await addSwingImageFile(f)}
 },true);
}
let swingEditImages=[];
let swingFromOrder=null;
// Návrh nového obchodu (z limitky): pole, která formulář nemá (orderPlacedAt, orderPrice, fillStatus), se uloží s ním.
let swingDraftBase=null;
async function addSwingImageFile(file){
 if(swingEditImages.length>=4){showToast('Swing obchod může mít nejvýše 4 obrázky.');return}
 if(file.size>3_000_000){showToast('Obrázek je větší než 3 MB.');return}
 const data=await new Promise(res=>{const r=new FileReader();r.onload=()=>res(r.result);r.readAsDataURL(file)});
 const ref=await storeScreenshot(data);
 if(ref){swingEditImages.push(ref);renderSwingImages()}
}
function renderSwingImages(){
 $('swImages').innerHTML=swingEditImages.map((r,i)=>`<div class="img-wrap">${thumbImgHTML(r)}<button class="btn" type="button" data-img-del="${i}">✕</button></div>`).join('');
 $('swImages').querySelectorAll('[data-img-del]').forEach(b=>b.onclick=()=>{swingEditImages.splice(Number(b.dataset.imgDel),1);renderSwingImages()});
}
function wireRows(){
 $('swingModal').querySelectorAll('[data-remove-row]').forEach(b=>b.onclick=()=>{b.closest('.swing-row').remove();renderSwingDerivedPreview()});
}
function focusRow(row){setTimeout(()=>row?.querySelector('input')?.focus(),20);renderSwingDerivedPreview()}
function newExitDefaults(){
 const draft=readSwingForm();
 const remaining=FJSwing.swingDerived(draft,null).remainingVolume;
 return {closedAt:FJSwing.berlinNowLocal(),volume:remaining!=null&&remaining>0?remaining:''};
}
function updatePipBox(){
 const sym=$('swSymbol').value.trim();
 $('swPipBox').style.display=sym&&!swingInstrumentOf(sym)?'':'none';
}
function openSwingModal(t,{focus,fromOrder,title}={}){
 ensureSwingModal();ensureSymbolList();
 const x=t||{};
 swingFromOrder=fromOrder||null;
 swingDraftBase=!x.id&&t?{orderPlacedAt:x.orderPlacedAt??undefined,orderPrice:x.orderPrice??undefined,fillStatus:x.fillStatus??undefined}:null;
 $('swingModalTitle').textContent=title||(x.id?(focus==='exit'?'Přidat výstup':focus==='sl'?'Posunout SL':'Upravit swing obchod'):'Otevřít pozici');
 $('swId').value=x.id||'';
 $('swSymbol').value=x.symbol||'';$('swDirection').value=x.direction||'long';
 $('swOpenedAt').value=x.openedAt||FJSwing.berlinNowLocal();
 for(const [id,k] of [['swEntry','entryPrice'],['swVolume','volume'],['swSlInitial','slInitial'],['swRisk','riskAmount'],['swMae','maePips'],['swMfe','mfePips'],['swDaysAgainst','maxDaysAgainst']])$(id).value=x[k]!=null?x[k]:'';
 $('swRecordType').value=x.recordType==='SETUP_ONLY'?'SETUP_ONLY':'';
 $('swSetup').value=x.swingSetup||'';$('swGrade').value=x.grade||'';$('swComment').value=x.comment||'';
 $('swPipSize').value='';
 $('swTargets').innerHTML=(x.targetsPlanned||[]).map(targetRowHTML).join('');
 $('swExits').innerHTML=(x.exits||[]).slice().sort((a,b)=>String(a.closedAt).localeCompare(String(b.closedAt))).map(exitRowHTML).join('');
 $('swSlMoves').innerHTML=(x.slMoves||[]).map(slRowHTML).join('');
 swingEditImages=[...(x.images||[])];
 renderSwingImages();wireRows();updatePipBox();
 $('swError').style.display='none';
 $('swingModal').classList.add('open');
 if(focus==='exit')focusRow((()=>{$('swExits').insertAdjacentHTML('beforeend',exitRowHTML(newExitDefaults()));wireRows();return $('swExits').lastElementChild})());
 else if(focus==='sl')focusRow((()=>{$('swSlMoves').insertAdjacentHTML('beforeend',slRowHTML({at:FJSwing.berlinNowLocal()}));wireRows();return $('swSlMoves').lastElementChild})());
 else setTimeout(()=>$('swSymbol').focus(),30);
 renderSwingDerivedPreview();
}
const numOrNull=v=>{if(v===null||v===undefined||String(v).trim()==='')return null;const n=Number(v);return Number.isFinite(n)?n:null};
function readRows(box,keys){
 return [...$(box).querySelectorAll('.swing-row')].map(r=>{const o={};for(const k of keys){const el=r.querySelector(`[data-k="${k}"]`);o[k]=el?el.value:''}return o});
}
function readSwingForm(){
 const id=$('swId').value;
 const existing=id?findSwing(id):null;
 const exits=readRows('swExits',['closedAt','price','volume','reason','pnl','swap','commission'])
  .filter(e=>e.closedAt||e.price||e.volume||e.pnl)
  .map(e=>({closedAt:e.closedAt||null,price:numOrNull(e.price),volume:numOrNull(e.volume),reason:FJSwing.EXIT_REASONS.includes(e.reason)?e.reason:null,pnl:numOrNull(e.pnl),swap:numOrNull(e.swap),commission:numOrNull(e.commission)}));
 const prevMoves=existing?.slMoves||[];
 const slMoves=readRows('swSlMoves',['at','price','reason']).filter(m=>m.price!=='')
  .map(m=>{const prev=prevMoves.find(p=>p.at===m.at&&Number(p.price)===Number(m.price));return {at:m.at||null,price:numOrNull(m.price),reason:FJSwing.SL_MOVE_REASONS.includes(m.reason)?m.reason:null,...(prev?.timeApprox?{timeApprox:true}:{})}});
 const targetsPlanned=readRows('swTargets',['price','levelType']).filter(g=>g.price!==''||g.levelType).map(g=>({price:numOrNull(g.price),levelType:String(g.levelType||'').trim()}));
 const recordType=$('swRecordType').value==='SETUP_ONLY'?'SETUP_ONLY':undefined;
 const out={
  ...(existing||swingDraftBase||{}),
  kind:'SWING', source:existing?.source||'MANUAL',
  symbol:FJSwing.normalizeSymbol($('swSymbol').value), direction:$('swDirection').value==='short'?'short':'long',
  openedAt:$('swOpenedAt').value||null, entryPrice:numOrNull($('swEntry').value), volume:numOrNull($('swVolume').value),
  slInitial:numOrNull($('swSlInitial').value), riskAmount:numOrNull($('swRisk').value),
  targetsPlanned, exits:recordType?[]:exits, slMoves:recordType?[]:slMoves,
  swingSetup:$('swSetup').value.trim(), grade:['A','B','C'].includes($('swGrade').value)?$('swGrade').value:'',
  maePips:numOrNull($('swMae').value), mfePips:numOrNull($('swMfe').value), maxDaysAgainst:numOrNull($('swDaysAgainst').value),
  comment:$('swComment').value, images:[...swingEditImages], currency:swingCurrency()
 };
 if(recordType){out.recordType='SETUP_ONLY';out.fillStatus=out.fillStatus||'NO_FILL'}else{delete out.recordType;if(out.fillStatus==='NO_FILL')delete out.fillStatus}
 out.date=FJSwing.swingListDate(out);
 return out;
}
function renderSwingDerivedPreview(){
 if(!$('swDerived'))return;
 const t=readSwingForm();
 const instr=swingInstrumentOf(t.symbol)||(numOrNull($('swPipSize').value)>0?{pipSize:numOrNull($('swPipSize').value)}:null);
 const d=FJSwing.swingDerived(t,instr);
 const missing=FJSwing.swingMissing(t);
 $('swDerived').innerHTML=[
  `Stav: <b>${t.recordType==='SETUP_ONLY'?'setup bez vstupu':d.status==='OPEN'?'otevřená':'uzavřená'}</b>`,
  `SL: <b>${fmtNum(d.slPips,1)}</b> pipů`,
  d.remainingVolume!=null?`Zbývá objem: <b>${fmtNum(d.remainingVolume,4)}</b>`:'',
  `R z ceny: <b>${d.rPrice!=null?fmtNum(d.rPrice,2):'—'}</b>`,
  d.pnlNetTotal!=null?`Netto: <b>${fmtMoney(d.pnlNetTotal)}</b>`:'',
  d.rMoney!=null?`R z peněz: <b>${fmtNum(d.rMoney,2)}</b>`:'',
  d.volumeError?'<span class="neg"><b>Součet objemů výstupů je větší než objem pozice.</b></span>':'',
  missing.length?`<span style="color:var(--orange)">Neúplné: ${esc(missing.map(k=>FJSwing.MISSING_LABELS[k]).join(', '))}</span>`:''
 ].filter(Boolean).join(' · ');
}
async function saveSwingModal(){
 const t=readSwingForm();
 const err=$('swError');
 const fail=m=>{err.textContent=m;err.style.display='block'};
 if(!t.symbol)return fail('Zadej symbol.');
 if(!FJSwing.splitLocal(t.openedAt))return fail('Zadej datum a čas otevření.');
 if(t.recordType!=='SETUP_ONLY'&&(t.entryPrice==null||t.volume==null))return fail('Zadej vstupní cenu a objem.');
 // neznámý symbol → do tabulky CFD instrumentů (jen když uživatel zadal pip size)
 const pip=numOrNull($('swPipSize').value);
 if(!swingInstrumentOf(t.symbol)&&pip>0){
  const list=Array.isArray(settings.cfdInstruments)?settings.cfdInstruments:[];
  await persistSettings({cfdInstruments:[...list,{symbol:t.symbol,pipSize:pip,priceDecimals:null,assetClass:'OTHER'}]});
 }
 const now=new Date().toISOString();
 if(!t.id){t.id='sw_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);t.createdAt=now}
 t.updatedAt=now;
 await nameRecordImages(t,{journalId:activeJournalId,key:t.id},{date:t.date,entryTime:(FJSwing.splitLocal(t.openedAt)||{}).time||'',instrument:t.symbol,side:t.direction,recordType:t.recordType});
 const orderId=swingFromOrder;
 await commitJournal(j=>{
  const rows=j.trades||(j.trades=[]);
  const i=rows.findIndex(x=>x?.id===t.id);
  if(i>=0)rows[i]=t;else rows.push(t);
  if(orderId)j.pendingOrders=(j.pendingOrders||[]).filter(o=>o?.id!==orderId);
 });
 swingFromOrder=null;swingDraftBase=null;
 $('swingModal').classList.remove('open');
 await load();
 showToast(t.recordType==='SETUP_ONLY'?'Setup bez vstupu uložen.':'Swing obchod uložen.');
}

// ---------- Nastavení: měna a CFD instrumenty, cTrader MCP ----------
function renderSwingSettings(){
 const anchor=$('templateList')?.closest('.card');
 if(anchor&&!$('swingSettingsCard')){
  const c=document.createElement('div');c.className='card swing-only';c.id='swingSettingsCard';c.style.marginTop='16px';
  anchor.insertAdjacentElement('afterend',c);
 }
 const card=$('swingSettingsCard');
 if(card){
  const list=swingInstruments();
  card.innerHTML=`<h2>Swing · CFD</h2>
   <div class="field" style="max-width:240px"><label>Měna účtu</label><select id="swingCurrencySelect">${FJSwing.CURRENCIES.map(c=>`<option ${c===swingCurrency()?'selected':''}>${c}</option>`).join('')}</select><div class="sub">Peníze se do swing deníku opisují z výpisu brokera v této měně.</div></div>
   <h3 style="margin-top:14px">CFD instrumenty</h3>
   <div class="sub">Deník potřebuje jen velikost pipu (pipy a R z cen). Hodnota pipu ani ticku se nezadává. Výchozí řádky jdou upravit; nic se nemaže.</div>
   <div class="table-scroll" style="margin-top:8px"><table><thead><tr><th>Symbol</th><th>Pip size</th><th>Desetinná místa</th><th>Třída</th><th>Base</th><th>Quote</th><th></th></tr></thead><tbody>
   ${list.map(i=>`<tr data-cfd="${esc(i.symbol)}"><td><b>${esc(i.symbol)}</b>${i.builtin?'':' <span class="sub">vlastní</span>'}</td>
    <td><input type="number" step="any" min="0" data-cfdk="pipSize" value="${i.pipSize??''}" style="width:100px"></td>
    <td><input type="number" step="1" min="0" data-cfdk="priceDecimals" value="${i.priceDecimals??''}" style="width:70px"></td>
    <td><select data-cfdk="assetClass">${FJSwing.ASSET_CLASSES.map(a=>`<option ${a===i.assetClass?'selected':''}>${a}</option>`).join('')}</select></td>
    <td><input data-cfdk="baseCcy" value="${esc(i.baseCcy||'')}" style="width:60px"></td>
    <td><input data-cfdk="quoteCcy" value="${esc(i.quoteCcy||'')}" style="width:60px"></td>
    <td><button class="btn" type="button" data-cfd-save="${esc(i.symbol)}">Uložit</button></td></tr>`).join('')}
   </tbody></table></div>
   <div class="swing-row" style="margin-top:10px">
    <div class="field"><label>Nový symbol</label><input id="cfdNewSymbol" placeholder="např. BTCUSD"></div>
    <div class="field"><label>Pip size</label><input id="cfdNewPip" type="number" step="any" min="0" style="width:100px"></div>
    <div class="field"><label>Desetinná místa</label><input id="cfdNewDec" type="number" step="1" min="0" style="width:70px"></div>
    <button class="btn" type="button" id="cfdAdd">＋ Přidat</button>
   </div>`;
  $('swingCurrencySelect').onchange=e=>void persistSettings({swingCurrency:e.target.value});
  const upsert=async row=>{
   const i=FJSwing.sanitizeInstrument(row);if(!i)return;
   const stored=(Array.isArray(settings.cfdInstruments)?settings.cfdInstruments:[]).filter(x=>FJSwing.normalizeSymbol(x?.symbol)!==i.symbol);
   await persistSettings({cfdInstruments:[...stored,i]});
   renderSwingSettings();showToast(`Instrument ${i.symbol} uložen.`);
  };
  card.querySelectorAll('[data-cfd-save]').forEach(b=>b.onclick=()=>{
   const tr=b.closest('tr');const row={symbol:tr.dataset.cfd};
   tr.querySelectorAll('[data-cfdk]').forEach(el=>row[el.dataset.cfdk]=el.value);
   void upsert(row);
  });
  $('cfdAdd').onclick=()=>{const s=$('cfdNewSymbol').value.trim();if(!s)return;void upsert({symbol:s,pipSize:$('cfdNewPip').value,priceDecimals:$('cfdNewDec').value,assetClass:'OTHER'})};
 }
 renderMcpSettings();
}
function renderMcpSettings(){
 const host=$('capCtrader');
 if(!host)return;
 let card=$('ctraderMcpCard');
 if(!card){card=document.createElement('div');card.className='card';card.id='ctraderMcpCard';card.style.marginTop='16px';host.appendChild(card)}
 const s=mcpSettings();
 card.innerHTML=`<h2>Limitky z cTraderu přes MCP (jen čtení)</h2>
  <div class="sub">Deník čte čekající příkazy přímo z běžícího cTrader Desktopu a ukáže je v záložce <b>Pozice/Příkazy</b>. Nic se do cTraderu neposílá a nic se nezapisuje do deníku.
  V cTraderu jednou zapni <b>Settings → Advanced → MCP server → Enable MCP server</b> a nech <b>Allow trading via MCP vypnuté</b>. Seznam patří účtu, který je v cTraderu právě aktivní.</div>
  <div class="swing-row" style="margin-top:10px">
   <div class="field"><label>Načítat limitky z cTraderu</label><select id="mcpEnabled"><option value="ne">Ne</option><option value="ano" ${s.enabled?'selected':''}>Ano</option></select></div>
   <div class="field" style="flex:1"><label>Adresa MCP serveru</label><input id="mcpUrl" value="${esc(s.url)}"></div>
   <button class="btn" type="button" id="mcpTest">Vyzkoušet</button>
  </div><div class="sub" id="mcpTestResult"></div>`;
 $('mcpEnabled').onchange=e=>{setMcpSettings({enabled:e.target.value==='ano'});void refreshMcpOrders()};
 $('mcpUrl').onchange=e=>{setMcpSettings({url:e.target.value.trim()});void refreshMcpOrders()};
 $('mcpTest').onclick=async()=>{
  const r=await window.desktopAPI?.ctraderPendingOrders?.($('mcpUrl').value.trim());
  $('mcpTestResult').textContent=r?.available?`OK – ${r.orders.length} čekajících příkazů, aktivní účet ${r.account?.broker||'?'} (${r.account?.currency||''}).`:`cTrader neodpovídá${r?.error?' ('+r.error+')':''}.`;
 };
}

// ---------- napojení na hlavní skript ----------
(function wireSwingUi(){
 const navBtn=document.querySelector('.nav [data-section="openPositions"]');
 if(navBtn)navBtn.addEventListener('click',()=>{renderPositionsTab();if(mcpSettings().enabled)startMcpPolling()});
 document.querySelectorAll('.nav [data-section]').forEach(b=>{if(b!==navBtn)b.addEventListener('click',stopMcpPolling)});
 $('addManualOrderBtn')?.addEventListener('click',()=>openOrderModal(null));
 $('addSwingPositionBtn')?.addEventListener('click',()=>openSwingModal(null));
 $('refreshOrdersBtn')?.addEventListener('click',()=>void refreshMcpOrders());
})();
