import * as pdfjs from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs'
import { TtsSession, PATH_MAP, voices } from 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-tts-web.js'
import { franc } from 'https://esm.sh/franc-min@6.2.0'
pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs'

const $ = id => document.getElementById(id)
const status = s => $('status').textContent = s
const audio = new Audio()
const prefs = { rate: 1.2, vol: .6, ...JSON.parse(localStorage.getItem('tts.pdf') || '{}') }   // speed and volume, remembered

let pdf, key        // open document and its localStorage key
let page = 1, idx = 0, sents = []   // current page, sentence within it, that page's sentences
let running = false, paused = false, gen = 0   // gen: bumped on every jump, cancels the loop in flight
let detected = 'en', session, queue = Promise.resolve()
const wavs = new Map()   // "page|idx" -> Promise<blob url>

// one voice per language: first "medium" one, else whatever exists
const rank = v => ['medium', 'high', 'low', 'x_low'].indexOf(v.quality)
const voice = {}
for (const v of (await voices()).filter(v => PATH_MAP[v.key]).sort((a, b) => rank(a) - rank(b)))
  voice[v.language.family] ??= { key: v.key, name: v.language.name_native }
for (const [code, v] of Object.entries(voice).sort((a, b) => a[1].name.localeCompare(b[1].name)))
  $('lang').add(new Option(v.name, code))
// franc speaks ISO 639-3
const iso = { ara: 'ar', cat: 'ca', ces: 'cs', dan: 'da', deu: 'de', ell: 'el', eng: 'en', spa: 'es', pes: 'fa', fin: 'fi', fra: 'fr', hun: 'hu', isl: 'is', ita: 'it', kat: 'ka', kaz: 'kk', ltz: 'lb', nep: 'ne', nld: 'nl', nob: 'no', nno: 'no', pol: 'pl', por: 'pt', ron: 'ro', rus: 'ru', slk: 'sk', slv: 'sl', srp: 'sr', swe: 'sv', swh: 'sw', tur: 'tr', ukr: 'uk', vie: 'vi', cmn: 'zh' }
const lang = () => $('lang').value || detected

// what gets spoken in one go: a clause. { t: text, first: opens a sentence, brk: opens a block, head: in a heading, gap: ms of silence after }
// the voice barely stops at punctuation by itself, so each clause is its own utterance with a pause behind it
const GAP = { ',': 60, ';': 200, ':': 200, '—': 160, '–': 160 }, SENTENCE = 250, BLOCK = 450
async function read(n) {
  const tc = await (await pdf.getPage(n)).getTextContent()
  // text lines with their font height and baseline
  const lines = [{ s: '', h: 0 }]
  for (const it of tc.items) {
    const l = lines.at(-1)
    if (it.str.trim()) { l.h = Math.max(l.h, it.height); l.y ??= it.transform[5] }
    l.s += it.str
    if (it.hasEOL) lines.push({ s: '', h: 0 })
  }
  // a block (heading or paragraph) ends where the font size changes or the gap between lines widens
  // ponytail: no column or table awareness; pdf.js reading order is taken as is
  const blocks = []
  let prev
  for (const l of lines.filter(l => l.s.trim())) {
    const gap = prev && prev.y - l.y
    if (!prev || Math.abs(l.h - prev.h) > .5 || gap < 0 || gap > 1.6 * prev.h) blocks.push({ s: '', h: l.h })
    const b = blocks.at(-1)
    // ponytail: a trailing "-" is taken as a split word, so real hyphens at a line end are lost
    b.s = b.s.endsWith('-') ? b.s.slice(0, -1) + l.s.trim() : (b.s + ' ' + l.s).trim()
    prev = l
  }
  const sizes = {}   // body size = the one most text is set in
  for (const b of blocks) sizes[Math.round(b.h)] = (sizes[Math.round(b.h)] || 0) + b.s.length
  const body = +Object.keys(sizes).sort((x, y) => sizes[y] - sizes[x])[0]
  const seg = new Intl.Segmenter(lang(), { granularity: 'sentence' })
  return blocks.flatMap(b => [...seg.segment(b.s.replace(/\s+/g, ' '))]
    .map(x => x.segment.trim()).filter(Boolean)
    .flatMap((t, i) => t.split(/(?<=[,;:—–])\s+/)
      .map((c, j, cs) => ({ t: c, first: !j, brk: !i && !j, head: b.h > body + .5, gap: j < cs.length - 1 ? GAP[c.at(-1)] : SENTENCE }))))
    .map((s, i, all) => all[i + 1]?.brk === false ? s : { ...s, gap: BLOCK })
}

async function show(n, i = 0) {
  page = n; idx = i; sents = await read(n)
  $('text').className = ''
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
  $('prev').disabled = n <= 1; $('next').disabled = n >= pdf.numPages
  mark()
}

function mark() {
  $('text').querySelector('.now')?.classList.remove('now')
  const el = sents[idx]?.el
  el?.classList.add('now'); el?.scrollIntoView({ block: 'nearest' })
  localStorage.setItem(key, JSON.stringify([page, idx]))
}

async function synth(text) {
  const v = voice[lang()]
  if (session?.voiceId !== v.key) {
    TtsSession._instance = null   // the library keeps a singleton; drop it to switch voice
    session = await TtsSession.create({ voiceId: v.key, progress: p => p.url.endsWith('.onnx') && status(`Fetching the ${v.name} voice, ${Math.round(p.loaded / p.total * 100)}%`) })
  }
  return URL.createObjectURL(await session.predict(text))
}
function wav(p, i, text) {
  const k = p + '|' + i
  if (!wavs.has(k)) wavs.set(k, queue = queue.catch(() => {}).then(() => synth(text)))
  return wavs.get(k)
}

async function speak() {
  const g = ++gen
  running = true; paused = false; ui()
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
      if (idx + 1 < sents.length) wav(page, idx + 1, sents[idx + 1].t)   // synthesize ahead, no gap between sentences
      audio.src = url
      if (!paused) await audio.play()
      await new Promise(r => audio.onended = r)
      URL.revokeObjectURL(url); wavs.delete(page + '|' + idx)
      if (g !== gen) return
      await new Promise(r => setTimeout(r, sents[idx++].gap / audio.playbackRate))
      if (g !== gen) return
    }
  } catch (e) {
    if (g !== gen) return
    halt(); status(`Could not speak this: ${e.message}`)
  }
}

function halt() { gen++; audio.pause(); running = false; ui() }
function stop() { halt(); idx = 0; mark(); status('') }
async function go(p, i = 0) {
  const was = running && !paused
  halt(); await show(p, i)
  if (was) speak()
}
function toggle() {
  if (!running) return speak()
  paused = !paused; ui()
  if (paused) audio.pause(); else if (!audio.ended) audio.play().catch(() => {})
}
function ui() {
  $('play').textContent = running && !paused ? 'Pause' : 'Play'
  $('play').disabled = $('stop').disabled = !pdf
}

async function open(file) {
  if (!file) return
  halt(); wavs.clear(); status('Opening…')
  try { pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise }
  catch { return status(`${file.name} is not a PDF this page can open.`) }
  key = 'tts.pdf:' + file.name
  $('file').textContent = file.name

  // sample the first pages with text to guess the language
  let sample = ''
  for (let n = 1; n <= Math.min(pdf.numPages, 20) && sample.length < 1500; n++) sample += (await read(n)).map(s => s.t).join(' ') + ' '
  detected = voice[iso[franc(sample)]] ? iso[franc(sample)] : 'en'
  $('lang').options[0].text = `Auto (${voice[detected].name})`

  const [p, i] = JSON.parse(localStorage.getItem(key) || '[1,0]')
  await show(Math.min(p, pdf.numPages), i)
  ui()
  status(sample.trim() ? '' : 'No text found in the first pages. If this is a scan, there is nothing to read aloud.')
}

$('play').onclick = toggle
$('stop').onclick = stop
$('prev').onclick = () => go(page - 1)
$('next').onclick = () => go(page + 1)
const volume = v => { audio.volume = $('vol').value = prefs.vol = v; localStorage.setItem('tts.pdf', JSON.stringify(prefs)) }
$('vol').oninput = e => volume(+e.target.value)
const speed = r => {
  audio.defaultPlaybackRate = audio.playbackRate = prefs.rate = Math.min(3, Math.max(.5, Math.round(r * 10) / 10))
  $('rate').textContent = prefs.rate.toFixed(1) + '×'
  localStorage.setItem('tts.pdf', JSON.stringify(prefs))
}
speed(prefs.rate); volume(prefs.vol)
$('slower').onclick = () => speed(prefs.rate - .1)
$('faster').onclick = () => speed(prefs.rate + .1)
$('lang').onchange = () => { wavs.clear(); if (pdf) go(page, idx) }
$('pick').onchange = e => open(e.target.files[0])
document.querySelector('label[for=pick]').onkeydown = e => (e.key === 'Enter' || e.key === ' ') && $('pick').click()

addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('over') })
addEventListener('dragleave', e => e.relatedTarget || document.body.classList.remove('over'))
addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('over'); open(e.dataTransfer.files[0]) })
addEventListener('keydown', e => { if (e.key === ' ' && pdf && !e.target.closest('button, select, input, label')) { e.preventDefault(); toggle() } })
