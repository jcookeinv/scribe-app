# Scribe

Record meetings on your phone and get a transcript, like Otter, except everything runs on the phone. Nothing you record is uploaded anywhere. The only network use is a one-time download of the speech model and the voice model from huggingface.co.

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
- Tells speakers apart. Sentences are grouped into paragraphs per speaker (Speaker 1, Speaker 2 and so on), live while recording and in the saved transcript. A short pause no longer starts a new line.
- Tap a name on a paragraph to fix it or rename that speaker. The Speakers button renames everyone or sets the number of speakers if the automatic count is wrong.
- Older recordings that kept their audio can be sorted afterwards with Find speakers.
- Exports include speaker names.
- Meeting notes: tap Meeting notes on a recording for a minutes-style breakdown (summary, topics through the conversation, decisions, action items with owner and date where said, questions raised, numbers and dates, a section per speaker, flagged moments). The original transcript stays untouched, one tap away on the Transcript button.
- Export the notes as Markdown or text, or the notes and full transcript together. There is also a button that copies the transcript with a ready-made request for minutes, to paste into an AI chat if you want a polished write-up. That is the only route that sends text anywhere, and only if you paste it.
- Recovers a recording if the app is closed or killed mid-session.
- Works offline once the model is downloaded.

## Limits you should know about

- Phones pause web apps when the screen locks or you switch apps. Keep the screen on while recording. The app asks the phone to stay awake, and warns you if it was in the background.
- Speaker recognition compares voice fingerprints, so it is good but not perfect. It struggles with noisy rooms, people talking over each other and very short interjections ("yes", "right"). If the count is off, use Speakers, then Set the number of speakers.
- Meeting notes are built by picking out and sorting sentences that were actually said. They are not rewritten, so they read like extracts rather than polished prose, and can miss or over-pick action items. Check them against the transcript.
- Speaker changes are placed at sentence and pause boundaries, so a change in the middle of a sentence is not caught.
- Speaker recognition adds a little processing time. It can be switched off in Settings.
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
6. Open Settings in the app and tap "Download selected model now" while on Wi-Fi. This also fetches the voice model (about 7 MB).

## Updating later

Upload the changed files the same way. When any app file changes, edit `VERSION` at the top of `sw.js` (currently `scribe-v3`, so use `scribe-v4` next) so phones pick up the new files.

## Files

- `index.html`, `app.js`: the app.
- `worker.js`: runs the speech model and voice model in the background so the screen stays smooth.
- `speakers.js`: pause finding, voice clustering and paragraph grouping.
- `notes.js`: builds the meeting notes.
- `pcm-tap.js`: reads microphone audio.
- `sw.js`, `manifest.webmanifest`, icons: make it installable and offline.
- `vendor/`: the speech engine (transformers.js 4.3.1 and onnxruntime-web 1.31.0-dev.20260914), stored here so the app does not depend on any outside server.

## Credits

Speaker fingerprints use the WeSpeaker ResNet34-LM model (trained on VoxCeleb), ONNX version `onnx-community/wespeaker-voxceleb-resnet34-LM` from huggingface.co. Transcription uses Whisper via transformers.js.
