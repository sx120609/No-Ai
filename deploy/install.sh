#!/usr/bin/env bash
# No-AI 安装/升级脚本（Linux + systemd，可在宝塔终端里跑）
#
# 用法：bash install.sh /path/to/no-ai-<sha>.tar.gz
#   同目录需要有 no-ai-<sha>.tar.gz.sha256
#
# 做的事：
#   1. 校验发布包哈希，解压到 /opt/no-ai/releases/<sha>，current 指向它
#   2. 在 /opt/no-ai/node 装独立的 Node（不动系统里已有的 Node / PM2）
#   3. 首次安装时生成 /opt/no-ai/.env（管理员令牌、网关地址；API Key 可现场粘贴，回车跳过）
#   4. 建 no-ai.service（专用用户 noai，只监听 127.0.0.1），重启并做健康检查
# 重复运行就是升级；data/ 和 .env 不会被覆盖。
set -euo pipefail

PKG="${1:?用法: bash install.sh /path/to/no-ai-<sha>.tar.gz}"
APP_DIR=/opt/no-ai
PORT="${NOAI_PORT:-23360}"
NODE_VERSION="${NOAI_NODE_VERSION:-v26.5.0}"
SERVICE=no-ai

say() { printf '\033[1m[no-ai]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[no-ai] 失败：%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "需要 root 运行"
command -v systemctl >/dev/null || die "没有 systemd"
[ -f "$PKG" ] || die "找不到发布包 $PKG"
[ -f "$PKG.sha256" ] || die "找不到哈希文件 $PKG.sha256"

say "校验发布包"
( cd "$(dirname "$PKG")" && sha256sum -c "$(basename "$PKG").sha256" ) || die "发布包哈希不匹配，可能上传不完整"
SHA="$(basename "$PKG" .tar.gz)"; SHA="${SHA#no-ai-}"

mkdir -p "$APP_DIR/releases" "$APP_DIR/data"
REL="$APP_DIR/releases/$SHA"
if [ ! -d "$REL" ]; then
  say "解压到 $REL"
  mkdir -p "$REL.tmp"
  tar -xzf "$PKG" -C "$REL.tmp"
  [ -f "$REL.tmp/src/server.ts" ] || die "发布包内容不对（缺 src/server.ts）"
  mv "$REL.tmp" "$REL"
fi

# ---------- Node ----------
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "不支持的架构 $(uname -m)" ;;
esac
if [ "$("$APP_DIR/node/bin/node" -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  say "安装 Node $NODE_VERSION（$ARCH）到 $APP_DIR/node"
  TMP="$(mktemp -d)"
  NAME="node-$NODE_VERSION-linux-$ARCH.tar.gz"
  ok=""
  for base in https://npmmirror.com/mirrors/node https://nodejs.org/dist; do
    if curl -fsSL --retry 2 --connect-timeout 15 -o "$TMP/$NAME" "$base/$NODE_VERSION/$NAME" \
       && curl -fsSL --retry 2 --connect-timeout 15 -o "$TMP/SHASUMS256.txt" "$base/$NODE_VERSION/SHASUMS256.txt" \
       && ( cd "$TMP" && grep " $NAME\$" SHASUMS256.txt | sha256sum -c - >/dev/null ); then
      ok=1; break
    fi
    say "从 $base 下载失败，换下一个源"
  done
  [ -n "$ok" ] || die "Node 下载失败（npmmirror 和 nodejs.org 都不通）"
  rm -rf "$APP_DIR/node.new" && mkdir -p "$APP_DIR/node.new"
  tar -xzf "$TMP/$NAME" -C "$APP_DIR/node.new" --strip-components=1
  rm -rf "$APP_DIR/node" && mv "$APP_DIR/node.new" "$APP_DIR/node"
  rm -rf "$TMP"
fi
"$APP_DIR/node/bin/node" -e "require('node:sqlite')" || die "Node 缺少 node:sqlite"

# ---------- 用户与目录 ----------
id noai >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin noai
chown -R noai:noai "$APP_DIR/data"
chmod 750 "$APP_DIR/data"

# ---------- 配置 ----------
ENV="$APP_DIR/.env"
if [ ! -f "$ENV" ]; then
  say "首次安装，生成 $ENV"
  TOKEN="adm_$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  KEY=""
  if [ -t 0 ] && [ -n "${NOAI_GATEWAY_URL:-}" ]; then
    printf '粘贴改写网关的 API Key（不会显示，直接回车跳过，稍后在后台填）：'
    read -rs KEY || true
    echo
  fi
  umask 077
  {
    echo "ADMIN_TOKEN=$TOKEN"
    echo "ACCESS_MODE=key"
    echo "TRUST_PROXY=1"
    echo "MAX_INPUT_CHARS=20000"
    echo "RATE_PER_MIN=20"
    echo "MAX_CONCURRENT=4"
    echo "STORE_RESULTS_HOURS=0"
    # 可选：NOAI_GATEWAY_URL / NOAI_GATEWAY_MODEL 预置一个 OpenAI 兼容网关，配合上面粘贴的 Key 首次启动即可用
    [ -n "${NOAI_GATEWAY_URL:-}" ] && echo "DE_AI_REWRITE_BASE_URL=$NOAI_GATEWAY_URL"
    [ -n "${NOAI_GATEWAY_MODEL:-}" ] && echo "DE_AI_REWRITE_MODEL=$NOAI_GATEWAY_MODEL"
    [ -n "$KEY" ] && echo "DE_AI_REWRITE_API_KEY=$KEY"
    true
  } > "$ENV"
  chown root:noai "$ENV"; chmod 640 "$ENV"
  NEW_TOKEN="$TOKEN"
fi

# ---------- systemd ----------
if ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q . && ! systemctl is-active --quiet "$SERVICE"; then
  die "端口 $PORT 已被其他程序占用，可用 NOAI_PORT=xxxxx 换一个"
fi
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=No-AI 去AI味服务
After=network-online.target
Wants=network-online.target

[Service]
User=noai
Group=noai
WorkingDirectory=$APP_DIR/current
EnvironmentFile=$ENV
Environment=NODE_ENV=production HOST=127.0.0.1 PORT=$PORT DATA_DIR=$APP_DIR/data
ExecStart=$APP_DIR/node/bin/node src/server.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
UNIT

ln -sfn "$REL" "$APP_DIR/current.new" && mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"
echo "$SHA" > "$APP_DIR/deployed-commit"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"

say "等待服务启动"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    say "健康检查通过：http://127.0.0.1:$PORT  版本 $SHA"
    # 只保留最近 3 个版本
    ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
    if [ -n "${NEW_TOKEN:-}" ]; then
      echo
      say "管理员令牌（只显示这一次，另存在 $ENV）："
      echo "    $NEW_TOKEN"
    fi
    exit 0
  fi
  sleep 1
done
journalctl -u "$SERVICE" -n 40 --no-pager || true
die "服务没有起来，见上面的日志"
