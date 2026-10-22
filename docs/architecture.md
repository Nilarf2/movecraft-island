# 架构说明

本项目依据修改方案重做荒岛玩法，并把姿态推理迁到浏览器，形成可独立部署的静态应用。

| 项目 | 原站 | 本地新版 |
| --- | --- | --- |
| 玩法 | 荒岛生存、射箭、滑雪 | 仅荒岛，按新版流程推进 |
| 页面 | 原生 HTML、CSS、JavaScript、Canvas | 原生 HTML、CSS、JavaScript、Canvas |
| 姿态识别 | 服务器 MediaPipe Pose Full | 浏览器 MediaPipe Pose Lite，Web Worker + WebAssembly |
| 摄像头数据 | JPEG 经 WebSocket 上传服务器推理 | 在当前浏览器内处理，不上传画面 |
| 服务端 | Caddy 反代 FastAPI 与姿态模型 | 仅提供页面、脚本、模型等静态文件 |
| 存档 | 当前浏览器 localStorage | 当前浏览器 localStorage，体感与试玩分别保存，可导入导出 |
| 诊断画面 | 提供最近一帧的诊断接口 | 无诊断帧接口 |

## 本地新版数据流

```text
摄像头 → 浏览器内的 MediaPipe Lite → 人体关键点
       → 动作判定 → 荒岛规则与资源变化 → Canvas 场景
                                      → localStorage 存档
```

摄像头授权要求安全上下文：本机使用 `localhost`，其他设备访问时使用 HTTPS。
页面运行时从同源静态目录读取 MediaPipe 运行库、WebAssembly 和 Lite 模型；不需要姿态推理后端、账户或云存档。
试玩模式使用独立存档，按钮演示不会混入体感进度。

## 与原站的边界

原站的服务器推理版本作为参考实现保留。此次本地版不修改原站的射箭、滑雪和既有存档，原站诊断接口也不属于本地版。

新版已部署至独立的 [在线试玩入口](https://pose.nfffff.dpdns.org/island/)，由 `/island/` 静态路由提供本项目的 `web/` 内容；其余路径继续交给原服务。本地版与线上新版使用同一套静态资源，原站玩法仍可访问。[完整离线包](https://pose.nfffff.dpdns.org/island/movecraft-island-offline.zip)可下载后在本机启动。
