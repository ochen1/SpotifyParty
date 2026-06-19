# SpotifyParty

SpotifyParty is a lean prototype for syncing multiple Spotify clients so separate speakers can play the same track at the same time.

The default sync service is managed at:

```text
https://spotify-party-sync.stanwithme.workers.dev
```

It includes:

- `apps/worker`: Cloudflare Worker + Durable Object room coordinator.
- `packages/core`: shared clock sync, protocol, scheduling, and adapter contracts.
- `clients/spicetify`: Spicetify extension bundle.
- `clients/tampermonkey`: Tampermonkey userscript bundle for `open.spotify.com`.

## Requirements

- Each speaker should use a separate Spotify Premium account.
- Disable crossfade/automix where possible.
- Set hardware speaker volume manually; SpotifyParty only sets Spotify player volume to max.
- Use per-speaker calibration in the panel for tight alignment.

## Commands

```sh
npm install
npm test
npm run build
npm run dev:worker
```

## Managed Sync

The Spicetify and Tampermonkey clients use the managed sync service by default. Create a room in one client, share the room code, and connect the other speakers.

## Advanced: Self-Hosted Sync

Deploy your own Worker:

```sh
npm run deploy:worker
```

Open the SpotifyParty panel, expand Advanced, switch Sync service to Self-hosted, and paste the deployed Worker URL.

## Spicetify

Build the bundle:

```sh
npm run build:clients
```

Then copy or symlink `dist/spotify-party.spicetify.js` into your Spicetify extensions directory and enable it with Spicetify.

## Tampermonkey

Build the bundle:

```sh
npm run build:clients
```

Install `dist/spotify-party.user.js` in Tampermonkey. Open `https://open.spotify.com`, start playback once if needed, and connect to a room from the SpotifyParty panel. The managed sync service is selected by default.

## Sync Model

Clients sample server clock offset with an NTP-style four-timestamp exchange. Scheduled playback is sent as server time plus track URI and position. Each client converts the target server time to local monotonic time, applies command lead compensation, starts playback, then monitors drift and hard-seeks when drift exceeds 80 ms.

Tampermonkey uses Spotify web internals and is expected to be more fragile than Spicetify.
