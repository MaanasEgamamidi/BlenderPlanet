# Course Galaxy

A 3D galaxy of hex-tiled planets, where every planet is a course. The focused
planet stays centred up front and the rest of the system keeps orbiting its star
in the background. Finishing lessons claims hex sectors on the planet, and when
every lesson is done the planet is **saved**.

```
blender/generate_planets.py   Blender script that builds the planets (GLB) + manifest
web/                          Three.js viewer (Vite)
  public/planets/             generated assets: 10 biomes x 2 terrain seeds, 3 stars
                              (hex GLB + baked smooth-surface textures for each)
  src/main.js                 renderer, app state, picking, public API
  src/system.js               a star system: star, orbits, planets, atmospheres
  src/camera.js               focus rig (camera locked to the planet, drag/zoom)
  src/assets.js               GLB loading + planet / atmosphere shaders
  src/background.js           starfield + nebula
  src/data.js                 galaxies / planets store (localStorage)
  src/ui.js                   HUD, planet list, modals
```

## Run it

```bash
cd web
npm install
npm run dev
```

## Controls

The HUD follows Starfield's menu layout: planet list on the left, the focused planet's card on
the right, the galaxy switcher top-centre and a key-prompt bar bottom-right (every prompt is also clickable).

- Click a planet in the list, or on a planet in the scene, to fly to it.
- `←` / `→` (or `A` / `D`) to cycle through planets. `Enter` launches. `N` adds a planet,
  `R` edits the focused one, `X` removes it, `B` flies back to the previous planet.
- Drag to orbit around the focused planet. Scroll or pinch to zoom.
- **Hex field / Smooth** (under the planet card, or `T`) switches every world between the hex tiles and a
  continuous smooth surface. The change sweeps across each planet from pole to pole. The choice is
  remembered, and the smooth meshes only download the first time you switch.
- `Q` / `E` (or the bumpers beside the galaxy name) switch galaxy with a warp transition. Click the
  galaxy name to list every galaxy or create a new one.
- **New Planet** charts a course planet: pick a biome, a terrain seed, a size and a colour shift.

The UI font stack starts with NB Architekt / NB Grotesk (Starfield's commercial fonts) and falls back to
the bundled Red Hat Display / Red Hat Text. The real fonts only apply if they are installed on the
viewer's machine or served from a licensed `@font-face`.

## Plugging in your course app

The viewer dispatches cancelable events on `window`. Call `preventDefault()` to
take over from the built-in behaviour.

| Event | When | Default if not prevented |
| --- | --- | --- |
| `coursegalaxy:launch` | Launch pressed | demo dialog with a "complete a lesson" button |
| `coursegalaxy:back` | Back pressed | fly to the previously focused planet |
| `coursegalaxy:focus` | a planet became the focus | none |
| `coursegalaxy:saved` | a planet reached 100% | none (a shockwave plays) |
| `coursegalaxy:galaxy` | a galaxy finished loading | none |
| `coursegalaxy:surface` | hex/smooth switch finished loading | none |

`event.detail` is `{ planet, galaxy }`.

```js
window.addEventListener('coursegalaxy:launch', (e) => {
  e.preventDefault();
  openCourse(e.detail.planet.id);
});

// after the learner finishes a lesson:
CourseGalaxy.setProgress(planetId, lessonsCompleted);
```

The full API is on `window.CourseGalaxy`: `getState`, `focus`, `switchGalaxy`,
`addGalaxy`, `addPlanet`, `updatePlanet`, `removePlanet`, `setProgress`,
`setSurface('hex' | 'smooth')` and `reset`. State persists to `localStorage` (`src/data.js`). Swap that for your
backend when you wire it up.

## Regenerating planets in Blender

The hex planets are Goldberg polyhedra: 5,762 tiles each, hexagons plus 12
pentagons. Each tile gets stepped terrain from noise, a biome colour and a claim
order. The GLBs carry three channels that the web shader reads:

- `COLOR_0`: rgb is the tile colour, alpha is how strongly the tile glows (lava, crystals, star surface).
- `_ORDER`: the order in which tiles light up as the course progresses (spreads out from a landing site).
- `_EDGE`: 0 at a tile's centre and 1 at its rim. This draws the glowing hex borders on claimed tiles.

**Smooth mode** is a UV sphere wearing three 2048×1024 textures baked by the same
script. Every pixel is sampled from the *same* biome function and noise seed as
the hex tiles, so oceans, continents, lava channels and storms sit in exactly
the same places. Only the rendering changes:

- `*_albedo.jpg`: surface colour. Zone edges on land are softened (terrain blends as
  seen from orbit), coastlines stay sharp, and fine detail and regional tint variation are added.
- `*_normal.jpg`: relief from the height field, lit by the star.
- `*_data.png`: R = roughness (liquids are glossy and catch a sun glint), G = glow, B = claim order.
  Claimed territory shows as a warm tint with a glowing frontier line.

Stars get an albedo texture with granulation; the viewer adds limb darkening.
Baking is pure-Python sampling, so the script spreads it across several background
Blender processes (`--jobs`).

```bash
# everything (about 3–5 minutes), from web/
npm run planets

# or directly, e.g. only two biomes with 3 seeds each at a higher tile count
blender --background --factory-startup --python blender/generate_planets.py -- \
  --out web/public/planets --only lava,ice --variants 3 --freq 30 --tex 4096 --jobs 6
```

To add a biome, write a colour function next to the others and register it in
`BIOMES` in `generate_planets.py`, then re-run the script. The manifest updates
and the new biome appears in the **New Planet** dialog.
