# HD Video Grabber

A desktop app (macOS + Windows) for downloading HD/UHD videos from
YouTube and 1000+ other sites. Powered by yt-dlp + ffmpeg.

## Run in development

    npm install
    npm start

On first launch the app downloads the yt-dlp engine automatically
(no Python required). ffmpeg is bundled via the ffmpeg-static package.

## Build installers

    npm run dist:mac    # run on macOS   -> dist/*.dmg
    npm run dist:win    # run on Windows -> dist/ installer + portable exe

Build on each target OS for best results.

## Troubleshooting

- If downloads suddenly fail, open Settings and click
  "Update yt-dlp engine" (YouTube changes frequently; yt-dlp patches fast).
- For private / age-gated videos you can already access in a browser,
  enable browser cookies in Settings.
- On Windows, close Chrome before using Chrome cookies (it locks its DB).

## Legal

Only download content you own, that is public domain / Creative
Commons, or from platforms that permit downloads. Respect YouTube's
Terms of Service.
