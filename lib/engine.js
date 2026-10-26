// 二进制解析与调用层：找引擎 → 跑一次 → 解析 JSON。
// 目标：装完即用（包内自带 arm64 二进制），换机器/换架构时能自己编。

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_ROOT = join(homedir(), 'Library', 'Caches', 'dsh-macvision')
const IS_MAC = process.platform === 'darwin'

/** 调用方给的可执行文件路径 / 缓存里的编译产物 / 包内预编译的二进制 */
function candidates(env) {
  return [
    env.binaryPath,
    join(CACHE_ROOT, 'macocr'),
    join(PKG_ROOT, 'bin', 'macocr'),
  ].filter((p) => typeof p === 'string' && p.length > 0)
}

async function executable(path) {
  if (!path) return false
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 跑一个短命令并回收 stdout，供 swiftc 探测与编译使用 */
function runToEnd(command, args, { timeoutMs = 180_000, signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timer
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      child.kill('SIGKILL')
      cleanup()
      reject(Object.assign(new Error('已取消'), { name: 'AbortError' }))
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        cleanup()
        reject(new Error(`${command} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
    }
    child.stdout.on('data', (b) => (stdout += b))
    child.stderr.on('data', (b) => (stderr += b))
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      cleanup()
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/** swiftc 在不在？不在就给出可执行的修复建议，而不是让用户读堆栈 */
async function requireSwiftc() {
  try {
    const { code } = await runToEnd('swiftc', ['--version'], { timeoutMs: 20_000 })
    if (code === 0) return
  } catch {
    /* 落到下面的报错 */
  }
  throw new Error(
    '这台机器上没有 swiftc，无法编译 OCR 引擎。运行 `xcode-select --install` 安装 Command Line Tools，' +
      '或用 DSH_MACOS_OCR_BIN 指向一个已有的 macocr 二进制。',
  )
}

/**
 * 引擎单例：并发调用只编一次。
 * @param {{binaryPath?: string, forceBuild?: boolean}} options
 */
export function createEngine(options = {}) {
  let pending = null

  async function build() {
    const source = join(PKG_ROOT, 'swift', 'macocr.swift')
    await access(source, fsConstants.R_OK)
    await requireSwiftc()
    await mkdir(CACHE_ROOT, { recursive: true })
    const target = join(CACHE_ROOT, 'macocr')
    const tmp = `${target}.${process.pid}.tmp`
    const result = await runToEnd(
      'swiftc',
      ['-O', '-module-cache-path', join(CACHE_ROOT, 'module-cache'), source, '-o', tmp],
      { timeoutMs: 300_000 },
    )
    if (result.code !== 0) {
      await rm(tmp, { force: true })
      throw new Error(`swiftc 编译失败：${result.stderr.trim().slice(-800)}`)
    }
    await rename(tmp, target)
    return target
  }

  async function locate() {
    if (options.forceBuild) return await build()
    for (const path of candidates(options)) {
      if (await executable(path)) return path
    }
    if (options.forceBuild || IS_MAC) return await build()
    throw new Error('找不到 OCR 引擎二进制')
  }

  return {
    async binary() {
      if (!pending) {
        pending = locate().catch((error) => {
          pending = null // 失败不缓存，下次还能重试
          throw error
        })
      }
      return await pending
    },
    platform: process.platform,
  }
}

/**
 * 跑一次 OCR，返回引擎的 JSON。
 * @param {string} binary
 * @param {string[]} args
 * @param {{timeoutMs?: number, signal?: AbortSignal}} exec
 */
export async function runOcr(binary, args, exec = {}) {
  const { code, stdout, stderr } = await runToEnd(binary, args, {
    timeoutMs: exec.timeoutMs ?? 240_000,
    signal: exec.signal,
  })
  if (code !== 0) {
    const detail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' / ')
    throw new Error(`macOS OCR 引擎退出码 ${code}${detail ? `：${detail}` : ''}`)
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`OCR 引擎输出不是合法 JSON（前 200 字符）：${stdout.slice(0, 200)}`)
  }
}
