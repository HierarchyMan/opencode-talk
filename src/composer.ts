/**
 * OpenCode 2.4 does not expose its composer through the plugin API.
 * Isolate the small, version-sensitive adapter here and fail closed if the
 * focused editor is a dialog, shell, or an unfamiliar future widget.
 */
export interface Composer {
  readonly focused: boolean
  readonly isDestroyed: boolean
  readonly plainText: string
  readonly traits?: { readonly owner?: string; readonly role?: string; readonly status?: string }
  readonly getClipboardText?: unknown
  readonly cursorOffset: number
  readonly editBuffer: {
    offsetToPosition(offset: number): { row: number; col: number } | null | undefined
  }
  getTextRange(start: number, end: number): string
  hasSelection(): boolean
  deleteRange(startRow: number, startCol: number, endRow: number, endCol: number): void
  insertText(text: string): void
}

export function focusedComposer(renderer: unknown): Composer | undefined {
  const editor = (renderer as { currentFocusedEditor?: Composer } | undefined)?.currentFocusedEditor
  if (!editor || editor.isDestroyed || !editor.focused) return
  if (editor.traits?.owner !== "opencode" || editor.traits.role !== "prompt" || editor.traits.status === "SHELL") return
  if (typeof editor.getClipboardText !== "function" || typeof editor.getTextRange !== "function" ||
      typeof editor.insertText !== "function" || typeof editor.deleteRange !== "function" ||
      typeof editor.hasSelection !== "function" || typeof editor.editBuffer?.offsetToPosition !== "function") return
  return editor
}

/** Remove only a complete inline command immediately before the caret. */
export function consumeVoiceTrigger(editor: Composer, token = "/voice"): boolean {
  if (editor.hasSelection()) return false
  const end = editor.cursorOffset
  if (end < token.length) return false
  const before = editor.getTextRange(0, end)
  if (!before.endsWith(token)) return false
  const prefix = before.slice(0, -token.length)
  if (prefix && !/\s$/u.test(prefix)) return false
  const from = editor.editBuffer.offsetToPosition(end - token.length)
  const to = editor.editBuffer.offsetToPosition(end)
  if (!from || !to) return false
  editor.deleteRange(from.row, from.col, to.row, to.col)
  return true
}

/** Insert at the current caret without replacing the draft or its attachments. */
export function insertTranscript(editor: Composer, text: string): boolean {
  const value = text.trim()
  if (!value || editor.isDestroyed || !editor.focused || editor.hasSelection()) return false
  const offset = editor.cursorOffset
  const before = editor.getTextRange(0, offset)
  const after = editor.getTextRange(offset, offset + 1)
  const left = before && !/\s$/u.test(before) ? " " : ""
  const right = after && !/^[\s.,!?;:)\]}]/u.test(after) ? " " : ""
  try {
    editor.insertText(`${left}${value}${right}`)
    return true
  } catch {
    return false
  }
}
