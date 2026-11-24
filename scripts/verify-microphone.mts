// Manual integration check: records briefly, verifies the WAV, and deletes it.
import { spawnSync } from "node:child_process"
import { startRecording } from "../src/recorder.js"

const recording = await startRecording({ recorder: "ffmpeg" })
try {
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const { file, durationMs } = await recording.stop()
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" })
  const duration = Number(probe.stdout.trim())
  if (probe.status !== 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid WAV: ${probe.stderr}`)
  }
  console.log(`Microphone recording OK: ${duration.toFixed(2)}s WAV (capture ${durationMs}ms)`)
} finally {
  await recording.abort()
}
