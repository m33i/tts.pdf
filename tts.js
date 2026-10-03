import * as pdfjs from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs'
import {
  TtsSession,
  PATH_MAP,
  voices,
} from 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-tts-web.js'
import { franc } from 'https://esm.sh/franc-min@6.2.0'
import { env } from 'onnxruntime-web/wasm'
env.wasm.proxy = true // off the UI thread; needs the headers in vercel.json
pdfjs.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs'

const $ = id => document.getElementById(id)
const status = (s, refusal = false) => {
  $('status').textContent = s
  $('status').dataset.refusal = refusal ? 1 : ''
}

const audio = new Audio()
const prefs = { rate: 1.2, vol: 0.6, ...JSON.parse(localStorage.getItem('tts.pdf') || '{}') }

let pdf, key
let bytes, raw // the file, and the same as a one-char-per-byte string
let page = 1
let idx = 0
let sents = []
let running = false
let paused = false
let gen = 0 // bumped on every jump, cancels the loop in flight
let detected = 'en'
let session
let queue = Promise.resolve()
const wavs = new Map() // "page|idx" -> Promise<blob url>

// one voice per language, a "medium" one if there is
const rank = v => ['medium', 'high', 'low', 'x_low'].indexOf(v.quality)
const voice = {}
for (const v of (await voices()).filter(v => PATH_MAP[v.key]).sort((a, b) => rank(a) - rank(b)))
  voice[v.language.family] ??= { key: v.key, name: v.language.name_native }
for (const [code, v] of Object.entries(voice).sort((a, b) => a[1].name.localeCompare(b[1].name)))
  $('lang').add(new Option(v.name, code))
// franc speaks ISO 639-3
const iso = Object.fromEntries(
  'ara:ar cat:ca ces:cs dan:da deu:de ell:el eng:en spa:es pes:fa fin:fi fra:fr hun:hu isl:is ita:it kat:ka kaz:kk ltz:lb nep:ne nld:nl nob:no nno:no pol:pl por:pt ron:ro rus:ru slk:sk slv:sl srp:sr swe:sv swh:sw tur:tr ukr:uk vie:vi cmn:zh'
    .split(' ')
    .map(p => p.split(':')),
)
const lang = () => $('lang').value || detected

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
  const obj = num => {
    const m = new RegExp(`(?:^|[\\s>])${num} 0 obj\\b`).exec(raw)
    return m ? [m.index, raw.indexOf('endobj', m.index)] : [0, 0]
  }
  const contents =
    raw.slice(...obj(ref?.num)).match(/\/Contents\s*(\[[^\]]*\]|\d+ \d+ R)/)?.[1] ?? ''
  let ops = ''
  for (const [, num] of contents.matchAll(/(\d+) \d+ R/g)) {
    const [a, z] = obj(num)
    const s = raw.indexOf('stream', a)
    if (s < 0 || s > z) continue
    const from = s + (raw[s + 6] === '\r' ? 8 : 7)
    const to = raw.lastIndexOf('endstream', z)
    ops += raw.slice(a, s).includes('FlateDecode')
      ? await inflate(bytes.subarray(from, to))
      : raw.slice(from, to)
  }
  return [...ops.matchAll(/\/Span\s*(<<.*?>>|\/\w+)\s*BDC/gs)]
    .map(m => m[1].match(/\/ActualText\s*(\((?:\\.|[^\\)])*\)|<[^>]*>)/s))
    .map(t => (t ? pdfString(t[1]) : null))
}

async function inflate(b) {
  // the data may end with the line break before "endstream"
  for (const cut of [0, 1, 2]) {
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

// a page as clauses: { t: text, first: opens a sentence, brk: opens a block, head: heading, gap: silence after }
async function read(n) {
  const pg = await pdf.getPage(n)
  const tc = await pg.getTextContent({ includeMarkedContent: true })
  const isSpan = i => i.type === 'beginMarkedContentProps' && i.tag === 'Span'
  // trusted only if the page has as many spans as the stream showed
  let fix = await actualTexts(pg.ref)
  if (fix.length !== tc.items.filter(isSpan).length) fix = []

  const lines = [{ s: '', h: 0 }]
  const open = []
  let k = 0
  for (const it of tc.items) {
    if (it.type) {
      if (it.type === 'endMarkedContent') open.pop()
      else open.push(isSpan(it) ? { t: fix[k++] } : {})
      continue
    }
    const l = lines.at(-1)
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
    if (it.hasEOL) lines.push({ s: '', h: 0 })
  }

  const text = lines.map(l => ({ ...l, s: clean(l.s).trim() })).filter(l => l.s)
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
      const clauses = sentence.split(/(?<=[,;:—–])\s+/)
      clauses.forEach((t, j) => {
        const gap = j < clauses.length - 1 ? GAP[t.at(-1)] : SENTENCE
        out.push({ t, first: !j, brk: !i && !j, head: b.h > body + 0.5, gap })
      })
    })
    if (out.length) out.at(-1).gap = BLOCK
  }
  return out
}

async function show(n, i = 0) {
  page = n
  idx = i
  sents = await read(n)
  $('empty').hidden = true
  $('text').hidden = false
  $('text').replaceChildren()
  sents.forEach((s, j) => {
    if (s.brk) $('text').append(document.createElement(s.head ? 'h2' : 'p'))
    if (!s.first) return (s.el = sents[j - 1].el).append(' ' + s.t)
    s.el = document.createElement('span')
    s.el.textContent = s.t
    s.el.onclick = () => go(page, j)
    $('text').lastChild.append(s.el, ' ')
  })
  $('folio').textContent = `${n} / ${pdf.numPages}`
  $('prev').disabled = n <= 1
  $('next').disabled = n >= pdf.numPages
  mark()
}

function mark() {
  $('text').querySelector('.now')?.classList.remove('now')
  const el = sents[idx]?.el
  el?.classList.add('now')
  el?.scrollIntoView({ block: 'nearest' })
  localStorage.setItem(key, JSON.stringify([page, idx]))
}

async function synth(text) {
  const v = voice[lang()]
  if (session?.voiceId !== v.key) {
    TtsSession._instance = null // the library keeps a singleton
    session = await TtsSession.create({
      voiceId: v.key,
      progress: p =>
        p.url.endsWith('.onnx') &&
        !$('status').dataset.refusal &&
        status(`Fetching the ${v.name} voice, ${Math.round((p.loaded / p.total) * 100)}%`),
    })
    if (!$('status').dataset.refusal) status('')
  }
  return URL.createObjectURL(await session.predict(text))
}

function wav(p, i, text) {
  const k = p + '|' + i
  if (!wavs.has(k)) wavs.set(k, (queue = queue.catch(() => {}).then(() => synth(text))))
  return wavs.get(k)
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
      // stay three clauses ahead
      for (let k = idx + 1; k < Math.min(idx + 4, sents.length); k++) wav(page, k, sents[k].t)
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
  await show(p, i)
  if (was) speak()
}

function toggle() {
  if (!running) return speak()
  paused = !paused
  ui()
  if (paused) audio.pause()
  else if (!audio.ended) audio.play().catch(() => {})
}

function ui() {
  $('play').textContent = running && !paused ? 'Pause' : 'Play'
  $('play').disabled = $('stop').disabled = !pdf
}

function close() {
  halt()
  wavs.clear()
  pdf?.destroy()
  pdf = bytes = raw = null
  sents = []
  $('text').replaceChildren()
  $('text').hidden = true
  $('empty').hidden = false
  $('file').textContent = ''
  $('close').hidden = true
  $('folio').textContent = '–'
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
  status('Opening…')
  try {
    pdf = await pdfjs.getDocument({ data: buf.slice(), isEvalSupported: false, enableXfa: false })
      .promise
  } catch (e) {
    return status(
      e.name === 'PasswordException'
        ? `${file.name} is locked with a password.`
        : `${file.name} is damaged and cannot be opened.`,
      true,
    )
  }
  bytes = buf
  raw = bin(buf)
  key = 'tts.pdf:' + file.name
  $('file').textContent = file.name
  $('close').hidden = false

  let sample = ''
  for (let n = 1; n <= Math.min(pdf.numPages, 20) && sample.length < 1500; n++)
    sample += (await read(n)).map(s => s.t).join(' ') + ' '
  detected = voice[iso[franc(sample)]] ? iso[franc(sample)] : 'en'
  $('lang').options[0].text = `Auto (${voice[detected].name})`

  const [p, i] = JSON.parse(localStorage.getItem(key) || '[1,0]')
  await show(Math.min(p, pdf.numPages), i)
  ui()
  if (sents[idx]) wav(page, idx, sents[idx].t) // warm up, so Play answers at once
  status(
    sample.trim()
      ? ''
      : 'No text found in the first pages. If this is a scan, there is nothing to read aloud.',
  )
}

$('play').onclick = toggle
$('stop').onclick = stop
$('prev').onclick = () => go(page - 1)
$('next').onclick = () => go(page + 1)
const volume = v => {
  audio.volume = $('vol').value = prefs.vol = v
  localStorage.setItem('tts.pdf', JSON.stringify(prefs))
}
$('vol').oninput = e => volume(+e.target.value)
const speed = r => {
  prefs.rate = Math.min(3, Math.max(0.5, Math.round(r * 10) / 10))
  audio.defaultPlaybackRate = audio.playbackRate = prefs.rate
  $('rate').textContent = prefs.rate.toFixed(1) + '×'
  localStorage.setItem('tts.pdf', JSON.stringify(prefs))
}
speed(prefs.rate)
volume(prefs.vol)
$('slower').onclick = () => speed(prefs.rate - 0.1)
$('faster').onclick = () => speed(prefs.rate + 0.1)
$('lang').onchange = () => {
  wavs.clear()
  if (pdf) go(page, idx)
}
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
