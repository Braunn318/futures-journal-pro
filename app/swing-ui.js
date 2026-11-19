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
 .swing-modal.group-mode .sw-pos-only{display:none!important}
 .swing-modal:not(.group-mode) .sw-group-only{display:none!important}
 .order-member-row td{opacity:.85;font-size:12px}
 .order-group-row td{vertical-align:top}
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
 if(swing&&!swingMcpFirstSyncDone){swingMcpFirstSyncDone=true;setTimeout(()=>void syncSwingFromMcp(),1500)}
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
 const legsHtml=legs.length?`<table class="swing-legs"><thead><tr><th>Výstup</th><th>Cena</th><th>Objem</th><th>Důvod</th><th>P/L</th><th>Swap</th><th>Komise</th><th>Netto</th></tr></thead><tbody>${legs.map(e=>{const n=FJSwing.legPnlNet(e);return `<tr><td>${fmtLocal(e.closedAt)}${e.source==='CTRADER'?' <span class="src-pill">cTrader</span>':''}</td><td>${fmtPrice(e.price,t.symbol)}</td><td>${fmtNum(e.volume,4)}</td><td>${esc(FJSwing.EXIT_REASON_LABELS[e.reason]||'—')}</td><td class="${signCls(e.pnl)}">${fmtMoney(e.pnl)}</td><td class="${signCls(e.swap)}">${fmtMoney(e.swap)}</td><td class="${signCls(e.commission)}">${fmtMoney(e.commission)}</td><td class="${signCls(n)}"><b>${fmtMoney(n)}</b></td></tr>`}).join('')}</tbody></table>`:'';
 const allImgs=[...(t.images||[]),...(t.imagesAfter||[])];
 const imgs=allImgs.length?`<div class="swing-imgs">${allImgs.map(r=>thumbImgHTML(r)).join('')}</div>`:'';
 return `<div class="swing-card" data-swing-id="${esc(t.id)}">
  <div class="swing-card-head">
   <div><b>${esc(t.symbol||'—')}</b> ${dirPill(t.direction)} ${statusPill}
    ${missing.length?`<span class="pill incomplete-pill" title="Chybí: ${esc(missing.map(k=>FJSwing.MISSING_LABELS[k]).join(', '))}">⚠ Neúplné · ${missing.length}</span>`:''}
    ${d.volumeError?'<span class="pill loss" title="Součet objemů výstupů je větší než objem pozice">Objem výstupů &gt; objem</span>':''}
    ${t.source==='CTRADER'||String(t.positionId||'').startsWith('ctrader-')?'<span class="src-pill" title="Importováno z cTraderu">cTrader</span>':''}
    ${t.orderGroupId?`<span class="src-pill" title="Vzniklo z plánovaného obchodu (skupiny limitek)">z limitek${(t.ctraderPositionIds||[]).length>1?' · '+t.ctraderPositionIds.length+' pozice':''}</span>`:''}
    ${t.contextFilledAt?`<span class="src-pill" title="Kontext vyplněn před vstupem ${esc(new Date(t.contextFilledAt).toLocaleString('cs-CZ'))}">kontext před vstupem</span>`:''}
    ${t.contextEditedAfterFill?'<span class="pill be" title="Kontext byl upraven po naplnění – už to není čistě to, co bylo známé před vstupem">kontext upraven po naplnění</span>':''}</div>
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
   ${t.entryLevelType?`<span><span class="sub">Hladina vstupu</span>${esc(t.entryLevelType)}</span>`:''}
   ${t.entryTf?`<span><span class="sub">TF vstupu</span>${esc(t.entryTf)}</span>`:''}
   ${t.htfTrend?`<span><span class="sub">Trend daily</span>${esc(t.htfTrend)}</span>`:''}
   ${t.weeklyCheck?`<span><span class="sub">Weekly</span>${esc(t.weeklyCheck)}</span>`:''}
   ${d.slSlippagePips!=null?`<span><span class="sub">Skluz za SL</span>${fmtNum(d.slSlippagePips,1)} pipů</span>`:''}
  </div>
  ${legsHtml}
  ${(t.cancelledOrders||[]).length?`<div class="sub" style="margin-top:6px">${t.cancelledOrders.map(c=>`${esc(c.label)} limitka zrušena${c.tp!=null?' ('+fmtPrice(c.tp,t.symbol)+')':''}`).join(' · ')}</div>`:''}
  ${t.entryReason?`<div class="sub" style="margin-top:6px;white-space:pre-line"><b>Důvod vstupu:</b> ${esc(t.entryReason)}</div>`:''}
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
// Okamžitý P/L otevřených pozic z cTraderu (get_positions při synchronizaci). Jen v paměti,
// do deníku se neukládá; ruční pozice bez vazby na cTrader ho nemají.
let swingLivePositions=new Map();
function swingLiveOf(t){return t?.positionId?swingLivePositions.get(t.positionId)||null:null}
function renderSwingPositions(){
 const target=$('swingOpenPositions');
 if(!target)return;
 const rows=swingOpenPositions().sort((a,b)=>String(a.openedAt).localeCompare(String(b.openedAt)));
 const total=$('swingOpenPnl');
 if(total){
  const live=rows.map(swingLiveOf).filter(Boolean);
  const sum=live.reduce((a,l)=>a+(Number(l.netProfit)||0),0);
  total.style.display=live.length?'':'none';
  total.innerHTML=live.length?`Otevřený P/L (cTrader, netto): <b class="${signCls(sum)}">${fmtMoney(sum)}</b> <span class="sub">· ${live.length} z ${rows.length} pozic · načteno ${new Date(live[0].at).toLocaleTimeString('cs-CZ')}</span>`:'';
 }
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
   ${(()=>{const l=swingLiveOf(t);return l?`<td>${fmtPrice(l.currentPrice,t.symbol)}</td><td class="${signCls(l.netProfit)}"><b>${fmtMoney(l.netProfit)}</b>${l.pips!=null?`<div class="sub">${fmtNum(l.pips,1)} pipů</div>`:''}</td>`:'<td>—</td><td>—</td>'})()}
   <td class="swing-actions"><button class="btn" data-swing-exit="${esc(t.id)}">＋ Výstup</button><button class="btn" data-swing-sl="${esc(t.id)}">Posunout SL</button><button class="btn" data-swing-edit="${esc(t.id)}">Upravit</button></td>
  </tr>`;
 }).join(''):'<tr><td colspan="10" class="sub">Žádná otevřená swing pozice. Novou otevřeš tlačítkem „＋ Otevřít pozici“.</td></tr>';
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
 if(mcpState.available)try{await syncSwingFromMcp()}catch(e){console.warn('Synchronizace z cTraderu:',e)}
}
function positionsTabOpen(){return $('openPositions')?.classList.contains('active')}
function startMcpPolling(){
 stopMcpPolling();
 void refreshMcpOrders();
 mcpTimer=setInterval(()=>{if(positionsTabOpen())void refreshMcpOrders();else stopMcpPolling()},60000);
}
function stopMcpPolling(){if(mcpTimer){clearInterval(mcpTimer);mcpTimer=null}}
function manualPendingOrders(){return (Array.isArray(db?.data?.pendingOrders)?db.data.pendingOrders:[]).map(o=>FJSwing.sanitizePendingOrder(o,o.placedAt)).filter(Boolean)}
function renderMcpOrdersStatus(){
 const s=mcpSettings();
 const status=$('mcpOrdersStatus');
 if(!status)return;
 if(!s.enabled)status.innerHTML='Limitky z cTraderu jsou vypnuté (Nastavení → Připojení a zdroje dat → cTrader → „Limitky z cTraderu přes MCP“).';
 else if(mcpState.available===null)status.textContent='cTrader: načítám…';
 else if(!mcpState.available)status.innerHTML='<span title="Zapni v cTraderu Settings → Advanced → MCP server → Enable MCP server">cTrader nevypadá spuštěný (MCP server neodpovídá).</span>';
 else{const a=mcpState.account||{};status.textContent=`cTrader: ${mcpState.orders.length} limitek · aktivní účet ${a.broker||'?'} · ${a.currency||''} · zůstatek ${fmtNum(a.balance)} · načteno ${new Date(mcpState.fetchedAt).toLocaleTimeString('cs-CZ')}${isSwingJournalActive()&&swingMcpAccountOk===false?' · účet nepatří tomuto deníku – limitky se jen ukazují, neukládají':''}`}
}
function renderPendingOrders(){
 if(isSwingJournalActive())return renderOrderGroups();
 renderPendingOrdersFlat();
}
function renderPendingOrdersFlat(){
 const target=$('pendingOrdersRows');
 if(!target)return;
 const s=mcpSettings();
 const status=$('mcpOrdersStatus');
 if(status){
  if(!s.enabled)status.innerHTML='Limitky z cTraderu jsou vypnuté (Nastavení → Připojení a zdroje dat → cTrader → „Limitky z cTraderu přes MCP“).';
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
 await commitJournal(j=>{j.pendingOrders=(j.pendingOrders||[]).filter(x=>x?.id!==o.id);planManualOrderGroups(j)});
 renderPendingOrders();
}

// ---------- plánované obchody = skupiny limitek (docs/ZADANI_SWING_SLUCOVANI_PRIKAZU.md) ----------
// Výpočty v app/order-groups.js (FJOrderGroups). Skupiny se ukládají do deníku (orderGroups):
// ruční limitky při každé změně seznamu, cTrader limitky při synchronizaci – a jen když je
// v cTraderu aktivní účet deníku (swingMcpAccountOk). Zobrazení počítá skupiny znovu nad
// aktuálními příkazy (stejná funkce), takže nová limitka je vidět hned, ještě před zápisem.
let swingMcpAccountOk=null;
const orderGroupsExpanded=new Set();
const orderGroupsSelected=new Set();
function orderGroupOpts(extra){
 return {account:settings?.ctraderMcpAccount?.login??null,decimalsOf:s=>swingInstrumentOf(s)?.priceDecimals??null,nowIso:new Date().toISOString(),...extra};
}
function storedOrderGroups(){return Array.isArray(db?.data?.orderGroups)?db.data.orderGroups:[]}
function mcpOrdersUsable(){return mcpSettings().enabled&&mcpState.available===true&&swingMcpAccountOk===true}
function viewOrderGroups(){
 const ct=mcpOrdersUsable();
 return FJOrderGroups.planOrderGroups(storedOrderGroups(),[...manualPendingOrders(),...(ct?mcpState.orders:[])],orderGroupOpts({sources:ct?['MANUAL','CTRADER']:['MANUAL']})).groups;
}
// Limitky cTraderu, když je aktivní jiný účet: jen ukázat (seskupené), nic neukládat.
function foreignOrderGroups(){
 if(!mcpSettings().enabled||mcpState.available!==true||swingMcpAccountOk===true)return [];
 let n=0;
 return FJOrderGroups.planOrderGroups([],mcpState.orders,orderGroupOpts({account:'?',sources:['CTRADER'],idGen:()=>'tmp_'+(++n)})).groups.map(g=>({...g,transient:true}));
}
// Ruční limitky deníku → skupiny (uvnitř commitJournal, j = kopie deníku).
function planManualOrderGroups(j){
 if(!isSwingJournalActive())return;
 const orders=(j.pendingOrders||[]).map(o=>FJSwing.sanitizePendingOrder(o,o.placedAt)).filter(Boolean);
 const r=FJOrderGroups.planOrderGroups(j.orderGroups||[],orders,orderGroupOpts({sources:['MANUAL']}));
 if(r.changed)j.orderGroups=r.groups;
}
// Migrace (§5): každý dosavadní ruční příkaz do skupiny podle §2.1. Záloha → zápis → značka.
async function runOrderGroupsMigration(){
 if(!isSwingJournalActive())return {skipped:true};
 const data=await ensureActiveJournalData();
 const m=FJOrderGroups.migratePendingOrders(data,orderGroupOpts());
 if(m.skipped)return m;
 if((data.pendingOrders||[]).length||(data.trades||[]).length||(data.orderGroups||[]).length){
  const r=await window.desktopAPI?.backupJournal?.(activeJournalId,'pred-seskupenim-limitek');
  if(!r||r.ok!==true)throw new Error(r?.error||'Zálohu deníku před seskupením limitek nelze vytvořit.');
 }
 await commitJournal(j=>{
  const again=FJOrderGroups.migratePendingOrders(j,orderGroupOpts());
  if(again.skipped)return;
  j.orderGroups=again.orderGroups;j.orderGroupsVersion=again.orderGroupsVersion;
 });
 return {created:m.created};
}
const GROUP_STATUS_PILL={
 PENDING:'',
 PARTIAL:'<span class="pill be" title="Část limitek se naplnila – obchod je v Deníku, zbytek dál čeká">částečně naplněno</span>',
 FILLED:'<span class="pill">naplněno</span>',
 GONE:'<span class="pill hypo-pill" title="Limitky už v cTraderu nejsou a pozice k nim se nenašla – zrušené / expirované, nebo naplněné mimo dohled deníku">limitky zmizely</span>'
};
function orderGroupVisible(g){
 if(g.resolution)return false;
 const v=FJOrderGroups.groupView(g);
 return v.status==='PENDING'||v.status==='PARTIAL'||(v.status==='GONE'&&!g.tradeId);
}
function memberRowHTML(g,m,i,n){
 const label=m.tp!=null?`TP${i+1}`:'bez TP';
 const st=m.state==='FILLED'?'<span class="pill">naplněno</span>':m.state==='GONE'?'<span class="pill hypo-pill">zmizela</span>':'';
 return `<tr class="order-member-row" data-member-of="${esc(g.id)}">
  <td><span class="sub">└ ${esc(label)}</span> <span class="src-pill">${m.source==='CTRADER'?'cTrader':'ručně'}</span></td>
  <td class="sub">${esc(m.note||'')} ${st}</td><td></td><td></td>
  <td>${fmtPrice(m.price,g.symbol)}${m.price!==g.price?' <span class="neg" title="Jiná cena než skupina">≠</span>':''}</td>
  <td>${fmtPrice(m.sl,g.symbol)}${m.sl!==g.sl?' <span class="neg" title="Jiný SL než skupina">≠</span>':''}</td>
  <td>${fmtPrice(m.tp,g.symbol)}</td><td>${fmtNum(m.volume,4)}</td>
  <td>${m.placedAt?fmtLocal(m.placedAt)+(m.placedAtApprox?' <span class="sub" title="Čas zadání cTrader nedává – poprvé viděno">≈</span>':''):'—'}</td>
  <td>${m.expiresAt?fmtLocal(m.expiresAt):'—'}</td>
  <td class="swing-actions">${m.source==='MANUAL'&&m.state==='PENDING'?`<button class="btn" data-order-edit="${esc(m.orderId)}">Upravit</button><button class="btn danger" data-order-del="${esc(m.orderId)}">🗑️</button>`:''}</td></tr>`;
}
function orderGroupRowHTML(g){
 const v=FJOrderGroups.groupView(g);
 const open=FJOrderGroups.isOpenGroup(g);
 const tps=v.tps.length?v.tps.map((p,i)=>`<div><span class="sub">TP${i+1}</span> ${fmtPrice(p,g.symbol)}</div>`).join(''):'—';
 const vol=v.totalVolume==null?'—':(v.count>1?`<b>${fmtNum(v.totalVolume,4)}</b><div class="sub">= ${v.volumes.map(x=>fmtNum(x,4)).join(' + ')}</div>`:fmtNum(v.totalVolume,4));
 const ctx=g.transient?'':(v.contextFilled?'<span class="pill" title="Kontext před vstupem je vyplněný">✓ kontext</span>':'<span class="pill incomplete-pill" title="Kontext před vstupem chybí">kontext chybí</span>');
 const exp=orderGroupsExpanded.has(g.id);
 const actions=g.transient?'<span class="sub">jiný účet</span>':`
   <button class="btn" data-group-context="${esc(g.id)}" title="Setup, důvod vstupu, screenshoty… – přenese se do obchodu">Kontext</button>
   ${!g.tradeId?`<button class="btn" data-group-filled="${esc(g.id)}" title="Limitky skupiny se naplnily – předvyplní jeden swing obchod (uloží se až po potvrzení)">Naplněno</button>
   <button class="btn" data-group-nofill="${esc(g.id)}" title="Limitky zmizely bez naplnění – předvyplní jeden setup bez vstupu za celou skupinu">Nenaplněno</button>`:''}
   ${v.status==='GONE'?`<button class="btn" data-group-dismiss="${esc(g.id)}" title="Skrýt bez záznamu">Skrýt</button>`:''}
   ${open&&v.count>1?`<button class="btn" data-group-split="${esc(g.id)}" title="Každá limitka jako samostatný plánovaný obchod">Rozdělit</button>`:''}`;
 return `<tr class="order-group-row" data-group-id="${esc(g.id)}">
  <td>${!g.transient&&open?`<input type="checkbox" class="order-group-select" data-group-select="${esc(g.id)}" ${orderGroupsSelected.has(g.id)?'checked':''} title="Vybrat ke sloučení">`:''}
   <button class="btn" data-group-toggle="${esc(g.id)}" title="${exp?'Skrýt':'Ukázat'} jednotlivé příkazy" style="padding:0 6px">${exp?'▾':'▸'}</button>
   ${v.sources.map(s=>`<span class="src-pill">${s==='CTRADER'?'cTrader':'ručně'}</span>`).join(' ')}</td>
  <td><b>${esc(g.symbol)}</b> <span class="sub">${v.count} ${v.count===1?'příkaz':v.count<5?'příkazy':'příkazů'}</span>${g.groupManual?' <span class="sub" title="Seskupeno ručně – automatika na skupinu nesahá">ručně</span>':''}<div>${ctx} ${GROUP_STATUS_PILL[v.status]||''}${v.priceMismatch||v.slMismatch?` <span class="pill loss" title="Příkazy ve skupině mají rozdílnou ${v.priceMismatch?'cenu vstupu':''}${v.priceMismatch&&v.slMismatch?' a ':''}${v.slMismatch?'SL':''}">rozdílná ${v.priceMismatch?'cena':''}${v.priceMismatch&&v.slMismatch?' / ':''}${v.slMismatch?'SL':''}</span>`:''}</div></td>
  <td>${dirPill(g.direction)}</td>
  <td>${g.orderType==='STOP'?'Stop':'Limit'}</td>
  <td>${fmtPrice(g.price,g.symbol)}</td>
  <td>${fmtPrice(g.sl,g.symbol)}</td>
  <td>${tps}</td>
  <td>${vol}</td>
  <td>${v.placedAt?fmtLocal(v.placedAt):'—'}</td>
  <td>${v.expiresAt?fmtLocal(v.expiresAt):'—'}</td>
  <td class="swing-actions">${actions}</td></tr>${exp?v.members.map((m,i)=>memberRowHTML(g,m,i,v.count)).join(''):''}`;
}
function ensureOrderGroupToolbar(){
 if($('mergeOrderGroupsBtn')||!$('refreshOrdersBtn'))return;
 const b=document.createElement('button');b.className='btn swing-only';b.id='mergeOrderGroupsBtn';b.textContent='Sloučit vybrané';
 b.title='Vybrané plánované obchody (zaškrtnuté řádky) spojí do jednoho';
 $('refreshOrdersBtn').insertAdjacentElement('beforebegin',b);
 b.onclick=()=>void mergeSelectedOrderGroups();
}
function renderOrderGroups(){
 const target=$('pendingOrdersRows');
 if(!target)return;
 ensureOrderGroupToolbar();
 renderMcpOrdersStatus();
 const groups=viewOrderGroups().filter(orderGroupVisible);
 const foreign=foreignOrderGroups();
 const all=[...groups,...foreign].sort((a,b)=>String(a.symbol).localeCompare(String(b.symbol))||String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
 for(const id of [...orderGroupsSelected])if(!groups.some(g=>g.id===id))orderGroupsSelected.delete(id);
 const mb=$('mergeOrderGroupsBtn');if(mb)mb.disabled=orderGroupsSelected.size<2;
 target.innerHTML=all.length?all.map(orderGroupRowHTML).join(''):'<tr><td colspan="11" class="sub">Žádné čekající příkazy.</td></tr>';
 const byGroup=id=>all.find(g=>g.id===id);
 const manualById=id=>manualPendingOrders().find(o=>o.id===id);
 target.querySelectorAll('[data-group-toggle]').forEach(b=>b.onclick=()=>{const id=b.dataset.groupToggle;orderGroupsExpanded.has(id)?orderGroupsExpanded.delete(id):orderGroupsExpanded.add(id);renderOrderGroups()});
 target.querySelectorAll('[data-group-select]').forEach(cb=>cb.onchange=()=>{cb.checked?orderGroupsSelected.add(cb.dataset.groupSelect):orderGroupsSelected.delete(cb.dataset.groupSelect);const m=$('mergeOrderGroupsBtn');if(m)m.disabled=orderGroupsSelected.size<2});
 target.querySelectorAll('[data-group-split]').forEach(b=>b.onclick=()=>void splitOrderGroupUi(b.dataset.groupSplit));
 target.querySelectorAll('[data-group-context]').forEach(b=>b.onclick=()=>void openGroupContext(byGroup(b.dataset.groupContext)));
 target.querySelectorAll('[data-group-filled]').forEach(b=>b.onclick=()=>void groupToTrade(byGroup(b.dataset.groupFilled),true));
 target.querySelectorAll('[data-group-nofill]').forEach(b=>b.onclick=()=>void groupToTrade(byGroup(b.dataset.groupNofill),false));
 target.querySelectorAll('[data-group-dismiss]').forEach(b=>b.onclick=()=>void dismissOrderGroup(byGroup(b.dataset.groupDismiss)));
 target.querySelectorAll('[data-order-edit]').forEach(b=>b.onclick=()=>openOrderModal(manualById(b.dataset.orderEdit)));
 target.querySelectorAll('[data-order-del]').forEach(b=>b.onclick=()=>void deletePendingOrder(manualById(b.dataset.orderDel)));
}
// Skupiny ze zobrazení uloží do deníku, pokud se liší (nové limitky ještě před synchronizací).
async function persistViewedGroups(){
 const view=viewOrderGroups();
 if(JSON.stringify(view)===JSON.stringify(storedOrderGroups()))return;
 await commitJournal(j=>{
  const ct=mcpOrdersUsable();
  const orders=[...(j.pendingOrders||[]).map(o=>FJSwing.sanitizePendingOrder(o,o.placedAt)).filter(Boolean),...(ct?mcpState.orders:[])];
  const r=FJOrderGroups.planOrderGroups(j.orderGroups||[],orders,orderGroupOpts({sources:ct?['MANUAL','CTRADER']:['MANUAL']}));
  if(r.changed)j.orderGroups=r.groups;
 });
}
async function mergeSelectedOrderGroups(){
 await persistViewedGroups();
 const ids=[...orderGroupsSelected];
 const picked=storedOrderGroups().filter(g=>ids.includes(g.id));
 if(picked.length<2){showToast('Zaškrtni aspoň dva plánované obchody.');return}
 const chk=FJOrderGroups.canMerge(picked);
 const BLOCK={account:'Nejde sloučit: příkazy jsou z různých účtů.',symbol:'Nejde sloučit: rozdílný symbol.',direction:'Nejde sloučit: rozdílný směr.',
  filled:'Nejde sloučit: některý z vybraných už má naplnění nebo rozhodnutí.',context:'Nejde sloučit: kontext je vyplněný u víc vybraných – kontext jednoho by se ztratil. Nech kontext jen u jednoho.',count:'Zaškrtni aspoň dva plánované obchody.'};
 if(!chk.ok){showToast(BLOCK[chk.block]||'Nejde sloučit.');return}
 if(chk.warn.includes('price')||chk.warn.includes('sl')||chk.warn.includes('orderType')){
  const what=[chk.warn.includes('price')?'cena vstupu':'',chk.warn.includes('sl')?'SL':'',chk.warn.includes('orderType')?'typ příkazu':''].filter(Boolean).join(' / ');
  const ok=await showConfirm(`Rozdílná ${what}. Sloučit přesto?\n\nSkupina si nechá cenu a SL ${picked.find(FJOrderGroups.contextFilled)?'skupiny s kontextem':'nejstarší skupiny'}; u jednotlivých příkazů zůstanou jejich vlastní.`,{title:'Sloučit plánované obchody',ok:'Sloučit přesto'});
  if(!ok)return;
 }
 await commitJournal(j=>{j.orderGroups=FJOrderGroups.mergeGroups(j.orderGroups||[],ids,orderGroupOpts()).groups});
 orderGroupsSelected.clear();
 renderOrderGroups();
 showToast('Sloučeno do jednoho plánovaného obchodu. Automatika ho už měnit nebude.');
}
async function splitOrderGroupUi(id){
 await persistViewedGroups();
 if(!storedOrderGroups().some(g=>g.id===id))return;
 await commitJournal(j=>{j.orderGroups=FJOrderGroups.splitGroup(j.orderGroups||[],id,orderGroupOpts()).groups});
 orderGroupsExpanded.delete(id);
 renderOrderGroups();
 showToast('Rozděleno – každý příkaz je samostatný plánovaný obchod. Synchronizace je znovu nesloučí.');
}
async function dismissOrderGroup(g){
 if(!g)return;
 if(!(await showConfirm(`Skrýt plánovaný obchod ${g.symbol} @ ${fmtPrice(g.price,g.symbol)}? Nic se nemaže, jen se přestane ukazovat (bez záznamu „nenaplněno“).`,{title:'Skrýt plánovaný obchod',ok:'Skrýt'})))return;
 await persistViewedGroups();
 await commitJournal(j=>{const x=(j.orderGroups||[]).find(y=>y.id===g.id);if(x){x.resolution='DISMISSED';x.updatedAt=new Date().toISOString()}});
 renderOrderGroups();
}
function groupInfoHTML(g){
 const v=FJOrderGroups.groupView(g);
 return `<b>${esc(g.symbol)}</b> ${dirPill(g.direction)} ${g.orderType==='STOP'?'Stop':'Limit'} @ <b>${fmtPrice(g.price,g.symbol)}</b> · SL ${fmtPrice(g.sl,g.symbol)} · ${v.tps.map((p,i)=>'TP'+(i+1)+' '+fmtPrice(p,g.symbol)).join(' · ')||'bez TP'} · objem ${fmtNum(v.totalVolume,4)} (${v.count} ${v.count===1?'příkaz':v.count<5?'příkazy':'příkazů'})<div>Kontext před vstupem se uloží ke skupině a při naplnění se celý přenese do obchodu.</div>`;
}
// „Kontext" u skupiny: stejný formulář jako u obchodu, jen kontextová část. Skupina, ze které
// už vznikl obchod, edituje rovnou ten obchod (úprava se tam označí jako po naplnění).
async function openGroupContext(g){
 if(!g||g.transient)return;
 if(g.tradeId){const t=findSwing(g.tradeId);if(t){openSwingModal(t,{title:'Kontext obchodu z plánované limitky'});return}}
 await persistViewedGroups();
 const sg=storedOrderGroups().find(x=>x.id===g.id);
 if(!sg){showToast('Plánovaný obchod se nepodařilo uložit.');return}
 const c=sg.context||{};
 const x={...c,symbol:sg.symbol,direction:sg.direction,contextFilledAt:sg.contextFilledAt,contextEditedAfterFill:sg.contextEditedAfterFill,
  targetsPlanned:FJOrderGroups.sortMembers(sg).map((m,i)=>({price:m.tp,levelType:(c.targetLevels||{})[m.orderId]||'',orderId:m.orderId,label:m.tp!=null?'TP'+(i+1):'bez TP'}))};
 openSwingModal(x,{group:sg,title:'Kontext před vstupem'});
}
async function saveGroupContextModal(){
 const id=swingGroupEdit;
 const g=storedOrderGroups().find(x=>x.id===id);
 if(!g){showToast('Plánovaný obchod už neexistuje.');return}
 const ctx={...readContextInputs(),riskAmount:numOrNull($('swGroupRisk').value),targetLevels:{}};
 for(const r of $('swTargets').querySelectorAll('.swing-row')){
  const oid=r.querySelector('[data-k="orderId"]')?.value;const lt=r.querySelector('[data-k="levelType"]')?.value.trim();
  if(oid&&lt)ctx.targetLevels[oid]=lt;
 }
 const v=FJOrderGroups.groupView(g);
 const p=FJSwing.splitLocal(v.placedAt)||FJSwing.splitLocal(FJSwing.berlinNowLocal());
 await nameRecordImages(ctx,{journalId:activeJournalId,key:'orderGroup:'+g.id},{date:p.date,entryTime:p.time,instrument:g.symbol,side:g.direction,recordType:'SETUP_ONLY'});
 const now=new Date().toISOString();
 await commitJournal(j=>{
  const list=j.orderGroups||[];
  const i=list.findIndex(x=>x.id===id);
  if(i>=0)list[i]=FJOrderGroups.applyGroupContext(list[i],ctx,now);
 });
 swingGroupEdit=null;
 $('swingModal').classList.remove('open','group-mode');
 renderOrderGroups();
 showToast('Kontext před vstupem uložen ke skupině.');
}
// Naplněno / Nenaplněno působí na celou skupinu: jeden obchod nebo jeden SETUP_ONLY s kontextem
// skupiny. Jen předvyplní formulář – uloží se až po potvrzení (saveSwingModal).
async function groupToTrade(g,filled){
 if(!g||g.transient)return;
 await persistViewedGroups();
 const sg=storedOrderGroups().find(x=>x.id===g.id);
 if(!sg){showToast('Plánovaný obchod se nepodařilo uložit.');return}
 const v=FJOrderGroups.groupView(sg);
 openSwingModal(FJOrderGroups.draftFromGroup(sg,filled),{title:filled?`Otevřít pozici z plánovaného obchodu (${v.count} ${v.count===1?'limitka':v.count<5?'limitky':'limitek'})`:'Nenaplněný plánovaný obchod'});
}

function renderPositionsTab(){
 renderSwingPositions();
 renderSwingImportNotice();
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
  planManualOrderGroups(j);
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
 // nabídky kontextu (§6) + dřív použité hodnoty z obchodů a skupin
 const ctxRows=[...swingRows(),...storedOrderGroups().map(g=>g.context||{})];
 const lists={swingEntryTfList:['entryTf','entryTf'],swingHtfTrendList:['htfTrend','htfTrend'],swingWeeklyList:['weeklyCheck','weeklyCheck'],swingLevelTypeList:['levelType','entryLevelType']};
 for(const [id,[sugg,key]] of Object.entries(lists)){
  let el=$(id);if(!el){el=document.createElement('datalist');el.id=id;document.body.appendChild(el)}
  const usedVals=ctxRows.flatMap(t=>key==='entryLevelType'?[t.entryLevelType,...(t.targetsPlanned||[]).map(x=>x?.levelType),...Object.values(t.targetLevels||{})]:[t[key]]).filter(v=>v&&String(v).trim());
  el.innerHTML=[...new Set([...FJSwing.SWING_CONTEXT_SUGGESTIONS[sugg],...usedVals])].map(v=>`<option value="${esc(v)}">`).join('');
 }
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
  <div class="field"><label>${g.label?esc(g.label):'Cíl'}</label><input type="number" step="any" data-k="price" value="${g.price??''}" style="width:120px" ${g.orderId?'readonly':''}></div>
  <div class="field"><label>Typ hladiny</label><input data-k="levelType" list="swingLevelTypeList" value="${esc(g.levelType||'')}" placeholder="VPOC 4h, Gap…"></div>
  ${g.orderId?`<input type="hidden" data-k="orderId" value="${esc(g.orderId)}">`:'<button class="btn" type="button" data-remove-row title="Odebrat">✕</button>'}</div>`;
}
const SW_CONTEXT_INPUTS=[['swSetup','swingSetup'],['swEntryLevel','entryLevelType'],['swEntryTf','entryTf'],['swHtfTrend','htfTrend'],['swWeeklyCheck','weeklyCheck'],['swEntryReason','entryReason'],['swComment','comment']];
function ensureSwingModal(){
 if($('swingModal'))return;
 const m=document.createElement('div');m.className='modal swing-modal';m.id='swingModal';
 m.innerHTML=`<div class="modalbox">
  <div class="modalhead"><h2 id="swingModalTitle">Otevřít pozici</h2><button class="icon" id="swingModalClose">✕</button></div>
  <input type="hidden" id="swId">
  <div class="sub sw-group-only" id="swGroupInfo" style="margin-bottom:8px"></div>
  <div class="swing-grid sw-pos-only">
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
  <div class="swing-section"><h3>Plánované cíle <button class="btn sw-pos-only" type="button" id="swAddTarget">＋ cíl</button></h3><div class="sub sw-group-only">Cíle jsou TP jednotlivých limitek (mění se v cTraderu / u ruční limitky). Tady jen typ hladiny.</div><div class="swing-rows" id="swTargets"></div></div>
  <div class="swing-section sw-pos-only"><h3>Výstupy <button class="btn" type="button" id="swAddExit">＋ výstup</button></h3><div class="sub">P/L, swap a komisi opiš z výpisu brokera se znaménkem. Netto = P/L + swap + komise.</div><div class="swing-rows" id="swExits"></div></div>
  <div class="swing-section sw-pos-only"><h3>Posuny SL <button class="btn" type="button" id="swAddSl">＋ posun SL</button></h3><div class="swing-rows" id="swSlMoves"></div></div>
  <div class="swing-section"><h3>Kontext <span class="sub" id="swContextStamp"></span></h3>
   <div class="swing-grid">
    <div class="field"><label>Setup</label><input id="swSetup" list="swingSetupList" autocomplete="off"></div>
    <div class="field"><label>Hladina vstupu</label><input id="swEntryLevel" list="swingLevelTypeList" autocomplete="off" placeholder="VPOC 4h, VA hrana…"></div>
    <div class="field"><label>TF vstupu</label><input id="swEntryTf" list="swingEntryTfList" autocomplete="off" placeholder="4h"></div>
    <div class="field"><label>Trend daily</label><input id="swHtfTrend" list="swingHtfTrendList" autocomplete="off" placeholder="nahoru / dolů / range"></div>
    <div class="field"><label>Weekly</label><input id="swWeeklyCheck" list="swingWeeklyList" autocomplete="off" placeholder="OK / proti / nehodnoceno"></div>
    <div class="field"><label>Známka</label><select id="swGrade"><option value="">—</option><option>A</option><option>B</option><option>C</option></select></div>
    <div class="field sw-group-only"><label>Riziko (peníze)</label><input id="swGroupRisk" type="number" step="any" min="0" title="Kolik stojí plný SL všech limitek skupiny podle platformy brokera"></div>
    <div class="field sw-pos-only"><label>MAE (pipy)</label><input id="swMae" type="number" step="any"></div>
    <div class="field sw-pos-only"><label>MFE (pipy)</label><input id="swMfe" type="number" step="any"></div>
    <div class="field sw-pos-only"><label>Nejdéle v mínusu (dny)</label><input id="swDaysAgainst" type="number" step="any" min="0"></div>
   </div>
   <div class="field"><label>Důvod vstupu</label><textarea id="swEntryReason" rows="2"></textarea></div>
   <div class="field"><label>Komentář</label><textarea id="swComment" rows="3"></textarea></div>
   <div class="field"><label>Screenshoty (daily + 4h při vstupu; vložení Ctrl+V)</label><input id="swImageInput" type="file" accept="image/*" multiple><div class="swing-imgs" id="swImages"></div></div>
  </div>
  <div class="swing-derived sw-pos-only" id="swDerived"></div>
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
let swingGroupEdit=null; // id skupiny limitek, když formulář edituje jen její kontext před vstupem
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
// Kontextová pole formuláře – stejné čtení pro obchod i pro skupinu limitek (kontext před vstupem).
function readContextInputs(){
 const c={};
 for(const [id,k] of SW_CONTEXT_INPUTS)c[k]=(k==='comment'||k==='entryReason')?$(id).value:$(id).value.trim();
 c.grade=['A','B','C'].includes($('swGrade').value)?$('swGrade').value:'';
 c.images=[...swingEditImages];
 return c;
}
function openSwingModal(t,{focus,fromOrder,title,group}={}){
 ensureSwingModal();ensureSymbolList();
 const x=t||{};
 swingFromOrder=fromOrder||null;
 swingGroupEdit=group?group.id:null;
 $('swingModal').classList.toggle('group-mode',!!group);
 // nový obchod z návrhu (limitka, skupina): pole, která formulář nemá (orderPlacedAt, orderGroupId, contextFilledAt …), se uloží s ním
 swingDraftBase=!x.id&&t&&!group?{...x}:null;
 $('swingModalTitle').textContent=title||(x.id?(focus==='exit'?'Přidat výstup':focus==='sl'?'Posunout SL':'Upravit swing obchod'):'Otevřít pozici');
 $('swId').value=x.id||'';
 $('swSymbol').value=x.symbol||'';$('swDirection').value=x.direction||'long';
 $('swOpenedAt').value=x.openedAt||FJSwing.berlinNowLocal();
 for(const [id,k] of [['swEntry','entryPrice'],['swVolume','volume'],['swSlInitial','slInitial'],['swRisk','riskAmount'],['swMae','maePips'],['swMfe','mfePips'],['swDaysAgainst','maxDaysAgainst']])$(id).value=x[k]!=null?x[k]:'';
 $('swRecordType').value=x.recordType==='SETUP_ONLY'?'SETUP_ONLY':'';
 for(const [id,k] of SW_CONTEXT_INPUTS)$(id).value=x[k]??'';
 $('swGrade').value=x.grade||'';
 $('swGroupRisk').value=x.riskAmount!=null?x.riskAmount:'';
 $('swContextStamp').textContent=x.contextFilledAt?`· vyplněno před vstupem ${new Date(x.contextFilledAt).toLocaleString('cs-CZ')}${x.contextEditedAfterFill?' · upraveno po naplnění':''}`:'';
 $('swGroupInfo').innerHTML=group?groupInfoHTML(group):'';
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
 else setTimeout(()=>$(group?'swSetup':'swSymbol').focus(),30);
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
  ...readContextInputs(),
  maePips:numOrNull($('swMae').value), mfePips:numOrNull($('swMfe').value), maxDaysAgainst:numOrNull($('swDaysAgainst').value),
  currency:swingCurrency()
 };
 if(recordType){out.recordType='SETUP_ONLY';out.fillStatus=out.fillStatus||'NO_FILL'}else{delete out.recordType;if(out.fillStatus==='NO_FILL')delete out.fillStatus}
 out.date=FJSwing.swingListDate(out);
 // nohy z cTraderu si drží svůj původ a id dealu (formulář je nemá)
 const prevExits=existing?.exits||[];
 out.exits=out.exits.map(e=>{const p=prevExits.find(x=>x.externalId&&x.closedAt===e.closedAt&&Number(x.price)===Number(e.price));return p?{...e,externalId:p.externalId,source:p.source}:e});
 // kontext zděděný ze skupiny limitek: změna kontextu po naplnění se označí (contextEditedAfterFill)
 const marked=FJOrderGroups.markContextEdit(existing||swingDraftBase,out);
 return existing?FJSwing.dropEditedImportedFields(existing,marked):marked;
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
 if(swingGroupEdit)return saveGroupContextModal();
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
 const fromGroup=swingDraftBase?.orderGroupId&&!findSwing(t.id)?swingDraftBase.orderGroupId:null;
 await commitJournal(j=>{
  const rows=j.trades||(j.trades=[]);
  const i=rows.findIndex(x=>x?.id===t.id);
  if(i>=0)rows[i]=t;else rows.push(t);
  if(orderId)j.pendingOrders=(j.pendingOrders||[]).filter(o=>o?.id!==orderId);
  if(fromGroup){
   const g=(j.orderGroups||[]).find(x=>x.id===fromGroup);
   const manualIds=new Set((g?.members||[]).filter(m=>m.source==='MANUAL').map(m=>m.orderId));
   if(manualIds.size)j.pendingOrders=(j.pendingOrders||[]).filter(o=>!manualIds.has(o?.id));
   j.orderGroups=FJOrderGroups.recordGroupDecision(j.orderGroups||[],fromGroup,t);
   planManualOrderGroups(j);
  }
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
   <h3 style="margin-top:6px">Import z cTraderu (MCP)</h3>
   <div class="sub">Otevřené pozice a provedené obchody se načítají přímo z běžícího cTrader Desktopu (MCP server, jen čtení) – cBot není potřeba. Vyber účet cTraderu, který patří tomuto deníku; synchronizuje se, jen když je v cTraderu aktivní právě on. Historie: v cTraderu nastav TradeWatch → History na „All“.</div>
   <div class="swing-row" style="margin-top:8px">
    <div class="field" style="min-width:280px"><label>Účet cTraderu</label><select id="swingMcpAccountSelect"><option value="">${esc(settings.ctraderMcpAccount?accountLabel(settings.ctraderMcpAccount):'— načti účty —')}</option></select></div>
    <div class="field"><label>Importovat obchody od</label><input type="date" id="swingImportFrom" value="${esc(settings.ctraderImportFrom||'')}" title="Prázdné = vše, co cTrader v historii má načtené"></div>
    <button class="btn" type="button" id="swingMcpLoadAccounts">Načíst účty</button>
    <button class="btn primary" type="button" id="swingMcpSyncNow">Synchronizovat teď</button>
   </div>
   <div class="sub" id="swingMcpAccountInfo" style="margin-top:6px"></div>
   <div class="field" style="max-width:240px;margin-top:12px"><label>Měna účtu</label><select id="swingCurrencySelect">${FJSwing.CURRENCIES.map(c=>`<option ${c===swingCurrency()?'selected':''}>${c}</option>`).join('')}</select><div class="sub">Peníze se do swing deníku opisují z výpisu brokera v této měně.</div></div>
   <h3 style="margin-top:14px">CFD instrumenty</h3>
   <div class="sub">Pip size stačí na pipy a R z cen; hodnota pipu ani ticku se nezadává. Velikost lotu (jednotek v 1 lotu) potřebuje jen import z cTraderu – objem posílá v jednotkách. Výchozí řádky jdou upravit; nic se nemaže.</div>
   <div class="table-scroll" style="margin-top:8px"><table><thead><tr><th>Symbol</th><th>Pip size</th><th>Desetinná místa</th><th>Lot (jednotek)</th><th>Třída</th><th>Base</th><th>Quote</th><th></th></tr></thead><tbody>
   ${list.map(i=>`<tr data-cfd="${esc(i.symbol)}"><td><b>${esc(i.symbol)}</b>${i.builtin?'':' <span class="sub">vlastní</span>'}</td>
    <td><input type="number" step="any" min="0" data-cfdk="pipSize" value="${i.pipSize??''}" style="width:100px"></td>
    <td><input type="number" step="1" min="0" data-cfdk="priceDecimals" value="${i.priceDecimals??''}" style="width:70px"></td>
    <td><input type="number" step="any" min="0" data-cfdk="lotSize" value="${i.lotSize??''}" style="width:100px" title="Kolik jednotek je 1 lot (cTrader posílá objem v jednotkách)"></td>
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
  $('swingMcpAccountSelect').onchange=async e=>{
   const a=(swingMcpLast?.accounts||[]).find(x=>String(x.login)===e.target.value);
   await persistSettings({ctraderMcpAccount:a?{login:String(a.login),broker:a.brokerTitle||'',brokerTitle:a.brokerTitle||'',currency:a.currency||'',isLive:a.isLive!==false}:null});
   renderSwingMcpStatus();
   if(a)void syncSwingFromMcp({manual:true});
  };
  $('swingImportFrom').onchange=e=>void persistSettings({ctraderImportFrom:e.target.value||''});
  $('swingMcpLoadAccounts').onclick=async()=>{await syncSwingFromMcp({manual:false});if(!swingMcpLast?.accounts?.length)showToast(swingMcpLast?.message||'cTrader neodpovídá.');renderSwingMcpStatus()};
  $('swingMcpSyncNow').onclick=()=>void syncSwingFromMcp({manual:true});
  renderSwingMcpStatus();
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

// ---------- import z cTraderu (cBot konektor) ----------
// Událost cBota (trade_opened / trade_closed, source 'ctrader') mířící do swing deníku
// (mapování účtů v Integrace) → swing obchod podle positionId „ctrader-<id>". Ruční hodnoty
// vyhrávají (importedFields), ručně zadaný obchod se spáruje jen po potvrzení. Vrací
// 'done' (událost jde označit jako importovaná), 'wait' (zůstane ve frontě) nebo 'error'.
let swingPairPending=new Set();
let swingPairDecisions=new Map();
let swingImportWaiting=new Map();
let swingImportChain=Promise.resolve();
// Velikost lotu symbolu: tabulka CFD instrumentů deníku, jinak cTrader MCP (doplní se do tabulky).
async function swingLotSizeFor(data,symbol){
 const main=data.settings.find(s=>s?.key==='main');
 const inst=FJSwing.findInstrument(symbol,FJSwing.instrumentsOf(main?.value||{}));
 if(inst?.lotSize)return inst.lotSize;
 const s=mcpSettings();
 if(!s.enabled||!window.desktopAPI?.ctraderSymbolDetails)return null;
 const r=await window.desktopAPI.ctraderSymbolDetails(s.url,symbol);
 const lot=Number(r?.details?.lotSize);
 if(!r?.available||!(lot>0))return null;
 let entry=main;
 if(!entry){entry={key:'main',value:{}};data.settings.push(entry)}
 const list=Array.isArray(entry.value.cfdInstruments)?entry.value.cfdInstruments:[];
 const pip=Number(r.details.pipSize),dig=Number(r.details.digits);
 const row={symbol,lotSize:lot,pipSize:inst?.pipSize??(pip>0?pip:null),priceDecimals:inst?.priceDecimals??(Number.isFinite(dig)?dig:null),assetClass:inst?.assetClass||'OTHER',baseCcy:inst?.baseCcy||'',quoteCcy:inst?.quoteCcy||''};
 entry.value={...entry.value,cfdInstruments:[...list.filter(x=>FJSwing.normalizeSymbol(x?.symbol)!==symbol),row]};
 data.__settingsChanged=true;
 return lot;
}
function importSwingCtraderEvent(journalId,e){
 // jeden import za druhým – zápis čte a píše celý deník
 const run=swingImportChain.then(()=>importSwingCtraderEventNow(journalId,e));
 swingImportChain=run.catch(()=>{});
 return run;
}
async function importSwingCtraderEventNow(journalId,e){
 const r=await window.desktopAPI.readJournal(journalId);
 if(!r?.ok)return 'error';
 const data=r.data||{trades:[],settings:[]};
 data.trades=Array.isArray(data.trades)?data.trades:[];
 data.settings=Array.isArray(data.settings)?data.settings:[];
 const symbol=FJSwing.normalizeSymbol(e.instrument);
 const lot=await swingLotSizeFor(data,symbol);
 if(!lot){swingImportWaiting.set(symbol,(swingImportWaiting.get(symbol)||0)+1);return 'wait'}
 swingImportWaiting.delete(symbol);
 const draft=FJSwing.swingFromCtraderEvent(e,lot);
 if(!draft||!draft.positionId)return 'wait';
 let idx=data.trades.indexOf(FJSwing.findTradeByPosition(data.trades,draft.positionId));
 let trade=idx>=0?data.trades[idx]:null;
 // pozice, kterou si může vzít čekající skupina limitek: počkat na MCP synchronizaci (ta ji spáruje
 // do obchodu skupiny); jen se zapnutým MCP a nejvýš 15 min od otevření, pak import jako dřív
 if(!trade&&mcpSettings().enabled&&Date.now()-Date.parse(e.entryTime||'')<15*60000&&FJOrderGroups.groupMayClaimEvent(data.orderGroups||[],e,{decimalsOf:sym=>FJSwing.findInstrument(sym,FJSwing.instrumentsOf((data.settings.find(x=>x?.key==='main')||{}).value||{}))?.priceDecimals??null}))return 'wait';
 const before=JSON.stringify(trade);
 if(!trade){
  const decision=swingPairDecisions.get(draft.positionId);
  const cand=decision&&decision!=='NEW'?data.trades.find(t=>t?.id===decision&&!t.positionId):(decision==='NEW'?null:FJSwing.findPairCandidate(data.trades,draft));
  if(cand&&!decision){
   if(swingPairPending.has(draft.positionId))return 'wait';
   swingPairPending.add(draft.positionId);
   let ok=false;
   try{
    ok=await showConfirm(`Z cTraderu přišla pozice ${draft.symbol} ${draft.direction==='short'?'SHORT':'LONG'} otevřená ${String(draft.openedAt||'').replace('T',' ')}.\nV deníku je ručně zadaný obchod ${cand.symbol} z ${String(cand.openedAt||'').replace('T',' ')}, který jí nejspíš odpovídá.\n\nSpárovat = k ručnímu obchodu se doplní jen prázdná pole a výstupy z cTraderu. Založit nový = vznikne druhý obchod.`,{title:'Spárovat obchod z cTraderu',ok:'Spárovat',cancel:'Založit nový'});
   }finally{swingPairPending.delete(draft.positionId)}
   swingPairDecisions.set(draft.positionId,ok?cand.id:'NEW');
   // deník se mezitím mohl změnit (jiný import, ruční uložení) → načíst znovu
   return importSwingCtraderEventNow(journalId,e);
  }
  if(cand){
   idx=data.trades.indexOf(cand);
   trade=FJSwing.mergeImported({...cand,positionId:draft.positionId,ctraderAccount:draft.ctraderAccount},draft);
  }else{
   if(data.trades.some(t=>t?.id===draft.id))draft.id=draft.id+'_'+Date.now().toString(36);
   draft.createdAt=new Date().toISOString();
   trade=draft;
  }
 }else if(e.type==='trade_opened'&&!FJSwing.isGroupTrade(trade)){
  trade=FJSwing.mergeImported(trade,draft);
 }
 if(e.type==='trade_closed'){
  const res=FJSwing.applyCtraderClose(trade,e,lot);
  trade=res.trade;
 }
 const changed=JSON.stringify(trade)!==before;
 if(!changed&&!data.__settingsChanged)return 'done';
 if(changed){
  const imgs=await capturedImages(e);
  if(imgs.length)trade={...trade,images:[...new Set([...(trade.images||[]),...imgs])].slice(0,4)};
  trade.updatedAt=new Date().toISOString();
  if(idx>=0)data.trades[idx]=trade;else data.trades.push(trade);
 }
 const settingsChanged=!!data.__settingsChanged;
 delete data.__settingsChanged;
 const w=await window.desktopAPI.writeJournal(journalId,data);
 if(!w?.ok)return 'error';
 if(settingsChanged&&journalId===activeJournalId&&typeof settings==='object'){
  const main=data.settings.find(s=>s?.key==='main');
  if(main?.value?.cfdInstruments)settings.cfdInstruments=main.value.cfdInstruments;
 }
 return 'done';
}
// Synchronizace swing deníku přímo z cTrader Desktopu přes MCP (bez cBota): otevřené pozice
// (get_positions, se SL / TP) a provedené obchody (get_order_history, každé uzavření = noha).
// Jen pro aktivní swing deník a jen když je v cTraderu aktivní účet vybraný v deníku
// (odpovědi číslo účtu nenesou). Výpočet je FJSwing.planMcpSync; zápis jen při změně, před
// prvním zápisem v sezení záloha deníku. Ruční obchod odpovídající pozici se spáruje jen po potvrzení.
let swingSyncBackedUp=false;
let swingMcpSyncBusy=false;
let swingMcpLast=null; // { at, ok, message, accounts, active }
let swingMcpFirstSyncDone=false;
const MCP_ACCOUNT_REASON={
 NO_ACCOUNT:'Vyber v Nastavení → Instrumenty a účty → Swing · CFD, který účet cTraderu patří tomuto deníku.',
 NO_BALANCE:'cTrader nevrátil údaje o účtu.',
 UNKNOWN_ACTIVE:'Aktivní účet v cTraderu nejde poznat.',
 AMBIGUOUS:'Aktivní účet v cTraderu nejde jednoznačně poznat (víc účtů se stejným brokerem, měnou a zůstatkem).',
 OTHER_ACTIVE:'V cTraderu je aktivní jiný účet, než který patří tomuto deníku – přepni účet v cTraderu.'
};
function accountLabel(a){return a?`${a.brokerTitle||a.broker||'?'} · ${a.login} · ${a.currency||''}${a.isLive===false?' · demo':''}`:'—'}
async function syncSwingFromMcp({manual=false}={}){
 if(swingMcpSyncBusy||!isSwingJournalActive())return null;
 const s=mcpSettings();
 if(!s.enabled||!window.desktopAPI?.ctraderSyncData){
  swingMcpLast={at:new Date().toISOString(),ok:false,message:'Import z cTraderu přes MCP je vypnutý (Nastavení → Připojení a zdroje dat → cTrader → „Limitky z cTraderu přes MCP“).'};
  renderSwingMcpStatus();if(manual)showToast(swingMcpLast.message);return null;
 }
 swingMcpSyncBusy=true;
 try{
  const r=await window.desktopAPI.ctraderSyncData(s.url);
  if(!r?.available){swingMcpLast={at:new Date().toISOString(),ok:false,message:'cTrader nevypadá spuštěný (MCP server neodpovídá).'};return null}
  const check=FJSwing.mcpActiveAccountCheck(settings.ctraderMcpAccount,r.balance,r.accounts);
  swingMcpAccountOk=check.ok;
  if(Array.isArray(r.orders))mcpState={available:true,orders:r.orders.map(FJSwing.pendingFromMcp).filter(Boolean),account:r.balance?{broker:r.balance.brokerName||null,currency:r.balance.depositAsset||null,balance:r.balance.balance??null}:mcpState.account,fetchedAt:r.fetchedAt||new Date().toISOString()};
  // okamžitý P/L jen pro účet, který patří deníku
  swingLivePositions=new Map(check.ok?(r.positions||[]).map(p=>['ctrader-'+p.id,{currentPrice:p.currentPrice,netProfit:p.netProfit,grossProfit:p.grossProfit,pips:p.pips,at:r.fetchedAt||new Date().toISOString()}]):[]);
  const active=(r.accounts||[]).find(a=>a.brokerTitle===r.balance?.brokerName&&a.currency===r.balance?.depositAsset&&Number(a.balance)===Number(r.balance?.balance))||null;
  if(!check.ok){
   swingMcpLast={at:new Date().toISOString(),ok:false,message:MCP_ACCOUNT_REASON[check.reason]||'Účet nesouhlasí.',accounts:r.accounts,active};
   if(manual)showToast(swingMcpLast.message);
   return null;
  }
  // velikost lotu: tabulka CFD instrumentů → otevřená pozice → detail symbolu z cTraderu (uloží se do tabulky)
  const lots=new Map();
  for(const p of r.positions||[])if(Number(p.lotSize)>0)lots.set(FJSwing.normalizeSymbol(p.symbolName),Number(p.lotSize));
  const need=new Set((r.history||[]).map(h=>FJSwing.normalizeSymbol(h.symbolName)).filter(sym=>!swingInstrumentOf(sym)?.lotSize&&!lots.has(sym)));
  const added=[];
  for(const sym of need){
   const d=await window.desktopAPI.ctraderSymbolDetails?.(s.url,sym);
   const lot=Number(d?.details?.lotSize);
   if(d?.available&&lot>0){lots.set(sym,lot);const inst=swingInstrumentOf(sym);added.push({symbol:sym,lotSize:lot,pipSize:inst?.pipSize??(Number(d.details.pipSize)||null),priceDecimals:inst?.priceDecimals??(Number.isFinite(Number(d.details.digits))?Number(d.details.digits):null),assetClass:inst?.assetClass||'OTHER',baseCcy:inst?.baseCcy||'',quoteCcy:inst?.quoteCcy||''})}
  }
  if(added.length){
   const stored=(Array.isArray(settings.cfdInstruments)?settings.cfdInstruments:[]).filter(x=>!added.some(a=>a.symbol===FJSwing.normalizeSymbol(x?.symbol)));
   await persistSettings({cfdInstruments:[...stored,...added]});
  }
  const opts=()=>({lotSizeOf:(sym,pos)=>swingInstrumentOf(sym)?.lotSize||(pos&&Number(pos.lotSize)>0?Number(pos.lotSize):null)||lots.get(sym)||null,
   importFrom:settings.ctraderImportFrom||'',decisions:swingPairDecisions,nowLocal:FJSwing.berlinNowLocal(),nowIso:new Date().toISOString()});
  // plánované obchody: snímky cTrader limitek (jen když je známý seznam limitek), párování
  // naplnění na pozice a jeden obchod za skupinu – před planMcpSync, aby pozice skupin
  // už měly svůj obchod (žádná otázka na spárování, žádný druhý obchod)
  const groupSources=Array.isArray(r.orders)?['MANUAL','CTRADER']:['MANUAL'];
  const groupOrders=()=>[...manualPendingOrders(),...(Array.isArray(r.orders)?mcpState.orders:[])];
  const stageOf=data=>FJOrderGroups.syncStage(data.orderGroups||[],data.trades||[],groupOrders(),r,orderGroupOpts({sources:groupSources,lotSizeOf:sym=>opts().lotSizeOf(sym,null)}));
  let staged=stageOf(db.data);
  let plan=FJSwing.planMcpSync(staged.trades,r,opts());
  for(const p of plan.pairs){
   const cand=(db.data.trades||[]).find(t=>t.id===p.candidateId);
   const ok=await showConfirm(`Z cTraderu přišla pozice ${p.draft.symbol} ${p.draft.direction==='short'?'SHORT':'LONG'} otevřená ${String(p.draft.openedAt||'').replace('T',' ')}.\nV deníku je ručně zadaný obchod ${cand?.symbol||''} z ${String(cand?.openedAt||'').replace('T',' ')}, který jí nejspíš odpovídá.\n\nSpárovat = k ručnímu obchodu se doplní jen prázdná pole a výstupy z cTraderu. Založit nový = vznikne druhý obchod.`,{title:'Spárovat obchod z cTraderu',ok:'Spárovat',cancel:'Založit nový'});
   swingPairDecisions.set(p.positionId,ok?p.candidateId:'NEW');
  }
  staged=stageOf(db.data);
  plan=FJSwing.planMcpSync(staged.trades,r,opts());
  const missing=[...plan.missingLot];
  for(const sym of missing)swingImportWaiting.set(sym,(swingImportWaiting.get(sym)||0)+1);
  const incomplete=r.stats&&Number(r.stats.totalTrades)>(r.history||[]).length;
  let result={created:0,updated:0};
  if(plan.created||plan.updated||staged.changed){
   if(!swingSyncBackedUp){
    const b=await window.desktopAPI?.backupJournal?.(activeJournalId,'pred-synchronizaci-ctrader');
    if(!b||b.ok!==true){swingMcpLast={at:new Date().toISOString(),ok:false,message:'Zálohu deníku před synchronizací nejde vytvořit – nic se nezapsalo.'};return null}
    swingSyncBackedUp=true;
   }
   result=await commitJournal(j=>{
    const st=stageOf(j);
    if(st.changed)j.orderGroups=st.groups;
    const p=FJSwing.planMcpSync(st.trades,r,opts());j.trades=p.trades;
    return {created:p.created+st.created,updated:p.updated+st.updated};
   });
  }
  swingMcpLast={at:new Date().toISOString(),ok:true,accounts:r.accounts,active,
   message:`cTrader: nové ${result.created} · aktualizované ${result.updated} · otevřené pozice ${(r.positions||[]).length} · uzavření v historii ${(r.history||[]).length}${missing.length?` · čeká (chybí velikost lotu): ${missing.join(', ')}`:''}${incomplete?' · historie v cTraderu je neúplná – v TradeWatch → History nastav období „All“':''}`};
  if(result.created||result.updated)await load();
  if(manual||result.created||result.updated)showToast(swingMcpLast.message);
  return result;
 }catch(e){
  swingMcpLast={at:new Date().toISOString(),ok:false,message:'Synchronizace z cTraderu selhala: '+e.message};
  return null;
 }finally{
  swingMcpSyncBusy=false;
  renderSwingMcpStatus();
  renderSwingPositions();
  renderPendingOrders();
 }
}
function renderSwingMcpStatus(){
 const el=$('swingMcpStatus');
 if(el)el.innerHTML=swingMcpLast?`<span class="${swingMcpLast.ok?'':'neg'}">${esc(swingMcpLast.message)}</span> <span class="sub">(${new Date(swingMcpLast.at).toLocaleTimeString('cs-CZ')})</span>`:'';
 const acc=$('swingMcpAccountInfo');
 if(acc){
  const sel=settings.ctraderMcpAccount;
  acc.innerHTML=`Vybraný účet: <b>${esc(sel?accountLabel(sel):'žádný')}</b>${swingMcpLast?.active?` · v cTraderu je teď aktivní ${esc(accountLabel(swingMcpLast.active))}`:''}`;
 }
 const pick=$('swingMcpAccountSelect');
 if(pick&&swingMcpLast?.accounts?.length){
  const sel=settings.ctraderMcpAccount;
  pick.innerHTML='<option value="">— vyber účet —</option>'+swingMcpLast.accounts.map(a=>`<option value="${esc(String(a.login))}" ${sel&&String(sel.login)===String(a.login)?'selected':''}>${esc(accountLabel(a))}</option>`).join('');
 }
 renderSwingImportNotice();
}
function renderSwingImportNotice(){
 const box=$('swingImportNotice');
 if(!box)return;
 const waiting=[...swingImportWaiting.entries()];
 box.style.display=waiting.length?'':'none';
 box.textContent=waiting.length?`Obchody z cTraderu čekají na import – doplň velikost lotu (jednotek v 1 lotu) pro ${waiting.map(([s,n])=>`${s} (${n})`).join(', ')} v Nastavení → Instrumenty a účty → Swing · CFD (s cTraderem přes MCP se doplní sama).`:'';
}

// ---------- Přehled účtu a Kalendář (swing zadání §5) ----------
// Nohy aktivního swing deníku jako řádky kalendáře (P/L podle dne výstupu).
function swingActiveLegRows(){
 const p=activeJournalProfile();
 const o={journalId:activeJournalId,journalName:p?.name||'',classify:v=>classifyResult(v,settings)};
 return swingRows().flatMap(t=>FJSwing.swingLegRows(t,o));
}
// Řádek swing obchodu / nohy v Přehledu a v detailu dne (místo futures karty).
function swingOverviewRowHTML(r){
 const orig=r.journalId===activeJournalId?findSwing(r.swingId):null;
 const cls=signCls(r.pnlRaw);
 const head=`<b>${esc(r.instrument||'—')}</b> ${dirPill(r.side)} <span class="src-pill">swing</span>${r.journalName?` <span class="pill journal-pill">${esc(r.journalName)}</span>`:''}`;
 const edit=orig?`<button class="btn" data-swing-open="${esc(r.swingId)}">Upravit</button>`:'';
 if(r.swingLeg){
  return `<div class="swing-card" data-swing-row="${esc(r.id)}"><div class="swing-card-head"><div>${head} <span class="sub">noha výstupu</span></div><div class="swing-actions">${edit}</div></div>
   <div class="swing-kpis"><span><span class="sub">Uzavřeno</span>${fmtLocal(r.legClosedAt)}</span><span><span class="sub">Cena</span>${fmtPrice(r.legPrice,r.instrument)}</span><span><span class="sub">Objem</span>${fmtNum(r.legVolume,4)}</span>${r.legReason?`<span><span class="sub">Důvod</span>${esc(FJSwing.EXIT_REASON_LABELS[r.legReason]||r.legReason)}</span>`:''}<span><span class="sub">Otevřeno</span>${fmtLocal(r.tradeOpenedAt)}</span><span><span class="sub">Netto</span><b class="${cls}">${fmtMoney(r.pnlRaw)}</b></span></div></div>`;
 }
 return `<div class="swing-card" data-swing-row="${esc(r.id)}"><div class="swing-card-head"><div>${head}</div><div class="swing-actions">${edit}</div></div>
  <div class="swing-kpis"><span><span class="sub">Otevřeno</span>${fmtLocal(r.openedAt)}</span><span><span class="sub">Uzavřeno</span>${fmtLocal(r.closedAt)}</span><span><span class="sub">Vstup → výstup</span>${fmtPrice(r.entryPrice,r.instrument)} → ${fmtPrice(r.exitPrice,r.instrument)}</span><span><span class="sub">Objem · nohy</span>${fmtNum(r.contracts,4)} · ${r.legs}</span><span><span class="sub">Držení</span>${fmtNum(r.holdingDays,1)} d</span><span><span class="sub">R z ceny</span>${r.rMultiple!=null?fmtNum(r.rMultiple,2)+' R':'—'}</span><span><span class="sub">Netto</span><b class="${cls}">${fmtMoney(r.pnlRaw)}</b></span>${r.setupCode?`<span><span class="sub">Setup</span>${esc(r.setupCode)}</span>`:''}</div></div>`;
}

// ---------- napojení na hlavní skript ----------
(function wireSwingUi(){
 const navBtn=document.querySelector('.nav [data-section="openPositions"]');
 if(navBtn)navBtn.addEventListener('click',()=>{renderPositionsTab();if(mcpSettings().enabled)startMcpPolling()});
 document.querySelectorAll('.nav [data-section]').forEach(b=>{if(b!==navBtn)b.addEventListener('click',stopMcpPolling)});
 $('addManualOrderBtn')?.addEventListener('click',()=>openOrderModal(null));
 $('addSwingPositionBtn')?.addEventListener('click',()=>openSwingModal(null));
 $('refreshOrdersBtn')?.addEventListener('click',()=>void refreshMcpOrders());
 $('swingSyncNowBtn')?.addEventListener('click',()=>void syncSwingFromMcp({manual:true}));
 setInterval(()=>{if(isSwingJournalActive()&&mcpSettings().enabled)void syncSwingFromMcp()},5*60*1000);
 // „Upravit" u swing řádku v Přehledu / detailu dne (vykresluje se mimo seznam Deníku)
 document.addEventListener('click',e=>{const b=e.target.closest?.('[data-swing-open]');if(!b)return;const t=findSwing(b.dataset.swingOpen);if(t){e.preventDefault();openSwingModal(t)}});
})();
