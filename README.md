# Scribe

Record meetings on your phone and get a transcript, like Otter, except everything runs on the phone. Nothing you record is uploaded anywhere. The only network use is a one-time download of the speech model from huggingface.co.

## What it does

- Records audio with a live waveform and timer.
- Shows captions a few seconds behind the speaker while recording.
- Flag button to mark important moments.
- Saves every recording on the phone with its transcript, searchable, with playback.
- Tap a timestamp to jump the audio to that moment.
- Edit transcript text, rename, delete.
- Export as text, Markdown or subtitles (.srt), or copy and share.
- Import an existing voice memo or audio file and transcribe it.
- Re-transcribe a recording with a different model.
- Recovers a recording if the app is closed or killed mid-session.
- Works offline once the model is downloaded.

## Limits you should know about

- Phones pause web apps when the screen locks or you switch apps. Keep the screen on while recording. The app asks the phone to stay awake, and warns you if it was in the background.
- No speaker labels (who said what). That needs a heavier engine than a phone browser can run.
- English only (the models used are the English ones).
- Speed depends on the phone. Base is the recommended model. Small is slow and may not work on older phones.
- Not yet tested on real phone hardware. Tested in headless Chromium at phone size, including offline use, import, export, playback seeking and crash recovery.
- iPhone: install it to the Home Screen. Safari clears storage for sites you have not opened for a week, but installed apps are exempt.

## Put it online (GitHub Pages)

1. Create the repository: https://github.com/new (name it `scribe-app`, Public, tick "Add a README file").
2. Upload the files: https://github.com/jcookeinv/scribe-app/upload/main
   Drag in everything from this folder, including the `vendor` folder, then commit.
3. Turn on Pages: https://github.com/jcookeinv/scribe-app/settings/pages
   Source: Deploy from a branch. Branch: main, folder: / (root). Save.
4. After a minute or two open https://jcookeinv.github.io/scribe-app/ on your phone.
5. Install it. iPhone: Share, then Add to Home Screen. Android: Chrome menu, then Install app.
6. Open Settings in the app and tap "Download selected model now" while on Wi-Fi.

## Updating later

Upload the changed files the same way. When any app file changes, edit `VERSION` at the top of `sw.js` (for example `scribe-v2`) so phones pick up the new files.

## Files

- `index.html`, `app.js`: the app.
- `worker.js`: runs the speech model in the background so the screen stays smooth.
- `pcm-tap.js`: reads microphone audio.
- `sw.js`, `manifest.webmanifest`, icons: make it installable and offline.
- `vendor/`: the speech engine (transformers.js 4.3.1 and onnxruntime-web 1.31.0-dev.20260914), stored here so the app does not depend on any outside server.
