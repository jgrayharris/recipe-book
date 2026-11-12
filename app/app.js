'use strict';
/*
  Harris House Recipes, the app. Sections:
    1. Settings and phone storage
    2. Book logic       (pure functions: search, filters, fridge matching, shopping list)
    3. Data             (recipes from the Kitchen; favorites and "we made it" from data/household.json)
    4. GitHub calls     (adding links, sending details, saving household changes)
    5. Screens          (book, recipe, cook mode, what we have, list, add, settings)
    6. Router and start-up
    7. Self-test        (open the app with ?test)
*/

const APP_VERSION = '1.0';
const DEFAULT_REPO = 'jgrayharris/recipe-book';
const HOUSEHOLD = ['Jordan', 'Lauren'];
// When the scheduled chef writes the cards. Set to '' if the repo gets an Anthropic API key
// (cards are then written within minutes).
const CHEF_SCHEDULE = 'Mondays and Thursdays at noon';
const readyWhen = () => CHEF_SCHEDULE ? `after the chef's next run (${CHEF_SCHEDULE})` : 'a few minutes later';
const NEW_DAYS = 10;
const DAY = 86400000;

/* ---------- 1. Settings and phone storage ---------- */

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('rb.' + key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem('rb.' + key, JSON.stringify(value)); } catch { /* private mode */ } },
};
const me = () => store.get('me', '');
const token = () => store.get('token', '');

function repoName() {
  const saved = store.get('repo', '');
  if (saved) return saved;
  const host = location.hostname.match(/^([^.]+)\.github\.io$/);
  const first = location.pathname.split('/').filter(Boolean)[0];
  return host && first ? `${host[1]}/${first}` : DEFAULT_REPO;
}

/* ---------- 2. Book logic ---------- */

const AISLES = ['produce', 'meat & seafood', 'dairy & eggs', 'bakery', 'pantry', 'international', 'spices', 'frozen', 'drinks', 'other'];
const CRAVINGS = [['comfort', '🍲'], ['spicy', '🌶️'], ['fresh', '🥗'], ['cheesy', '🧀'], ['crispy', '🍟'],
  ['sweet', '🍰'], ['light', '🥬'], ['hearty', '🍖'], ['saucy', '🍝'], ['zesty', '🍋']];
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'side', 'drink', 'sauce'];
const PROTEINS = ['chicken', 'beef', 'pork', 'lamb', 'turkey', 'seafood', 'eggs', 'vegetarian', 'none'];
const DIFFICULTIES = ['Easy', 'Moderate', 'Professional'];
const PROTEIN_EMOJI = { chicken: '🍗', beef: '🥩', pork: '🥓', lamb: '🍖', turkey: '🦃', seafood: '🦐', eggs: '🍳', vegetarian: '🥦' };
const MEAL_EMOJI = { dessert: '🍰', drink: '🍹', sauce: '🫙', snack: '🥨', breakfast: '🥞' };
const PLATFORMS = { tiktok: 'TikTok', instagram: 'Instagram', reddit: 'Reddit', youtube: 'YouTube', facebook: 'Facebook', pinterest: 'Pinterest' };
const SORTS = [['newest', 'Newest'], ['quickest', 'Quickest'], ['fewest', 'Fewest ingredients'], ['az', 'A to Z'], ['made', 'Most made']];

const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const singular = w => w.length > 3 ? w.replace(/ies$/, 'y').replace(/oes$/, 'o').replace(/([^s])s$/, '$1') : w;
const itemKey = s => norm(s).split(' ').map(singular).join(' ');

/** "chicken" matches "chicken thighs"; "egg" matches "eggs". Whole words only. */
function itemsMatch(have, need) {
  const a = itemKey(have), b = itemKey(need);
  if (!a || !b) return false;
  if (a === b) return true;
  return ` ${b} `.includes(` ${a} `) || ` ${a} `.includes(` ${b} `);
}

const emojiFor = r => PROTEIN_EMOJI[r.protein] || MEAL_EMOJI[(r.meal || []).find(m => MEAL_EMOJI[m])] || '🍽️';
const mainIngredients = r => (r.ingredients || []).filter(i => !i.staple);
/** A card for a post the kitchen couldn't read: just the link, waiting for the recipe to be pasted in. */
const isStub = r => !(r.ingredients || []).length && !(r.steps || []).length;
const entry = (hh, id) => hh.recipes[id] || { fav: [], log: [] };
const favBy = (hh, id) => entry(hh, id).fav || [];
const logFor = (hh, id) => entry(hh, id).log || [];
const isRecent = (r, now) => now - Date.parse(r.added_at || 0) < NEW_DAYS * DAY;

const hayCache = new WeakMap();
function haystack(r) {
  if (!hayCache.has(r)) {
    hayCache.set(r, norm([r.title, r.summary, r.cuisine, r.protein, ...(r.meal || []), ...(r.cravings || []),
      ...(r.ingredients || []).map(i => i.item), r.source?.author].join(' ')));
  }
  return hayCache.get(r);
}

function defaultFilters() {
  return { q: '', maxTime: 0, difficulty: [], meal: [], protein: [], cuisine: [], cravings: [], favorites: false, recent: false, sort: 'newest' };
}

function matches(r, f, hh, now) {
  if (f.q) {
    const hay = haystack(r);
    if (!norm(f.q).split(' ').every(w => hay.includes(singular(w)))) return false;
  }
  if (f.maxTime && !(r.total_minutes > 0 && r.total_minutes <= f.maxTime)) return false;
  if (isStub(r) && (f.difficulty.length || f.protein.length)) return false;   // its tags are blanks
  if (f.difficulty.length && !f.difficulty.includes(r.difficulty)) return false;
  if (f.meal.length && !f.meal.some(m => (r.meal || []).includes(m))) return false;
  if (f.protein.length && !f.protein.includes(r.protein)) return false;
  if (f.cuisine.length && !f.cuisine.includes(r.cuisine)) return false;
  if (f.cravings.length && !f.cravings.every(c => (r.cravings || []).includes(c))) return false;
  if (f.favorites && !favBy(hh, r.id).length) return false;
  if (f.recent && !isRecent(r, now)) return false;
  return true;
}

function sortRecipes(list, sort, hh) {
  const by = {
    newest: (a, b) => String(b.added_at).localeCompare(String(a.added_at)),
    quickest: (a, b) => (a.total_minutes || 999) - (b.total_minutes || 999),
    fewest: (a, b) => mainIngredients(a).length - mainIngredients(b).length,
    az: (a, b) => a.title.localeCompare(b.title),
    made: (a, b) => logFor(hh, b.id).length - logFor(hh, a.id).length || String(b.added_at).localeCompare(String(a.added_at)),
  }[sort] || (() => 0);
  return [...list].sort(by);
}

const filterRecipes = (recipes, f, hh, now = Date.now()) => sortRecipes(recipes.filter(r => matches(r, f, hh, now)), f.sort, hh);

function activeFilterCount(f) {
  return (f.maxTime ? 1 : 0) + f.difficulty.length + f.meal.length + f.protein.length + f.cuisine.length +
    f.cravings.length + (f.favorites ? 1 : 0) + (f.recent ? 1 : 0);
}

/** Recipes ranked by how little is missing, given what's in the kitchen. Staples are assumed. */
function fridgeRank(recipes, have) {
  return recipes.map(r => {
    const need = mainIngredients(r);
    const missing = need.filter(i => !have.some(h => itemsMatch(h, i.item)));
    return { r, total: need.length, have: need.length - missing.length, missing };
  }).filter(x => x.have > 0)
    .sort((a, b) => a.missing.length - b.missing.length || b.have - a.have || (a.r.total_minutes || 999) - (b.r.total_minutes || 999));
}

/** One combined list: each item once, grouped by aisle, with the line from each recipe. */
function shoppingList(recipes) {
  const items = new Map();
  for (const r of recipes) {
    for (const i of r.ingredients || []) {
      const key = itemKey(i.item);
      if (!items.has(key)) items.set(key, { key, item: i.item, aisle: i.aisle, staple: true, lines: [] });
      const it = items.get(key);
      it.staple = it.staple && i.staple;
      it.lines.push({ line: i.line, recipe: r.title });
    }
  }
  const all = [...items.values()].sort((a, b) => a.item.localeCompare(b.item));
  return {
    groups: AISLES.map(aisle => ({ aisle, items: all.filter(x => !x.staple && (AISLES.includes(x.aisle) ? x.aisle : 'other') === aisle) }))
      .filter(g => g.items.length),
    staples: all.filter(x => x.staple),
  };
}

function listAsText(list, checked) {
  const lines = [];
  for (const g of list.groups) {
    const left = g.items.filter(x => !checked.includes(x.key));
    if (!left.length) continue;
    lines.push(cap(g.aisle));
    for (const x of left) lines.push(`- ${x.lines.map(l => l.line).join(' + ')}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function fmtMinutes(m) {
  if (!m) return '?';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
const shortTime = m => !m ? '?' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}`;
const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); };
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const findLinks = text =>[...new Set((String(text || '').match(/https?:\/\/[^\s<>"'()\[\]{}]+/gi) || []).map(u => u.replace(/[.,;:!?*]+$/, '')))];

/* ---------- 3. Data ---------- */

const state = {
  recipes: [], byId: new Map(), generatedAt: '', loadError: '',
  household: { recipes: {} },
  filters: defaultFilters(),
  bookScroll: 0, lastView: '',
  ticked: new Map(),          // recipe id -> Set of ingredient indexes ticked off (this visit only)
  madeForm: null,             // { id, stars, note } while the "we made it" form is open
  cookStep: 0,
  queue: null,
};

function normalizeHousehold(data) {
  const out = { recipes: {} };
  for (const [id, e] of Object.entries((data && data.recipes) || {})) {
    out.recipes[id] = { fav: Array.isArray(e.fav) ? e.fav : [], log: Array.isArray(e.log) ? e.log : [] };
  }
  return out;
}

async function loadRecipes(force) {
  const res = await fetch('data/recipes.json', { cache: force ? 'reload' : 'no-cache' });
  if (!res.ok) throw new Error(`recipes.json answered ${res.status}`);
  const data = await res.json();
  state.recipes = (data.recipes || []).filter(r => r && r.id && r.title);
  state.byId = new Map(state.recipes.map(r => [r.id, r]));
  state.generatedAt = data.generated_at || '';
}

async function loadHousehold() {
  if (token()) {
    try { state.household = normalizeHousehold((await gh.readHousehold()).data); return; }
    catch (e) { console.warn('household from GitHub failed', e); }
  }
  try {
    const res = await fetch('data/household.json', { cache: 'no-cache' });
    if (res.ok) state.household = normalizeHousehold(await res.json());
  } catch { /* offline: keep what we have */ }
}

/** Change one recipe's household entry here at once, then save it for both phones.
 *  `change` must give the same result when run twice: it runs on our copy and on GitHub's newest copy. */
async function changeHousehold(id, change, message) {
  const mine = state.household.recipes[id] = entry(state.household, id);
  change(mine);
  render();
  if (!token()) { toast('Saved on this phone. Set it up in Settings to share with each other.'); return; }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data, sha } = await gh.readHousehold();
      const fresh = normalizeHousehold(data);
      const e = fresh.recipes[id] = entry(fresh, id);
      change(e);
      await gh.writeHousehold(fresh, sha, message);
      state.household = fresh;
      return;
    } catch (err) {
      if (err.status !== 409 && err.status !== 422) { toast(`Couldn't save that: ${err.message}`); return; }
    }
  }
  toast("Couldn't save that just now. Try again in a moment.");
}

/* ---------- 4. GitHub calls ---------- */

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(String(b64).replace(/\s/g, '')), c => c.charCodeAt(0)));

const gh = {
  async call(method, path, body) {
    const res = await fetch(`https://api.github.com/repos/${repoName()}${path}`, {
      method, cache: 'no-store',
      headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error({ 401: 'the setup code is wrong or expired', 403: "the setup code doesn't allow that", 404: "the repo wasn't found" }[res.status] || `GitHub answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  },
  async readHousehold() {
    try {
      const f = await this.call('GET', '/contents/data/household.json?ref=main');
      return { data: JSON.parse(b64decode(f.content)), sha: f.sha };
    } catch (e) {
      if (e.status === 404) return { data: {}, sha: null };
      throw e;
    }
  },
  writeHousehold(data, sha, message) {
    const body = { message, branch: 'main', content: b64encode(JSON.stringify(data, null, 2) + '\n') };
    if (sha) body.sha = sha;
    return this.call('PUT', '/contents/data/household.json', body);
  },
  addRecipe: (url, text) => gh.call('POST', '/issues', { title: 'Add recipe', body: `${text || url}\nfrom: ${me() || 'someone'}\nvia: app` }),
  addDetails: (id, text) => gh.call('POST', '/issues', { title: `Add details: ${id}`, body: `${text}\nfrom: ${me() || 'someone'}\nvia: app` }),
  async waiting() {
    const issues = await this.call('GET', '/issues?state=open&per_page=50');
    return issues.filter(i => !i.pull_request && /^add (recipe|details)/i.test(i.title));
  },
  async retry(n) {
    await this.call('DELETE', `/issues/${n}/labels/failed`).catch(() => {});
    await this.call('PATCH', `/issues/${n}`, { state: 'closed' });
    await this.call('PATCH', `/issues/${n}`, { state: 'open' });   // reopening wakes the Kitchen
  },
};

/* ---------- 5. Screens ---------- */

const $view = document.getElementById('view');
const photoHtml = (r, size) => r.photo
  ? `<img src="images/${esc(r.id)}${size === 'sm' ? '-sm' : ''}.jpg" alt="" loading="lazy" decoding="async" data-emoji="${emojiFor(r)}">`
  : `<div class="placeholder" aria-hidden="true">${emojiFor(r)}</div>`;
const diffHtml = r => `<span class="diff ${esc(r.difficulty)}">${esc(r.difficulty)}</span>`;

function greeting() {
  const h = new Date().getHours();
  const part = h < 11 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}${me() ? ', ' + esc(me()) : ''}.<br>What are we <em>cooking</em>?`;
}

function cardHtml(r, now, seen) {
  const loved = favBy(state.household, r.id).length > 0;
  const fresh = isRecent(r, now) && !seen.includes(r.id);
  const stub = isStub(r);
  return `<a class="card" href="#/r/${encodeURIComponent(r.id)}">
    <div class="photo">${photoHtml(r, 'sm')}
      ${stub ? '' : `<span class="pill time">⏱ ${shortTime(r.total_minutes)}</span>`}
      ${loved ? '<span class="pill heart" aria-label="Favorite">❤️</span>' : ''}
      ${fresh ? '<span class="pill new">NEW</span>' : ''}
    </div>
    <div class="meta"><h3>${esc(r.title)}</h3>
      <div class="sub">${stub ? '<span class="needs">✍️ waiting for the recipe</span>'
        : `${diffHtml(r)}<span>${esc(r.cuisine || '')}</span>${r.needs_details ? '<span class="needs">✍️ needs details</span>' : ''}`}</div>
    </div></a>`;
}

/** The book's top (greeting and search box) is drawn once; typing only redraws what's below it,
 *  so the phone keyboard stays open. */
function renderBook() {
  $view.innerHTML = `
    <div class="top"><span class="brand">HARRIS HOUSE RECIPES</span><a class="icon-btn" href="#/settings" aria-label="Settings">⚙️</a></div>
    <h1 class="hello">${greeting()}</h1>
    <div class="search"><span class="mag">🔍</span>
      <input id="q" type="search" placeholder="Search dishes, ingredients, cuisines…" value="${esc(state.filters.q)}" autocomplete="off" enterkeyhint="search">
      <button class="clear" data-act="clear-q" aria-label="Clear search"${state.filters.q ? '' : ' hidden'}>✕</button></div>
    <div id="bookBody"></div>`;
  const q = document.getElementById('q');
  q.addEventListener('input', () => {
    state.filters.q = q.value;
    q.nextElementSibling.hidden = !q.value;
    renderBookBody();
  });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') q.blur(); });
  renderBookBody();
}

function renderBookBody() {
  const body$ = document.getElementById('bookBody');
  if (!body$) return;
  const f = state.filters, now = Date.now(), seen = store.get('seen', []);
  const list = filterRecipes(state.recipes, f, state.household, now);
  const count = activeFilterCount(f);
  const tile = (act, emoji, label, on) => `<button class="tile${on ? ' on' : ''}" data-act="${act}"><span class="e">${emoji}</span>${label}</button>`;
  const active = [
    f.maxTime ? [`⏱ ${f.maxTime} min or less`, 'maxTime'] : null,
    ...f.difficulty.map(d => [d, 'difficulty:' + d]),
    ...f.meal.map(m => [cap(m), 'meal:' + m]),
    ...f.protein.map(p => [cap(p), 'protein:' + p]),
    ...f.cuisine.map(c => [c, 'cuisine:' + c]),
    f.favorites ? ['❤️ Favorites', 'favorites'] : null,
    f.recent ? ['New', 'recent'] : null,
  ].filter(Boolean);

  let body;
  if (state.loadError && !state.recipes.length) {
    body = `<div class="empty"><div class="big">📡</div><h2>Couldn't load the book</h2><p>${esc(state.loadError)}</p>
      <button class="btn" data-act="reload">Try again</button></div>`;
  } else if (!state.recipes.length) {
    body = `<div class="empty"><div class="big">🍳</div><h2>The book is empty, for now</h2>
      <p>Copy a TikTok, Instagram or Reddit link, then tap <b>Paste link and add</b> on the Add page. Each one shows up here ${readyWhen()}.</p>
      <a class="btn primary" href="#/add">Add a recipe</a></div>`;
  } else if (!list.length) {
    body = `<div class="empty"><div class="big">🤷</div><h2>Nothing matches</h2><p>Try fewer filters.</p>
      <button class="btn" data-act="clear-filters">Clear filters</button></div>`;
  } else {
    body = `<div class="grid">${list.map(r => cardHtml(r, now, seen)).join('')}</div>`;
  }

  body$.innerHTML = `
    <div class="quick">
      ${tile('quick', '⚡', '20 min<br>or less', f.maxTime === 20)}
      ${tile('easy', '😌', 'Easy<br>ones', f.difficulty.length === 1 && f.difficulty[0] === 'Easy')}
      ${tile('favorites', '❤️', 'Our<br>favorites', f.favorites)}
      ${tile('surprise', '🎲', 'Surprise<br>me', false)}
    </div>
    <div class="chips" aria-label="Cravings">
      ${CRAVINGS.map(([c, e]) => `<button class="chip${f.cravings.includes(c) ? ' on' : ''}" data-act="craving" data-v="${c}">${e} ${cap(c)}</button>`).join('')}
    </div>
    ${active.length ? `<div class="chips wrap">${active.map(([label, key]) => `<button class="chip soft" data-act="drop" data-v="${esc(key)}">${esc(label)} <span class="x">✕</span></button>`).join('')}</div>` : ''}
    <div class="bar">
      <span>${list.length} ${list.length === 1 ? 'recipe' : 'recipes'}${count ? ` · <button class="link-btn" data-act="clear-filters">clear</button>` : ''}</span>
      <span><button class="chip" data-act="filters">⚙︎ Filters${count ? ` (${count})` : ''}</button>
      <select id="sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></span>
    </div>
    ${body}`;
  document.getElementById('sort').addEventListener('change', e => { state.filters.sort = e.target.value; renderBookBody(); });
}

function openFilters(keepPlace) {
  const before = document.querySelector('#sheet .sheet');
  const scroll = keepPlace && before ? before.scrollTop : 0;
  const f = state.filters;
  const cuisines = [...new Set(state.recipes.map(r => r.cuisine).filter(Boolean))].sort();
  const group = (title, key, values, label = cap) => values.length ? `<h3>${title}</h3><div class="chips wrap">${values.map(v =>
    `<button class="chip${f[key].includes(v) ? ' on' : ''}" data-act="toggle" data-k="${key}" data-v="${esc(v)}">${esc(label(v))}</button>`).join('')}</div>` : '';
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = `<div class="sheet${keepPlace ? ' still' : ''}" role="dialog" aria-label="Filters"><div class="grab"></div>
    <h2>Filters</h2>
    <h3>Total time</h3><div class="chips wrap">${[0, 15, 30, 45, 60].map(t =>
      `<button class="chip${f.maxTime === t ? ' on' : ''}" data-act="maxTime" data-v="${t}">${t ? `${t} min or less` : 'Any'}</button>`).join('')}</div>
    ${group('Difficulty', 'difficulty', DIFFICULTIES, String)}
    ${group('Meal', 'meal', MEALS.filter(m => state.recipes.some(r => (r.meal || []).includes(m))))}
    ${group('Main protein', 'protein', PROTEINS.filter(p => state.recipes.some(r => r.protein === p)), p => `${PROTEIN_EMOJI[p] || ''} ${p === 'none' ? 'No protein' : cap(p)}`)}
    ${group('Cuisine', 'cuisine', cuisines, String)}
    <h3>Other</h3><div class="chips wrap">
      <button class="chip${f.favorites ? ' on' : ''}" data-act="favorites">❤️ Favorites</button>
      <button class="chip${f.recent ? ' on' : ''}" data-act="recent">🆕 Added in the last ${NEW_DAYS} days</button></div>
    <div class="row" style="margin-top:18px"><button class="btn" data-act="clear-filters">Clear all</button><button class="btn primary" data-act="close-sheet">Show ${filterRecipes(state.recipes, f, state.household).length} recipes</button></div>
  </div>`;
  sheet.hidden = false;
  sheet.querySelector('.sheet').scrollTop = scroll;
}

function renderRecipe(id) {
  const r = state.byId.get(id);
  if (!r) {
    $view.innerHTML = `<div class="empty"><div class="big">🔎</div><h2>That recipe isn't here</h2>
      <p>It may still be cooking. Pull the book again in a minute.</p><a class="btn" href="#/">Back to the book</a></div>`;
    return;
  }
  const seen = store.get('seen', []);
  if (!seen.includes(id)) store.set('seen', [...seen, id].slice(-500));
  const hh = state.household, loved = favBy(hh, id), log = logFor(hh, id);
  const ticked = state.ticked.get(id) || new Set();
  const inList = store.get('list', []).includes(id);
  const platform = PLATFORMS[r.source?.platform] || hostOf(r.source?.url) || 'the web';
  const groups = [];
  (r.ingredients || []).forEach((ing, i) => {
    let g = groups.find(x => x.name === ing.group);
    if (!g) groups.push(g = { name: ing.group, items: [] });
    g.items.push([ing, i]);
  });
  const form = state.madeForm && state.madeForm.id === id ? state.madeForm : null;
  const stub = isStub(r);
  const openPost = r.source?.url ? `<a class="btn" href="${esc(r.source.url)}" target="_blank" rel="noopener">↗ ${esc(platform)}</a>` : '';
  const needsBox = stub
    ? `<div class="banner"><h3>✍️ Waiting for the recipe</h3><p>${esc(r.missing || 'The chef had nothing to go on.')} Open the post, copy the recipe or the caption, and paste it here. The card is ready ${readyWhen()}.</p>
        <textarea id="details" placeholder="Paste the recipe text here"></textarea>
        <div class="row" style="margin-top:10px">${openPost}<button class="btn primary" data-act="send-details" data-v="${esc(id)}">Send to the chef</button></div></div>`
    : r.needs_details
    ? `<div class="banner"><h3>✍️ This one needs details</h3><p>${esc(r.missing || 'The post didn’t say much, so the chef reconstructed it.')} Paste the caption, a comment or the recipe text and the chef will redo the card.</p>
        <textarea id="details" placeholder="Paste the recipe text here"></textarea>
        <div class="row" style="margin-top:10px"><button class="btn primary" data-act="send-details" data-v="${esc(id)}">Send to the chef</button></div></div>`
    : r.completeness === 'partial'
      ? `<div class="banner calm"><p style="margin:0">Some amounts were filled in by the chef (marked <span class="est">~est.</span>). ${esc(r.missing || '')}
         <button class="link-btn" data-act="show-details">Paste the real ones</button></p>
         <div id="detailsBox" hidden><textarea id="details" placeholder="Paste the recipe text here"></textarea>
         <div class="row" style="margin-top:10px"><button class="btn primary" data-act="send-details" data-v="${esc(id)}">Send to the chef</button></div></div></div>`
      : '';

  $view.innerHTML = `<div class="narrow">
    <div class="hero">${photoHtml(r)}
      <a class="float back" href="#/" data-act="back" aria-label="Back">←</a>
      <button class="float fav" data-act="fav" data-v="${esc(id)}" aria-label="${loved.includes(me()) ? 'Unfavorite' : 'Favorite'}">${loved.length ? '❤️' : '🤍'}</button>
    </div>
    <div class="title-block"><h1>${esc(r.title)}</h1>${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ''}</div>
    ${stub ? needsBox : `<div class="stats">
      <div class="stat"><b>${fmtMinutes(r.total_minutes)}</b><span>${r.active_minutes && r.active_minutes !== r.total_minutes ? `${fmtMinutes(r.active_minutes)} hands-on` : 'total'}</span></div>
      <div class="stat"><b>${diffHtml(r)}</b><span>effort</span></div>
      <div class="stat"><b>${r.servings || '?'}</b><span>servings</span></div>
      <div class="stat"><b>${esc(r.cuisine || '–')}</b><span>${emojiFor(r)} ${esc(r.protein === 'none' ? '' : r.protein)}</span></div>
    </div>
    ${r.difficulty_reason ? `<p class="why">${esc(r.difficulty)}: ${esc(r.difficulty_reason)}</p>` : ''}
    ${loved.length ? `<p class="why">❤️ Loved by ${esc(loved.join(' and '))}</p>` : ''}
    ${needsBox}
    <div class="row">
      <a class="btn primary" href="#/cook/${encodeURIComponent(id)}">▶ Cook mode</a>
      <button class="btn" data-act="list" data-v="${esc(id)}">${inList ? '✓ On the list' : '🛒 Add to list'}</button>
      ${openPost}
    </div>

    <section class="section"><h2>Ingredients <small>${mainIngredients(r).length} to buy · staples in grey</small></h2>
      ${groups.map(g => `${g.name ? `<div class="group-label">${esc(g.name)}</div>` : ''}${g.items.map(([ing, i]) =>
        `<label class="ing${ticked.has(i) ? ' done' : ''}"><input type="checkbox" data-act="tick" data-v="${i}"${ticked.has(i) ? ' checked' : ''}>
          <span class="${ing.staple ? 'staple' : ''}">${esc(ing.line)}${ing.estimated ? '<span class="est">~est.</span>' : ''}</span></label>`).join('')}`).join('')}
    </section>

    <section class="section"><h2>Steps</h2><ol class="steps">${(r.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol></section>
    ${r.equipment?.length ? `<section class="section"><h2>You'll need</h2><ul class="bullets">${r.equipment.map(e => `<li>${esc(e)}</li>`).join('')}</ul></section>` : ''}
    ${r.tips?.length ? `<section class="section"><h2>Tips</h2><ul class="bullets">${r.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>` : ''}

    <section class="section"><h2>We made it <small>${log.length ? `${log.length} ${log.length === 1 ? 'time' : 'times'}` : 'not yet'}</small></h2>
      ${log.slice().reverse().map(l => `<div class="log"><span class="who">${esc(l.by)}</span> <span class="stars">${'★'.repeat(l.rating || 0)}${'☆'.repeat(5 - (l.rating || 0))}</span>
        <div class="when">${fmtDate(l.at)}</div>${l.note ? `<div>${esc(l.note)}</div>` : ''}</div>`).join('')}
      ${form ? `<div class="card-box"><h2>How was it?</h2>
          <div class="star-pick">${[1, 2, 3, 4, 5].map(n => `<button class="${n <= form.stars ? 'on' : ''}" data-act="stars" data-v="${n}" aria-label="${n} stars">★</button>`).join('')}</div>
          <textarea id="madeNote" placeholder="Notes for next time (double the garlic…)">${esc(form.note)}</textarea>
          <div class="row" style="margin-top:10px"><button class="btn" data-act="made-cancel">Cancel</button><button class="btn primary" data-act="made-save" data-v="${esc(id)}">Save</button></div></div>`
        : `<button class="btn block" data-act="made-open" data-v="${esc(id)}">🎉 We made it</button>`}
    </section>`}

    <p class="foot">Added by ${esc(r.added_by || 'someone')} on ${fmtDate(r.added_at)} · from ${esc(platform)}${r.source?.author ? ` (${esc(r.source.author)})` : ''}.
      ${r.source_notes ? `<br>${esc(r.source_notes)}` : ''}</p>
  </div>`;
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported or not allowed: the screen may dim */ }
}

function renderCook(id) {
  const r = state.byId.get(id);
  if (!r) { location.hash = '#/'; return; }
  const steps = r.steps || [];
  const n = Math.min(state.cookStep, steps.length);
  const done = n >= steps.length;
  const ticked = state.ticked.get(id) || new Set();
  const showIngredients = state.cookIngredients;
  $view.innerHTML = `<div class="cook">
    <header><h2>${esc(r.title)}</h2><button class="close" data-act="cook-close" data-v="${esc(id)}" aria-label="Close cook mode">✕</button></header>
    <div class="dots">${steps.map((_, i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>
    <div class="stage">${done
      ? `<div class="num">All done 🎉</div><div class="text">Enjoy it. Want to log it in the book?</div>`
      : `<div class="num">Step ${n + 1} of ${steps.length}</div><div class="text">${esc(steps[n])}</div>`}</div>
    <button class="drawer-btn" data-act="cook-ingredients">${showIngredients ? 'Hide' : 'Show'} ingredients</button>
    ${showIngredients ? `<div class="drawer">${(r.ingredients || []).map((ing, i) =>
      `<label class="ing${ticked.has(i) ? ' done' : ''}"><input type="checkbox" data-act="tick" data-v="${i}"${ticked.has(i) ? ' checked' : ''}><span>${esc(ing.line)}</span></label>`).join('')}</div>` : ''}
    <div class="nav">
      <button data-act="cook-prev"${n === 0 ? ' disabled' : ''}>← Back</button>
      ${done ? `<button class="next" data-act="cook-made" data-v="${esc(id)}">🎉 We made it</button>` : `<button class="next" data-act="cook-next">${n === steps.length - 1 ? 'Finish' : 'Next →'}</button>`}
    </div></div>`;
}

function renderFridge() {
  $view.innerHTML = `<div class="narrow">
    <div class="page-head"><h1>What can we make?</h1><p>Tap what you have. Salt, oil and the usual spices are assumed.</p></div>
    <div class="search"><span class="mag">🔍</span><input id="fq" type="search" placeholder="Find or add an ingredient" value="${esc(state.fridgeQuery || '')}" enterkeyhint="done" autocomplete="off"></div>
    <div id="fridgeBody"></div></div>`;
  const fq = document.getElementById('fq');
  fq.addEventListener('input', () => { state.fridgeQuery = fq.value; renderFridgeBody(); });
  fq.addEventListener('keydown', e => {
    if (e.key === 'Enter' && fq.value.trim()) {
      toggleFridge(fq.value.trim().toLowerCase());
      fq.value = state.fridgeQuery = '';
      renderFridgeBody();
    }
  });
  renderFridgeBody();
}

function renderFridgeBody() {
  const body$ = document.getElementById('fridgeBody');
  if (!body$) return;
  const have = store.get('fridge', []);
  const freq = new Map();
  for (const r of state.recipes) {
    for (const i of mainIngredients(r)) {
      const key = itemKey(i.item);
      const x = freq.get(key) || { item: i.item, aisle: AISLES.includes(i.aisle) ? i.aisle : 'other', n: 0 };
      x.n++;
      freq.set(key, x);
    }
  }
  const query = norm(state.fridgeQuery || '');
  const options = [...freq.values()].filter(x => !query || norm(x.item).includes(query)).sort((a, b) => b.n - a.n || a.item.localeCompare(b.item));
  const isOn = item => have.some(h => itemKey(h) === itemKey(item));
  const groups = AISLES.map(a => ({ a, items: options.filter(x => x.aisle === a) })).filter(g => g.items.length);
  const ranked = fridgeRank(state.recipes, have);
  const resultHtml = ranked.slice(0, 30).map(({ r, have: got, total, missing }) => `<a class="match" href="#/r/${encodeURIComponent(r.id)}">
      <div class="thumb">${photoHtml(r, 'sm')}</div>
      <div style="flex:1;min-width:0"><h3>${esc(r.title)}</h3>
        <div class="have">${missing.length ? `You have ${got} of ${total}` : 'You have everything 🙌'}</div>
        ${missing.length ? `<div class="miss">Missing: ${esc(missing.map(m => m.item).join(', '))}</div>` : ''}
        <div class="meter"><i style="width:${Math.round(100 * got / Math.max(total, 1))}%"></i></div>
        <div class="sub muted small" style="margin-top:4px">⏱ ${fmtMinutes(r.total_minutes)} · ${esc(r.difficulty)}</div></div></a>`).join('');

  body$.innerHTML = `
    ${have.length ? `<div class="chips wrap">${have.map(h => `<button class="chip on" data-act="fridge" data-v="${esc(h)}">${esc(h)} <span class="x">✕</span></button>`).join('')}
      <button class="chip" data-act="fridge-clear">Clear</button></div>
      <section class="section"><h2>Best matches <small>${ranked.length} recipes use these</small></h2>
      ${resultHtml || '<p class="muted">No recipes use those yet.</p>'}</section>
      <h2 style="margin:26px 0 0;font-size:22px">Add more</h2>` : ''}
    ${groups.map(g => `<div class="aisle"><h3>${esc(g.a)}</h3><div class="chips wrap">${g.items.map(x =>
      `<button class="chip${isOn(x.item) ? ' on' : ''}" data-act="fridge" data-v="${esc(x.item)}">${esc(x.item)}</button>`).join('')}</div></div>`).join('')}
    ${!state.recipes.length ? '<p class="muted">Ingredients show up here once the book has recipes.</p>' : ''}
    ${query && !options.length ? `<p class="muted">Press return to add “${esc(state.fridgeQuery.trim())}”.</p>` : ''}`;
}

function toggleFridge(item) {
  const have = store.get('fridge', []);
  const i = have.findIndex(h => itemKey(h) === itemKey(item));
  if (i >= 0) have.splice(i, 1); else have.push(item);
  store.set('fridge', have);
}

function renderList() {
  const ids = store.get('list', []).filter(id => state.byId.has(id));
  const recipes = ids.map(id => state.byId.get(id));
  const checked = store.get('checked', []);
  const list = shoppingList(recipes);
  const row = x => `<label class="list-item${checked.includes(x.key) ? ' done' : ''}"><input type="checkbox" data-act="check" data-v="${esc(x.key)}"${checked.includes(x.key) ? ' checked' : ''}>
    <div><div class="name">${esc(x.item)}</div><div class="for">${x.lines.map(l => `${esc(l.line)}${recipes.length > 1 ? ` · <i>${esc(l.recipe)}</i>` : ''}`).join('<br>')}</div></div></label>`;
  $view.innerHTML = `<div class="narrow">
    <div class="page-head"><h1>Shopping list</h1><p>${recipes.length ? `For ${recipes.length} ${recipes.length === 1 ? 'recipe' : 'recipes'}. Tick things off as you go.` : ''}</p></div>
    ${!recipes.length ? `<div class="empty"><div class="big">🛒</div><h2>Nothing on the list</h2><p>Open a recipe and tap <b>Add to list</b>. Add a few and they combine into one list.</p><a class="btn" href="#/">Browse the book</a></div>` : `
    <div class="chips wrap">${recipes.map(r => `<button class="chip soft" data-act="unlist" data-v="${esc(r.id)}">${esc(r.title)} <span class="x">✕</span></button>`).join('')}</div>
    ${list.groups.map(g => `<div class="aisle"><h3>${esc(g.aisle)}</h3>${g.items.map(row).join('')}</div>`).join('')}
    ${list.staples.length ? `<details class="aisle"><summary class="muted">Probably in the cupboard (${list.staples.length})</summary>${list.staples.map(row).join('')}</details>` : ''}
    <div class="row" style="margin-top:20px"><button class="btn primary" data-act="copy-list">Copy list</button><button class="btn" data-act="uncheck">Untick all</button><button class="btn" data-act="clear-list">Clear list</button></div>`}
  </div>`;
}

function renderAdd() {
  const ready = !!token();
  const q = state.queue;
  const stateLabel = i => {
    const names = i.labels.map(l => l.name);
    if (names.includes('failed')) return '<span class="state failed">Needs a retry</span>';
    if (names.includes('cooking')) return '<span class="state cooking">Cooking</span>';
    if (names.includes('needs-chef')) return '<span class="state">Waiting for the chef</span>';
    return '<span class="state">In line</span>';
  };
  $view.innerHTML = `<div class="narrow">
    <div class="page-head"><h1>Add recipes</h1><p>TikTok, Instagram, Reddit, YouTube or any recipe site. Each one is ready ${readyWhen()}.</p></div>
    ${ready ? '' : `<div class="banner"><h3>Set up this phone first</h3><p>Adding recipes needs the setup code once.</p><a class="btn primary" href="#/settings">Open settings</a></div>`}
    <button class="btn primary block paste" data-act="paste-links"${ready ? '' : ' disabled'}>📋 Paste link and add</button>
    <p class="muted small center">In TikTok, Instagram or Reddit, tap <b>Share → Copy link</b>, then come back and tap this.</p>
    <div class="or"><span>or paste a list</span></div>
    <textarea id="links" placeholder="One link or many. To include the recipe text (handy for Reddit and Instagram), paste it under a single link.">${esc(state.draftLinks || '')}</textarea>
    <div class="bar"><span id="linkCount">${findLinks(state.draftLinks).length} links found</span></div>
    <button class="btn block" data-act="send-links"${ready ? '' : ' disabled'}>Add these to the book</button>
    <p class="muted small">You can also email links to the house Gmail.</p>
    ${ready ? `<section class="section"><h2>In the kitchen <small><button class="link-btn" data-act="refresh-queue">refresh</button></small></h2>
      ${q === null ? '<p class="muted">Checking…</p>' : !q.length ? '<p class="muted">Nothing waiting. Everything you sent is in the book.</p>' :
        q.map(i => `<div class="queue-row"><div style="min-width:0"><div class="u">${esc(findLinks(i.body)[0] || i.title)}</div>
          <a class="muted small" href="${esc(i.html_url)}" target="_blank" rel="noopener">details ↗</a></div>
          <div style="text-align:right">${stateLabel(i)}${i.labels.some(l => l.name === 'failed') ? `<br><button class="link-btn" data-act="retry" data-v="${i.number}">Retry</button>` : ''}</div></div>`).join('')}
    </section>` : ''}
  </div>`;
  const links = document.getElementById('links');
  links.addEventListener('input', () => {
    state.draftLinks = links.value;
    document.getElementById('linkCount').textContent = `${findLinks(links.value).length} links found`;
  });
  if (ready && q === null) loadQueue();
}

async function loadQueue() {
  try { state.queue = await gh.waiting(); } catch (e) { state.queue = []; toast(`Couldn't check the kitchen: ${e.message}`); }
  if (currentView() === 'add') renderAdd();
}

function renderSettings() {
  const t = token();
  $view.innerHTML = `<div class="narrow">
    <div class="page-head"><h1>Settings</h1><p>These stay on this phone.</p></div>
    <div class="card-box"><h2>Who's using this phone?</h2><p class="muted small">Shows up on recipes you add, favorites and notes.</p>
      <div class="who-pick">${HOUSEHOLD.map(n => `<button class="chip${me() === n ? ' on' : ''}" data-act="me" data-v="${n}">${n}</button>`).join('')}</div></div>
    <div class="card-box"><h2>Setup code</h2>
      <p class="muted small">The GitHub key from the setup guide. It lets this phone add recipes and save favorites. ${t ? `<b>Saved</b> (ends in …${esc(t.slice(-4))}).` : 'Not set yet.'}</p>
      <input id="token" class="field" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="row" style="margin-top:10px"><button class="btn primary" data-act="save-token">Save</button><button class="btn" data-act="test-token"${t ? '' : ' disabled'}>Test it</button>
      ${t ? '<button class="btn" data-act="forget-token">Forget</button>' : ''}</div></div>
    <div class="card-box"><h2>The book</h2>
      <p class="muted small">${state.recipes.length} recipes${state.generatedAt ? ` · updated ${fmtDate(state.generatedAt)} ${new Date(state.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''} · repo <code>${esc(repoName())}</code> · app ${APP_VERSION}</p>
      <button class="btn" data-act="reload">Refresh recipes</button></div>
    <div class="card-box"><h2>Put it on the home screen</h2><p class="muted small">In Safari, tap Share, then <b>Add to Home Screen</b>. Open it from there, then come back here to set it up: the home-screen app keeps its own settings.</p></div>
  </div>`;
}

/* ---------- toast, sheet, surprise ---------- */

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}
const closeSheet = () => { document.getElementById('sheet').hidden = true; };

function surprise() {
  const pool = filterRecipes(state.recipes, state.filters, state.household).filter(r => !isStub(r));
  const from = pool.length ? pool : state.recipes.filter(r => !isStub(r));
  if (!from.length) { toast('Add a few recipes first.'); return; }
  const pick = from[Math.floor(Math.random() * from.length)];
  const dice = document.createElement('div');
  dice.className = 'dice';
  dice.innerHTML = '<span>🎲</span>';
  document.body.appendChild(dice);
  setTimeout(() => { dice.remove(); location.hash = `#/r/${encodeURIComponent(pick.id)}`; }, 700);
}

/* ---------- clicks ---------- */

function toggleIn(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }

/** Opens one "Add recipe" issue per link. `withText` goes along when one link has the recipe pasted under it. */
async function sendLinks(button, links, withText = '', fromBox = false) {
  button.disabled = true;
  let sent = 0;
  for (const url of links) {
    try { await gh.addRecipe(url, withText); sent++; button.textContent = `Sending ${sent} of ${links.length}…`; }
    catch (e) { toast(`Stopped at ${url}: ${e.message}`); break; }
    if (links.length > 1) await new Promise(r => setTimeout(r, 800));   // GitHub dislikes bursts
  }
  if (sent) {
    if (fromBox) state.draftLinks = '';
    state.queue = null;
    const site = Object.entries(PLATFORMS).find(([k]) => hostOf(links[0]).includes(k))?.[1] || hostOf(links[0]);
    const what = links.length === 1 ? `Added your ${site} link` : `Sent ${sent} links`;
    toast(`${what} 🍳 It'll be in the book ${readyWhen()}.`);
  }
  renderAdd();
}

function sendFromBox(button) {
  const raw = document.getElementById('links').value;
  const links = findLinks(raw);
  if (!links.length) { toast('Paste at least one link.'); return; }
  // One link with the recipe pasted under it: send the text too, for posts a site won't share.
  const withText = links.length === 1 && raw.replace(links[0], '').trim().length > 20 ? raw.trim() : '';
  sendLinks(button, links, withText, true);
}

/** Reads the clipboard (the phone shows a small "Paste" bubble to allow it) and adds the link(s) on it. */
async function pasteAndSend(button) {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    toast("Couldn't read the clipboard. Tap the box below and choose Paste instead.");
    document.getElementById('links').focus();
    return;
  }
  const links = findLinks(text);
  if (!links.length) { toast('No link on the clipboard. In TikTok, tap Share → Copy link, then try again.'); return; }
  sendLinks(button, links);   // only the links: share text like "Check out this video!" isn't the recipe
}

const actions = {
  quick: () => { state.filters.maxTime = state.filters.maxTime === 20 ? 0 : 20; renderBookBody(); },
  easy: () => { const on = state.filters.difficulty.length === 1 && state.filters.difficulty[0] === 'Easy'; state.filters.difficulty = on ? [] : ['Easy']; renderBookBody(); },
  favorites: () => { state.filters.favorites = !state.filters.favorites; refreshFilters(); },
  recent: () => { state.filters.recent = !state.filters.recent; refreshFilters(); },
  surprise,
  craving: v => { toggleIn(state.filters.cravings, v); renderBookBody(); },
  'clear-q': () => { state.filters.q = ''; renderBook(); },
  'clear-filters': () => { state.filters = { ...defaultFilters(), q: state.filters.q, sort: state.filters.sort }; closeSheet(); renderBookBody(); },
  drop: v => {
    const [k, val] = v.split(':');
    if (val !== undefined) toggleIn(state.filters[k], val); else state.filters[k] = k === 'maxTime' ? 0 : false;
    renderBookBody();
  },
  filters: openFilters,
  toggle: (v, el) => { toggleIn(state.filters[el.dataset.k], v); refreshFilters(); },
  maxTime: v => { state.filters.maxTime = Number(v); refreshFilters(); },
  'close-sheet': closeSheet,
  reload: async () => { await boot(true); toast('Up to date.'); },
  back: (v, el, e) => { if (state.prevView === 'book') { e.preventDefault(); history.back(); } },
  fav: v => {
    const who = me() || 'Us';
    const on = !favBy(state.household, v).includes(who);
    changeHousehold(v, e => { e.fav = on ? [...new Set([...(e.fav || []), who])] : (e.fav || []).filter(n => n !== who); },
      `${on ? 'Favorite' : 'Unfavorite'}: ${v} (${who})`);
  },
  list: v => { const ids = store.get('list', []); toggleIn(ids, v); store.set('list', ids); render(); toast(ids.includes(v) ? 'Added to the shopping list.' : 'Taken off the list.'); },
  unlist: v => { const ids = store.get('list', []); toggleIn(ids, v); store.set('list', ids); render(); },
  tick: (v, el) => {
    const id = routeParts()[1];
    const set = state.ticked.get(id) || new Set();
    if (el.checked) set.add(Number(v)); else set.delete(Number(v));
    state.ticked.set(id, set);
    el.closest('.ing').classList.toggle('done', el.checked);
  },
  'show-details': () => { document.getElementById('detailsBox').hidden = false; },
  'send-details': async (v, el) => {
    const text = document.getElementById('details').value.trim();
    if (!text) { toast('Paste the recipe text first.'); return; }
    if (!token()) { location.hash = '#/settings'; toast('Set up this phone first.'); return; }
    el.disabled = true;
    try { await gh.addDetails(v, text); toast(`Sent. The chef will redo this card ${readyWhen()}.`); document.getElementById('details').value = ''; }
    catch (e) { toast(`Couldn't send: ${e.message}`); }
    el.disabled = false;
  },
  'made-open': v => { state.madeForm = { id: v, stars: 0, note: '' }; render(); },
  'made-cancel': () => { state.madeForm = null; render(); },
  stars: v => { state.madeForm.note = document.getElementById('madeNote').value; state.madeForm.stars = Number(v); render(); },
  'made-save': v => {
    const item = { by: me() || 'Us', at: new Date().toISOString(), rating: state.madeForm.stars, note: document.getElementById('madeNote').value.trim() };
    state.madeForm = null;
    changeHousehold(v, e => { if (!(e.log || []).some(x => x.at === item.at && x.by === item.by)) e.log = [...(e.log || []), item]; }, `Made it: ${v} (${item.by})`);
    toast('Logged. Nice work 🎉');
  },
  'cook-next': () => { state.cookStep++; renderCook(routeParts()[1]); },
  'cook-prev': () => { state.cookStep = Math.max(0, state.cookStep - 1); renderCook(routeParts()[1]); },
  'cook-ingredients': () => { state.cookIngredients = !state.cookIngredients; renderCook(routeParts()[1]); },
  'cook-close': v => { location.hash = `#/r/${encodeURIComponent(v)}`; },
  'cook-made': v => { state.madeForm = { id: v, stars: 0, note: '' }; location.hash = `#/r/${encodeURIComponent(v)}`; },
  fridge: v => { toggleFridge(v); renderFridgeBody(); },
  'fridge-clear': () => { store.set('fridge', []); renderFridgeBody(); },
  check: (v, el) => { const c = store.get('checked', []); toggleIn(c, v); store.set('checked', c); el.closest('.list-item').classList.toggle('done', el.checked); },
  uncheck: () => { store.set('checked', []); renderList(); },
  'clear-list': () => { store.set('list', []); store.set('checked', []); render(); },
  'copy-list': async () => {
    const ids = store.get('list', []).filter(id => state.byId.has(id));
    const text = listAsText(shoppingList(ids.map(id => state.byId.get(id))), store.get('checked', []));
    try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into Notes or a text.'); }
    catch { toast("Couldn't copy on this browser."); }
  },
  'send-links': (v, el) => sendFromBox(el),
  'paste-links': (v, el) => pasteAndSend(el),
  'refresh-queue': () => { state.queue = null; renderAdd(); },
  retry: async v => { try { await gh.retry(Number(v)); toast('Sent back to the kitchen.'); } catch (e) { toast(`Couldn't retry: ${e.message}`); } state.queue = null; renderAdd(); },
  me: v => { store.set('me', v); renderSettings(); toast(`Hi, ${v}!`); },
  'save-token': () => {
    const t = document.getElementById('token').value.trim();
    if (!t) { toast('Paste the setup code first.'); return; }
    store.set('token', t);
    renderSettings();
    actions['test-token']();
  },
  'forget-token': () => { store.set('token', ''); renderSettings(); },
  'test-token': async () => {
    try { await gh.call('GET', ''); await gh.readHousehold(); toast('All set: this phone can add recipes.'); loadHousehold().then(render); }
    catch (e) { toast(`That didn't work: ${e.message}`); }
  },
};

function refreshFilters() { if (!document.getElementById('sheet').hidden) openFilters(true); renderBookBody(); }

document.addEventListener('click', e => {
  if (e.target.classList.contains('sheet-wrap')) { closeSheet(); return; }
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  if (el.tagName === 'INPUT') { actions[el.dataset.act](el.dataset.v, el, e); return; }
  if (el.tagName === 'BUTTON') e.preventDefault();
  actions[el.dataset.act](el.dataset.v, el, e);
});

// A recipe photo that can't load becomes its emoji.
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.dataset.emoji) {
    const div = document.createElement('div');
    div.className = 'placeholder';
    div.textContent = img.dataset.emoji;
    img.replaceWith(div);
  }
}, true);

// Cook mode: swipe or arrow keys between steps.
let touchX = null;
document.addEventListener('touchstart', e => { if (currentView() === 'cook') touchX = e.touches[0].clientX; }, { passive: true });
document.addEventListener('touchend', e => {
  if (touchX === null || currentView() !== 'cook') return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 60) actions[dx < 0 ? 'cook-next' : 'cook-prev']();
});
document.addEventListener('keydown', e => {
  if (currentView() !== 'cook') return;
  if (e.key === 'ArrowRight') actions['cook-next']();
  if (e.key === 'ArrowLeft') actions['cook-prev']();
  if (e.key === 'Escape') actions['cook-close'](routeParts()[1]);
});

/* ---------- 6. Router and start-up ---------- */

const routeParts = () => (location.hash || '#/').replace(/^#\/?/, '').split('/').map(decodeURIComponent);
function currentView() {
  const v = routeParts()[0];
  return { '': 'book', r: 'recipe', cook: 'cook', fridge: 'fridge', list: 'list', add: 'add', settings: 'settings' }[v] || 'book';
}

function render() {
  const view = currentView(), arg = routeParts()[1];
  document.body.classList.toggle('cooking', view === 'cook');
  keepAwake(view === 'cook');
  const tab = { book: 'book', recipe: 'book', settings: 'book', fridge: 'fridge', list: 'list', add: 'add' }[view];
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  const listCount = store.get('list', []).filter(id => state.byId.has(id)).length;
  const badge = document.getElementById('listBadge');
  badge.hidden = !listCount;
  badge.textContent = listCount;
  ({ book: renderBook, recipe: () => renderRecipe(arg), cook: () => renderCook(arg), fridge: renderFridge,
    list: renderList, add: renderAdd, settings: renderSettings })[view]();
}

window.addEventListener('hashchange', () => {
  const was = state.lastView, view = currentView();
  if (was === 'book') state.bookScroll = window.scrollY;
  if (view === 'cook' && was !== 'cook') { state.cookStep = 0; state.cookIngredients = false; }
  if (view !== 'recipe' && view !== 'cook') state.madeForm = null;
  closeSheet();
  render();
  window.scrollTo(0, view === 'book' && was === 'recipe' ? state.bookScroll : 0);
  state.prevView = was;
  state.lastView = view;
});

async function boot(force) {
  try { await loadRecipes(force); state.loadError = ''; }
  catch (e) { state.loadError = navigator.onLine ? e.message : "You're offline and the book hasn't been saved on this phone yet."; }
  await loadHousehold();
  render();
}

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (currentView() === 'cook') keepAwake(true);
  if (Date.now() - hiddenAt > 60000 && currentView() !== 'cook') boot();   // back after a while: fetch what's new
});

/* ---------- 7. Self-test ---------- */

function selfTest() {
  const results = [];
  const t = (name, ok) => results.push([name, !!ok]);
  t('egg matches eggs', itemsMatch('egg', 'eggs'));
  t('chicken matches chicken thighs', itemsMatch('chicken', 'chicken thighs'));
  t('chicken thighs matches chicken', itemsMatch('chicken thighs', 'chicken'));
  t('rice does not match licorice', !itemsMatch('rice', 'licorice'));
  t('tomatoes matches tomato', itemsMatch('tomatoes', 'tomato'));
  const a = { id: 'a', title: 'Quick Eggs', total_minutes: 10, difficulty: 'Easy', meal: ['breakfast'], cuisine: 'American', protein: 'eggs', cravings: ['comfort'],
    added_at: new Date().toISOString(), ingredients: [{ item: 'eggs', line: '2 eggs', aisle: 'dairy & eggs', staple: false }, { item: 'salt', line: 'salt', aisle: 'spices', staple: true }] };
  const b = { id: 'b', title: 'Big Braise', total_minutes: 240, difficulty: 'Easy', meal: ['dinner'], cuisine: 'French', protein: 'beef', cravings: ['hearty', 'comfort'],
    added_at: '2025-01-01T00:00:00Z', ingredients: [{ item: 'beef chuck', line: '3 lb beef chuck', aisle: 'meat & seafood', staple: false },
      { item: 'eggs', line: '1 egg', aisle: 'dairy & eggs', staple: false }, { item: 'salt', line: 'salt', aisle: 'spices', staple: true }] };
  const hh = { recipes: { b: { fav: ['Lauren'], log: [{ by: 'Jordan', at: 'x', rating: 5 }] } } };
  const f = () => defaultFilters();
  t('20-minute filter keeps the quick one', filterRecipes([a, b], { ...f(), maxTime: 20 }, hh).map(r => r.id).join() === 'a');
  t('cravings are AND', filterRecipes([a, b], { ...f(), cravings: ['comfort', 'hearty'] }, hh).map(r => r.id).join() === 'b');
  t('favorites filter', filterRecipes([a, b], { ...f(), favorites: true }, hh).map(r => r.id).join() === 'b');
  t('search finds ingredients', filterRecipes([a, b], { ...f(), q: 'chuck' }, hh).map(r => r.id).join() === 'b');
  t('search handles plurals', filterRecipes([a, b], { ...f(), q: 'braises' }, hh).length === 1);
  t('quickest sort', filterRecipes([b, a], { ...f(), sort: 'quickest' }, hh)[0].id === 'a');
  t('most made sort', filterRecipes([a, b], { ...f(), sort: 'made' }, hh)[0].id === 'b');
  const rank = fridgeRank([a, b], ['eggs']);
  t('fridge: eggs alone makes Quick Eggs first', rank[0].r.id === 'a' && rank[0].missing.length === 0 && rank[1].missing[0].item === 'beef chuck');
  const list = shoppingList([a, b]);
  t('list merges eggs from both', list.groups.find(g => g.aisle === 'dairy & eggs').items[0].lines.length === 2);
  t('list keeps salt with staples', list.staples.length === 1);
  t('list text skips ticked items', !listAsText(list, ['egg']).includes('egg') && listAsText(list, []).includes('3 lb beef chuck'));
  t('links found in pasted text', findLinks('a https://x.com/1, and https://y.com/2.').join() === 'https://x.com/1,https://y.com/2');
  t('base64 round trip with emoji', b64decode(b64encode('crème brûlée 🍮')) === 'crème brûlée 🍮');
  t('minutes format', fmtMinutes(95) === '1 h 35 min' && fmtMinutes(40) === '40 min');
  const s = { id: 's', title: 'Saved from r/soup', total_minutes: 0, difficulty: 'Easy', protein: 'none', meal: [], cravings: [],
    ingredients: [], steps: [], needs_details: true, added_at: new Date().toISOString() };
  t('a waiting card is a stub; a recipe is not', isStub(s) && !isStub(a));
  t('waiting cards stay in the book', filterRecipes([a, s], f(), hh).length === 2);
  t('waiting cards skip the Easy filter', filterRecipes([a, s], { ...f(), difficulty: ['Easy'] }, hh).map(r => r.id).join() === 'a');
  t('waiting cards skip the fridge', fridgeRank([a, s], ['eggs']).every(x => x.r.id !== 's'));
  const passed = results.filter(r => r[1]).length;
  $view.innerHTML = `<div class="narrow"><div class="page-head"><h1>Self-test</h1><p>${passed} of ${results.length} passed</p></div>
    ${results.map(([n, ok]) => `<div class="queue-row"><span>${esc(n)}</span><span class="state ${ok ? '' : 'failed'}">${ok ? 'pass' : 'FAIL'}</span></div>`).join('')}</div>`;
  document.title = `${passed}/${results.length} passed`;
}

if (new URLSearchParams(location.search).has('test')) {
  selfTest();
} else {
  state.lastView = currentView();
  boot();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
