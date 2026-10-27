// 工具层：把引擎包装成模型能调用的 ocr_macos 工具。
// 关键点：返回给模型的是「可直接引用的文本 + 结构 + 置信度」，而不是一段裸字符串。

import { stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { runOcr } from './engine.js'

export const DEFAULT_TOOL_NAME = 'ocr_macos'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff', '.webp', '.gif', '.bmp', '.pdf'])
const MAX_TEXT = 60_000
const DEFAULT_MAX_TEXT = 20_000

/** 一次 OCR 的完整参数（模型可只给 path，其余走默认） */
function normalizeArgs(raw) {
  const path = typeof raw?.path === 'string' ? raw.path.trim() : ''
  if (path === '') throw new Error('ocr_macos 需要一个本地文件路径（path）')
  if (/^https?:\/\//i.test(path)) {
    throw new Error('ocr_macos 只读本地文件；请先把 URL 下载到磁盘再传路径')
  }
  const expanded = path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
  const absolute = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
  // DSH 的附件存的是 sha256 命名的无扩展名文件，所以“没有扩展名”必须放行，
  // 交给引擎按魔数嗅探；只有明确是别的格式才拦。
  const ext = extname(absolute).toLowerCase()
  if (ext !== '' && !IMAGE_EXT.has(ext)) {
    throw new Error(`ocr_macos 只处理图片或 PDF，这个扩展名不认识：${ext}`)
  }
  const languages = Array.isArray(raw?.languages)
    ? raw.languages.filter((l) => typeof l === 'string' && l.trim() !== '')
    : typeof raw?.languages === 'string' && raw.languages.trim() !== ''
      ? raw.languages.split(',').map((s) => s.trim()).filter(Boolean)
      : ['en-US']

  return {
    path: absolute,
    languages,
    fast: raw?.mode === 'fast',
    pages: typeof raw?.pages === 'string' ? raw.pages.trim() : '',
    dpi: Number.isFinite(raw?.dpi) ? Math.min(600, Math.max(40, raw.dpi)) : 200,
    minConfidence: Number.isFinite(raw?.minConfidence) ? Math.min(1, Math.max(0, raw.minConfidence)) : 0,
    autoRotate: raw?.autoRotate !== false,
    boxes: raw?.boxes === true,
    maxChars: Number.isFinite(raw?.maxChars) ? Math.min(MAX_TEXT, Math.max(500, raw.maxChars)) : DEFAULT_MAX_TEXT,
    // 行数预算：maxChars 只约束 text，coordinates 曾是无限量返回（50 页能到 160k 字符）
    maxLines: Number.isFinite(raw?.maxLines) ? Math.min(20_000, Math.max(1, raw.maxLines)) : 1000,
  }
}

function toCliArgs(o) {
  const args = [o.path, '--json', '--langs', o.languages.join(','), '--dpi', String(o.dpi)]
  if (o.fast) args.push('--fast')
  if (o.pages) args.push('--pages', o.pages)
  if (o.minConfidence > 0) args.push('--min-conf', String(o.minConfidence))
  if (!o.autoRotate) args.push('--no-auto-rotate')
  return args
}

/** 文件身份 + 选项 → 缓存键；同一张图换个问题不必重跑引擎 */
function cacheKey(o, stamp) {
  return JSON.stringify([o.path, stamp, o.languages, o.fast, o.pages, o.dpi, o.minConfidence, o.autoRotate, o.boxes, o.maxChars, o.maxLines])
}

function shape(engineResult, o, ms) {
  // 行预算是整份结果共享的：先到先得，后面的页记为 omittedLines，
  // 这样 truncated 标记和实际返回内容永远一致。
  let lineBudget = o.maxLines
  const pages = (engineResult.pages ?? []).map((p) => {
    const raw = p.lines ?? []
    const take = Math.max(0, Math.min(raw.length, lineBudget))
    lineBudget -= take
    const lines = raw.slice(0, take).map((l) =>
      o.boxes ? { text: l.text, confidence: l.confidence, box: l.box } : { text: l.text, confidence: l.confidence },
    )
    return {
      page: p.page,
      width: p.width,
      height: p.height,
      rotation: p.rotation,
      source: p.source ?? 'ocr',
      lines,
      omittedLines: raw.length - take,
    }
  })

  const allLines = pages.flatMap((p) => p.lines)
  const confidences = allLines.map((l) => l.confidence)
  const mean = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0
  const low = allLines.filter((l) => l.confidence < 0.5).length

  const full = pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n\n')
  const omitted = pages.reduce((n, p) => n + p.omittedLines, 0)
  const truncated = full.length > o.maxChars || omitted > 0

  return {
    engine: engineResult.engine ?? 'Apple Vision',
    file: engineResult.file ?? o.path,
    kind: engineResult.kind ?? 'image',
    pageCount: engineResult.pageCount ?? pages.length,
    text: truncated ? `${full.slice(0, o.maxChars)}\n…（已截断，共 ${full.length} 字符）` : full,
    truncated,
    stats: {
      pages: pages.length,
      lines: allLines.length,
      chars: full.length,
      meanConfidence: Math.round(mean * 100) / 100,
      lowConfidenceLines: low,
      rotations: pages.map((p) => p.rotation).filter((r, i, a) => r !== 0 && a.indexOf(r) === i),
      omittedLines: omitted,
      sources: [...new Set(pages.map((p) => p.source))],
      ms,
    },
    pages,
  }
}

function render(o, value) {
  const { stats } = value
  const via = stats.sources?.includes('text-layer')
    ? stats.sources.length > 1 ? '文字层+OCR' : 'PDF 文字层（精确文本）'
    : 'Vision OCR'
  const head = [
    `${via} · ${value.kind === 'pdf' ? 'PDF' : '图片'} · ${stats.pages} 页 · ${stats.lines} 行 · ` +
      `平均置信度 ${stats.meanConfidence}${stats.lowConfidenceLines ? ` · 低置信 ${stats.lowConfidenceLines} 行` : ''}` +
      `${stats.rotations?.length ? ` · 已纠正旋转 ${stats.rotations.join('/')}°` : ''} · ${stats.ms}ms`,
    `语言 ${o.languages.join(',')} · ${value.file}` +
      `${stats.omittedLines ? ` · 因行数上限省略 ${stats.omittedLines} 行（调大 maxLines 可看全）` : ''}`,
  ].join('\n')

  const body = value.text.trim() === '' ? '（这一页没有识别到文字）' : value.text

  if (!o.boxes) return [{ type: 'text', text: `${head}\n\n${body}` }]

  const tables = value.pages
    .filter((p) => p.lines.length > 0)
    .map((p) => {
      const rows = p.lines
        .map((l) => `  x=${String(Math.round(l.box[0])).padStart(5)} y=${String(Math.round(l.box[1])).padStart(5)}  ${l.text}`)
        .join('\n')
      return `第 ${p.page} 页坐标（左上角原点，像素）:\n${rows}`
    })
    .join('\n\n')

  return [{ type: 'text', text: `${head}\n\n${body}\n\n${tables}` }]
}

/**
 * 构造工具定义。与宿主 @deepseek-ai/dsh-tools 的 defineTool 同构，
 * 但保持零依赖：直接用普通对象注册，避免插件被 peer 版本卡住。
 */
export function buildTool({ engine, config = {}, toolName = DEFAULT_TOOL_NAME, logger = console }) {
  const cache = new Map()
  const cacheLimit = Number.isFinite(config.cacheSize) ? Math.max(0, config.cacheSize) : 16

  // 同一文件同一参数的并发调用只跑一次引擎：没有这张表时两次并发会各跑一遍
  // （实测 1690ms / 1663ms，纯浪费）
  const inflight = new Map()

  async function invoke(rawArgs, exec = {}) {
    const started = Date.now()
    const o = normalizeArgs(rawArgs)

    const info = await stat(o.path).catch(() => null)
    if (!info?.isFile()) throw new Error(`文件不存在或不是普通文件：${o.path}`)

    const key = cacheKey(o, `${info.mtimeMs}:${info.size}`)
    if (cache.has(key)) return cache.get(key)
    if (inflight.has(key)) return await inflight.get(key)

    const pending = (async () => {
    const binary = await engine.binary()
    const result = await runOcr(binary, toCliArgs(o), {
      timeoutMs: config.timeoutMs ?? 180_000,
      signal: exec.signal,
    })
    const value = shape(result, o, Date.now() - started)

    if (cacheLimit > 0) {
      cache.set(key, value)
      while (cache.size > cacheLimit) cache.delete(cache.keys().next().value)
    }
    return value
    })()

    inflight.set(key, pending)
    try {
      return await pending
    } finally {
      inflight.delete(key)
    }
  }

  return {
    name: toolName,
    description:
      '用 macOS 自带的 Vision 框架对本地图片或 PDF 做 OCR，把识别出的文字（可选带坐标）直接交给模型。' +
      '当需要读取扫描件、截图、拍照文档、发票/合同/表格，或 PDF 里的文字无法选中时调用。' +
      '完全离线、不需要 API key。返回 text（按阅读序的纯文本）、逐页结构、每行置信度；' +
      '需要还原表格布局时把 boxes 设为 true 取像素坐标。识别质量差时可指定 languages，' +
      '例如中文单据用 zh-Hans，中英混排用 zh-Hans,en-US，阿拉伯语用 ar-SA。',

    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '本地绝对路径（支持 png/jpeg/heic/tiff/webp 和 pdf），不要传 URL',
        },
        languages: {
          type: 'string',
          description:
            '逗号分隔的 BCP-47 语言，默认 en-US。混排文档建议先只给主语言：Vision 给多个语言时会用第一个去硬读，' +
            '阿拉伯文这类非拉丁文字容易被读坏（例：document_ar 用 ar-SA，中文用 zh-Hans）',
        },
        mode: {
          type: 'string',
          enum: ['accurate', 'fast'],
          description: 'accurate 默认，神经网络模型；fast 快约 3 倍，清晰印刷体够用，小字号易掉字符',
        },
        pages: {
          type: 'string',
          description: 'PDF 页码，如 "1-3,7"；不填为全部。扫描多页时只取需要的页更省时间',
        },
        dpi: {
          type: 'number',
          description: 'PDF 渲染分辨率，默认 200；小字单据可提到 300',
        },
        minConfidence: {
          type: 'number',
          description: '丢弃低于该置信度的行（0–1），默认 0 全保留',
        },
        autoRotate: {
          type: 'boolean',
          description: '默认 true：先用 fast 探测 0/90/180/270 四向，挑最正的再精读。横放扫描件必须留 true',
        },
        boxes: {
          type: 'boolean',
          description: '返回每行像素坐标，用于还原表格行列、逐字段核对。默认 false',
        },
        maxChars: {
          type: 'number',
          description: '返回文本上限，默认 20000，超出会截断并置 truncated',
        },
        maxLines: {
          type: 'number',
          description: '带坐标时返回的行数上限，默认 1000。超出部分丢弃并计入 stats.omittedLines，避免长 PDF 撑爆上下文',
        },
      },
      required: ['path'],
    },

    output: {
      schema: {
        type: 'object',
        properties: {
          engine: { type: 'string', description: '实际使用的引擎标识' },
          file: { type: 'string', description: '被识别的文件路径' },
          kind: { type: 'string', description: 'image 或 pdf' },
          pageCount: { type: 'number', description: '识别到的页数' },
          text: { type: 'string', description: '按阅读序拼接的纯文本，可直接引用' },
          truncated: { type: 'boolean', description: '文本是否被 maxChars 截断' },
          stats: {
            type: 'object',
            properties: {
              pages: { type: 'number' },
              lines: { type: 'number' },
              chars: { type: 'number' },
              meanConfidence: { type: 'number' },
              lowConfidenceLines: { type: 'number' },
              rotations: { type: 'array', items: { type: 'number' } },
              omittedLines: { type: 'number' },
              sources: { type: 'array', items: { type: 'string' } },
              ms: { type: 'number' },
            },
            required: ['pages', 'lines', 'chars', 'meanConfidence', 'lowConfidenceLines', 'ms'],
          },
          pages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                page: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                rotation: { type: 'number' },
                source: { type: 'string', description: 'text-layer（PDF 文字层直出）或 ocr' },
                omittedLines: { type: 'number', description: '因 maxLines 预算被丢弃的行数' },
                lines: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      text: { type: 'string' },
                      confidence: { type: 'number' },
                      box: { type: 'array', items: { type: 'number' }, description: '[x,y,w,h] 左上角原点像素坐标' },
                    },
                    required: ['text', 'confidence'],
                  },
                },
              },
              required: ['page', 'width', 'height', 'rotation', 'source', 'lines'],
            },
          },
        },
        required: ['engine', 'file', 'kind', 'pageCount', 'text', 'truncated', 'stats', 'pages'],
      },
      render: (args, value) => render(normalizeArgs(args), value),
    },

    timeoutMs: (config.timeoutMs ?? 180_000) + 20_000,
    isConcurrencySafe: () => true,

    presentCall: (args) => ({
      card: 'generic',
      title: toolName,
      kind: 'read',
      rawInput: args,
      ...(typeof args?.path === 'string' && !/^https?:\/\//i.test(args.path)
        ? { locations: [{ path: args.path }] }
        : {}),
    }),

    async execute(args, exec) {
      try {
        return await invoke(args, exec)
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        logger.error?.(`[dsh-macvision] ${error?.message ?? error}`)
        throw error
      }
    },
  }
}
