// DOM overlay: planet list, galaxy menu, info card, modals and toasts.
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
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.top-right')) toggleGalaxyMenu(false);
  });
  document.querySelectorAll('.surface-toggle button').forEach((b) =>
    b.addEventListener('click', () => app.setSurface(b.dataset.surface)),
  );
  $('#launch').addEventListener('click', () => app.launch());
  $('#back').addEventListener('click', () => app.back());
  $('#new-planet').addEventListener('click', () => openPlanetModal());
  $('#edit-planet').addEventListener('click', () => {
    const p = app.focusedPlanet();
    if (p) openPlanetModal(p);
  });
  $('#delete-planet').addEventListener('click', () => {
    const p = app.focusedPlanet();
    if (!p) return;
    confirmModal({
      title: `Remove ${p.name}?`,
      body: `The planet for <strong>${esc(p.course)}</strong> will leave this galaxy. Course progress stored on it is lost.`,
      confirm: 'Remove planet',
      danger: true,
    }).then((ok) => ok && app.removePlanet(p.id));
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (document.querySelector('.backdrop') || e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'ArrowDown') app.cycle(1);
    else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'ArrowUp') app.cycle(-1);
    else if (e.key === 'Enter') app.launch();
    else if (e.key === 'n') openPlanetModal();
    else if (e.key === 't') app.toggleSurface();
    else return;
    e.preventDefault();
  });

  setTimeout(() => ($('#hint').style.opacity = '0'), 9000);
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
  $('#galaxy-name').textContent = store.galaxy.name;
}

export function renderPlanetList() {
  const m = getManifest();
  const list = $('#planet-list');
  const planets = store.galaxy.planets;
  list.innerHTML = planets
    .map((p) => {
      const b = m.biomes[p.biome] ?? m.biomes.terran;
      const status = isSaved(p) ? '<span class="saved">SAVED</span>' : `<span class="pct">${Math.round(progressOf(p) * 100)}%</span>`;
      return `<li><button data-id="${p.id}" class="${p.id === app.focusId ? 'active' : ''}" title="${esc(p.course)}">
        <span class="swatch" style="background:${b.swatch};box-shadow:0 0 8px ${b.atmosphere}"></span>
        <span class="name">${esc(p.name)}</span>${status}</button></li>`;
    })
    .join('');
  if (!planets.length) list.innerHTML = '<li style="color:var(--muted);text-align:center;padding:10px;font-size:14px">No planets yet</li>';
  list.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => app.focus(btn.dataset.id)));
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function renderInfo() {
  const p = app.focusedPlanet();
  const info = $('#info');
  const has = !!p;
  $('#edit-planet').style.visibility = has ? 'visible' : 'hidden';
  $('#delete-planet').style.visibility = has ? 'visible' : 'hidden';
  $('#launch').disabled = !has;
  $('#launch').style.opacity = has ? '1' : '0.4';
  if (!has) {
    $('#info-name').textContent = store.galaxy.name;
    $('#info-course').textContent = 'An empty system. Add a planet for your first course.';
    $('#progress-fill').style.width = '0';
    $('#progress-label').textContent = '';
    return;
  }
  $('#info-name').textContent = p.name;
  $('#info-course').textContent = p.course;
  $('#progress-fill').style.width = `${progressOf(p) * 100}%`;
  const label = $('#progress-label');
  label.classList.toggle('saved', isSaved(p));
  label.textContent = isSaved(p) ? 'Planet saved' : `${p.completed} / ${p.lessons} sectors`;
  info.dataset.planet = p.id;
}

function renderGalaxyMenu() {
  const m = getManifest();
  const menu = $('#galaxy-menu');
  menu.innerHTML =
    store.state.galaxies
      .map((g) => {
        const star = m.stars[g.star] ?? Object.values(m.stars)[0];
        const saved = g.planets.filter(isSaved).length;
        return `<button data-id="${g.id}" class="${g.id === store.galaxy.id ? 'active' : ''}">
          <span class="star-dot" style="background:${star.glow};color:${star.glow}"></span>
          ${esc(g.name)}<span class="meta">${saved}/${g.planets.length} saved</span></button>`;
      })
      .join('') + '<hr><button data-new="1">+ New galaxy</button>';
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

function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const backdrop = root.querySelector('.backdrop');
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) closeModal();
  });
  const first = root.querySelector('input, button');
  first?.focus();
  return root.querySelector('.modal');
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

  const modal = openModal(`
    <h2>${editing ? 'Edit planet' : 'New planet'}</h2>
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
              <span class="orb" style="background:radial-gradient(circle at 35% 30%, ${b.atmosphere}, ${b.swatch} 55%, #000 100%);box-shadow:0 0 12px ${b.atmosphere}55"></span>${b.label}</button>`,
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
      <div class="modal-actions">
        <button type="button" class="btn small" data-cancel>Cancel</button>
        <button type="submit" class="btn small primary">${editing ? 'Save changes' : 'Chart planet'}</button>
      </div>
    </form>`);

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
  const modal = openModal(`
    <h2>New galaxy</h2>
    <p class="lead">A galaxy groups related course planets around a single star.</p>
    <form autocomplete="off">
      <div class="field"><label for="gf-name">Galaxy name</label><input id="gf-name" type="text" maxlength="28" required placeholder="e.g. Advanced Mathematics"></div>
      <div class="field"><span class="lbl">Star</span><div class="seg" id="gf-star">${Object.entries(m.stars)
        .map(([id, s], i) => `<button type="button" data-v="${id}" class="${i === 0 ? 'active' : ''}"><span style="color:${s.glow}">●</span> ${s.label}</button>`)
        .join('')}</div></div>
      <div class="field"><span class="lbl">Nebula</span><div class="seg" id="gf-neb">${Object.entries(NEBULAE)
        .map(([id, n]) => `<button type="button" data-v="${id}" class="${id === state.nebula ? 'active' : ''}"><span style="color:${n.a};filter:brightness(2.2)">●</span> ${n.label}</button>`)
        .join('')}</div></div>
      <div class="modal-actions">
        <button type="button" class="btn small" data-cancel>Cancel</button>
        <button type="submit" class="btn small primary">Create galaxy</button>
      </div>
    </form>`);
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

export function confirmModal({ title, body, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <h2>${esc(title)}</h2><p class="lead">${body}</p>
      <div class="modal-actions">
        <button class="btn small" data-no>Cancel</button>
        <button class="btn small ${danger ? 'danger' : 'primary'}" data-yes>${esc(confirm)}</button>
      </div>`);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(v);
    };
    modal.querySelector('[data-no]').addEventListener('click', () => done(false));
    modal.querySelector('[data-yes]').addEventListener('click', () => done(true));
    $('#modal-root').addEventListener('close', () => done(false), { once: true });
  });
}

/** Shown when nothing handles the `coursegalaxy:launch` event (standalone demo). */
export function launchModal(planet) {
  const modal = openModal(`
    <div class="launch-card">
      <div class="eyebrow">Launching</div>
      <div class="big">${esc(planet.name)}</div>
      <div style="color:var(--muted)">${esc(planet.course)}</div>
      <div class="demo-note">
        <strong>Hook up your course player here.</strong> Listen for
        <code>coursegalaxy:launch</code> on <code>window</code> and call
        <code>event.preventDefault()</code> to replace this dialog. Report progress with
        <code>CourseGalaxy.setProgress(id, lessonsDone)</code>.
      </div>
      <div class="modal-actions" style="justify-content:center">
        <button class="btn small" data-close>Close</button>
        <button class="btn small primary" data-lesson ${isSaved(planet) ? 'disabled' : ''}>${isSaved(planet) ? 'Planet saved' : 'Complete a lesson (demo)'}</button>
      </div>
    </div>`);
  modal.querySelector('[data-close]').addEventListener('click', closeModal);
  modal.querySelector('[data-lesson]').addEventListener('click', () => {
    closeModal();
    app.setProgress(planet.id, planet.completed + 1);
  });
}

export function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

export function setLoading(frac, done = false) {
  $('#loading-fill').style.width = `${Math.round(frac * 100)}%`;
  if (done) $('#loading').classList.add('done');
}
