# Tidal-DL

`Tidal-DL` is a command-line downloader for TIDAL tracks, playlists, and music videos. It uses TIDAL device authorization, stores the local session for reuse, and downloads segmented media with `aria2c` when available or a built-in downloader when it is not.

## Features

- Download tracks in `LOW`, `HIGH`, `LOSSLESS`, and `HI_RES_LOSSLESS` quality tiers.
- Download full playlists at a selected quality.
- Download music videos after choosing from the available stream variants.
- Rename tracks using `Artist - Title` metadata.
- Optionally convert downloaded audio to MP3 with `ffmpeg`.
- Set a custom base output directory at startup.
- Use `aria2c` automatically when installed, with a native fallback otherwise.

## Requirements

- Node.js 18 or newer.
- `ffmpeg` only if you want MP3 conversion.
- `aria2c` is optional. If it is installed and available on `PATH`, the downloader will use it automatically.

## Installation

```bash
git clone https://github.com/andresdevvv/tidal-dl.git
cd tidal-dl
npm install
```

## Usage

Start the CLI with either command:

```bash
npm run startup
```

```bash
node startup.mjs
```

On first run, the app will prompt you to complete TIDAL device authentication in your browser. After authentication, the session is stored locally and reused on later runs.

If the bundled device-auth client stops working, you can provide your own auth configuration in `tidal_auth.json`:

```json
{
  "clientId": "your_client_id",
  "clientSecret": "your_client_secret",
  "scope": "r_usr w_usr w_sub",
  "sessionFile": "tidal_session.json"
}
```

You can also override the same values with environment variables:

- `TIDAL_CLIENT_ID`
- `TIDAL_CLIENT_SECRET`
- `TIDAL_SCOPE`
- `TIDAL_SESSION_FILE`

Detailed runtime logs are written to `./logs/` by default. You can override the location with `TIDAL_LOG_DIR` or `TIDAL_LOG_FILE`.

The CLI currently supports:

- Download a song
- Download a music video
- Download a playlist

You will be prompted for the TIDAL URL, quality selection, output directory, and optional rename or MP3 conversion steps where applicable.

## Output

By default, downloads are stored under `./downloads`:

- `./downloads/music`
- `./downloads/playlists/<playlist name>`
- `./downloads/videos`

## Notes

- This project is intended for personal use with content you are authorized to access through your TIDAL account.
- Respect copyright law and TIDAL's terms of service.
- Download reliability and available formats depend on TIDAL responses and stream availability.

## License

This project is licensed under the MIT License. See `LICENSE` for the full text.
