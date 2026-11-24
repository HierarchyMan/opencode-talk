import { node, platform } from "./node.js"

export interface Recording {
  readonly file: string
  readonly directory: string
  /** Stop capturing, finalize the WAV, and return the result. */
  stop(): Promise<{ file: string; directory: string; durationMs: number }>
  /** Stop capturing without transcribing and delete the audio. */
  abort(): Promise<void>
}

interface Candidate {
  cmd: string
  args: string[]
}

type ChildProcess = import("node:child_process").ChildProcess

export interface RecorderOptions {
  recorder?: string
  sampleRate?: number
  /** Exact DirectShow audio device name on Windows; otherwise auto-detected. */
  device?: string
  /** Cancel startup before a recorder has become ready. */
  signal?: AbortSignal
  /** Keep the WAV file on disk (still returns the path). */
  keepAudio?: boolean
}

/**
 * Start capturing the default microphone into a WAV file.
 *
 * Recorder binaries differ per platform and desktop stack, so we try a small
 * ordered list. FFmpeg must report captured audio before it is considered ready;
 * other recorders must survive a short grace period.
 */
export async function startRecording(options: RecorderOptions = {}): Promise<Recording> {
  const { fs, os, path, cp } = await node()
  options.signal?.throwIfAborted()
  const rate = options.sampleRate ?? 16000
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-voice-"))
  const file = path.join(directory, "audio.wav")

  let discovered: string[] | undefined
  try {
    if (platform() === "win32" && !options.device && (!options.recorder || options.recorder === "auto" || options.recorder === "ffmpeg")) {
      discovered = await discoverWindowsAudioDevices(cp, options.signal)
    }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  const candidates = buildCandidates(cp, options.recorder ?? "auto", rate, options.device, discovered)
  const attempted: string[] = []
  const failures: string[] = []
  let child: ChildProcess | undefined
  let used: string | undefined
  let startedAt = 0
  let recorderOutput: (() => string) | undefined

  for (const candidate of candidates) {
    if (options.signal?.aborted) break
    attempted.push(candidate.cmd)
    try {
      const attemptedAt = Date.now()
      const active = await trySpawn(cp, candidate, file, options.signal)
      child = active.child
      recorderOutput = active.stderr
      used = candidate.cmd
      // Readiness can take time while audio is already being captured.
      startedAt = attemptedAt
      break
    } catch (error) {
      failures.push(`${candidate.cmd}: ${(error as Error).message}`)
    }
  }

  if (!child || !used) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    options.signal?.throwIfAborted()
    const detail = failures.length ? failures.join("; ") : attempted.join(", ")
    throw new Error(`no microphone recorder available (${detail})`)
  }

  let terminated = false

  async function finalize(): Promise<void> {
    if (terminated) return
    terminated = true
    await terminate(child!, used === "ffmpeg")
  }

  return {
    file,
    directory,
    async stop() {
      await finalize()
      const durationMs = Date.now() - startedAt
      const info = await fs.stat(file).catch(() => undefined)
      if (!info || info.size < 1024) {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
        const detail = recorderOutput?.().trim()
        throw new Error(`Recording produced no audio${detail ? `: ${detail.slice(-1000)}` : ". Check microphone access and try again."}`)
      }
      return { file, directory, durationMs }
    },
    async abort() {
      await finalize()
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/** DirectShow requires an actual device name; "audio=default" is not a default-device alias. */
export function parseWindowsAudioDevices(output: string): string[] {
  return [...new Set(Array.from(output.matchAll(/"([^"\r\n]+)"\s+\(audio\)/g), (match) => match[1]))]
}

/** Device enumeration must not block the TUI or prevent Escape from cancelling. */
export async function discoverWindowsAudioDevices(cp: typeof import("node:child_process"), signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  const output = await new Promise<string>((resolve) => {
    cp.execFile("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      { encoding: "utf8", timeout: 10000, windowsHide: true, signal },
      (_error, _stdout, stderr) => resolve(stderr ?? ""))
  })
  signal?.throwIfAborted()
  return parseWindowsAudioDevices(output)
}

export function buildCandidates(cp: typeof import("node:child_process"), recorder: string, rate: number, device?: string, discovered?: readonly string[]): Candidate[] {
  const all: Candidate[] = [
    { cmd: "pw-record", args: ["--rate", String(rate), "--channels", "1", "--format", "s16", "{file}"] },
    { cmd: "parecord", args: [`--format=s16le`, `--rate=${rate}`, "--channels=1", "--file-format=wav", "{file}"] },
    { cmd: "arecord", args: ["-q", "-f", "S16_LE", "-r", String(rate), "-c", "1", "-t", "wav", "{file}"] },
    { cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default", "-ar", String(rate), "-ac", "1", "-y", "{file}"] },
    { cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "alsa", "-i", "default", "-ar", String(rate), "-ac", "1", "-y", "{file}"] },
    { cmd: "sox", args: ["-d", "-r", String(rate), "-c", "1", "-b", "16", "{file}"] },
  ]

  if (platform() === "darwin") {
    all.unshift({
      cmd: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":0", "-ar", String(rate), "-ac", "1", "-y", "{file}"],
    })
  }
  if (platform() === "win32") {
    let devices = device ? [device] : []
    if (!device && (recorder === "auto" || recorder === "ffmpeg")) {
      if (discovered) devices = [...discovered]
      else {
        const listing = cp.spawnSync("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
          encoding: "utf8",
          timeout: 10000,
          windowsHide: true,
        })
        devices = parseWindowsAudioDevices(listing.stderr ?? "")
      }
      // Prefer physical microphones to loopbacks and virtual cables when both are present.
      devices.sort((a, b) => Number(/virtual|stereo mix|loopback|cable/i.test(a)) - Number(/virtual|stereo mix|loopback|cable/i.test(b)))
    }
    if (!devices.length) devices = ["default"]
    all.unshift(...devices.map((name) => ({
      cmd: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-f", "dshow", "-i", `audio=${name}`, "-ar", String(rate), "-ac", "1", "-y", "{file}"],
    })))
  }

  if (recorder && recorder !== "auto") {
    // Honour an explicit choice exactly: if the user asked for a recorder we do
    // not know about, fail loudly instead of silently using a different one.
    return all.filter((candidate) => candidate.cmd === recorder)
  }
  return all
}

export async function trySpawn(
  cp: typeof import("node:child_process"),
  candidate: Candidate,
  file: string,
  signal?: AbortSignal,
): Promise<{ child: ChildProcess; stderr: () => string }> {
  signal?.throwIfAborted()
  const isFfmpeg = candidate.cmd === "ffmpeg"
  const args = [
    ...(isFfmpeg ? ["-progress", "pipe:1", "-stats_period", "0.25", "-nostats"] : []),
    ...candidate.args.map((arg) => arg.replaceAll("{file}", file)),
  ]
  const child = cp.spawn(candidate.cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  let stderr = ""
  child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4000) })
  child.stdin?.on("error", () => {})
  if (!isFfmpeg) child.stdout?.resume()

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let progress = ""
    let grace: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => fail(new Error(stderr.trim() || "Timed out waiting for microphone audio")), 15000)
    const cleanup = () => {
      clearTimeout(timeout)
      if (grace) clearTimeout(grace)
      child.off("exit", onExit)
      signal?.removeEventListener("abort", onAbort)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        child.kill("SIGKILL")
      } catch {
        // ignore
      }
      reject(error)
    }
    const ready = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onExit = (code: number | null) => fail(new Error(stderr.trim() || `Recorder exited before capturing audio (exit ${code})`))
    const onAbort = () => fail(signal?.reason ?? new Error("Recording cancelled"))
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    child.once("error", (error) => fail(error as Error))
    child.once("exit", onExit)
    if (isFfmpeg) {
      child.stdout?.on("data", (chunk) => {
        if (settled) return
        progress = (progress + String(chunk)).slice(-4000)
        const times = [...progress.matchAll(/(?:^|\r?\n)out_time_(?:us|ms)=(\d+)/g)]
        if (times.some((match) => Number(match[1]) > 0)) ready()
      })
    }
    child.once("spawn", () => {
      if (isFfmpeg) return
      grace = setTimeout(() => {
        if (settled) return
        if (child.exitCode === null && child.signalCode === null) {
          ready()
        } else {
          fail(new Error(stderr.trim() || "exited immediately"))
        }
      }, 350)
    })
  })

  return { child, stderr: () => stderr }
}

async function terminate(child: ChildProcess, isFfmpeg: boolean): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve()
    }
    child.once("exit", finish)
    try {
      if (isFfmpeg && child.stdin?.writable) child.stdin.end("q\n")
      else if (platform() === "win32") child.kill()
      else child.kill("SIGINT")
    } catch {
      finish()
      return
    }
    timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL")
        } catch {
          // ignore
        }
      }
      finish()
    }, 4000)
  })
}
