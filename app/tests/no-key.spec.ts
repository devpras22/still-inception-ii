import { test, expect, FTUE_SEEN_KEY } from './fixtures'

/**
 * The central claim of this project, tested end to end: a stranger who clones
 * the repo and runs it — with no account, no API key, no .env — gets a studio
 * they can actually author and play a world in.
 *
 * This is deliberately not a unit test. The regression it guards against is not
 * "a function returned the wrong value", it is "the app compiles and builds
 * perfectly and still shows a login wall to someone who has nothing". That
 * failure survives every typecheck.
 *
 * Every test here starts from a genuinely empty browser: no localStorage, so no
 * provider config, no saved worlds, no key.
 */

// No storage-clearing hook here on purpose. Playwright gives every test a fresh
// browser context, so localStorage starts empty already — and an addInitScript
// that clears it would re-run on EVERY navigation, including the page.reload()
// in the persistence test below, wiping the data that test exists to check.

test('boots into the studio with no key, not a connect wall', async ({ page }) => {
  await page.goto('/')

  // The shell itself.
  await expect(page.getByText('ALAKAZAM STUDIO')).toBeVisible()

  // The old build gated here: with no key it rendered ONLY a "Connect to
  // Alakazam" panel and nothing else. Assert the real studio instead — the nav
  // rail is the thing that could not exist behind the gate.
  await expect(page.getByRole('button', { name: /My Creations/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open the floating world composer' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Community/ })).toBeVisible()

  // And the gate copy must be absent, not merely off-screen.
  await expect(page.getByText('Connect to Alakazam')).toHaveCount(0)
})

test('says worlds are local when no hosted key is configured', async ({ page }) => {
  await page.goto('/')
  // The top bar tells you where your work is going. With no key that has to say
  // this browser, because that is where the local store puts it.
  await expect(page.getByText(/worlds · this browser/)).toBeVisible()
  await expect(page.getByText(/world · mock/)).toBeVisible()
})

test('authoring works offline: create a world and open it', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /My Creations/ }).click()

  // Empty state or existing cards — both fine on a fresh profile.
  const before = await page.locator('.world-card').count()

  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  const name = `offline probe ${Date.now()}`
  const input = page.locator('input[type="text"], textarea').first()
  await input.fill(name)

  // Whatever the create affordance is called, it must not require a key.
  const createBtn = page.getByRole('button', { name: /^(Generate|↑ Generate|Create|New|Blank|Start)/ }).first()
  await createBtn.click()

  // Creating drops you straight into the graph editor, so the editor rendering a
  // real graph IS the proof the world exists and was read back from the store.
  const graph = page.locator('.overlay svg').first()
  await expect(graph).toBeVisible({ timeout: 30_000 })

  // Close the editor (it overlays the nav) and confirm the world persisted.
  await page.getByRole('button', { name: 'Close' }).first().click()
  await page.getByRole('button', { name: /My Creations/ }).click()
  await expect
    .poll(async () => page.locator('.world-card').count(), { timeout: 20_000 })
    .toBeGreaterThan(before)
})

test('a world authored offline survives a reload', async ({ page }) => {
  // The trap this guards: an in-memory store looks identical to a persistent one
  // until the tab closes, and then a creator's work is gone. localStorage or not,
  // the promise is that authoring offline keeps the world.
  await page.goto('/')
  await page.getByRole('button', { name: /My Creations/ }).click()
  const before = await page.locator('.world-card').count()

  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.locator('input[type="text"], textarea').first().fill(`persist probe ${Date.now()}`)
  await page.getByRole('button', { name: /^(Generate|↑ Generate|Create|New|Blank|Start)/ }).first().click()
  await expect(page.locator('.overlay svg').first()).toBeVisible({ timeout: 30_000 })

  // Reload WITHOUT clearing storage — beforeEach only clears on first load.
  // Land on the bare URL: view state is addressable now, so reloading the deep
  // link would reopen the editor over the list. That behaviour has its own test
  // below; this one is about the world still existing.
  await page.goto('/')
  await page.getByRole('button', { name: /My Creations/ }).click()
  await expect
    .poll(async () => page.locator('.world-card').count(), { timeout: 20_000 })
    .toBeGreaterThan(before)
})

test('view state is addressable: every state that matters has a URL', async ({ page }) => {
  // A state reachable only by clicking cannot be verified repeatedly, which is
  // why this is a product requirement and not a testing convenience. The capture
  // harness and the live-provider runs both open the studio already in the state
  // under test rather than clicking their way there.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  // The editor put the world in the URL, and it survives a reload.
  const worldId = new URL(page.url()).searchParams.get('world')
  expect(worldId).toBeTruthy()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  // The player is addressable too, from a cold load.
  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 20_000 })

  // And so is settings, which is how a verification run reaches it without
  // three clicks through a modal.
  await page.goto('/?settings=1')
  await expect(page.getByRole('button', { name: 'Save providers' })).toBeVisible({ timeout: 15_000 })

  // A hand-edited URL must never render a broken studio.
  await page.goto('/?section=nonsense&world=')
  await expect(page.getByRole('heading', { name: 'My Creations' })).toBeVisible()
})

test('Settings offers the provider choices and states where keys are kept', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings' }).click()

  // Both axes must be reachable without any credential.
  await expect(page.getByText(/reactor/i).first()).toBeVisible()
  await expect(page.getByText(/websocket/i).first()).toBeVisible()

  // The promise made to anyone typing a secret into a web page.
  await expect(page.getByText(/localStorage/i).first()).toBeVisible()
})

test('play actually renders a picture, not just a green capability chip', async ({ page }) => {
  // The regression this exists for: the mount node had a React child, so React
  // wiped the provider's canvas the moment the status line cleared. Capabilities
  // said "streaming ✓" over a blank rectangle. Asserting the chip would have
  // passed; only asserting PIXELS catches it.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.locator('input[type="text"], textarea').first().fill('a quiet street at dusk')
  await page.getByRole('button', { name: /^(Generate|↑ Generate|Create|New|Blank|Start)/ }).first().click()
  await expect(page.locator('.overlay svg').first()).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Close' }).first().click()

  await page.getByRole('button', { name: /My Creations/ }).click()
  const play = page.locator('.world-card').first().getByRole('button', { name: /Play/ })
  await play.click()

  // The mock provider paints into a canvas. It must exist, have real size, and
  // still be attached after the status line clears.
  const canvas = page.locator('.overlay canvas').first()
  await expect(canvas).toBeVisible({ timeout: 30_000 })
  const box = await canvas.boundingBox()
  expect(box!.width).toBeGreaterThan(200)
  expect(box!.height).toBeGreaterThan(150)

  // And it must be ANIMATING — a frozen first frame is the other way this fails.
  const sample = () => canvas.evaluate((c: HTMLCanvasElement) =>
    (c as HTMLCanvasElement).toDataURL().slice(-2000))
  const a = await sample()
  await page.waitForTimeout(1500)
  const b = await sample()
  expect(a).not.toEqual(b)

  // The play-time inspector: the traversal over the EXACT prompt being
  // streamed. It reads the world, so it works on every provider — and it is
  // the surface that would silently render an empty column if the scene ever
  // stopped reaching the player.
  await expect(page.getByText('timeline', { exact: false })).toBeVisible()
  await expect(page.getByText('state graph', { exact: false })).toBeVisible()
  await expect(page.getByText('branches', { exact: false })).toBeVisible()
  // The char count is the kernel's own budget, not a decoration: it must show
  // a real assembled length against 1900.
  await expect(page.getByText(/\d+\/1900/)).toBeVisible()
  // …and the prompt column must hold the state's actual prose.
  await expect(page.locator('.playspect-layer-text').first()).not.toBeEmpty()

  // It hides and comes back.
  await page.locator('.playspect-head').getByRole('button', { name: '×' }).click()
  await expect(page.locator('.playspect')).toHaveCount(0)
  await page.getByRole('button', { name: /inspector/ }).click()
  await expect(page.locator('.playspect')).toHaveCount(1)
})

test('the example world is reachable and has a real graph', async ({ page }) => {
  // The starter world existed in the store from day one but no UI path passed
  // template:'starter', so a new user's first world was one empty state and the
  // artifact built to teach the graph was unreachable.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()

  const graph = page.locator('.overlay svg').first()
  await expect(graph).toBeVisible({ timeout: 30_000 })

  // Three states and two transitions — a graph, not a lone node. Node labels are
  // SVG text, so counting them is the cheapest honest assertion of "real graph".
  await expect
    .poll(async () => graph.locator('text').count(), { timeout: 15_000 })
    .toBeGreaterThan(3)
})

test('playing a world sends what you authored, and the rail obeys the capability', async ({ page }) => {
  // The regression this guards is not cosmetic. PlayModal used to call
  // connect({ worldId }) and stop there: no opening prompt, no first frame, and
  // no path in the whole studio that ever reached sendEvent. You could author a
  // graph, press Play, and none of it was sent to the world model — while a row
  // of green capability ticks sat above the picture. The mock said it plainly:
  // "no prompt — the studio sent none for this world".
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()

  // The example world exists to be the thing with a real graph in it.
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  await page.locator('.overlay').getByRole('button', { name: /Play/ }).click()

  // The rail proves the studio READ the authored events — it never did before.
  const rail = page.getByText('send a beat:')
  await expect(rail).toBeVisible({ timeout: 15_000 })
  const beat = page.getByRole('button', { name: /walk up the lane/i })
  await expect(beat).toBeVisible()

  // The mock reports promptableEvents: true and means it, so the beat is live.
  await expect(beat).toBeEnabled({ timeout: 15_000 })
  await beat.click()

  // It went through: no error surfaced, and the machine advanced — the rail now
  // offers what leads out of the state we just entered, not what we just used.
  await expect(page.locator('.diag.error')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /go to the bench/i })).toBeVisible({ timeout: 10_000 })
})

test('the state machine actually moves, and only offers legal beats', async ({ page }) => {
  // Asserted against the mock's CANVAS, not the DOM, because the DOM was not
  // where this lied. The rail sent every beat as kind:'prompt'; the mock only
  // moves its state readout on kind:'state', so the HUD sat on the literal
  // string "entrance" — an id no authored world contains — for the whole
  // session while the event counter climbed. It looked exactly like a working
  // state machine. Hook fillText and read what is really drawn.
  await page.addInitScript(() => {
    ;(window as unknown as { __hud: string[] }).__hud = []
    const orig = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) {
      ;(window as unknown as { __hud: string[] }).__hud.push(String(text))
      return (orig as (this: CanvasRenderingContext2D, ...a: unknown[]) => void).apply(this, [text, ...rest])
    } as typeof CanvasRenderingContext2D.prototype.fillText
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  await page.locator('.overlay').getByRole('button', { name: /Play/ }).click()
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 15_000 })

  const hudHas = async (needle: string) =>
    (await page.evaluate(() => (window as unknown as { __hud: string[] }).__hud)).some((t) => t.includes(needle))

  // Opens on the real entrance state, not the phantom "entrance".
  await expect.poll(() => hudHas('lane'), { timeout: 10_000 }).toBe(true)
  expect(await hudHas('entrance')).toBe(false)

  // Only what is legal from the lane. "go to the bench" is from orchard_gate.
  await expect(page.getByRole('button', { name: /walk up the lane/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /go to the bench/i })).toHaveCount(0)

  await page.getByRole('button', { name: /walk up the lane/i }).click()

  // The machine MOVED: the canvas now names the destination state, and the rail
  // has swapped to the beats that lead out of it.
  await expect.poll(() => hudHas('orchard_gate'), { timeout: 10_000 }).toBe(true)
  await expect(page.getByRole('button', { name: /go to the bench/i })).toBeVisible()
  await expect(page.locator('.diag.error')).toHaveCount(0)

  // The scene prose follows the state, rather than the new state's name sitting
  // above the old state's description.
  await expect.poll(() => hudHas('orchard'), { timeout: 10_000 }).toBe(true)

  // And held input is real: `heldCommands` was a green chip over nothing, since
  // no key handler existed and nothing ever sent kind:'command'.
  await page.locator('body').press('w')
  await expect.poll(() => hudHas('Front'), { timeout: 10_000 }).toBe(true)
})

test('AI authoring runs on YOUR model, and never touches the vendor', async ({ page, context }) => {
  // The whole LLM provider layer — presets, keys, connection test — was called
  // by exactly one thing: the Test connection button. The agent, the only
  // feature that IS AI authoring, posted to the hosted /v1/worlds/:id/edit
  // regardless of what you configured. So a Cerebras or Ollama key proved it
  // worked and was then never used. This asserts the opposite of that.
  await context.addInitScript(() => {
    localStorage.setItem('alakazam-studio:providers:v1', JSON.stringify({
      world: { active: 'mock' },
      llm: {
        active: 'custom',
        endpoints: { custom: { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' } },
      },
    }))
  })

  // Stand in for the user's endpoint. If the studio calls the vendor instead,
  // this never fires and the assertions below fail.
  let llmCalls = 0
  await page.route('http://llm.test/v1/chat/completions', async (route) => {
    llmCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          reply: 'Added a bench you can sit on.',
          ops: [{ op: 'add_state', id: 'sitting_down', base: 'The slats of the bench, close and weathered.' }],
        }) } }],
      }),
    })
  })
  const vendorCalls: string[] = []
  await page.route('**://api.alakazam.gg/**', async (route) => {
    vendorCalls.push(route.request().url())
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"no"}' })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  // The agent is the floating composer over the canvas now, not a sidebar tab.
  // It opens as the PILL over a world that has doctrine lints to read (it
  // would otherwise cover them), so open it the way a person does.
  const pill = page.getByRole('button', { name: /ask the kernel agent/ })
  if (await pill.count()) await pill.click()
  await expect(page.getByText(/runs on/i)).toBeVisible()
  await page.getByPlaceholder(/tell the agent what to change/i).fill('Add a state for sitting on the bench.')
  await page.getByRole('button', { name: 'Send to the kernel agent' }).click()

  // Our endpoint was called, the vendor was not, and the graph really changed.
  await expect.poll(() => llmCalls, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(page.getByText('Added a bench you can sit on.')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('svg text', { hasText: 'sitting_down' }).first()).toBeVisible({ timeout: 15_000 })
  expect(vendorCalls).toEqual([])
})

test('no vendor request escapes a keyless clone', async ({ page }) => {
  // The promise is that nothing is called until you configure something. Two
  // paths broke it: Account fetched /v1/usage unconditionally on first click,
  // and the Vision panel POSTed the user's uploaded frame to the hosted API
  // with an empty bearer. Both showed a 401 and blamed a key the user had
  // never entered — after the bytes had already left the machine.
  // Match on HOST, not on the URL string: the dev server serves
  // /src/providers/llm/openaiCompat.ts, which contains "openai" and is not a
  // vendor request.
  const vendor: string[] = []
  page.on('request', (r) => {
    let host = ''
    try { host = new URL(r.url()).hostname } catch { return }
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return
    vendor.push(`${host} ${r.url()}`)
  })

  await page.goto('/')
  // 'Create' is no longer a section — it is the floating composer, opened below.
  for (const name of ['My Creations', 'Community', 'Account']) {
    await page.getByRole('button', { name, exact: false }).first().click()
    await expect(page.locator('.content')).toBeVisible()
  }
  // Into a world and across the editor tabs, including Vision.
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  for (const tab of ['Validate', 'Versions', 'Vision']) {
    await page.getByRole('button', { name: tab, exact: true }).click()
  }
  // And the agent composer on the canvas. Clicking those tabs collapsed it to
  // its pill (a pointerdown outside the float is how you dismiss it), so
  // reopening and walking popup → panel → bar exercises all three views.
  await page.getByRole('button', { name: /ask the kernel agent|no language model configured/ }).click()
  await page.getByRole('button', { name: '⊟ history' }).click()
  await page.getByRole('button', { name: '✕' }).click()
  await page.waitForTimeout(1000)

  expect(vendor).toEqual([])
})

test('provider settings can be reached and saved on a laptop screen', async ({ page }) => {
  // Found by driving a real browser, missed by every test before it, because
  // they all seeded localStorage and never opened Settings. The modal scrim
  // centred a 1512px panel with flexbox and no overflow, so on a 900px screen
  // "Save providers" sat at y=1111 with nothing to scroll: you could read every
  // provider option and never save one. The entire bring-your-own surface was
  // decoration on any normal laptop.
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/')
  await page.getByRole('button', { name: /Account/ }).click()
  await page.getByRole('button', { name: /Settings/ }).first().click()

  // The furthest control in the panel, below the language-model section.
  const save = page.getByRole('button', { name: 'Save providers' })
  await save.scrollIntoViewIfNeeded()
  const box = await save.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(800)

  // And it actually works from there.
  await save.click()
  await expect(page.getByRole('button', { name: 'Save providers' })).toHaveCount(0)
})

test('a move is CHOREOGRAPHED and an arrival is VERIFIED, not timed', async ({ page }) => {
  // `phases` and `landWhen` are the two capabilities the last three doctrine
  // rules police, and a rule over a field nothing runs is decorative. This is
  // the proof they run: the starter world's first transition is told in two
  // beats, and its second lands on what the picture shows.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: '▶ Play' }).click()
  await expect(page.locator('.overlay canvas').first()).toBeVisible({ timeout: 30_000 })

  // CHOREOGRAPHY: the beats stream one at a time, and the state does NOT move
  // until they are done — that ordering is the whole point of phases.
  await page.getByRole('button', { name: /WALK UP THE LANE/i }).click()
  await expect(page.locator('.playspect-event')).toContainText(/beat 1\/2/, { timeout: 5_000 })
  await expect(page.locator('.playspect-state')).toHaveText('lane', { timeout: 2_000 })
  await expect(page.locator('.playspect-event')).toContainText(/beat 2\/2/, { timeout: 5_000 })
  await expect(page.locator('.playspect-state')).toHaveText('orchard_gate', { timeout: 10_000 })

  // ARRIVAL: the next transition waits for evidence before it lands, and says
  // so while it waits.
  await page.getByRole('button', { name: /GO TO THE BENCH/i }).click()
  await expect(page.locator('.playspect-event')).toContainText(/waiting for arrival|evidence/, { timeout: 5_000 })
  // It lands either way — verified, or fail-open with the reason stated. What
  // must never happen is a player trapped mid-event.
  await expect(page.locator('.playspect-state')).toHaveText('bench_under_trees', { timeout: 15_000 })
})

test('a world that fails the doctrine will not open, and nothing is billed', async ({ page }) => {
  // The studio refuses to REGISTER an invalid world; this is that boundary.
  // Checking before connect() also means a broken world never opens a metered
  // session — the honest failure is the free one.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  // Break it the way a person would: write a negation into a state's prose.
  await page.goto(`/?world=${worldId}&sel=state:lane`)
  await expect(page.getByRole('button', { name: /Save state/ })).toBeVisible({ timeout: 15_000 })
  await page.locator('#insp-state-base').fill('A lane between low stone walls. There are no birds here.')
  await page.getByRole('button', { name: /Save state/ }).click()
  await page.waitForTimeout(600)

  await page.getByRole('button', { name: '▶ Play' }).click()
  await expect(page.getByText(/does not pass the doctrine/i)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/\[negation\]/)).toBeVisible()
  // Refused BEFORE any session: no picture was ever mounted.
  await expect(page.locator('.overlay canvas')).toHaveCount(0)
})

test('firing an anchored CHIP moves the machine, exactly as the rail does', async ({ page }) => {
  // Found on a live session: the rail advanced opening → temple_atrium while the
  // chip for the SAME beat fired and nothing happened. The two share one send(),
  // so a difference between them is a defect in the chip path — and a live world
  // model is the worst possible place to debug one. This pins it deterministically:
  // a stubbed detector puts a chip on screen over the mock provider's canvas, and
  // the chip must move the machine.
  await page.route('**/v1/detect', async (route) => {
    // Centred and large: armed under the aim and proximity gates.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ objects: [{ x_min: 0.3, y_min: 0.3, x_max: 0.7, y_max: 0.7 }] }),
    })
  })
  await page.addInitScript(() => {
    localStorage.setItem('alakazam-studio:providers:v1', JSON.stringify({
      world: { active: 'mock' },
      vision: { endpoint: 'cloud', apiKey: 'test-key', localUrl: '' },
    }))
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  await page.goto(`/?play=${worldId}`)
  await expect(page.locator('.overlay canvas').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.playspect-state')).toHaveText('lane')

  // The starter world's first transition is anchored on "the gap in the wall".
  const chip = page.locator('.chip', { hasText: 'walk up the lane' })
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await expect(chip).toHaveClass(/chip-armed/, { timeout: 20_000 })

  // A REAL mouse press at the chip's own centre — no dispatch, no force. This
  // is the assertion that caught the defect it now guards: chips fire on
  // POINTERDOWN, because a `click` resolves on the common ancestor of press and
  // release, and a chip tracking a live detection moves between the two. With
  // onClick the press landed on the button and the click landed on the
  // container, so a visibly armed chip did nothing at all.
  const box = await chip.boundingBox()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)

  // The SAME outcome the rail produces: the machine advances.
  await expect(page.locator('.playspect-state')).toHaveText('orchard_gate', { timeout: 30_000 })
})

test('a MISSION plays: the quest panel ticks off the flags the rail gates on', async ({ page }) => {
  // A mission ties quest UI, graph, flag ledger and grounding together — so the
  // proof is that the PANEL and the RAIL agree without either being told about
  // the other: both read the same flags. The shipped quest example is itself
  // built by the mission compiler, so this also pins what that compiler emits.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the quest example/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  await page.goto(`/?play=${worldId}`)
  await expect(page.locator('.quest')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.quest-title')).toHaveText('The Delivery')
  const lines = page.locator('.quest-line')
  await expect(lines).toHaveCount(2)
  await expect(lines.first()).toHaveClass(/active/)
  await expect(lines.nth(1)).not.toHaveClass(/done/)

  // The second objective is gated — and it SAYS what unblocks it rather than
  // vanishing, which is what makes a lock read as a lock.
  await expect(page.getByText(/Need: Reach the steel door/)).toBeVisible()

  // Do the first one. The panel ticks, the second goes active, the lock lifts —
  // all three off one flag.
  // Scoped to the RAIL: the same objective also appears as an inspector branch
  // and inside the locked beat's reason, which is three matches for one name.
  await page.locator('.overlay .row').getByRole('button', { name: 'Reach the steel door', exact: true }).click()
  await expect(lines.first()).toHaveClass(/done/, { timeout: 20_000 })
  await expect(lines.nth(1)).toHaveClass(/active/)
  await expect(page.getByText(/Need: Reach the steel door/)).toHaveCount(0)
})

test('an ending ENDS the run', async ({ page }) => {
  // An ending was authored, drawn with its badge, and then played exactly like
  // any other room: the run just stopped somewhere with no exits. (The flag
  // algebra beside it is pure and lives in tests/unit/anchors.test.ts.)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  await page.goto('/')
  await page.getByRole('button', { name: /My Creations/ }).click()
  await page.locator('.world-card').first().getByRole('button', { name: /Play/ }).click()
  await expect(page.locator('.overlay canvas').first()).toBeVisible({ timeout: 30_000 })

  // Walk the world to its authored ending.
  await page.getByRole('button', { name: /WALK UP THE LANE/i }).click()
  await expect(page.locator('.playspect-state')).toHaveText('orchard_gate', { timeout: 20_000 })
  await page.getByRole('button', { name: /GO TO THE BENCH/i }).click()
  await expect(page.locator('.playspect-state')).toHaveText('bench_under_trees', { timeout: 20_000 })

  // The ending LANDS: a card, the right verdict, and a way to run it again.
  const card = page.locator('.ending-card')
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card).toContainText(/YOU WIN|YOU LOSE/)
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()

  // Try again reboots at the entrance rather than leaving you at the end.
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.locator('.playspect-state')).toHaveText('lane', { timeout: 20_000 })
  await expect(card).toHaveCount(0)
})

test('the doctrine panel speaks to a creator, and its one fix works', async ({ page }) => {
  // The panel existed and was invisible on every world, because the rule that
  // fires most often — an anchored interaction with no minimum on-screen size —
  // was simply missing until now. The starter world carries exactly one, on
  // purpose.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  const panel = page.locator('.lint-panel')
  await expect(panel).toBeVisible()
  // The headline is the rule's PLAIN title, not its id.
  const row = panel.locator('.lint-row').filter({ hasText: 'Object might be cut off at the frame edge' })
  await expect(row).toHaveCount(1)

  // "what's this?" opens what it means and how to fix it — the raw code is
  // there too, but it is not the answer.
  await row.getByRole('button', { name: "what's this?" }).click()
  await expect(panel.locator('.lint-what')).toContainText(/minimum on-screen size/i)
  await expect(panel.locator('.lint-rule')).toContainText('[sliver-evidence]')

  // And the Fix writes the graph: the lint is gone afterwards, and it is gone
  // because the WORLD changed — a reload proves it was a write, not a hide.
  await row.getByRole('button', { name: 'Fix' }).click()
  await expect(panel.locator('.lint-row').filter({ hasText: 'Object might be cut off' })).toHaveCount(0, { timeout: 15_000 })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.lint-row').filter({ hasText: 'Object might be cut off' })).toHaveCount(0)
})

test('the editor does not silently destroy authored work', async ({ page }) => {
  // Four separate ways the Inspector lost work, all of which reported success.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  // (1) The ending subtitle. The form had no subtitle field while the schema and
  // the shipped example world both carried one, so pressing Save on an ending
  // state deleted prose the user could not see, edit, or keep.
  await page.locator('svg text', { hasText: 'bench_under_tre' }).first().click()
  const subtitle = page.getByPlaceholder(/Nothing else needed doing/i)
  await expect(subtitle).toBeVisible()
  const authored = await subtitle.inputValue()
  expect(authored.length).toBeGreaterThan(0)
  await page.getByRole('button', { name: /Save state/ }).click()
  await expect(page.getByText('State saved')).toBeVisible({ timeout: 10_000 })
  await expect(subtitle).toHaveValue(authored)

  // (2) The ending checkbox was a one-way switch: unticking it dropped the key
  // from the patch, the merge skipped undefined, and the old value survived —
  // so the UI and the stored world silently disagreed.
  const endingToggle = page.getByRole('checkbox', { name: /ending/i }).first()
  await endingToggle.uncheck()
  await page.getByRole('button', { name: /Save state/ }).click()
  await expect(page.getByText('State saved')).toBeVisible({ timeout: 10_000 })
  await page.reload()
  await page.locator('svg text', { hasText: 'bench_under_tre' }).first().click()
  await expect(page.getByRole('checkbox', { name: /ending/i }).first()).not.toBeChecked()

  // (3) An in-progress edit survives another write in the same panel. The form
  // used to be keyed on `rev`, so any write remounted it and re-read every field
  // from the store, discarding whatever had been typed.
  await page.locator('svg text', { hasText: 'lane' }).first().click()
  const prompt = page.getByPlaceholder(/What the camera sees/).first()
  await prompt.fill('A long rewritten paragraph that must not vanish.')
  await page.getByRole('button', { name: /Set entrance/ }).click()
  await expect(prompt).toHaveValue('A long rewritten paragraph that must not vanish.')
})

test('destructive editor actions ask first', async ({ page }) => {
  // Deleting a state cascades — it removes events and can clear the entrance,
  // leaving a world that cannot be played — and the button sits 8px from Save.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  // Select the state itself, not an edge label that happens to contain "lane".
  await page.locator('svg text').filter({ hasText: /^lane$/ }).first().click()
  await expect(page.getByText(/^State/).first()).toBeVisible({ timeout: 10_000 })

  let asked = ''
  page.once('dialog', (d) => { asked = d.message(); void d.dismiss() })
  await page.locator('.overlay').getByRole('button', { name: /^Delete$/ }).first().click()
  expect(asked).toMatch(/delete the state "lane"/i)

  // Dismissed means nothing happened.
  await expect(page.locator('svg text').filter({ hasText: /^lane$/ }).first()).toBeVisible()

  // And an event delete names the event rather than an empty string.
  await page.locator('svg text').filter({ hasText: /walk_up_the_lane/ }).first().click()
  let askedEvent = ''
  page.once('dialog', (d) => { askedEvent = d.message(); void d.dismiss() })
  await page.locator('.overlay').getByRole('button', { name: /^Delete$/ }).first().click()
  expect(askedEvent).toMatch(/delete the event "walk_up_the_lane"/i)
})

test('?section=api renders the live tool surface', async ({ page }) => {
  // The reference screen walks the SAME tree the CLI dispatches and the app's
  // bridge runs. If it renders these leaves, they exist on every surface at
  // once — a hand-written API page beside the tree could not make that claim.
  await page.goto('/?section=api')
  await expect(page.getByRole('heading', { name: 'API' })).toBeVisible()
  await expect(page.getByText('world create', { exact: true })).toBeVisible()
  await expect(page.getByText('author state add', { exact: true })).toBeVisible()
  await expect(page.getByText('world version restore', { exact: true })).toBeVisible()
  // Every leaf declares its kind, rendered as a pill on each card.
  expect(await page.getByText('mutation', { exact: true }).count()).toBeGreaterThan(5)
})

test('the action log shows tool calls on the keyless path', async ({ page }) => {
  // With no key there are no /v1 HTTP requests at all, and the old HTTP-only
  // log sat permanently empty under a caption claiming every action showed up
  // there. Every action is a tool dispatch — so the log must say so.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.locator('input[type="text"], textarea').first().fill(`log probe ${Date.now()}`)
  await page.getByRole('button', { name: /^(Generate|↑ Generate|Create|New|Blank|Start)/ }).first().click()
  await expect(page.locator('.overlay svg').first()).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Close' }).first().click()

  const log = page.locator('.logpane')
  await expect(log.getByText('world.create').first()).toBeVisible()
  await expect(log.getByText(/tool·mut/).first()).toBeVisible()
})

test('theme is addressable and applied before the app renders', async ({ page }) => {
  // index.html carries its own copy of this precedence — a pre-React inline
  // script stamps data-theme on <html> before first paint, so a light-theme
  // link never flashes dark. Assert against documentElement, not body: that
  // background comes from index.html's inline style, which exists whether or
  // not the app CSS light palette has landed in this working tree.
  await page.goto('/?theme=light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
  expect(bg).toBe('rgb(244, 246, 249)')

  await page.goto('/?theme=dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('the theme toggle persists, and the URL parameter outranks the persisted choice', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(page.url()).toContain('theme=light')
  expect(await page.evaluate(() => localStorage.getItem('alakazam-studio:theme:v1'))).toBe('light')

  // A bare reload has no ?theme=, so the persisted choice is what carries it.
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  // But an explicit URL parameter still wins over that stored 'light'.
  await page.goto('/?theme=dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('the editor tab and selection are addressable by URL', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.locator('.overlay svg').first()).toBeVisible({ timeout: 30_000 })

  const worldId = new URL(page.url()).searchParams.get('world')
  expect(worldId).toBeTruthy()

  // Clicking a tab in the strip updates the URL.
  await page.getByRole('button', { name: 'Versions' }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('versions')

  // A selection deep link opens the Inspector on that state, cold.
  await page.goto(`/?world=${worldId}&sel=state:lane`)
  const stateCard = page.getByText(/^State/).first()
  await expect(stateCard).toBeVisible({ timeout: 15_000 })
  await expect(stateCard).toContainText('lane')

  // A tab deep link opens the Validate panel, cold.
  await page.goto(`/?world=${worldId}&tab=validate`)
  await expect(page.getByRole('heading', { name: 'Validate & Lint' })).toBeVisible({ timeout: 15_000 })
})

test('the DIRECTOR stages what you type mid-play, and plays it', async ({ page, context }) => {
  // The last authoring surface that was missing, and the only one that runs
  // while the world is live. Three things have to be true at once for it to be
  // real, and each has been false at some point: the brief has to commit to
  // what was LITERALLY typed, the kernel's ops have to reach the live rail (a
  // beat list computed at connect time leaves them unpressable), and the
  // authored event has to actually PLAY — a diagnostic found the agent
  // authoring the action and then not asking for it to be played.
  await context.addInitScript(() => {
    localStorage.setItem('alakazam-studio:providers:v1', JSON.stringify({
      world: { active: 'mock' },
      llm: { active: 'custom', endpoints: { custom: { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' } } },
    }))
  })
  await page.addInitScript(() => {
    ;(window as unknown as { __hud: string[] }).__hud = []
    const orig = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) {
      ;(window as unknown as { __hud: string[] }).__hud.push(String(text))
      return (orig as (this: CanvasRenderingContext2D, ...a: unknown[]) => void).apply(this, [text, ...rest])
    } as typeof CanvasRenderingContext2D.prototype.fillText
  })

  const briefs: string[] = []
  await page.route('http://llm.test/v1/chat/completions', async (route) => {
    const body = route.request().postDataJSON() as { messages: { role: string; content: string }[] }
    briefs.push(body.messages.map((m) => m.content).join('\n'))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          reply: 'The wall goes.',
          ops: [
            { op: 'add_state', id: 'lane_dragon', base: 'A rear-view shot of the walker amid splintered hedgerow, the beast coiled across the lane ahead, dust turning in the light.' },
            { op: 'add_event', name: 'a_dragon_smashes_in', kind: 'transition', from: ['lane'], to: 'lane_dragon', base: 'The hedge bursts inward and a scaled head rams through, the walker stumbling back as the lane fills with dust.' },
            { op: 'add_event', name: 'bait_it_away', kind: 'transition', from: ['lane_dragon'], to: 'orchard_gate', base: 'The walker breaks into a run down the lane, the beast wheeling after them.' },
          ],
        }) } }],
      }),
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  await page.locator('.overlay').getByRole('button', { name: /Play/ }).click()
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 15_000 })

  // The composer rests as its pill over the picture, so it never covers the
  // rail underneath — the same rule that moved it off the editor's lint panel.
  await page.getByRole('button', { name: /type what happens next/ }).click()
  await page.getByPlaceholder(/tell the agent what to change/i).fill('a dragon smashes through the hedge')
  await page.getByRole('button', { name: 'Send to the kernel agent' }).click()

  // 1. The brief committed to the literal text, and told the kernel where the
  //    player is standing rather than describing the world in general.
  await expect.poll(() => briefs.length, { timeout: 15_000 }).toBeGreaterThan(0)
  expect(briefs[0]).toContain('a dragon smashes through the hedge')
  expect(briefs[0]).toContain('never a security drone')
  expect(briefs[0]).toContain('`lane`')

  // 2. It PLAYED — the mock's HUD names the state the authored event lands in.
  const hudHas = async (needle: string) =>
    (await page.evaluate(() => (window as unknown as { __hud: string[] }).__hud)).some((t) => t.includes(needle))
  await expect.poll(() => hudHas('lane_dragon'), { timeout: 20_000 }).toBe(true)

  // 3. And the world it authored is on the LIVE rail: standing in the aftermath
  //    state, the reaction it wrote is a button you can press.
  await expect(page.getByRole('button', { name: /bait it away/i })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.diag.error')).toHaveCount(0)
})

test('a CAMPAIGN hands the player from one world into the next, carrying what the edge names', async ({ page }) => {
  // Two worlds joined by a macro-edge. The claim is the hand-off itself: the
  // player finishes act one, and the world underneath them CHANGES — with the
  // flags the edge carries and nothing else. Without this the campaign lints
  // police a mechanic nobody runs.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const actOne = new URL(page.url()).searchParams.get('world')

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the quest example/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const actTwo = new URL(page.url()).searchParams.get('world')
  expect(actOne).not.toEqual(actTwo)

  // Write the campaign into the same database the store reads. Its on-disk
  // shape is the database itself in the browser (the file driver's key-value
  // map is a node-side concern).
  await page.evaluate(({ a, b }) => {
    const KEY = 'alakazam-studio:worlds:v1'
    const db = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    db.campaigns = [{
      id: 'c_e2e',
      title: 'Two Fields',
      graph: {
        start: 'act_1',
        goldenThread: ['act_1', 'act_2'],
        acts: [
          { actId: 'act_1', worldId: a, title: 'The Lane', canonical: true },
          { actId: 'act_2', worldId: b, title: 'The Delivery', canonical: true },
        ],
        edges: [{
          from: { actId: 'act_1', state: 'orchard_gate' },
          to: { actId: 'act_2' },
          kind: 'golden',
          carryFlags: ['walked_the_lane'],
        }],
      },
    }]
    localStorage.setItem(KEY, JSON.stringify(db))
  }, { a: actOne, b: actTwo })

  await page.goto(`/?play=${actOne}&campaign=c_e2e`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })

  // Act one, and it says so — a story that silently swaps worlds reads as a bug.
  const banner = page.locator('.act-banner')
  await expect(banner).toContainText('The Lane')
  await expect(banner).toContainText('act 1 of 2')
  await expect(page.getByRole('button', { name: /walk up the lane/i })).toBeVisible()

  // Cross the exit state. The hand-off fires on ARRIVAL, so the next act's
  // world is what the player is standing in a moment later.
  await page.locator('.overlay .row').getByRole('button', { name: /walk up the lane/i }).click()

  await expect(banner).toContainText('The Delivery', { timeout: 30_000 })
  await expect(banner).toContainText('act 2 of 2')
  await expect(banner).toContainText('carrying walked_the_lane')

  // The rail is act two's now — this beat exists only in the quest world.
  await expect(page.locator('.overlay .row').getByRole('button', { name: 'Reach the steel door', exact: true })).toBeVisible({ timeout: 20_000 })
  // …and act one's is gone.
  await expect(page.getByRole('button', { name: /walk up the lane/i })).toHaveCount(0)
  await expect(page.locator('.diag.error')).toHaveCount(0)
})

test('a macro edge hung on the ENTRANCE does not bounce the player straight out of the chapter', async ({ page }) => {
  // The guard exists because a spine sometimes hangs a macro edge on the
  // entrance ('refuse to leave' / 'leave next morning'), which would bounce
  // the player straight out of the chapter on boot — skipping it entirely.
  //
  // A unit test pins `handoffFor`; this pins the WIRING, which is the part that
  // can silently be nothing: if the player never told the rule which state is
  // the entrance, the rule would agree with itself and the chapter would still
  // be skipped.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const actOne = new URL(page.url()).searchParams.get('world')

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the quest example/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const actTwo = new URL(page.url()).searchParams.get('world')

  await page.evaluate(({ a, b }) => {
    const KEY = 'alakazam-studio:worlds:v1'
    const db = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    db.campaigns = [{
      id: 'c_entrance',
      title: 'Leave Next Morning',
      graph: {
        start: 'act_1',
        goldenThread: ['act_1', 'act_2'],
        acts: [
          { actId: 'act_1', worldId: a, title: 'The Lane', canonical: true },
          { actId: 'act_2', worldId: b, title: 'The Delivery', canonical: true },
        ],
        // FROM THE ENTRANCE — the shape that skips a chapter.
        edges: [{ from: { actId: 'act_1', state: 'lane' }, to: { actId: 'act_2' }, kind: 'golden', carryFlags: [] }],
      },
    }]
    localStorage.setItem(KEY, JSON.stringify(db))
  }, { a: actOne, b: actTwo })

  await page.goto(`/?play=${actOne}&campaign=c_entrance`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })

  // Still in act one, with act one's beats. Give the hand-off ample time to
  // misfire before concluding it did not.
  const banner = page.locator('.act-banner')
  await expect(banner).toContainText('The Lane')
  await expect(page.getByRole('button', { name: /walk up the lane/i })).toBeVisible()
  await page.waitForTimeout(3000)
  await expect(banner).toContainText('The Lane')
  await expect(banner).not.toContainText('The Delivery')
})

test('an authored GATE is replayed over the session that just happened', async ({ page }) => {
  // The eDSL's recogniser, running on real pixels. The starter world's walk to
  // the bench lands on `maxMotion: 12` — "when the scene comes to rest" — and
  // until now an author had no way to know whether their own world ever gets
  // that still. The inspector now answers it from the episode record: a time,
  // or a hit count that never reached the gate's budget.
  //
  // This is the wiring test, not the rule test (the rule is pinned in
  // tests/unit/episode.test.ts). If the player stopped RECORDING, the verdict
  // disappears and this fails — which is the failure worth catching, since a
  // gate readout over an empty record would happily say "never fired".
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })

  // Walk to the state the gated beat leaves from, so the branch is offered.
  await page.locator('.overlay .row').getByRole('button', { name: /walk up the lane/i }).click()
  const gated = page.locator('.playspect-branch', { hasText: 'go_to_the_bench' })
  await expect(gated).toBeVisible({ timeout: 20_000 })

  // THE RECORDING IS REAL. This assertion exists because the first version of
  // this test passed with frame recording deleted: an empty record renders
  // "✕ 0 hits", which is indistinguishable from a session that was watched and
  // never got still. The frame count is the one thing only a live recorder can
  // produce, so it is what the test stands on.
  const size = page.locator('.playspect-episode')
  await expect(size).toBeVisible({ timeout: 20_000 })
  await expect.poll(
    async () => Number(/(\d+) frame/.exec((await size.textContent()) ?? '')?.[1] ?? 0),
    { timeout: 20_000 },
  ).toBeGreaterThan(0)

  // …and the verdict beside it says one of the things it may say. This gate has
  // NOT run yet — nothing has fired it — so it must read as the HYPOTHETICAL
  // (`≈`, replayed from entering the state) and never as a measurement of
  // something that happened. Measured live: while an event was still streaming
  // its phases, this row said "✓ 5.5s" about an arrival that had not begun.
  await expect(gated.locator('.gate-hit, .gate-miss')).toBeVisible({ timeout: 20_000 })
  const verdict = ((await gated.locator('.gate-hit, .gate-miss').textContent()) ?? '').trim()
  expect(verdict).toMatch(/^(≈ \d+\.\d+s|≈ \d+ hits?|○ nothing to ground)$/)
  expect(verdict).not.toContain('nothing to ground')
  await expect(gated.locator('.gate-hit, .gate-miss')).toHaveAttribute('title', /has not run yet/)
})

test('an author can write an arrival GATE by hand, and the doctrine answers immediately', async ({ page }) => {
  // Arrival evidence and phases were authorable by the agent and the CLI and by
  // nobody with hands. That got worse the moment the player started replaying
  // gates over a recorded session: the studio would tell an author their gate
  // never fired and give them no way to change it.
  //
  // The proof is the round trip THROUGH the doctrine: tick "fire during free
  // roam" with no pixel clause and `auto-needs-pixels` must appear — a trigger
  // zone with nothing to watch. Fill in a pixel clause and it must clear. That
  // exercises the editor, the store, and the rule, and none of the three can be
  // absent for it to pass.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  // An event is an EDGE on the canvas, and the edge is the button.
  await page.getByRole('button', { name: 'event walk_up_the_lane' }).click()
  await expect(page.locator('code', { hasText: 'walk_up_the_lane' }).first()).toBeVisible({ timeout: 10_000 })

  const auto = page.getByLabel('also fire during free roam (trigger zone)')
  await expect(auto).toBeVisible()
  await auto.check()
  await page.getByRole('button', { name: 'Save event' }).click()

  // The rule fires on the thing a hand just wrote — and the panel says it in a
  // creator's words, not as a rule id.
  const zoneLint = page.locator('.lint-row').filter({ hasText: 'Auto-trigger has nothing to watch' })
  await expect(zoneLint).toHaveCount(1, { timeout: 20_000 })

  // Give the zone something to watch, and it clears.
  await page.locator('#insp-lw-maxmotion').fill('12')
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(zoneLint).toHaveCount(0, { timeout: 20_000 })

  // And it PERSISTED: a reload shows what was written, not the form's memory.
  await page.reload()
  await page.getByRole('button', { name: 'event walk_up_the_lane' }).click()
  await expect(page.locator('#insp-lw-maxmotion')).toHaveValue('12', { timeout: 15_000 })
  await expect(page.getByLabel('also fire during free roam (trigger zone)')).toBeChecked()
})

test('an A/B VARIANT reaches the model — different words, same seed', async ({ page }) => {
  // `variants` was typed `unknown[]`, written by two ops and read by nothing:
  // the exact shape a feature takes when it exists in the schema and nowhere
  // else. The claim here is the one that was missing — that choosing B changes
  // what is STREAMED, and that A is still there to compare against.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  // Author B on the entrance state, through the editor. Selected by the node's
  // OWN accessible name: `svg text` with "lane" also matches the edge label
  // `walk_up_the_lane`, and the first match is the edge (the other half of the
  // same rule —
  // states are nodes, events are edges, and their TEXT overlaps).
  await page.getByRole('button', { name: 'state lane' }).click()
  await page.getByRole('button', { name: '+ variant' }).click()
  const base = page.getByPlaceholder(/What the camera sees/).first()
  await base.fill('A rear-view shot of the same lane under heavy snow, the ruts filled and the hedges white.')
  await page.getByRole('button', { name: 'Save state' }).click()
  await expect(page.getByText('State saved')).toBeVisible({ timeout: 10_000 })

  // A still says what it always said — writing B must not overwrite the thing
  // it is being compared against.
  await page.getByRole('button', { name: 'A', exact: true }).click()
  await expect(base).not.toHaveValue(/heavy snow/)

  // Play B: the prompt the runtime streams is the VARIANT's prose.
  await page.goto(`/?play=${worldId}&state=lane&variant=B`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.playspect-prompt, .playspect-layer').first()).toContainText(/heavy snow/, { timeout: 20_000 })

  // Play A on the same seed: the original prose, so the two arms differ by the
  // words alone.
  await page.goto(`/?play=${worldId}&state=lane`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.playspect-prompt, .playspect-layer').first()).not.toContainText(/heavy snow/)
})

test('a dragged node stays where it was put, and dragging did not eat the click', async ({ page }) => {
  // Two claims, and the second is the one that breaks quietly: taking the
  // pointer press for a drag is exactly how a `role="button"` node stops being
  // selectable. A layout that persists but costs you selection is a bad trade.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  const node = page.getByRole('button', { name: 'state lane' })
  await expect(node).toBeVisible()

  // A press that does not move is still a CLICK — the node selects.
  await node.click()
  await expect(page.locator('.card strong', { hasText: 'State' }).first()).toContainText('lane')

  // Measured in GRAPH coordinates, off the node's own transform — not on
  // screen. The canvas fits the camera to the graph's bounds, so moving a node
  // outward re-centres everything and a screen-space assertion cannot tell
  // "the position was restored" from "the camera re-fitted".
  const graphX = async () => {
    const t = await page.getByRole('button', { name: 'state lane' }).getAttribute('transform')
    return Number(/translate\(([-\d.]+)/.exec(t ?? '')?.[1] ?? NaN)
  }
  const autoX = await graphX()
  // Re-read the box: selecting a state opens the inspector, the canvas gets
  // narrower, and the graph re-fits — so the coordinates captured before the
  // click point at empty space by now.
  const grip = await node.boundingBox()
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip!.x + grip!.width / 2 + 120, grip!.y + grip!.height / 2 + 60, { steps: 8 })
  await page.mouse.up()
  const draggedX = await graphX()
  expect(draggedX).toBeGreaterThan(autoX + 40)

  // It SURVIVES a reload — the position is written, not just held in a state.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => Math.abs((await graphX()) - draggedX)).toBeLessThan(8)

  // And the automatic layout can be asked back, which is what makes dragging
  // safe to try. Polled, not read once: the reset is a React render away, and
  // a bare read here fails on the render that has not happened yet.
  await page.getByRole('button', { name: '↺ auto-layout' }).click()
  await expect.poll(async () => Math.abs((await graphX()) - autoX)).toBeLessThan(8)
})

test('a timed beat fires ITSELF, and an authored shot rides with the move', async ({ page }) => {
  // Three fields the schema now carries; the only ones worth shipping are the
  // ones the player feels. `autoAfterMs` is a beat that needs no press — the
  // thing that lets a world open on something happening rather than on a menu.
  await page.addInitScript(() => {
    ;(window as unknown as { __hud: string[] }).__hud = []
    const orig = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) {
      ;(window as unknown as { __hud: string[] }).__hud.push(String(text))
      return (orig as (this: CanvasRenderingContext2D, ...a: unknown[]) => void).apply(this, [text, ...rest])
    } as typeof CanvasRenderingContext2D.prototype.fillText
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  // Author the shot and the timer on the lane's own transition.
  await page.getByRole('button', { name: 'event walk_up_the_lane' }).click()
  await page.locator('#insp-event-camera').fill('low and close, following through the gap')
  await page.locator('#insp-event-autoafter').fill('1200')
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(page.getByText('Event saved')).toBeVisible({ timeout: 10_000 })

  // Play, and press NOTHING. The beat fires on its own and the machine moves.
  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })
  const hudHas = async (needle: string) =>
    (await page.evaluate(() => (window as unknown as { __hud: string[] }).__hud)).some((t) => t.includes(needle))
  await expect.poll(() => hudHas('orchard_gate'), { timeout: 25_000 }).toBe(true)

  // …and the event's own framing went out WITH its prose, not instead of it.
  expect(await hudHas('following through the gap')).toBe(true)
})

test('the player READS the narration — a state\'s line, then a beat\'s outcome', async ({ page }) => {
  // The separation is the feature: display copy beside the picture, authored in
  // its own field, and never mixed into the prompt. What this test can see is
  // the READING half; the sending half is a unit test (see the note below).
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  await page.getByRole('button', { name: 'state lane' }).click()
  await page.locator('#insp-state-narration').fill('The lane is quiet. Somewhere ahead, a gate stands open.')
  await page.getByRole('button', { name: 'Save state' }).click()
  await expect(page.getByText('State saved')).toBeVisible({ timeout: 10_000 })

  await page.getByRole('button', { name: 'event walk_up_the_lane' }).click()
  await page.locator('#insp-event-narration').fill('You push through the gap and the orchard opens out.')
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(page.getByText('Event saved')).toBeVisible({ timeout: 10_000 })

  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })

  // The entrance's line is on screen…
  const panel = page.locator('.narration')
  await expect(panel).toContainText('Somewhere ahead, a gate stands open', { timeout: 20_000 })

  // Taking the beat shows its OUTCOME line.
  await page.locator('.overlay .row').getByRole('button', { name: /walk up the lane/i }).click()
  await expect(panel).toContainText('the orchard opens out', { timeout: 20_000 })

  // NOTE: "and the model never got it" is NOT asserted here, on purpose. The
  // mock wraps its prompt to three lines, so the absence of a phrase on screen
  // is equally consistent with it having been sent and clipped — a vacuous
  // assertion, which this file has been burned by before. That claim is a value
  // and is made where it can be checked: `promptForBeat` in
  // tests/unit/narration.test.ts.
})

test('an authored move PRESSES its own controls, and lets go afterwards', async ({ page }) => {
  // The model listens on two channels — the prompt and the movement grammar —
  // and this world's schema says what happens when they disagree: prose about
  // leaping over an idle channel "sends contradictory signals". So a move can
  // now press what it describes. The release matters as much: a held `forward`
  // that nothing clears keeps walking the world away after the beat is over.
  await page.addInitScript(() => {
    ;(window as unknown as { __hud: string[] }).__hud = []
    const orig = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) {
      ;(window as unknown as { __hud: string[] }).__hud.push(String(text))
      return (orig as (this: CanvasRenderingContext2D, ...a: unknown[]) => void).apply(this, [text, ...rest])
    } as typeof CanvasRenderingContext2D.prototype.fillText
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  await page.getByRole('button', { name: 'event walk_up_the_lane' }).click()
  await page.locator('#insp-event-drive-move').selectOption('forward')
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(page.getByText('Event saved')).toBeVisible({ timeout: 10_000 })

  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })

  const hudHas = async (needle: string) =>
    (await page.evaluate(() => (window as unknown as { __hud: string[] }).__hud)).some((t) => t.includes(needle))
  // Nothing is driving before the beat is taken.
  expect(await hudHas('Front')).toBe(false)

  await page.locator('.overlay .row').getByRole('button', { name: /walk up the lane/i }).click()

  // The move pressed forward…
  await expect.poll(() => hudHas('Front'), { timeout: 20_000 }).toBe(true)
  // …and the MOVE register in the inspector lights while it is held, which is
  // the same signal a player's own key produces.
  await expect(page.locator('.playspect-reg').filter({ hasText: 'MOVE' }).first()).toBeVisible()
})

test('an AUTOPILOT state drives the camera while you stand in it, and stops when you leave', async ({ page }) => {
  // A standing drive, not a per-move one: the release is the half that breaks
  // quietly, because a `strafe_left` nobody clears keeps orbiting a room the
  // player has already left.
  await page.addInitScript(() => {
    ;(window as unknown as { __hud: string[] }).__hud = []
    const orig = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) {
      ;(window as unknown as { __hud: string[] }).__hud.push(String(text))
      return (orig as (this: CanvasRenderingContext2D, ...a: unknown[]) => void).apply(this, [text, ...rest])
    } as typeof CanvasRenderingContext2D.prototype.fillText
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  await page.getByRole('button', { name: 'state lane' }).click()
  await page.locator('#insp-state-auto-move').selectOption('strafe_left')
  await page.getByRole('button', { name: 'Save state' }).click()
  await expect(page.getByText('State saved')).toBeVisible({ timeout: 10_000 })

  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })

  const hudHas = async (needle: string) =>
    (await page.evaluate(() => (window as unknown as { __hud: string[] }).__hud)).some((t) => t.includes(needle))

  // Standing in the lane, the camera is already driving — nothing was pressed.
  await expect.poll(() => hudHas('Left'), { timeout: 20_000 }).toBe(true)
  await expect(page.locator('.playspect-reg').filter({ hasText: 'MOVE' }).first()).toBeVisible()

  // Leave, and it lets go: the next state has no autopilot, so the register
  // goes dark rather than orbiting a room nobody is in.
  await page.locator('.overlay .row').getByRole('button', { name: /walk up the lane/i }).click()
  await expect.poll(async () => {
    const hud = await page.evaluate(() => (window as unknown as { __hud: string[] }).__hud)
    return hud.some((t) => t.includes('orchard_gate'))
  }, { timeout: 25_000 }).toBe(true)
  await expect.poll(() => hudHas('idle'), { timeout: 15_000 }).toBe(true)
})

test('repainting the opening frame says what is missing rather than failing quietly', async ({ page }) => {
  // The keyless path is most of this studio's users. A repaint that silently
  // did nothing would leave an author staring at the very frame they were
  // trying to replace, with no way to tell a broken button from a missing key.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /Repaint opening frame/ }).click()
  await expect(page.getByText(/No image model is configured/)).toBeVisible({ timeout: 15_000 })
  // …and it names WHERE to fix it, which is the difference between an error and
  // an instruction.
  await expect(page.getByText(/in Settings/)).toBeVisible()
})

test('a SET-PIECE walks itself through its beats, in order, hands-free', async ({ page }) => {
  // Four states in a row are not a set-piece; the PACING is. This authors one
  // and watches the world walk it — the player presses ▶ once and the machine
  // moves twice.
  await page.addInitScript(() => {
    ;(window as unknown as { __hud: string[] }).__hud = []
    const orig = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) {
      ;(window as unknown as { __hud: string[] }).__hud.push(String(text))
      return (orig as (this: CanvasRenderingContext2D, ...a: unknown[]) => void).apply(this, [text, ...rest])
    } as typeof CanvasRenderingContext2D.prototype.fillText
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  // Author the set-piece straight into the store — the editor has no track UI
  // yet, and this test is about the RUNTIME walking it.
  await page.evaluate((id) => {
    const KEY = 'alakazam-studio:worlds:v1'
    const db = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const w = (db.worlds ?? []).find((x: { id: string }) => x.id === id)
    w.world.sequences = [{
      id: 'arrival',
      title: 'The gate opens',
      beats: [
        { state: 'lane', dwell: { ms: 400 } },
        { state: 'orchard_gate', dwell: { ms: 400 } },
        { state: 'bench_under_trees', dwell: 'input' },
      ],
    }]
    localStorage.setItem(KEY, JSON.stringify(db))
  }, worldId)

  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })

  // Offered where it STARTS, beside the beats.
  const start = page.locator('.overlay .row').getByRole('button', { name: /The gate opens/ })
  await expect(start).toBeVisible()
  await start.click()

  // It says it is playing, and it walks — two states the player never pressed.
  await expect(page.locator('.seq-banner')).toContainText('The gate opens', { timeout: 20_000 })
  const hudHas = async (needle: string) =>
    (await page.evaluate(() => (window as unknown as { __hud: string[] }).__hud)).some((t) => t.includes(needle))
  await expect.poll(() => hudHas('orchard_gate'), { timeout: 25_000 }).toBe(true)
  await expect.poll(() => hudHas('bench_under_trees'), { timeout: 25_000 }).toBe(true)

  // The last beat hands control BACK — the banner clears rather than the world
  // carrying on without the player.
  await expect(page.locator('.seq-banner')).toHaveCount(0, { timeout: 25_000 })
  await expect(page.locator('.diag.error')).toHaveCount(0)
})

test('a set-piece can be AUTHORED by hand, reordered, and then walks', async ({ page }) => {
  // The runtime shipped before its surface: a set-piece was writable by the
  // agent and the CLI and by nobody with hands. This drives the whole loop
  // through the editor — build it, reorder it, save it, play it.
  await page.addInitScript(() => {
    ;(window as unknown as { __hud: string[] }).__hud = []
    const orig = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) {
      ;(window as unknown as { __hud: string[] }).__hud.push(String(text))
      return (orig as (this: CanvasRenderingContext2D, ...a: unknown[]) => void).apply(this, [text, ...rest])
    } as typeof CanvasRenderingContext2D.prototype.fillText
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  await page.getByRole('button', { name: '+ New set-piece' }).click()
  await page.locator('#seq-title').fill('The gate opens')

  // Beat 1 is seeded from the first state; add a second and a third.
  await page.getByRole('button', { name: '+ beat' }).click()
  await page.getByRole('button', { name: '+ beat' }).click()
  await page.locator('#seq-beat-state-0').selectOption('lane')
  await page.locator('#seq-beat-dwell-0').selectOption('ms')
  await page.locator('#seq-beat-ms-0').fill('400')
  await page.locator('#seq-beat-state-1').selectOption('bench_under_trees')
  await page.locator('#seq-beat-dwell-1').selectOption('ms')
  await page.locator('#seq-beat-ms-1').fill('400')
  await page.locator('#seq-beat-state-2').selectOption('orchard_gate')
  await page.locator('#seq-beat-dwell-2').selectOption('input')

  // REORDER: the bench should come last. Beat 3 moves up, so the order becomes
  // lane → orchard_gate → bench.
  await page.getByRole('button', { name: 'move beat 3 earlier' }).click()
  await expect(page.locator('#seq-beat-state-1')).toHaveValue('orchard_gate')
  await expect(page.locator('#seq-beat-state-2')).toHaveValue('bench_under_trees')

  await page.getByRole('button', { name: 'Save set-piece' }).click()
  await expect(page.getByText('Set-piece saved')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/The gate opens · 3 beats/)).toBeVisible()

  // And it walks, in the order it was reordered into — which the reorder also
  // MOVED A DWELL: the `input` beat is now second, and `input` ends the walk.
  // So the third beat must NOT be reached. (My first version of this test
  // asserted the opposite and was wrong about the feature, not about the code:
  // handing control back and then carrying on regardless would take the world
  // off the player a moment after giving it to them.)
  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })
  await page.locator('.overlay .row').getByRole('button', { name: /The gate opens/ }).click()
  const hudHas = async (needle: string) =>
    (await page.evaluate(() => (window as unknown as { __hud: string[] }).__hud)).some((t) => t.includes(needle))
  await expect.poll(() => hudHas('orchard_gate'), { timeout: 25_000 }).toBe(true)
  // The banner clears because the walk ENDED here, not because it finished.
  await expect(page.locator('.seq-banner')).toHaveCount(0, { timeout: 20_000 })
  expect(await hudHas('bench_under_trees')).toBe(false)
})

test('deleting a state a SET-PIECE walks through is reported, not silently repaired', async ({ page }) => {
  // The rot this catches happens between two valid moments: the beat was fine
  // when it was written, and the state went later. Neither the store's write
  // check nor the player's plan check helps — one ran too early, the other runs
  // too late, when a player is already standing in the cinematic.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  // Author a set-piece through the track that walks the bench.
  await page.getByRole('button', { name: '+ New set-piece' }).click()
  await page.locator('#seq-title').fill('Down to the bench')
  await page.getByRole('button', { name: '+ beat' }).click()
  await page.locator('#seq-beat-state-0').selectOption('lane')
  await page.locator('#seq-beat-state-1').selectOption('bench_under_trees')
  await page.getByRole('button', { name: 'Save set-piece' }).click()
  await expect(page.getByText('Set-piece saved')).toBeVisible({ timeout: 15_000 })

  // Now delete the state it walks into.
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'state bench_under_trees' }).click()
  // Scoped to the STATE form: the set-piece rows carry a Delete of their own,
  // and so does the sequence being listed above.
  await page.locator('.card', { has: page.locator('#insp-state-base') }).getByRole('button', { name: 'Delete', exact: true }).click()

  // The doctrine says so, in a creator's words.
  await expect(
    page.locator('.lint-row').filter({ hasText: 'A set-piece walks into a room that is gone' }),
  ).toHaveCount(1, { timeout: 20_000 })

  // …and the beat is STILL THERE — the pacing is the author's to fix, and a
  // silent prune would rewrite it to hide their own edit from them.
  await expect(page.getByText(/Down to the bench · 2 beats/)).toBeVisible()
})

test('a CAMPAIGN with a broken act will not open, and says which rule stopped it', async ({ page }) => {
  // Six campaign lints shipped and were run by NOTHING: a
  // campaign could be played straight into an infinite loop with every check
  // passing, because no check was asked. This is the same promise the doctrine
  // already makes for one world — a broken thing does not open, and nothing is
  // billed for finding that out.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  // A campaign whose second act points at a world that does not exist — the
  // shape a delete leaves behind.
  await page.evaluate((id) => {
    const KEY = 'alakazam-studio:worlds:v1'
    const db = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    db.campaigns = [{
      id: 'c_broken',
      title: 'Half a Story',
      graph: {
        start: 'act_1',
        goldenThread: ['act_1', 'act_2'],
        acts: [
          { actId: 'act_1', worldId: id, title: 'The Lane', canonical: true },
          { actId: 'act_2', worldId: 'w_deleted', title: 'The Gone', canonical: true },
        ],
        edges: [{ from: { actId: 'act_1', state: 'orchard_gate' }, to: { actId: 'act_2' }, kind: 'golden', carryFlags: [] }],
      },
    }]
    localStorage.setItem(KEY, JSON.stringify(db))
  }, worldId)

  await page.goto(`/?play=${worldId}&campaign=c_broken`)

  // It refuses, names the rule, and never reaches the rail.
  await expect(page.getByText(/act-has-world/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/has no world/)).toBeVisible()
  await expect(page.getByText(/send a beat:/)).toHaveCount(0)
})

test('a WAYPOINT counts down while you drive, and arrives when you have driven far enough', async ({ page }) => {
  // The mechanic exists because the medium has no geometry: nothing can be
  // asked how far the port is, so the distance IS the driving. Holding forward
  // is the whole interaction, and letting go has to stop it — a counter that
  // ran on its own would be a cutscene with a number on it.
  await page.addInitScript(() => {
    ;(window as unknown as { __hud: string[] }).__hud = []
    const orig = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) {
      ;(window as unknown as { __hud: string[] }).__hud.push(String(text))
      return (orig as (this: CanvasRenderingContext2D, ...a: unknown[]) => void).apply(this, [text, ...rest])
    } as typeof CanvasRenderingContext2D.prototype.fillText
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  // A short drive, authored through the editor.
  await page.getByRole('button', { name: 'event walk_up_the_lane' }).click()
  await page.locator('#insp-event-wp-label').fill('THE ORCHARD')
  await page.locator('#insp-event-wp-distance').fill('60')
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(page.getByText('Event saved')).toBeVisible({ timeout: 10_000 })

  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })

  // The blip is up, at the full distance, and NOT moving on its own.
  const blip = page.locator('.waypoint')
  await expect(blip).toContainText('THE ORCHARD', { timeout: 20_000 })
  await expect(blip).toContainText('60 m')
  await page.waitForTimeout(1500)
  await expect(blip).toContainText('60 m', { timeout: 5_000 })

  // Drive. 60m at 14 m/s is a little over four seconds of holding forward.
  await page.locator('body').press('w')
  await page.keyboard.down('w')
  // 30s, not 15s. The drive itself is ~4s of SIMULATED travel, but its
  // wall-clock cost scales with how much of the machine the browser is getting:
  // `windows-latest` runs this suite in ~12 minutes against macOS's ~4.5, and it
  // blew the 15s budget once and passed on the identical commit the next run.
  // Two runs, one fail one pass, same code — a timing flake on the slowest
  // runner, not a Windows behaviour difference, so the headroom is what moves
  // rather than the assertion. It still fails if the countdown never starts,
  // which is the thing worth catching.
  await expect.poll(async () => Number(/(\d+) m/.exec((await blip.textContent()) ?? '')?.[1] ?? 999), { timeout: 30_000 })
    .toBeLessThan(50)
  await page.keyboard.up('w')

  // Letting go stops the journey — the number holds where it was.
  const held = Number(/(\d+) m/.exec((await blip.textContent()) ?? '')?.[1] ?? 0)
  await page.waitForTimeout(1500)
  const stillHeld = Number(/(\d+) m/.exec((await blip.textContent()) ?? '')?.[1] ?? 0)
  expect(Math.abs(stillHeld - held)).toBeLessThanOrEqual(1)

  // Drive the rest of the way and the event plays ITSELF.
  await page.keyboard.down('w')
  const hudHas = async (needle: string) =>
    (await page.evaluate(() => (window as unknown as { __hud: string[] }).__hud)).some((t) => t.includes(needle))
  await expect.poll(() => hudHas('orchard_gate'), { timeout: 30_000 }).toBe(true)
  await page.keyboard.up('w')
})

test('the editor TOUR shows once, and the ? brings it back', async ({ page }) => {
  // Opt back OUT of the shared seed, ON THE FIRST LOAD ONLY. Init scripts run
  // on EVERY navigation, so a plain `removeItem` here would also
  // fire during the reload below and un-dismiss a tour the app had correctly
  // marked seen — the test would then be asserting that its own fixture works.
  // A sessionStorage marker survives the reload and makes this one-shot.
  await page.addInitScript((key) => {
    try {
      if (sessionStorage.getItem('ftue-test-booted') === '1') return
      sessionStorage.setItem('ftue-test-booted', '1')
      localStorage.removeItem(key)
    } catch { /* private mode */ }
  }, FTUE_SEEN_KEY)
  // A pile of mechanics is worth very little to someone who cannot find
  // them. The two things worth pinning are that it appears on a first visit and
  // that it STAYS gone afterwards — a tour that reappears every time is a tax.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()

  const tour = page.getByRole('dialog', { name: 'Editor tour' })
  await expect(tour).toBeVisible({ timeout: 15_000 })
  await expect(tour).toContainText('A game here is a map')

  // It steps, and the last step finishes rather than dead-ending.
  await tour.getByRole('button', { name: /^Next/ }).click()
  await expect(tour).toContainText('A node is a state')
  await tour.getByRole('button', { name: 'Back' }).click()
  await expect(tour).toContainText('A game here is a map')
  await tour.getByRole('button', { name: 'Skip the tour' }).click()
  await expect(tour).toHaveCount(0)

  // Gone for good — including across a reload, which is the half that would
  // otherwise be a lie told by component state.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('dialog', { name: 'Editor tour' })).toHaveCount(0)

  // …and reachable again on purpose.
  await page.getByRole('button', { name: 'Show the editor tour' }).click()
  await expect(page.getByRole('dialog', { name: 'Editor tour' })).toBeVisible()
})

test('the MINIMAP shows the whole graph, and clicking it moves the view', async ({ page }) => {
  // A graph outgrows its pane quickly — the shipped example is 2600px wide
  // against an editor pane under a thousand — and after that, panning is
  // navigation by memory. The claim worth testing is not that a box is drawn
  // but that pressing it MOVES THE CAMERA.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  const map = page.getByRole('button', { name: /Graph minimap/ })
  await expect(map).toBeVisible()
  // One dot per state, plus the viewport rectangle.
  await expect(map.locator('.minimap-dot')).toHaveCount(3)
  await expect(map.locator('.minimap-view')).toHaveCount(1)

  // The camera is a transform on the canvas; clicking the far side of the map
  // has to change it.
  const transform = async () =>
    (await page.locator('svg > g[transform]').first().getAttribute('transform')) ?? ''
  const before = await transform()
  const box = await map.boundingBox()
  await page.mouse.click(box!.x + box!.width * 0.9, box!.y + box!.height * 0.5)
  await expect.poll(transform).not.toBe(before)
})

test('the DIRECTOR remembers: a second action is told what the first one did', async ({ page, context }) => {
  // Without this the director answers every typed action from a blank slate —
  // it can see a state called `lane_dragon` in the graph and has no idea a
  // dragon already came through the hedge. The claim is narrow and checkable:
  // the SECOND brief contains what the FIRST action did.
  await context.addInitScript(() => {
    localStorage.setItem('alakazam-studio:providers:v1', JSON.stringify({
      world: { active: 'mock' },
      llm: { active: 'custom', endpoints: { custom: { baseUrl: 'http://llm.test/v1', apiKey: 'k', model: 'm' } } },
    }))
  })

  const briefs: string[] = []
  let call = 0
  await page.route('http://llm.test/v1/chat/completions', async (route) => {
    const body = route.request().postDataJSON() as { messages: { role: string; content: string }[] }
    briefs.push(body.messages.map((m) => m.content).join('\n'))
    call += 1
    const id = call === 1 ? 'lane_dragon' : 'lane_flood'
    const name = call === 1 ? 'a_dragon_smashes_in' : 'the_water_rises'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          reply: call === 1 ? 'The hedge bursts.' : 'The water comes up.',
          ops: [
            { op: 'add_state', id, base: `A rear-view shot of the walker in the lane, ${call === 1 ? 'a scaled head through the hedge' : 'brown water rising over the ruts'}, the light gone flat.` },
            { op: 'add_event', name, kind: 'transition', from: ['lane'], to: id, base: 'It happens all at once.' },
          ],
        }) } }],
      }),
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  await page.locator('.overlay').getByRole('button', { name: /Play/ }).click()
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 15_000 })

  const say = async (what: string) => {
    const pill = page.getByRole('button', { name: /type what happens next/ })
    if (await pill.count()) await pill.click()
    await page.getByPlaceholder(/tell the agent what to change/i).fill(what)
    await page.getByRole('button', { name: 'Send to the kernel agent' }).click()
  }

  await say('a dragon smashes through the hedge')
  await expect.poll(() => briefs.length, { timeout: 20_000 }).toBe(1)
  expect(briefs[0]).not.toContain('Already happened')

  // The second one is told about the first.
  await expect.poll(async () => (await page.locator('.direct-note').count()) > 0, { timeout: 20_000 }).toBe(true)
  await say('the water starts rising')
  await expect.poll(() => briefs.length, { timeout: 25_000 }).toBe(2)
  expect(briefs[1]).toContain('do NOT repeat or contradict')
  expect(briefs[1]).toContain('a dragon smashes through the hedge')
})

test('a CUTSCENE plays on the seam — and a missing clip does not become a wall', async ({ page }) => {
  // The fail-open rule is the one worth an e2e, because it only shows up when
  // something is broken: "missing/404 = fail-open… so the world is playable
  // before final art lands". A world under construction that stops at a clip
  // nobody has made yet is worse than one with no clips at all.
  await page.addInitScript(() => {
    ;(window as unknown as { __hud: string[] }).__hud = []
    const orig = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) {
      ;(window as unknown as { __hud: string[] }).__hud.push(String(text))
      return (orig as (this: CanvasRenderingContext2D, ...a: unknown[]) => void).apply(this, [text, ...rest])
    } as typeof CanvasRenderingContext2D.prototype.fillText
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  // Author a cut on the lane's seam, pointing at a clip that does not exist.
  await page.locator('#cut-id').fill('c1')
  await page.locator('#cut-video').fill('/clips/never-rendered.webm')
  await page.locator('#cut-from').selectOption('lane')
  await page.locator('#cut-to').selectOption('orchard_gate')
  await page.getByRole('button', { name: 'Add cutscene' }).click()
  await expect(page.getByText('Cutscene added')).toBeVisible({ timeout: 15_000 })

  // Point the lane's transition AT the cut, so taking it plays the clip.
  await page.getByRole('button', { name: 'event walk_up_the_lane' }).click()
  await page.locator('#insp-event-to').selectOption('c1')
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(page.getByText('Event saved')).toBeVisible({ timeout: 15_000 })

  // Leave the clip request hanging — see below.
  await page.route('**/clips/never-rendered.webm', () => { /* never resolved */ })

  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })
  await page.locator('.overlay .row').getByRole('button', { name: /walk up the lane/i }).click()

  // The clip mounts, with the authored source. Its request is left HANGING on
  // purpose: a 404 fires `onError` within milliseconds, so the element exists
  // for about fifty of them and asserting on it is chasing a transient. A clip
  // that neither plays nor fails is also the case the timeout exists for.
  const clip = page.locator('video.cutscene')
  await expect(clip).toHaveAttribute('data-cutscene', 'c1', { timeout: 15_000 })

  // …and the world does NOT stop: the wait gives up, the cut clears itself, and
  // the destination the cut names lands anyway.
  await expect(clip).toHaveCount(0, { timeout: 20_000 })
  const hudHas = async (needle: string) =>
    (await page.evaluate(() => (window as unknown as { __hud: string[] }).__hud)).some((t) => t.includes(needle))
  await expect.poll(() => hudHas('orchard_gate'), { timeout: 25_000 }).toBe(true)
  await expect(page.locator('.diag.error')).toHaveCount(0)
})

test('a TERMINAL opens in the world and answers on your own model — or says it cannot', async ({ page }) => {
  // The console is a thing in the room: the world keeps breathing behind it,
  // nothing lands, and it answers on YOUR key. Keyless it must say so rather
  // than sitting silent, which is the state most people will meet it in.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  // Author a console on the lane, with one open fact and one gated one.
  await page.evaluate((id) => {
    const KEY = 'alakazam-studio:worlds:v1'
    const db = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const w = (db.worlds ?? []).find((x: { id: string }) => x.id === id)
    w.world.scene.events.push({
      name: 'use_the_post',
      kind: 'terminal',
      from: ['lane'],
      terminal: {
        persona: 'You are a parish notice board that has been alone a long time.',
        greeting: 'NOTICE BOARD — ask.',
        facts: [
          { text: 'The orchard gate was left open on Tuesday.' },
          { text: 'The bench was moved by the Hartleys.', requires: ['asked_around'] },
        ],
      },
    })
    localStorage.setItem(KEY, JSON.stringify(db))
  }, worldId)

  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })

  // It is on the rail, and pressing it opens the console with its greeting.
  await page.locator('.overlay .row').getByRole('button', { name: /use the post/i }).click()
  const term = page.getByRole('dialog', { name: /Terminal/ })
  await expect(term).toBeVisible({ timeout: 15_000 })
  await expect(term).toContainText('NOTICE BOARD — ask.')

  // Keyless, it says what is missing instead of hanging.
  await page.locator('#terminal-input').fill('who moved the bench?')
  await term.getByRole('button', { name: 'ASK' }).click()
  await expect(term).toContainText(/NO LINK/, { timeout: 15_000 })
  await expect(term).toContainText(/YOUR language model/)

  // The world kept breathing behind it: nothing landed, and the rail is intact.
  await expect(page.getByText(/send a beat:/)).toBeVisible()
  await term.getByRole('button', { name: 'Close the terminal' }).click()
  await expect(term).toHaveCount(0)
})

test('AUTO-NARRATION is off until asked for, and never overrides an author', async ({ page }) => {
  // "Omit on hand-authored worlds" is the behaviour worth pinning: a world
  // nobody narrated gets a derived line only when its author asks, and a
  // state that HAS a narration keeps it.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  // Nothing on screen to read yet — the starter world narrates nothing.
  await page.goto(`/?play=${worldId}`)
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.narration')).toHaveCount(0)

  // Ask for it.
  await page.goto(`/?world=${worldId}`)
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('Narrate states that have no narration of their own').check()
  await expect(page.getByText('Auto-narration on')).toBeVisible({ timeout: 15_000 })

  // Now the entrance reads as prose, with the camera instruction stripped off.
  await page.goto(`/?play=${worldId}`)
  await expect(page.locator('.narration')).toBeVisible({ timeout: 30_000 })
  const derived = (await page.locator('.narration').textContent()) ?? ''
  expect(derived).not.toMatch(/rear-view shot/i)
  expect(derived.length).toBeGreaterThan(10)

  // An AUTHORED line still wins over the derivation.
  await page.goto(`/?world=${worldId}`)
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'state lane' }).click()
  await page.locator('#insp-state-narration').fill('The lane is quiet, and colder than it looks.')
  await page.getByRole('button', { name: 'Save state' }).click()
  await expect(page.getByText('State saved')).toBeVisible({ timeout: 10_000 })
  await page.goto(`/?play=${worldId}`)
  await expect(page.locator('.narration')).toContainText('colder than it looks', { timeout: 30_000 })
})

test('an INTRO covers the boot rather than delaying it, and an OUTRO is earned once', async ({ page }) => {
  // The intro's whole job is to sit over the part of a boot that looks bad —
  // so the session has to be connecting UNDERNEATH it, not after it. The outro
  // is the opposite kind of thing: a condition that has to be met.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
  const worldId = new URL(page.url()).searchParams.get('world')

  await page.locator('#insp-intro-video').fill('/clips/open.webm')
  await page.getByRole('button', { name: 'Save intro' }).click()
  await expect(page.getByText('Intro saved')).toBeVisible({ timeout: 15_000 })

  // An outro that the lane's own walk earns: reaching the bench with the flag.
  await page.evaluate((id) => {
    const KEY = 'alakazam-studio:worlds:v1'
    const db = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const w = (db.worlds ?? []).find((x: { id: string }) => x.id === id)
    w.world.outro = { video: '/clips/home.webm', flag: 'arrived', state: 'orchard_gate' }
    const ev = w.world.scene.events.find((e: { name: string }) => e.name === 'walk_up_the_lane')
    ev.grants = ['arrived']
    localStorage.setItem(KEY, JSON.stringify(db))
  }, worldId)

  // Both clips hang, so each stays up long enough to be seen.
  await page.route('**/clips/*.webm', () => { /* never resolved */ })
  await page.goto(`/?play=${worldId}`)

  // THE INTRO IS UP WHILE THE WORLD IS STILL CONNECTING — that is the claim.
  const clip = page.locator('video.cutscene')
  await expect(clip).toHaveAttribute('data-bookend', 'intro', { timeout: 15_000 })
  await expect(page.getByText(/connecting…|send a beat:/)).toBeVisible()

  // It gives up on a clip that never arrives, and the world is playable.
  await expect(clip).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByText(/send a beat:/)).toBeVisible({ timeout: 30_000 })

  // The outro is NOT up: its condition has not been met yet.
  await expect(page.locator('video.cutscene')).toHaveCount(0)

  // Earn it — the walk grants the flag and lands in the outro's state.
  await page.locator('.overlay .row').getByRole('button', { name: /walk up the lane/i }).click()
  await expect(page.locator('video.cutscene')).toHaveAttribute('data-bookend', 'outro', { timeout: 30_000 })
})

test('a LOCK can be authored by hand, and the doctrine answers before it ships', async ({ page }) => {
  // The flag algebra had no editor at all. The kernel writes locks into most
  // worlds, the doctrine polices them, and the player renders a padlocked beat
  // with the author's hint — but `grants`, `requires` and `lockedHint` appeared
  // nowhere in the inspector, so the only ways a human could add or repair one
  // were the CLI and the agent. This walks the whole loop with hands: mint a
  // key on one event, demand it on another, and let the doctrine referee.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  // 1. DEMAND a key nothing mints. The editor must say so BEFORE the save —
  //    the agent only learns this by being refused.
  await page.getByRole('button', { name: 'event go_to_the_bench' }).click()
  await expect(page.locator('code', { hasText: 'go_to_the_bench' }).first()).toBeVisible({ timeout: 10_000 })
  await page.locator('#insp-event-requires').fill('has_lamp')
  await expect(page.getByText(/Nothing grants/)).toBeVisible()

  // 2. A requirement with no hint HIDES the beat rather than greying it out.
  //    That is a real choice and the editor states it rather than leaving the
  //    author to discover it in a session.
  await expect(page.getByText(/hidden.*while it is locked/)).toBeVisible()
  await page.locator('#insp-event-locked-hint').fill('The bench is dark. Something would have to light it.')
  await page.getByRole('button', { name: 'Save event' }).click()

  // The doctrine agrees with the editor: an unreachable requirement is an error.
  // The panel speaks in a creator's words, not rule ids — the same surface the
  // trigger-zone test asserts on.
  const noKey = page.locator('.lint-row').filter({ hasText: 'A locked door with no key' })
  await expect(noKey).toHaveCount(1, { timeout: 20_000 })

  // 3. MINT the key on another event, and the warning clears on both sides.
  await page.getByRole('button', { name: 'event walk_up_the_lane' }).click()
  await expect(page.locator('code', { hasText: 'walk_up_the_lane' }).first()).toBeVisible({ timeout: 10_000 })
  await page.locator('#insp-event-grants').fill('has_lamp')
  await page.getByRole('button', { name: 'Save event' }).click()
  await expect(noKey).toHaveCount(0, { timeout: 20_000 })

  // 4. THE STORE IS THE PROOF, not the form. A field the schema carries and the
  //    store drops is invisible.
  await page.getByRole('button', { name: 'event go_to_the_bench' }).click()
  await expect(page.locator('#insp-event-requires')).toHaveValue('has_lamp')
  await expect(page.locator('#insp-event-locked-hint')).toHaveValue(/bench is dark/)
  await page.reload()
  await page.getByRole('button', { name: 'event go_to_the_bench' }).click()
  await expect(page.locator('#insp-event-requires')).toHaveValue('has_lamp', { timeout: 15_000 })
})

test('an override that fires in two rooms gets two DISTINGUISHABLE chips', async ({ page }) => {
  // An override or terminal fires from every state it lists in `from`, so the
  // canvas draws one chip per state — and every one of them was labelled
  // "event listen". Two controls with one accessible name is a strict-mode
  // failure for any automation, and a screen reader reading the same thing
  // twice with nothing to say which room it belongs to. Found while trying to
  // click one from a live driver, which is a use nobody had exercised.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  const labels = await page.getByRole('button', { name: /^event / })
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
  expect(new Set(labels).size, `every canvas event is uniquely named: ${labels.join(' | ')}`).toBe(labels.length)

  // And the name still says which event it is, not just where.
  const listen = labels.filter((l) => l.includes('listen'))
  expect(listen.length).toBeGreaterThan(1)
  for (const l of listen) expect(l).toMatch(/^event listen in \w+$/)

  // And clicking one opens THAT event — but only after the canvas has stopped
  // moving. The graph fits itself to the viewport on load, so a click issued
  // while the camera is still travelling is measured against one layout and
  // lands in another: it hits whatever occupies those coordinates a beat later,
  // which is the state node underneath. That race was first written up as
  // "overrides cannot be selected from the canvas" before a DOM dispatch (no
  // coordinates) opened the event first try.
  const chip = page.getByRole('button', { name: 'event listen in lane' })
  await expect(async () => {
    const a = await chip.boundingBox()
    await page.waitForTimeout(120)
    const b = await chip.boundingBox()
    expect(a && b && a.x === b.x && a.y === b.y, 'the camera has come to rest').toBeTruthy()
  }).toPass({ timeout: 10_000 })

  // A REAL mouse press, not a dispatched event: the whole defect this pins is
  // that a synthesized DOM click worked while a real one did not.
  await chip.click({ force: true })
  await expect(page.locator('#insp-event-grants')).toBeVisible({ timeout: 10_000 })
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
})

test('a world with no first frame says so in the editor, not after you press Play', async ({ page }) => {
  // The only place this was ever said was a banner over a black screen, AFTER
  // the session had opened and started accepting beats. A live session lost a
  // whole run to it: authored, played, and sat in front of nothing. It is
  // deliberately NOT a doctrine lint — a world without a seed
  // frame is perfectly valid on a backend that does not need one — so it reads
  // as a fact about the world beside the counts, not as a rule violation.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })

  // The shipped example is authored as prose, with no painted entrance.
  await expect(page.getByText('no first frame')).toBeVisible()
  await expect(page.getByTitle(/will not start from prose alone/)).toBeVisible()

  // And it is a NOTE, not an error: the world still opens and still plays.
  await expect(page.getByRole('button', { name: '▶ Play' })).toBeEnabled()
})

test('an abnormally dropped socket is replaced: the studio reconnects', async ({ page }) => {
  // An earlier version of this test was written against the episode FRAME
  // COUNTER and it passed with the entire retry mechanism deleted — the
  // counter is not downstream of
  // the connection. This watches the thing that is: every WebSocket the studio
  // constructs, and how each one ended. A probe first showed the real shape —
  // three sockets, the middle one closing 1006, a third opening after it — so
  // the assertion below describes something observed rather than assumed.
  const { spawn } = await import('node:child_process')
  // Port 0: the OS picks. This suite hardcoded ports until three unrelated
  // processes were found squatting the range, one of them on a port a deleted
  // test had used the day before.
  //
  // `refuse` cuts the session and then stays down for 4s, which is what a
  // restart looks like — plain `drop` lets the very next attempt in, so "it
  // recovered" cannot be told apart from "it tried once and got lucky".
  const server = spawn('node', ['examples/world-echo.mjs', '0', 'rgba', 'refuse', '4000'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const log: string[] = []
  server.stdout.on('data', (b: Buffer) => log.push(...String(b).split('\n').filter(Boolean)))
  try {
    const PORT = await new Promise<number>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('the reference server never announced a port')), 10_000)
      const tick = setInterval(() => {
        const m = /ws:\/\/localhost:(\d+)/.exec(log.join('\n'))
        if (m) { clearInterval(tick); clearTimeout(deadline); resolve(Number(m[1])) }
      }, 100)
    })
    await page.addInitScript((port) => {
      const Real = window.WebSocket
      const log: { closeCode: number | null; opened: boolean }[] = []
      ;(window as unknown as { __socks: typeof log }).__socks = log
      const starts: { resume: unknown; worldId: unknown }[] = []
      ;(window as unknown as { __starts: typeof starts }).__starts = starts
      const Wrapped = function (url: string, proto?: string | string[]) {
        const ws = proto === undefined ? new Real(url) : new Real(url, proto)
        const rec = { closeCode: null as number | null, opened: false }
        log.push(rec)
        ws.addEventListener('open', () => { rec.opened = true })
        ws.addEventListener('close', (e) => { rec.closeCode = (e as CloseEvent).code })
        // Every `start` the studio sends, in order. The RESUMED one has to be
        // distinguishable from the first, or a server cannot tell a reconnect
        // from a brand-new session and will re-seed the world underneath the
        // player.
        const send = ws.send.bind(ws)
        ws.send = (data: string) => {
          try {
            const m = JSON.parse(String(data))
            if (m?.type === 'start') starts.push({ resume: m.resume, worldId: m.worldId })
          } catch { /* binary or not ours */ }
          return send(data)
        }
        return ws
      } as unknown as typeof WebSocket
      Wrapped.prototype = Real.prototype
      window.WebSocket = Object.assign(Wrapped, Real)
      try {
        localStorage.setItem('alakazam-studio:providers:v1', JSON.stringify({
          world: { active: 'websocket', reactor: { apiKey: '', mode: 'adventure' },
            websocket: { url: `ws://localhost:${port}`, apiKey: '', protocol: 'auto' },
            alakazam: { apiBase: 'https://api.alakazam.gg', embedHost: 'https://play.alakazam.gg', apiKey: '' } },
          llm: { active: 'none', endpoints: {} },
          image: { geminiKey: '', model: 'gemini-3-pro-image' },
          vision: { endpoint: 'cloud', apiKey: '', localUrl: 'http://localhost:2020/v1/detect' },
        }))
      } catch { /* a browser refusing storage still gets a test */ }
    }, PORT)

    await page.goto('/')
    await page.getByRole('button', { name: 'Open the floating world composer' }).click()
    await page.getByRole('button', { name: /Open the example world/ }).click()
    await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible({ timeout: 15_000 })
    const world = new URL(page.url()).searchParams.get('world') ?? ''
    await page.goto(`/?play=${world}`)

    // The server cuts the session 1.5s after `start`, with 1006 — an abrupt
    // drop, not the clean 1000 the studio is right to treat as "we are done".
    const socks = () => page.evaluate(() => (window as unknown as { __socks: { closeCode: number | null; opened: boolean }[] }).__socks ?? [])
    await expect.poll(async () => (await socks()).some((s) => s.closeCode === 1006), { timeout: 30_000 })
      .toBe(true)

    // A LATER socket must open. Without the retry, the dropped one is the last.
    await expect.poll(async () => {
      const all = await socks()
      const dropped = all.findIndex((s) => s.closeCode === 1006)
      return dropped >= 0 && all.slice(dropped + 1).some((s) => s.opened && s.closeCode === null)
    }, { timeout: 30_000, message: 'no socket opened after the 1006 close — the studio did not come back' }).toBe(true)

    // THE RETRY SCHEDULE, read off the SERVER — the one vantage that cannot miss
    // an attempt. A page-side WebSocket wrapper recorded one of four attempts
    // here and produced a confident, wrong "the studio gave up after a single
    // retry"; the server had logged every one.
    await expect.poll(() => log.filter((l) => l.startsWith('upgrade refused')).length,
      { timeout: 30_000, message: `the studio stopped retrying while the server was down: ${log.join(' | ')}` })
      .toBeGreaterThan(1)
    // …and it got back in once the server returned.
    expect(log.filter((l) => l.startsWith('upgrade accepted')).length,
      `never reconnected: ${log.join(' | ')}`).toBeGreaterThan(1)

    // And it comes back as a RESUME, not as a new session. Verified by probe
    // before it was asserted: the first start carries resume:false, the one on
    // the reconnected socket carries resume:true and the SAME worldId.
    const starts = await page.evaluate(() =>
      (window as unknown as { __starts: { resume: unknown; worldId: unknown }[] }).__starts ?? [])
    expect(starts.length, `expected a first start and a resumed one, got ${JSON.stringify(starts)}`).toBeGreaterThan(1)
    expect(starts[0]?.resume, 'the first session is not a resume').toBeFalsy()
    expect(starts[starts.length - 1]?.resume, 'the reconnect must announce itself as a resume').toBe(true)
    expect(starts[starts.length - 1]?.worldId, 'a resume re-enters the SAME world').toBe(starts[0]?.worldId)
  } finally {
    server.kill()
  }
})

test('long prose announces itself as a chapter before anything is spent', async ({ page }) => {
  // `author chapter` shipped as a CLI and agent leaf with no way for a person in
  // the browser to reach it — the same shape as the flag algebra having no
  // editor, a recurring gap. The composer now routes on LENGTH rather than on
  // a mode switch: what you paste decides.
  //
  // Keyless, so no model is configured and nothing is authored. What is asserted
  // is the part that does not need one: that the affordance appears at the
  // threshold, and that the failure names the CHAPTER path rather than the
  // premise path — which is how we know the routing is real and not a label.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  const box = page.locator('#composer-premise')
  await expect(box).toBeVisible({ timeout: 15_000 })

  // A premise says nothing about chapters.
  await box.fill('a beaver exploring a sunken city')
  await expect(page.getByText(/treated as a/)).toHaveCount(0)

  // Long prose announces itself BEFORE anything is spent.
  const chapter = 'The lock had gone to seed since the last time she came down to it. '.repeat(12)
  expect(chapter.length).toBeGreaterThanOrEqual(400)
  await box.fill(chapter)
  await expect(page.getByText(/treated as a/)).toBeVisible()
  await expect(page.getByText(/in the order you wrote them/)).toBeVisible()
})

test('the book path has a door, and it will not offer what the tool would refuse', async ({ page }) => {
  // `runBookToCampaign` shipped and its only call site in the whole repository
  // was a tool leaf: it worked from the CLI and from an agent, and nobody
  // sitting in the studio could start it. 298 unit tests and 65 e2e passed
  // over it the entire time, because tests check that a thing works and never
  // that a person can reach it.
  await page.goto('/?section=book')
  await expect(page.getByRole('heading', { name: 'Book → Game' })).toBeVisible()

  // It is reachable from the rail, not only by typing a URL — which is the
  // whole defect being fixed.
  await page.goto('/')
  await page.getByRole('button', { name: /Book → Game/ }).click()
  await expect(page.getByRole('heading', { name: 'Book → Game' })).toBeVisible()

  const lay = page.getByRole('button', { name: /Lay out the book/ })
  await expect(lay).toBeDisabled()

  // Short text stays refused, and says how short it is. The floor is the SAME
  // constant `runBookToCampaign` throws under, so the surface cannot offer a
  // path the tool rejects — the rule the composer already follows for chapters.
  await page.getByLabel('The book').fill('Too short to be a book.')
  await expect(lay).toBeDisabled()
  await expect(page.getByText(/of 1200 characters/)).toBeVisible()

  // Past the floor it becomes available. Nothing is clicked: authoring a book
  // costs minutes of real model time, and this test is about the DOOR.
  await page.getByLabel('The book').fill('x'.repeat(1300))
  await expect(lay).toBeEnabled()
})

test('one-shot is editable, not just playable', async ({ page }) => {
  // `legalBeats` drops a `oneShot` beat once it is in `used`, so the mechanic is
  // live in every session — and until now a human could only add it from the CLI
  // or the agent, missing from the editor entirely. Same asymmetry as the
  // flag algebra: authored, linted, PLAYED, and unreachable in the editor.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.locator('.overlay svg').first()).toBeVisible({ timeout: 30_000 })

  // Select an event, not a state — one-shot is a statement about a beat.
  await page.getByText('walk_up_the_lane', { exact: true }).first().click()
  const once = page.getByLabel(/Once only/)
  await expect(once).toBeVisible()
  await expect(once).not.toBeChecked()

  await once.check()
  await page.getByRole('button', { name: 'Save event' }).click()

  // It must survive a reload: a toggle that only lives in component state is
  // the same defect wearing a checkbox.
  await page.reload()
  await page.getByText('walk_up_the_lane', { exact: true }).first().click()
  await expect(page.getByLabel(/Once only/)).toBeChecked()
})

test('ambient details are editable, and reach the state the player streams', async ({ page }) => {
  // The last field the inspector did not edit — and it was missing for a
  // reason worth remembering: there was no editor because there was no
  // CONSUMER. The kernel wrote two or three of these into every world it made
  // and nothing read them. A mechanic now streams one line at a time (watched
  // on the protocol wire), so a field that writes to it is finally worth
  // having.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  await expect(page.locator('.overlay svg').first()).toBeVisible({ timeout: 30_000 })

  await page.getByText('lane', { exact: true }).first().click()
  const field = page.getByLabel(/^Ambient/)
  await expect(field).toBeVisible()

  await field.fill('Ivy trembling in the breeze\nCrows calling in the distance')
  await page.getByRole('button', { name: 'Save state' }).click()

  // One per LINE, not one long clause: they are separate transients, and the
  // player picks between them. A reload proves it reached the store rather than
  // living in component state.
  await page.reload()
  await page.getByText('lane', { exact: true }).first().click()
  await expect(page.getByLabel(/^Ambient/)).toHaveValue('Ivy trembling in the breeze\nCrows calling in the distance')

  // Emptying it ERASES rather than storing [], so a state never claims to be
  // deliberately silent when nobody filled it in.
  await page.getByLabel(/^Ambient/).fill('')
  await page.getByRole('button', { name: 'Save state' }).click()
  await page.reload()
  await page.getByText('lane', { exact: true }).first().click()
  await expect(page.getByLabel(/^Ambient/)).toHaveValue('')
})

// Node drag, and the position surviving a reload.
//
// An earlier version of this test was written as a FAILING test and reported
// the feature broken. That was wrong, and the way it was wrong is worth
// keeping: it compared the
// node's SCREEN box before and after a reload, and the camera re-fits the graph
// on load. The node had not moved back — the whole view had rescaled. Measured
// after: the offset between two nodes went 210,-90 to 224,-96, a uniform 1.067
// on BOTH axes, which is a zoom and not a lost position, and the stored layout
// was byte-identical across the reload.
//
// So the assertions here are camera-invariant: what the store holds, and the
// SHAPE of the graph rather than its pixels.
test('a dragged node stays where it was put, across a reload', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()
  await page.getByRole('button', { name: /Open the example world/ }).click()
  const svg = page.locator('.overlay svg').first()
  await expect(svg).toBeVisible({ timeout: 30_000 })

  const nodes = () => svg.getByRole('button', { name: /^state / })
  const node = nodes().first()
  await expect(node).toBeVisible()
  const label = await node.getAttribute('aria-label')
  const before = await node.boundingBox()
  if (!before) throw new Error('the node has no box to drag')

  // A real pointer drag: the handler uses pointer capture and commits only on
  // release, so nothing short of down-move-up commits anything — which is why a
  // unit test could not have carried this claim either way.
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2 + 90, { steps: 12 })
  await page.mouse.up()
  expect((await node.boundingBox())!.x).toBeGreaterThan(before.x + 40)

  const stored = async (): Promise<string> =>
    (await page.evaluate(() => localStorage.getItem('alakazam-studio:layout:v1'))) ?? ''
  const dragged = await stored()
  expect(dragged).toContain(label!.replace('state ', ''))

  // The position is the author's, so it must outlive the session — and it is
  // the STORE that owns it, not wherever the camera happens to put it.
  await page.reload()
  await expect(svg).toBeVisible({ timeout: 30_000 })
  expect(await stored()).toBe(dragged)

  // And it must be APPLIED, not merely remembered: with the layout in force the
  // dragged node sits below-right of its neighbour, where the automatic layout
  // would have put it above-left. Compared as a direction, so a camera that
  // rescales the whole view cannot change the answer.
  const all = await nodes().all()
  const boxes = await Promise.all(all.map((n) => n.boundingBox()))
  expect(boxes.length).toBeGreaterThan(1)
  expect(boxes[1]!.x - boxes[0]!.x).toBeGreaterThan(0)
})

test('the quest path has a door, and refuses to promise grounding it cannot do', async ({ page }) => {
  // `author.quest` — probe a real frame, author a mission whose every objective
  // names something the detector actually FOUND — had no way in from the
  // studio for a long time. The quest TEMPLATE in the UI disguised the gap: it
  // hands you a prebuilt world with a mission in it, which is a different
  // thing entirely.
  await page.goto('/')
  await page.getByRole('button', { name: 'Open the floating world composer' }).click()

  const quest = page.getByRole('button', { name: /Quest/ })
  await expect(quest).toBeVisible()

  // On the keyless path there is no eye, so the control is refused WITH ITS
  // REASON rather than hidden. A grounded quest without a detector would be a
  // mission grounded on nothing, which is the one thing this path exists to
  // prevent — so the surface must not offer what the tool would reject.
  await expect(quest).toBeDisabled()
  await expect(quest).toHaveAttribute('title', /vision model/)
  await expect(quest).toHaveAttribute('title', /Settings/)
})




