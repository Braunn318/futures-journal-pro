(() => {
  'use strict';

  const PASSWORD_KEY = 'FuturesJournal_passwordHash';
  const LEGACY_PLAIN_KEY = 'FuturesJournal_passwordPlain';
  const SESSION_AUTH_KEY = 'FuturesJournal_sessionAuthenticated';
  const byId = (id) => document.getElementById(id);

  async function sha256(value) {
    const text = String(value ?? '');
    if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return null;
  }

  function hashPassword(value) {
    const text = String(value ?? '');
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 16777619);
      h2 = Math.imul(h2 ^ code, 2246822519);
    }
    return `v2-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
  }

  async function verifyPassword(entered) {
    const stored = localStorage.getItem(PASSWORD_KEY);
    if (!stored) return false;
    const secureHash = await sha256(entered);
    const matches = stored === secureHash || stored === hashPassword(entered) || stored === entered || localStorage.getItem(LEGACY_PLAIN_KEY) === entered;
    if (matches && stored !== secureHash && secureHash) localStorage.setItem(PASSWORD_KEY, secureHash);
    if (matches) localStorage.removeItem(LEGACY_PLAIN_KEY);
    return matches;
  }

  async function storePassword(value) {
    const secureHash = await sha256(value);
    localStorage.setItem(PASSWORD_KEY, secureHash || hashPassword(value));
    localStorage.removeItem(LEGACY_PLAIN_KEY);
  }

  function setError(message = '') {
    const element = byId('loginError');
    if (element) element.textContent = message;
  }

  function unlockInputs() {
    for (const id of ['loginPassword', 'loginPassword2', 'loginButton']) {
      const element = byId(id);
      if (!element) continue;
      element.disabled = false;
      element.removeAttribute('readonly');
      element.style.pointerEvents = 'auto';
    }
  }

  function authenticate() {
    const overlay = byId('loginOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    try { sessionStorage.setItem(SESSION_AUTH_KEY, '1'); } catch (e) { /* ignore */ }
    window.dispatchEvent(new CustomEvent('journal:authenticated'));
  }

  function setMode(setup) {
    const overlay = byId('loginOverlay');
    const password = byId('loginPassword');
    const confirmation = byId('loginPassword2');
    const hint = byId('loginHint');
    const button = byId('loginButton');
    if (!overlay || !password || !confirmation || !hint || !button) return;

    overlay.classList.remove('hidden');
    unlockInputs();
    password.value = '';
    confirmation.value = '';
    confirmation.style.display = setup ? 'block' : 'none';
    hint.textContent = setup
      ? 'Při prvním spuštění si vytvoř vlastní přihlašovací heslo.'
      : 'Přihlášení do obchodního deníku';
    button.textContent = setup ? 'Uložit heslo a vstoupit' : 'Přihlásit se';
    button.dataset.mode = setup ? 'setup' : 'login';
    setError('');
    requestAnimationFrame(() => {
      password.focus();
      password.click();
    });
  }

  async function submitLogin() {
    const button = byId('loginButton');
    const password = byId('loginPassword');
    const confirmation = byId('loginPassword2');
    if (!button || !password || !confirmation) return;

    unlockInputs();
    setError('');
    const entered = password.value;

    if (button.dataset.mode === 'setup') {
      if (entered.length < 4) return setError('Heslo musí mít alespoň 4 znaky.');
      if (entered !== confirmation.value) return setError('Hesla se neshodují.');
      await storePassword(entered);
      authenticate();
      return;
    }

    const stored = localStorage.getItem(PASSWORD_KEY);
    if (!stored) return setMode(true);
    const matches = await verifyPassword(entered);
    if (!matches) return setError('Nesprávné heslo.');
    authenticate();
  }

  function bind() {
    const button = byId('loginButton');
    const password = byId('loginPassword');
    const confirmation = byId('loginPassword2');
    if (!button || !password || !confirmation) return;

    unlockInputs();
    button.onclick = (event) => { event.preventDefault(); void submitLogin(); };
    const onEnter = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void submitLogin(); }
    };
    password.onkeydown = onEnter;
    confirmation.onkeydown = onEnter;

    for (const field of [password, confirmation]) {
      field.addEventListener('mousedown', () => field.focus());
      field.addEventListener('touchstart', () => field.focus(), { passive: true });
    }

    // Heslo se má vyžadovat jen jednou za spuštění aplikace, ne při každém
    // interním location.reload() (např. při přepnutí/vytvoření deníku).
    // sessionStorage přežije reload té samé stránky, ale ne zavření aplikace.
    let alreadyAuthenticated = false;
    try { alreadyAuthenticated = sessionStorage.getItem(SESSION_AUTH_KEY) === '1'; } catch (e) { /* ignore */ }
    if (alreadyAuthenticated && localStorage.getItem(PASSWORD_KEY)) {
      authenticate();
      return;
    }

    setMode(!localStorage.getItem(PASSWORD_KEY));
  }

  // Malé API pro zbytek aplikace (změna hesla, ruční zamknutí) – viz tlačítka
  // "Změnit heslo" a "Zamknout aplikaci" v Nastavení → Zabezpečení aplikace.
  window.FJAuth = {
    hasPassword: () => !!localStorage.getItem(PASSWORD_KEY),
    verifyPassword,
    setPassword: storePassword,
    lock: () => {
      try { sessionStorage.removeItem(SESSION_AUTH_KEY); } catch (e) { /* ignore */ }
      setMode(false);
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();

