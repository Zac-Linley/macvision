// dsh-macvision — 把 Apple Vision 的 OCR 能力接进 DSH。
//
// 设计取舍：
//   * 零运行时依赖（只用 node: 内置模块），不引 @deepseek-ai/dsh-tools，
//     避免 peer 版本把插件卡死；工具用普通对象注册（与 defineTool 产物同构）。
//   * 引擎是 Swift 编译的单文件二进制，包内自带；换架构/换机器时自动重新编译。
//   * 只做“取字 + 坐标”，字段语义交给模型——这才是文本模型缺的那一环。

import { createEngine } from './lib/engine.js'
import { buildTool, DEFAULT_TOOL_NAME } from './lib/tool.js'

export const name = 'dsh-macvision'

// 只要 tools 服务就够；拿不到就装不上，早失败好过静默失效
export const inject = ['tools']

export function apply(ctx, config = {}) {
  if (process.platform !== 'darwin') {
    console.error('[dsh-macvision] 只支持 macOS：这个插件直接调用 Apple Vision 框架')
    return
  }

  const engine = createEngine({
    binaryPath: config.binaryPath ?? process.env.DSH_MACOS_OCR_BIN,
    forceBuild: config.forceBuild === true,
  })

  const toolName = typeof config.toolName === 'string' && config.toolName.trim() !== ''
    ? config.toolName.trim()
    : DEFAULT_TOOL_NAME

  try {
    ctx.tools.register(buildTool({ engine, config, toolName }))
  } catch (error) {
    // 同名工具已存在（宿主或另一个插件占了名字）：降级但要吵，不要静默
    console.error(`[dsh-macvision] 注册 ${toolName} 失败：${error?.message ?? error}`)
  }

  // 首次加载就把引擎备好，别让第一次调用的人等编译
  engine.binary().catch((error) => {
    console.error(`[dsh-macvision] 引擎不可用：${error?.message ?? error}`)
  })
}
