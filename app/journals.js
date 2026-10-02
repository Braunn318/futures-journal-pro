'use strict';
// Viditelnost deníků na jednom místě (4.7.2).
//
// Deník jde skrýt: zmizí z výběru deníku, z Přehledu účtu, Kalendáře, Reportů
// i z nabídky přesunu obchodu, ale data zůstávají a jdou do záloh. Skrytý deník
// nesmí zůstat aktivní – aplikace by v něm pracovala, a přitom by nebyl vidět
// ve výběru. Rozhodnutí „který deník je aktivní" a „co ukázat v Přehledu při
// startu" proto žije tady, jako čisté funkce ověřené testem.
//
// Příznak `hidden` se v profilu ukládá jen jako true; chybějící = viditelný.
//
// Modul se načítá přes <script src> před hlavním skriptem (bundler v projektu
// není) a zároveň jde načíst v Node testech.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FJJournals = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Výchozí režim Přehledu účtu při startu: jen poslední aktivní deník.
  const OVERVIEW_START = { ACTIVE: 'active', ALL: 'all' };

  function isHidden(profile) { return profile?.hidden === true; }

  function visibleJournals(profiles) {
    return (Array.isArray(profiles) ? profiles : []).filter(p => p && !isHidden(p));
  }

  function isVisibleId(profiles, id) {
    return !!id && visibleJournals(profiles).some(p => p.id === id);
  }

  // Aktivní deník: uložený, pokud existuje a je viditelný; jinak naposledy
  // použitý viditelný; jinak první viditelný. Bez viditelného deníku ''.
  function resolveActiveJournal(profiles, activeId, previousId) {
    if (isVisibleId(profiles, activeId)) return activeId;
    if (isVisibleId(profiles, previousId)) return previousId;
    return visibleJournals(profiles)[0]?.id || '';
  }

  // Poslední viditelný deník skrýt nejde – aplikace by neměla kam přepnout.
  function canHide(profiles, id) {
    if (!isVisibleId(profiles, id)) return false;
    return visibleJournals(profiles).length > 1;
  }

  // Hodnota filtru „Deník / karta" v Přehledu účtu při startu ('' = všechny).
  function overviewStartJournal(mode, activeId, profiles) {
    if (mode === OVERVIEW_START.ALL) return '';
    return isVisibleId(profiles, activeId) ? activeId : '';
  }

  return {
    OVERVIEW_START,
    isHidden,
    visibleJournals,
    resolveActiveJournal,
    canHide,
    overviewStartJournal
  };
}));
