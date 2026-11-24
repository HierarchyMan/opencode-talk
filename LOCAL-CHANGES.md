# Inline voice input fork

This fork of `hdlopesrocha/opencode-talk` adds inline composer dictation in the
OpenCode TUI and Windows DirectShow microphone discovery via FFmpeg.

To load a local checkout in OpenCode without auto-updates, point
`~/.config/opencode/cli.json` at the checkout path under `plugins`.

To install development dependencies on Windows without downloading the
optional local Whisper and text-to-speech engines:

```powershell
$env:OPENCODE_VOICE_SKIP_SETUP = "1"
npm ci
```

The voice-focused tests can be run with:

```powershell
npm run typecheck
npx vitest run tests/voice-tui-english.test.ts tests/voice-recorder.test.ts tests/voice-commands.test.ts tests/voice-speech.test.ts
npx tsx scripts/smoke.mts
```

The upstream full test suite includes remote-control tests that assume Unix
file permissions and process behavior; those tests fail on Windows.

In the terminal UI, type `/voice` followed by a space to start recording.
Space or Enter stops and transcribes; Escape cancels without transcribing.
A blinking red dot in the prompt footer marks microphone capture. These keys
also work while the microphone is opening. The trigger works inside a draft. You can
also use the configured voice shortcut (`Ctrl+X`, then `V` by default).
The transcript is inserted at the current cursor and is never sent by voice
input. Wait for “Recording…” before speaking.

Voice input is enabled by default. Type `/voice-toggle` followed by a space
anywhere in a draft, or run `/voice-toggle` as a slash command, to disable or
re-enable it. The choice persists across restarts and is shared across TUI
windows. While disabled, `/voice` is ordinary text and its shortcut is
inactive. Disabling voice cancels an active recording or transcription.

If the original prompt is unavailable when transcription finishes, the text is
held in memory rather than inserted into a different prompt. Return to the
original prompt and run **Voice: insert held transcript** from the command
palette. Held text does not survive closing or reloading the plugin.

OpenCode 2.4.1 does not expose a supported composer API. `src/composer.ts`
isolates the adapter to its focused prompt editor. The adapter checks the
editor's identity and refuses to edit unrelated inputs; it may need adjustment
after an OpenCode update.
