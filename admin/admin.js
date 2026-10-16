/* ─────────────────────────────────────────────────────────────
   Site editor (/admin)
   Runs entirely in the browser. Every change is saved as a commit
   to the GitHub repository through the GitHub API, and GitHub Pages
   rebuilds the site 1–2 minutes later.

   Login: the GitHub token is entered once, encrypted with the chosen
   username + password (PBKDF2 + AES-GCM) and stored in admin/key.json.
   After that, username + password are enough on any device.
   ───────────────────────────────────────────────────────────── */
'use strict';

/* Only needed if the site later moves to a custom domain: "owner/repo" */
const REPO_OVERRIDE = '';

const KEY_PATH = 'admin/key.json';
const ITER = 600000;
const FILES = {
  profile: '_data/profile.yml',
  cv: '_data/cv.yml',
  projects: '_data/projects.yml',
  links: '_data/links.yml',
  documents: '_data/documents.yml',
  config: '_config.yml'
};
const SITE_ROOT = location.pathname.replace(/admin(\/.*)?$/, '');

/* ---------- small helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const te = new TextEncoder();
const b64FromBytes = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const bytesFromB64 = b => Uint8Array.from(atob(String(b).replace(/\s/g, '')), c => c.charCodeAt(0));
const utf8b64 = s => b64FromBytes(te.encode(s));
const b64utf8 = b => new TextDecoder().decode(bytesFromB64(b));
const today = () => new Date().toLocaleDateString('sv');   // YYYY-MM-DD, local time
const slugify = s => String(s || '')
  .replace(/[çÇ]/g, 'c').replace(/[ğĞ]/g, 'g').replace(/[ıIİ]/g, 'i').replace(/[öÖ]/g, 'o').replace(/[şŞ]/g, 's').replace(/[üÜ]/g, 'u')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
const safeFileName = name => {
  const m = String(name).match(/^(.*?)(\.[A-Za-z0-9]+)?$/);
  return (slugify(m[1]) || 'file') + (m[2] || '').toLowerCase();
};
const store = {
  get(k) { try { return sessionStorage.getItem(k) || localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v, remember) { try { (remember ? localStorage : sessionStorage).setItem(k, v); } catch {} },
  clear(k) { try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch {} },
  remembered(k) { try { return !!localStorage.getItem(k); } catch { return false; } }
};

let toastTimer;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = bad ? 'bad' : ''; }, bad ? 7000 : 3800);
}

/* ---------- repository ---------- */
function detectRepo() {
  const q = new URLSearchParams(location.search).get('repo');
  const pick = v => { const [owner, repo] = v.split('/'); return owner && repo ? { owner, repo } : null; };
  if (q) return pick(q);
  if (REPO_OVERRIDE) return pick(REPO_OVERRIDE);
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (!m) return null;
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: seg && seg !== 'admin' ? seg : `${m[1]}.github.io`.toLowerCase() };
}

async function apiError(r) {
  let msg = ''; try { msg = (await r.json()).message || ''; } catch {}
  let text;
  if (r.status === 401) text = 'Erişim anahtarı (token) geçersiz ya da süresi dolmuş. Çıkış yapıp girişte “Token’ı yenile”yi kullan.';
  else if (r.status === 403 && /rate limit/i.test(msg)) text = 'GitHub istek sınırına ulaşıldı. Birkaç dakika sonra tekrar dene.';
  else if (r.status === 403) text = 'Bu token’ın depoya yazma izni yok. Token’da “Contents: Read and write” izni olmalı.';
  else if (r.status === 404) text = 'Depo ya da dosya bulunamadı.';
  else if (r.status === 409 || (r.status === 422 && /sha/i.test(msg))) text = 'Dosya bu arada başka yerden değişmiş. Sayfayı yenileyip tekrar dene.';
  else text = `GitHub hatası (${r.status})${msg ? ': ' + msg : ''}`;
  return Object.assign(new Error(text), { status: r.status });
}

const gh = {
  owner: '', repo: '', branch: '', token: '',
  base() { return `https://api.github.com/repos/${this.owner}/${this.repo}`; },
  async req(path, opt = {}) {
    const headers = { Accept: 'application/vnd.github+json' };
    const tok = opt.token ?? this.token;
    if (tok && !opt.anon) headers.Authorization = 'Bearer ' + tok;
    if (opt.body) headers['Content-Type'] = 'application/json';
    let r;
    try { r = await fetch(this.base() + path, { method: opt.method || 'GET', headers, body: opt.body ? JSON.stringify(opt.body) : undefined, cache: 'no-store' }); }
    catch { throw new Error('GitHub’a bağlanılamadı. İnternet bağlantını kontrol et.'); }
    if (opt.allow404 && r.status === 404) return null;
    if (!r.ok) throw await apiError(r);
    return r.status === 204 ? null : r.json();
  },
  enc(p) { return p.split('/').map(encodeURIComponent).join('/'); },
  get(path, opt = {}) { return this.req(`/contents/${this.enc(path)}${this.branch ? '?ref=' + encodeURIComponent(this.branch) : ''}`, { allow404: true, ...opt }); },
  async readText(path) { const j = await this.get(path); return j && j.content !== undefined ? { text: b64utf8(j.content), sha: j.sha } : null; },
  async list(dir) { const j = await this.get(dir); return Array.isArray(j) ? j : []; },
  async put(path, b64, message, sha, token) {
    const body = { message, content: b64 }; if (this.branch) body.branch = this.branch; if (sha) body.sha = sha;
    const j = await this.req(`/contents/${this.enc(path)}`, { method: 'PUT', body, token });
    return j.content.sha;
  },
  del(path, sha, message) { return this.req(`/contents/${this.enc(path)}`, { method: 'DELETE', body: { message, sha, branch: this.branch } }); },
  async tree() { return (await this.req(`/git/trees/${encodeURIComponent(this.branch)}?recursive=1`)).tree || []; }
};

/* ---------- login key (token encrypted with username + password) ---------- */
async function deriveKey(user, pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(user.trim().toLowerCase() + '\n' + pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(token, user, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(user, pass, salt, ITER);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify({ token }))));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64FromBytes(salt), iv: b64FromBytes(iv), data: b64FromBytes(data) };
}
async function unseal(box, user, pass) {
  try {
    const key = await deriveKey(user, pass, bytesFromB64(box.salt), box.iter || ITER);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytesFromB64(box.iv) }, key, bytesFromB64(box.data));
    return JSON.parse(new TextDecoder().decode(pt)).token || null;
  } catch { return null; }
}
async function loadBoxes() {
  const out = [];
  try {
    const j = await gh.get(KEY_PATH, { anon: true });
    if (j && j.content) out.push({ box: JSON.parse(b64utf8(j.content)), sha: j.sha });
    if (j === null) return out;           // the repository has no key yet
  } catch {}
  try { const r = await fetch('key.json', { cache: 'no-store' }); if (r.ok) out.push({ box: await r.json(), sha: null }); } catch {}
  return out;
}
async function writeBox(token, user, pass) {
  const box = await seal(token, user, pass);
  const cur = await gh.get(KEY_PATH, { token });
  await gh.put(KEY_PATH, utf8b64(JSON.stringify(box, null, 2) + '\n'), 'Update site editor login', cur && cur.sha, token);
}

/* ---------- boot, login and setup screens ---------- */
const app = () => $('#app');

async function boot() {
  if (!window.jsyaml || !window.crypto || !crypto.subtle) {
    app().innerHTML = '<div class="box"><p>Düzenleyici yüklenemedi. Sayfayı yenile; olmazsa güncel bir tarayıcı kullan.</p></div>'; return;
  }
  const r = detectRepo();
  if (!r) { app().innerHTML = '<div class="box"><p>Depo adı bulunamadı. admin/admin.js içindeki REPO_OVERRIDE satırına <code>kullanıcı/depo</code> yaz.</p></div>'; return; }
  Object.assign(gh, r);
  let firstErr = null;
  try { gh.branch = (await gh.req('', { anon: true })).default_branch; } catch (e) { firstErr = e; }
  const saved = store.get('admin.token');
  if (saved) {
    try { const info = await gh.req('', { token: saved }); gh.branch = info.default_branch; gh.token = saved; return enterApp(); }
    catch (e) { if (e.status === 401) store.clear('admin.token'); else { app().innerHTML = `<div class="box"><p class="err">${esc(e.message)}</p></div>`; return; } }
  }
  const boxes = await loadBoxes();
  if (boxes.length) return showLogin(boxes);
  if (firstErr && firstErr.status !== 404) { app().innerHTML = `<div class="box"><p class="err">${esc(firstErr.message)}</p></div>`; return; }
  showSetup(false);
}

function showLogin(boxes, msg = '') {
  app().innerHTML = `
  <div class="login">
    <h1 class="h">Giriş</h1>
    <p class="lead">Siteyi düzenlemek için kullanıcı adın ve şifrenle gir.</p>
    <form class="box" id="loginForm" autocomplete="on">
      <label class="f"><span>Kullanıcı adı</span><input type="text" name="user" autocomplete="username" autocapitalize="none" required></label>
      <label class="f"><span>Şifre</span><input type="password" name="pass" autocomplete="current-password" required></label>
      <label class="c"><input type="checkbox" name="remember"> Bu cihazda beni hatırla</label>
      <p class="err" id="err">${esc(msg)}</p>
      <div class="row-actions"><button class="b primary" type="submit">Giriş yap</button></div>
    </form>
    <p class="hint">Şifreni mi unuttun ya da token’ın süresi mi doldu? <button class="linkish" type="button" id="toSetup">Token’ı yenile</button></p>
  </div>`;
  $('#toSetup').onclick = () => showSetup(true);
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Giriş yapılıyor…'; $('#err').textContent = '';
    let token = null;
    for (const b of boxes) { token = await unseal(b.box, f.user.value, f.pass.value); if (token) break; }
    if (!token) { $('#err').textContent = 'Kullanıcı adı ya da şifre yanlış.'; btn.disabled = false; btn.textContent = 'Giriş yap'; return; }
    try { const info = await gh.req('', { token }); gh.branch = gh.branch || info.default_branch; }
    catch (err) {
      $('#err').textContent = err.status === 401 ? 'Şifre doğru ama kayıtlı token’ın süresi dolmuş. “Token’ı yenile” ile yeni token gir.' : err.message;
      btn.disabled = false; btn.textContent = 'Giriş yap'; return;
    }
    gh.token = token; store.set('admin.token', token, f.remember.checked);
    enterApp();
  };
  $('#loginForm input[name=user]').focus();
}

function showSetup(reset) {
  const repoName = `${gh.owner}/${gh.repo}`;
  app().innerHTML = `
  <div class="login">
    <h1 class="h">${reset ? 'Token’ı yenile' : 'İlk kurulum'}</h1>
    <p class="lead">${reset ? 'Yeni bir token gir ve giriş bilgilerini yeniden belirle. Eski şifre geçersiz olur.' : 'Bu adım bir kez yapılır. Sonra her cihazdan sadece kullanıcı adı ve şifreyle girersin.'}</p>
    <div class="box">
      <h2>1 · GitHub token’ı oluştur</h2>
      <ol>
        <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Bu sayfayı aç ↗</a> (GitHub hesabınla giriş yapmış ol).</li>
        <li><b>Token name:</b> site-editor · <b>Expiration:</b> en uzun süreyi seç.</li>
        <li><b>Repository access:</b> Only select repositories → <code>${esc(repoName)}</code></li>
        <li><b>Permissions:</b> + Add permissions → <b>Contents</b> → <b>Read and write</b>.</li>
        <li><b>Generate token</b>’a bas, çıkan <code>github_pat_…</code> metnini kopyala.</li>
      </ol>
    </div>
    <form class="box" id="setupForm">
      <h2>2 · Token’ı yapıştır, giriş bilgilerini belirle</h2>
      <label class="f"><span>Token</span><input type="password" name="token" placeholder="github_pat_…" autocomplete="off" required></label>
      <label class="f"><span>Kullanıcı adı</span><input type="text" name="user" autocomplete="username" autocapitalize="none" required></label>
      <label class="f"><span>Şifre</span><input type="password" name="pass" autocomplete="new-password" minlength="10" required><small>En az 10 karakter. Token bu şifreyle şifrelenip depoya kaydedilir, o yüzden tahmin edilmesi zor bir şifre seç.</small></label>
      <label class="f"><span>Şifre (tekrar)</span><input type="password" name="pass2" autocomplete="new-password" required></label>
      <label class="c"><input type="checkbox" name="remember"> Bu cihazda beni hatırla</label>
      <p class="err" id="err"></p>
      <div class="row-actions"><button class="b primary" type="submit">Kaydet ve giriş yap</button>${reset ? '<button class="b" type="button" id="back">Vazgeç</button>' : ''}</div>
    </form>
  </div>`;
  if (reset) $('#back').onclick = () => boot();
  $('#setupForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type=submit]'), err = $('#err');
    const token = f.token.value.trim(), user = f.user.value.trim(), pass = f.pass.value;
    err.textContent = '';
    if (pass.length < 10) return err.textContent = 'Şifre en az 10 karakter olmalı.';
    if (pass !== f.pass2.value) return err.textContent = 'Şifreler aynı değil.';
    btn.disabled = true; btn.textContent = 'Kaydediliyor…';
    try {
      const info = await gh.req('', { token }); gh.branch = gh.branch || info.default_branch;
      await writeBox(token, user, pass);
      gh.token = token; store.set('admin.token', token, f.remember.checked);
      toast('Kurulum tamam. Artık kullanıcı adı ve şifreyle girebilirsin.');
      enterApp();
    } catch (x) {
      err.textContent = x.status === 401 ? 'Token geçersiz. Kopyalarken eksik kalmış olabilir.' : x.message;
      btn.disabled = false; btn.textContent = 'Kaydet ve giriş yap';
    }
  };
}

function logout() {
  if (dirty && !confirm('Kaydedilmemiş değişiklikler var. Yine de çıkılsın mı?')) return;
  dirty = false; store.clear('admin.token'); gh.token = ''; location.hash = ''; location.reload();
}

/* ---------- app shell and routing ---------- */
const TABS = [['profil', 'Profil'], ['ozgecmis', 'Özgeçmiş'], ['projeler', 'Projeler'], ['linkler', 'Linkler'], ['blog', 'Blog'], ['belgeler', 'Belgeler'], ['ayarlar', 'Ayarlar']];
let S = null, dirty = false, curHash = '', ignoreHash = false;

function enterApp() {
  $('#who').innerHTML = `<button class="linkish" type="button" id="logout">Çıkış yap</button>`;
  $('#logout').onclick = logout;
  app().innerHTML = `<nav class="tabs" id="tabs" aria-label="Bölümler"></nav><div id="view"></div>`;
  const v = $('#view');
  v.addEventListener('input', onInput);
  v.addEventListener('change', onChange);
  v.addEventListener('click', onClick);
  route();
}
window.addEventListener('hashchange', () => {
  if (ignoreHash) { ignoreHash = false; return; }
  if (!gh.token || !$('#view')) return;
  if (dirty && !confirm('Kaydedilmemiş değişiklikler var. Sayfadan çıkılsın mı?')) { ignoreHash = true; location.hash = curHash; return; }
  route();
});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

async function route() {
  dirty = false; S = null;
  curHash = location.hash || '#profil';
  const [tab, ...rest] = curHash.slice(1).split('/');
  const name = TABS.some(t => t[0] === tab) ? tab : 'profil';
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<a href="#${k}"${k === name ? ' aria-current="page"' : ''}>${l}</a>`).join('');
  const v = $('#view');
  v.innerHTML = '<p class="muted">Yükleniyor…</p>';
  try { await VIEWS[name](rest.map(decodeURIComponent)); }
  catch (e) { v.innerHTML = `<div class="box"><p class="err">${esc(e.message)}</p><p><button class="b" type="button" onclick="location.reload()">Yeniden dene</button></p></div>`; }
}

/* ---------- generic form binding ---------- */
function getPath(o, p) { if (p === '' || p == null) return o; return String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o); }
function setPath(o, p, v) {
  const ks = String(p).split('.'); let x = o;
  ks.slice(0, -1).forEach((k, i) => { if (x[k] == null) x[k] = /^\d+$/.test(ks[i + 1]) ? [] : {}; x = x[k]; });
  x[ks[ks.length - 1]] = v;
}
const val = p => getPath(S.data, p);
const F = {
  text: (label, p, o = {}) => `<label class="f"><span>${label}</span><input type="${o.type || 'text'}" data-path="${p}" value="${esc(val(p))}" placeholder="${esc(o.ph || '')}"${o.attrs || ''}>${o.hint ? `<small>${o.hint}</small>` : ''}</label>`,
  area: (label, p, o = {}) => `<label class="f"><span>${label}</span><textarea rows="${o.rows || 3}" data-path="${p}"${o.cls ? ` class="${o.cls}"` : ''}${o.id ? ` id="${o.id}"` : ''} placeholder="${esc(o.ph || '')}">${esc(val(p))}</textarea>${o.hint ? `<small>${o.hint}</small>` : ''}</label>`,
  lines: (label, p, o = {}) => `<label class="f"><span>${label}</span><textarea rows="${o.rows || 4}" data-path="${p}" data-kind="lines">${esc((val(p) || []).join('\n'))}</textarea><small>${o.hint || 'Her satıra bir tane.'}</small></label>`,
  check: (label, p) => `<label class="c"><input type="checkbox" data-path="${p}"${val(p) ? ' checked' : ''}> ${label}</label>`
};
function card(p, i, len, title, body, delLabel = 'Sil') {
  return `<div class="item"><div class="item-bar"><b>${esc(title)}</b><span class="tools">
    <button class="ib" type="button" data-act="up" data-path="${p}" ${i === 0 ? 'disabled' : ''} title="Yukarı taşı" aria-label="Yukarı taşı">↑</button>
    <button class="ib" type="button" data-act="down" data-path="${p}" ${i === len - 1 ? 'disabled' : ''} title="Aşağı taşı" aria-label="Aşağı taşı">↓</button>
    <button class="ib danger" type="button" data-act="del" data-path="${p}">${delLabel}</button></span></div>${body}</div>`;
}
const addBtn = (p, tpl, label) => `<button class="b add" type="button" data-act="add" data-path="${p}" data-tpl="${tpl}">+ ${label}</button>`;
const TPL = {
  row: { when: '', what: '', details: '' },
  rowsSection: { title: 'New section', rows: [{ when: '', what: '', details: '' }] },
  tagsSection: { title: 'New section', tags: [] },
  social: { name: '', url: '' },
  contact: { label: '', value: '', url: '' },
  project: { title: '', year: String(new Date().getFullYear()), status: 'In progress', description: '', url: '' },
  group: { group: '', links: [{ name: '', url: '', note: '' }] },
  link: { name: '', url: '', note: '' }
};

function markDirty() {
  if (!dirty) { dirty = true; const st = $('#state'); if (st) { st.textContent = 'Kaydedilmemiş değişiklikler var'; st.classList.add('dirty'); } }
}
function savebar(label = 'Kaydet') {
  return `<div class="savebar"><span class="state${dirty ? ' dirty' : ''}" id="state">${dirty ? 'Kaydedilmemiş değişiklikler var' : 'Tüm değişiklikler kaydedildi'}</span><button class="b primary" type="button" data-act="save">${label}</button></div>`;
}
function draw() { $('#view').innerHTML = S.render(); if (S.after) S.after(); }

function onInput(e) {
  const el = e.target, p = el.dataset.path;
  if (p == null || el.type === 'file') return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.kind === 'lines') v = v.split('\n').map(s => s.trim()).filter(Boolean);
  setPath(S.data, p, v); markDirty();
}
function onChange(e) {
  const el = e.target;
  if (el.type === 'file' && el.dataset.upload && S.uploads && S.uploads[el.dataset.upload]) { S.uploads[el.dataset.upload](el); return; }
  if (el.type === 'checkbox' && el.dataset.path != null) onInput(e);
  if (el.dataset.act && S.actions && S.actions[el.dataset.act]) S.actions[el.dataset.act](el);
}
async function onClick(e) {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
  const act = b.dataset.act, p = b.dataset.path;
  if (act === 'save') return runSave(b);
  if (S.actions && S.actions[act]) return S.actions[act](b, e);
  if (act === 'add') { const arr = getPath(S.data, p) || []; arr.push(clone(TPL[b.dataset.tpl])); if (p) setPath(S.data, p, arr); }
  else if (act === 'del' || act === 'up' || act === 'down') {
    const ks = p.split('.'), i = +ks.pop(), arr = getPath(S.data, ks.join('.'));
    if (act === 'del') { if (!confirm('Bu öğe silinsin mi? (Kaydet’e basınca kalıcı olur)')) return; arr.splice(i, 1); }
    else { const j = act === 'up' ? i - 1 : i + 1; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; }
  } else return;
  markDirty(); const y = scrollY; draw(); scrollTo(0, y);
}
async function runSave(btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'Kaydediliyor…';
  try {
    const msg = await S.save();
    dirty = false; const st = $('#state'); if (st) { st.textContent = 'Tüm değişiklikler kaydedildi'; st.classList.remove('dirty'); }
    toast(msg || 'Kaydedildi. Site 1–2 dakika içinde güncellenir.');
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = old;
}

/* ---------- YAML files ---------- */
function cleanData(v, depth = 0) {
  if (Array.isArray(v)) return v.map(x => cleanData(x, depth + 1)).filter(x => !(x && typeof x === 'object' && !Array.isArray(x) && !Object.keys(x).length) && x !== '');
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const c = cleanData(x, depth + 1);
      if (depth > 0 && (c === '' || c === false || c == null)) continue;   // optional fields left empty
      o[k] = c;
    }
    return o;
  }
  return typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : v;
}
function dumpYaml(data, header) {
  const body = jsyaml.dump(cleanData(clone(data)), { lineWidth: -1, noRefs: true, quotingType: '"' });
  return (header ? header.trimEnd() + '\n\n' : '') + body;
}
async function loadYaml(path) {
  const f = await gh.readText(path);
  const text = f ? f.text : '';
  const header = (text.match(/^(?:[ \t]*(?:#.*)?\r?\n)*/) || [''])[0];
  let data = null;
  try { data = jsyaml.load(text); } catch (e) { throw new Error(`${path} dosyası okunamadı (YAML hatası). GitHub’da elle düzeltilmesi gerekiyor: ${e.reason || e.message}`); }
  return { data, sha: f && f.sha, header };
}
async function yamlView(path, render, fallback, prep) {
  const y = await loadYaml(path);
  S = { path, data: y.data ?? fallback, sha: y.sha, header: y.header, render, save: saveYaml };
  if (prep) prep(S);
  draw();
}
async function saveYaml() {
  S.sha = await gh.put(S.path, utf8b64(dumpYaml(S.data, S.header)), `Update ${S.path.split('/').pop()} from the site editor`, S.sha);
}

/* ---------- Profile ---------- */
function renderProfile() {
  const d = S.data;
  ['info', 'social', 'contact'].forEach(k => { if (!Array.isArray(d[k])) d[k] = []; });
  const photoSrc = S.photoPreview || (d.photo ? SITE_ROOT + d.photo.replace(/^\//, '') + '?v=' + Date.now() : '');
  return `
  <h1 class="h">Profil</h1><p class="lead">Sol sütun, “About” yazısı ve iletişim sayfası.</p>
  <section class="box"><h2>Fotoğraf</h2>
    <div class="photo-row">${d.photo || S.photoPreview ? `<img src="${esc(photoSrc)}" alt="">` : '<span class="ph"></span>'}
      <div><span class="b filebtn">Yeni fotoğraf yükle<input type="file" accept="image/*" data-upload="photo"></span>
      <p class="hint">Kare olarak ortadan kırpılır ve hemen kaydedilir.</p></div></div>
    <label class="c"><input type="checkbox" data-act="hidephoto"${d.photo ? '' : ' checked'}> Fotoğrafı gizle (yerine baş harfler görünür)</label>
  </section>
  <section class="box"><h2>Kimlik</h2>
    <div class="grid2">${F.text('Ad soyad', 'name')}${F.text('Kısa ad', 'short_name', { hint: '“Hello, I’m …” başlığında görünür.' })}</div>
    ${F.text('Baş harfler', 'initials', { hint: 'Sadece fotoğraf gizliyse görünür.' })}
    ${F.area('Kısa tanıtım (sol sütun)', 'tagline', { rows: 2 })}
    ${F.lines('Bilgi satırları (sol sütun)', 'info', { rows: 3 })}
  </section>
  <section class="box"><h2>About yazısı</h2>
    ${F.area('Metin', 'about', { rows: 12, hint: 'Paragraflar arasında bir boş satır bırak. **kalın**, *italik*, [link yazısı](https://adres) yazabilirsin.' })}
  </section>
  <section class="box"><h2>Sosyal linkler (sol sütun)</h2>
    ${d.social.map((s, i) => card(`social.${i}`, i, d.social.length, s.name || 'Yeni link', `<div class="grid2">${F.text('Ad', `social.${i}.name`, { ph: 'LinkedIn' })}${F.text('Adres', `social.${i}.url`, { type: 'url', ph: 'https://…' })}</div>`)).join('')}
    ${addBtn('social', 'social', 'Link ekle')}
  </section>
  <section class="box"><h2>İletişim sayfası</h2>
    ${F.area('Giriş cümlesi', 'contact_text', { rows: 2 })}
    ${d.contact.map((c, i) => card(`contact.${i}`, i, d.contact.length, c.label || 'Yeni satır', `<div class="grid3">${F.text('Etiket', `contact.${i}.label`, { ph: 'Email' })}${F.text('Görünen değer', `contact.${i}.value`)}${F.text('Link (isteğe bağlı)', `contact.${i}.url`, { ph: 'https://…' })}</div>${F.check('“Copy” düğmesi göster', `contact.${i}.copy`)}`)).join('')}
    ${addBtn('contact', 'contact', 'Satır ekle')}
  </section>
  ${savebar()}`;
}
const profileExtras = s => {
  s.actions = { hidephoto: el => { S.data.photo = el.checked ? '' : '/assets/photo.jpg'; markDirty(); } };
  s.uploads = {
    photo: async el => {
      const file = el.files[0]; if (!file) return;
      try {
        toast('Fotoğraf hazırlanıyor…');
        const blob = await squareJpeg(file, 640);
        const b64 = b64FromBytes(new Uint8Array(await blob.arrayBuffer()));
        const cur = await gh.get('assets/photo.jpg');
        await gh.put('assets/photo.jpg', b64, 'Update profile photo from the site editor', cur && cur.sha);
        S.photoPreview = 'data:image/jpeg;base64,' + b64;
        if (S.data.photo !== '/assets/photo.jpg') { S.data.photo = '/assets/photo.jpg'; await saveYaml(); }
        draw(); toast('Fotoğraf yüklendi. Site 1–2 dakika içinde güncellenir.');
      } catch (e) { toast(e.message, true); }
    }
  };
};
function loadImage(file) {
  return new Promise((ok, bad) => { const u = URL.createObjectURL(file), im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error('Bu resim açılamadı.')); im.src = u; });
}
async function squareJpeg(file, size) {
  const im = await loadImage(file), s = Math.min(im.naturalWidth, im.naturalHeight);
  const c = document.createElement('canvas'); c.width = c.height = Math.min(size, s);
  c.getContext('2d').drawImage(im, (im.naturalWidth - s) / 2, (im.naturalHeight - s) / 2, s, s, 0, 0, c.width, c.height);
  return new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.88));
}
async function shrinkImage(file, maxW) {
  const im = await loadImage(file);
  if (im.naturalWidth <= maxW && file.size < 1.5e6) return { blob: file, ext: (file.name.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase() };
  const k = Math.min(1, maxW / im.naturalWidth), c = document.createElement('canvas');
  c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
  return { blob: await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.85)), ext: '.jpg' };
}

/* ---------- CV ---------- */
function renderCV() {
  const d = S.data;
  return `
  <h1 class="h">Özgeçmiş</h1><p class="lead">Ana sayfanın alt kısmı. Bölümler “satırlı” (solda tarih, sağda başlık ve açıklama) ya da “etiketli” (yan yana kutucuklar) olabilir.</p>
  ${d.map((b, i) => card(`${i}`, i, d.length, b.title || 'Yeni bölüm', `
    ${F.text('Bölüm başlığı', `${i}.title`)}
    <div class="seg" role="group" aria-label="Bölüm türü"><button type="button" data-act="cvtype" data-i="${i}" data-type="rows" class="${b.tags ? '' : 'on'}">Satırlar</button><button type="button" data-act="cvtype" data-i="${i}" data-type="tags" class="${b.tags ? 'on' : ''}">Etiketler</button></div>
    ${b.tags ? F.lines('Etiketler', `${i}.tags`, { rows: 5 }) :
      (b.rows || []).map((r, j) => card(`${i}.rows.${j}`, j, b.rows.length, r.what || 'Yeni satır', `
        <div class="grid2">${F.text('Sol taraf (tarih / etiket)', `${i}.rows.${j}.when`, { ph: '2024 – 2026' })}${F.text('Başlık', `${i}.rows.${j}.what`)}</div>
        ${F.area('Açıklama (isteğe bağlı)', `${i}.rows.${j}.details`, { rows: 2 })}`)).join('') + addBtn(`${i}.rows`, 'row', 'Satır ekle')}
  `, 'Bölümü sil')).join('')}
  <div class="row-actions">${addBtn('', 'rowsSection', 'Satırlı bölüm ekle')}${addBtn('', 'tagsSection', 'Etiketli bölüm ekle')}</div>
  ${savebar()}`;
}
const cvExtras = s => {
  s.actions = {
    cvtype: b => {
      const sec = S.data[+b.dataset.i], to = b.dataset.type;
      if (to === 'tags' && !sec.tags) { sec.tags = (sec.rows || []).map(r => r.what).filter(Boolean); delete sec.rows; }
      else if (to === 'rows' && sec.tags) { sec.rows = sec.tags.map(t => ({ when: '', what: t, details: '' })); if (!sec.rows.length) sec.rows.push(clone(TPL.row)); delete sec.tags; }
      else return;
      markDirty(); draw();
    }
  };
};

/* ---------- Projects ---------- */
function renderProjects() {
  const d = S.data;
  return `
  <h1 class="h">Projeler</h1><p class="lead">“Projects” sayfası. Taslak işaretli olanlar sitede görünmez.</p>
  ${d.map((x, i) => card(`${i}`, i, d.length, (x.title || 'Yeni proje') + (x.draft ? ' (taslak)' : ''), `
    ${F.text('Başlık', `${i}.title`)}
    <div class="grid2">${F.text('Yıl', `${i}.year`)}${F.text('Durum', `${i}.status`, { ph: 'Live / In progress / Completed' })}</div>
    ${F.area('Açıklama', `${i}.description`, { rows: 3 })}
    ${F.text('Link (isteğe bağlı)', `${i}.url`, { ph: 'https://… ya da /documents/dosya.pdf' })}
    ${F.check('Taslak (sitede gizli)', `${i}.draft`)}`)).join('')}
  ${addBtn('', 'project', 'Proje ekle')}
  ${savebar()}`;
}

/* ---------- Links ---------- */
function renderLinks() {
  const d = S.data;
  return `
  <h1 class="h">Linkler</h1><p class="lead">“Links” sayfası. Linkler gruplar halinde görünür.</p>
  ${d.map((g, i) => {
    g.links = g.links || [];
    return card(`${i}`, i, d.length, g.group || 'Yeni grup', `
      ${F.text('Grup adı', `${i}.group`)}
      ${g.links.map((l, j) => card(`${i}.links.${j}`, j, g.links.length, l.name || 'Yeni link', `
        <div class="grid2">${F.text('Ad', `${i}.links.${j}.name`)}${F.text('Adres', `${i}.links.${j}.url`, { type: 'url', ph: 'https://…' })}</div>
        ${F.text('Not (isteğe bağlı)', `${i}.links.${j}.note`)}`)).join('')}
      ${addBtn(`${i}.links`, 'link', 'Link ekle')}`, 'Grubu sil');
  }).join('')}
  ${addBtn('', 'group', 'Grup ekle')}
  ${savebar()}`;
}

/* ---------- Blog ---------- */
function parsePost(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  let fm = {}; try { fm = jsyaml.load(m[1]) || {}; } catch {}
  return { fm, body: m[2].replace(/^\s*\n/, '') };
}
const postDate = name => (name.match(/^(\d{4}-\d{2}-\d{2})-/) || [, ''])[1];
const postSlug = name => name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.(md|markdown|html)$/i, '');
const tagList = t => (Array.isArray(t) ? t : String(t || '').split(',')).map(s => String(s).trim()).filter(Boolean);

async function blogView(rest) {
  if (rest[0] === 'new') return postEditor(null);
  if (rest[0] === 'edit' && rest[1]) return postEditor(rest[1]);
  const files = (await gh.list('_posts')).filter(f => f.type === 'file' && /\.(md|markdown)$/i.test(f.name));
  const posts = await Promise.all(files.map(async f => {
    const t = await gh.readText(f.path); const { fm } = parsePost(t ? t.text : '');
    return { name: f.name, sha: f.sha, fm };
  }));
  posts.sort((a, b) => b.name.localeCompare(a.name));
  S = {
    data: {}, posts,
    render: () => `
      <h1 class="h">Blog</h1><p class="lead">Yazı ekle, düzenle ya da sil.</p>
      <div class="row-actions"><a class="b primary" href="#blog/new">+ Yeni yazı</a></div>
      ${posts.length ? `<ul class="list">${posts.map(p => {
        const d = postDate(p.name), draftish = p.fm.published === false, future = d > today();
        return `<li><div class="grow"><b>${esc(p.fm.title || postSlug(p.name))}${draftish ? '<span class="badge">taslak</span>' : ''}${future ? '<span class="badge">ileri tarihli</span>' : ''}</b><small>${esc(d)}${p.fm.summary ? ' · ' + esc(p.fm.summary) : ''}</small></div>
          <a class="ib" href="#blog/edit/${encodeURIComponent(p.name)}">Düzenle</a>
          <button class="ib danger" type="button" data-act="delpost" data-name="${esc(p.name)}">Sil</button></li>`;
      }).join('')}</ul>` : '<p class="muted">Henüz yazı yok.</p>'}`,
    actions: {
      delpost: async b => {
        const p = posts.find(x => x.name === b.dataset.name);
        if (!confirm(`“${p.fm.title || p.name}” kalıcı olarak silinsin mi?`)) return;
        try { await gh.del('_posts/' + p.name, p.sha, `Delete post ${p.name}`); toast('Yazı silindi.'); route(); } catch (e) { toast(e.message, true); }
      }
    }
  };
  draw();
}

async function postEditor(name) {
  let fm = {}, body = '', sha = null;
  if (name) {
    const f = await gh.readText('_posts/' + name);
    if (!f) throw new Error('Yazı bulunamadı. Silinmiş olabilir.');
    ({ fm, body } = parsePost(f.text)); sha = f.sha;
  }
  const extra = { ...fm }; ['title', 'summary', 'tags', 'math', 'published'].forEach(k => delete extra[k]);
  S = {
    name, sha, extra, preview: false,
    data: { title: fm.title || '', summary: fm.summary || '', tags: tagList(fm.tags).join(', '), date: name ? postDate(name) : today(), math: !!fm.math, draft: fm.published === false, body },
    render: renderPostEditor, save: savePost,
    actions: {
      preview: () => { S.preview = !S.preview; draw(); },
      delthis: async () => {
        if (!confirm('Bu yazı kalıcı olarak silinsin mi?')) return;
        try { await gh.del('_posts/' + S.name, S.sha, `Delete post ${S.name}`); dirty = false; toast('Yazı silindi.'); location.hash = '#blog'; } catch (e) { toast(e.message, true); }
      }
    },
    uploads: { img: uploadPostImage }
  };
  draw();
}
function renderPostEditor() {
  const d = S.data, live = S.name && !d.draft && d.date <= today();
  return `
  <p><a href="#blog">← Tüm yazılar</a></p>
  <h1 class="h">${S.name ? 'Yazıyı düzenle' : 'Yeni yazı'}</h1>
  <section class="box">
    ${F.text('Başlık', 'title')}
    ${F.text('Özet (listede görünür)', 'summary')}
    <div class="grid2">${F.text('Tarih', 'date', { type: 'date', hint: 'İleri tarihli yazılar o gün gelene kadar görünmez.' })}${F.text('Etiketler', 'tags', { ph: 'materials, internship', hint: 'Virgülle ayır.' })}</div>
    ${F.check('Taslak (sitede gösterme)', 'draft')}
    ${F.check('Matematik formülleri kullan ($$E = mc^2$$)', 'math')}
  </section>
  <section class="box"><h2>Yazı</h2>
    <div class="row-actions">
      <button class="b" type="button" data-act="preview">${S.preview ? 'Düzenlemeye dön' : 'Önizleme'}</button>
      ${S.preview ? '' : '<span class="b filebtn">Resim ekle<input type="file" accept="image/*" data-upload="img"></span>'}
    </div>
    ${S.preview ? `<div class="preview prose">${previewHtml(d.body || '')}</div>` :
      F.area('Metin', 'body', { rows: 18, cls: 'big', id: 'bodyArea', hint: '### Ara başlık · **kalın** · *italik* · [link](https://…) · - madde · > alıntı · Paragraflar arasında boş satır bırak.' })}
  </section>
  <div class="row-actions">${live ? `<a class="b" href="${SITE_ROOT}blog/${esc(postSlug(S.name))}/" target="_blank" rel="noopener">Sitede görüntüle ↗</a>` : ''}${S.name ? '<button class="b danger" type="button" data-act="delthis">Yazıyı sil</button>' : ''}</div>
  ${savebar(S.name ? 'Kaydet' : 'Yayınla')}`;
}
function previewHtml(md) {
  if (!window.marked) return `<pre>${esc(md)}</pre>`;
  // images uploaded a moment ago are not on the site yet, so show them straight from GitHub
  const raw = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.branch}/`;
  return marked.parse(md).replace(/(<img[^>]+src=")\/(?!\/)/g, '$1' + raw);
}
async function uploadPostImage(el) {
  const file = el.files[0]; if (!file) return;
  try {
    toast('Resim yükleniyor…');
    const { blob, ext } = await shrinkImage(file, 1600);
    const base = slugify(file.name.replace(/\.[^.]+$/, '')) || 'image';
    const path = `assets/images/${today()}-${base}-${Date.now().toString(36).slice(-4)}${ext}`;
    await gh.put(path, b64FromBytes(new Uint8Array(await blob.arrayBuffer())), `Add image ${path.split('/').pop()}`);
    const md = `![${base.replace(/-/g, ' ')}](/${path})`;
    const ta = $('#bodyArea'), d = S.data;
    const at = ta ? ta.selectionStart : d.body.length;
    d.body = d.body.slice(0, at) + (at && d.body[at - 1] !== '\n' ? '\n\n' : '') + md + '\n' + d.body.slice(at);
    markDirty(); draw(); toast('Resim eklendi. Yazıyı kaydetmeyi unutma.');
  } catch (e) { toast(e.message, true); }
}
async function savePost() {
  const d = S.data;
  if (!d.title.trim()) throw new Error('Başlık boş olamaz.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new Error('Tarih geçerli değil.');
  const fm = { title: d.title.trim(), ...S.extra };
  if (d.summary.trim()) fm.summary = d.summary.trim();
  const tags = tagList(d.tags); if (tags.length) fm.tags = tags;
  if (d.math) fm.math = true;
  if (d.draft) fm.published = false;
  const text = '---\n' + jsyaml.dump(fm, { lineWidth: -1, flowLevel: 1, quotingType: '"' }) + '---\n\n' + d.body.replace(/\r\n/g, '\n').trim() + '\n';
  let slug = S.name ? postSlug(S.name) : slugify(d.title);
  if (!slug) slug = 'post';
  let name = `${d.date}-${slug}.md`;
  if (!S.name || name !== S.name) {
    const existing = new Set((await gh.list('_posts')).map(f => f.name));
    if (!S.name) { let k = 2; while (existing.has(name)) name = `${d.date}-${slug}-${k++}.md`; }
    else if (existing.has(name)) throw new Error('Bu tarihte aynı adlı başka bir yazı var.');
  }
  const newSha = await gh.put('_posts/' + name, utf8b64(text), `${S.name ? 'Update' : 'Add'} post ${name}`, name === S.name ? S.sha : null);
  if (S.name && name !== S.name) await gh.del('_posts/' + S.name, S.sha, `Rename post ${S.name} → ${name}`);
  const wasNew = !S.name;
  S.name = name; S.sha = newSha;
  curHash = '#blog/edit/' + encodeURIComponent(name);
  history.replaceState(null, '', curHash);
  setTimeout(() => { draw(); }, 0);
  return wasNew && !d.draft ? 'Yazı yayınlandı. Sitede 1–2 dakika içinde görünür.' : null;
}

/* ---------- Documents ---------- */
async function docsView() {
  const [tree, y] = await Promise.all([gh.tree(), loadYaml(FILES.documents)]);
  const files = tree.filter(t => t.type === 'blob' && t.path.startsWith('documents/') && !/\.(html|yml|md)$/i.test(t.path));
  const meta = Array.isArray(y.data) ? y.data : [];
  files.forEach(f => { const n = f.path.split('/').pop(); if (!meta.some(m => m.file === n)) meta.push({ file: n, title: '', description: '', category: '' }); });
  S = { path: FILES.documents, header: y.header, sha: y.sha, files, data: { meta }, render: renderDocs,
    save: async () => {
      const keep = S.data.meta.filter(m => (m.title || m.description || m.category) && S.files.some(f => f.path.endsWith('/' + m.file)));
      S.sha = await gh.put(S.path, utf8b64(dumpYaml(keep, S.header)), 'Update documents.yml from the site editor', S.sha);
    },
    actions: {
      deldoc: async b => {
        const f = S.files.find(x => x.path === b.dataset.p);
        if (!confirm(`“${f.path.split('/').pop()}” kalıcı olarak silinsin mi?`)) return;
        try { await gh.del(f.path, f.sha, `Delete ${f.path}`); S.files = S.files.filter(x => x !== f); draw(); toast('Belge silindi.'); } catch (e) { toast(e.message, true); }
      }
    },
    uploads: { doc: uploadDocs }
  };
  draw();
}
function renderDocs() {
  const meta = S.data.meta;
  const groups = {};
  S.files.forEach(f => { const parts = f.path.split('/').slice(1, -1); (groups[parts.join(' / ') || 'Genel'] ||= []).push(f); });
  return `
  <h1 class="h">Belgeler</h1><p class="lead">“Documents” sayfası. Yüklenen her dosya orada otomatik listelenir.</p>
  <section class="box"><h2>Dosya yükle</h2>
    <label class="f"><span>Klasör (isteğe bağlı)</span><input type="text" id="docFolder" placeholder="ör. Lecture notes"><small>Sayfada grup başlığı olarak görünür. Boş bırakırsan “General” grubuna girer.</small></label>
    <div class="row-actions"><span class="b primary filebtn">Dosya seç ve yükle<input type="file" multiple data-upload="doc"></span><span class="hint" id="upState"></span></div>
  </section>
  ${Object.keys(groups).sort().map(g => `<section class="box"><h2>${esc(g)}</h2>${groups[g].map(f => {
    const n = f.path.split('/').pop(), i = meta.findIndex(m => m.file === n);
    return `<div class="item"><div class="item-bar"><b>${esc(n)}</b><span class="tools"><a class="ib" href="${SITE_ROOT}${f.path.split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener">Aç ↗</a><button class="ib danger" type="button" data-act="deldoc" data-p="${esc(f.path)}">Sil</button></span></div>
      <div class="grid2">${F.text('Başlık (isteğe bağlı)', `meta.${i}.title`, { ph: n.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') })}${F.text('Kategori (isteğe bağlı)', `meta.${i}.category`, { hint: 'Doluysa klasör adının yerine geçer.' })}</div>
      ${F.text('Açıklama (isteğe bağlı)', `meta.${i}.description`)}</div>`;
  }).join('')}</section>`).join('') || '<p class="muted">Henüz belge yok.</p>'}
  ${S.files.length ? savebar('Başlıkları kaydet') : ''}`;
}
async function uploadDocs(el) {
  const list = [...el.files]; if (!list.length) return;
  const folder = String(($('#docFolder') || {}).value || '').split('/').map(s => s.trim()).filter(Boolean).join('/');
  const st = $('#upState');
  for (const [k, file] of list.entries()) {
    if (file.size > 40e6) { toast(`${file.name} çok büyük (en fazla 40 MB).`, true); continue; }
    const path = 'documents/' + (folder ? folder + '/' : '') + safeFileName(file.name);
    const old = S.files.find(f => f.path === path);
    if (old && !confirm(`${path.split('/').pop()} zaten var. Üzerine yazılsın mı?`)) continue;
    if (st) st.textContent = `Yükleniyor ${k + 1}/${list.length}: ${file.name}…`;
    try {
      const sha = await gh.put(path, b64FromBytes(new Uint8Array(await file.arrayBuffer())), `Upload ${path}`, old && old.sha);
      if (old) old.sha = sha; else S.files.push({ path, sha, type: 'blob' });
      const n = path.split('/').pop();
      if (!S.data.meta.some(m => m.file === n)) S.data.meta.push({ file: n, title: '', description: '', category: '' });
    } catch (e) { toast(e.message, true); }
  }
  S.files.sort((a, b) => a.path.localeCompare(b.path));
  const keepDirty = dirty; draw(); if (keepDirty) markDirty();
  toast('Yükleme bitti. Belgeler sayfası 1–2 dakika içinde güncellenir.');
}

/* ---------- Settings ---------- */
async function settingsView() {
  const f = await gh.readText(FILES.config);
  const cfg = f ? (jsyaml.load(f.text) || {}) : {};
  S = { sha: f && f.sha, text: f ? f.text : '', data: { title: cfg.title || '', description: cfg.description || '', url: cfg.url || '' },
    render: renderSettings, save: saveSettings,
    actions: { creds: updateCreds, logout } };
  draw();
}
function renderSettings() {
  return `
  <h1 class="h">Ayarlar</h1>
  <section class="box"><h2>Site bilgileri</h2>
    ${F.text('Site başlığı', 'title', { hint: 'Arama motorlarında ve sekme başlığında görünür.' })}
    ${F.area('Site açıklaması', 'description', { rows: 2 })}
    ${F.text('Site adresi', 'url', { type: 'url', ph: 'https://kullanici-adi.github.io' })}
    ${savebar()}
  </section>
  <section class="box" id="credBox"><h2>Giriş bilgileri</h2>
    <p>Kullanıcı adını, şifreni ya da token’ı değiştir. Token alanını boş bırakırsan mevcut token kullanılır.</p>
    <label class="f"><span>Yeni token (isteğe bağlı)</span><input type="password" id="cToken" placeholder="github_pat_…" autocomplete="off"></label>
    <div class="grid2"><label class="f"><span>Kullanıcı adı</span><input type="text" id="cUser" autocomplete="username" autocapitalize="none"></label><span></span></div>
    <div class="grid2"><label class="f"><span>Yeni şifre</span><input type="password" id="cPass" autocomplete="new-password"></label><label class="f"><span>Yeni şifre (tekrar)</span><input type="password" id="cPass2" autocomplete="new-password"></label></div>
    <p class="err" id="cErr"></p>
    <div class="row-actions"><button class="b" type="button" data-act="creds">Giriş bilgilerini güncelle</button></div>
  </section>
  <section class="box"><h2>Oturum</h2>
    <p>${store.remembered('admin.token') ? 'Bu cihazda oturum açık kalıyor.' : 'Tarayıcı kapanınca oturum kapanır.'} Depo: <code>${esc(gh.owner)}/${esc(gh.repo)}</code></p>
    <div class="row-actions"><button class="b" type="button" data-act="logout">Çıkış yap</button></div>
  </section>`;
}
async function saveSettings() {
  let t = S.text;
  for (const k of ['title', 'description', 'url']) {
    const v = String(S.data[k] || '').trim(); if (!v && k !== 'description') continue;
    const re = new RegExp(`^${k}:.*$`, 'm'), line = `${k}: ${JSON.stringify(v)}`;
    t = re.test(t) ? t.replace(re, line) : t.trimEnd() + '\n' + line + '\n';
  }
  S.sha = await gh.put(FILES.config, utf8b64(t), 'Update site settings from the site editor', S.sha);
  S.text = t;
}
async function updateCreds() {
  const err = $('#cErr'), tokNew = $('#cToken').value.trim(), user = $('#cUser').value.trim(), pass = $('#cPass').value;
  err.textContent = '';
  if (!user) return err.textContent = 'Kullanıcı adı gerekli.';
  if (pass.length < 10) return err.textContent = 'Şifre en az 10 karakter olmalı.';
  if (pass !== $('#cPass2').value) return err.textContent = 'Şifreler aynı değil.';
  const token = tokNew || gh.token;
  try {
    if (tokNew) await gh.req('', { token });
    await writeBox(token, user, pass);
    gh.token = token; store.set('admin.token', token, store.remembered('admin.token'));
    ['cToken', 'cPass', 'cPass2'].forEach(id => { $('#' + id).value = ''; });
    toast('Giriş bilgileri güncellendi.');
  } catch (e) { err.textContent = e.status === 401 ? 'Yeni token geçersiz.' : e.message; }
}

/* ---------- views ---------- */
const VIEWS = {
  profil: () => yamlView(FILES.profile, renderProfile, {}, profileExtras),
  ozgecmis: () => yamlView(FILES.cv, renderCV, [], cvExtras),
  projeler: () => yamlView(FILES.projects, renderProjects, []),
  linkler: () => yamlView(FILES.links, renderLinks, []),
  blog: blogView,
  belgeler: docsView,
  ayarlar: settingsView
};

boot();
