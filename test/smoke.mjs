// 冒烟测试：不需要跑起整个 DSH，用一个假 ctx 就能验证注册契约与端到端行为。
//   node test/smoke.mjs [图片] [扫描型PDF] [文字型PDF]
// 三个参数都可省略；文件不存在时对应用例自动跳过，保证 clone 下来直接 `npm test` 能跑。

import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { apply } from '../index.js'

const args = process.argv.slice(2)
const IMAGE = args[0] ?? '/Users/linley/.dsh/attachments/v1/objects/d9/d9f793fb13f576c8aff6ba226dd740a55b8507c37d887a34203117cc371be841'
const SCANNED_PDF = args[1] ?? '/tmp/doc.pdf'
const TEXT_PDF = args[2] ?? '/tmp/text.pdf'

const exists = async (p) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function fakeCtx() {
  const registered = []
  return { registered, ctx: { tools: { register: (tool) => registered.push(tool) } } }
}

const { ctx, registered } = fakeCtx()
apply(ctx, {})

assert.equal(registered.length, 1, '应该注册一个工具')
const tool = registered[0]
assert.equal(tool.name, 'ocr_macos')
assert.ok(tool.description.includes('Vision'), '描述里要点明走的是 macOS Vision')
assert.deepEqual(tool.parameters.required, ['path'])
assert.ok(tool.parameters.properties.maxLines, '应暴露 maxLines 预算参数')
console.log(`✓ 注册契约: ${tool.name} / 参数 ${Object.keys(tool.parameters.properties).join(', ')}`)

// --- 错误路径（不依赖任何文件）---
await assert.rejects(() => tool.execute({ path: 'https://example.com/a.png' }, {}), /只读本地文件/)
await assert.rejects(() => tool.execute({ path: '/tmp/nope.txt' }, {}), /只处理图片或 PDF/)
console.log('✓ 错误路径')

if (await exists(IMAGE)) {
  const img = await tool.execute({ path: IMAGE, boxes: true }, {})
  assert.equal(img.kind, 'image')
  assert.ok(img.text.includes('NUCTEEH MIDDLE EAST FZCO'), '应识别出客户名')
  assert.ok(img.text.includes('2150.00'), '应识别出合计金额')
  assert.ok(img.text.includes('AE290400008882268364901'), '应识别出 IBAN')
  assert.ok(img.stats.lines > 40, `行数应在 40 以上，实际 ${img.stats.lines}`)
  assert.ok(img.pages[0].lines.every((l) => Array.isArray(l.box) && l.box.length === 4), 'boxes=true 时应带坐标')
  console.log(`✓ 图片: ${img.stats.lines} 行, 均置信 ${img.stats.meanConfidence}, ${img.stats.ms}ms`)

  // 行预算：maxLines 生效，且 truncated 与裁剪一致
  const capped = await tool.execute({ path: IMAGE, boxes: true, maxLines: 10 }, {})
  const returned = capped.pages.reduce((n, p) => n + p.lines.length, 0)
  assert.equal(returned, 10, 'maxLines=10 只返回 10 行')
  assert.ok(capped.stats.omittedLines > 0, '应记录被省略的行数')
  assert.equal(capped.truncated, true, '裁剪后 truncated 必须为 true')
  assert.ok(JSON.stringify(capped).length < 4000, '裁剪后体积应可控')
  console.log(`✓ 行预算: 返回 ${returned} 行, 省略 ${capped.stats.omittedLines} 行, 共 ${JSON.stringify(capped).length} 字符`)

  // 并发同参只跑一遍引擎
  const [a, b] = await Promise.all([
    tool.execute({ path: IMAGE, maxChars: 900 }, {}),
    tool.execute({ path: IMAGE, maxChars: 900 }, {}),
  ])
  assert.equal(a.stats.ms, b.stats.ms, '并发同参应共享同一次引擎调用（ms 相同）')
  console.log('✓ 并发去重')

  // 阿语单语：多语言清单会把阿文读坏，单给 ar-SA 才对
  const ar = await tool.execute({ path: IMAGE, languages: 'ar-SA' }, {})
  assert.ok(/[\u0600-\u06FF]/.test(ar.text), 'ar-SA 应输出阿拉伯字母')
  console.log(`✓ 阿语: ${ar.text.split('\n').find((l) => /[\u0600-\u06FF]/.test(l))}`)
} else {
  console.log('… 跳过图片用例（没有测试图片）')
}

if (await exists(SCANNED_PDF)) {
  const pdf = await tool.execute({ path: SCANNED_PDF, pages: '3' }, {})
  assert.equal(pdf.kind, 'pdf')
  assert.equal(pdf.pageCount, 1, '--pages 3 只应返回一页')
  assert.equal(pdf.pages[0].source, 'ocr', '扫描型 PDF 应走 OCR')
  assert.equal(pdf.pages[0].rotation, 270, '横放的第 3 页应被纠正 270°')
  console.log(`✓ 扫描型 PDF: source=${pdf.pages[0].source}, rotation=${pdf.pages[0].rotation}`)
} else {
  console.log('… 跳过扫描型 PDF 用例')
}

if (await exists(TEXT_PDF)) {
  const txt = await tool.execute({ path: TEXT_PDF }, {})
  assert.equal(txt.pages[0].source, 'text-layer', '数字型 PDF 应走文字层')
  assert.ok(txt.text.includes('12655'), `文字层应精确保留 12655，实际: ${txt.text.replace(/\n/g, ' | ')}`)
  assert.ok(txt.stats.ms < 500, `文字层应远快于 OCR，实际 ${txt.stats.ms}ms`)
  console.log(`✓ 文字型 PDF: ${txt.stats.ms}ms, ${JSON.stringify(txt.text.slice(0, 40))}`)
} else {
  console.log('… 跳过文字型 PDF 用例')
}

console.log('\n全部通过')
