# MoveCraft · 体感荒岛

用摄像头完成运动，把运动换成水、食物、木材和庇护所。中文界面，浏览器本地姿态识别、本地存档，不需要服务器账号、API Key 或 GPU。项目聚焦荒岛玩法；历史服务中的射箭、滑雪模式不包含在本版。

[在线试玩](https://pose.nfffff.dpdns.org/island/) · [下载完整离线包](https://pose.nfffff.dpdns.org/island/movecraft-island-offline.zip)

## 答辩资料

答辩 PPTX、PDF、预览与构建脚本见 [presentation/](presentation/README.md)（原 `island-defense/` 目录）。

## 本地启动

安装 Python 3.10 或更新版本，下载并解压仓库后运行：

```sh
python3 scripts/setup_assets.py
python3 start.py
```

第一次准备资源需要联网，下载固定版本的 MediaPipe 和姿态模型，约 45 MB；游戏和动作识别可离线运行，系统语音是否联网取决于设备使用的语音服务。完整离线分发包已包含资源时可跳过准备步骤。

Windows 先运行 `py -3 scripts/setup_assets.py`，之后可双击 `start.bat`，或运行 `py -3 start.py`。打开 **http://localhost:8787**，使用近期版本的 Chrome 或 Edge。端口被占用时运行 `python3 start.py --port 8788`。运行游戏不需要 Node.js，也无需安装 Python 依赖。

不要直接双击 `web/index.html`：浏览器对摄像头与模块加载要求本地 HTTP 地址。手机访问电脑的局域网 HTTP 地址通常无法使用摄像头，需要为该地址配置 HTTPS。`localhost` 的摄像头例外只适用于当前设备。

## 发给别人：双击即用的一键版

如果对方不熟悉命令行、也不想安装 Python，可以发一键版压缩包：解压后双击 `双击启动游戏.bat`，浏览器会自动打开游戏。包内已含 MediaPipe 资源与 Python 3.11 嵌入式运行时，无需安装 Python。游戏进度仍会保存在浏览器本地，系统语音的联网情况取决于设备。

在一台已执行过 `setup_assets.py` 的 Windows 电脑上重新生成：

```sh
py -3 scripts/fetch_runtime.py      # 下载官方嵌入式 Python 到 runtime/，只需一次
py -3 scripts/package_oneclick.py   # 输出 deliverables/movecraft-island-oneclick.zip
```

启动器会复用同一目录中已经运行的游戏，否则从 8787 起找一个空闲端口，并在控制台打印实际地址；关闭运行服务的控制台窗口即停止服务。端口变化会使用另一份浏览器存档，可通过导出和导入迁移。`runtime/` 与 `deliverables/` 都不进入版本库。

## Docker

```sh
docker compose up -d --build
```

构建镜像时会联网准备模型资源，运行镜像不需联网。访问 **http://localhost:8787**。停止使用 `docker compose down`。Compose 默认只监听本机；如需公开访问，在自己的反向代理上配置 HTTPS。也可在准备资源后把 `web/` 整个目录部署到任意静态站点服务器，保持子目录结构即可。

## 一轮游戏

规则页自动尝试朗读简要规则，朗读结束后进入登录页并自动请求摄像头，再播报「摄像头准备好了。右手向右侧平举，停一下，再往左挥，就能登岛。」浏览器阻止自动朗读时，点击「重新朗读」启用；也可阅读 10 秒后直接开始。镜像画面仍按玩家自身左右判断。摄像头不可用时可选择独立的键鼠试玩存档。

登录页与游戏页都有摄像头选择框。默认「自动选择」使用系统默认摄像头；电脑上装有 Iriun、DroidCam、OBS 虚拟摄像头等软件时，它们会被标注为「虚拟设备」，需要配套手机 App 或软件在运行才能出画面，此时请在下拉框中改选内置摄像头。选择结果会记住，下次打开直接使用。所选设备被拔掉或无法打开时，会自动退回系统默认摄像头。

| 环节 | 完整动作 | 初始次数 | 奖励 |
| --- | --- | --- | --- |
| 摘椰子 | 双脚竖直跳起后落地 | 10 | 水源 +2 |
| 砍树 | 双脚开合、双手举过头后收回 | 10 | 木材 +5 |
| 耕种 | 双臂从身侧平举至肩高后放下 | 10 | 食物 +2 |
| 建房 | 从站直下蹲后重新站起 | 10 | 消耗 5 木材，庇护所升一级 |

每次动作产生 1 体力，关卡完成分别消耗 3、3、3、5 体力；额外体力可按 5:1 兑换水或食物，兑换时会预留当前关卡通关所需体力。每轮恢复最多 6 生命。从存档开始日期算起，每两个自然日，各关目标增加一次，上限 25 次。关卡画面随进度显示椰子掉落、树木变短、麦田长出、房屋升起，并显示玩家影像。

大屏结算页按动作次数换算游戏热量：竖直跳和开合跳每次 0.35 千卡，手臂平举每次 0.1 千卡，深蹲每次 0.25 千卡，四项各 n 次合计 1.05n 千卡。这是按游戏规则换算的数值，不是实际测量。结算显示 98%～99% 的鼓励性百分比，并注明为游戏设定、非真实全国排名；试玩结算单独标识。旧存档按实际完成次数结算，不补造历史动作。网页模式结算仍保持原有热量规则。

活动开始朗读关卡和动作要领，计数时简短报数，过半、还剩三个、最后一个和完成时加一句鼓励；动作较快时会合并尚未播出的计数，优先播报最新进度。长时间未计数时按提示纠正动作，纠正播报至少间隔 8 秒。结算朗读完成情况、总热量和排名鼓励，并一句带过「热量和排名是游戏换算」；各项次数不同时，逐项明细只在屏幕显示。顶部可开关语音或重新朗读，语音开关会被记住；切换页面会取消旧播报。

### 配音

游戏台词由 Gemini TTS（`gemini-3.8-flash-tts`，预置音色 Puck）生成，完整台本见 [docs/voice-script.md](docs/voice-script.md)，音频位于 `web/audio/voice/`。`web/voice-assets.js` 按台词原文映射录音，一句话的各片段按顺序播放；某句缺少录音，或播放中途失败时，余下内容改用设备中文语音。浏览器阻止自动播放时，文字与操作仍可使用。

修改 `web/narration.js` 的台词后重新生成：

```sh
GEMINI_API_KEY=... python3 scripts/generate_voice.py --voice Puck
```

用 Google Cloud 赠金时改走 Agent Platform（原 Vertex AI）：在 Cloud Shell 运行 `gcloud auth print-access-token` 取得令牌（约 1 小时有效），先加 `--probe` 发一条测试请求，再正式生成；令牌过期时脚本会停下，重新取令牌后重跑会跳过已录好的句子。同时设置 `GEMINI_API_KEY` 时，如果 Agent Platform 上没有校对用的文本模型，校对改用 AI Studio。

```sh
VERTEX_ACCESS_TOKEN=... python3 scripts/generate_voice.py --backend vertex --project 项目ID --probe
VERTEX_ACCESS_TOKEN=... python3 scripts/generate_voice.py --backend vertex --project 项目ID --voice Puck
```

脚本把多句台词合成一次请求，按停顿切开，再把切好的片段转写回文字与台本比对：数字不符、漏读、重复或时长异常的句子会重录；只有个别字转写不同的保留，并列入 `reports/voice-report.json` 待人工试听。生成需要 ffmpeg 与 Node.js；免费层按分钟和每日次数限流，中断后重跑会跳过已完成的录音。运行游戏不需要这些工具。

每天消耗水、食物各一份；基础生命损失 4 点，缺水额外 10 点、缺粮额外 8 点。庇护所减伤后向上取整，至少扣 1 点。生命归零即挑战失败，可重新开岛。自然日以设备本地日期计算；退出后的天数会在下次登岛时结算。

| 等级 | 庇护所 | 每日减伤 |
| --- | --- | --- |
| 1 | 简陋棚屋 | 12% |
| 2 | 茅草小屋 | 24% |
| 3 | 原木木屋 | 36% |
| 4 | 加固木屋 | 48% |
| 5 | 石木堡垒 | 60% |
| 6 | 临海营地据点 | 72% |

连续两天未登岛降一级，之后每两天继续降一级；最低为荒地。新一天登岛可获 1～4 点营地体力馈赠，房屋越高越多。满级后继续建造可加固营地，获得水、食物各一份。

## 存档与隐私

摄像头帧在浏览器内交给 MediaPipe Web Worker 识别，不上传。游戏使用浏览器 `localStorage`；换浏览器、改端口或清空网站数据会影响存档，可使用页面底部导入/导出 JSON。体感与键鼠试玩存档相互独立。没有账号系统、遥测、外部字体或 CDN 请求。

## 开发与验证

```sh
npm ci
npm test
npm run test:browser
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

单元测试覆盖游戏日结算和完整动作周期；浏览器测试需要本机 Chromium（通过 `CHROMIUM_PATH` 指定），检查规则倒计时、整轮试玩、存档、摄像头拒绝及本机模型加载。测试结果见 `docs/VALIDATION.md`。

```text
web/core.js       资源、日结算、奖励与存档数据
web/narration.js  全部朗读台词，也是配音生成的台本来源
web/voice.js      录音顺序播放与设备语音回退
web/detector.js   基于 MediaPipe 33 点的动作状态机
web/pose-worker.js 本机姿态推理，CPU WebAssembly
web/scene.js      原创 Canvas 海岛与渐进关卡绘制
web/app.js        摄像头、界面与本地存档
start.py          Python 标准库静态文件服务
```

动作识别依赖光线、机位、遮挡和人体差异。竖直跳要让脚部入镜并先站稳半秒；深蹲建议侧前方机位。合成骨架与浏览器测试不能替代真人动作验收，本版尚未进行真人摄像头体验评估。请量力运动，保持场地平整、周围无障碍物。

项目自有代码与绘图采用 MIT；MediaPipe 运行时及姿态模型的来源、许可证见 `THIRD_PARTY_NOTICES.md`。
