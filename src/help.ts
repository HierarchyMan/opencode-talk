/** Usage text shown by `/mic help` and `/sound help` (TUI dialog / server log). */

export const MIC_HELP = [
  "Microphone commands:",
  "",
  "/mic          Start or stop recording (toggle)",
  "/mic start    Start recording (begin, gravar)",
  "/mic send     Stop and transcribe (submit, enviar)",
  "/mic abort    Cancel the recording (cancel, parar)",
  "/mic off      Cancel and discard (same as abort)",
  "/mic status   Show recorder state and backend",
  "/mic help     Show this help",
  "",
  "In the terminal, type /voice followed by a space to start inside a draft.",
  "While recording, Space or Enter stops and transcribes; Escape cancels.",
  "A blinking red dot in the prompt footer marks microphone capture.",
  "Type /voice-toggle followed by a space, or run /voice-toggle, to enable or disable voice input.",
  "The setting is remembered; when disabled, /voice is ordinary text.",
  "The transcript is inserted at the cursor; review it and send the prompt yourself.",
  "The server-side /mic command, if separately enabled, sends directly.",
].join("\n")

export const SOUND_HELP = [
  "Speech commands:",
  "",
  "/sound        Toggle speech on/off",
  "/sound on     Enable speech (start, ligar)",
  "/sound off    Disable speech and stop speaking (stop, desligar)",
  "/sound pause  Silence now, keep speech on (silence, calar)",
  "/sound status Show switch, engine, voices and limits",
  "/sound help   Show this help",
  "",
  "Speech reads the main agent's replies; enable the agent's reasoning with OPENCODE_VOICE_TTS_REASONING=1. Configure voices and the API with /mic-setup.",
].join("\n")
