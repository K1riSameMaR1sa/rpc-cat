# RPC CAT · 管理局翻译工作台

给 RPC 管理局（RPC Authority）译者用的**纯前端**翻译辅助工具：

- **对齐制作** —— 粘贴英文原文 + 中文译文，自动做段落级／句级对齐，人工可修正，一键生成 **TMX**
- **翻译记忆库** —— 导入／导出 TMX，检索、编辑、去重、合并；语料存在浏览器本机
- **CAT 式工作台** —— 逐句翻译，自动给出 100% 精确匹配与模糊匹配百分比，查证检索，进度统计
- **语料库** —— 保存翻译项目，随时继续翻译或导出纯译文

没有后端，没有上传，没有账号。所有数据保存在你自己浏览器的 IndexedDB 里。
可以直接托管到 GitHub Pages。

---

## 快速开始

### 最简单：双击 `rpc-cat.html`

仓库里的 **`rpc-cat.html`** 是**单文件版**：样式、脚本、示例记忆库全部内联在
一个文件里，**直接双击就能用**，不需要服务器、不需要联网。

> 为什么不能双击 `index.html`？浏览器出于安全策略，
> **禁止 `file://` 下加载 ES 模块**，脚本会被整个拦掉，
> 表现就是「页面能打开，但所有按钮都没反应」。
> `index.html` 是给本地开发和 GitHub Pages 用的；
> 如果你双击了它，页面会在 1.5 秒后弹出提示告诉你该怎么办。

### 本地运行（开发用）

ES 模块需要一个 HTTP 服务：

```bash
git clone <your-repo-url>
cd rpc-cat
npm run serve          # 然后打开 http://localhost:8080/
```

没有 Node 也可以用任意静态服务器，例如 `python -m http.server 8080`。

### 部署到 GitHub Pages

1. 把仓库推到 GitHub。
2. **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
3. 仓库自带的 `.github/workflows/pages.yml` 会自动构建单文件版、跑测试并发布，
   地址形如 `https://<用户名>.github.io/<仓库名>/`。

> 也可以把 Source 选成 **Deploy from a branch**（分支 `main`、目录 `/ (root)`），
> 一样能用，因为整个应用就是静态文件。

### 改完代码后

```bash
npm run build          # 重新生成 rpc-cat.html
npm test               # 四组测试
```

`rpc-cat.html` 是**构建产物，但建议一起提交**，这样别人 clone 下来就能直接双击用。
它由 `js/` 下的 ES 模块生成——那些才是唯一的事实来源，别直接改 `rpc-cat.html`。

---

## 功能说明

### 1. 对齐制作（生成 TMX）

分别粘贴英文原文和中文译文 → **自动对齐** → 检查表格 → **存入记忆库** 或 **导出 TMX**。

对齐算法与离线构建 RPC Authority 中英记忆库的流程完全一致：

1. **段落级单调动态规划**。相似度由跨语言特征合成：
   - **锚点重合** —— 编号（`RPC-691`、`Site-070`）、日期（`5/12/2017`、`2017年5月12日`、
     `16-17 July, 1462` 都会归一化成同一种标记）、小数、百分数；
   - **结构标签** —— `Object Class:` ↔ `项目分级：`、`Containment Protocols:` ↔ `收容协议：` 等；
   - **长度合理性** —— 以**该段自身**的中英长度比为准，而不是全局常数；
   - **必须保留的标识符** —— 含数字的记号（`RPC-691`、`MP4`、`3.75G`）译文中通常原样保留，
     若一侧有而另一侧完全没有，就说明多半不是一对。
   跳过段落是**零成本**的，配对必须超过阈值才会成立，所以无关段落不会被硬凑成一对。
2. **句级对齐**。两侧句数相同就 1:1 直配；否则用小型单调 DP 分组，置信度不足时整段作为一条输出。

表格里可以手动 **并入上一行 / 并入下一行 / 拆分为两句 / 取消配对 / 删除该行**，
确认后导出或入库。

### 2. 翻译记忆库

- 导入 TMX / CSV / JSON
- 检索（支持正则，写作 `/pattern/`）、编辑、单条或批量删除、跨库移动
- 删除完全重复条目；统计同一源文的多译法
- 导出 TMX（可导入 Trados、memoQ、OmegaT、CafeTran 等）、CSV、JSON

### 3. 工作台

粘贴英文原文后按句切分，每一句：

- 展示记忆库匹配（100% 精确 / 模糊百分比），点击即填入译文
- 高亮 `███`、`[[...]]`、`RPC-XXX`、数字等**必须原样保留**的内容
- 译文若漏掉原文中的编号，会就地提示「缺少 …」
- 快捷键：`Ctrl+Enter` 确认并下一句，`Alt+↑/↓` 切换句子，`Esc` 关弹窗

可导出**双语 TMX**（直接进记忆库）或**纯译文文本**。

### 4. 语料库

翻译项目保存在这里，可以继续翻译、导出 TMX、导出纯译文，或一键存入记忆库。

---

## 内置示例记忆库

仓库里的 `data/demo-tm.tmx` 是从完整记忆库里抽出的 **660 条**高质量对照
（涵盖 RPC 主条目、故事、设定页等 30 个页面），让应用开箱即用。

**完整的 RPC Authority 中英记忆库约 2.9 万条**，文件 21 MB，不适合放进 git 仓库。
用顶部的 **导入 TMX** 按钮加载即可，它会一直留在浏览器里。
（用同一套流程构建，字段与示例库一致。）

---

## 项目结构

```
rpc-cat.html            ★ 单文件版（构建产物，双击即用）
index.html              应用外壳（开发 / GitHub Pages 用，需要 HTTP 服务）
css/style.css           主题样式
js/
  app.js                状态、路由、记忆库装载、导入导出
  ui.js                 DOM 小工具、弹窗、通知、文件读写
  tmx.js                TMX 1.4 解析与生成（无依赖，含 CDATA / 实体）
  segment.js            断句、锚点抽取、结构标签、Wikidot 分块
  align.js              跨语言对齐（段落 DP + 句级 DP）
  match.js              模糊匹配引擎（倒排索引 + 编辑距离）、查证检索
  db.js                 IndexedDB 存储层
  views/                workbench / align / memory / corpus / settings
tests/
  run.mjs               逻辑单元测试
  smoke.mjs             在 DOM 垫片上真实渲染每个视图
  dom-shim.mjs          极简 DOM，用于在 Node 里跑视图
  db.mjs                存储层测试（真实调用 db.js）
  idb-shim.mjs          内存版 IndexedDB
  bundle.mjs            启动单文件版并真的去点每一个按钮
scripts/
  serve.mjs             本地静态服务器
  bundle.mjs            生成 rpc-cat.html
  make-demo-tm.py       从完整 TMX 抽取示例库
data/demo-tm.tmx        示例记忆库
```

## 测试

```bash
npm test              # 四组全跑
npm run test:unit     # TMX 往返、断句、锚点、对齐、模糊匹配
npm run test:smoke    # 在极简 DOM 上渲染每个视图
npm run test:db       # IndexedDB 存储层（内存版 IDB）
npm run test:bundle   # 启动单文件版，逐个点击按钮验证真的有效
```

- **单元测试**覆盖 TMX 往返（含 CDATA 与实体）、中英断句、锚点抽取、
  跨语言对齐（带省略号错位与年表错位的回归用例）、模糊匹配与查证检索。
- **冒烟测试**在一个极简 DOM 上真实调用每个视图的 `render()`，
  抓「导入了不存在的导出名」「渲染时抛异常」这类问题。
- **存储层测试**用一个内存版 IndexedDB 跑通真实路径：
  建库 → 导入内置 TMX 全部 660 条 → 读回 → 建索引 → 检索 → 编辑 → 删除。
- **单文件版测试**会真的加载 `rpc-cat.html`、真的去点导航按钮、点「载入示例记忆库」、
  点「开始翻译」、点一条匹配建议，确认按钮**确实有效**——
  因为「按钮全部没反应」正是这套工具最容易踩的坑。
- CI（`.github/workflows/pages.yml`）在发布前会构建单文件版并跑全部四组测试。

## 隐私

所有数据都在浏览器本地（IndexedDB）。工具不会向任何服务器发送内容。
换浏览器或清理浏览器数据会丢失内容，请用 **导出 TMX** 定期备份。

---

## 授权

- **代码**：MIT，见 `LICENSE`。
- **语料**（`data/demo-tm.tmx`，以及你用本工具导入的记忆库内容）：
  来自 [RPC Authority 英文主站](https://rpc-wiki.net/) 与
  [RPC 管理局中文分站](https://rpc-wiki-cn.wikidot.com/)，
  两者均采用 **[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)**。
  重新分发这些语料时请保留署名与相同方式共享条款——用本工具导出的 TMX
  会在文件头部自动写入授权与署名信息。

RPC Authority 及其标志为其各自权利人所有。本项目是非官方的社区工具。
