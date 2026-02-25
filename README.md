# nostria-curator

Content workspace for the Nostria Curator account:

- `npub1j2wajnnveznxv4n958slcppe2tqpfstvzu640r35xmx52y93aq5sc8rsr8`

## Structure

- `scripts/`: reusable automation scripts.
- `scripts/music/`: music newsletter helper scripts.
- `docs/articles/`: one folder per article.

## First article: Music February 2026

Article folder:

- `docs/articles/music-february-2026/`

Included files:

- `article.md`: markdown source.
- `nostr-event.unsigned.json`: unsigned long-form Nostr event template (kind `30023`) for import into Nostria.
- `data/`: generated playlist + track JSON data used as authoring input.

## Playlist fetch script

Install dependencies:

```bash
npm install
```

Run with defaults (configured for the provided playlist + relays):

```bash
npm run music:fetch
npm run music:build
npm run music:package
```

`music:fetch` and `music:build` use dedicated wrapper scripts for this specific article:

- `scripts/music/fetch-music-february-2026.ts`
- `scripts/music/build-music-february-2026.ts`

For generic fetch usage across future articles:

```bash
npm run music:fetch:generic -- \
	--playlist=nostr:naddr1... \
	--article-dir=docs/articles/my-article \
	--relays=wss://nos.lol/,wss://relay.damus.io/,wss://relay.snort.social/
```

For generic build usage across future articles:

```bash
npm run music:build:generic -- \
	--article-dir=docs/articles/my-article \
	--title="My Article" \
	--identifier=my-article \
	--curator-npub=npub1...
```

For generic package usage across future articles:

```bash
npm run music:package:generic -- \
	--article-dir=docs/articles/my-article \
	--out-zip=docs/articles/my-article/my-article.zip \
	--event-file=docs/articles/my-article/nostr-event.unsigned.json
```

The script resolves the playlist event, fetches referenced track events, and writes:

- `data/playlist-event.json`
- `data/tracks/index.json`
- `data/tracks/<event-id>.json` for each track
- `data/artists.json`
- `data/summary.json`

The normalized tracks index includes a `hasVideo` flag so article writing can mention if a track has a music video (`video` tag / media hints).

### Refreshing after playlist edits

You do **not** need to delete the full article folder.

Run:

```bash
npm run music:fetch
npm run music:build
npm run music:package
```

`music:fetch` now rewrites current track files and removes stale `data/tracks/*.json` files that are no longer in the playlist.

Then `npm run music:build` composes:

- `article.md` with full track list, `Video: Yes/No`, and `@npub...` artist mentions.
- `article-notes.md` (auto-created once, never overwritten if it already exists) for your manual editorial narrative; its content is injected into the generated article.
- `nostr-event.unsigned.json` (kind `30023`, unsigned) ready to import in Nostria's article editor.
- `data/video-screenshot-checklist.json` with only `Video: Yes` tracks and `screenshotStatus: "todo"`.
- `data/profiles.json` with outbox-model profile lookup details.
- `data/unresolved-artists.json` for artists without a resolved `kind:0` profile.

Then `npm run music:package` creates a publish zip:

- zip root always contains `event.json` (copied from configured event file)
- local image/video files from the article folder are included in a flat structure (no nested dirs)
- `data/package-manifest.json` lists source-to-zip filename mapping

Profile lookup in `music:build`:

- Reads artists' relay list events (`kind:10002`) from:
	- `wss://discovery.eu.nostria.app/`
	- `wss://indexer.coracle.social/`
- Uses each artist's outbox relays to fetch metadata profiles (`kind:0`).
- If no profile is found via outbox/indexers, falls back to `kind:0` lookup on:
	- `wss://nos.lol/`
	- `wss://relay.damus.io/`

## Chrome MCP setup (for screenshots)

This workspace includes MCP config at `.vscode/mcp.json` with a single full server:

- `chrome-devtools`: full Chrome DevTools MCP toolset.

### Prerequisites

- Chrome installed on your machine.
- Node.js + npm available (for `npx`).

### Start using it in VS Code

1. Open this workspace in VS Code.
2. Start/reload MCP servers from VS Code's MCP UI/command.
3. Ensure `chrome-devtools` is running.
4. In chat, ask to open `https://nostria.app` and capture screenshots.

### Screenshot workflow for articles

- Navigate to the target view in Nostria (e.g. music video player).
- Capture screenshots through the Chrome MCP session.
- Save screenshots inside the article folder (for example `docs/articles/music-february-2026/media/`).
- Run `npm run music:package` to generate the publish zip with:
	- `event.json`
	- local images/videos in a flat zip structure