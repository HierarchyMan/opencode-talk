import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  transcribe: vi.fn(),
}))
vi.mock("../src/recorder.js", () => ({ startRecording: mocks.start }))
vi.mock("../src/transcribe.js", () => ({ transcribe: mocks.transcribe }))

import plugin from "../tui.js"

function editor(initial = "", cursor = initial.length) {
  return {
    plainText: initial,
    cursorOffset: cursor,
    focused: true,
    isDestroyed: false,
    selected: false,
    traits: { owner: "opencode", role: "prompt", status: undefined as string | undefined },
    getClipboardText: () => "",
    hasSelection() { return this.selected },
    getTextRange(start: number, end: number) { return this.plainText.slice(start, end) },
    editBuffer: { offsetToPosition(offset: number) { return { row: 0, col: offset } } },
    deleteRange(_startRow: number, start: number, _endRow: number, end: number) {
      this.plainText = this.plainText.slice(0, start) + this.plainText.slice(end)
      this.cursorOffset = start
    },
    insertText(text: string) {
      this.plainText = this.plainText.slice(0, this.cursorOffset) + text + this.plainText.slice(this.cursorOffset)
      this.cursorOffset += text.length
    },
  }
}

async function setup(initial = "", persisted = { enabled: true }) {
  const stop = vi.fn().mockResolvedValue({ file: "audio.wav", durationMs: 2000 })
  const abort = vi.fn().mockResolvedValue(undefined)
  mocks.start.mockResolvedValue({ stop, abort })
  mocks.transcribe.mockResolvedValue("spoken words")
  const prompt = vi.fn()
  const send = vi.fn()
  const select = vi.fn().mockResolvedValue(undefined)
  const input = editor(initial)
  let sessionID = "ses_test"
  let layer: () => any
  const context: any = {
    options: { backend: "api", apiKey: "test", language: "en", submitMode: "edit", tts: false },
    renderer: { currentFocusedEditor: input },
    storage: { store: () => [persisted, async (mutate: (draft: typeof persisted) => void) => mutate(persisted)] },
    ui: {
      toast: { show: vi.fn() },
      router: { current: () => ({ type: "session", sessionID }) },
      panel: { current: () => undefined },
      dialog: { prompt, select },
    },
    keymap: { layer: (factory: () => any) => { layer = factory } },
    client: { session: { command: vi.fn().mockResolvedValue(undefined), prompt: send } },
  }
  const dispose = await plugin.setup(context)
  const command = (id: string) => layer().commands.find((item: any) => item.id === id)
  const space = () => {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    const result = command("voice.input.inline").run(undefined, event)
    return { event, result }
  }
  const key = (id: string) => {
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    const result = command(id).run(undefined, event)
    return { event, result }
  }
  return { context, input, prompt, send, abort, stop, command, space, key, dispose, persisted, setSession: (value: string) => { sessionID = value } }
}

beforeEach(() => vi.clearAllMocks())

describe("voice input in the composer", () => {
  it.each(["space", "enter"])("%s stops recording and inserts without submitting", async (name) => {
    const t = await setup("draft")
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Recording…" }),
    ))
    const action = name === "space" ? t.space() : t.key("voice.input.finish-enter")
    expect(action.event.preventDefault).toHaveBeenCalled()
    expect(action.event.stopPropagation).toHaveBeenCalled()
    await vi.waitFor(() => expect(t.input.plainText).toBe("draft spoken words"))
    expect(t.send).not.toHaveBeenCalled()
    expect(t.stop).toHaveBeenCalledTimes(1)
    t.dispose?.()
  })

  it("Escape cancels without changing or submitting the draft", async () => {
    const t = await setup("draft")
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Recording…" }),
    ))
    const action = t.key("voice.input.cancel-escape")
    expect(action.event.preventDefault).toHaveBeenCalled()
    expect(action.event.stopPropagation).toHaveBeenCalled()
    await vi.waitFor(() => expect(t.abort).toHaveBeenCalled())
    expect(t.stop).not.toHaveBeenCalled()
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(t.input.plainText).toBe("draft")
    expect(t.send).not.toHaveBeenCalled()
    t.dispose?.()
  })

  it.each(["space", "enter"])("%s during microphone startup queues a safe finish", async (name) => {
    const t = await setup("draft")
    let resolveStart!: (value: any) => void
    mocks.start.mockReturnValueOnce(new Promise((resolve) => { resolveStart = resolve }))
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled())
    const action = name === "space" ? t.space() : t.key("voice.input.finish-enter")
    expect(action.event.preventDefault).toHaveBeenCalled()
    resolveStart({ stop: t.stop, abort: t.abort })
    await vi.waitFor(() => expect(t.input.plainText).toBe("draft spoken words"))
    expect(t.stop).toHaveBeenCalledTimes(1)
    expect(t.send).not.toHaveBeenCalled()
    t.dispose?.()
  })

  it("Escape during microphone startup cancels the pending recorder", async () => {
    const t = await setup("draft")
    let resolveStart!: (value: any) => void
    mocks.start.mockReturnValueOnce(new Promise((resolve) => { resolveStart = resolve }))
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled())
    const signal: AbortSignal = mocks.start.mock.calls[0][0].signal
    const action = t.key("voice.input.cancel-escape")
    expect(action.event.preventDefault).toHaveBeenCalled()
    expect(signal.aborted).toBe(true)
    resolveStart({ stop: t.stop, abort: t.abort })
    await vi.waitFor(() => expect(t.abort).toHaveBeenCalled())
    expect(t.stop).not.toHaveBeenCalled()
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(t.input.plainText).toBe("draft")
    t.dispose?.()
  })

  it("consumes repeated finish keys until the microphone has actually stopped", async () => {
    const t = await setup("draft")
    let resolveStop!: (value: any) => void
    t.stop.mockReturnValueOnce(new Promise((resolve) => { resolveStop = resolve }))
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Recording…" }),
    ))
    t.key("voice.input.finish-enter")
    expect(t.key("voice.input.finish-enter").event.preventDefault).toHaveBeenCalled()
    expect(t.space().event.preventDefault).toHaveBeenCalled()
    expect(t.stop).toHaveBeenCalledTimes(1)
    resolveStop({ file: "audio.wav", durationMs: 2000 })
    await vi.waitFor(() => expect(t.input.plainText).toBe("draft spoken words"))
    expect(t.send).not.toHaveBeenCalled()
    t.dispose?.()
  })

  it("Escape while the microphone is stopping discards the pending recording", async () => {
    const t = await setup("draft")
    let resolveStop!: (value: any) => void
    t.stop.mockReturnValueOnce(new Promise((resolve) => { resolveStop = resolve }))
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Recording…" }),
    ))
    t.space()
    expect(t.key("voice.input.cancel-escape").event.preventDefault).toHaveBeenCalled()
    resolveStop({ file: "audio.wav", durationMs: 2000 })
    await vi.waitFor(() => expect(t.abort).toHaveBeenCalled())
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(t.input.plainText).toBe("draft")
    t.dispose?.()
  })

  it("leaves normal keys alone when idle and does not hijack a dialog", async () => {
    const t = await setup("draft")
    expect(t.key("voice.input.finish-enter").result).toBe(false)
    expect(t.key("voice.input.cancel-escape").result).toBe(false)
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Recording…" }),
    ))
    t.input.traits.role = "dialog"
    expect(t.space().result).toBe(false)
    expect(t.key("voice.input.finish-enter").result).toBe(false)
    expect(t.stop).not.toHaveBeenCalled()
    expect(t.key("voice.input.cancel-escape").event.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(t.abort).toHaveBeenCalled())
    t.dispose?.()
  })

  it("stops from a different session without submitting or inserting into the wrong draft", async () => {
    const t = await setup("draft")
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Recording…" }),
    ))
    t.setSession("other")
    expect(t.key("voice.input.finish-enter").event.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Transcript held") }),
    ))
    expect(t.input.plainText).toBe("draft")
    expect(t.send).not.toHaveBeenCalled()
    t.dispose?.()
  })

  it("persists the off switch and makes /voice ordinary text until re-enabled", async () => {
    const t = await setup("existing /voice-toggle")
    expect(t.persisted.enabled).toBe(true)
    const off = t.space()
    expect(off.event.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(t.persisted.enabled).toBe(false))
    expect(t.input.plainText).toBe("existing ")
    expect(t.command("voice.input.toggle").slash).toBeUndefined()
    expect(t.command("voice.input.toggle").bind).toBe(false)
    t.input.insertText("/voice")
    expect(t.space().result).toBe(false)
    expect(t.input.plainText).toBe("existing /voice")
    expect(mocks.start).not.toHaveBeenCalled()
    t.dispose?.()

    const reloaded = await setup("draft /voice-toggle", t.persisted)
    expect(reloaded.command("voice.input.toggle").slash).toBeUndefined()
    reloaded.space()
    await vi.waitFor(() => expect(reloaded.persisted.enabled).toBe(true))
    expect(reloaded.command("voice.input.toggle").slash.aliases).toContain("voice")
    reloaded.input.insertText("/voice")
    reloaded.space()
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled())
    reloaded.dispose?.()
  })

  it("disables and cancels an active recording without transcribing", async () => {
    const t = await setup("draft")
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Recording") }),
    ))
    t.command("voice.input.enabled").run()
    await vi.waitFor(() => expect(t.abort).toHaveBeenCalled())
    expect(t.persisted.enabled).toBe(false)
    expect(t.stop).not.toHaveBeenCalled()
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(t.input.plainText).toBe("draft")
    t.dispose?.()
  })

  it("stops a recording when shared state is disabled by another terminal", async () => {
    const state = { enabled: true }
    const t = await setup("draft", state)
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Recording") }),
    ))
    state.enabled = false
    await vi.waitFor(() => expect(t.abort).toHaveBeenCalled())
    expect(mocks.transcribe).not.toHaveBeenCalled()
    t.dispose?.()
  })

  it("stops a recorder that finishes opening after voice input was disabled", async () => {
    const t = await setup("draft")
    let resolveStart!: (value: any) => void
    mocks.start.mockReturnValueOnce(new Promise((resolve) => { resolveStart = resolve }))
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled())
    t.command("voice.input.enabled").run()
    await vi.waitFor(() => expect(t.persisted.enabled).toBe(false))
    resolveStart({ stop: t.stop, abort: t.abort })
    await vi.waitFor(() => expect(t.abort).toHaveBeenCalled())
    expect(t.input.plainText).toBe("draft")
    expect(mocks.transcribe).not.toHaveBeenCalled()
    t.dispose?.()
  })

  it("aborts an in-flight transcription and never inserts its late result after disabling", async () => {
    const t = await setup("draft")
    let resolveText!: (text: string) => void
    mocks.transcribe.mockReturnValueOnce(new Promise<string>((resolve) => { resolveText = resolve }))
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Recording") }),
    ))
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalled())
    const signal: AbortSignal = mocks.transcribe.mock.calls[0][2]
    t.command("voice.input.enabled").run()
    await vi.waitFor(() => expect(t.persisted.enabled).toBe(false))
    expect(signal.aborted).toBe(true)
    resolveText("late words")
    await vi.waitFor(() => expect(t.abort).toHaveBeenCalled())
    expect(t.input.plainText).toBe("draft")
    expect(t.send).not.toHaveBeenCalled()
    t.dispose?.()
  })

  it("toggles with /voice plus space in a nonempty draft and never sends or opens a dialog", async () => {
    const t = await setup("typed words /voice")
    const first = t.space()
    expect(first.event.preventDefault).toHaveBeenCalled()
    expect(t.input.plainText).toBe("typed words ")
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Recording") }),
    ))
    t.input.insertText("more typed /voice")
    t.space()
    await vi.waitFor(() => expect(t.input.plainText).toBe("typed words more typed spoken words"))
    expect(mocks.transcribe.mock.calls[0][0].language).toBe("en")
    expect(t.send).not.toHaveBeenCalled()
    expect(t.prompt).not.toHaveBeenCalled()
    expect(t.abort).toHaveBeenCalled()
    t.dispose?.()
  })

  it("does not intercept ordinary spaces, partial commands, dialogs, or selections", async () => {
    const t = await setup("hello /voices")
    expect(t.space().result).toBe(false)
    expect(t.input.plainText).toBe("hello /voices")
    t.input.plainText = "path/voice"
    t.input.cursorOffset = t.input.plainText.length
    expect(t.space().result).toBe(false)
    t.input.plainText = "hello /voice"
    t.input.cursorOffset = t.input.plainText.length
    t.input.selected = true
    expect(t.space().result).toBe(false)
    t.input.selected = false
    t.input.traits.role = "dialog"
    expect(t.space().result).toBe(false)
    expect(mocks.start).not.toHaveBeenCalled()
    t.dispose?.()
  })

  it("holds text rather than replacing a selection in the original prompt", async () => {
    const t = await setup("keep my text")
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Recording") }),
    ))
    t.input.selected = true
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Transcript held") }),
    ))
    expect(t.input.plainText).toBe("keep my text")
    t.input.selected = false
    t.command("voice.input.recover").run()
    expect(t.input.plainText).toBe("keep my text spoken words")
    t.dispose?.()
  })

  it("holds a transcript when the session changes, then recovers it only in its original prompt", async () => {
    const t = await setup("original")
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Recording") }),
    ))
    t.setSession("other")
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Transcript held") }),
    ))
    t.command("voice.input.recover").run()
    expect(t.input.plainText).toBe("original")
    t.setSession("ses_test")
    t.command("voice.input.recover").run()
    expect(t.input.plainText).toBe("original spoken words")
    expect(t.send).not.toHaveBeenCalled()
    t.dispose?.()
  })

  it("inserts at the cursor without replacing surrounding text", async () => {
    const t = await setup("before /voice after")
    t.input.cursorOffset = "before /voice".length
    t.space()
    await vi.waitFor(() => expect(t.context.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Recording") }),
    ))
    t.command("voice.input.toggle").run()
    await vi.waitFor(() => expect(t.input.plainText).toBe("before spoken words after"))
    t.dispose?.()
  })
})
