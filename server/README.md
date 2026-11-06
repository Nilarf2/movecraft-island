# MoveCraft 账号与排行榜服务

只用 Python 标准库（3.10 以上，线上用 3.12）和 SQLite，不需要安装任何依赖。提供注册登录、小岛存档同步、本周榜和总榜。前端客户端是 `web/net/api.js`，见文末。

## 本地启动

在仓库根目录：

```sh
python3 -m server.serve
```

默认监听 `127.0.0.1:8787`，数据库在 `server/.data/movecraft.sqlite3`（已加入 `.gitignore`）。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DB_PATH` | `server/.data/movecraft.sqlite3` | 数据库文件 |
| `HOST`、`PORT` | `127.0.0.1`、`8787` | 监听地址；`PORT=0` 时随机端口 |
| `ALLOWED_ORIGINS` | 空 | 允许跨域的来源，逗号分隔，写完整 origin，如 `https://a.example`。不支持通配符 |
| `TRUST_PROXY` | 关 | 设为 `1` 时，取 `X-Forwarded-For` 最右边一项作为客户端 IP。只有前面是自己的反向代理时才能打开 |
| `SCRYPT_N` | `16384` | scrypt 成本，只在测试里调低 |
| `REGISTER_PER_HOUR` | `120` | 每个 IP 每小时最多注册几次 |
| `LOGIN_FAILURES_PER_IP` | `300` | 每个 IP 每 15 分钟最多登录失败几次 |

## 接口约定

- 前缀 `/api/v1/`。也认 `/v1/`，所以反向代理去掉 `/island` 或 `/island/api` 都可以。
- 请求体只收 `application/json`，最大 300 KB。
- 鉴权用 `Authorization: Bearer <token>`，不用 Cookie。
- 返回的时间都是 UTC 的 ISO 8601，如 `2026-11-06T04:00:00Z`。日和周按北京时间（固定 UTC+8）算，每周从周一 00:00 开始。
- 每个响应都带 `X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`。
- 出错时返回 `{"error": {"code": "...", "message": "中文说明"}}`。锁定和限流另外带 `retryAfter`（秒）和 `Retry-After` 响应头。

### 错误码

| HTTP | code | 什么时候 | api.js 里的 code |
| --- | --- | --- | --- |
| 400 | `invalid` | 字段缺失或格式不对，用户名或密码不合规则 | `invalid` |
| 401 | `credentials` | 登录时用户名或密码不对 | `credentials` |
| 401 | `auth` | 没带令牌，或令牌无效、过期、已作废 | `auth`，同时清掉本地登录 |
| 403 | `credentials` | 改密码、删账号时密码不对（不会让人掉线） | `credentials` |
| 403 | `forbidden` | 跨域预检被拒 | 浏览器里表现为 `network` |
| 404、405 | `not_found`、`not_allowed` | 接口不存在、方法不对 | `server` |
| 409 | `taken` | 用户名已被占用 | `taken` |
| 409 | `conflict` | 存档版本不是最新，带 `latest` | `conflict` |
| 411、413、415 | `invalid`、`too_large` | 没有 Content-Length、请求体或存档太大、不是 JSON | `invalid` |
| 422 | `rejected` | 成绩没通过合理性检查 | `rejected` |
| 429 | `locked` | 这个用户名连续输错 5 次，锁 15 分钟 | `locked` |
| 429 | `rate` | 同一 IP 注册太多或登录失败太多 | `rate` |
| 500、503 | `server` | 服务器出错或正忙 | `server` |
## 接口

### 账号

**POST /auth/register**、**POST /auth/login**

- 请求：`{"username": "小明", "password": "secret1", "remember": false}`
- 返回：`{"token", "expiresAt", "user": {"id", "username"}}`。注册返回 201，登录返回 200。
- 用户名：先做 NFKC 规范化并去掉首尾空格，2–16 个字符，只能用汉字、ASCII 字母、数字和下划线，和 `web/stage/ui/logic.js` 的规则一致。判重不分大小写，`Lin` 和 `lin` 算同一个人。admin、游客、管理员这类名字不能注册。
- 密码：NFKC 规范化后 6–128 位，所以全角和半角数字算同一个密码。
- `remember` 为 `true` 时令牌 30 天有效，否则 4 小时，给大屏这类公用设备用。

**POST /auth/logout**：作废当前令牌。没带令牌也返回 200 `{"ok": true}`。

**GET /me**：返回 `{"user": {"id", "username"}, "expiresAt"}`。

**POST /me/password**：请求 `{"oldPassword", "newPassword"}`。改完后，除当前令牌外，这个账号的其他令牌全部作废。

**DELETE /me**：请求 `{"password"}`。删除账号，存档、成绩和令牌一起删掉，用户名可以被重新注册。

### 存档

**GET /save**：返回 `{"data", "version", "updatedAt"}`。没有存档时是 `{"data": null, "version": 0, "updatedAt": null}`。

**PUT /save**

- 请求：`{"data": 任意 JSON, "version": 你手上的版本号}`。第一次保存时 version 填 0。
- 成功返回 `{"version": 新版本号, "updatedAt"}`。
- version 不是服务器上的最新版本时返回 409，`error.latest` 里是服务器上的 `{data, version, updatedAt}`。
- data 序列化后超过 256 KB 时返回 413。

### 成绩

**POST /rounds**

- 请求：`{"roundId": "UUID", "counts": [竖直跳, 开合跳, 平举, 深蹲], "durationSec": 150, "mode": "camera", "finishedAt": "2026-11-06T04:00:00Z"}`
- finishedAt 可以是带时区的 ISO 8601 字符串，也可以是毫秒时间戳。
- roundId 是幂等键。同一个账号重复提交同一个 roundId，只算第一次，返回 200 和 `duplicate: true`。
- 返回：`{"accepted": true, "duplicate": false, "weekTotal", "weekRank", "weekPercentile"}`。新成绩返回 201。
  - weekTotal：本周累计次数。
  - weekRank：本周名次，并列同名次。
  - weekPercentile：定义见下文。
- 合理性检查不通过时返回 422 `rejected`：
  - mode 不是 `camera`。键鼠试玩不计入排行。
  - 某一项不在 0–40 之间，或四项都是 0。
  - 平均每个动作不到 0.6 秒，或 durationSec 不在 (0, 3600] 之间。
  - finishedAt 和服务器时间相差超过 10 分钟。
  - 这个账号今天（北京时间）已经计入 30 轮。
- 成绩算进哪一天、哪一周，看服务器收到的时间，不看客户端填的 finishedAt。
- 被管理员隐藏的账号，成绩照样保存，但 weekRank 和 weekPercentile 是 null。

### 排行榜

**GET /leaderboard?period=week|all&limit=10**

- period 默认 `week`。limit 取 1–100，默认 10。
- 返回 `{"period", "weekStart": "2026-11-02", "entries": [{"rank", "username", "total", "rounds"}], "me"}`。
  - weekStart 是本周一的北京日期。
  - entries 按 total 从高到低排列。并列同名次（1, 1, 3）。隐藏的账号不出现。
- 带有效令牌时，me 是自己那一行，不在前 limit 名也会给出。没带令牌、令牌无效或者自己没上榜时，me 是 null。这个接口不会因为令牌无效返回 401。

**GET /me/stats**

- 返回 `{"weekStart", "streakDays", "week": {...}, "all": {...}}`。
- week 和 all 都是 `{"total", "rounds", "rank", "percentile", "players"}`。players 是这个榜上的人数。
- streakDays 是连续运动天数：截至今天，每天（北京时间）至少有一轮被接受。今天还没运动时，从昨天往前数。

**GET /health**：只返回 `{"ok": true}`，会检查数据库能不能连上。连不上时返回 503，不给任何内部信息。

### weekPercentile 的定义

weekPercentile 是 0–100 的整数，向下取整，表示本周超过了多少比例的其他参与者。

- 参与者：本周（北京时间周一 00:00 起）至少有一轮被接受、没有被隐藏的账号。
- 计算：`floor(100 × 本周总次数严格低于我的人数 ÷ (参与者人数 − 1))`。
- 分数相同的人不算被超过。
- 本周只有自己一个参与者，或者自己被隐藏时，值为 null。
- 例子：4 个人分别是 40、40、20、4 次，40 次的两人都是 66（超过 3 人中的 2 人），20 次是 33，4 次是 0。
- 前端的语音档位按这个值算，≥ 50 说「超过一半」。GET /me/stats 里的 percentile 用同样的定义，总榜的 percentile 就把「本周」换成「全部」。
## 在别的 Python 程序里使用

处理函数不依赖 HTTP 服务器，线程安全：

```python
from server.app import App
app = App("/path/to/movecraft.sqlite3")
status, headers, body = app.handle("GET", "/api/v1/health", {}, b"", "127.0.0.1")
```

- 传入：headers 可以是 dict，也可以是 (name, value) 列表；body 是 bytes。
- 返回：headers 是 (name, value) 列表，body 是 bytes。
- `create_app()` 从上面的环境变量读配置。
- `server.serve.respond(app, handler)` 把一个 BaseHTTPRequestHandler 的请求交给 app 处理，会顺带检查 Content-Length 和大小上限。

## 管理命令

在容器里运行：`docker compose exec api python -m server.admin 子命令`。在本机运行：`python3 -m server.admin --db 数据库路径 子命令`。

| 子命令 | 作用 |
| --- | --- |
| `list-users [--hidden]` | 列出账号、轮数和总次数 |
| `reset-password 用户名` | 生成一个 10 位随机密码，只显示这一次；这个账号的令牌全部作废 |
| `hide 用户名`、`unhide 用户名` | 在所有排行榜上隐藏或恢复这个账号 |
| `delete-user 用户名 --yes` | 删除账号和它的全部数据。不加 `--yes` 只提示，不删 |
| `backup [路径] [--force]` | 用 SQLite 的 backup API 做一致的快照。默认写到数据库旁边的 `backups/movecraft-日期-时间.sqlite3`。目标已存在时要加 `--force` |

登录锁定记在服务进程的内存里，重置密码不会解锁。锁定 15 分钟后自动解除，重启服务也会解除。

## 部署（server/compose.yaml）

文件写好了，没有执行过 docker。部署由主代理来做。

- 镜像用 `python:3.12-alpine`，不需要构建。server/ 只读挂载到 `/app/server`。
- 以 10001:10001 运行。根文件系统只读，`/tmp` 是 16 MB 的 tmpfs。
- 只发布 `127.0.0.1:8787`。Caddy 把 `https://pose.nfffff.dpdns.org/island/api/*` 去掉前缀后反代到这里。
- `TRUST_PROXY=1`：客户端 IP 取 `X-Forwarded-For` 最右边那一项，也就是 Caddy 写的那一项。端口只对本机开放，只有本机进程能绕过 Caddy 直连。
- 限制：内存 128 MB（不用 swap），CPU 0.5，最多 64 个进程。日志最多 10 MB × 3 份。
- healthcheck 每 30 秒请求一次 `/api/v1/health`。
- 根目录的 compose.yaml（静态游戏服务器）也占用 `127.0.0.1:8787`，两者不能在同一台机器上同时跑。
<!--README_PART_4-->
