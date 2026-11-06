# 展示版模块接口约定

2026-11-06 起草，主代理维护。目标是 2026-11-07 的现场展示。展示入口是大屏页 web/stage.html；原来的 web/index.html 和 web/app.js 保持不变，作为个人版继续用。

## 时间线（北京时间）

2026-11-06 13:30 主代理换人后重排：

| 时间 | 交付 |
| --- | --- |
| 14:15 | sfx.js 能接入 |
| 14:30 | pose-stream.js |
| 15:00 | island.js、avatar.js 能接入；server/ 测试通过 |
| 15:15 | quality.js |
| 15:30 | 账号界面组件；大屏页用假模块键鼠走通一轮 |
| 15:45 | api.js |
| 16:00 | 启动器 --path 和两个 bat |
| 16:30 | 大屏页接上全部真模块和摄像头 |
| 17:00 | 全流程走通；台本冻结 |
| 17:30 | 部署到 https://pose.nfffff.dpdns.org/island/stage.html |
| 18:00 | 用户试玩；晚上打 Windows 包 |

配音（主代理）：拿到 Agent Platform 令牌后立即录全部剩余台词；不行就 16:00 用 AI Studio 免费额度先录大屏优先的 71 句。

接口一能用就先用 SendMessage 告诉 "main"，再接着打磨。

## 文件归属

| 文件 | 负责 |
| --- | --- |
| web/world/island.js、web/lookdev.html、tests/island.test.mjs | 3D 岛 |
| web/world/avatar.js、web/avatar-lab.html、tests/avatar.test.mjs；web/pose-worker.js 只加 worldLandmarks 一个字段 | 小人 |
| web/stage/sfx.js、web/sfx-lab.html、tests/sfx.test.mjs | 音效 |
| web/stage/pose-stream.js、web/stage/quality.js、tests/quality.test.mjs、web/perf-lab.*、launcher/、scripts/package_oneclick.py、tests/test_packaging.py | 性能 |
| server/、web/net/api.js、tests/api-client.test.mjs | 后端 |
| web/stage/ui/、web/ui-lab.html、tests/stage-ui.test.mjs | 账号界面 |
| web/stage.html、web/stage/ 下其余文件、tests/stage-flow.test.mjs、tests/browser-stage.mjs | 大屏页 |
| web/stage/tokens.css、web/narration.js、web/voice.js、docs/、README、package.json、部署、git | 主代理 |

截图和报告各自放在 reports/<模块名>/ 下，比如 reports/avatar/、reports/stage/。

其他文件谁都不改。需要别人改文件，或者发现别人的模块有 bug，用 SendMessage 告诉 "main"。

## 公共约定

- 不用构建工具，全部是 ES module。stage.html 在 web/ 下，import map 把 "three" 指向 ./vendor/three/three.module.js。
- web/world/ 下的模块不直接 import three，由调用方把 THREE 传进来，这样纯逻辑能在 node 里测。
- 运行时除了 API 不发任何外部请求，不加载网络字体。
- 用户能看到的文字一律用中文。
- 不 commit、不 stash、不 reset、不 checkout，不部署，不上传。主代理统一提交。
- 交之前跑 `npm test` 和 `python3 -m unittest discover -s tests -p 'test_*.py'`。
- 大屏的颜色、字号、圆角统一用 web/stage/tokens.css 里的变量，不要另起一套。

## 渲染

大屏页持有唯一一个全屏的 WebGLRenderer。每帧按顺序调用：
`quality.sample(dtMs, {poseFps})` → `island.update(dt, t)` → `avatar.update(dt, t)` → `renderer.render(island.scene, island.camera)`

## island.js（3D 岛）

`createIsland(THREE, {palette: 'day', quality: 'medium', zone: 0, reducedMotion: false})` 返回：

- `scene`、`camera`、`avatarHeight`（推荐的小人身高，世界单位）
- `update(dt, t)`、`resize(w, h)`、`stats()`、`dispose()`
- `focusZone(i)`：0 椰林、1 树林、2 田地、3 营地。镜头缓动过去，小人约占画面高度的 40%。
- `setAttract(on)`：待机时慢速绕岛
- `setPalette(name)`
- `setQuality(level)`：只管场景这一侧，即投影、粒子、实例密度
- `setShelter(level, {animate})`：level 取 0–6
- `setResources({water, wood, food})`
- `rep(stage, count, target)`：推进持久进度，同时放一次即时反馈
- `stageDone(stage)`、`celebrate()`
- `anchor(zone)`：返回 `{position, facing}`
- `toScreen(vec3, w, h)`：返回 `{x, y}`，单位 CSS 像素

画面顶部 14% 和底部 18% 是 HUD 带，重要内容不要放进去。

## avatar.js（小人）

`createAvatar(THREE, {height, palette: 'day', mirror: true})` 返回：

- `group`：由调用方 add 到 island.scene，放在 `island.anchor(zone)` 的位置
- `setPose(landmarks, worldLandmarks, timestamp)`：MediaPipe 的 33 个点。worldLandmarks 为空时用 2D 点估算。
- `setDemo(action)`：没人时播放示范动作。action 取 idle、wave、jump、jack、raise、squat。
- `flash(part)`：计数时让对应部位闪一下。part 取 legs、arms、body。
- `update(dt, t)`、`dispose()`

600 ms 内没有收到新姿态时自动回到 idle。pose-worker.js 的 pose 消息增加字段 `worldLandmarks: result.worldLandmarks?.[0] || []`，其余字段不变。

## sfx.js（音效）

`createSfx({context})` 返回：

- `unlock()`：用户第一次按键或点击时调用
- `play(name, {pitch, gain})`：name 取 rep、repFinal、stageDone、shelterUp、roundDone、coin、uiMove、uiSelect、uiBack、error、login、countdown、whoosh
- `ambient(on)`：海浪环境声
- `setVolume(v)`、`mute(on)`
- `duck(on)`：旁白播放时调用 duck(true)

全部用 WebAudio 合成，不加载音频文件。没有 AudioContext 时，所有方法都是空操作。

## pose-stream.js、quality.js（性能）

- `listCameras()` 返回 `[{deviceId, label}]`
- `createPoseStream({deviceId, width, height, onPose, onStatus})` 返回 `{start(), stop(), switchCamera(id), video, stats()}`
  - `onPose({landmarks, worldLandmarks, timestamp, latency, fps})`
  - `onStatus({state, error})`：state 取 starting、ready、running、stalled、error、stopped
- `createQuality(renderer, {initial: 'auto', onChange})` 返回 `{level, sample(dtMs, {poseFps}), set(level)}`
- `webglAvailable()` 返回布尔值

## api.js（后端）

`createApi({base, storage, sessionStorage, fetch})`，完整说明见 server/README.md。

- base 默认是 `new URL('./api/v1/', location.href)`，可以用页面里的 `<meta name="movecraft-api">` 覆盖，不接受 URL 参数覆盖。
- 线上地址：https://pose.nfffff.dpdns.org/island/api/v1/
- 本地启动器：http://127.0.0.1:端口/api/v1/
- 只有摄像头模式的完整一轮才调用 `submitRound({counts, durationSec, mode: 'camera', finishedAt})`。键鼠试玩和中途退出都不提交。

## 账号界面组件

- `mountLogin(root, {api, sfx, onDone})` 返回 `{focus(), destroy()}`。onDone 的参数是 `{user}` 或 `{guest: true}`。
- `mountBoard(root, {api, period: 'week', highlight, limit: 10, compact: false})` 返回 `{refresh(), destroy()}`
- `mountSettlement(root, {summary, rank, reason, sfx, onDone})` 返回 `{destroy()}`
  - rank 是 `{weekRank, weekPercentile, weekTotal}`，没有排名时为 null
  - reason 取 null、guest、offline、demo、queued

文件放在 web/stage/ui/：account.js、board.js、settlement.js、ui.css。

## narration.js（主代理，已完成）

- `kioskParts(key)`：返回 parts。key 和使用时机：
  - attract：待机时检测到有人，同一个人 60 秒内只说一次
  - loginPrompt：打开登录界面
  - welcomeNew：注册成功；welcomeBack：登录成功
  - guest：选择游客
  - wavePrompt：ready 状态，提示挥手登岛（和个人版的 LOGIN_CONFIRM 是同一句）
  - offline：连不上服务器
  - bye：排行榜倒计时结束、自动退出时
- 挥手成功后进第一关：`stageParts({stage: 0, target, greeting: true})`，开头会先说「登岛成功！」。
- 结算只调一次：`settlementParts({demo, summary, percentile: false, rank: {rank, percentile, reason}})`
  - rank 是服务器返回的 weekRank；percentile 是 weekPercentile，0–100 的整数，只有一人上榜时为 null。
  - reason 取 null、guest、offline、queued、demo。
  - 名次那句会排在次数之后、告别之前。具体名次只显示在屏幕上，语音只说「前三」「前十」这类档位。
- `rankParts({rank, percentile, reason})`、`rankBand(...)`、`RANK_LINES`、`KIOSK` 也导出了，需要时可以单独用。
- 用户名不念出来：录音念不了任意名字，名字只显示在屏幕上。

用法和现在一样：`narrator.speakParts(parts)`。

## 大屏流程

attract（待机）→ login（登录）→ ready（挥手登岛）→ 四关 → settlement（结算）→ leaderboard（排行榜）→ attract
