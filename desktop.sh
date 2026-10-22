#!/usr/bin/env bash
#
# GitHub Desktop 一键脚本（macOS）
#
#   ./desktop.sh            交互菜单
#   ./desktop.sh 1|2|3|4|5|6  直接执行某一步
#   MODE=prod ./desktop.sh  使用 production 构建（产物名为 "GitHub Desktop.app"，
#                           会与官方版本同名，复制时会覆盖 /Applications 中的官方版）
#
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

MODE="${MODE:-dev}"
case "$MODE" in
  dev)
    export NODE_ENV=development
    APP_NAME="GitHub Desktop-dev"
    ;;
  prod)
    export NODE_ENV=production
    # 本地没有 Apple 发布证书，沿用 development 渠道以便使用 ad-hoc 签名、跳过公证
    export RELEASE_CHANNEL=development
    APP_NAME="GitHub Desktop"
    ;;
  *)
    echo "未知 MODE: $MODE（可选 dev / prod）" >&2
    exit 1
    ;;
esac

# Node 的 fetch 不读取 macOS 系统代理，这里把系统 HTTPS 代理导出为环境变量
if [ -z "${https_proxy:-}${HTTPS_PROXY:-}" ] && command -v scutil >/dev/null; then
  _proxy_info="$(scutil --proxy)"
  if echo "$_proxy_info" | grep -q "HTTPSEnable : 1"; then
    _host="$(echo "$_proxy_info" | awk '/HTTPSProxy :/ {print $3}')"
    _port="$(echo "$_proxy_info" | awk '/HTTPSPort :/ {print $3}')"
    if [ -n "$_host" ] && [ -n "$_port" ]; then
      export https_proxy="http://${_host}:${_port}" http_proxy="http://${_host}:${_port}"
      export HTTPS_PROXY="$https_proxy" HTTP_PROXY="$http_proxy"
      export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1}" no_proxy="${no_proxy:-localhost,127.0.0.1}"
    fi
  fi
  unset _proxy_info _host _port
fi
[ -n "${https_proxy:-}${HTTPS_PROXY:-}" ] && export NODE_USE_ENV_PROXY=1

ARCH="$(uname -m)"
[ "$ARCH" = "x86_64" ] && ARCH="x64"
DIST_DIR="$ROOT/dist/${APP_NAME}-darwin-${ARCH}"
APP_PATH="$DIST_DIR/${APP_NAME}.app"
ZIP_PATH="$ROOT/dist/${APP_NAME}-${ARCH}.zip"
INSTALL_PATH="/Applications/${APP_NAME}.app"

c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_blue=$'\033[36m'; c_off=$'\033[0m'
info() { echo "${c_blue}==>${c_off} $*"; }
ok()   { echo "${c_green}✔${c_off} $*"; }
warn() { echo "${c_yellow}!${c_off} $*"; }
die()  { echo "${c_red}✘${c_off} $*" >&2; exit 1; }

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    return 0
  fi
  return 1
}

# 每一步执行前切到 .nvmrc 指定的 Node 版本
use_node() {
  if load_nvm; then
    nvm use >/dev/null 2>&1 || warn "nvm 中没有 $(cat .nvmrc)，请先执行第 1 步"
  fi
  command -v node >/dev/null || die "找不到 node，请先执行第 1 步"
  command -v yarn >/dev/null || die "找不到 yarn，请先执行第 1 步"
}

# 根目录和 app/ 的 node_modules 都与 yarn.lock 一致，且 Electron 已下载
# 传入 no-electron 时不检查 Electron
deps_ready() {
  [ -d node_modules ] && [ -d app/node_modules ] || return 1
  yarn check --integrity >/dev/null 2>&1 || return 1
  yarn --cwd app check --integrity >/dev/null 2>&1 || return 1
  [ "${1:-}" = "no-electron" ] && return 0
  [ -f node_modules/electron/path.txt ] && [ -d node_modules/electron/dist ]
}

# ---------------------------------------------------------------- 1. 安装环境
step_setup() {
  info "[1] 安装环境"
  [ "$(uname)" = "Darwin" ] || die "此脚本仅支持 macOS"

  if ! xcode-select -p >/dev/null 2>&1; then
    warn "未安装 Xcode Command Line Tools，正在弹出安装窗口…"
    xcode-select --install || true
    die "请在 Command Line Tools 安装完成后重新执行第 1 步"
  fi
  ok "Xcode Command Line Tools: $(xcode-select -p)"

  if ! load_nvm; then
    info "安装 nvm…"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    load_nvm || die "nvm 安装失败"
  fi
  ok "nvm $(nvm --version)"

  local node_version
  node_version="$(cat .nvmrc)"
  if [ "$(nvm version "$node_version")" = "N/A" ]; then
    info "安装 Node $node_version…"
    nvm install
  fi
  nvm use >/dev/null
  ok "node $(node -v)"

  if ! command -v yarn >/dev/null; then
    info "安装 yarn 1.x…"
    npm install -g yarn@1
  fi
  ok "yarn $(yarn -v)"

  if ! command -v python3 >/dev/null; then
    if command -v brew >/dev/null; then
      info "安装 python3…"
      brew install python
    else
      die "缺少 python3（编译原生模块需要），请安装后重试"
    fi
  fi
  ok "$(python3 --version)"

  if git submodule status --recursive | grep -q '^-'; then
    info "初始化 git submodules…"
    git submodule update --init --recursive
  fi
  ok "git submodules"

  if [ "${FORCE:-}" != "1" ] && deps_ready; then
    ok "依赖已安装且与 yarn.lock 一致，跳过（FORCE=1 可强制重装）"
    ok "环境安装完成"
    return 0
  fi

  # 依赖完整、只差 Electron 二进制（通常是之前下载失败）时只补装 Electron
  if [ "${FORCE:-}" != "1" ] && deps_ready no-electron; then
    info "补装 Electron 二进制…"
    node node_modules/electron/install.js
    ok "环境安装完成"
    return 0
  fi

  # yarn 1 多个进程共用缓存并发解压会互相损坏文件（"Extracting tar content of undefined failed"）
  if pgrep -f "yarn.* install" >/dev/null; then
    pgrep -fl "yarn.* install" >&2 || true
    die "检测到其他 yarn install 正在运行，请等待其结束或 kill 掉上面的进程后重试"
  fi

  info "安装依赖 (yarn install)…"
  if ! yarn install --frozen-lockfile --network-concurrency 4; then
    warn "安装失败，清理 yarn 缓存后重试一次…"
    yarn cache clean
    yarn install --frozen-lockfile --network-concurrency 4
  fi
  ok "环境安装完成"
}

# dev 构建默认从 yarn start 的 localhost:3000 加载界面；独立构建把界面打包进应用，
# 才能复制到 /Applications 单独运行
is_standalone_build() {
  [ -f "$APP_PATH/Contents/Resources/app/index.html" ] &&
    ! grep -q "localhost:3000" "$APP_PATH/Contents/Resources/app/index.html"
}

# ---------------------------------------------------------------- 2. 编译
step_build() {
  local kind=""
  if [ "$MODE" = "dev" ]; then
    if [ "${DESKTOP_STANDALONE:-}" = "1" ]; then kind=", 独立运行"; else kind=", 配合第 3 步开发服务器"; fi
  fi
  info "[2] 编译 ($MODE$kind)"
  use_node
  yarn "build:$MODE"
  [ -d "$APP_PATH" ] || die "编译完成但未找到 $APP_PATH"
  ok "编译完成: $APP_PATH"
}

# ---------------------------------------------------------------- 3. 运行
step_run() {
  info "[3] 运行 ($MODE)"
  use_node
  [ -d "$APP_PATH" ] || die "未找到 $APP_PATH，请先执行第 2 步"
  if [ "$MODE" = "dev" ] && is_standalone_build; then
    info "当前是独立构建，开发模式需要连接开发服务器的构建，重新编译…"
    DESKTOP_STANDALONE= step_build
  fi
  if [ "$MODE" = "dev" ]; then
    info "启动开发模式（支持热更新，Cmd+Alt+R 重新加载，Ctrl+C 退出）"
    yarn start
  else
    yarn start:prod
  fi
}

# ---------------------------------------------------------------- 4. 打包
step_package() {
  info "[4] 打包 zip"
  use_node
  [ -d "$APP_PATH" ] || die "未找到 $APP_PATH，请先执行第 2 步"
  yarn package
  [ -f "$ZIP_PATH" ] || die "未生成 $ZIP_PATH"
  ok "打包完成: $ZIP_PATH"
}

# ---------------------------------------------------------------- 5. 复制到 /Applications
step_install() {
  info "[5] 复制到 /Applications"
  [ -d "$APP_PATH" ] || die "未找到 $APP_PATH，请先执行第 2 步"
  if [ "$MODE" = "dev" ] && ! is_standalone_build; then
    info "当前构建依赖 localhost:3000 开发服务器，重新编译为独立运行版本…"
    DESKTOP_STANDALONE=1 step_build
  fi

  if [ -d "$INSTALL_PATH" ]; then
    if [ "$MODE" = "prod" ]; then
      read -r -p "将覆盖 $INSTALL_PATH（可能是官方版本），继续？[y/N] " yn
      [[ "$yn" =~ ^[Yy]$ ]] || { warn "已取消"; return 0; }
    fi
    if pgrep -f "$INSTALL_PATH/Contents/MacOS/" >/dev/null; then
      info "关闭正在运行的 ${APP_NAME}…"
      osascript -e "quit app \"$INSTALL_PATH\"" >/dev/null 2>&1 || true
      sleep 2
      pkill -f "$INSTALL_PATH/Contents/MacOS/" 2>/dev/null || true
    fi
    rm -rf "$INSTALL_PATH" 2>/dev/null || sudo rm -rf "$INSTALL_PATH"
  fi

  ditto "$APP_PATH" "$INSTALL_PATH" 2>/dev/null || sudo ditto "$APP_PATH" "$INSTALL_PATH"
  ok "已安装: $INSTALL_PATH"
}

# ---------------------------------------------------------------- 6. 一键全部
step_all() {
  step_setup
  DESKTOP_STANDALONE=1 step_build
  step_package
  step_install
  info "启动 ${INSTALL_PATH}"
  open "$INSTALL_PATH"
  ok "全部完成"
}

run_step() {
  case "$1" in
    1) step_setup ;;
    2) step_build ;;
    3) step_run ;;
    4) step_package ;;
    5) step_install ;;
    6) step_all ;;
    0|q|Q) exit 0 ;;
    *) warn "无效选项: $1" ;;
  esac
}

menu() {
  while true; do
    cat <<EOF

${c_green}GitHub Desktop 构建工具${c_off}  (MODE=$MODE, 产物: ${APP_NAME}.app, 代理: ${https_proxy:-${HTTPS_PROXY:-无}})
  1) 安装环境     Xcode CLT / nvm / Node $(cat .nvmrc) / yarn / submodules / 依赖
  2) 编译         yarn build:$MODE
  3) 运行         启动编译好的应用
  4) 打包         生成 zip
  5) 复制         安装到 /Applications
  6) 一键完成     1 → 2 → 4 → 5 并打开应用
  0) 退出
EOF
    read -r -p "请选择 [0-6]: " choice
    case "$choice" in 0|q|Q) exit 0 ;; esac
    # 用独立进程执行，保证 set -e 生效且单步失败不会退出菜单
    MODE="$MODE" bash "${BASH_SOURCE[0]}" "$choice" || warn "步骤 $choice 执行失败"
  done
}

if [ $# -gt 0 ]; then
  for s in "$@"; do run_step "$s"; done
else
  menu
fi
