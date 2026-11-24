import { createSignal, Show } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"

/** A persistent indicator in every visible prompt footer. */
export function recordingIndicator(context: Context) {
  const [active, setActive] = createSignal(false)
  const [lit, setLit] = createSignal(true)
  let timer: ReturnType<typeof setInterval> | undefined
  const unregister = context.ui.slot({
    append: "prompt.footer.status",
    render: () => (
      <Show when={active()}>
        <text fg="#ff3030">{lit() ? "●" : " "}</text>
      </Show>
    ),
  })
  return {
    set(value: boolean) {
      if (timer) clearInterval(timer)
      timer = undefined
      setLit(true)
      setActive(value)
      if (value) timer = setInterval(() => setLit((previous) => !previous), 600)
    },
    dispose() {
      if (timer) clearInterval(timer)
      timer = undefined
      setActive(false)
      unregister()
    },
  }
}
