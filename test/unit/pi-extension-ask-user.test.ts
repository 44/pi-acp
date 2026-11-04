import { test } from 'node:test'
import assert from 'node:assert/strict'
import askUserExtension from '../../src/pi-extension-ask-user.js'

type Tool = {
  name: string
  label: string
  description: string
  promptSnippet?: string
  promptGuidelines?: string[]
  exposure?: string
  executionMode?: string
  parameters: Record<string, unknown>
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>
}

type UiTranscript = string[]

function harness(opts: { select?: string | undefined; input?: string | undefined; hasUI?: boolean } = {}) {
  const tools: Tool[] = []
  askUserExtension({ registerTool: tool => tools.push(tool as unknown as Tool) })
  const tool = tools.find(t => t.name === 'ask_user')
  assert.ok(tool, 'registers the ask_user tool')

  const calls: UiTranscript = []
  const ctx = {
    hasUI: opts.hasUI ?? true,
    ui: {
      select: async (title: string, options: string[]) => {
        calls.push(`select:${options.join('|')}`)
        return 'select' in opts ? opts.select : options[0]
      },
      input: async (title: string) => {
        calls.push(`input:${title}`)
        return 'input' in opts ? opts.input : 'typed'
      }
    }
  }

  const run = (params: unknown) => tool.execute('call-1', params, undefined, undefined, ctx)
  return { tool, run, calls }
}

test('ask_user: is model-only and blocks sibling calls in the same turn', () => {
  const { tool } = harness()

  assert.equal(tool.exposure, 'model-only')
  assert.equal(tool.executionMode, 'sequential')
  assert.match(tool.description, /ask the user/i)
  assert.ok(tool.promptSnippet, 'ships a prompt snippet so the model knows when to ask')
  assert.match(tool.promptGuidelines!.join(' '), /context/)
})

test('ask_user: parameters describe a single question with optional titled options', () => {
  const { tool } = harness()
  const properties = tool.parameters.properties as Record<string, any>

  assert.deepEqual(tool.parameters.required, ['question'])
  assert.equal(properties.question.type, 'string')
  assert.equal(properties.options.type, 'array')
  assert.deepEqual(properties.options.items.required, ['title'])
  assert.deepEqual(Object.keys(properties.options.items.properties).sort(), ['description', 'title'])
  assert.equal(properties.allowFreeform.type, 'boolean')
})

test('ask_user: offers options plus a freeform escape hatch and returns the chosen label', async () => {
  const { run, calls } = harness({ select: 'Beta' })

  const result = await run({
    question: 'Which model?',
    context: 'Found two candidates.',
    options: [{ title: 'Alpha' }, { title: 'Beta', description: 'faster' }]
  })

  assert.deepEqual(calls, ['select:Alpha|Beta — faster|Other (type an answer)'])
  assert.equal(result.content[0].text, 'Beta')
  assert.deepEqual(result.details, {
    question: 'Which model?',
    options: ['Alpha', 'Beta — faster'],
    answer: 'Beta',
    cancelled: false
  })
})

test('ask_user: asks for typed text when the user picks the freeform option', async () => {
  const { run, calls } = harness({ select: 'Other (type an answer)', input: 'something custom' })

  const result = await run({ question: 'Which model?', options: [{ title: 'Alpha' }] })

  assert.deepEqual(calls, ['select:Alpha|Other (type an answer)', 'input:Which model?'])
  assert.equal(result.content[0].text, 'something custom')
  assert.equal(result.details.cancelled, false)
})

test('ask_user: goes straight to typed input when no options are given', async () => {
  const { run, calls } = harness({ input: 'free text' })

  const result = await run({ question: 'What should I name it?' })

  assert.deepEqual(calls, ['input:What should I name it?'])
  assert.equal(result.content[0].text, 'free text')
})

test('ask_user: reports cancellation without failing the turn', async () => {
  const { run } = harness({ select: undefined })

  const result = await run({ question: 'Proceed?', options: [{ title: 'Yes' }] })

  assert.equal(result.details.cancelled, true)
  assert.equal(result.details.answer, null)
  assert.match(result.content[0].text, /cancelled/)
})

test('ask_user: tells the model to ask in chat when there is no interactive UI', async () => {
  const { run } = harness({ hasUI: false })

  await assert.rejects(
    () => run({ question: 'Which one?', options: [{ title: 'A' }, { title: 'B' }] }),
    /Ask the user in chat/
  )
})

test('ask_user: rejects an empty question', async () => {
  const { run } = harness()

  await assert.rejects(() => run({ question: '   ' }), /non-empty "question"/)
})
