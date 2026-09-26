// DOM overlay: planet list, galaxy switcher, detail card, prompt bar, modals and toasts.
import { store, isSaved, progressOf, NEBULAE } from './data.js';
import { getManifest } from './assets.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let app = null;

export function initUI(appRef) {
  app = appRef;

  $('#galaxy-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGalaxyMenu();
  });
  $('#galaxy-prev').addEventListener('click', () => cycleGalaxy(-1));
  $('#galaxy-next').addEventListener('click', () => cycleGalaxy(1));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.galaxy-switch')) toggleGalaxyMenu(false);
  });
  document.querySelectorAll('.surface-toggle button').forEach((b) =>
    b.addEventListener('click', () => app.setSurface(b.dataset.surface)),
  );
  $('#launch').addEventListener('click', () => app.launch());
  $('#back').addEventListener('click', () => app.back());
  $('#new-planet').addEventListener('click', () => openPlanetModal());
  $('#edit-planet').addEventListener('click', editFocused);
  $('#delete-planet').addEventListener('click', removeFocused);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      toggleGalaxyMenu(false);
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.backdrop') || e.target.closest('input, textarea')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'ArrowRight' || k === 'd' || k === 'ArrowDown') app.cycle(1);
    else if (k === 'ArrowLeft' || k === 'a' || k === 'ArrowUp') app.cycle(-1);
    else if (k === 'Enter') app.launch();
    else if (k === 'n') openPlanetModal();
    else if (k === 't') app.toggleSurface();
    else if (k === 'r') editFocused();
    else if (k === 'x' || k === 'Delete') removeFocused();
    else if (k === 'b') app.back();
    else if (k === 'q') cycleGalaxy(-1);
    else if (k === 'e') cycleGalaxy(1);
    else return;
    e.preventDefault();
  });

  setTimeout(() => ($('#hint').style.opacity = '0'), 9000);
}

function editFocused() {
  const p = app.focusedPlanet();
  if (p) openPlanetModal(p);
}

function removeFocused() {
  const p = app.focusedPlanet();
  if (!p) return;
  confirmModal({
    kicker: 'REMOVE PLANET',
    title: `Remove ${p.name}?`,
    body: `The planet for <strong>${esc(p.course)}</strong> will leave this galaxy. Course progress stored on it is lost.`,
    confirm: 'Remove',
    danger: true,
  }).then((ok) => ok && app.removePlanet(p.id));
}

function cycleGalaxy(dir) {
  const list = store.state.galaxies;
  if (list.length < 2) return;
  const i = list.findIndex((g) => g.id === store.galaxy.id);
  toggleGalaxyMenu(false);
  app.switchGalaxy(list[(i + dir + list.length) % list.length].id);
}

// --------------------------------------------------------------------------- //
//  Panels
// --------------------------------------------------------------------------- //

export function renderSurfaceToggle(mode, busy) {
  const group = $('.surface-toggle');
  group.classList.toggle('busy', !!busy);
  group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.surface === mode)));
}

export function renderAll() {
  renderHeader();
  renderPlanetList();
  renderInfo();
  renderGalaxyMenu();
}

function renderHeader() {
  const m = getManifest();
  const g = store.galaxy;
  const all = store.state.galaxies;
  const star = m.stars[g.star] ?? Object.values(m.stars)[0];
  $('#galaxy-name').textContent = g.name;
  $('#galaxy-count').textContent = `SYSTEM ${all.findIndex((x) => x.id === g.id) + 1}/${all.length}`;
  $('#galaxy-star').textContent = star.label;
  const multi = all.length > 1;
  $('#galaxy-prev').style.visibility = multi ? 'visible' : 'hidden';
  $('#galaxy-next').style.visibility = multi ? 'visible' : 'hidden';
}

function renderTotals() {
  const planets = store.galaxy.planets;
  const done = planets.reduce((s, p) => s + Math.min(p.completed, p.lessons), 0);
  const total = planets.reduce((s, p) => s + p.lessons, 0);
  $('#sectors-total').textContent = `${done}/${total}`;
  $('#foot-planets').textContent = String(planets.length);
  $('#foot-saved').textContent = `${planets.filter(isSaved).length}/${planets.length}`;
}

export function renderPlanetList() {
  const m = getManifest();
  const list = $('#planet-list');
  const planets = store.galaxy.planets;
  list.innerHTML = planets
    .map((p) => {
      const b = m.biomes[p.biome] ?? m.biomes.terran;
      const saved = isSaved(p);
      const val = saved ? '<span class="saved">SAVED</span>' : `${Math.round(progressOf(p) * 100)}%`;
      return `<li><button data-id="${p.id}" class="${p.id === app.focusId ? 'active' : ''}${saved ? ' is-saved' : ''}" title="${esc(p.course)}">
        <span class="name"><i class="swatch" style="background:${b.swatch}"></i><span>${esc(p.name)}</span></span>
        <span class="val">${val}</span></button></li>`;
    })
    .join('');
  if (!planets.length) list.innerHTML = '<li class="empty">NO PLANETS CHARTED</li>';
  list.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => app.focus(btn.dataset.id)));
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderTotals();
}

const set = (id, text, cls = '') => {
  const el = $(id);
  el.textContent = text;
  el.className = `v ${cls}`.trim();
};

export function renderInfo() {
  const p = app.focusedPlanet();
  const info = $('#info');
  const has = !!p;
  for (const id of ['#edit-planet', '#delete-planet', '#launch']) $(id).disabled = !has;
  renderTotals();
  if (!has) {
    info.classList.remove('epic');
    $('#info-name').textContent = store.galaxy.name;
    $('#info-type').textContent = 'EMPTY SYSTEM';
    $('#info-rarity').textContent = '';
    for (const id of ['#st-sectors', '#st-progress', '#st-size', '#st-biome', '#st-seed', '#st-left', '#st-status', '#st-done', '#st-lessons']) set(id, '—');
    $('#info-course').textContent = 'An empty system. Add a planet for your first course.';
    $('#progress-fill').style.width = '0';
    $('#progress-label').textContent = '';
    return;
  }
  const m = getManifest();
  const b = m.biomes[p.biome] ?? m.biomes.terran;
  const saved = isSaved(p);
  const pct = Math.round(progressOf(p) * 100);
  info.classList.toggle('epic', saved);
  $('#info-name').textContent = p.name;
  $('#info-type').textContent = `${b.label} world`;
  $('#info-rarity').textContent = saved ? '✦ ✦' : '';
  set('#st-sectors', `${p.completed}/${p.lessons}`);
  set('#st-progress', `${pct}%`, saved ? 'good' : '');
  set('#st-size', (p.size ?? 1).toFixed(2));
  set('#st-biome', b.label);
  set('#st-seed', p.variant ? 'B' : 'A');
  set('#st-left', String(p.lessons - p.completed));
  set('#st-status', saved ? 'SAVED' : p.completed ? 'CLAIMING' : 'UNCHARTED', saved ? 'good' : '');
  set('#st-done', String(p.completed));
  set('#st-lessons', String(p.lessons));
  $('#info-course').textContent = p.course;
  $('#progress-fill').style.width = `${pct}%`;
  const label = $('#progress-label');
  label.classList.toggle('saved', saved);
  label.textContent = saved ? 'Planet saved' : `${pct}% secured`;
  info.dataset.planet = p.id;
}

function renderGalaxyMenu() {
  const m = getManifest();
  const menu = $('#galaxy-menu');
  menu.innerHTML =
    '<div class="dd-head"><span>.. &gt; GALAXIES</span><span>SAVED</span></div>' +
    store.state.galaxies
      .map((g) => {
        const star = m.stars[g.star] ?? Object.values(m.stars)[0];
        const saved = g.planets.filter(isSaved).length;
        return `<button data-id="${g.id}" class="${g.id === store.galaxy.id ? 'active' : ''}">
          <span class="star-dot" style="background:${star.glow};color:${star.glow}"></span>
          ${esc(g.name)}<span class="meta">${saved}/${g.planets.length}</span></button>`;
      })
      .join('') +
    '<button class="new" data-new="1">+ NEW GALAXY</button>';
  menu.querySelectorAll('button[data-id]').forEach((b) =>
    b.addEventListener('click', () => {
      toggleGalaxyMenu(false);
      app.switchGalaxy(b.dataset.id);
    }),
  );
  menu.querySelector('[data-new]').addEventListener('click', () => {
    toggleGalaxyMenu(false);
    openGalaxyModal();
  });
}

function toggleGalaxyMenu(force) {
  const menu = $('#galaxy-menu');
  const open = force ?? menu.hidden;
  menu.hidden = !open;
  $('#galaxy-toggle').setAttribute('aria-expanded', String(open));
}

// --------------------------------------------------------------------------- //
//  Modals
// --------------------------------------------------------------------------- //

const actions = (cancel, confirm, { danger = false, type = 'button', disabled = false } = {}) => `
  <div class="modal-actions">
    <button type="button" class="prompt" data-cancel><span class="pl">${esc(cancel)}</span><kbd>ESC</kbd></button>
    <button type="${type}" class="prompt${danger ? ' danger' : ''}" data-ok ${disabled ? 'disabled' : ''}><span class="pl">${esc(confirm)}</span><kbd>&#8629;</kbd></button>
  </div>`;

function openModal({ kicker, title, body }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="backdrop"><div class="modal" role="dialog" aria-modal="true">
    <div class="modal-head"><div class="kicker">${esc(kicker)}</div><h2>${esc(title)}</h2></div>
    <div class="modal-body">${body}</div></div></div>`;
  const backdrop = root.querySelector('.backdrop');
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) closeModal();
  });
  const modal = root.querySelector('.modal');
  modal.tabIndex = -1;
  // Enter runs the ↵ prompt, unless keyboard focus sits on a specific button or field.
  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.closest('button, input')) return;
    e.preventDefault();
    const ok = modal.querySelector('[data-ok]');
    if (ok && !ok.disabled) ok.click();
  });
  (root.querySelector('input') ?? modal).focus();
  return modal;
}

export function closeModal() {
  const root = $('#modal-root');
  root.dispatchEvent(new Event('close'));
  root.innerHTML = '';
}

export function openPlanetModal(existing = null) {
  const m = getManifest();
  const editing = !!existing;
  const p = existing ?? {
    name: '',
    course: '',
    biome: Object.keys(m.biomes)[(Math.random() * Object.keys(m.biomes).length) | 0],
    variant: 0,
    hue: 0,
    size: 1,
    lessons: 10,
    completed: 0,
  };
  const state = { biome: p.biome, variant: p.variant };

  const modal = openModal({
    kicker: editing ? 'PLANET > EDIT' : 'PLANET > CHART',
    title: editing ? p.name : 'New planet',
    body: `
    <p class="lead">${editing ? 'Tweak the course or the world that represents it.' : 'Every course is a world. Pick a biome and it will be charted into this galaxy.'}</p>
    <form id="planet-form" autocomplete="off">
      <div class="row">
        <div class="field"><label for="pf-name">Planet name</label><input id="pf-name" type="text" maxlength="24" required value="${esc(p.name)}" placeholder="e.g. Calculon"></div>
        <div class="field"><label for="pf-lessons">Lessons (sectors)</label><input id="pf-lessons" type="number" min="1" max="200" required value="${p.lessons}"></div>
      </div>
      <div class="field"><label for="pf-course">Course</label><input id="pf-course" type="text" maxlength="60" required value="${esc(p.course)}" placeholder="e.g. Calculus II: Integration"></div>
      ${editing ? `<div class="field"><label for="pf-done">Lessons completed</label><input id="pf-done" type="number" min="0" max="${p.lessons}" value="${p.completed}"></div>` : ''}
      <div class="field"><span class="lbl">Biome</span>
        <div class="biomes">${Object.entries(m.biomes)
          .map(
            ([id, b]) => `<button type="button" class="biome ${id === state.biome ? 'active' : ''}" data-biome="${id}">
              <span class="orb" style="background:radial-gradient(circle at 35% 30%, ${b.atmosphere}, ${b.swatch} 55%, #000 100%)"></span>${b.label}</button>`,
          )
          .join('')}</div>
      </div>
      <div class="row">
        <div class="field"><span class="lbl">Terrain seed</span>
          <div class="seg" id="pf-variant">${[0, 1].map((v) => `<button type="button" data-v="${v}" class="${v === state.variant ? 'active' : ''}">${v ? 'B' : 'A'}</button>`).join('')}</div>
        </div>
        <div class="field"><label for="pf-size">Size</label><input id="pf-size" type="range" min="0.7" max="1.7" step="0.05" value="${p.size}"></div>
      </div>
      <div class="field"><label for="pf-hue">Colour shift</label><input id="pf-hue" type="range" min="-3.14" max="3.14" step="0.01" value="${p.hue}"><div class="hue-track"></div></div>
      ${actions('Cancel', editing ? 'Save changes' : 'Chart planet', { type: 'submit' })}
    </form>`,
  });

  modal.querySelectorAll('.biome').forEach((b) =>
    b.addEventListener('click', () => {
      state.biome = b.dataset.biome;
      modal.querySelectorAll('.biome').forEach((x) => x.classList.toggle('active', x === b));
      const vs = m.biomes[state.biome].variants.length;
      modal.querySelectorAll('#pf-variant button').forEach((x) => (x.disabled = +x.dataset.v >= vs));
    }),
  );
  modal.querySelectorAll('#pf-variant button').forEach((b) =>
    b.addEventListener('click', () => {
      state.variant = +b.dataset.v;
      modal.querySelectorAll('#pf-variant button').forEach((x) => x.classList.toggle('active', x === b));
    }),
  );
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#pf-lessons').addEventListener('input', (e) => {
    const done = modal.querySelector('#pf-done');
    if (done) done.max = e.target.value;
  });
  modal.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = (id) => modal.querySelector(id)?.value;
    const data = {
      name: val('#pf-name').trim() || 'Unnamed',
      course: val('#pf-course').trim() || 'Untitled course',
      lessons: Math.max(1, parseInt(val('#pf-lessons'), 10) || 1),
      biome: state.biome,
      variant: state.variant,
      size: parseFloat(val('#pf-size')),
      hue: parseFloat(val('#pf-hue')),
    };
    if (editing) data.completed = parseInt(val('#pf-done'), 10) || 0;
    closeModal();
    if (editing) app.updatePlanet(existing.id, data);
    else app.addPlanet(data);
  });
}

export function openGalaxyModal() {
  const m = getManifest();
  const state = { star: Object.keys(m.stars)[0], nebula: 'violet' };
  const modal = openModal({
    kicker: 'GALAXY > CHART',
    title: 'New galaxy',
    body: `
    <p class="lead">A galaxy groups related course planets around a single star.</p>
    <form autocomplete="off">
      <div class="field"><label for="gf-name">Galaxy name</label><input id="gf-name" type="text" maxlength="28" required placeholder="e.g. Advanced Mathematics"></div>
      <div class="field"><span class="lbl">Star</span><div class="seg" id="gf-star">${Object.entries(m.stars)
        .map(([id, s], i) => `<button type="button" data-v="${id}" class="${i === 0 ? 'active' : ''}"><span style="color:${s.glow}">●</span> ${s.label}</button>`)
        .join('')}</div></div>
      <div class="field"><span class="lbl">Nebula</span><div class="seg" id="gf-neb">${Object.entries(NEBULAE)
        .map(([id, n]) => `<button type="button" data-v="${id}" class="${id === state.nebula ? 'active' : ''}"><span style="color:${n.a};filter:brightness(2.2)">●</span> ${n.label}</button>`)
        .join('')}</div></div>
      ${actions('Cancel', 'Create galaxy', { type: 'submit' })}
    </form>`,
  });
  const seg = (sel, key) =>
    modal.querySelectorAll(`${sel} button`).forEach((b) =>
      b.addEventListener('click', () => {
        state[key] = b.dataset.v;
        modal.querySelectorAll(`${sel} button`).forEach((x) => x.classList.toggle('active', x === b));
      }),
    );
  seg('#gf-star', 'star');
  seg('#gf-neb', 'nebula');
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = modal.querySelector('#gf-name').value.trim() || 'Unnamed Galaxy';
    closeModal();
    app.createGalaxy({ name, ...state });
  });
}

export function confirmModal({ kicker = 'CONFIRM', title, body, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const modal = openModal({ kicker, title, body: `<p class="lead">${body}</p>${actions('Cancel', confirm, { danger })}` });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(v);
    };
    modal.querySelector('[data-cancel]').addEventListener('click', () => done(false));
    modal.querySelector('[data-ok]').addEventListener('click', () => done(true));
    $('#modal-root').addEventListener('close', () => done(false), { once: true });
  });
}

/** Shown when nothing handles the `coursegalaxy:launch` event (standalone demo). */
export function launchModal(planet) {
  const saved = isSaved(planet);
  const modal = openModal({
    kicker: 'LAUNCHING',
    title: planet.name,
    body: `
    <div class="launch-card">
      <div class="course">${esc(planet.course)}</div>
      <div class="demo-note">
        <strong>Hook up your course player here.</strong> Listen for
        <code>coursegalaxy:launch</code> on <code>window</code> and call
        <code>event.preventDefault()</code> to replace this dialog. Report progress with
        <code>CourseGalaxy.setProgress(id, lessonsDone)</code>.
      </div>
    </div>
    ${actions('Close', saved ? 'Planet saved' : 'Complete a lesson (demo)', { disabled: saved })}`,
  });
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-ok]').addEventListener('click', () => {
    closeModal();
    app.setProgress(planet.id, planet.completed + 1);
  });
}

export function toast(msg, { kicker = 'COURSE UPDATED', sub = store.galaxy?.name } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="toast-main"><div class="toast-ico"><span></span></div>
    <div class="toast-text"><div class="toast-kicker">${esc(kicker)}</div><div class="toast-msg">${esc(msg)}</div></div></div>
    ${sub ? `<div class="toast-sub">${esc(String(sub).toUpperCase())}</div>` : ''}`;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

export function setLoading(frac, done = false) {
  $('#loading-fill').style.width = `${Math.round(frac * 100)}%`;
  if (done) $('#loading').classList.add('done');
}
