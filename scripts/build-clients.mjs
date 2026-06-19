import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import packageJson from "../package.json" with { type: "json" };

await mkdir("dist", { recursive: true });

const userscriptUrl = "https://raw.githubusercontent.com/ochen1/SpotifyParty/main/dist/spotify-party.user.js";

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120", "firefox120"],
  sourcemap: true,
  minify: false,
  legalComments: "none"
};

await build({
  ...common,
  entryPoints: ["clients/spicetify/src/index.ts"],
  outfile: "dist/spotify-party.spicetify.js",
  banner: {
    js: "/* SpotifyParty Spicetify extension */"
  }
});

await build({
  ...common,
  entryPoints: ["clients/tampermonkey/src/index.ts"],
  outfile: "dist/spotify-party.user.js",
  banner: {
    js: `// ==UserScript==
// @name         SpotifyParty
// @namespace    https://github.com/local/spotify-party
// @version      ${packageJson.version}
// @description  Sync Spotify web playback with SpotifyParty rooms.
// @match        https://open.spotify.com/*
// @homepageURL  https://github.com/ochen1/SpotifyParty
// @downloadURL  ${userscriptUrl}
// @updateURL    ${userscriptUrl}
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// ==/UserScript==`
  }
});

console.log("Built dist/spotify-party.spicetify.js and dist/spotify-party.user.js");
