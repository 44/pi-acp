/**
 * `ask_user` tool for `pi-acp`.
 *
 * The model cannot reach the user on its own: `extension_ui_request` only exists because an extension
 * called `ctx.ui.*`, and pi's built-in tools never do. Without a model-facing tool the model guesses
 * or stalls instead of asking, no matter which ACP capabilities the client advertises. This extension
 * (bundled with pi-acp, loaded via `--extension`) registers that tool; pi-acp then maps the resulting
 * `select`/`confirm`/`input` dialogs onto ACP requests.
 *
 * The tool shape is deliberately small — one focused question per call, optional options, optional
 * freeform answer. Anything richer (multi-question batches, multi-select, comments, overlay chrome) is
 * TUI-only and has no ACP representation, so it is left out rather than faked.
 *
 * `parameters` is a plain JSON Schema object: pi validates arguments against JSON Schema and
 * providers consume it directly, so no TypeBox dependency is needed at load time.
 *
 * Types are declared locally on purpose: pi-acp drives pi over RPC and does not depend on
 * `@earendil-works/pi-coding-agent`. Pi injects the real API at load time.
 */

type AskUserOption = { title: string; description?: string }

type AskUserParams = {
  question?: unknown
  context?: unknown
  options?: unknown
  allowFreeform?: unknown
}

type AskUserResult = {
  content: Array<{ type: 'text'; text: string }>
  details: {
    question: string
    options: string[]
    answer: string | null
    cancelled: boolean
  }
}

type AskUserContext = {
  hasUI?: boolean
  ui?: {
    select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>
    input?: (title: string, placeholder?: string, opts?: unknown) => Promise<string | undefined>
  }
}

interface PiAskUserApi {
  registerTool: (tool: {
    name: string
    label: string
    description: string
    promptSnippet?: string
    promptGuidelines?: string[]
    /** Only the model may call it: codemode scripts must not be able to open prompts. */
    exposure?: 'model-only' | 'deferred' | 'always'
    /** Blocks sibling tool calls in the same turn, so side effects cannot run before the answer. */
    executionMode?: 'sequential' | 'parallel'
    parameters: Record<string, unknown>
    execute: (
      toolCallId: string,
      params: AskUserParams,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: AskUserContext
    ) => Promise<AskUserResult>
  }) => void
}

const FREEFORM_OPTION = 'Other (type an answer)'

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    question: {
      type: 'string',
      description: 'The single question to ask the user.'
    },
    context: {
      type: 'string',
      description: 'Short summary of what you already found, shown above the question (optional).'
    },
    options: {
      type: 'array',
      description: 'Choices to offer. Omit for a free-form answer.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Short title for this option' },
          description: { type: 'string', description: 'Optional detail explaining the option' }
        },
        required: ['title']
      }
    },
    allowFreeform: {
      type: 'boolean',
      description: `Also allow a typed answer alongside the options. Default: true.`
    }
  },
  required: ['question']
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeOptions(value: unknown): AskUserOption[] {
  if (!Array.isArray(value)) return []

  const options: AskUserOption[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const title = asText(entry)
      if (title) options.push({ title })
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const title = asText(rec.title)
    if (!title) continue
    const description = asText(rec.description)
    options.push(description ? { title, description } : { title })
  }
  return options
}

/** The dialog title: question first, context folded in as a trailing paragraph. */
function dialogTitle(question: string, context: string | null): string {
  return context ? `${question}\n\n${context}` : question
}

function finish(question: string, options: string[], answer: string | null, cancelled: boolean): AskUserResult {
  const text = cancelled ? `The user cancelled the question: ${question}` : (answer ?? 'The user did not answer.')

  return {
    content: [{ type: 'text', text }],
    details: { question, options, answer, cancelled }
  }
}

async function ask(
  params: AskUserParams,
  signal: AbortSignal | undefined,
  ctx: AskUserContext
): Promise<AskUserResult> {
  const question = asText(params.question)
  if (!question) {
    throw new Error('ask_user needs a non-empty "question".')
  }

  const context = asText(params.context)
  const options = normalizeOptions(params.options)
  const labels = options.map(option => (option.description ? `${option.title} — ${option.description}` : option.title))
  const allowFreeform = params.allowFreeform !== false
  const title = dialogTitle(question, context)

  const ui = ctx.ui
  if (!ctx.hasUI || !ui?.select || !ui.input) {
    // No interactive surface: surface the question as an error so the model asks in chat instead.
    const optionText = labels.length > 0 ? `\n\nOptions:\n${labels.map(label => `- ${label}`).join('\n')}` : ''
    throw new Error(`No interactive UI is available. Ask the user in chat:\n\n${title}${optionText}`)
  }

  if (signal?.aborted) {
    return finish(question, labels, null, true)
  }

  if (labels.length === 0) {
    const typed = await ui.input(title, 'Type your answer...')
    const answer = asText(typed)
    return finish(question, labels, answer, answer === null)
  }

  const choices = allowFreeform ? [...labels, FREEFORM_OPTION] : labels
  const chosen = await ui.select(title, choices)
  if (chosen === undefined) {
    return finish(question, labels, null, true)
  }

  if (chosen === FREEFORM_OPTION) {
    const typed = await ui.input(title, 'Type your answer...')
    const answer = asText(typed)
    return finish(question, labels, answer, answer === null)
  }

  return finish(question, labels, chosen, false)
}

export default function (pi: PiAskUserApi): void {
  pi.registerTool({
    name: 'ask_user',
    label: 'Ask User',
    description:
      'Ask the user a focused question, optionally with multiple-choice answers. Use it when intent is ambiguous, a decision needs explicit approval, or several valid options exist — instead of guessing.',
    promptSnippet:
      'Ask the user one focused question (with optional multiple-choice answers) when guessing would be worse than asking',
    promptGuidelines: [
      'Gather context with tools first, then ask; pass a short summary via the context field so the question stands alone.',
      'Ask one focused question per call. Ask follow-up questions in a later call rather than combining unrelated ones.',
      'Prefer options over open-ended text when the plausible answers are enumerable.'
    ],
    exposure: 'model-only',
    executionMode: 'sequential',
    parameters: PARAMETERS,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => ask(params, signal, ctx)
  })
}
