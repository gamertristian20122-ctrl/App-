// HTML for template renders (carousel slides, template-video cards). Pure functions: every text is
// HTML-escaped, colours are re-checked as #rrggbb, images are inlined as data: URIs of allowed image
// types, and no script is ever emitted (the renderer also disables JavaScript and the network).
// Fonts are the worker image's system fonts (Noto, DejaVu), chosen by the theme's font preset.

import type { RenderCarouselInput, RenderVideoInput } from '@app/core/validation'

export interface Theme {
  background: string
  foreground: string
  accent: string
  font: 'sans' | 'serif' | 'mono' | 'rounded' | 'condensed'
}

export const DEFAULT_THEME: Readonly<Theme> = Object.freeze({ background: '#ffffff', foreground: '#111111', accent: '#4f46e5', font: 'sans' })

const EMOJI = "'Noto Color Emoji'"
export const FONT_STACKS: Readonly<Record<Theme['font'], string>> = {
  sans: `'Noto Sans', 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif, ${EMOJI}`,
  serif: `'Noto Serif', 'DejaVu Serif', 'Liberation Serif', Georgia, serif, ${EMOJI}`,
  mono: `'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', monospace, ${EMOJI}`,
  rounded: `'Nunito', 'Varela Round', 'Noto Sans', 'DejaVu Sans', sans-serif, ${EMOJI}`,
  condensed: `'Noto Sans Condensed', 'Roboto Condensed', 'DejaVu Sans Condensed', 'Noto Sans', sans-serif, ${EMOJI}`,
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export interface InlineImage {
  mimeType: string
  base64: string
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function color(value: string | undefined, fallback: string): string {
  return value && HEX_RE.test(value) ? value.toLowerCase() : fallback
}

export function resolveTheme(theme: Partial<Theme> | undefined | null): Theme {
  const font = theme?.font && theme.font in FONT_STACKS ? theme.font : DEFAULT_THEME.font
  return {
    background: color(theme?.background, DEFAULT_THEME.background),
    foreground: color(theme?.foreground, DEFAULT_THEME.foreground),
    accent: color(theme?.accent, DEFAULT_THEME.accent),
    font,
  }
}

/** Relative luminance 0..1 of #rrggbb. */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** Readable text colour on `background`. */
export function contrastOn(background: string): string {
  return luminance(background) > 0.4 ? '#111111' : '#ffffff'
}

function imageSrc(image: InlineImage | null | undefined): string | null {
  if (!image || !IMAGE_MIME.has(image.mimeType) || !/^[A-Za-z0-9+/=]+$/.test(image.base64)) return null
  return `data:${image.mimeType};base64,${image.base64}`
}

/** Font size (px at 1080 wide) that keeps longer text on the slide. */
function fit(length: number, steps: ReadonlyArray<readonly [number, number]>, smallest: number): number {
  for (const [maxLength, size] of steps) if (length <= maxLength) return size
  return smallest
}

const HEADING_STEPS = [
  [16, 104],
  [32, 88],
  [60, 72],
  [90, 62],
] as const
const BODY_STEPS = [
  [80, 48],
  [180, 42],
  [320, 36],
  [480, 31],
] as const

function page(size: { width: number; height: number }, theme: Theme, css: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${size.width}"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${size.width}px;height:${size.height}px;overflow:hidden}
body{background:${theme.background};color:${theme.foreground};font-family:${FONT_STACKS[theme.font]};-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.slide{position:relative;width:100%;height:100%;overflow:hidden}
.pre{white-space:pre-line;overflow-wrap:anywhere}
${css}
</style></head><body>${body}</body></html>`
}

// ---------------------------------------------------------------------------------------------
// Carousel
// ---------------------------------------------------------------------------------------------

export type CarouselSlide = RenderCarouselInput['slides'][number]

export interface CarouselSlideContext {
  template: RenderCarouselInput['template']
  theme: Theme
  size: { width: number; height: number }
  index: number
  total: number
  image?: InlineImage | null
}

export function carouselSlideHtml(slide: CarouselSlide, c: CarouselSlideContext): string {
  const { theme, size } = c
  const k = size.width / 1080
  const px = (n: number) => `${Math.round(n * k)}px`
  const heading = slide.heading?.trim() ?? ''
  const body = slide.body?.trim() ?? ''
  const footer = slide.footer?.trim() ?? ''
  const src = imageSrc(c.image)
  const template = c.template === 'photo' && !src ? 'minimal' : c.template
  const bold = template === 'bold'
  const bg = bold ? theme.accent : theme.background
  const fg = bold ? contrastOn(theme.accent) : theme.foreground
  const accent = bold ? fg : theme.accent
  const pad = px(96)
  const headingSize = px(fit(heading.length, HEADING_STEPS, 54) * (bold ? 1.1 : 1))
  const bodySize = px(fit(body.length, BODY_STEPS, 28))
  const counter = c.total > 1 ? `<span class="count">${c.index + 1}/${c.total}</span>` : ''
  const foot = footer || counter ? `<div class="foot"><span>${escapeHtml(footer)}</span>${counter}</div>` : ''

  const css = `
.slide{background:${bg};color:${fg};padding:${pad};padding-bottom:${px(170)};display:flex;flex-direction:column;justify-content:center;gap:${px(40)}}
h1{font-size:${headingSize};line-height:1.08;font-weight:800;letter-spacing:-0.01em;overflow-wrap:anywhere}
.body{font-size:${bodySize};line-height:1.38;font-weight:400;opacity:.92}
.bar{width:${px(120)};height:${px(12)};border-radius:${px(6)};background:${accent};flex:none}
.media{flex:1 1 auto;min-height:${px(200)};max-height:55%;border-radius:${px(28)};overflow:hidden}
.media img{width:100%;height:100%;object-fit:cover;display:block}
.foot{position:absolute;left:${pad};right:${pad};bottom:${px(64)};display:flex;justify-content:space-between;align-items:center;font-size:${px(30)};font-weight:600;color:${accent}}
.count{opacity:.8;margin-left:auto}
.quote-mark{font-family:'Noto Serif','DejaVu Serif',serif;font-size:${px(220)};line-height:.7;color:${accent};height:${px(120)}}
.quote{font-size:${px(fit(body.length || heading.length, BODY_STEPS, 30) * 1.25)};line-height:1.3;font-weight:600}
.attrib{font-size:${px(34)};font-weight:600;color:${accent}}
ul{list-style:none;display:flex;flex-direction:column;gap:${px(22)}}
li{font-size:${bodySize};line-height:1.32;padding-left:${px(48)};position:relative;overflow-wrap:anywhere}
li:before{content:'';position:absolute;left:0;top:.45em;width:${px(20)};height:${px(20)};border-radius:50%;background:${accent}}
.photo{position:absolute;inset:0}
.photo img{width:100%;height:100%;object-fit:cover;display:block}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 35%,rgba(0,0,0,.78) 100%)}
.over{position:absolute;left:${pad};right:${pad};bottom:${px(150)};color:#ffffff;display:flex;flex-direction:column;gap:${px(28)}}
.photo-foot{color:#ffffff}`

  const media = src ? `<div class="media"><img src="${src}" alt=""></div>` : ''
  let inner: string
  if (template === 'photo' && src) {
    inner = `<div class="photo"><img src="${src}" alt=""></div><div class="shade"></div><div class="over">${heading ? `<h1>${escapeHtml(heading)}</h1>` : ''}${
      body ? `<p class="body pre">${escapeHtml(body)}</p>` : ''
    }</div>${foot.replace('class="foot"', 'class="foot photo-foot"')}`
  } else if (template === 'quote') {
    const quote = body || heading
    const attribution = body ? heading : ''
    inner = `${media}<div class="quote-mark">&ldquo;</div><p class="quote pre">${escapeHtml(quote)}</p>${attribution ? `<p class="attrib">${escapeHtml(attribution)}</p>` : ''}${foot}`
  } else if (template === 'list') {
    const items = body
      .split(/\n+/)
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter(Boolean)
    const list = items.length > 0 ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''
    inner = `${heading ? `<h1>${escapeHtml(heading)}</h1>` : ''}<div class="bar"></div>${list}${media}${foot}`
  } else {
    inner = `${media}${heading ? `<h1>${escapeHtml(heading)}</h1>` : ''}${heading || body ? '<div class="bar"></div>' : ''}${
      body ? `<p class="body pre">${escapeHtml(body)}</p>` : ''
    }${foot}`
  }
  return page(size, theme, css, `<main class="slide t-${template}">${inner}</main>`)
}

// ---------------------------------------------------------------------------------------------
// Template video cards
// ---------------------------------------------------------------------------------------------

export type VideoSlide = RenderVideoInput['slides'][number]

export interface VideoSlideContext {
  template: RenderVideoInput['template']
  theme: Theme
  size: { width: number; height: number }
  /** Draw slide text over image slides (RenderVideoInput.captions). */
  captions: boolean
  image?: InlineImage | null
}

/** One card of a template video. Text stays inside the platform safe area of vertical video. */
export function videoSlideHtml(slide: VideoSlide, c: VideoSlideContext): string {
  const { theme, size } = c
  const k = size.width / 1080
  const px = (n: number) => `${Math.round(n * k)}px`
  const vertical = size.height > size.width
  const text = slide.text?.trim() ?? ''
  const src = imageSrc(c.image)
  const top = vertical ? Math.round(size.height * 0.12) : Math.round(size.height * 0.08)
  const bottom = vertical ? Math.round(size.height * 0.26) : Math.round(size.height * 0.1)
  const side = px(vertical ? 96 : 120)
  const textSize = px(fit(text.length, HEADING_STEPS, 52) * (vertical ? 1 : 0.85))

  const css = `
.slide{display:flex;flex-direction:column;justify-content:center;padding:${top}px ${side} ${bottom}px ${side};gap:${px(36)}}
.card-text{font-size:${textSize};line-height:1.15;font-weight:800;overflow-wrap:anywhere}
.bar{width:${px(140)};height:${px(14)};border-radius:${px(7)};background:${theme.accent}}
.quote-mark{font-family:'Noto Serif','DejaVu Serif',serif;font-size:${px(240)};line-height:.7;color:${theme.accent};height:${px(130)}}
.quote{font-weight:600;font-style:italic}
.photo{position:absolute;inset:0}
.photo img{width:100%;height:100%;object-fit:cover;display:block}
.caption{position:absolute;left:${side};right:${side};bottom:${bottom}px;display:flex;justify-content:center}
.caption span{background:rgba(0,0,0,.72);color:#ffffff;font-size:${px(fit(text.length, BODY_STEPS, 34) * 1.15)};line-height:1.3;font-weight:700;padding:${px(18)} ${px(28)};border-radius:${px(18)};text-align:center;overflow-wrap:anywhere;white-space:pre-line}`

  let inner: string
  if (src) {
    const caption = c.captions && text ? `<div class="caption"><span>${escapeHtml(text)}</span></div>` : ''
    inner = `<div class="photo"><img src="${src}" alt=""></div>${caption}`
  } else if (c.template === 'quote') {
    inner = `<div class="quote-mark">&ldquo;</div><p class="card-text quote pre">${escapeHtml(text)}</p>`
  } else {
    inner = `<div class="bar"></div><p class="card-text pre">${escapeHtml(text)}</p>`
  }
  return page(size, theme, css, `<main class="slide">${inner}</main>`)
}
