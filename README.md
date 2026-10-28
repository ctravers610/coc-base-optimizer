# Clash Base Optimizer

Lays out a Clash of Clans Home Village for defense from your Town Hall level, building counts and levels.

## Use it
- Open `index.html` in a browser (no server needed), or use the published artifact link.
- Pick your Town Hall, choose War/Trophy, Farming or Hybrid, adjust counts and levels (blank = max for your TH; one number = all; a list like `14,14,13,12` = per building), then press **Optimize base**.
- Drag any building on the map to tweak it; the score and notes recompute. The inventory and last layout are saved in your browser.
- The **Game / Top-down / Grid** switch on the map picks between the diamond view you see in the game (dark centre tile, buildings as raised blocks), a flat top-down view on the same diagonal, and a flat square grid. The arrow buttons next to it turn the map a quarter turn, like rotating the camera in the game. Free tiles inside the walls are dotted so empty space is easy to spot (toggle **Empty tiles**).
- Scroll (or pinch) over the map to zoom in on a part of the base; drag empty ground to pan and double-click it (or press **Reset zoom**) to see the whole map again. Traps are drawn as bright diamonds on top of everything and show their name on hover.

## Import from a screenshot
Upload up to four screenshots of your village and press **Read screenshots**. Claude counts the buildings and estimates levels from their appearance, then fills in the inventory for you to check (level numbers are not shown in a base screenshot, so treat levels as a starting point).

- On the published claude.ai artifact this uses the viewer's own Claude account; the page asks for permission the first time.
- On GitHub Pages or a local copy it asks for your own Anthropic API key (from console.anthropic.com). The key is kept only in your browser (optionally remembered in local storage) and sent only to `api.anthropic.com`. Each person who uses that copy supplies their own key.

## How it works
- `data.js` — building, trap, wall and Town Hall data (sizes, ranges, counts per TH, DPS/HP per level), generated from the `chiefpansancolt/clash-of-clans-data` dataset (wiki-derived, TH3–TH18). X-Bow footprint corrected to 3x3; Mortar minimum range 4 added.
- `optimizer.js` — picks a wall-compartment grid that fits your wall count, packs buildings into it, then runs simulated annealing against a defensive cost: fire coverage (ground and air), core protection, wall layers around key buildings, same-type defense spacing, compartment balance, splash support, outer-ring placement and sweeper placement. Traps are placed afterwards by heuristics (double giant bombs on hog paths, springs beside defenses, air traps around Air Defenses, skeleton/tornado traps at the core).
- `page.html` — the UI fragment published as the artifact; `build.py` wraps it into `index.html` for local use.

The score is a heuristic, not a simulation of attacks. Use the "What to fix" notes and the coverage heat map, then adjust by hand.
