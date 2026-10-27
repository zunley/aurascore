# music-dance-gpt — MIDI 动态乐谱视频渲染服务

把 MIDI 文件渲染成动画乐谱视频（Remotion 合成 + Fastify 服务）。上传 `.mid` 与元信息，服务端异步渲染后返回 mp4。

完整设计方案见 [docs/render-service-plan.md](docs/render-service-plan.md)。

## 前置依赖

- Node.js ≥ 20.19 / 22.13 / 24
- `fluidsynth`、`ffmpeg`（音频管线）
- SoundFont：`sounds/default.sf2`（已内置 Salamander 钢琴，随镜像/本地提供）

## 快速开始（本地开发）

```bash
npm i
npm run dev:setup        # 准备 data/jobs/dev/ 与 data/soundfonts/
npm run server           # 终端 1：API + 渲染 worker（:9302）
npm run dev              # 终端 2：Remotion Studio，defaultProps 指向 /assets/dev
```

Studio 预览与线上渲染走**同一套资产接口**（`/assets/<jobId>/*`），本地换素材只需替换 `data/jobs/dev/` 下的 `input.mid` / `input.mp3`。

## Web 管理界面

浏览器打开 `http://<host>:9302/` 即可使用自带的管理控制台（`web/` 目录，原生 HTML/CSS/JS，无构建步骤，monospace-dark 风格）：

- **新建任务**：上传 `.mid` + 配置曲名/帧率/分辨率/音色后提交渲染
- **渲染任务**：全部任务列表，渲染中实时显示进度，支持下载 mp4 与删除
- **音色库**：注册 `.sf2` 音色文件、查看/删除已有音色

页面本身免鉴权；若设置了 `API_KEY`，在界面左下角填入即可（存于浏览器 localStorage，请求自动携带 `X-API-Key` 头）。

## 部署（Docker）

```bash
cp .env.example .env    # 按需设置 API_KEY / PORT 等
make up                 # 构建镜像并后台启动（docker compose）
make logs               # 跟踪日志
make down               # 停止
```

其他目标：`make build`（仅构建镜像，打 `latest` + git 版本号标签）、`make restart`、`make ps`、`make help`。数据持久化在 `./data`（任务产物、SQLite、SoundFont）。

**镜像瘦身**：`.dockerignore` 排除了 `node_modules`、`data`、`sounds/*.sf2`（1.2GB）、`out` 等，镜像只含源码与 npm 依赖，约几百 MB。音色文件不入镜像：

- 在 `./data/soundfonts/` 放置任意 `.sf2`（如 `default.sf2`），启动时自动注册；也可通过 Web 界面 / API 上传（注册后同样存入 `data/soundfonts/`）
- 单一数据卷 `./data`，无需额外挂载

## API

完整接口文档见 [docs/API.md](docs/API.md)（含请求/响应示例与状态码）。

鉴权：设置 `API_KEY` 环境变量后，`/api/*` 需要 `X-API-Key` 头（Web 界面、`/healthz` 与 `/assets/*` 除外）。

### 提交渲染任务

```bash
curl -F "file=@song.mid" -F "title=Flower Dance" \
     -F "fps=24" -F "width=1280" -F "height=720" \
     -F "soundfont=default" \
     localhost:9302/api/v1/jobs
# → 202 {"jobId":"...","status":"queued","durationSeconds":187.4,"links":{...}}
```

限制：mid ≤ 5MB、时长 ≤ 300s、fps ∈ {24,30,60}、分辨率 ≤ 1920×1080、队列深度 ≤ 20。

### 轮询与下载

```bash
curl localhost:9302/api/v1/jobs/<jobId>          # {status, progress, videoUrl, ...}
curl -OJ localhost:9302/api/v1/jobs/<jobId>/video # 完成后下载 mp4
curl -X DELETE localhost:9302/api/v1/jobs/<jobId> # 取消/删除
```

### SoundFont 管理

任务只引用标识名，文件上传走独立接口（注册一次多任务复用）：

```bash
curl -F "file=@my-piano.sf2" -F "name=my-piano" localhost:9302/api/v1/soundfonts   # 201
curl localhost:9302/api/v1/soundfonts                                               # 列表
curl -X DELETE localhost:9302/api/v1/soundfonts/my-piano                            # 204
```

校验：`name` 白名单字符、`sfbk` 魔数、≤ 512MB、sha256 去重。内置 `default` 不可删除。

### CLI 渲染（与 HTTP 同一契约）

```bash
npx remotion render MusicDance3D out/test.mp4 \
  --props='{"assetBaseUrl":"http://127.0.0.1:9302/assets/<jobId>","title":"Flower Dance"}'
```

## 命令

| 命令 | 说明 |
|------|------|
| `npm run server` | 启动 API + 内嵌渲染 worker |
| `npm run dev` | Remotion Studio 预览 |
| `npm run dev:setup` | 初始化本地 data/ 目录 |
| `npm run audio -- in.mid out.mp3` | 单独生成音频（fluidsynth + ffmpeg） |
| `npm run lint` | eslint + tsc |
| `npm run render` | CLI 渲染（走 defaultProps 的 dev 资产） |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 9302 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `API_KEY` | 关闭 | 设置后启用 X-API-Key 鉴权 |
| `DATA_DIR` | ./data | 任务与 SoundFont 存储目录 |
| `WORKER_CONCURRENCY` | 1 | 并行渲染数（每个渲染约占 1-2GB 内存） |
| `MAX_QUEUE_DEPTH` | 20 | 队列满时提交返回 429 |

## Docker

```bash
docker build -t music-dance-render .
docker run -p 9302:9302 -v music-data:/app/data -e API_KEY=changeme music-dance-render
```

## 目录结构

```
src/        Remotion 合成（参数化：assetBaseUrl/title/fps/width/height）
shared/     同构模块：midi 解析（浏览器+Node）、音频生成（Node）
server/     Fastify API：jobs、soundfonts、assets 路由 + SQLite + 内嵌 worker
scripts/    dev 初始化、音频 CLI
sounds/     内置 SoundFont（default.sf2，git 忽略）
dev/        本地预览素材
data/       运行期数据（git 忽略）：jobs/<id>/、soundfonts/、jobs.db
```

## 许可注意

Remotion 对个人及 ≤3 人团队免费；更大规模商用需购买 [company license](https://remotion.dev/license)。
