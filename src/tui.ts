import { Plugin } from "@opencode/plugin/tui"
import { resolveConfig } from "./config.js"
import { configFilePath, loadConfigFile, saveConfigFile } from "./configfile.js"
import { MIC_HELP, SOUND_HELP } from "./help.js"
import { startRecording, type Recording } from "./recorder.js"
import { transcribe } from "./transcribe.js"
import { consumeVoiceTrigger, focusedComposer, insertTranscript, type Composer } from "./composer.js"

/** Curated edge-tts voices offered in the settings menu. */
const LANG_VOICES: { title: string; value: string; slot: "pt" | "en" | "fr"; category: string }[] = [
  { title: "Portuguese (PT) — Raquel", value: "pt-PT-RaquelNeural", slot: "pt", category: "Portuguese" },
  { title: "Portuguese (PT) — Duarte (male)", value: "pt-PT-DuarteNeural", slot: "pt", category: "Portuguese" },
  { title: "Portuguese (BR) — Francisca", value: "pt-BR-FranciscaNeural", slot: "pt", category: "Portuguese" },
  { title: "Portuguese (BR) — António (male)", value: "pt-BR-AntonioNeural", slot: "pt", category: "Portuguese" },
  { title: "English (US) — Aria", value: "en-US-AriaNeural", slot: "en", category: "English" },
  { title: "English (US) — Guy (male)", value: "en-US-GuyNeural", slot: "en", category: "English" },
  { title: "English (UK) — Sonia", value: "en-GB-SoniaNeural", slot: "en", category: "English" },
  { title: "English (UK) — Ryan (male)", value: "en-GB-RyanNeural", slot: "en", category: "English" },
  { title: "French — Denise", value: "fr-FR-DeniseNeural", slot: "fr", category: "French" },
  { title: "French — Henri (male)", value: "fr-FR-HenriNeural", slot: "fr", category: "French" },
]

const AVAILABLE_LANGUAGES = [
  "Portuguese (Portugal) pt      → pt-PT-RaquelNeural · pt-PT-DuarteNeural",
  "Portuguese (Brazil)   pt-br   → pt-BR-FranciscaNeural · pt-BR-AntonioNeural",
  "English (US)          en      → en-US-AriaNeural · en-US-GuyNeural",
  "English (UK)          en-gb   → en-GB-SoniaNeural · en-GB-RyanNeural",
  "Spanish               es      → es-ES-ElviraNeural",
  "French                fr      → fr-FR-DeniseNeural · fr-FR-HenriNeural",
  "German                de      → de-DE-KatjaNeural",
  "Italian               it      → it-IT-ElsaNeural",
].join("\n")

/**
 * Voice input for OpenCode.
 *
 * Press the keybind (default `<leader>v`) or run `/voice` to start recording,
 * press it again to stop. The transcript is inserted into the existing draft;
 * it is never submitted by dictation.
 */
export default Plugin.define({
  id: "voice-input.tui",
  async setup(context) {
    const indicator = (context.ui as { slot?: typeof context.ui.slot }).slot
      ? (await import("./indicator.tsx")).recordingIndicator(context)
      : undefined
    const [voice, updateVoice] = context.storage.store("voice-input", { initial: { enabled: true } })
    const isEnabled = () => voice.enabled !== false
    let cfg = resolveConfig(context.options as Record<string, unknown> | undefined)
    const refresh = () => {
      cfg = resolveConfig(context.options as Record<string, unknown> | undefined)
    }

    let recording: Recording | undefined
    let opening: AbortController | undefined
    let stopping = false
    let finishWhenReady = false
    let autoStop: ReturnType<typeof setTimeout> | undefined
    let busy = false
    let origin: { sessionID?: string; editor: Composer } | undefined
    const pending: { sessionID?: string; text: string }[] = []
    let generation = 0
    let transcription: AbortController | undefined
    let changingVoice = false
    let disposed = false
    let voiceMonitor: ReturnType<typeof setInterval> | undefined

    const toast = (
      message: string,
      variant: "info" | "success" | "warning" | "error" = "info",
      duration = 4000,
    ) => context.ui.toast.show({ title: "Voice", message, variant, duration })

    function activeSessionID(): string | undefined {
      const route = context.ui.router.current()
      if (route.type === "session") return route.sessionID
      return context.ui.panel.current()?.sessionID
    }

    async function begin() {
      if (!isEnabled() || busy || recording || disposed) return
      const currentGeneration = generation
      const editor = focusedComposer(context.renderer)
      if (!editor) {
        toast("Focus the normal prompt before starting voice input", "warning")
        return
      }
      refresh()
      // Silence the server-side TTS before we start capturing the mic.
      const sessionID = activeSessionID()
      origin = { sessionID, editor }
      if (sessionID) {
        void context.client.session.command({ sessionID, name: "sound", text: "pause" }).catch(() => {})
      }
      busy = true
      opening = new AbortController()
      finishWhenReady = false
      indicator?.set(true)
      monitorVoice()
      try {
        toast("Opening microphone…", "info", 10000)
        const active = await startRecording({ recorder: cfg.recorder, sampleRate: cfg.sampleRate, device: cfg.recorderDevice, signal: opening.signal })
        if (!isEnabled() || disposed || generation !== currentGeneration) {
          await active.abort()
          return
        }
        recording = active
        toast("Recording…", "info", 2500)
        if (cfg.maxDuration > 0) {
          autoStop = setTimeout(() => void finish(), cfg.maxDuration * 1000)
        }
      } catch (error) {
        recording = undefined
        origin = undefined
        if (isEnabled() && !disposed && generation === currentGeneration)
          toast(`Could not start recording — ${(error as Error).message}`, "error", 7000)
      } finally {
        opening = undefined
        busy = false
        if (!recording) {
          indicator?.set(false)
          stopVoiceMonitor()
        } else if (finishWhenReady) {
          finishWhenReady = false
          void finish()
        }
      }
    }

    async function finish() {
      refresh()
      const active = recording
      if (!active) return
      const currentGeneration = generation
      const destination = origin
      origin = undefined
      recording = undefined
      if (autoStop) {
        clearTimeout(autoStop)
        autoStop = undefined
      }

      const sessionID = activeSessionID()
      busy = true
      stopping = true
      try {
        try {
          let result: Awaited<ReturnType<Recording["stop"]>>
          try {
            result = await active.stop()
          } finally {
            stopping = false
            indicator?.set(false)
          }
          const { file, durationMs } = result
          if (!isEnabled() || disposed || generation !== currentGeneration) return

          if (durationMs < cfg.minDuration * 1000) {
            toast("Recording was too short", "warning")
            return
          }

          toast("Transcribing…", "info", 2000)
          const controller = new AbortController()
          transcription = controller
          let text = await transcribe(cfg, file, controller.signal)
          if (!isEnabled() || disposed || generation !== currentGeneration) return
          if (!text) {
            toast("No speech detected", "warning")
            return
          }

          if (cfg.polish && sessionID) text = await polish(sessionID, text)
          if (!isEnabled() || disposed || generation !== currentGeneration) return

          const finalText = [cfg.prefix, text, cfg.suffix]
            .map((part) => part.trim())
            .filter(Boolean)
            .join(" ")

          const current = focusedComposer(context.renderer)
          if (destination && destination.sessionID === activeSessionID() && current === destination.editor &&
              insertTranscript(current, finalText)) {
            toast("Transcript added to draft", "success", 2500)
          } else {
            pending.push({ sessionID: destination?.sessionID, text: finalText })
            toast("Transcript held: return to the original prompt and run Voice: insert held transcript", "warning", 10000)
          }
        } finally {
          indicator?.set(false)
          if (!cfg.keepAudio) await active.abort()
        }
      } catch (error) {
        if (isEnabled() && !disposed && generation === currentGeneration)
          toast(`Voice failed — ${(error as Error).message}`, "error", 7000)
      } finally {
        transcription = undefined
        busy = false
        stopVoiceMonitor()
      }
    }

    async function polish(sessionID: string, text: string): Promise<string> {
      try {
        const result = await context.client.session.generate({
          sessionID,
          prompt: `${cfg.polishPrompt}${text}`,
        })
        const cleaned = String(result?.text ?? "").trim()
        return cleaned || text
      } catch {
        return text
      }
    }

    async function configure() {
      const choice = await context.ui.dialog.select({
        title: "Voice settings",
        options: [
          { title: "Local transcription (faster-whisper, no key)", value: "local" },
          { title: "API transcription — set key", value: "api" },
          { title: "Choose voice", value: "tts-list" },
          { title: "Portuguese TTS voice — enter name", value: "tts" },
          { title: "English TTS voice — enter name", value: "tts-en" },
          { title: "French TTS voice — enter name", value: "tts-fr" },
          { title: "Show available languages and voices", value: "langs" },
          { title: "Automatic speech language detection (pt/en/fr)", value: "tts-auto" },
          { title: cfg.ttsReasoning ? "Stop speaking reasoning" : "Speak reasoning", value: "tts-reasoning" },
          { title: cfg.tts ? "Disable TTS" : "Enable TTS", value: "tts-toggle" },
          { title: "Show current settings", value: "show" },
        ],
      })
      if (!choice) return

      if (choice === "local") {
        saveConfigFile({ backend: "local" })
        refresh()
        toast("Local transcription enabled", "success")
      } else if (choice === "api") {
        const key = await context.ui.dialog.prompt({
          title: "API key",
          description: "Stored in ~/.config/opencode/voice.json (outside the repository)",
          placeholder: "sk-...",
        })
        if (!key || !key.trim()) return
        const baseURL = await context.ui.dialog.prompt({ title: "Base URL", value: String(cfg.baseURL) })
        const model = await context.ui.dialog.prompt({ title: "Model", value: String(cfg.model) })
        saveConfigFile({
          backend: "api",
          apiKey: key.trim(),
          baseURL: (baseURL ?? "").trim() || cfg.baseURL,
          model: (model ?? "").trim() || cfg.model,
        })
        refresh()
        toast("Key saved outside the repository", "success")
      } else if (choice === "tts") {
        const voice = await context.ui.dialog.prompt({
          title: "TTS voice",
          description: "pt, pt-br, en, … or an Edge voice name (e.g. pt-PT-DuarteNeural)",
          value: String(cfg.ttsVoice ?? "pt"),
        })
        if (voice === undefined) return
        saveConfigFile({ ttsVoice: voice.trim() || "pt" })
        refresh()
        toast(`TTS voice: ${voice.trim() || "pt"}`, "success")
      } else if (choice === "tts-en") {
        const voice = await context.ui.dialog.prompt({
          title: "English TTS voice",
          description: "English Edge voice (e.g. en-US-AriaNeural, en-GB-SoniaNeural)",
          value: String(cfg.ttsVoiceEn ?? "en-US-AriaNeural"),
        })
        if (voice === undefined) return
        saveConfigFile({ ttsVoiceEn: voice.trim() || "en-US-AriaNeural" })
        refresh()
        toast(`English voice: ${voice.trim() || "en-US-AriaNeural"}`, "success")
      } else if (choice === "tts-fr") {
        const voice = await context.ui.dialog.prompt({
          title: "French TTS voice",
          description: "French Edge voice (e.g. fr-FR-DeniseNeural, fr-FR-HenriNeural)",
          value: String(cfg.ttsVoiceFr ?? "fr-FR-DeniseNeural"),
        })
        if (voice === undefined) return
        saveConfigFile({ ttsVoiceFr: voice.trim() || "fr-FR-DeniseNeural" })
        refresh()
        toast(`French voice: ${voice.trim() || "fr-FR-DeniseNeural"}`, "success")
      } else if (choice === "tts-list") {
        const picked = await context.ui.dialog.select({
          title: "Choose voice",
          options: LANG_VOICES.map((v) => ({ title: v.title, value: v.value, category: v.category })),
        })
        if (!picked) return
        const entry = LANG_VOICES.find((v) => v.value === picked)
        if (!entry) return
        if (entry.slot === "en") saveConfigFile({ ttsVoiceEn: entry.value })
        else if (entry.slot === "fr") saveConfigFile({ ttsVoiceFr: entry.value })
        else saveConfigFile({ ttsVoice: entry.value })
        refresh()
        toast(`Voice: ${picked}`, "success")
      } else if (choice === "langs") {
        await context.ui.dialog.alert({
          title: "Available languages and voices",
          message: `${AVAILABLE_LANGUAGES}\n\nCurrent — PT: ${cfg.ttsVoice} · EN: ${cfg.ttsVoiceEn}\nAutomatic detection selects PT, EN or FR; any Edge voice name is also accepted.`,
        })
      } else if (choice === "tts-auto") {
        saveConfigFile({ ttsAuto: !cfg.ttsAuto })
        refresh()
        toast(cfg.ttsAuto ? "Automatic detection: on" : "Automatic detection: off", "success")
      } else if (choice === "tts-reasoning") {
        saveConfigFile({ ttsReasoning: !cfg.ttsReasoning })
        refresh()
        toast(cfg.ttsReasoning ? "Speaking reasoning: on" : "Speaking reasoning: off", "success")
      } else if (choice === "tts-toggle") {
        saveConfigFile({ tts: !cfg.tts })
        refresh()
        toast(cfg.tts ? "TTS enabled" : "TTS disabled", "success")
      } else if (choice === "show") {
        const current = { ...loadConfigFile() }
        if (typeof current.apiKey === "string") {
          current.apiKey = `${current.apiKey.slice(0, 4)}…(${current.apiKey.length})`
        }
        await context.ui.dialog.alert({
          title: "Voice settings",
          message: `${configFilePath()}\n\n${JSON.stringify(current, null, 2)}`,
        })
      }
    }

    const cancelWords = new Set(["stop", "cancel", "abort", "parar", "para", "cancelar", "cancela"])
    const sendWords = new Set(["send", "submit", "enviar", "submeter", "terminar", "concluir"])
    const startWords = new Set(["start", "begin", "iniciar", "comecar", "começar", "gravar", "record"])
    const helpWords = new Set(["help", "ajuda", "?"])

    async function cancelRecording() {
      if (!recording && !opening && !stopping) return
      suspendVoice()
      toast("Recording cancelled", "warning", 2500)
    }

    function stopVoiceMonitor() {
      if (voiceMonitor) clearInterval(voiceMonitor)
      voiceMonitor = undefined
    }

    // The store is shared across TUIs. Check it only while a capture or request
    // is active so a change in another window also shuts down this microphone.
    function monitorVoice() {
      if (voiceMonitor) return
      voiceMonitor = setInterval(() => {
        if (!isEnabled()) suspendVoice()
      }, 200)
    }

    function suspendVoice() {
      generation++
      stopVoiceMonitor()
      opening?.abort()
      finishWhenReady = false
      transcription?.abort()
      origin = undefined
      const active = recording
      recording = undefined
      if (autoStop) clearTimeout(autoStop)
      autoStop = undefined
      if (active) {
        busy = true
        stopping = true
        void active.abort().catch((error) => {
          if (!disposed) toast(`Could not stop microphone — ${String(error)}`, "error", 7000)
        }).finally(() => {
          stopping = false
          indicator?.set(false)
          busy = false
        })
      }
    }

    async function toggleEnabled() {
      if (changingVoice || disposed) return
      changingVoice = true
      try {
        await updateVoice((draft) => { draft.enabled = draft.enabled === false })
        // Do not rely only on reactive effects: the microphone must stop immediately.
        if (!isEnabled()) suspendVoice()
        toast(isEnabled() ? "Voice input enabled" : "Voice input disabled — /voice is ordinary text", "success")
      } catch (error) {
        toast(`Could not save voice setting — ${String(error)}`, "error", 7000)
      } finally {
        changingVoice = false
      }
    }

    function handleRun(input?: string) {
      const arg = String(input ?? "").trim().toLowerCase()
      if (helpWords.has(arg)) {
        void context.ui.dialog.alert({ title: "Voice input", message: MIC_HELP })
        return
      }
      if (cancelWords.has(arg)) {
        void cancelRecording()
        return
      }
      if (sendWords.has(arg)) {
        if (recording) void finish()
        else toast("No recording in progress", "warning", 2000)
        return
      }
      if (startWords.has(arg)) {
        if (recording) toast("Already recording", "info", 2000)
        else void begin()
        return
      }
      toggle()
    }

    const soundOnWords = new Set(["start", "on", "ligar", "liga", "enable", "ativa", "ativar"])
    const soundPauseWords = new Set(["pause", "silence", "silencio", "silêncio", "quiet", "hush", "calar", "parar", "para"])
    const soundOffWords = new Set(["stop", "off", "desligar", "desliga", "disable", "cancel", "cancelar", "abort"])

    async function pauseServerSpeech() {
      const sid = activeSessionID()
      if (sid) {
        await context.client.session.command({ sessionID: sid, name: "sound", text: "pause" }).catch(() => {})
      }
    }

    async function handleSound(input?: string) {
      const arg = String(input ?? "").trim().toLowerCase()
      if (helpWords.has(arg)) {
        await context.ui.dialog.alert({ title: "Speech", message: SOUND_HELP })
        return
      }
      if (soundOnWords.has(arg)) {
        saveConfigFile({ tts: true })
        refresh()
        toast("Speech enabled", "success")
        return
      }
      if (soundPauseWords.has(arg)) {
        await pauseServerSpeech()
        toast("Speech paused", "warning")
        return
      }
      if (soundOffWords.has(arg)) {
        await pauseServerSpeech()
        saveConfigFile({ tts: false })
        refresh()
        toast("Speech disabled", "warning")
        return
      }
      const next = !cfg.tts
      if (!next) await pauseServerSpeech()
      saveConfigFile({ tts: next })
      refresh()
      toast(next ? "Speech enabled" : "Speech disabled", next ? "success" : "warning")
    }

    function toggle() {
      if (!isEnabled() || disposed) return
      if (opening) {
        finishWhenReady = true
        return
      }
      void (recording ? finish() : begin())
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 5,
      commands: [
        {
          id: "voice.input.toggle",
          title: "Voice input",
          description:
            "Toggle dictation; /voice followed by a space works inside a draft",
          group: "Voice",
          bind: !isEnabled() || cfg.keybind === false ? false : cfg.keybind,
          palette: true,
          slash: isEnabled() && cfg.slash
            ? { name: cfg.slash, aliases: cfg.aliases, arguments: true }
            : undefined,
          run: (input) => {
            handleRun(input)
          },
        },
        {
          id: "voice.input.enabled",
          title: isEnabled() ? "Voice: disable voice input" : "Voice: enable voice input",
          description: "Toggle voice input persistently",
          group: "Voice",
          bind: false,
          palette: true,
          slash: { name: "voice-toggle", arguments: true },
          run: () => { void toggleEnabled() },
        },
        {
          id: "voice.input.inline",
          title: "Start or stop inline voice input",
          group: "Voice",
          bind: "space",
          run: (_input, event) => {
            if (!event || changingVoice) return false
            const editor = focusedComposer(context.renderer)
            if (!editor) return false
            if (recording || opening || stopping) {
              if (origin?.editor === editor && origin.sessionID === activeSessionID()) consumeVoiceTrigger(editor)
              event.preventDefault()
              event.stopPropagation()
              if (!stopping) toggle()
              return
            }
            if (consumeVoiceTrigger(editor, "/voice-toggle")) {
              event.preventDefault()
              event.stopPropagation()
              void toggleEnabled()
              return
            }
            if (!isEnabled() || busy || !consumeVoiceTrigger(editor)) return false
            event.preventDefault()
            event.stopPropagation()
            toggle()
          },
        },
        {
          id: "voice.input.finish-enter",
          bind: "enter",
          run: (_input, event) => {
            if (!event || !(recording || opening || stopping) || !focusedComposer(context.renderer)) return false
            event.preventDefault()
            event.stopPropagation()
            if (!stopping) toggle()
          },
        },
        {
          id: "voice.input.cancel-escape",
          bind: "escape",
          run: (_input, event) => {
            if (!event || !(recording || opening || stopping)) return false
            event.preventDefault()
            event.stopPropagation()
            void cancelRecording()
          },
        },
        {
          id: "voice.input.recover",
          title: "Voice: insert held transcript",
          description: "Insert a transcript held when its original prompt was unavailable",
          group: "Voice",
          bind: false,
          palette: true,
          run: () => {
            const sessionID = activeSessionID()
            const index = pending.findIndex((item) => item.sessionID === sessionID)
            const editor = focusedComposer(context.renderer)
            if (index < 0) {
              toast("No held transcript for this prompt", "info")
              return
            }
            if (!editor || !insertTranscript(editor, pending[index].text)) {
              toast("Focus the prompt and clear any selection, then retry", "warning")
              return
            }
            pending.splice(index, 1)
            toast("Transcript added to draft", "success")
          },
        },
        {
          id: "voice.setup",
          title: "Voice: settings",
          description: "Configure transcription API, TTS voice and backend",
          group: "Voice",
          bind: false,
          palette: true,
          slash: { name: "mic-setup", aliases: ["voice-setup", "voice-config"] },
          run: () => {
            void configure()
          },
        },
        {
          id: "voice.sound.toggle",
          title: "Sound: toggle speech",
          description: "Agent speech: /sound (toggle), /sound on, /sound off, /sound pause, /sound help",
          group: "Voice",
          bind: false,
          palette: true,
          slash: { name: "sound", arguments: true },
          run: (input) => {
            void handleSound(input)
          },
        },
      ],
      bindings: ["voice.input.toggle", "voice.setup", "voice.sound.toggle"],
    }))

    return () => {
      disposed = true
      suspendVoice()
      indicator?.dispose()
    }
  },
})
