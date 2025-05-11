# Tidal-DL 🌊🎵🎬

Download music tracks and music videos directly from Tidal.

---

`Tidal-DL` is a command-line interface (CLI) tool that allows you to download your music and music videos from Tidal. It authenticates with your Tidal account using a secure device authorization flow and saves your session for future use.

## ✨ Features

*   **Song Downloads:**
    *   Choose from available audio qualities:
        *   Standard (AAC 96 kbps)
        *   High (AAC 320 kbps)
        *   HiFi (CD Quality FLAC 16-bit/44.1kHz - Lossless)
        *   Max (HiRes FLAC up to 24-bit/192kHz - Lossless)
    *   Downloads are saved as `.flac` files.
    *   Automatic renaming to `Artist - Title.flac` (with confirmation) based on metadata fetched from Tidal.
*   **Music Video Downloads:**
    *   Lists available video resolutions and bandwidths for you to select the best option.
    *   Downloads are saved as `.ts` files.
    *   Attempts to name files using the video title scraped from the Tidal page.
*   **Efficient Downloads:** Utilizes `aria2c` for fast, resumable, and segmented downloading.
*   **Authentication:** Secure OAuth2 device login. Session details (including access and refresh tokens) are stored locally in `tidal_session.json` for persistence, reducing the need to log in repeatedly.
*   **Interactive CLI:** A user-friendly command-line interface guides you through the selection and download process.

## 🚀 Prerequisites

Before you begin, ensure you have the following installed on your system:

1.  **Node.js:** A recent LTS version (e.g., v18.x, v20.x, or newer). You can download it from [nodejs.org](https://nodejs.org/).
2.  **aria2c:** This is a **critical dependency** for the download process.
    *   Official website: [aria2.github.io](https://aria2.github.io/)
    *   Ensure `aria2c` is installed and accessible from your system's PATH (i.e., you can run `aria2c --version` in your terminal).

## 🛠️ Setup

1.  **Clone the repository:**
    If you're downloading this from GitHub, you've likely already done this or downloaded the source. If not:
    ```bash
    git clone https://github.com/andresdevvv/tidal-dl.git
    cd tidal-dl
    ```

2.  **Install dependencies:**
    Navigate to the project's root directory in your terminal and run:
    ```bash
    npm install
    ```
    This will install `axios`, `xml2js`.

## ⚙️ How to Use

1.  **Run the script:**
    Open your terminal in the `Tidal-DL` project directory and execute:
    ```bash
    node run startup
    ```

2.  **First-Time Authentication:**
    *   On your first run, the script will guide you through the Tidal authentication process.
    *   You will see a message like this:
        ```
        ---------------------------------------------------------------------
         TIDAL DEVICE AUTHENTICATION REQUIRED
        ---------------------------------------------------------------------
        1. Open your web browser and go to: https://link.tidal.com/XXXXX
        2. Enter the following code: YOUR_USER_CODE if asked
        ---------------------------------------------------------------------

        Waiting for authorization (this may take a moment)...
        ```
    *   Open the provided URL (e.g., `https://link.tidal.com/XXXXX`) in your web browser.
    *   Enter the user code (e.g., `YOUR_USER_CODE`) on the Tidal website if prompted.
    *   Authorize the application in your browser.
    *   Once authorized, the script will automatically detect it, complete the login, and save your session details to `tidal_session.json`. Future runs will attempt to use this saved session.

3.  **Download Process:**
    *   After successful authentication, the main menu will appear:
        ```
        What would you like to do?
          1. Download a Song
          2. Download a Music Video
          3. Exit
        Enter your choice (1-3):
        ```
    *   Enter your choice (`1` for a song, `2` for a video).
    *   **Provide URL:** Paste the full Tidal URL for the song or music video you want to download.
        *   **Song URL Examples:**
            *   `https://tidal.com/browse/track/12345678`
            *   `https://tidal.com/track/12345678`
            *   `https://tidal.com/u/SOME_USER_ID/track/12345678` (shared links)
        *   **Video URL Example:**
            *   `https://tidal.com/browse/video/87654321`
    *   The script will extract the ID from the URL.
    *   **Select Quality:**
        *   **For Songs:** You'll be presented with a list of available audio qualities (Standard, High, HiFi, Max). Select your preferred quality.
        *   **For Music Videos:** The script will fetch available video streams and list them by resolution and bandwidth (best first). Select your preferred stream.
    *   **File Naming Confirmation (Optional):**
        *   **For Songs:** If metadata (artist, title) is successfully fetched, you'll be asked: `Do you want to rename the file based on Artist - Title? (yes/no):`.
        *   **For Music Videos:** If a title is successfully scraped from the Tidal page, you might be asked: `Use "Scraped Video Title.ts" as filename? (y/n):`.
    *   **Download:** The download will start. `aria2c` handles the actual downloading of segments, which are then combined into the final file.

4.  **Output Location:**
    *   Downloaded songs are saved in the `./downloads/music/` directory relative to where you run the script.
    *   Downloaded music videos are saved in the `./downloads/videos/` directory.

## 📁 File Structure Overview

```
Tidal-DL/
├── downloads/              # Default directory for all downloaded files
│   ├── music/              # Stores downloaded songs (.flac)
│   └── videos/             # Stores downloaded music videos (.ts)
├── node_modules/           # Project dependencies (created by `npm install`)
├── v2/                     # Core logic modules
│   ├── login.mjs           # Handles Tidal authentication & session management
│   ├── music.js            # Logic for music track downloads
│   └── video.js            # Logic for music video downloads
├── .gitignore              # Specifies intentionally untracked files for Git
├── package-lock.json       # Records exact versions of installed dependencies
├── package.json            # Project metadata and list of dependencies
├── startup.mjs             # The main executable script (CLI entry point)
└── tidal_session.json      # Stores your Tidal login session data (created after first login)
```

## ⚠️ Important Notes

*   **`aria2c` is Essential:** This tool **will not work** if `aria2c` is not installed or not correctly configured in your system's PATH.
*   **For Personal Use Only:** This tool is intended for personal, private use, such as backing up music and videos you have legitimate access to via your Tidal subscription.
*   **Respect Copyright:** Always respect copyright laws and Tidal's Terms of Service. Downloading and distributing copyrighted material without authorization may be illegal. The developers of this tool are not responsible for its misuse.
*   **API Rate Limiting:** While the script includes some retry mechanisms, excessive or rapid use might lead to temporary rate limiting by Tidal's API. Use the tool reasonably.

## 📄 License

Copyright (c) 2025 AndresDevvv

This project is licensed under the terms of the **GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.**

A copy of the AGPL-3.0 license is included in the file `LICENSE` in the root of this repository. You can also find the full text of the license online at:
[https://www.gnu.org/licenses/agpl-3.0.html](https://www.gnu.org/licenses/agpl-3.0.html)

---

Happy Downloading!