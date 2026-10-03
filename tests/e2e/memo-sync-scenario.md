# App 与 Server SQLite 同步场景

在隔离的 Android 模拟器和测试 Server 上运行。测试数据只写入这两个测试实例；不要在日常使用的手机或 Server 数据库上执行。

1. 启动测试 Server 和 Expo，连接模拟器，并确认 App 显示“已连接”。设置 `SPROUT_E2E_SERVER_DB` 为测试 Server 的 SQLite 文件路径；默认使用 `.expo/image-sync-server.db`。如需指定模拟器，设置 `ANDROID_SERIAL`。
2. 运行 `node scripts/e2e-memo-sync.mjs baseline`。脚本检查两库完整性与外键，并保存基线到忽略 Git 的 `.tmp/memo-sync-e2e/`。
3. 在 App 中分别新增一条纯文本、一条纯图片、一条正文加图片记录；在首页下拉同步，等待“未同步”标记消失。
4. 运行 `node scripts/e2e-memo-sync.mjs created`。脚本按基线识别三条新记录，逐条核对正文、图片顺序、图片字节 SHA-256、Outbox `acked` 和 Server 版本。
5. 在 App 中删除这三条记录，再下拉同步；运行 `node scripts/e2e-memo-sync.mjs deleted`。脚本核对 App 记录及图片关系消失、图片文件清理、Outbox `acked`、Server 墓碑与版本，并再次检查两库完整性和外键。

脚本的 `created` 和 `deleted` 阶段只读数据库及 App 私有文件；失败时会指出具体记录或字段。每次测试从 `baseline` 重新开始。
