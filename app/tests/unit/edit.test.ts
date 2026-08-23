/**
 * The editor's agent path, where it meets the model's budget.
 *
 * This file exists because of one live failure. `runLocalEdit` hard-coded 4096
 * output tokens with a comment explaining that an edit "rewrites one field" —
 * true while the editor bar was its only caller. The director then began
 * sending it a long brief and asking for a state plus two reactions at full
 * prose density, and on a real Cerebras session GLM spent the entire allowance
 * on reasoning tokens (they come out of the same budget) and returned
 * `finish_reason: length` with an empty message three times running. The
 * platform had already met this and fixed it the same way — `max_completion_tokens:
 * 16384`, "the old 2048 truncated extensive edits".
 *
 * So the budget is a parameter now, and this is what stops it silently becoming
 * a constant again.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalWorldStore } from '../../src/world/store/local'
import { fileStore, defaultStorePath } from '../../src/world/store/file.node'
import { runLocalEdit, EDIT_MAX_TOKENS } from '../../src/author/agent/edit'
import { runTool, root } from '../../src/tool'
import type { LLMProvider, LLMRequest } from '../../src/provider/types'

function stubLLM(reply: string): LLMProvider & { seen: LLMRequest[] } {
  const seen: LLMRequest[] = []
  return {
    id: 'stub',
    label: 'stub',
    seen,
    isConfigured: () => true,
    async complete(req: LLMRequest): Promise<string> {
      seen.push(req)
      return reply
    },
  }
}

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'studio-edit-'))
  const store = new LocalWorldStore(fileStore(defaultStorePath({ STUDIO_HOME: dir })))
  const created = await store.createWorld({ premise: 'a beaver exploring Atlantis' }, 'test')
  // The same bridge the app hands the agent — `author.ops` has to be the real
  // one, or a budget test could pass over a graph that never got written.
  const tools = {
    run: (path: string, input: Record<string, unknown>, opts?: { origin?: 'app' | 'agent' }) =>
      runTool(root, path, input, { store, origin: opts?.origin ?? 'app', json: false }),
  }
  return { store, tools, id: created.worldId ?? '', dir }
}

const ONE_EDIT = JSON.stringify({
  reply: 'Gave the opening some weather.',
  ops: [{ op: 'update_state', id: 'opening', patch: { base: 'A rear-view shot of a beaver at the gates of a sunken city, silt turning in the light.' } }],
})

test('the answer budget is a PARAMETER, and the caller\'s value is what the model gets', async () => {
  const { store, tools, id, dir } = await fresh()
  try {
    const llm = stubLLM(ONE_EDIT)
    await runLocalEdit({ llm, store, tools, worldId: id, instruction: 'more silt', maxTokens: 16000 })
    assert.equal(llm.seen[0]?.maxTokens, 16000, 'a graph-scale caller gets a graph-scale budget')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('and without one, the editor keeps the budget sized for a single edit', async () => {
  const { store, tools, id, dir } = await fresh()
  try {
    const llm = stubLLM(ONE_EDIT)
    const res = await runLocalEdit({ llm, store, tools, worldId: id, instruction: 'more silt' })
    assert.equal(llm.seen[0]?.maxTokens, EDIT_MAX_TOKENS)
    assert.equal(res.applied, 1, 'and the edit still lands')
    const scene = await store.getScene(id)
    assert.match(scene.states['opening']?.base ?? '', /silt turning in the light/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
