# Clash Base Optimizer

Lays out a Clash of Clans Home Village for defense from your Town Hall level, building counts and levels.

## Use it
- Open `index.html` in a browser (no server needed), or use the published artifact link.
- Pick your Town Hall, choose War/Trophy, Farming or Hybrid, adjust counts and levels (blank = max for your TH; one number = all; a list like `14,14,13,12` = per building), then press **Optimize base**.
- Drag any building on the map to tweak it; the score and notes recompute. The inventory and last layout are saved in your browser.

## How it works
- `data.js` — building, trap, wall and Town Hall data (sizes, ranges, counts per TH, DPS/HP per level), generated from the `chiefpansancolt/clash-of-clans-data` dataset (wiki-derived, TH3–TH18). X-Bow footprint corrected to 3x3; Mortar minimum range 4 added.
- `optimizer.js` — picks a wall-compartment grid that fits your wall count, packs buildings into it, then runs simulated annealing against a defensive cost: fire coverage (ground and air), core protection, wall layers around key buildings, same-type defense spacing, compartment balance, splash support, outer-ring placement and sweeper placement. Traps are placed afterwards by heuristics (double giant bombs on hog paths, springs beside defenses, air traps around Air Defenses, skeleton/tornado traps at the core).
- `page.html` — the UI fragment published as the artifact; `build.py` wraps it into `index.html` for local use.

The score is a heuristic, not a simulation of attacks. Use the "What to fix" notes and the coverage heat map, then adjust by hand.
