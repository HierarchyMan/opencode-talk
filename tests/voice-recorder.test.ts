import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

vi.mock("../src/node.js", () => ({ platform: () => "win32", node: vi.fn() }))

import { buildCandidates, discoverWindowsAudioDevices, parseWindowsAudioDevices, startRecording, trySpawn } from "../src/recorder.js"
import { node } from "../src/node.js"

const listing = `
[dshow] "Camera" (video)
[dshow] "Virtual Cable" (audio)
[dshow]   Alternative name "@device_virtual"
[dshow] "Microphone Array (Intel® Smart Sound)" (audio)
[dshow] "Microphone Array (Intel® Smart Sound)" (audio)
`

describe("Windows recorder selection", () => {
  it("extracts and deduplicates only audio device names", () => {
    expect(parseWindowsAudioDevices(listing)).toEqual(["Virtual Cable", "Microphone Array (Intel® Smart Sound)"])
  })

  it("prefers a physical microphone and retains other devices as fallbacks", () => {
    const cp = { spawnSync: vi.fn(() => ({ stderr: listing })) } as unknown as typeof import("node:child_process")
    const candidates = buildCandidates(cp, "ffmpeg", 16000)
    expect(candidates[0].args).toContain("audio=Microphone Array (Intel® Smart Sound)")
    expect(candidates[1].args).toContain("audio=Virtual Cable")
  })

  it("honours a user-selected device without enumerating", () => {
    const spawnSync = vi.fn()
    const cp = { spawnSync } as unknown as typeof import("node:child_process")
    const candidates = buildCandidates(cp, "ffmpeg", 16000, "My Mic")
    expect(candidates[0].args).toContain("audio=My Mic")
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it("uses asynchronously discovered devices without blocking enumeration", () => {
    const spawnSync = vi.fn()
    const cp = { spawnSync } as unknown as typeof import("node:child_process")
    const candidates = buildCandidates(cp, "ffmpeg", 16000, undefined, ["Virtual Cable", "Microphone"])
    expect(candidates[0].args).toContain("audio=Microphone")
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it("can cancel Windows device discovery without waiting for its timeout", async () => {
    const controller = new AbortController()
    const execFile = vi.fn((_cmd, _args, options, callback) => {
      options.signal.addEventListener("abort", () => callback(new Error("aborted"), "", ""), { once: true })
    })
    const cp = { execFile } as unknown as typeof import("node:child_process")
    const result = discoverWindowsAudioDevices(cp, controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(execFile).toHaveBeenCalledTimes(1)
  })
})

describe("FFmpeg startup", () => {
  function makeProcess() {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    })
    const spawn = vi.fn((_command: string, _args: string[]) => child)
    const cp = { spawn } as unknown as typeof import("node:child_process")
    return { child, cp, spawn }
  }

  it("waits for positive audio progress before declaring the microphone ready", async () => {
    const { child, cp, spawn } = makeProcess()
    const result = trySpawn(cp, { cmd: "ffmpeg", args: ["-i", "audio=mic", "{file}"] }, "audio.wav")
    const ready = vi.fn()
    void result.then(ready)
    child.emit("spawn")
    child.stdout.write("out_time_us=0\nprogress=continue\n")
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    child.stdout.write("out_time_us=125000\nprogress=continue\n")
    const active = await result
    expect(active.child).toBe(child)
    expect(spawn.mock.calls[0][1]).toContain("-progress")
  })

  it("counts capture time while waiting for recorder readiness", async () => {
    vi.useFakeTimers()
    try {
      const { child, cp } = makeProcess()
      vi.mocked(node).mockResolvedValue({
        fs: { mkdtemp: vi.fn().mockResolvedValue("tmp"), stat: vi.fn().mockResolvedValue({ size: 2048 }) },
        os: { tmpdir: () => "tmp" },
        path: { join: (...parts: string[]) => parts.join("/") },
        cp,
      } as any)
      const result = startRecording({ recorder: "ffmpeg", device: "test" })
      await vi.waitFor(() => expect(child.listenerCount("spawn")).toBeGreaterThan(0))
      child.emit("spawn")
      await vi.advanceTimersByTimeAsync(1000)
      child.stdout.write("out_time_us=250000\n")
      const recording = await result
      Object.assign(child, { exitCode: 0 })
      expect((await recording.stop()).durationMs).toBeGreaterThanOrEqual(1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports recorder errors when a process exits before audio starts", async () => {
    const { child, cp } = makeProcess()
    const result = trySpawn(cp, { cmd: "ffmpeg", args: ["{file}"] }, "audio.wav")
    child.stderr.write("Microphone access denied")
    child.emit("exit", 1)
    await expect(result).rejects.toThrow("Microphone access denied")
  })

  it("kills a recorder immediately when startup is cancelled", async () => {
    const { child, cp } = makeProcess()
    const controller = new AbortController()
    const result = trySpawn(cp, { cmd: "ffmpeg", args: ["{file}"] }, "audio.wav", controller.signal)
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    await rejection
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
  })

  it("does not spawn when startup was already cancelled", async () => {
    const { cp, spawn } = makeProcess()
    const controller = new AbortController()
    controller.abort()
    await expect(trySpawn(cp, { cmd: "ffmpeg", args: ["{file}"] }, "audio.wav", controller.signal))
      .rejects.toMatchObject({ name: "AbortError" })
    expect(spawn).not.toHaveBeenCalled()
  })

  it("times out and stops a recorder that never captures audio", async () => {
    vi.useFakeTimers()
    try {
      const { child, cp } = makeProcess()
      const result = trySpawn(cp, { cmd: "ffmpeg", args: ["{file}"] }, "audio.wav")
      const rejection = expect(result).rejects.toThrow("Timed out waiting for microphone audio")
      child.emit("spawn")
      await vi.advanceTimersByTimeAsync(15000)
      await rejection
      expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    } finally {
      vi.useRealTimers()
    }
  })
})
