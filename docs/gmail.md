# 添加 Gmail 账号

MailBride 通过 Gmail 的 IMAP 读取和管理邮件，通过 SMTP 发送。当前可使用应用专用密码或已有的 OAuth access token；应用内 Google 登录、refresh token 管理和 token 自动刷新尚未实现。

## 1. 选择认证方式

Google 推荐客户端使用“使用 Google 账号登录”。MailBride 目前没有这一授权界面，因此个人账号可采用应用专用密码：先开启 Google 账号的两步验证，再进入[应用专用密码](https://myaccount.google.com/apppasswords)，创建一个名为 `MailBride MCP` 的 16 位应用密码。不要在配置中填写普通 Google 登录密码。[Google 官方说明](https://support.google.com/accounts/answer/185833?hl=zh-Hans)

若看不到这个入口，账号可能受组织策略、仅安全密钥的两步验证设置或高级保护计划限制。不要为了接入关闭这些保护；应使用账号允许的 OAuth 接入方式。[账号限制说明](https://support.google.com/accounts/answer/185833?hl=zh-Hans)

个人 Gmail 的 IMAP 现已默认启用，不需要再寻找“启用 IMAP”开关；组织管理的 Google Workspace 账号还需遵守管理员的接入策略。[Gmail 官方说明](https://support.google.com/mail/answer/7126229?hl=zh-Hans)

## 2. 追加账号与本地凭据

先参照项目 README 完成配置目录及访问权限设置。默认文件位置：

- Windows：`%APPDATA%\CodexEmailMcp\accounts.json`、`credentials.json`。
- macOS/Linux：`${XDG_CONFIG_HOME:-~/.config}/codex-email-mcp/`。
- 可通过 `CODEX_EMAIL_CONFIG` 和 `CODEX_EMAIL_CREDENTIALS_FILE` 覆盖路径。

使用 [Gmail 账号模板](../examples/gmail.accounts.example.json) 时，将 `accounts` 数组里的 Gmail 对象追加到已有文件，保留 QQ、企业邮箱等其它账号；不要覆盖整个文件。把 `you@gmail.com` 换成实际地址，并确保 `id` 和邮箱地址没有重复。

模板的关键参数如下：[Google IMAP/SMTP 文档](https://developers.google.com/workspace/gmail/imap/imap-smtp)

| 服务 | 主机 | 端口 | MailBride 的 `tls` 值 |
| --- | --- | --- | --- |
| IMAP | `imap.gmail.com` | `993` | `implicit` |
| SMTP | `smtp.gmail.com` | `465` | `implicit` |
| SMTP 可选方案 | `smtp.gmail.com` | `587` | `starttls` |

模板中 `sentCopyMode: "provider"` 让 MailBride 不另行 APPEND Sent 副本。初次接入先使用 `draftSyncMode: "none"` 和 `folders.inbox: "INBOX"`，待实际文件夹确认后再启用云端草稿。模板显式允许新邮件、回复、回复全部、转发和 BCC；一般邮件/文件夹变更及回收站操作仍关闭。

再将 [Gmail 凭据模板](../examples/gmail.credentials.example.json) 的 `MAIL_GMAIL` 条目追加到现有 `credentials.json` 的 `secrets` 对象。在本机填写实际用户名和应用专用密码；账号对象的 `secretRef` 必须与此键名一致。保留原有条目，确保 JSON 逗号正确。真实凭据不应进入 Git、聊天或工具参数。

应用密码更换或撤销后，需要更新本地文件并重新加载 MCP。修改 Google 登录密码也会撤销已有应用专用密码。[Google 官方说明](https://support.google.com/accounts/answer/185833?hl=zh-Hans)

## 3. 校验并进行只读连接检查

在项目目录执行：

```powershell
pnpm check-config
```

这个命令只校验本地配置、格式和文件权限，不证明 Gmail 网络连接或认证成功。通过后重新加载 MailBride MCP 或重启 Codex App，让新进程加载新增账号。

Agent 先调用 `list_accounts` 确认 `gmail` 存在，再调用：

```json
{
  "accountId": "gmail"
}
```

这是 `list_mailboxes` 的参数。成功列出文件夹即可验证一次真实 IMAP 登录；随后可用 `mail_search` 做少量只读搜索。不要为了验证连接自动发送邮件、创建草稿或修改邮件标记。

## 4. 确认实际文件夹并开启云端 Drafts

从 `list_mailboxes` 返回值中找到 `specialUse` 为 `\Drafts`、`\Sent`、`\Trash` 的文件夹，并将对应的 `path` 写入 `folders.drafts`、`folders.sent`、`folders.trash`。使用当前账号实际返回的路径，而不是把网页标签名称直接当作 IMAP 路径。Gmail 的 `LIST` 响应提供这些特殊用途标记。[Gmail 文件夹说明](https://developers.google.com/workspace/gmail/imap/imap-extensions)

例如，**仅当实际返回这些英文路径时**，可把账号中的字段改成：

```json
{
  "draftSyncMode": "imap",
  "folders": {
    "inbox": "INBOX",
    "drafts": "[Gmail]/Drafts",
    "sent": "[Gmail]/Sent Mail",
    "trash": "[Gmail]/Trash"
  }
}
```

这段是替换账号相应字段的示意，不是完整 `accounts.json`。如果服务器返回其它路径，使用实际值。再次运行 `pnpm check-config` 并重新加载 MCP 后，`list_accounts.capabilities.cloudDrafts` 应为 `true`。

之后创建/编辑草稿时，检查 `cloudDraft.status: "saved"` 以及云端 revision 是否等于当前 revision，再告诉用户已保存到 Gmail Drafts。私有草稿保留 BCC，SMTP 提交时仍隐藏 BCC。完整行为与失败处理见 [云端草稿同步](../README.md#云端草稿同步)。

只有明确需要进行有写入的端到端检查时，才执行：

```powershell
pnpm check:cloud-drafts --account gmail --write-test
```

该命令创建一封发给自己的测试草稿，验证云端读取、更新、旧版本清理，最后删除自己的测试副本并确认消失；不会调用 SMTP 发信。缺少 UIDPLUS 等安全清理能力时，工具会报告问题，不会宽泛清空 Drafts。

## OAuth 与连接问题

`credentials.json` 的同一个 secret 可以使用 `{ "username": "you@gmail.com", "accessToken": "有效的 OAuth access token" }`，但不能同时填写 `password`。这个 token 必须由外部流程取得，且具备 Gmail IMAP/SMTP 所需的 `https://mail.google.com/` 授权范围；仅有 Gmail API 的其它 scopes 不应视为 IMAP 授权。[Google XOAUTH2 文档](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)

OAuth access token 通常约一小时有效。MailBride 不接收 `refreshToken`、`clientId` 或 `clientSecret` 字段，也不会自行续期；外部授权流程更新 token 文件后，需要重新加载 MCP，已有进程不会自动重读文件。[Google token 有效期说明](https://developers.google.com/workspace/gmail/imap/imap-smtp)

若连接超时，先检查运行 MailBride 的主机能否连接 `imap.gmail.com:993` 和选择的 SMTP 端口。当前客户端直接建立 TLS/TCP 连接，不会自动采用浏览器的 HTTP 代理设置。配置检查通过或网页登录成功，都不能代替一次真实 IMAP/SMTP 连接检查。
