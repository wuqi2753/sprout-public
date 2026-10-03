# Sprout

手机快速记录，同步到自己的 Go Server。SQLite 保存笔记与图片。


## Android 安装包

在仓库的 Releases 下载 `sprout-1.1.2-android.apk`，支持 Android 7.0+、ARM64 / ARMv7 手机。正式版内置运行代码，不需要 localhost 或开发机；首次启动后填写自己的 Server 地址与 API Key。

正式版与原调试版签名不同，不能直接覆盖安装。已有调试版记录时先保留并备份数据，不要直接卸载；后续正式版可使用同一签名正常更新。

## 云服务器部署

本文适用于 Ubuntu 22.04、x86_64，域名用 `app.example.com` 举例。所有示例域名、IP 和仓库地址需替换。命令按顺序逐条执行，失败时先处理，再继续；文件内容需粘贴到指定文件，不是在终端执行。

| 顺序 | 在哪里做 | 完成什么 |
| --- | --- | --- |
| 1 | 本地终端 → SSH 云服务器 | 安装 Go、clone、启动 Server 并测试本机 API |
| 2 | 浏览器 Cloudflare → 本地新终端 | 添加 DNS 灰云记录，确认解析 |
| 3 | 云服务器 SSH 终端 → 本地终端 | 安装配置 Caddy，验证公网 HTTPS |
| 4 | 手机 App | 填 URL 和 API Key，测试同步 |
| 可选 | 浏览器 Cloudflare | 开启橙云并重测 |

### 1. 云服务器：安装 Go，克隆并启动 Server

**先在本地电脑终端**登录云服务器：

```sh
ssh <登录用户>@<服务器公网IP>
```

登录成功后，以下安装命令在远程 Ubuntu 执行；`Permission denied` 表示 SSH 认证失败。

**在这个 SSH 终端安装工具：**

```sh
sudo apt update
sudo apt install -y git curl ca-certificates openssl sqlite3 gnupg
uname -m
```

`uname -m` 应为 `x86_64`；其他架构不能使用下面的 amd64 包。

**安装 Go**：先运行 `go version`。已有 Go 1.24 或更高版本可跳过安装；没有 Go 且 `/usr/local/go` 不存在时执行：

```sh
curl -fsSL 'https://go.dev/VERSION?m=text' -o /tmp/sprout-go-version.txt
SPROUT_GO_VERSION=$(head -n 1 /tmp/sprout-go-version.txt)
curl -fL "https://go.dev/dl/${SPROUT_GO_VERSION}.linux-amd64.tar.gz" -o /tmp/sprout-go.tar.gz
sudo tar -C /usr/local -xzf /tmp/sprout-go.tar.gz
echo 'export PATH="/usr/local/go/bin:$PATH"' >> "$HOME/.profile"
. "$HOME/.profile"
go version
```

成功示例：`go version go1.27.1 linux/amd64`（版本随官方下载更新）。若提示 `go: command not found`，检查 PATH；已有旧版或旧安装目录时，按 [Go 官方升级说明](https://go.dev/doc/install) 处理，不能向旧目录直接解压覆盖。

**克隆并构建**：仓库 URL 从仓库页面 Code 复制。

```sh
SPROUT_DIR=/opt/sprout
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 "$SPROUT_DIR"
git clone <仓库URL> "$SPROUT_DIR"
cd "$SPROUT_DIR/server"
go test ./...
go build -o ../sprout-server .
```

成功时测试输出 `ok sprout/server ...`，构建通常无输出。Git `Authentication failed` 表示仓库权限未通过。

`/opt/sprout` 只是示例。要与已有服务同级部署，将 `SPROUT_DIR` 改为选定的绝对路径。已有部署不要重新 clone：进入实际项目根目录，运行 `SPROUT_DIR=$(pwd)`，跳过创建配置，直接读取原 Key。重新登录 SSH 后也这样设置变量；数据库仍独立保存。

**创建数据目录**（首次执行）：

Server 使用当前登录用户运行。`/var/lib/sprout` 保存数据库；源码、程序与配置都在 `$SPROUT_DIR`。数据库独立保存，更新代码不会替换数据。

```sh
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 750 /var/lib/sprout
```

已有数据目录时先确认当前用户可读写，不清空已有数据。

**填写 Server 配置**（首次执行，已有 `.env` 不要覆盖）：

```sh
cd "$SPROUT_DIR"
cp -i .env.example .env
chmod 600 .env
openssl rand -hex 32
nano .env
```

`cp -i` 遇到已有 `.env` 会询问是否覆盖；已有配置时回答 `n`，跳过后续生成和编辑步骤。`openssl rand -hex 32` 只输出 64 位十六进制 API Key，不会自动写入文件；复制后，在 `nano` 打开的 `.env` 中填到 `SPROUT_API_KEY=` 后面。监听地址和数据库路径保留模板值设为 `SPROUT_LISTEN_ADDRESS=127.0.0.1:8080` 和 `SPROUT_DATABASE_PATH=/var/lib/sprout/sprout.db`。按 `Ctrl+O`、回车保存，再按 `Ctrl+X` 退出。

`chmod 600 .env` 表示只有文件所有者能读写，用来保护 API Key。`.env` 不提交 Git，`.env.example` 只保存示例。Server 和手机 App 使用同一个 API Key。

Go 启动时直接读取 `.env`；下面通过 `-env-file` 指定路径。也可在项目根目录运行 `./sprout-server`，默认读取当前目录的 `.env`。

**让 Server 持续运行**：systemd 负责开机启动和异常退出后重启，断开 SSH 后 Server 仍运行。直接启动程序不需要 systemd；云服务器长期运行使用下面的配置。编辑服务文件：

```sh
sudo nano /etc/systemd/system/sprout.service
```

运行 `id -un` 查看当前登录用户名，运行 `echo "$SPROUT_DIR"` 查看实际项目目录。将下面两个占位符替换为对应输出；systemd 不会自动展开占位符或 shell 变量。

```ini
[Unit]
Description=Sprout Server
After=network.target

[Service]
User=<当前登录用户名>
ExecStart=<项目绝对路径>/sprout-server -env-file <项目绝对路径>/.env
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
```

保存 service 文件后，在云服务器终端执行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sprout
sudo systemctl is-active sprout
```

应输出 `active`。字段说明见 [Server README](server/README.md#systemd-字段说明)。

**仍在云服务器的 Bash 终端**验证本机 API：

```bash
read -r -s -p 'API Key: ' SPROUT_TEST_KEY
echo
curl -i -H "Authorization: Bearer $SPROUT_TEST_KEY" http://127.0.0.1:8080/api/v1/health
unset SPROUT_TEST_KEY
```

正确结果包含 HTTP `200` 和 `{"status":"ok"}`。HTTP `401` 表示 Key 不正确；`Failed to connect` 表示服务或端口未就绪，用 `sudo journalctl -u sprout -n 50 --no-pager` 查看启动原因。**这里成功后才进入 DNS 步骤。**

### 2. Cloudflare 网页配置 DNS，本地终端检查

**切到浏览器**，打开 Cloudflare → 选择你的域名 → DNS → Add record：

| Type | Name | IPv4 address | Proxy | TTL |
| --- | --- | --- | --- | --- |
| A | app | 服务器公网 IP | DNS only（灰云） | Auto |

域名须已在 Cloudflare 激活；其他 DNS 服务商同样添加 A 记录。

**回到本地电脑，另开一个终端**，不要在 SSH 终端里测试：

```sh
nslookup app.example.com
```

正确结果应包含：

```text
Name:    app.example.com
Address: 203.0.113.10
```

这里 `203.0.113.10` 是示例地址，实际输出应等于自己的公网 IP。失败情况：

| 输出 | 怎么处理 |
| --- | --- |
| `NXDOMAIN` / `Non-existent domain` | 检查域名拼写、A 记录、Cloudflare 域名激活及 Nameserver |
| Address 是错误地址 | 修正记录，等待缓存更新后重查 |
| Address 是 Cloudflare 地址 | 当前仍是橙云；本教程首次验证先切灰云 |
| `timed out` | 检查本地网络或 DNS 解析器 |

DNS 成功只说明地址正确，此时不要求 HTTPS 已能访问。接下来返回云服务器配置实际 HTTPS 入口。

本机启用网络代理时，DNS 结果可能被代理改写；如果与公网 IP 不一致，也在服务器运行 `getent ahostsv4 app.example.com` 对照检查，不要只凭本机结果判断记录配置失败。

### 3. 云服务器：先安装 Caddy，再配置 HTTPS

**回到第一步的 SSH 终端**。云安全组与防火墙需允许 TCP 80/443；Go 的 8080 保持仅本机访问。

Caddy 软件包安装时会尝试启动服务。如果 80/443 已被其他程序占用，先安排统一入口；已有 Caddy 则跳过安装、直接追加配置。

**已有容器占用 80/443 时**，先执行下面的命令，避免安装时抢占端口；现有站点继续运行：

```sh
sudo systemctl mask caddy.service
```

安装并准备好 Caddyfile 后，再按后面的“切换已有入口”操作。新服务器没有其他入口时跳过此命令。

**首次安装 Caddy 软件包**（已安装则跳过），命令来自 [官方安装说明](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)：

```sh
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
caddy version
```

成功时输出 `v2.x.x ...`，具体版本随软件源变化。出现 `caddy: command not found` 说明安装未成功；下载或 apt 报错时先处理，不继续配置。

**编辑配置文件：**

```sh
sudo nano /etc/caddy/Caddyfile
```

只有 Sprout 一个站点时，将默认示例替换为：

```caddyfile
app.example.com {
    header Cache-Control "no-store"
    reverse_proxy 127.0.0.1:8080
}
```

如果已有其他 Caddy 站点，保留已有配置，只追加上面的块。其他服务按域名各写一块，例如：

```caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:9000
}

dashboard.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

示例域名需单独配置 DNS；9000 是另一个 Go 服务的监听端口，8000 是 Docker 服务映射到宿主机的端口，例如 `127.0.0.1:8000:3000`。如果 Caddy 也在容器中，使用同一 Docker 网络的服务名和容器端口，例如 `reverse_proxy dashboard:3000`。

**仍在云服务器 SSH 终端，先验证配置：**

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

正确输出包含 `Valid configuration`，可能还有日志。它只检查配置，不启动服务；若出现 `Error`，先修正配置再继续。

**切换已有入口**（没有旧入口则跳过）：备份现有 Compose、环境配置和 Caddyfile。将原应用对公网的 `80:80`、`443:443` 映射移除，改成仅本机 HTTP 映射，例如 `127.0.0.1:8000:8000`；具体容器端口以应用配置为准。关闭应用自身的 HTTPS，并保留原 HTTPS 域名作为对外 URL。这些配置随应用而异，不能只修改端口映射。

在原应用的 Compose 目录执行 `docker compose up -d --no-deps <应用服务名>`，只重建该应用。用 `curl -I http://127.0.0.1:8000` 确认上游正常；应用重启期间会短暂中断。不要删除数据库容器或数据卷。确认上游就绪并释放 80/443 后，解除前面的启动屏蔽：

```sh
sudo systemctl unmask caddy.service
sudo systemctl daemon-reload
```

再执行下方启动命令。若切换失败，停止 Caddy、恢复备份的原应用配置并重新启动应用。

**首次启动，并设置开机启动：**

```sh
sudo systemctl enable --now caddy
```

成功通常没有输出，首次启用也可能显示 `Created symlink ...`；这些文字不代表 HTTPS 已成功。若出现 `Job for caddy.service failed`，启动失败，检查端口占用和日志。

**已经运行时，加载修改后的配置：**

```sh
sudo systemctl reload caddy
```

成功通常没有输出。首次启动已读取当前配置时可跳过；以后修改 Caddyfile，先 validate 再 reload。出现 `not active` 表示服务未运行，需要先启动。

**检查服务是否正在运行：**

```sh
sudo systemctl is-active caddy
```

正确输出是：

```text
active
```

`inactive` 或 `failed` 表示未正常运行，在服务器查看原因：

```sh
sudo journalctl -u caddy -n 50 --no-pager
```

这几步分别检查配置和进程。Caddy 启动后会自动验证域名、申请及续期证书；证书与公网 HTTPS 是否可用，以下面的本地 HTTPS 请求为准。

**再切到本地电脑终端**，测试真实公网 HTTPS：

```bash
bash
read -r -s -p 'Production API Key: ' SPROUT_TEST_KEY
echo
curl -i -H "Authorization: Bearer $SPROUT_TEST_KEY" https://app.example.com/api/v1/health
unset SPROUT_TEST_KEY
```

这里先进入 Bash，兼容本机默认使用其他 shell 的情况。正确结果包含 HTTP `200` 和 `{"status":"ok"}`，而且没有证书错误；不要使用 `curl -k` 跳过验证。

| 错误 | 检查 |
| --- | --- |
| `Could not resolve host` | 返回第二步检查 DNS |
| `Failed to connect` / 超时 | Caddy 是否启动，80/443 是否可达、是否仍被其他入口占用 |
| `SSL certificate problem` | 域名、证书申请结果；不要跳过证书验证 |
| HTTP `502` | Go 是否运行，Caddy 上游地址是否正确 |
| HTTP `401` | API Key 是否与 Server 配置一致 |

Caddy 启动或证书错误在云服务器用 `sudo journalctl -u caddy -n 50 --no-pager` 查看。公网 HTTPS 成功后再配置 App。

### 4. 手机 App：填写连接

| 字段 | 填写 |
| --- | --- |
| Server URL | `https://app.example.com` |
| API Key | 第一步生成并写入 `SPROUT_API_KEY` 的整串字符 |

URL 不加 `:8080` 或 `/api/v1`。点击“验证连接”，成功后保存；用移动网络或其他外部网络验证测试笔记、图片与编辑删除同步。

保存记录后下拉同步。新服务器不会自动获得原服务器的数据；切换 Server 后，旧记录的修改可能返回 `note_not_found`，该记录后续操作会等待处理。不要仅凭“Server 已连接”判断所有记录均已同步；检查“未同步”状态。纯文本、三图图文及删除同步的实际两端核验结果见 手机同步记录。删除同步后 App 移除本地记录，Server 保留删除墓碑与图片字节，双方记录总数不必相同。

已有部署或忘记 Key 时，在云服务器终端进入实际项目根目录，再读取原值，不重新生成：

```sh
sed -n 's/^SPROUT_API_KEY=//p' .env
```

### 可选：Cloudflare 网页开启橙云

灰云 HTTPS 已成功时，可以保持灰云；需要代理时，在 Cloudflare 控制台：

1. 将适用的 SSL/TLS 模式设为 **Full (strict)**；域名级设置先确认兼容其他站点。
2. `app` 记录改为 **Proxied**，确认边缘证书生效。
3. 对该 API 主机设置 **Bypass cache**，避免防护规则拦截 App 请求。
4. 从本地终端重做第三步 HTTPS 验证，再从手机重测同步。

橙云后 DNS 返回 Cloudflare 地址是正常的，App、Go、Caddy 基本配置沿用前面步骤。

## Server 数据放在哪里

本教程使用以下路径；实际数据位置以项目根目录 `.env` 中的 `SPROUT_DATABASE_PATH` 为准。

| 路径 | 保存什么 |
| --- | --- |
| `/var/lib/sprout/sprout.db` | SQLite：笔记、图片原始字节、图片关联、同步操作记录 |
| `$SPROUT_DIR/.env` | API Key、监听地址、数据库路径；不提交 Git |
| `$SPROUT_DIR/sprout-server` | Go 程序，可重新构建 |
| `$SPROUT_DIR` | Git 源码，不是生产数据目录 |

**迁移数据要找数据库，不是复制 Git 项目。** 图片也在 SQLite 里，当前 Server 没有单独的图片文件目录。使用 SQLite `.backup` 导出完整备份；服务运行时不要只复制 `sprout.db`，同目录的 `-wal` 文件可能含有已提交数据。

迁到新服务器时，恢复数据库到配置路径并让运行 Server 的登录用户可读写；另外安全保存或重新配置 API Key，新入口单独配置 HTTPS。恢复后核对笔记和图片，再切换 DNS。

修改 `.env` 后执行 `sudo systemctl restart sprout`；移动项目目录后更新 `ExecStart` 中的程序与配置路径，再执行 `daemon-reload` 和重启。

更新、备份与排错见 [Server README](server/README.md)。
