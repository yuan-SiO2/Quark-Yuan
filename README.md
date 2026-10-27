# Quark-Yuan

夸克网盘 **官方网页 UI + 会员通道多连接下载** 的 Electron 桌面壳。

用官方网页做界面（跟网页 1:1），把「下载」这一步换成自研的多连接下载器：
用客户端 UA 拿真实直链，再走 N 路 Range 并发，实测 8 连接 ≈ 14 MB/s（会员账号，9.5GB 文件）。

> 非官方客户端，与夸克/UC 无关。仅供个人备份与学习研究，请遵守夸克网盘服务条款，勿用于传播侵权内容。

## 功能

**下载（核心）**
- 用**客户端 UA**（`quark-cloud-drive/…`）调官方接口拿真实直链；浏览器 UA 只会拿到 `23018 下载超限`
- 自研多连接下载器：按 `range_size` 切片、N 路并发 Range、按 offset 写入、断点续传、412/403 自动重取直链
- 兜底：原生下载失败时退回 `quark-drive download --id`（单连接）

**登录**
- 网页扫码登录一次即可；cookie 每 20 秒同步一次，并写入 `~/.config/quark-yuan/cookie.txt` 供下载器使用

**面板（右下角「下载进度」）**
- 任务列表：进度条、速度、状态、取消；「清除」移除已完成/失败/已取消
- 「—」最小化为**圆形图标按钮**：无任务蓝色描边、有任务绿色描边
- 状态圆点：绿=正常、红=异常（悬停看原因）
- 「链接」：嗅探结果入口；「设置」：下载目录 + 深色/亮色主题

**转存分享**
- 自动嗅探页面上的 `pan.quark.cn/s/…`（识别提取码、去重）
- 点「转存」打开**独立窗口**：解析分享 → **树形展开**分享内容（点 ▸ / 文件夹名按需展开，逐层缩进）→ 勾选 → 逐级选目标目录 → 只转存勾选项
- 勾选文件夹 = 整个文件夹整包转存，其下条目显示为「已包含」；想单独挑内部文件，取消该文件夹的勾选后展开勾选即可（跨目录勾选会合并成一次转存，并自动去掉重复的上级/下级）
- 转存时**不信窗口送来的 token**：按勾选项所在目录 + 本次 stoken 现场重取 `fid_token`（夸克的 token 与 stoken 同源，拿旧的配新 stoken 会报「转存文件token校验异常」）；遇到 token 类错误自动换新 stoken 重试一次

**回收站**
- 站点把回收站写死成「请用客户端」，这里点回收站会弹**自己的查看窗口**（总数/名称/大小/刷新）
- **只读**：恢复与彻底删除的接口已从代码中移除，没有任何写入口

**网页深色**
- 站点本身没有深色主题，用「整页反色 + 媒体回正」实现；图片/视频/头像单独反色一次，避免嵌套偏色
- 主题在「设置」里切换，持久化到 `appTheme`

**其它稳健性**
- 拦截 `qkclouddrive://` 协议（JS 层 + 导航层 + 新窗口）
- 只接管**网盘文件直链**，客户端安装包等一律不下载
- 不可预览类型（safetensors/ckpt/7z…）拦预览跳转；视频/图片/文档正常预览

## 安装（AppImage · x86_64）

从 [Releases](https://github.com/yuan-SiO2/quark-yuan/releases) 下载 `Quark-Yuan-*-x86_64.AppImage`：

```bash
chmod +x Quark-Yuan-*-x86_64.AppImage
./Quark-Yuan-*-x86_64.AppImage
```

- 免安装，包内自带 Electron 运行时、界面代码与图标
- 首次运行会把配置复制到 `~/.config/quark-yuan/config.json`（AppImage 自身只读，改动都写这里）
- 若想装进应用菜单：把 AppImage 和仓库里的 `quark-yuan.desktop` 放到同一目录，或自行执行 `desktop-file-install`

## 从源码运行

解压后直接运行 [`start.sh`](start.sh)，它会把环境自举好再启动：

```bash
./start.sh              # 缺什么装什么，装过的跳过，然后启动
./start.sh --check      # 只体检：Node / 依赖 / 引擎 / 系统库，不下载不启动
./start.sh --force-deps # 忽略安装标记，重新校验依赖
./start.sh --appimage   # dist/ 里已有 AppImage 时直接跑它（零下载）
./start.sh -- --ozone-platform=x11   # 额外参数透传给 Electron
```

自举逻辑（每一步都先检测，**已存在的绝不重复下载**）：

| 缺失项 | 处理 | 存放位置 |
|---|---|---|
| Node ≥ 20 | 下载官方 Linux 运行时（约 30MB，仅一次） | `.runtime/node/`（已装 Node 则完全跳过） |
| Electron 依赖 | `pnpm install`（无 pnpm 时用 npm）；二进制命中 `~/.cache/electron` 就不重下 | `node_modules/` |
| 安装标记 | `package.json` + lock 的 md5，未变则跳过整步 | `.bootstrap/deps.md5` |
| quark-drive 引擎 | 不做下载（项目不含该第三方二进制），仅提示 | 可选 |

系统库（GTK/NSS/ALSA/GBM/xkbcommon）无法免 sudo 安装，脚本会体检并给出对应发行版的安装命令。

要求：Linux x86_64 / arm64（Windows、macOS 未适配，逻辑上只依赖 Electron，可自行移植）。

## 打包（AppImage · x86_64）

```bash
pnpm add -D electron-builder   # 打包器不进运行时依赖，按需安装一次
pnpm run appimage              # → dist/Quark-Yuan-<version>-x86_64.AppImage（约 143MB）
```

打包会从 **`../quark-drive-extract/usr/bin/quark-drive`**（连同 `usr/lib` 依赖）把引擎塞进包内
`resources/engine/`，因此需要在同级目录准备好解开后的引擎；仓库里不含该二进制。

> 没有引擎也能跑：直链下载走 `src/fetcher.js` + 网页 cookie，引擎只用于 CLI 兜底与它自己的登录校验。
> 只是没有引擎时面板状态圆点是红的（提示「引擎未就绪」）。

## 配置

包内 `config.json` 是默认值，用户改动写到 `~/.config/quark-yuan/config.json`：

| 键 | 说明 |
|---|---|
| `startUrl` | 启动打开的页面（默认夸克网盘文件列表） |
| `engine.path` | quark-drive 可执行文件；留空则用包内自带的 |
| `engine.clientUA` | 客户端 UA（拿会员直链的关键） |
| `downloadDir` | 下载目录，支持 `~/…`（面板「设置」可改） |
| `conn` | 下载并发连接数（默认 8） |
| `nativeDownload` | 用自研多连接下载器 |
| `spoofClientUA` | 让网页自己的下载请求以客户端身份发出 |
| `maxParallelJobs` | 同时进行的任务数 |
| `autoCancelBrowserDownload` | 取消浏览器原生下载（改由本地接管） |
| `appTheme` | `dark` / `light` |
| `nonPreviewAction` | 不可预览文件被点击时：`block` / `toast` / `download` |
| `previewBlockAll` | `true` 则所有预览都不跳转 |
| `hideLimitDialog` | 兜底隐藏站点「超限」弹窗 |

## 目录结构

```
src/
  main.js               主进程：窗口、协议拦截、UA 伪装、IPC、主题注入
  preload.js            面板 UI（下载进度 / 链接 / 设置 / 回收站窗口）+ 与主进程通信
  hooks.js              注入页面主世界：列表抓取、协议拦截、嗅探、深色媒体修正、回收站页面清理
  engine.js             下载调度：原生多连接 + CLI 兜底、进度解析、队列
  fetcher.js            多连接 Range 下载器（断点 .qh.json）
  quarkapi.js           夸克 API：分享解析/转存、目录列表、回收站（只读）、文件信息
  urls.js               判定是否网盘文件直链（避免误下安装包）
  protocol.js           解析 qkclouddrive:// 协议
  theme.js              网页强制深色 CSS
  save-window.html      转存窗口 UI
  save-window-preload.js
assets/                 图标（512 / 256 / 64）
tools/                  15 个自测脚本（Electron 实际渲染，非 mock）
quark-yuan.desktop      桌面项示例
```

## 自测

```bash
for t in savewindow links sniff theme settings panel panel-status avatar darkpage suppress preview preview-video blockpreview trash trashpage; do
  DISPLAY=:0 ./node_modules/.bin/electron tools/selftest-$t.js --no-sandbox --ozone-platform=x11 2>&1 | grep -oE 'PASS|FAIL' | tail -1
done
```

## 已知限制

- 磁力/BT/离线下载：夸克网页 API 无此接口（实测 6 个候选路径全 404），只能识别链接
- 引擎兜底的 `quark-drive download --id` 是单连接（~100KB/s），只做失败兜底；正常都走自研多连接
- 网页深色是反色方案，个别高饱和图标可能偏色，可针对性加白名单
- 只做了 Linux x86_64 的打包与验证

## 许可

代码以 MIT 发布，见 [LICENSE](LICENSE)。
`assets/` 下的图标由项目作者提供，如涉及第三方形象/商标，其权利归原权利人，请自行确认使用范围。
