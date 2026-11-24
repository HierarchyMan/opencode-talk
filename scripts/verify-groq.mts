// Manual integration check: send synthetic silence, not microphone audio.
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../src/config.js"

const cfg = resolveConfig(undefined)
if (cfg.backend !== "api" || !cfg.apiKey) throw new Error("Groq API is not configured")
const dir = await mkdtemp(join(tmpdir(), "opencode-voice-api-test-"))
try {
  const file = join(dir, "silence.wav")
  const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", "-y", file], { encoding: "utf8" })
  if (generated.status !== 0) throw new Error(`Could not generate test audio: ${generated.stderr}`)
  const form = new FormData()
  form.append("model", cfg.model)
  form.append("file", new Blob([await readFile(file)], { type: "audio/wav" }), "silence.wav")
  const response = await fetch(`${cfg.baseURL.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`Groq transcription request failed with HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json() as { text?: unknown }
  if (typeof body.text !== "string") throw new Error("Groq did not return a transcript field")
  console.log(`Groq transcription API OK (${response.status}, ${cfg.model}; synthetic silence only)`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
