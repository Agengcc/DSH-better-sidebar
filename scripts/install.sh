#!/usr/bin/env bash
# =============================================================================
# dsh-better-sidebar 一键安装脚本（npm 包方式）
#
# 把插件以 npm 包形式装进 DSH 的 web profile（挂载仍走 cordis.patch.yml，
# 符合仓库硬约束：不修改 DSH 源码，插件永远作为独立包被 profile 引用）。
#
# 用法：
#   bash scripts/install.sh [版本] [--restart] [--dry-run]
#
#   版本    npm 版本号/范围，缺省为 latest（自动解析为 ^<最新>）。
#           示例：0.10.1、^0.10.1、~0.10.1、latest
#   --restart   装完后尝试 `pm2 restart dsh-web`（无 pm2 时仅打印提示）。
#               注意：重启会断开当前 DSH 页面会话，默认不自动重启。
#   --dry-run   只打印将要执行的操作，不写任何文件。
#
# 环境：
#   DSH_HOME    默认 ~/.dsh
#   REGISTRY    默认 https://registry.npmjs.org（发布源；装依赖仍走 pnpm 配置）
#
# 幂等：依赖已存在且版本满足 → 跳过写入；cordis.patch.yml 已含挂载行 → 不重复追加。
# 回滚：把 profile package.json 的依赖改回 "dsh-better-sidebar": "link:<路径>" 再 pnpm install。
# =============================================================================
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
PKG_JSON="$PROFILE_DIR/package.json"
PATCH_YML="$PROFILE_DIR/cordis.patch.yml"
REGISTRY="${REGISTRY:-https://registry.npmjs.org}"
PKG="dsh-better-sidebar"

RESTART=false
DRY_RUN=false
VERSION_SPEC=""
for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=true ;;
    --dry-run) DRY_RUN=true ;;
    -*) echo "未知参数: $arg" >&2; exit 2 ;;
    *) VERSION_SPEC="$arg" ;;
  esac
done

say()  { printf '\033[32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# 解析用户给的版本 -> package.json 里要写的 spec（"^x.y.z"）
resolve_spec() {
  local given="${1:-latest}"
  case "$given" in
    latest)
      local v
      v="$(npm view "$PKG" version --registry="$REGISTRY" 2>/dev/null)" \
        || die "无法从 $REGISTRY 解析 $PKG 的最新版本（请检查网络/登录）。可显式传版本号：bash scripts/install.sh 0.10.1"
      printf '^%s' "$v"
      ;;
    ^*|~*) printf '%s' "$given" ;;
    *) printf '^%s' "$given" ;;
  esac
}

[ -d "$PROFILE_DIR" ] || die "找不到 profile 目录：${PROFILE_DIR}（请先安装并运行过一次 dsh web）"
[ -f "$PKG_JSON" ]    || die "找不到 $PKG_JSON"
[ -f "$PATCH_YML" ]   || die "找不到 ${PATCH_YML}（请先初始化 web profile）"

SPEC="$(resolve_spec "$VERSION_SPEC")"
say "目标依赖：\"$PKG\": \"$SPEC\"（profile: ${PROFILE_DIR}）"

if [ "$DRY_RUN" = true ]; then
  say "[dry-run] 步骤 1：更新 $PKG_JSON 的 dependencies[\"$PKG\"] = \"$SPEC\""
  say "[dry-run] 步骤 2：确保 $PATCH_YML 含挂载行（- insert: - id: better-sidebar）"
  say "[dry-run] 步骤 3：在 $PROFILE_DIR 执行 pnpm install"
  if [ "$RESTART" = true ]; then say "[dry-run] 步骤 4：pm2 restart dsh-web"; else say "[dry-run] 步骤 4：提示用户手动重启 DSH"; fi
  exit 0
fi

# 步骤 1：写依赖（用 node 安全改 JSON，保留其余字段；替换已存在的 link:/旧版本条目）
node -e '
  const fs = require("fs");
  const pkgJson = process.argv[1];
  const name = process.argv[2];
  const spec = process.argv[3];
  const p = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
  p.dependencies = p.dependencies || {};
  const old = p.dependencies[name];
  if (old === spec) {
    console.log("unchanged");
  } else {
    p.dependencies[name] = spec;
    fs.writeFileSync(pkgJson, JSON.stringify(p, null, 2) + "\n");
    console.log(old === undefined ? `added ${name}@${spec}` : `replaced ${name}@${old} -> ${name}@${spec}`);
  }
' "$PKG_JSON" "$PKG" "$SPEC"

# 步骤 2：确保 cordis.patch.yml 挂载行存在（幂等追加）
if grep -qE '^\s*- id: better-sidebar\b' "$PATCH_YML"; then
  say "挂载行已存在，跳过 cordis.patch.yml"
else
  # 确保文件末尾有换行
  [ -n "$(tail -c1 "$PATCH_YML" 2>/dev/null)" ] && printf '\n' >> "$PATCH_YML"
  cat >> "$PATCH_YML" <<'YAML'

# dsh-better-sidebar mount (added by scripts/install.sh)
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
YAML
  say "已追加挂载行到 cordis.patch.yml"
fi

# 步骤 3：安装
say "执行 pnpm install（${PROFILE_DIR}）..."
if ! (cd "$PROFILE_DIR" && pnpm install); then
  warn "pnpm install 失败。若提示 minimumReleaseAge（新版本发布 <24h），pnpm 通常会自动写入 minimumReleaseAgeExclude 并重试；"
  warn "仍失败可尝试：cd $PROFILE_DIR && pnpm clean --lockfile && pnpm install"
  exit 1
fi
say "安装完成：$PKG@$SPEC"

# 步骤 4：重启提示
if [ "$RESTART" = true ]; then
  if command -v pm2 >/dev/null 2>&1; then
    say "重启 dsh-web（pm2）..."
    pm2 restart dsh-web || warn "pm2 restart 失败，请手动重启 DSH"
  else
    warn "未找到 pm2，请手动重启 DSH（如：pm2 restart dsh-web 或 dsh web）"
  fi
else
  say "下一步：重启 DSH 并硬刷新（Cmd/Ctrl+Shift+R）使新副本生效。"
  if command -v pm2 >/dev/null 2>&1; then
    say "本机可用：pm2 restart dsh-web（会短暂断开当前页面会话）"
  fi
fi
