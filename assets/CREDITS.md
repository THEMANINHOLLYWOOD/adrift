# Adrift: third-party assets

Every file in this folder was made from a CC0 1.0 (public domain) original. CC0 needs no attribution; it is given anyway.
Each licence was checked on the asset's own page before downloading (2026-11-17).

The originals were processed offline before shipping:
- Models (Quaternius, via Poly Pizza): restyled to Adrift's watercolour palette (flat vertex colours, or the model's own painted textures washed
  to the palette), normalised in size and origin, the palm split into `trunk` and `crown` so the wind shader can bend it, and the
  animals' skinned clips (Walk / Swim) baked into four key frames stored as morph targets (no skeleton, no textures).
- Textures (Poly Haven): resized to 512 px; the colour map turned into a grey high-passed detail map (`_d`) so the game keeps its
  own colours; normal maps (`_n`, OpenGL convention) resized only. The leaf texture was recoloured to the island greens.

| Shipped file | Source page | Author | Licence | Original | Shipped |
|---|---|---|---|---|---|
| models/palm.glb | https://poly.pizza/m/VYslw9DEi6 (Palm Trees, tree 1 of 5) | Quaternius | CC0 1.0 | 1,120,784 B (GLB with 2 textures) | 21,628 B |
| tex/palm_bark.jpg | same Palm Trees (its bark texture, washed to the palette, 256 px) | Quaternius | CC0 1.0 | (inside the GLB above) | 8,204 B |
| tex/palm_fronds.png | same Palm Trees (its cut-out frond texture, washed to the palette, 512 px) | Quaternius | CC0 1.0 | (inside the GLB above) | 60,185 B |
| models/bush.glb | https://poly.pizza/m/ooG6CkLyE8 (Bush) | Quaternius | CC0 1.0 | 131,172 B (GLB incl. leaf texture) | 14,524 B |
| tex/leaves.png | same Bush as above (its leaf texture, recoloured, 256 px) | Quaternius | CC0 1.0 | (inside the GLB above) | 41,936 B |
| models/rock.glb | https://poly.pizza/m/KZdEP3uUpa (Rock Medium) | Quaternius | CC0 1.0 | 1,060,940 B (GLB + 1K texture) | 11,368 B |
| models/deer.glb | https://poly.pizza/m/T6Cs7tmMHJ (Deer, animated) | Quaternius | CC0 1.0 | 1,007,564 B | 322,348 B |
| models/pig.glb | https://poly.pizza/m/TNvG3QUFlp (Pig) | Quaternius | CC0 1.0 | 159,724 B | 46,072 B |
| models/fish.glb | https://poly.pizza/m/XWl86YFtpF (Fish, animated) | Quaternius | CC0 1.0 | 70,268 B | 86,576 B |
| models/dolphin.glb | https://poly.pizza/m/3LzFgI3GLO (Dolphin) | Quaternius | CC0 1.0 | 60,412 B | 66,832 B |
| models/shark.glb | https://poly.pizza/m/AyHTK3zUSG (Shark, animated) | Quaternius | CC0 1.0 | 77,732 B | 96,216 B |
| models/whale.glb | https://poly.pizza/m/JGFwp6xWgk (Whale) | Quaternius | CC0 1.0 | 68,764 B | 70,960 B |
| tex/sand_d.jpg, tex/sand_n.jpg | https://polyhaven.com/a/aerial_beach_01 (Aerial Beach 01) | Rob Tuytel | CC0 | 115,382 B + 262,878 B (1K diffuse + normal JPG) | 114,421 B + 127,398 B |
| tex/grass_d.jpg, tex/grass_n.jpg | https://polyhaven.com/a/leafy_grass (Leafy Grass) | Charlotte Baglioni | CC0 | 1,195,394 B + 1,466,049 B | 132,877 B + 224,279 B |
| tex/rock_d.jpg | https://polyhaven.com/a/mossy_rock (Mossy Rock) | Rob Tuytel | CC0 | 1,124,438 B (1K diffuse JPG) | 115,257 B |
| tex/wood_d.jpg | https://polyhaven.com/a/weathered_brown_planks (Weathered Brown Planks) | Dimitrios Savva, Rico Cilliers | CC0 | 226,049 B (1K diffuse JPG) | 100,573 B |

Total shipped: about 1.66 MB. Poly Haven licence: https://polyhaven.com/license ("Our assets are all licensed as CC0").
Poly Pizza model pages state "CC0 1.0" and the creator Quaternius (https://quaternius.com).

Loading: `assetsLoad()` in the game module fetches these after the start; until they arrive, and whenever one fails or the device is on
a low tier (`?noassets`, data saver, 2 GB or less of memory), the hand-made shapes and procedural surfaces stay in place.
