#!/usr/bin/env bash
# Quark-Yuan 一键启动
#
# 用途：新用户解压后直接运行本脚本 —— 缺 Node 就下 Node，缺依赖就装依赖，
#      已经装好的部分一律跳过（不重复下载）。装好后直接启动应用。
#
# 用法：
#   ./start.sh                 首次自举 + 启动
#   ./start.sh --check         只检查环境，不下载、不启动
#   ./start.sh --force-deps    忽略安装标记，重新校验依赖
#   ./start.sh --appimage      直接运行 dist/ 里已打好的 AppImage（零下载）
#   ./start.sh -- <参数>       其余参数透传给 Electron，如 --ozone-platform=x11
set -uo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cd "$ROOT" || exit 1

STATE_DIR="$ROOT/.bootstrap"
STATE_FILE="$STATE_DIR/deps.md5"
RUNTIME_DIR="$ROOT/.runtime"
CACHE_DIR="$ROOT/.cache"

NODE_MIN_MAJOR=20
NODE_PIN="v22.20.0"          # 首次下载的固定版本；已装 Node ≥20 的用户不会用到
MODE=run
FORCE_DEPS=0
APPIMAGE=0
PASSTHRU=()

log()  { printf '\033[1;34m[Quark-Yuan]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[Quark-Yuan]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[Quark-Yuan]\033[0m %s\n' "$*"; }
die()  {
  printf '\033[1;31m[Quark-Yuan]\033[0m %s\n' "$*" >&2
  # 双击运行时窗口会立刻关闭，停在错误页上让人看清原因
  if [ -t 0 ]; then printf '\n按回车退出…'; read -r _; fi
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check)      MODE=check ;;
    --force-deps) FORCE_DEPS=1 ;;
    --appimage)   APPIMAGE=1 ;;
    --)           shift; PASSTHRU+=("$@"); break ;;
    -h|--help)    sed -n '2,20p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            PASSTHRU+=("$1") ;;
  esac
  shift
done

# ---------- 0. 平台 ----------
case "$(uname -s)" in
  Linux) ;;
  *) die "仅支持 Linux（当前：$(uname -s)）" ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "不支持的 CPU 架构：$(uname -m)" ;;
esac

# ---------- 1. --appimage：直接运行已打好的包，零下载 ----------
if [ "$APPIMAGE" = 1 ]; then
  IMG="$(ls -1 dist/*.AppImage 2>/dev/null | head -1 || true)"
  [ -n "$IMG" ] || die "dist/ 里没有 AppImage，先执行 pnpm run appimage"
  [ -x "$IMG" ] || chmod +x "$IMG" 2>/dev/null
  log "运行已打包的 AppImage：$(basename "$IMG")（不下载、不安装）"
  exec "$IMG" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
fi

# ---------- 2. Node 运行时 ----------
node_major_ok() {
  local bin="$1" v major
  [ -x "$bin" ] || return 1
  v="$("$bin" -v 2>/dev/null)" || return 1
  major="${v#v}"; major="${major%%.*}"
  [ -n "$major" ] && [ "$major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null
}

NODE_BIN=""
if have node && node_major_ok "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
  ok "Node $(node -v) 已就绪（跳过下载）"
elif node_major_ok "$RUNTIME_DIR/node/bin/node"; then
  NODE_BIN="$RUNTIME_DIR/node/bin/node"
  ok "项目内 Node $("$NODE_BIN" -v) 已就绪（跳过下载）"
fi

fetch() { # url dest
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then log "命中缓存：$(basename "$dest")（跳过下载）"; return 0; fi
  mkdir -p "$(dirname "$dest")"
  log "下载 $(basename "$dest") …"
  if have curl; then
    curl -fL --retry 3 --progress-bar -o "$dest.part" "$url" || { rm -f "$dest.part"; return 1; }
  elif have wget; then
    wget -q --show-progress -O "$dest.part" "$url" || { rm -f "$dest.part"; return 1; }
  else
    warn "缺少 curl / wget，无法下载"; return 1
  fi
  mv "$dest.part" "$dest"
}

if [ -z "$NODE_BIN" ]; then
  if [ "$MODE" = check ]; then
    warn "未找到 Node ≥ $NODE_MIN_MAJOR：首次运行会下载 Node $NODE_PIN（约 30MB，仅一次）"
  else
    warn "未找到 Node ≥ $NODE_MIN_MAJOR，下载官方运行时（仅首次，之后复用）"
    TAR="$CACHE_DIR/node-$NODE_PIN-linux-$ARCH.tar.xz"
    fetch "https://nodejs.org/dist/$NODE_PIN/node-$NODE_PIN-linux-$ARCH.tar.xz" "$TAR" \
      || die "下载 Node 失败，请检查网络；或自行安装 Node ≥ $NODE_MIN_MAJOR 后重试"
    log "解压 Node 到 $RUNTIME_DIR …"
    mkdir -p "$RUNTIME_DIR"
    rm -rf "$RUNTIME_DIR/node" "$RUNTIME_DIR/node-$NODE_PIN-linux-$ARCH"
    tar -xJf "$TAR" -C "$RUNTIME_DIR" || die "解压失败（需要 xz：Debian/Ubuntu 用 apt install xz-utils）"
    mv "$RUNTIME_DIR/node-$NODE_PIN-linux-$ARCH" "$RUNTIME_DIR/node" || die "Node 目录结构异常"
    NODE_BIN="$RUNTIME_DIR/node/bin/node"
    node_major_ok "$NODE_BIN" || die "Node 解压后无法运行"
    ok "Node $("$NODE_BIN" -v) 安装完成"
  fi
fi
[ -n "$NODE_BIN" ] && export PATH="$(dirname "$NODE_BIN"):$PATH"

# ---------- 3. 项目依赖（只有 electron 一个运行时依赖） ----------
deps_hash() {
  { cat package.json 2>/dev/null; cat pnpm-lock.yaml 2>/dev/null; } | md5sum | cut -d' ' -f1
}
electron_ready() {
  [ -x "$ROOT/node_modules/.bin/electron" ] && [ -x "$ROOT/node_modules/electron/dist/electron" ]
}
HASH="$(deps_hash)"

if electron_ready && [ "$FORCE_DEPS" = 0 ]; then
  if [ -f "$STATE_FILE" ] && [ "$(cat "$STATE_FILE" 2>/dev/null)" = "$HASH" ]; then
    ok "依赖已就绪（$(printf '%s' "$HASH" | cut -c1-8)），跳过安装与下载"
  else
    mkdir -p "$STATE_DIR" && printf '%s' "$HASH" > "$STATE_FILE"
    ok "已存在 Electron 运行时，跳过安装与下载"
  fi
else
  if [ "$MODE" = check ]; then
    warn "依赖缺失：首次运行会安装 electron（已缓存的二进制不会重复下载）"
  else
    log "安装项目依赖（首次；Electron 二进制命中 ~/.cache/electron 时不会重新下载）"
    # 注意：pnpm 可能因「被忽略的构建脚本」返回非 0，但依赖其实已装好，
    # 所以这里不立刻失败，最后统一用 electron_ready 判定。
    if have pnpm; then
      pnpm install --frozen-lockfile || pnpm install || warn "pnpm install 返回非 0，继续检查产物"
    elif have npm; then
      npm install --no-audit --no-fund || warn "npm install 返回非 0，继续检查产物"
    else
      die "缺少 pnpm / npm（Node 通常自带 npm，请检查安装）"
    fi
    electron_ready || {
      # 包管理器可能跳过 electron 的 postinstall（pnpm 的构建白名单策略），
      # 这里直接跑它自带的安装脚本：二进制会落到 ~/.cache/electron，只下一次。
      if [ -f "$ROOT/node_modules/electron/install.js" ]; then
        warn "Electron 二进制缺失，运行其安装脚本补全（仅首次）"
        PATH="$(dirname "$NODE_BIN"):$PATH" "$NODE_BIN" "$ROOT/node_modules/electron/install.js" \
          || die "Electron 二进制下载失败，请检查网络或代理设置"
      fi
    }
    electron_ready || die "Electron 未安装成功（node_modules/electron/dist 不存在）"
    mkdir -p "$STATE_DIR" && printf '%s' "$HASH" > "$STATE_FILE"
    ok "依赖安装完成"
  fi
fi

# ---------- 4. 可选引擎 + 系统库体检 ----------
ENGINE_CFG="$(sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' config.json 2>/dev/null | head -1 || true)"
if [ -n "$ENGINE_CFG" ] && [ -x "$ENGINE_CFG" ]; then
  ok "下载引擎已就绪：$ENGINE_CFG"
elif [ -x "$ROOT/../quark-drive-extract/usr/bin/quark-drive" ]; then
  ok "下载引擎已就绪：../quark-drive-extract/usr/bin/quark-drive"
else
  warn "未找到 quark-drive 引擎：不影响下载（直链走网页 cookie），只少了 CLI 兜底；面板状态圆点会显示异常"
fi

# 注意：不要写成 `ldconfig -p | grep -q` —— grep 命中后提前退出会让 ldconfig 收 SIGPIPE，
# 在 `set -o pipefail` 下整条管道判失败，导致所有库都被误报为缺失。
LDCACHE="$(ldconfig -p 2>/dev/null || true)"
if [ -n "$LDCACHE" ]; then
  missing_libs=""
  for lib in libgtk-3.so.0 libnss3.so libasound.so.2 libgbm.so.1 libxkbcommon.so.0; do
    case "$LDCACHE" in
      *"$lib"*) ;;
      *) missing_libs="$missing_libs $lib" ;;
    esac
  done
  if [ -n "$missing_libs" ]; then
    warn "缺少系统库：$missing_libs"
    warn "Debian/Ubuntu: sudo apt install -y libgtk-3-0 libnss3 libasound2 libgbm1 libxkbcommon0"
    warn "Arch/Manjaro : sudo pacman -S --needed gtk3 nss alsa-lib mesa libxkbcommon"
    warn "Fedora       : sudo dnf install gtk3 nss alsa-lib mesa-libgbm libxkbcommon"
  else
    ok "系统库齐全（GTK/NSS/ALSA/GBM/xkbcommon）"
  fi
else
  warn "无法运行 ldconfig，跳过系统库体检（若界面起不来，请安装 gtk3 / nss / alsa-lib / mesa）"
fi

# ---------- 5. 启动 ----------
if [ "$MODE" = check ]; then
  ok "环境检查完成（本次未下载、未安装、未启动）"
  exit 0
fi

ELECTRON="$ROOT/node_modules/.bin/electron"
[ -x "$ELECTRON" ] || die "找不到 Electron 可执行文件：$ELECTRON"

log "启动 Quark-Yuan"
exec "$ELECTRON" "$ROOT" --no-sandbox ${PASSTHRU+"${PASSTHRU[@]}"}
