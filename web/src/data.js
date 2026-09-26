// Galaxy / planet data, persistence and change notifications.
//
// Shape:
//   { activeGalaxy, galaxies: [{ id, name, star, nebula, planets: [Planet] }] }
//   Planet = { id, name, course, biome, variant, hue, size, lessons, completed }
//
// A planet is "saved" when completed === lessons.

const STORAGE_KEY = 'course-galaxy/v1';

export const NEBULAE = {
  violet: { label: 'Violet', a: '#2a1250', b: '#0c1a4a' },
  ember: { label: 'Ember', a: '#4a1210', b: '#2a0c30' },
  teal: { label: 'Teal', a: '#0b3a4a', b: '#10204a' },
  rose: { label: 'Rose', a: '#4a1038', b: '#1a0c40' },
};

const uid = () => Math.random().toString(36).slice(2, 10);

function planet(name, course, biome, variant, lessons, completed, extra = {}) {
  return { id: uid(), name, course, biome, variant, hue: 0, size: 1, lessons, completed, ...extra };
}

function defaults() {
  return {
    activeGalaxy: 'core',
    galaxies: [
      {
        id: 'core',
        name: 'Core Sciences',
        star: 'star_yellow',
        nebula: 'violet',
        planets: [
          planet('Algebra', 'Algebra I: Equations & Functions', 'terran', 0, 12, 12),
          planet('Vulcan', 'Physics: Forces & Energy', 'lava', 0, 10, 4),
          planet('Miasma', 'Chemistry: Reactions', 'toxic', 0, 14, 2),
          planet('Verdant', 'Biology: Life Systems', 'jungle', 1, 12, 7),
          planet('Prism', 'Computer Science: Algorithms', 'crystal', 0, 16, 1),
          planet('Titan', 'Astronomy: The Cosmos', 'gas', 0, 8, 0, { size: 1.55 }),
        ],
      },
      {
        id: 'humanities',
        name: 'Humanities Reach',
        star: 'star_red',
        nebula: 'ember',
        planets: [
          planet('Dunehold', 'World History: Ancient Empires', 'desert', 0, 10, 6),
          planet('Cinder', 'Literature: The Novel', 'ember', 0, 9, 9),
          planet('Selene', 'Philosophy: Ethics', 'moon', 1, 6, 1),
          planet('Atlas', 'Geography: Earth Systems', 'terran', 1, 11, 3),
        ],
      },
      {
        id: 'arts',
        name: 'Creative Nebula',
        star: 'star_blue',
        nebula: 'teal',
        planets: [
          planet('Aria', 'Music Theory', 'ice', 1, 8, 2),
          planet('Chroma', 'Visual Design', 'crystal', 1, 10, 10),
          planet('Frost', 'Film & Story', 'ice', 0, 7, 0),
        ],
      },
    ],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.galaxies) && data.galaxies.length) return data;
    }
  } catch {
    /* storage unavailable or corrupt: fall back to defaults */
  }
  return defaults();
}

class Store extends EventTarget {
  constructor() {
    super();
    this.state = load();
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* ignore quota / private mode */
    }
  }

  emit(type, detail) {
    this.save();
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get galaxy() {
    return this.state.galaxies.find((g) => g.id === this.state.activeGalaxy) ?? this.state.galaxies[0];
  }

  findPlanet(id) {
    for (const g of this.state.galaxies) {
      const p = g.planets.find((x) => x.id === id);
      if (p) return { galaxy: g, planet: p };
    }
    return null;
  }

  setActiveGalaxy(id) {
    if (!this.state.galaxies.some((g) => g.id === id)) return;
    this.state.activeGalaxy = id;
    this.emit('galaxy', { id });
  }

  addGalaxy({ name, star = 'star_yellow', nebula = 'violet' }) {
    const g = { id: uid(), name, star, nebula, planets: [] };
    this.state.galaxies.push(g);
    this.emit('galaxies', { galaxy: g });
    return g;
  }

  addPlanet(galaxyId, data) {
    const g = this.state.galaxies.find((x) => x.id === galaxyId);
    if (!g) throw new Error(`Unknown galaxy ${galaxyId}`);
    const p = {
      id: uid(),
      name: 'New Planet',
      course: 'Untitled course',
      biome: 'terran',
      variant: 0,
      hue: 0,
      size: 1,
      lessons: 10,
      completed: 0,
      ...data,
    };
    g.planets.push(p);
    this.emit('planets', { galaxy: g, added: p });
    return p;
  }

  updatePlanet(id, patch) {
    const hit = this.findPlanet(id);
    if (!hit) return null;
    const before = { ...hit.planet };
    Object.assign(hit.planet, patch);
    hit.planet.lessons = Math.max(1, Math.round(hit.planet.lessons));
    hit.planet.completed = Math.max(0, Math.min(hit.planet.lessons, Math.round(hit.planet.completed)));
    const visual = ['biome', 'variant', 'hue', 'size'].some((k) => before[k] !== hit.planet[k]);
    this.emit('planet', { galaxy: hit.galaxy, planet: hit.planet, before, visual });
    return hit.planet;
  }

  removePlanet(id) {
    const hit = this.findPlanet(id);
    if (!hit) return;
    hit.galaxy.planets = hit.galaxy.planets.filter((p) => p.id !== id);
    this.emit('planets', { galaxy: hit.galaxy, removed: id });
  }

  reset() {
    this.state = defaults();
    this.emit('galaxy', { id: this.state.activeGalaxy });
  }
}

export const store = new Store();

export const isSaved = (p) => p.completed >= p.lessons;
export const progressOf = (p) => (p.lessons ? p.completed / p.lessons : 0);
