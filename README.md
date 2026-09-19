# Background ❤️ Tube

Lightweight mobile-first music discovery app.

- **Search** uses the official [YouTube Data API v3](https://developers.google.com/youtube/v3) through a server proxy. The API key never reaches the browser.
- **Playback** uses only the official [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference). Media always streams from YouTube. Nothing is downloaded, ripped, cached as audio, or redistributed.

## Screens

Home · Search · Library · Settings, plus a full player overlay and a persistent mini player above the bottom navigation.

## Version 1 rules

- Listeners do not create or paste a YouTube API key.
- Listeners do not sign in with Google for basic search and playback.
- The operator sets `YOUTUBE_API_KEY` on the server.
- Google passwords are never requested or stored.
- OAuth and cloud playlist sync can be added later without rewriting UI, storage, or playback modules.

## Background playback

Official IFrame embeds do **not** keep playing after most mobile browsers suspend the tab. This app does not work around that restriction. Settings and the player explain the limit. Media Session metadata is published so lock-screen controls can appear *while the page is still active* and the browser allows it.

## Architecture

```
server.js                 Express + YouTube Data API proxy
public/js/api.js          Client API wrapper
public/js/player.js       IFrame Player + queue + Media Session
public/js/library.js      Favorites, history, local playlists, queue snapshot
public/js/storage.js      localStorage boundary
public/js/settings.js     Preferences
public/js/ui.js           Screens and events
```

## Run

```bash
cp .env.example .env
# set YOUTUBE_API_KEY in .env
npm install
npm test
npm start
```

Open `http://localhost:3000`.

## Compliance

- No scraping, ytdl, or unofficial extractors.
- No media download or conversion.
- YouTube Terms: https://www.youtube.com/t/terms
- API Services Terms: https://developers.google.com/youtube/terms/api-services-terms-of-service
- Google Privacy Policy: https://www.google.com/policies/privacy
