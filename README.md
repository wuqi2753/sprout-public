# Sprout

极简文本 Capture App：快速记录想法与图片，保存到本地，并同步到自己的 Server。客户端使用 Expo / React Native，Server 使用 Go / SQLite。App 不提供 AI 服务。

## 运行客户端

安装 Node.js 和 pnpm；原生构建还需要 Android / iOS 开发环境。

```sh
pnpm install --frozen-lockfile
pnpm start
# Android
pnpm android
# iOS（macOS）
pnpm ios
# Web
pnpm web
```

## 运行自己的 Server

需要 Go 1.24 或更高版本。首次在项目根目录执行：

```sh
cp .env.example .env
```

编辑 `.env`：填写自行生成的 API Key，将数据库路径改为有读写权限的路径。真实配置不要提交。然后：

```sh
cd server
go build -o ../sprout-server .
cd ..
./sprout-server -env-file .env
```

在 App 连接设置中填写 Server URL 和同一个 API Key，验证后保存。Android 模拟器访问开发机用 `http://10.0.2.2:8080`；真机需要可达的监听地址，例如 `0.0.0.0:8080`，并配置防火墙。公网部署应通过 HTTPS 反向代理访问。

连接验证接口是 `GET /api/v1/health`，请求头是 `Authorization: Bearer <API Key>`。SQLite 保存笔记、图片字节、删除墓碑及同步记录。备份使用 SQLite `.backup`；服务运行时不要只复制数据库主文件而遗漏 WAL。

保存后下拉同步。切换 Server 不会自动迁移旧 Server 数据，注意未同步状态。

## Android 安装包

发布的安装包可从本仓库 Releases 下载。源码开发使用上面的 `pnpm android`。

首次安装不会预置笔记、图片、数据库或服务器凭据。自行签名的版本与其他签名版本可能无法直接覆盖安装，卸载前备份记录。

## 代码检查

SQLite 初始化测试需要 Python 3。

```sh
pnpm lint
pnpm test
cd server
go test ./...
```

## 反馈与许可证

欢迎通过 Issues 反馈问题或提交 PR。项目许可证见 [LICENSE](LICENSE)；原 Expo 模板的 MIT 声明保存在 [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES)。
