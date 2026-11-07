<p align="center"><img src="build/icon.png" width="96" alt=""></p>

<h1 align="center">Rawcut</h1>

<p align="center"><b>Record your screen. Your own AI edits it, using real footage.</b><br>
Free and open source. Bring your own AI: Claude Code, Codex, Ollama, or any API key.<br>
Real b-roll, real memes, real sound effects. <b>Nothing AI-generated.</b></p>

---

Rawcut watches and listens to your **whole** recording before it touches anything. It works out what the video is about, which moments matter and where the dead air is, and only then edits. It cuts pauses and retakes, zooms in on the important parts, and adds **real** media from the internet: stock footage, archive photos, real meme templates, real reaction GIFs and recorded sound effects.

- 💸 **No subscription, no credits, no account.** Connect an AI you already have.
- 🔒 **Runs on your computer.** Your video never gets uploaded. Only the transcript and a few still frames go to the AI you pick, and with Ollama even those stay local.
- 🎞️ **No AI slop.** All media comes from Pexels, Pixabay, Wikimedia Commons, Openverse, Imgflip, GIPHY and Freesound.

## Download

Grab the installer for your system from **[Releases](../../releases/latest)**:

| System | File |
| --- | --- |
| macOS (Apple Silicon / Intel) | `Rawcut-x.y.z-arm64.dmg` / `Rawcut-x.y.z.dmg` |
| Windows 10/11 | `Rawcut-Setup-x.y.z.exe` |
| Linux | `Rawcut-x.y.z.AppImage` or `.deb` |

Everything you need is built in, including ffmpeg and speech-to-text, so there's nothing else to install.

> **First launch on macOS:** the app isn't notarized by Apple yet, so right-click → **Open** → **Open**. To record the screen, allow Rawcut in *System Settings → Privacy & Security → Screen Recording*.
> **Windows:** if SmartScreen appears, click *More info → Run anyway*.

### Or run it with Node (any OS)

```bash
git clone <this repo> rawcut && cd rawcut
npm install
npm start          # opens http://localhost:4777 in your browser
```
Use Chrome, Edge, Arc or Brave. Screen capture uses the browser's own picker.

## Connect an AI (pick one, about 1 minute)

Open **Settings → Editing brain**, pick one, then press **Test connection**.

| Brain | Cost | Setup |
| --- | --- | --- |
| **Claude Code** | Uses your Claude plan | `npm i -g @anthropic-ai/claude-code`, then run `claude` once to log in |
| **Codex CLI** | Uses your ChatGPT plan | `npm i -g @openai/codex`, then run `codex` once to log in |
| **Ollama** | Free, 100% local | Install from [ollama.com](https://ollama.com), then `ollama pull qwen2.5vl` |
| **Anthropic API** | Your key | Paste your key from console.anthropic.com |
| **OpenAI-compatible** | Your key | OpenAI, OpenRouter, Groq, Together, LM Studio… paste the base URL + key |
| **Custom CLI** | Whatever it costs | Any command that reads a prompt on stdin, e.g. `gemini -p` |

Use a model that can see images (Claude, GPT-4o, Gemini, qwen2.5vl, llama3.2-vision) so the AI can look at your screen. Bigger models plan better edits.

### Optional: better media (free keys)

Rawcut works with no keys at all, using Wikimedia Commons, Openverse and Imgflip. Free keys make b-roll, GIFs and sound effects much better. Paste them in **Settings → Real media sources**:
[Pexels](https://www.pexels.com/api/) · [Pixabay](https://pixabay.com/api/docs/) · [GIPHY](https://developers.giphy.com/dashboard/) · [Freesound](https://freesound.org/apiv2/apply)

## How it edits: watch first, then edit

1. **Listen.** A word-by-word transcript is made on your computer (built-in Whisper, or whisper.cpp if you have it), and the real pauses are measured.
2. **Watch.** Rawcut finds scene changes and samples frames across the whole video for the AI to look at.
3. **Understand.** The AI writes a summary and splits the video into sections. It marks must-see moments, on-screen details you need to read, dead air and moments that could be funny. You can see all of this in the editor.
4. **Plan.** The AI proposes cuts, zooms, b-roll, memes and sound effects, each with a reason.
5. **Guard rails (in code, not just prompts).** The AI can't make a mess:
   - no cutting mid-word
   - it can't remove more than 40% of what you said
   - full-screen b-roll never covers a must-see moment (it becomes picture-in-picture instead)
   - overlays never stack
   - a cap on edits per minute, based on the style you pick (subtle, balanced or heavy)
6. **Find real media.** Every b-roll clip, meme and sound comes from a real source, and you can swap or re-search any of them.
7. **Render.** ffmpeg renders on your computer, with word-by-word captions.

Then just talk to it: *"more memes"*, *"cut the intro"*, *"b-roll of Tokyo at 0:42"*.

## Build the desktop app yourself

```bash
npm install
npm run app          # run the desktop app in dev mode
npm run dist         # build an installer for your OS into ./dist
```
Pushing a tag like `v1.0.1` makes GitHub Actions build the macOS, Windows and Linux installers and attach them to a Release (`.github/workflows/release.yml`).

## Project layout

```
server.js          local API (only accepts requests from this computer)
lib/brain.js       understanding, planning and the guard rails
lib/media.js       real-media search (Pexels, Pixabay, Wikimedia, Openverse, Imgflip, GIPHY, Freesound)
lib/llm.js         all the AI "brains"
lib/transcribe.js  built-in Whisper / whisper.cpp / Whisper API
lib/ffmpeg.js      analysis + rendering
public/            the app UI (plain JS, no build step)
electron/          desktop app wrapper
```

Your data (settings, projects, renders) is stored in `./data` when you run with Node, or in the app's own data folder for the desktop app.

## Media licenses

Rawcut shows the source of every clip it uses. Pexels and Pixabay media is free to use. Wikimedia and Openverse items carry their own Creative Commons licenses, and memes and GIFs fall under each platform's terms. Check the credits before you publish anything commercial.

## Contributing

PRs welcome. Good first issues: more media sources, more caption styles, a vertical (9:16) export, and better local-model prompts.

MIT licensed.
