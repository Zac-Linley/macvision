// 冒烟测试：不需要跑起整个 DSH，用一个假 ctx 就能验证注册契约与端到端识别。
//   node test/smoke.mjs [图片路径] [PDF路径]

import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { apply } from '../index.js'

const INVOICE = process.argv[2] ?? '/Users/linley/.dsh/attachments/v1/objects/d9/d9f793fb13f576c8aff6ba226dd740a55b8507c37d887a34203117cc371be841'
const PDF = process.argv[3] ?? '/tmp/doc.pdf'

// 最小的 ctx：只实现插件用到的 tools.register
function fakeCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      tools: { register: (tool) => registered.push(tool) },
    },
  }
}

const { ctx, registered } = fakeCtx()
apply(ctx, {})

assert.equal(registered.length, 1, '应该注册一个工具')
const tool = registered[0]
assert.equal(tool.name, 'ocr_macos')
assert.ok(tool.description.includes('Vision'), '描述里要点明走的是 macOS Vision')
assert.deepEqual(tool.parameters.required, ['path'])
assert.equal(typeof tool.execute, 'function')
console.log(`✓ 注册契约: ${tool.name} / 参数 ${Object.keys(tool.parameters.properties).join(', ')}`)

// --- 图片：文本 + 坐标 ---
const img = await tool.execute({ path: INVOICE, boxes: true }, {})
assert.equal(img.kind, 'image')
assert.ok(img.text.includes('NUCTEEH MIDDLE EAST FZCO'), '应识别出客户名')
assert.ok(img.text.includes('2150.00'), '应识别出合计金额')
assert.ok(img.text.includes('AE290400008882268364901'), '应识别出 IBAN')
assert.ok(img.pages[0].lines.every((l) => Array.isArray(l.box) && l.box.length === 4), 'boxes=true 时应带坐标')
console.log(`✓ 图片: ${img.text.split('\n').length} 行, 均置信 ${img.stats.meanConfidence}, ${img.stats.ms}ms`)
console.log(`  渲染给模型的首行: ${tool.output.render({ path: INVOICE }, img)[0].text.split('\n')[0]}`)

// --- 缓存：同参数第二次不应重跑引擎 ---
const again = await tool.execute({ path: INVOICE, boxes: true }, {})
assert.equal(again.stats.ms, img.stats.ms, '同参数应命中缓存（ms 相同）')
console.log('✓ 缓存命中')

// --- 阿拉伯语单语：多语言清单会把阿文读坏，单给 ar-SA 才对 ---
const ar = await tool.execute({ path: INVOICE, languages: 'ar-SA' }, {})
assert.ok(/[\u0600-\u06FF]/.test(ar.text), 'ar-SA 应输出阿拉伯字母')
console.log(`✓ 阿语: ${ar.text.split('\n').find((l) => /[\u0600-\u06FF]/.test(l))}`)

// --- PDF：选页 + 旋转纠正 ---
try {
  await access(PDF)
  const pdf = await tool.execute({ path: PDF, pages: '3' }, {})
  assert.equal(pdf.kind, 'pdf')
  assert.equal(pdf.pageCount, 1, '--pages 3 只应返回一页')
  assert.equal(pdf.pages[0].rotation, 270, '横放的第 3 页应被纠正 270°')
  assert.ok(pdf.text.includes('LCB-5 COOLER'), '旋转纠正后应能读到明细')
  console.log(`✓ PDF: rotation=${pdf.pages[0].rotation}, ${pdf.text.split('\n').length} 行`)
} catch (error) {
  if (error.code === 'ENOENT') console.log('… 跳过 PDF 用例（没有测试文件）')
  else throw error
}

// --- 错误路径：URL 与非图片扩展名要给出人话 ---
await assert.rejects(() => tool.execute({ path: 'https://example.com/a.png' }, {}), /只读本地文件/)
await assert.rejects(() => tool.execute({ path: '/tmp/nope.txt' }, {}), /只处理图片或 PDF/)
console.log('✓ 错误路径')

console.log('\n全部通过')
