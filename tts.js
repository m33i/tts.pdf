import * as pdfjs from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs'
import {
  TtsSession,
  PATH_MAP,
} from 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-tts-web.js'
import voiceList from 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/voices_static-D_OtJDHM.js'
import { franc } from 'https://cdn.jsdelivr.net/npm/franc-min@6.2.0/+esm'
import { env } from 'onnxruntime-web/wasm'
env.wasm.proxy = true // off the UI thread; needs the headers in vercel.json
pdfjs.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs'

const $ = id => document.getElementById(id)
const status = (s, refusal = false) => {
  $('status').textContent = s
  $('status').dataset.refusal = refusal ? 1 : ''
}

// localStorage can be missing or full; nothing here is worth failing for
const store = {
  get(k, fallback) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? fallback
    } catch {
      return fallback
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {}
  },
}

const audio = new Audio()
const prefs = { rate: 1.2, vol: 0.6, voices: {}, two: true, ...store.get('tts.pdf', {}) }
// room for an open book: two pages side by side
const wide = matchMedia('(min-width: 64rem) and (min-aspect-ratio: 5/4)')

let pdf, key
let raw, offsets // Mac PDFs only: the file as a one-char-per-byte string, and where each object starts
let opening = 0 // bumped on every open and close, cancels an open in flight
let page = 1
let idx = 0
let sents = []
let onScreen = []
let spread = '' // what was last drawn, to skip redrawing it
const shown = new Map() // page on screen -> the element showing each of its clauses
let running = false
let paused = false
let gen = 0 // bumped on every jump, cancels the loop in flight
let detected = 'en'
let session
let queue = Promise.resolve()
const wavs = new Map() // "page|idx" -> Promise<blob url>
const lineCache = new Map() // page -> Promise<lines>
const pages = new Map() // page -> Promise<clauses>

// each language's voices, "medium" ones first: the first is its default
const rank = v => ['medium', 'high', 'low', 'x_low'].indexOf(v.quality)
// worth offering: full-rate models of one voice, not research sets of many mixed speakers
const good = v => rank(v) < 2 && v.num_speakers <= 2
const voices = {}
for (const v of Object.values(voiceList)
  .filter(v => PATH_MAP[v.key])
  .sort((a, b) => rank(a) - rank(b)))
  (voices[v.language.family] ??= { name: v.language.name_native, list: [] }).list.push(v)
for (const l of Object.values(voices)) {
  // a language with nothing good keeps the best it has
  const best = l.list.some(good) ? good : v => rank(v) === rank(l.list[0])
  l.list = l.list.filter(best)
}
for (const [code, l] of Object.entries(voices).sort((a, b) => a[1].name.localeCompare(b[1].name)))
  $('lang').add(new Option(l.name, code))
// franc speaks ISO 639-3
const iso = Object.fromEntries(
  'ara:ar cat:ca ces:cs dan:da deu:de ell:el eng:en spa:es pes:fa fin:fi fra:fr hun:hu isl:is ita:it kat:ka kaz:kk ltz:lb nep:ne nld:nl nob:no nno:no pol:pl por:pt ron:ro rus:ru slk:sk slv:sl srp:sr swe:sv swh:sw tur:tr ukr:uk vie:vi cmn:zh'
    .split(' ')
    .map(p => p.split(':')),
)
const lang = () => $('lang').value || detected
// the voice picked for the current language, else its default
const voiceKey = () => {
  const { list } = voices[lang()]
  return (list.find(v => v.key === prefs.voices[lang()]) ?? list[0]).key
}
function fillVoices() {
  // "es_MX-claude-high" -> "Claude (MX, high)"
  const label = v => {
    const name = v.name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
    return `${name} (${v.language.region}, ${v.quality.replace('_', ' ')})`
  }
  $('voice').replaceChildren(...voices[lang()].list.map(v => new Option(label(v), v.key)))
  $('voice').value = voiceKey()
}
fillVoices()

// the voice barely pauses at punctuation, so each clause is spoken on its own with a silence after (ms)
const GAP = { ',': 60, ';': 200, ':': 200, '—': 160, '–': 160 }
const SENTENCE = 250
const BLOCK = 450

const bin = b => {
  let s = ''
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192))
  return s
}

// Mac PDFs draw accents and ligatures with odd glyphs and keep the real text in an /ActualText that pdf.js
// ignores ("confidencial" -> "conVidencial"). Read it from the raw file: one entry per /Span, in order.
async function actualTexts(ref) {
  if (!raw) return []
  const obj = num => {
    const at = offsets.get(+num)
    return at == null ? '' : raw.slice(at, raw.indexOf('endobj', at))
  }
  const contents = obj(ref.num).match(/\/Contents\s*(\[[^\]]*\]|\d+ \d+ R)/)?.[1] ?? ''
  let ops = ''
  for (const [, num] of contents.matchAll(/(\d+) \d+ R/g)) {
    const o = obj(num)
    const s = o.indexOf('stream')
    if (s < 0) continue
    const data = o.slice(s + (o[s + 6] === '\r' ? 8 : 7), o.lastIndexOf('endstream'))
    ops += o.slice(0, s).includes('FlateDecode') ? await inflate(data) : data
  }
  return [...ops.matchAll(/\/Span\s*(<<.*?>>|\/\w+)\s*BDC/gs)]
    .map(m => m[1].match(/\/ActualText\s*(\((?:\\.|[^\\)])*\)|<[^>]*>)/s))
    .map(t => (t ? pdfString(t[1]) : null))
}

async function inflate(s) {
  const b = Uint8Array.from(s, c => c.charCodeAt(0))
  // drop the line break before "endstream"; if those bytes were data after all, retry with them
  const eol = /\r?\n$|\r$/.exec(s)?.[0].length ?? 0
  for (const cut of new Set([eol, 0])) {
    const stream = new Blob([b.subarray(0, b.length - cut)]).stream()
    const out = new Response(stream.pipeThrough(new DecompressionStream('deflate')))
    try {
      return bin(new Uint8Array(await out.arrayBuffer()))
    } catch {}
  }
  return ''
}

// "(literal)" or "<hex>" as written in a PDF -> text
function pdfString(s) {
  const body = s.slice(1, -1)
  const escapes = { n: '\n', r: '\r', t: '\t' }
  const unescaped = body.replace(/\\([0-7]{1,3})|\\(.)/gs, (_, oct, c) =>
    oct ? String.fromCharCode(parseInt(oct, 8)) : (escapes[c] ?? c),
  )
  const codes =
    s[0] === '<'
      ? (body.replace(/\s/g, '').match(/../g) ?? []).map(h => parseInt(h, 16))
      : [...unescaped].map(c => c.charCodeAt(0))
  return codes[0] === 0xfe && codes[1] === 0xff
    ? new TextDecoder('utf-16be').decode(new Uint8Array(codes.slice(2)))
    : String.fromCharCode(...codes)
}

// composed accents, split ligatures, no soft hyphens or ruled lines
const clean = s =>
  s
    .replace(/ı(?=\p{M})/gu, 'i')
    .normalize('NFC')
    .replace(/[\uFB00-\uFB06]/g, c => c.normalize('NFKC'))
    .replace(/\u00AD/g, '')
    .replace(/[_.·•=\-–—]{4,}/g, ' ')

// a page's lines: { s: text, h: font height, y: baseline, x0, x1, edge: sits in the top or bottom margin }
function lines(n) {
  if (!lineCache.has(n)) lineCache.set(n, readLines(n))
  return lineCache.get(n)
}

async function readLines(n) {
  const pg = await pdf.getPage(n)
  const tc = await pg.getTextContent({ includeMarkedContent: true })
  const isSpan = i => i.type === 'beginMarkedContentProps' && i.tag === 'Span'
  // trusted only if the page has as many spans as the stream showed
  let fix = await actualTexts(pg.ref)
  if (fix.length !== tc.items.filter(isSpan).length) fix = []

  const out = [{ s: '', h: 0 }]
  const open = []
  let k = 0
  for (const it of tc.items) {
    if (it.type) {
      if (it.type === 'endMarkedContent') open.pop()
      else open.push(isSpan(it) ? { t: fix[k++] } : {})
      continue
    }
    const l = out.at(-1)
    const span = open.at(-1)
    if (it.str.trim()) {
      l.h = Math.max(l.h, it.height)
      l.y ??= it.transform[5]
      l.x0 ??= it.transform[4]
      l.x1 = it.transform[4] + it.width
    }
    // a span's real text replaces its glyphs, once; blank items are pdf.js spacing
    if (span?.t == null || !it.str.trim()) l.s += it.str
    else if (!span.done) {
      l.s += span.t
      span.done = true
    }
    if (it.hasEOL) out.push({ s: '', h: 0 })
  }

  const [, bottom, , top] = pg.view
  const margin = 0.1 * (top - bottom)
  return out
    .map(l => ({ ...l, s: clean(l.s).trim(), edge: l.y < bottom + margin || l.y > top - margin }))
    .filter(l => l.s)
}

// a page as clauses: { t: text, first: opens a sentence, brk: opens a block, head: heading, gap: silence after }
function clauses(n) {
  if (!pages.has(n)) pages.set(n, read(n))
  return pages.get(n)
}

async function read(n) {
  const doc = pdf
  // running heads and page numbers: margin lines that are a bare number or repeat on a neighbouring page
  const shape = l => l.s.replace(/\d+/g, '#')
  const repeated = new Set()
  for (const m of [n - 1, n + 1]) {
    if (m < 1 || m > doc.numPages) continue
    const near = await lines(m)
    if (doc !== pdf) return []
    for (const l of near) if (l.edge) repeated.add(shape(l))
  }
  const all = await lines(n)
  if (doc !== pdf) return []
  const text = all.filter(l => !(l.edge && (/^\W*\d+\W*$/.test(l.s) || repeated.has(shape(l)))))
  const left = Math.min(...text.map(l => l.x0))
  const width = Math.max(...text.map(l => l.x1)) - left

  // a block ends where the font size changes, the line gap widens, or a sentence ends short of the margin
  // ponytail: no column or table awareness, pdf.js reading order is taken as is
  const blocks = []
  let prev
  for (const l of text) {
    const gap = prev && prev.y - l.y
    const short = prev && prev.x1 - left < 0.75 * width && /[.:!?…"”)]$/.test(prev.s)
    if (!prev || Math.abs(l.h - prev.h) > 0.5 || gap < 0 || gap > 1.6 * prev.h || short)
      blocks.push({ s: '', h: l.h })
    const b = blocks.at(-1)
    // ponytail: a trailing "-" counts as a split word, real hyphens at a line end are lost
    b.s = b.s.endsWith('-') ? b.s.slice(0, -1) + l.s : (b.s + ' ' + l.s).trim()
    prev = l
  }

  // body size: the one most text is set in
  const sizes = {}
  for (const b of blocks) sizes[Math.round(b.h)] = (sizes[Math.round(b.h)] || 0) + b.s.length
  const body = +Object.keys(sizes).sort((x, y) => sizes[y] - sizes[x])[0]
  const seg = new Intl.Segmenter(lang(), { granularity: 'sentence' })
  const out = []
  for (const b of blocks) {
    const sentences = [...seg.segment(b.s.replace(/\s+/g, ' '))].map(x => x.segment.trim())
    sentences.filter(Boolean).forEach((sentence, i) => {
      const parts = sentence.split(/(?<=[,;:—–])\s+/)
      parts.forEach((t, j) => {
        const gap = j < parts.length - 1 ? GAP[t.at(-1)] : SENTENCE
        out.push({ t, first: !j, brk: !i && !j, head: b.h > body + 0.5, gap })
      })
    })
    if (out.length) out.at(-1).gap = BLOCK
  }
  // a sentence that runs on to the next page gets no pause at the turn
  if (out.length && !/[.!?…:"”»)]$/.test(out.at(-1).t)) out.at(-1).gap = 0
  return out
}

async function show(n, i = 0) {
  const doc = pdf
  page = n
  idx = i
  sents = await clauses(n)
  if (doc !== pdf) return
  // as in a book, a spread opens on an odd page
  const two = prefs.two && wide.matches && pdf.numPages > 1
  const first = two ? n - ((n + 1) % 2) : n
  onScreen = (two ? [first, first + 1] : [first]).filter(m => m <= pdf.numPages)
  const lists = await Promise.all(onScreen.map(clauses))
  if (doc !== pdf) return
  if (spread !== `${onScreen}|${lang()}`) {
    spread = `${onScreen}|${lang()}`
    shown.clear()
    $('text').replaceChildren(...onScreen.map((m, k) => render(m, lists[k])))
  }
  $('empty').hidden = true
  $('text').hidden = false
  $('text').lang = lang()
  document.body.classList.toggle('two', two)
  $('cur').textContent = onScreen.join('–')
  $('total').textContent = ` / ${pdf.numPages}`
  $('prev').disabled = first <= 1
  $('next').disabled = onScreen.at(-1) >= pdf.numPages
  mark()
  if (sents[idx]) wav(page, idx, sents[idx].t) // warm up, so Play answers at once
}

function render(n, list) {
  const el = document.createElement('div')
  el.className = 'page'
  const els = []
  list.forEach((s, j) => {
    if (s.brk) el.append(document.createElement(s.head ? 'h2' : 'p'))
    if (!s.first) return (els[j] = els[j - 1]).append(' ' + s.t)
    els[j] = document.createElement('span')
    els[j].textContent = s.t
    els[j].onclick = () => go(n, j)
    el.lastChild.append(els[j], ' ')
  })
  shown.set(n, els)
  return el
}

function mark() {
  $('text').querySelector('.now')?.classList.remove('now')
  const el = shown.get(page)?.[idx]
  el?.classList.add('now')
  el?.scrollIntoView({ block: 'nearest' })
  const read = pdf ? (page - 1 + idx / (sents.length || 1)) / pdf.numPages : 0
  $('bar').style.width = `${read * 100}%`
  $('bar').parentNode.ariaValueNow = Math.round(read * 100)
  store.set(key, [page, idx])
}

async function synth(text) {
  const voiceId = voiceKey()
  const { name } = voices[lang()]
  if (session?.voiceId !== voiceId) {
    TtsSession._instance = null // the library keeps a singleton
    session = await TtsSession.create({
      voiceId,
      progress: p =>
        p.url.endsWith('.onnx') &&
        !$('status').dataset.refusal &&
        status(`Fetching the ${name} voice, ${Math.round((p.loaded / p.total) * 100)}%`),
    })
    if (!$('status').dataset.refusal) status('')
  }
  return URL.createObjectURL(await session.predict(text))
}

function wav(p, i, text) {
  const k = p + '|' + i
  if (!wavs.has(k)) {
    // skipped if dropped before its turn; forgotten if it fails, so the next Play tries again
    const job = (queue = queue.catch(() => {}).then(() => wavs.get(k) === job && synth(text)))
    job.catch(() => wavs.get(k) === job && wavs.delete(k))
    wavs.set(k, job)
  }
  return wavs.get(k)
}

function flush() {
  for (const job of wavs.values()) job.then(url => url && URL.revokeObjectURL(url)).catch(() => {})
  wavs.clear()
}

async function speak() {
  const g = ++gen
  running = true
  paused = false
  ui()
  try {
    while (g === gen) {
      if (idx >= sents.length) {
        if (page >= pdf.numPages) return stop()
        await show(page + 1)
        continue
      }
      mark()
      if (!wavs.has(page + '|' + idx)) status('Preparing the voice…')
      const url = await wav(page, idx, sents[idx].t)
      if (g !== gen) return
      status('')
      // stay three clauses ahead, across the page turn too
      for (let k = idx + 1; k <= idx + 3; k++) {
        const p = page + 1
        const j = k - sents.length
        if (j < 0) wav(page, k, sents[k].t)
        else if (p <= pdf.numPages)
          clauses(p)
            .then(next => next[j] && g === gen && wav(p, j, next[j].t))
            .catch(() => {})
      }
      audio.src = url
      if (!paused) await audio.play()
      await new Promise(r => (audio.onended = r))
      URL.revokeObjectURL(url)
      wavs.delete(page + '|' + idx)
      if (g !== gen) return
      await new Promise(r => setTimeout(r, sents[idx++].gap / audio.playbackRate))
      if (g !== gen) return
    }
  } catch (e) {
    if (g !== gen) return
    halt()
    status(`Could not speak this: ${e.message}`)
  }
}

function halt() {
  gen++
  audio.pause()
  running = false
  ui()
}

function stop() {
  halt()
  idx = 0
  mark()
  status('')
}

async function go(p, i = 0) {
  const was = running && !paused
  halt()
  flush() // whatever was queued for the old position would only delay the new one
  await show(p, i)
  if (was) speak()
}

// to the next sentence, or back to the start of this one and then to the one before
async function sentence(dir) {
  const starts = sents.flatMap((s, j) => (s.first ? [j] : []))
  const here = starts.findLast(j => j <= idx) ?? 0
  const to =
    dir > 0 ? starts.find(j => j > idx) : idx > here ? here : starts.findLast(j => j < here)
  if (to != null) return go(page, to)
  if (dir > 0 && page < pdf.numPages) return go(page + 1)
  if (dir < 0 && page > 1)
    return go(
      page - 1,
      Math.max(
        0,
        (await clauses(page - 1)).findLastIndex(s => s.first),
      ),
    )
}

function toggle() {
  if (!running) return speak()
  paused = !paused
  ui()
  if (paused) audio.pause()
  else if (!audio.ended) audio.play().catch(() => {})
}

function ui() {
  const playing = running && !paused
  $('play').classList.toggle('playing', playing)
  $('play').ariaLabel = $('play').title = playing ? 'Pause' : 'Play'
  $('play').disabled = $('back').disabled = $('forth').disabled = !pdf
}

function close() {
  opening++
  halt()
  flush()
  lineCache.clear()
  pages.clear()
  pdf?.destroy()
  pdf = raw = offsets = null
  sents = []
  onScreen = []
  spread = ''
  shown.clear()
  document.body.classList.remove('two')
  $('text').replaceChildren()
  $('text').hidden = true
  $('empty').hidden = false
  $('file').textContent = ''
  $('close').hidden = true
  $('cur').textContent = '–'
  $('total').textContent = ''
  $('bar').style.width = 0
  $('prev').disabled = $('next').disabled = true
  $('lang').options[0].text = 'Auto'
  $('pick').value = ''
  status('')
  ui()
}

const MAX = 150 * 2 ** 20
async function open(file) {
  if (!file) return
  if (file.size > MAX)
    return status(`${file.name} is larger than 150 MB, too big to open here.`, true)
  const buf = await file.arrayBuffer().then(
    b => new Uint8Array(b),
    () => new Uint8Array(),
  )
  // trust the first bytes, not the name or type
  if (!bin(buf.subarray(0, 1024)).includes('%PDF-'))
    return status(`${file.name} is not a PDF.`, true)
  close()
  const mine = opening
  status('Opening…')
  let doc, info
  try {
    doc = await pdfjs.getDocument({ data: buf.slice(), isEvalSupported: false }).promise
    info = (await doc.getMetadata()).info
  } catch (e) {
    if (mine !== opening) return
    return status(
      e.name === 'PasswordException'
        ? `${file.name} is locked with a password.`
        : `${file.name} is damaged and cannot be opened.`,
      true,
    )
  }
  if (mine !== opening) return doc.destroy()
  pdf = doc
  if (/Quartz|macOS|Mac OS X/.test(`${info?.Producer} ${info?.Creator}`)) {
    raw = bin(buf)
    offsets = new Map()
    for (const m of raw.matchAll(/(?:^|[\s>])(\d+) 0 obj\b/g)) offsets.set(+m[1], m.index)
  }
  key = `tts.pdf:${file.name}:${file.size}`
  $('file').textContent = file.name
  $('close').hidden = false

  let sample = ''
  for (let n = 1; n <= Math.min(pdf.numPages, 20) && sample.length < 1500; n++) {
    sample += (await clauses(n)).map(s => s.t).join(' ') + ' '
    if (mine !== opening) return
  }
  const guess = iso[franc(sample)]
  detected = voices[guess] ? guess : 'en'
  $('lang').options[0].text = `Auto (${voices[detected].name})`
  fillVoices()
  // the pages sampled so far were split into sentences with the previous language's rules
  pages.clear()

  const [p, i] = store.get(key, [1, 0])
  await show(Math.min(p, pdf.numPages), i)
  if (mine !== opening) return
  ui()
  status(
    sample.trim()
      ? ''
      : 'No text found in the first pages. If this is a scan, there is nothing to read aloud.',
  )
}

$('play').onclick = toggle
$('back').onclick = () => sentence(-1)
$('forth').onclick = () => sentence(1)
$('prev').onclick = () => go(onScreen[0] - onScreen.length)
$('next').onclick = () => go(onScreen.at(-1) + 1)
const volume = v => {
  audio.volume = $('vol').value = prefs.vol = v
  store.set('tts.pdf', prefs)
}
$('vol').oninput = e => volume(+e.target.value)

// a button and the panel it opens: Escape or a click elsewhere closes it and hands focus back
function popover(button, panel) {
  const set = open => {
    panel.hidden = !open
    button.ariaExpanded = open
    if (open) panel.querySelector('select, button, input')?.focus()
    else if (panel.contains(document.activeElement)) button.focus()
  }
  button.onclick = () => set(panel.hidden)
  addEventListener(
    'keydown',
    e => e.key === 'Escape' && !panel.hidden && (set(false), button.focus()),
  )
  addEventListener('pointerdown', e => {
    if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) set(false)
  })
  return set
}
popover($('settings'), $('panel'))
const speedMenu = popover($('speed'), $('speedmenu'))

const SPEEDS = [0.75, 1, 1.1, 1.25, 1.5, 2]
const speed = r => {
  prefs.rate = r
  audio.defaultPlaybackRate = audio.playbackRate = r
  store.set('tts.pdf', prefs)
  $('speed').textContent = `${r}×`
  // the usual speeds plus the current one
  const all = [...new Set([...SPEEDS, r])].sort((a, b) => a - b)
  $('speedmenu').replaceChildren(
    ...all.map(x => {
      const b = document.createElement('button')
      b.textContent = `${x}×`
      b.ariaPressed = x === r
      b.onclick = () => {
        speed(x)
        speedMenu(false)
      }
      return b
    }),
  )
}
speed(prefs.rate)
volume(prefs.vol)
$('lang').onchange = () => {
  fillVoices()
  pages.clear()
  if (pdf) go(page, idx)
}
$('voice').onchange = e => {
  prefs.voices[lang()] = e.target.value
  store.set('tts.pdf', prefs)
  if (pdf) go(page, idx)
}
const layout = () => {
  $('view').hidden = !wide.matches
  $('one').ariaPressed = !prefs.two
  $('two').ariaPressed = prefs.two
  if (pdf) show(page, idx)
}
const view = two => {
  prefs.two = two
  store.set('tts.pdf', prefs)
  layout()
}
layout()
wide.onchange = layout
$('one').onclick = () => view(false)
$('two').onclick = () => view(true)
$('pick').onchange = e => open(e.target.files[0])
$('close').onclick = close
document.querySelector('label[for=pick]').onkeydown = e =>
  (e.key === 'Enter' || e.key === ' ') && $('pick').click()

addEventListener('dragover', e => {
  e.preventDefault()
  document.body.classList.add('over')
})
addEventListener('dragleave', e => e.relatedTarget || document.body.classList.remove('over'))
addEventListener('drop', e => {
  e.preventDefault()
  document.body.classList.remove('over')
  const fs = [...e.dataTransfer.files]
  open(fs.find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) ?? fs[0])
})
addEventListener('keydown', e => {
  if (e.key === ' ' && pdf && !e.target.closest('button, select, input, label')) {
    e.preventDefault()
    toggle()
  }
})
