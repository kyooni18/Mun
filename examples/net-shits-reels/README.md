# Memes (Mün)

A minimal local swipe-to-next feed, not a video editor. The app is built with the actual Mün `@mun/core` view/state API and `@mun/web` renderer.

The app is managed by the `local.memes.web` launchd job in `~/local-services/`. It starts at login and runs through the dedicated production Node server, not Vite's development server. Double-click `start.command` to open it, or use:

```sh
~/.local/bin/local-services status
~/.local/bin/local-services logs memes
```

For *development*, stop the managed Memes job first or choose a different port; the normal `pnpm exec vite --config examples/net-shits-reels/vite.config.ts` command also uses port 3133. The service builds the UI on launch, then serves the build and exported media through `examples/net-shits-reels/server.mjs`.

Then visit http://127.0.0.1:3133/. For an original-versus-current design comparison, open http://127.0.0.1:3133/compare.html. The left half is a preserved screenshot from before the UI guideline; the right half is a live view of the current app. The server is loopback-only and never uploads photos or edits the Photos library. Its source is the exported copies at `~/Movies/NetShitsShorts/assets/` (445 files, seven albums). `NETSHITS_MEDIA_DIR` overrides this location. Converted posters and MOV playback proxies are generated on demand and cached in `~/Movies/NetShitsShorts/.reels-cache/`.

The design follows `General Interface Guideline.md`: content-first hierarchy, a restrained neutral palette, straightforward album navigation, consistent controls, and no redundant status/metadata decorations. **No filenames are rendered in the interface, image alt text, queue, or the client JSON manifest.** Album names are exactly Star Wars, IT, CATS, Aerospace, Western, Eastern, and KSP; the underlying source folder names remain unchanged. Neither the UI nor the JSON endpoint exposes item counts or filenames. The historical screenshot on the comparison page is deliberately unmodified, including its older labels and counters.

The full feed is freshly and uniformly randomized on each page load and on pressing Shuffle using a crypto-backed Fisher–Yates permutation (no featured items, category rotation, chronological bias, or seeded order). Album filtering preserves the uniformly randomized relative order. On desktop use the album sidebar; on mobile open the album picker in the upper right. The original translucent circular controls float directly over the video again, rather than sitting in a separate footer. The native video is never cropped, zoomed, shortened or auto-skipped: `object-fit: contain` and native loop playback preserve the full frame and duration. In landscape orientation (desktops and rotated phones >=600px wide), the video stage uses the available width, and the selected collection title and Shuffle control live in the left sidebar instead of above the video. This prevents wide videos being confined to a phone-sized column. The app does not display the archive title. Videos autoplay muted, and only the active item and its immediate neighbors have loaded media elements. Use vertical swipe/scroll or the keyboard to move between cards. Favorites stay in browser `localStorage`, including after a reload. Videos have a native, accessible timeline at the bottom: drag/tap the scrubber, or focus it and press Left/Right for fine seeking. Pressing Space/P/M/L continues to work with the scrubber focused, while its own arrow keys keep their standard seek behavior. Controls on the reel are translucent circles with accessible labels: save, mute, pause/play, and open the original exported copy.

Keyboard: `↓` / `J` / `Space` next, `↑` / `K` previous, `M` sound, `P` play/pause, `L` save, `Home` / `End` first/last, `Esc` closes the album picker.

Check the project while the server is running:

```sh
cd ~/Code/Mun
pnpm exec tsc --noEmit -p examples/net-shits-reels/tsconfig.json
node examples/net-shits-reels/smoke.mjs
node examples/net-shits-reels/autoplay-regression.mjs
pnpm exec vite build --config examples/net-shits-reels/vite.config.ts
```

Video autoplay is retried after DOM mounting, metadata/can-play events, transient `play()` rejection, tab visibility/focus changes, and interrupted startup. Sound autoplay rejection automatically falls back to muted playback. After bounded failures the active reel offers a direct tap-to-play button, without changing its clip duration or altering the user's favorites.
