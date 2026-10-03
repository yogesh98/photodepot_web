# Photodepot screenshots

Captured on October 1, 2026 from the actual Photodepot desktop app built from
`/Users/yogeshpatel/Developer/photodepot`. The compiled renderer, main process,
and preload were unchanged. Matching ARM native binaries were staged in a
temporary development runtime.

The isolated **Coastal weekend** project used temporary settings and a simulated
64 GB camera card with real sample JPEGs. Ingest copy, checksum verification,
analysis, ratings, folder assignments, and tags were performed by the app.
No personal projects or photos are shown.

- `ingest.png`: six verified arrivals and the completed ingest.
- `cull.png`: a picked coastal photograph rated four stars in the Cull workspace.
- `organize.png`: planned Coast / Selects folders and the Coastal tag.

Screenshots are unretouched. The website clips the macOS recording title bar
using CSS; the original captured pixels are retained here. The collaboration
diagram is an explanatory illustration of the implemented local-network workflow,
not a screenshot of connected reviewers.

## Demo photography

These sample photos were downloaded under the [Unsplash License](https://unsplash.com/license)
and appear only within the actual app screenshots.

- `COAST_0001.jpg` — [Photo by Charles Zhang on Unsplash](https://unsplash.com/photos/coastal-cliffs-overlooking-a-misty-ocean-beach-Wh2iohxCCKo)
- `COAST_0002.jpg` — [Photo by Sergei Gussev on Unsplash](https://unsplash.com/photos/coastal-landscape-with-green-cliffs-sandy-beach-and-blue-ocean-d-mvmDOs8sM)
- `COAST_0003.jpg` — [Photo by Leo_Visions on Unsplash](https://unsplash.com/photos/coastal-cliffs-overlooking-a-turquoise-ocean-with-trees-b8C7jvbyKUo)
- `COAST_0004.jpg` — [Photo by Frank on Unsplash](https://unsplash.com/photos/coastal-cliffs-meet-the-blue-ocean-under-fog-AAVt8vRAQBI)
- `COAST_0005.jpg` — [Photo by Ars M on Unsplash](https://unsplash.com/photos/misty-coastal-cliffs-overlooking-the-ocean-waves-AoNkf6YKYXs)
- `COAST_0006.jpg` — [Photo by Aivars Vilks on Unsplash](https://unsplash.com/photos/a-long-white-cliff-next-to-the-ocean-PaQkxljB9tg)

## Local AI feature close-ups — October 2, 2026

The original `ai-stacks.png`, `ai-ranking.png`, `ai-local.png`, and decision
close-ups are crops of the real Photodepot desktop app, captured in
an isolated **Local AI walkthrough** project. The app’s compiled renderer, main
process, preload, models, and native analysis were unchanged. An isolated Electron
launcher used a separate app identity and temporary settings so the user’s active
project and preferences were not affected.

Eight unchanged, licensed sample copies were ingested and analyzed by the app:
three copies each of `COAST_0001.jpg` and `COAST_0002.jpg` from the demo sources
above, and two copies of the Emiliano LG portrait used in the website hero
([Pexels source](https://www.pexels.com/photo/expressive-portrait-with-colorful-lighting-effects-30760594/)).
Filename-based duplicate comparisons allowed distinct sample filenames to ingest;
copy verification remained enabled. The app produced three stacks (3 / 3 / 2
photos) and the portrait result **Eyes appear open**. These repeated samples
illustrate the actual interface; they are not evidence of relative quality in a
real photographic burst.

- `ai-stacks.png`: the actual Scenes and Rank columns after automatic grouping.
- `ai-ranking.png`: the portrait’s real Close-ups / Eyes appear open result.
- `ai-local.png`: the Cull settings / Saved on this Mac message, captured using
  the app’s normal View zoom controls, used as a tighter crop on phones.
- `ai-local-context.png`: the complete Cull settings description and Scene
  grouping context from the same capture. Offline and bundled-model behavior is
  explained in the accompanying website copy; the app has no dedicated offline
  model status indicator.
- `ai-decisions.png`: the Scene menu with cover, split, merge, and unstack actions.
  Merge is disabled in this capture because only one scene is selected.
- `ai-decision-toolbar.png`: real pick, reject, unflag, and star controls; the
  sample portrait was picked and rated four stars using the app.

Original full-window captures and exact crop rectangles are retained in
`local-ai-source/`. No interface text, results, photos, or controls were retouched
or synthesized. The website scales and clips the crops to keep feature details
readable. The historical decisions slide shows the menu and toolbar as separate
close-ups.

## Wedding feature animations — October 2, 2026

The four `ai-*.gif` animations use new full-window captures from the same isolated
app runtime and **Local AI walkthrough** project, populated with 32 unique
photographs by [Emma Bauso on Pexels](https://www.pexels.com/@emma-bauso-1183828/).
The source includes wedding preparations, ceremony, portraits, venue details,
and a few couple-session photographs. It is not claimed to be one verified
wedding. Related-event groupings are visual inferences from matching attire,
setting, and composition; event dates were not independently verified.

Photo IDs, photographer attribution, original photo-page and CDN URLs,
downloaded dimensions, checksums, and the [Pexels License](https://www.pexels.com/license/)
are retained in `local-ai-source/wedding-sources.json`. JPEGs were downloaded as
served by Pexels at 1200 pixels wide. No duplicated photos, visual edits, or
synthetic capture dates were created for this set. All 32 photographs were
ingested, verified, and analyzed by the actual app.

- `ai-stacks.gif`: 32 items produced 31 Scenes. The selected two-photo Scene 20
  contains Pexels photos 2253867 and 2253868, a color and black-and-white wedding
  composition published as distinct source photos. The app grouped them through
  **DINOv2 similarity · neighboring original filenames**. This is a real grouping
  result, not a benchmark or a manually forced stack.
- `ai-ranking.gif`: the groom photo 2253851 shows the app's qualified **Possible
  closed eyes** estimate in the Close-ups inspector. The result was not altered
  or promoted to a definite classification.
- `ai-local.gif`: the wide view shows native Cull settings over the populated
  workspace, then zooms into the real **Cull settings / Saved on this Mac**
  description. A tighter final view makes those words readable on phones.
  This message describes local settings; bundled, offline model behavior is
  substantiated by the app source and documentation, not a fabricated status
  indicator in the screenshot.
- `ai-decisions.gif`: zooms into the real Scene menu, then pans to Pick, Reject,
  Unflag, and star controls. The selected photo 2253867 was picked and rated four
  stars using the app. Merge remains disabled because only one scene is selected.

The unchanged native full-window captures are retained as
`local-ai-source/ai-*-wedding-full.png`, separately from the historical source
captures and `crops.json`. Native screenshot bytes were losslessly decoded to
PNG; no interface, result, photo, or control was retouched or synthesized.

`local-ai-source/generate_ai_gifs.py` and `animation-manifest.json` reproduce the
animations using Pillow. Camera crops preserve the 32:21 aspect ratio and use
only pixels from each original capture. GIF encoding resamples the frames and
quantizes colors; sampled native selection/white colors are preserved in the
palette. The GIFs are 768 × 504 at 10 motion frames per second. They hold the wide
view for 1.5 seconds, ease into the detail over 1.5 seconds, hold, and ease back
over 1 second. Local settings and decisions include a second camera move.

Full-color `ai-*-poster.png` stills are 960 × 630 for reduced-motion preferences.
They match the first detail hold, except the local
settings poster uses the tighter second focus so **Saved on this Mac** remains
readable on phones. The chosen poster stage is recorded in the manifest.
Exact crop rectangles, timings, source checksums, encoded frame counts, color counts, and sizes are
recorded in `local-ai-source/animation-manifest.json` and `animation-report.json`.
