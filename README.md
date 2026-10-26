# MacVision

给 DeepSeek Harness 一个**离线、零依赖**的 OCR 工具：直接调 macOS 自带的 Vision 框架，把扫描件、截图、拍照文档和 PDF 里的文字，连同逐行坐标一起交给模型。

不需要 API key，不需要联网，不需要装 Python/模型权重。

## 为什么需要它

DeepSeek 是纯文本模型。图片进来时有三条路可走，各有短板：

| 路线 | 短板 |
|---|---|
| 云端视觉模型（modlens 一类） | 要 key、要联网，票据内容出本机 |
| 原生多模态 | 给不了坐标，长文档容易漏行 |
| 本地 OCR 引擎（RapidOCR/Tesseract） | 要 Python 环境或 brew 装依赖，包体大 |

macOS 自带的 Vision 框架把这件事解决了：系统内置、`VNRecognizeTextRequest` 支持中英阿日韩等语言、单页 0.9 秒、还能给出每行的像素坐标。这个插件就是把它接进 DSH 的工具层。

## 架构

```
模型调用 ocr_macos(path)
        │
        ├─ lib/tool.js    参数校验 → 文件指纹缓存 → 结果整形 → 渲染成可引用文本
        ├─ lib/engine.js  找二进制（env → 缓存 → 包内）→ 没有就用 swiftc 现编 → spawn
        └─ swift/macocr.swift
              ├─ 图片：ImageIO 读 EXIF → 短边放大到 1600px → Vision
              └─ PDF：CGPDFDocument 逐页 → getDrawingTransform 处理 /Rotate → 渲染 @200dpi → Vision
                        │
                        └─ 定向探测：0/90/180/270 各跑一次 fast，挑最正的再 accurate 精读
```

三个刻意的设计：

1. **零运行时依赖**。不 import `@deepseek-ai/dsh-tools`，工具用普通对象注册（与其 `defineTool` 产物同构）。这样宿主版本升级不会因为 peer 范围把插件卡死——`@liustack/modlens` 就是被 `github:` 安装方式坑到 `dist` 缺失的。
2. **只取字，不做语义**。Vision 输出「行 + 坐标 + 置信度」，字段含义交给模型。分工清楚：本地负责快和准，模型负责理解。
3. **结果直接进上下文**。`render` 产出一段带统计头的文本，模型不需要再解析 JSON 就能引用。

## 安装

```bash
# 在插件目录里
cd dsh-macvision
npm install -g .            # 或 pnpm add -g . ；也可以直接 npm link 到 profile

# 注册进当前 profile
dsh plugin add dsh-macvision
```

手工安装（不想用 CLI 时）——编辑 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": { "dsh-macvision": "link:/绝对路径/dsh-macvision" },
  "dsh": { "profile": { "bundles": ["…", "dsh-macvision"] } }
}
```

然后在 profile 目录 `pnpm install`，重启 DSH。挂载由包内 `cordis.patch.yml` 完成，不需要改 `cordis.patch.yml` 那一层。

> 只在 macOS 上可用。Linux/Windows 上 `apply` 会打印一行原因后直接返回，不会注册半残的工具。

## 工具参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `path` | string | 必填 | 本地图片或 PDF 路径；URL 会被拒绝 |
| `languages` | string | `en-US` | 逗号分隔。中文单据 `zh-Hans`，中英混排 `zh-Hans,en-US`，阿语 `ar-SA` |
| `mode` | `accurate`/`fast` | `accurate` | fast 快约 3 倍，小字号易掉字符 |
| `pages` | string | 全部 | PDF 页码，如 `1-3,7` |
| `dpi` | number | `200` | PDF 渲染分辨率，小字单据可到 300 |
| `minConfidence` | number | `0` | 丢弃低置信行 |
| `autoRotate` | boolean | `true` | 四向 fast 探测再精读，横放扫描件必备 |
| `boxes` | boolean | `false` | 返回每行 `[x,y,w,h]` 像素坐标 |
| `maxChars` | number | `20000` | 超出截断并置 `truncated` |

返回：`text`（按阅读序的纯文本）、`pages[].lines[]`（文本 + 置信度 + 可选坐标）、`stats`（行数、均置信度、低置信行数、纠正的旋转角、耗时）、`truncated`。

## 实测

用一张 1653×2327 的迪拜 proforma invoice（中英阿三语混排）：

| 项目 | 结果 |
|---|---|
| 拉丁文本 | 全对：`IBAN:AE290400008882268364901`、两个 15 位 TRN、`2150.00` |
| 阿拉伯文 | `اويسيس غاردن ش م ح`（单语 `ar-SA`） |
| 耗时 | 1.7s（含四向探测）；`--no-auto-rotate` 约 0.9s |
| 坐标 | 49 行全部带框，可用于还原金额列右对齐 |

跑测试：

```bash
node test/smoke.mjs [图片] [PDF]
```

验证的是注册契约、内容命中、缓存命中、阿语单语、PDF 选页 + 旋转纠正、错误路径。

## 已知限制

- **多语言清单会打架**。给 `en-US,ar-SA` 时 Vision 会用第一个语言硬读阿文行，输出 `Sent B` 之类的垃圾；单给 `ar-SA` 反而中英阿全对。所以 `languages` 建议只给主语言，或分次调用。
- **字母归一化**。`گ`（波斯语 gaf）会被读成 `غ`，`پ` 成 `ي`。这是字体映射差异，不是识别错误，下游做实体匹配前要先归一化。
- **手写体不可靠**。签名、批注这类只有 0.3–0.5 置信度，别当权威值。
- **印章/水印**是物理退化，弧形文字的置信度天然低。
- 每页位图上限 4000 万像素；超过的畸形 PDF 会被跳过而不是把内存撑爆。

## 目录

```
index.js             插件入口（name / inject / apply）
lib/engine.js        二进制定位、自动编译、spawn、超时与取消
lib/tool.js          工具定义、参数规范化、缓存、结果整形与渲染
swift/macocr.swift   Vision 引擎源码（图片 + PDF + 定向探测）
bin/macocr           预编译二进制（arm64，169KB）
cordis.patch.yml     bundle 挂载层
test/smoke.mjs       冒烟测试
```

重新编译引擎：

```bash
npm run build:engine      # 需要 Xcode Command Line Tools
```

## 致谢

PDF 逐页渲染与 `getDrawingTransform` 的处理方式参考了 [schappim/macOCR](https://github.com/schappim/macOCR)（2.4k star，Swift 写的菜单栏取字工具）。
