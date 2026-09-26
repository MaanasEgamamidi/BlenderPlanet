"""
Hex-tiled planet generator for the Course Galaxy.

Builds Goldberg-style hex planets (a subdivided icosahedron's dual: hexagons
plus 12 pentagons), sculpts stepped terrain with noise, paints each tile from a
biome palette and exports one GLB per planet plus a manifest.json that the web
viewer reads. Each planet also gets baked textures for its smooth mode
(<name>_albedo.jpg, _normal.jpg, _data.png): the same biome sampled per pixel,
so both modes show identical features.

Run headless:
    blender --background --factory-startup --python blender/generate_planets.py -- \
        --out web/public/planets [--only lava,ice] [--variants 2] [--freq 24] [--tex 2048] [--jobs 6]

Every GLB carries three per-vertex channels that the web shader relies on:
    COLOR_0   rgb = tile colour, a = emission strength (0..1)
    _ORDER    0..1 claim order - tiles light up in this order as a course progresses
    _EDGE     0 at a tile's centre, 1 on its rim / walls (draws the glowing hex borders)

To add a new biome, add an entry to BIOMES below and re-run.
"""

import bpy
import bmesh  # noqa: F401  (kept for people extending the script)
import json
import math
import os
import random
import sys

import numpy as np
from mathutils import Vector, Color, noise

# --------------------------------------------------------------------------- #
#  Colour helpers
# --------------------------------------------------------------------------- #


def hex_rgb(h):
    h = h.lstrip("#")
    # Blender vertex colours are linear; convert from sRGB so exported colours
    # match the palette when three.js decodes them.
    def lin(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return Vector((lin(int(h[0:2], 16)), lin(int(h[2:4], 16)), lin(int(h[4:6], 16))))


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return a * (1 - t) + b * t


def ramp(stops, t):
    """stops: list of (position, Vector colour) sorted by position."""
    if t <= stops[0][0]:
        return stops[0][1].copy()
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        if t <= p1:
            return mix(c0, c1, (t - p0) / max(p1 - p0, 1e-6))
    return stops[-1][1].copy()


def jitter(c, rng, amount=0.08):
    k = 1.0 + (rng.random() - 0.5) * 2 * amount
    return Vector((c.x * k, c.y * k, c.z * k))


def fbm(p, octaves=5, lac=2.0, gain=0.5, basis="PERLIN_NEW"):
    amp, freq, total, norm = 1.0, 1.0, 0.0, 0.0
    for _ in range(octaves):
        total += amp * noise.noise(p * freq, noise_basis=basis)
        norm += amp
        amp *= gain
        freq *= lac
    return total / norm  # roughly -1..1


def ridged(p, octaves=5):
    amp, freq, total, norm = 1.0, 1.0, 0.0, 0.0
    for _ in range(octaves):
        n = 1.0 - abs(noise.noise(p * freq, noise_basis="PERLIN_NEW"))
        total += amp * n * n
        norm += amp
        amp *= 0.5
        freq *= 2.1
    return total / norm  # 0..1


# --------------------------------------------------------------------------- #
#  Biomes.  Each returns (height 0..1, colour Vector, emission 0..1) per tile.
#  `d` is the unit direction of the tile centre, `o` a per-planet noise offset.
# --------------------------------------------------------------------------- #


def b_terran(d, o, rng):
    e = fbm(d * 1.6 + o, 6) * 0.5 + 0.5
    m = fbm(d * 2.3 + o * 1.7 + Vector((5, 1, 3)), 4) * 0.5 + 0.5
    lat = abs(d.z)
    sea = 0.5
    if lat > 0.86 - (m - 0.5) * 0.15:
        return max(e, sea) * 0.6 + 0.25, jitter(hex_rgb("e8f1f7"), rng, 0.05), 0.0
    if e < sea:
        # deep navy basins shading to turquoise shelves near the coast (Blue Marble)
        c = ramp([(0.0, hex_rgb("071a40")), (0.36, hex_rgb("0e3470")), (0.46, hex_rgb("1a5c9c")), (0.5, hex_rgb("2d8fb0"))], e)
        return 0.0, jitter(c, rng, 0.04), 0.0
    t = (e - sea) / (1 - sea)
    if t < 0.08:
        c = hex_rgb("d9c68b")
    elif m > 0.55:
        c = ramp([(0.0, hex_rgb("3f8f3a")), (0.5, hex_rgb("2b6a2c")), (0.8, hex_rgb("5b5a4a")), (1.0, hex_rgb("f2f2f2"))], t * 1.4)
    else:
        c = ramp([(0.0, hex_rgb("8faa4b")), (0.4, hex_rgb("b59b5d")), (0.75, hex_rgb("7b6a58")), (1.0, hex_rgb("f2f2f2"))], t * 1.4)
    return t, jitter(c, rng), 0.0


def b_lava(d, o, rng):
    e = ridged(d * 1.8 + o, 5)
    cracks = abs(fbm(d * 3.2 + o * 2, 3))
    if cracks < 0.07 or e < 0.28:
        heat = 1.0 - min(cracks / 0.07, 1.0) * 0.5 if cracks < 0.07 else 0.6
        c = ramp([(0.0, hex_rgb("ff3d00")), (0.6, hex_rgb("ff8a00")), (1.0, hex_rgb("ffd54a"))], heat * rng.uniform(0.7, 1.0))
        return 0.0, c, 0.85 * heat
    c = ramp([(0.0, hex_rgb("2e2420")), (0.5, hex_rgb("45352f")), (1.0, hex_rgb("6a564a"))], e)
    return (e - 0.28) / 0.72, jitter(c, rng, 0.15), 0.0


def b_ice(d, o, rng):
    e = fbm(d * 1.4 + o, 5) * 0.5 + 0.5
    crev = abs(fbm(d * 4.0 + o * 3, 3))
    if crev < 0.028:
        # Europa-style lineae: salts stain the cracks reddish-brown
        return 0.0, hex_rgb("8c5536"), 0.0
    c = ramp([(0.0, hex_rgb("7fb7d9")), (0.45, hex_rgb("c7e4f2")), (0.75, hex_rgb("eef7fb")), (1.0, hex_rgb("ffffff"))], e)
    return max(0.0, e - 0.35) * 1.3, jitter(c, rng, 0.05), 0.0


def b_desert(d, o, rng):
    e = fbm(d * 1.5 + o, 5) * 0.5 + 0.5
    canyon = abs(fbm(d * 2.2 + o * 1.3, 4))
    if canyon < 0.06:
        return 0.0, jitter(hex_rgb("5a2616"), rng, 0.1), 0.0
    dunes = math.sin((d.z * 18 + fbm(d * 3 + o, 2) * 4)) * 0.5 + 0.5
    c = ramp([(0.0, hex_rgb("9b3f1e")), (0.4, hex_rgb("c4622d")), (0.7, hex_rgb("d98b4a")), (1.0, hex_rgb("ecc38a"))], e * 0.8 + dunes * 0.2)
    if abs(d.z) > 0.9:
        c = mix(c, hex_rgb("f3e6da"), 0.8)
    return e, jitter(c, rng, 0.08), 0.0


def b_toxic(d, o, rng):
    e = fbm(d * 1.7 + o, 5) * 0.5 + 0.5
    spores = fbm(d * 5.0 + o * 2, 2)
    if e < 0.42:
        c = mix(hex_rgb("3cff6f"), hex_rgb("a4ff3c"), rng.random())
        return 0.0, c, 0.55
    c = ramp([(0.0, hex_rgb("5a3a8a")), (0.5, hex_rgb("7a4fb0")), (0.8, hex_rgb("9a6fd0")), (1.0, hex_rgb("c8a8f0"))], e)
    if spores > 0.45:
        return (e - 0.42) * 1.4, hex_rgb("b58cff"), 0.45
    return (e - 0.42) * 1.4, jitter(c, rng, 0.18), 0.0


def b_crystal(d, o, rng):
    e = fbm(d * 1.3 + o, 4) * 0.5 + 0.5
    v = noise.voronoi(d * 3.0 + o, distance_metric="DISTANCE")[0][0]
    if v < 0.3:
        c = mix(hex_rgb("33f0ff"), hex_rgb("ff4fd8"), fbm(d * 2 + o, 2) * 0.5 + 0.5)
        return 0.35 + (0.3 - v) * 2.2, jitter(c, rng, 0.12), 0.1 + (0.3 - v) * 0.9
    c = ramp([(0.0, hex_rgb("2f5575")), (0.5, hex_rgb("41759a")), (1.0, hex_rgb("7fb0cc"))], e)
    return e * 0.4, jitter(c, rng, 0.12), 0.0


def b_gas(d, o, rng):
    w = fbm(d * 2.0 + o, 3) * 0.35
    band = math.sin((d.z + w) * 11.0) * 0.5 + 0.5
    storm = (d - Vector((0.6, -0.5, -0.35)).normalized()).length
    c = ramp([(0.0, hex_rgb("7a4b2c")), (0.3, hex_rgb("c08a58")), (0.55, hex_rgb("e8d2ae")), (0.8, hex_rgb("b86a3d")), (1.0, hex_rgb("f1e3c7"))], band)
    if storm < 0.22:
        c = mix(hex_rgb("c2442a"), c, storm / 0.22)
    return band * 0.15, jitter(c, rng, 0.03), 0.0


def b_jungle(d, o, rng):
    e = fbm(d * 1.6 + o, 6) * 0.5 + 0.5
    river = abs(fbm(d * 2.6 + o * 1.9, 4))
    if river < 0.045 or e < 0.33:
        return 0.0, jitter(hex_rgb("1c6f7a"), rng, 0.05), 0.0
    c = ramp([(0.0, hex_rgb("2f7a38")), (0.4, hex_rgb("1d5f2c")), (0.7, hex_rgb("2d7d34")), (1.0, hex_rgb("6d8c3b"))], e)
    glow = rng.random() < 0.012
    return (e - 0.33) * 1.3, (hex_rgb("b8e04a") if glow else jitter(c, rng, 0.15)), (0.25 if glow else 0.0)


def b_moon(d, o, rng):
    e = fbm(d * 1.5 + o, 5) * 0.5 + 0.5
    f = noise.voronoi(d * 3.0 + o, distance_metric="DISTANCE")[0][0]
    crater = f < 0.22
    c = ramp([(0.0, hex_rgb("3f3f44")), (0.5, hex_rgb("75757c")), (1.0, hex_rgb("b3b3b9"))], e)
    if crater:
        return 0.0, jitter(c * 0.55, rng, 0.08), 0.0
    return e * 0.6, jitter(c, rng, 0.1), 0.0


def b_ember(d, o, rng):
    # Erekir-style: dark red crust, orange vents, rusty highlands
    e = fbm(d * 1.6 + o, 5) * 0.5 + 0.5
    vents = noise.voronoi(d * 5.0 + o, distance_metric="DISTANCE")[0][0]
    if vents < 0.1:
        return 0.0, hex_rgb("ff6a2b"), 0.75
    c = ramp([(0.0, hex_rgb("4a1a14")), (0.4, hex_rgb("7a2a1c")), (0.7, hex_rgb("8f3b21")), (1.0, hex_rgb("d98a5a"))], e)
    return e, jitter(c, rng, 0.14), 0.0


def star_fn(palette):
    def fn(d, o, rng):
        n = fbm(d * 2.2 + o, 4) * 0.5 + 0.5
        b = fbm(d * 6.0 + o * 3, 2) * 0.5 + 0.5
        c = ramp(palette, n * 0.75 + b * 0.25)
        return n * 0.12, jitter(c, rng, 0.06), 1.0

    return fn


BIOMES = {
    # id         label                   fn         relief  atmosphere  palette swatch
    "terran":  ("Terran",                b_terran,  0.045, "#6fc3ff", "#2c8ad1"),
    "lava":    ("Volcanic",              b_lava,    0.055, "#ff7a3c", "#ff5a1a"),
    "ice":     ("Glacial",               b_ice,     0.035, "#bfefff", "#c7e4f2"),
    "desert":  ("Dune",                  b_desert,  0.045, "#ffb27a", "#c4622d"),
    "toxic":   ("Toxic",                 b_toxic,   0.05,  "#b77cff", "#4b2a6e"),
    "crystal": ("Crystal",               b_crystal, 0.06,  "#5ff4ff", "#33f0ff"),
    "gas":     ("Gas Giant",             b_gas,     0.018, "#ffd9a8", "#e8d2ae"),
    "jungle":  ("Jungle",                b_jungle,  0.05,  "#8dffb0", "#2d7d34"),
    "moon":    ("Barren",                b_moon,    0.04,  "#c9c9d6", "#75757c"),
    "ember":   ("Ember",                 b_ember,   0.05,  "#ff6a4a", "#8f3b21"),
}

STARS = {
    "star_yellow": ("Yellow Star", [(0.0, hex_rgb("ff5a00")), (0.4, hex_rgb("ff9a1f")), (0.7, hex_rgb("ffd24a")), (1.0, hex_rgb("fff3b0"))], "#ffb347"),
    "star_red":    ("Red Dwarf",   [(0.0, hex_rgb("7a0a05")), (0.4, hex_rgb("d6240e")), (0.75, hex_rgb("ff5a2a")), (1.0, hex_rgb("ffa27a"))], "#ff4a2a"),
    "star_blue":   ("Blue Giant",  [(0.0, hex_rgb("1a3cff")), (0.4, hex_rgb("4f8bff")), (0.75, hex_rgb("a8d0ff")), (1.0, hex_rgb("f0f8ff"))], "#7fb2ff"),
}

# --------------------------------------------------------------------------- #
#  Goldberg polyhedron
# --------------------------------------------------------------------------- #


def icosahedron():
    t = (1 + 5 ** 0.5) / 2
    v = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t),
         (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    f = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4),
         (11, 10, 2), (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8),
         (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    return [Vector(p).normalized() for p in v], f


def geodesic(freq):
    """Subdivide each icosahedron face into freq^2 triangles on the unit sphere."""
    base_v, base_f = icosahedron()
    verts, index = [], {}

    def key(p):
        return (round(p.x, 5), round(p.y, 5), round(p.z, 5))

    def add(p):
        p = p.normalized()
        k = key(p)
        if k not in index:
            index[k] = len(verts)
            verts.append(p)
        return index[k]

    tris = []
    for a, b, c in base_f:
        A, B, C = base_v[a], base_v[b], base_v[c]
        grid = {}
        for i in range(freq + 1):
            for j in range(freq + 1 - i):
                k = freq - i - j
                grid[i, j] = add((A * i + B * j + C * k) / freq)
        for i in range(freq):
            for j in range(freq - i):
                tris.append((grid[i, j], grid[i + 1, j], grid[i, j + 1]))
                if i + j < freq - 1:
                    tris.append((grid[i + 1, j], grid[i + 1, j + 1], grid[i, j + 1]))
    return verts, tris


def goldberg(freq):
    """Returns tiles: list of (centre_dir, [corner dirs ordered CCW])."""
    verts, tris = geodesic(freq)
    centroids = [((verts[a] + verts[b] + verts[c]) / 3).normalized() for a, b, c in tris]
    around = [[] for _ in verts]
    for ti, (a, b, c) in enumerate(tris):
        around[a].append(ti)
        around[b].append(ti)
        around[c].append(ti)
    tiles = []
    for vi, tlist in enumerate(around):
        n = verts[vi]
        ref = (centroids[tlist[0]] - n).normalized()
        side = n.cross(ref)
        corners = sorted(
            (centroids[t] for t in tlist),
            key=lambda p: math.atan2((p - n).dot(side), (p - n).dot(ref)),
        )
        tiles.append((n, corners))
    # neighbours: tiles sharing a triangle
    neigh = [set() for _ in verts]
    for a, b, c in tris:
        neigh[a].update((b, c))
        neigh[b].update((a, c))
        neigh[c].update((a, b))
    return tiles, neigh


# --------------------------------------------------------------------------- #
#  Mesh build
# --------------------------------------------------------------------------- #


LANDING = Vector((0.35, -0.8, 0.45)).normalized()


class NeutralRng:
    """Stand-in RNG for the smooth surface: no per-tile jitter or random glow spots."""

    def random(self):
        return 0.5

    def uniform(self, a, b):
        return (a + b) / 2


def planet_offset(seed):
    rng = random.Random(seed)
    o = Vector((rng.uniform(-100, 100), rng.uniform(-100, 100), rng.uniform(-100, 100)))
    return o, rng


def raw_order(d, o):
    """Claim order before normalisation: angular distance from the landing site,
    wobbled by noise so territory grows as an organic blob. Shared by the hex and
    smooth meshes so both show the same claimed region."""
    ang = math.acos(max(-1.0, min(1.0, d.dot(LANDING)))) / math.pi
    return ang + noise.noise(d * 2.5 + o * 0.3) * 0.18


def order_range(o):
    dirs, _ = geodesic(24)
    vals = [raw_order(d, o) for d in dirs]
    return min(vals), max(vals)


def norm_order(x, rng_lohi):
    lo, hi = rng_lohi
    return max(0.0, min(0.999, (x - lo) / (hi - lo)))


def finish_mesh(name, positions, faces, smooth, cols, emis, orders, edges, is_star):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(p) for p in positions], [], faces)
    mesh.update()
    mesh.polygons.foreach_set("use_smooth", smooth)
    ca = mesh.color_attributes.new("Color", "FLOAT_COLOR", "POINT")
    flat = []
    for c, e in zip(cols, emis):
        flat.extend((c.x, c.y, c.z, e))
    ca.data.foreach_set("color", flat)
    mesh.color_attributes.active_color = ca
    oa = mesh.attributes.new("_ORDER", "FLOAT", "POINT")
    ea = mesh.attributes.new("_EDGE", "FLOAT", "POINT")
    oa.data.foreach_set("value", orders)
    ea.data.foreach_set("value", edges)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(vertex_color_material(is_star))
    return obj


def build_planet(name, fn, relief, seed, freq, levels=7, inset=0.93, is_star=False):
    """Hex-field planet: one raised prism per Goldberg tile."""
    o, rng = planet_offset(seed)
    lohi = order_range(o)
    tiles, _ = goldberg(freq)

    samples = [fn(c, o, rng) for c, _ in tiles]
    # Stepped heights give the chunky terraced Mindustry look.
    heights = [round(max(0.0, min(1.0, h)) * levels) / levels for h, _, _ in samples]
    order = [norm_order(raw_order(c, o), lohi) for c, _ in tiles]

    positions, faces, smooth = [], [], []
    cols, emis, ords, edges = [], [], [], []
    base_r = 1.0 - relief * 0.6

    def vert(p, c, e, od, ed):
        positions.append(p)
        cols.append(c); emis.append(e); ords.append(od); edges.append(ed)
        return len(positions) - 1

    for i, (centre, corners) in enumerate(tiles):
        _, c, emission = samples[i]
        r = 1.0 + heights[i] * relief
        k = len(corners)
        top_c = vert(centre * r, c, emission, order[i], 0.0)
        rim = [(centre + (p - centre) * inset).normalized() * r for p in corners]
        ring = [vert(q, c, emission, order[i], 1.0) for q in rim]
        for j in range(k):
            faces.append((top_c, ring[j], ring[(j + 1) % k]))
            smooth.append(True)  # shared fan verts -> gentle dome shading
        # Walls down to the core, sharing verts around the tile (smooth-shaded
        # like a short column) to keep the vertex count down. Winding
        # (top_j, bottom_j, bottom_j+1, top_j+1) faces away from the tile centre.
        wall_c = c * 0.45
        wt = [vert(q, wall_c, emission * 0.5, order[i], 1.0) for q in rim]
        wb = [vert(q.normalized() * base_r, wall_c, emission * 0.5, order[i], 1.0) for q in rim]
        for j in range(k):
            n = (j + 1) % k
            faces.append((wt[j], wb[j], wb[n], wt[n]))
            smooth.append(True)

    obj = finish_mesh(name, positions, faces, smooth, cols, emis, ords, edges, is_star)
    return obj, len(tiles)


# --------------------------------------------------------------------------- #
#  Smooth surface: baked equirectangular textures
# --------------------------------------------------------------------------- #
#
# The smooth planet is a plain UV sphere in the viewer wearing textures baked
# here. Every pixel is sampled from the SAME biome function and noise offset as
# the hex tiles, so oceans, continents, lava channels and storms sit in exactly
# the same places - only the rendering changes. Realism comes from resolution
# (crisp coastlines instead of blurred vertex colours), fine surface detail, a
# normal map for relief and a roughness channel so liquids catch the sun.
#
# Pixel (row, col) maps to the viewer's SphereGeometry direction
#   (-cos(phi) sin(theta), cos(theta), sin(phi) sin(theta)),
#   theta = (row + .5) / H * pi,  phi = (col + .5) / W * 2 pi,
# which is Blender direction (x, -z, y) because glTF export is Y-up.

# Biomes whose zero-height regions are liquid (oceans, rivers, toxic pools, lava).
LIQUID = {"terran": 0.26, "jungle": 0.3, "toxic": 0.32, "lava": 0.55}


def _hash3(ix, iy, iz):
    h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)
    h = (h ^ (h >> 13)) * 1274126177
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF).astype(np.float32) / float(0xFFFFFF)


def vnoise(p):
    """Vectorised 3D value noise in -1..1 for detail layers (not feature placement)."""
    i = np.floor(p).astype(np.int64)
    f = (p - i).astype(np.float32)
    u = f * f * (3 - 2 * f)
    x, y, z = i[:, 0], i[:, 1], i[:, 2]
    ux, uy, uz = u[:, 0], u[:, 1], u[:, 2]

    def lerp(a, b, t):
        return a + (b - a) * t

    c000, c100 = _hash3(x, y, z), _hash3(x + 1, y, z)
    c010, c110 = _hash3(x, y + 1, z), _hash3(x + 1, y + 1, z)
    c001, c101 = _hash3(x, y, z + 1), _hash3(x + 1, y, z + 1)
    c011, c111 = _hash3(x, y + 1, z + 1), _hash3(x + 1, y + 1, z + 1)
    v = lerp(lerp(lerp(c000, c100, ux), lerp(c010, c110, ux), uy),
             lerp(lerp(c001, c101, ux), lerp(c011, c111, ux), uy), uz)
    return v * 2 - 1


def fbm_np(p, octaves=4):
    total = np.zeros(len(p), np.float32)
    amp, norm = 1.0, 0.0
    for k in range(octaves):
        total += amp * vnoise(p * (2.03 ** k) + k * 17.3)
        norm += amp
        amp *= 0.5
    return total / norm


def box_blur(a, r, axis):
    """Box blur along one axis; wraps around longitude (axis 1), clamps at the poles (axis 0)."""
    if r < 1:
        return a
    n = 2 * r + 1
    if axis == 1:
        pad = np.concatenate([a[:, -r:], a, a[:, :r]], axis=1)
    else:
        pad = np.concatenate([np.repeat(a[:1], r, 0), a, np.repeat(a[-1:], r, 0)], axis=0)
    c = np.cumsum(pad, axis=axis, dtype=np.float64)
    c = np.concatenate([np.zeros_like(np.take(c, [0], axis=axis)), c], axis=axis)
    hi = np.take(c, np.arange(n, c.shape[axis]), axis=axis)
    lo = np.take(c, np.arange(0, c.shape[axis] - n), axis=axis)
    return ((hi - lo) / n).astype(np.float32)


def soft_blur(a, r, passes=3):
    """Three box passes ~ gaussian. Works on HxW or HxWxC arrays."""
    for _ in range(passes):
        a = box_blur(box_blur(a, r, 1), r, 0)
    return a


def masked_blur(a, mask, r):
    """Blur `a` only among pixels where mask is set (no bleeding across the mask edge)."""
    m = mask.astype(np.float32)
    num = soft_blur(a * (m[..., None] if a.ndim == 3 else m), r)
    den = soft_blur(m, r)
    den = den[..., None] if a.ndim == 3 else den
    return np.where(den > 1e-4, num / np.maximum(den, 1e-4), a)


def to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def save_image(arr, path, fmt, quality=92):
    """arr: HxWx3 floats already in the file's encoding (row 0 = top)."""
    h, w, _ = arr.shape
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    img.colorspace_settings.name = "Non-Color"  # write values untouched
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = np.clip(arr, 0, 1)
    img.pixels.foreach_set(rgba[::-1].ravel())  # Blender rows start at the bottom
    img.filepath_raw = path
    img.file_format = fmt
    img.save(quality=quality)
    bpy.data.images.remove(img)


def bake_textures(prefix, kind, fn, relief, seed, out, width=2048, is_star=False):
    W, H = width, width // 2
    o, _ = planet_offset(seed)
    lohi = order_range(o)
    rng = NeutralRng()

    th = (np.arange(H) + 0.5) / H * math.pi
    ph = (np.arange(W) + 0.5) / W * 2 * math.pi
    st, ct = np.sin(th)[:, None], np.cos(th)[:, None]
    X = -np.cos(ph)[None, :] * st
    Y = np.broadcast_to(ct, (H, W))
    Z = np.sin(ph)[None, :] * st
    bdir = np.stack([X, -Z, Y], -1).astype(np.float64)  # Blender-space directions

    alb = np.zeros((H, W, 3), np.float32)
    hgt = np.zeros((H, W), np.float32)
    emi = np.zeros((H, W), np.float32)
    ordr = np.zeros((H, W), np.float32)
    V = Vector
    for r in range(H):
        row = bdir[r].tolist()
        a_r, h_r, e_r, o_r = alb[r], hgt[r], emi[r], ordr[r]
        for c, xyz in enumerate(row):
            d = V(xyz)
            h, col, e = fn(d, o, rng)
            a_r[c] = (col.x, col.y, col.z)
            h_r[c] = h
            e_r[c] = e
            if not is_star:
                o_r[c] = raw_order(d, o)

    P = bdir.reshape(-1, 3).astype(np.float32)
    det1 = fbm_np(P * 16 + 3.1, 5).reshape(H, W)
    det2 = fbm_np(P * 64 + 7.7, 3).reshape(H, W)

    if is_star:
        # Granulation + faint mottling; limb darkening is applied in the viewer.
        cells = fbm_np(P * 90 + 1.3, 2).reshape(H, W)
        alb *= (1 + 0.10 * det1 + 0.08 * cells)[..., None]
        save_image(to_srgb(alb), os.path.join(out, f"{prefix}_albedo.jpg"), "JPEG")
        return

    liquid = (hgt <= 1e-4) & (kind in LIQUID)
    land = ~liquid
    px = max(1, W // 700)  # blur radius scales with resolution

    # Real terrain seen from orbit blends between zones instead of switching at
    # hard edges. Soften colour zones within the land (and within the liquid) but
    # never across the shoreline, so coastlines stay exactly where the hexes put them.
    glow = emi > 0.05
    soft = masked_blur(alb, land & ~glow, px * 2)
    soft = np.where(liquid[..., None], masked_blur(alb, liquid & ~glow, px), soft)
    alb = np.where(glow[..., None], alb, soft)

    # Photographs of real worlds are a touch less saturated than game palettes.
    lum = (alb @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
    alb = alb * 0.88 + lum * 0.12

    if kind == "gas":
        # Fine turbulent streaks running along the bands (Juno-style detail).
        Pa = P * np.array([6, 6, 70], np.float32) + 5.0
        streak = fbm_np(Pa, 5).reshape(H, W)
        alb *= (1 + 0.14 * streak + 0.05 * det1)[..., None]
        height = hgt * 0.2 + streak * 0.02
    else:
        shade = np.where(land, 1 + 0.11 * det1 + 0.06 * det2, 1 + 0.025 * det1)
        alb *= shade[..., None]
        # Broad regional tint drift (greener / drier / redder patches) on land.
        tint = np.stack([fbm_np(P * 3 + 11 * (i + 1), 3).reshape(H, W) for i in range(3)], -1)
        alb *= np.where(land[..., None], 1 + 0.07 * tint, 1)
        height = np.clip(hgt, 0, 1) + np.where(land, 0.06 * det1 + 0.025 * det2, 0)

    if kind == "crystal":
        # Crystal fields: faceted shards (quantised cell noise) with bright
        # cleavage planes, instead of soft blobs. Only where crystals already are.
        facets = np.floor((vnoise(P * 140 + 9.1).reshape(H, W) * 0.5 + 0.5) * 5) / 4
        shards = glow
        alb = np.where(shards[..., None], alb * (0.55 + 0.7 * facets)[..., None], alb)
        height = np.where(shards, height + 0.25 * facets, height)
        emi = np.where(shards, emi * (0.4 + 0.9 * facets), emi)

    # Lit relief: slopes from the height field, in the sphere's UV tangent space
    # (+x = increasing u / longitude, +y = north).
    hh = soft_blur(height, px) * relief  # no razor cliffs at zone borders
    du = 2 * math.pi * np.maximum(st, 0.05) / W
    dv = math.pi / H
    gx = (np.roll(hh, -1, 1) - np.roll(hh, 1, 1)) / (2 * du)
    gy = -np.gradient(hh, axis=0) / dv  # rows run south, v runs north
    k = 5.0
    n = np.stack([-gx * k, -gy * k, np.ones_like(hh)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)

    rough = np.full((H, W), 0.9, np.float32)
    if kind == "crystal":
        rough[glow] = 0.18  # polished faces flash in the sunlight
    if kind in LIQUID:
        rough[liquid] = LIQUID[kind]
    if kind == "ice":
        rough[:] = 0.55
    if kind == "gas":
        rough[:] = 0.8

    order = np.clip((ordr - lohi[0]) / (lohi[1] - lohi[0]), 0, 0.999)
    data = np.stack([rough, np.clip(emi, 0, 1), order], -1)
    data = data.reshape(H // 2, 2, W // 2, 2, 3).mean(axis=(1, 3))  # half-res is plenty

    save_image(to_srgb(alb), os.path.join(out, f"{prefix}_albedo.jpg"), "JPEG", 92)
    save_image(n * 0.5 + 0.5, os.path.join(out, f"{prefix}_normal.jpg"), "JPEG", 94)
    save_image(data, os.path.join(out, f"{prefix}_data.png"), "PNG")


def smooth_entry(prefix, is_star=False):
    if is_star:
        return {"albedo": f"{prefix}_albedo.jpg"}
    return {"albedo": f"{prefix}_albedo.jpg", "normal": f"{prefix}_normal.jpg", "data": f"{prefix}_data.png"}


def build_rings(name, inner, outer, count, seed, tint):
    """A belt of low-poly rocks around a planet (merged into one mesh)."""
    rng = random.Random(seed)
    positions, faces, cols = [], [], []
    iv, ifc = icosahedron()
    for _ in range(count):
        a = rng.uniform(0, math.tau)
        rr = rng.uniform(inner, outer) + rng.gauss(0, 0.02)
        centre = Vector((math.cos(a) * rr, math.sin(a) * rr, rng.gauss(0, 0.012)))
        s = rng.uniform(0.006, 0.022)
        shade = rng.uniform(0.55, 1.1)
        c = Vector((tint.x * shade, tint.y * shade, tint.z * shade))
        base = len(positions)
        for p in iv:
            q = Vector((p.x * rng.uniform(0.7, 1.3), p.y * rng.uniform(0.7, 1.3), p.z * rng.uniform(0.7, 1.3)))
            positions.append(centre + q * s)
            cols.append(c)
        for f in ifc:
            faces.append(tuple(base + x for x in f))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(p) for p in positions], [], faces)
    for poly in mesh.polygons:
        poly.use_smooth = False
    ca = mesh.color_attributes.new("Color", "FLOAT_COLOR", "POINT")
    for v, c in enumerate(cols):
        ca.data[v].color = (c.x, c.y, c.z, 0.0)
    oa = mesh.attributes.new("_ORDER", "FLOAT", "POINT")
    ea = mesh.attributes.new("_EDGE", "FLOAT", "POINT")
    oa.data.foreach_set("value", [2.0] * len(positions))  # never "claimed"
    ea.data.foreach_set("value", [0.0] * len(positions))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(vertex_color_material(False))
    return obj


_MATS = {}


def vertex_color_material(emissive):
    key = "star" if emissive else "planet"
    if key in _MATS:
        return _MATS[key]
    mat = bpy.data.materials.new("HexStar" if emissive else "HexPlanet")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Color"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    if emissive:
        nt.links.new(attr.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 3.0
    _MATS[key] = mat
    return mat


def export(objs, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_attributes=True,
        export_vertex_color="ACTIVE",
        export_normals=True,
        export_materials="EXPORT",
        export_yup=True,
        export_meshopt_compression_enable=True,
    )


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for m in list(bpy.data.meshes):
        bpy.data.meshes.remove(m)


# --------------------------------------------------------------------------- #
#  Entry point
# --------------------------------------------------------------------------- #


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = {"out": os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "public", "planets"),
            "only": None, "variants": 2, "freq": 24, "tex": 2048, "seed": 1337,
            "jobs": max(1, min(6, (os.cpu_count() or 2) - 1)), "bake": None, "no_bake": False}
    it = iter(argv)
    for a in it:
        if a == "--out":
            args["out"] = next(it)
        elif a == "--only":
            args["only"] = set(next(it).split(","))
        elif a == "--variants":
            args["variants"] = int(next(it))
        elif a == "--freq":
            args["freq"] = int(next(it))
        elif a == "--tex":
            args["tex"] = int(next(it))
        elif a == "--seed":
            args["seed"] = int(next(it))
        elif a == "--jobs":
            args["jobs"] = int(next(it))
        elif a == "--bake":  # internal: bake textures for these jobs only
            args["bake"] = next(it).split(",")
        elif a == "--no-bake":
            args["no_bake"] = True
    return args


def planet_seed(base, bid, v):
    return base + sum(map(ord, bid)) * 131 + v * 7919


def star_seed(base, sid):
    return base + len(sid)


def bake_job(key, args, out):
    """key is 'biome:variant' or a star id."""
    if ":" in key:
        bid, v = key.split(":")
        _, fn, relief, _, _ = BIOMES[bid]
        bake_textures(f"{bid}_{v}", bid, fn, relief, planet_seed(args["seed"], bid, int(v)), out, args["tex"])
    else:
        _, palette, _ = STARS[key]
        bake_textures(key, "star", star_fn(palette), 0.02, star_seed(args["seed"], key), out, args["tex"], is_star=True)
    print(f"[planets] baked {key}", flush=True)


def run_bakes(keys, args, out):
    """Texture baking is pure-Python sampling, so spread it over several
    background Blender processes."""
    import subprocess
    import time

    jobs = max(1, min(args["jobs"], len(keys)))
    if jobs == 1:
        for k in keys:
            bake_job(k, args, out)
        return
    buckets = [keys[i::jobs] for i in range(jobs)]
    procs = []
    for b in buckets:
        cmd = [bpy.app.binary_path, "--background", "--factory-startup", "--python", os.path.abspath(__file__), "--",
               "--out", out, "--seed", str(args["seed"]), "--tex", str(args["tex"]), "--bake", ",".join(b)]
        procs.append(subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True))
    print(f"[planets] baking {len(keys)} texture sets on {jobs} Blender processes...", flush=True)
    failed = False
    for pr in procs:
        output, _ = pr.communicate()
        for line in output.splitlines():
            if "[planets]" in line or "Error" in line or "Traceback" in line:
                print(line, flush=True)
        failed |= pr.returncode != 0
    if failed:
        raise SystemExit("[planets] a bake process failed")


def main():
    args = parse_args()
    out = os.path.abspath(args["out"])
    os.makedirs(out, exist_ok=True)

    if args["bake"]:
        for key in args["bake"]:
            bake_job(key, args, out)
        return

    manifest_path = os.path.join(out, "manifest.json")
    manifest = {"biomes": {}, "stars": {}}
    if os.path.exists(manifest_path) and args["only"]:
        with open(manifest_path) as fh:
            manifest = json.load(fh)

    def wanted(k):
        return args["only"] is None or k in args["only"]

    bakes = []
    for bid, (label, fn, relief, atmo, swatch) in BIOMES.items():
        if not wanted(bid):
            continue
        variants = []
        for v in range(args["variants"]):
            clear_scene()
            seed = planet_seed(args["seed"], bid, v)
            objs = []
            planet, ntiles = build_planet(f"{bid}_{v}", fn, relief, seed, args["freq"])
            objs.append(planet)
            has_rings = bid == "gas" or (bid in ("ice", "crystal") and v == 1)
            if has_rings:
                tint = hex_rgb(swatch)
                objs.append(build_rings(f"{bid}_{v}_rings", 1.45, 2.05, 900, seed, tint))
            fname = f"{bid}_{v}.glb"
            export(objs, os.path.join(out, fname))
            variants.append({"file": fname, "smooth": smooth_entry(f"{bid}_{v}"), "tiles": ntiles, "rings": has_rings})
            bakes.append(f"{bid}:{v}")
            print(f"[planets] {fname}: {ntiles} tiles")
        manifest["biomes"][bid] = {"label": label, "atmosphere": atmo, "swatch": swatch, "variants": variants}

    for sid, (label, palette, glow) in STARS.items():
        if not wanted(sid):
            continue
        clear_scene()
        star, ntiles = build_planet(sid, star_fn(palette), 0.02, star_seed(args["seed"], sid), args["freq"] + 2, is_star=True)
        fname = f"{sid}.glb"
        export([star], os.path.join(out, fname))
        manifest["stars"][sid] = {"label": label, "glow": glow, "file": fname, "smooth": smooth_entry(sid, True)}
        bakes.append(sid)
        print(f"[planets] {fname}: {ntiles} tiles")

    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=2)
    print("[planets] manifest written to", manifest_path)

    if not args["no_bake"]:
        run_bakes(bakes, args, out)
    print("[planets] done")


main()
