# MusicDance 渲染服务方案

将本项目从"本地 Remotion 工程"改造为"上传 MIDI → 异步渲染 → 下载视频"的 Web 服务。

## 1. 现状分析

| 环节 | 现状 | 服务化障碍 |
|------|------|-----------|
| 动画输入 | `src/` 硬编码 `staticFile("input.mid")` / `input.mp3` / `metadata.json` | `public/` 是全局单例，多任务互相覆盖，无法并发 |
| 音频生成 | `scripts/generate-audio.mjs`（fluidsynth + ffmpeg，路径写死） | 需参数化为可复用函数 |
| 视频渲染 | `remotion render MusicDance3D` CLI | 无进度回调、无任务管理，需改为编程 API |
| 时长计算 | `calculateMetadata` fetch MIDI 后动态计算 | 改造后需按任务的 MIDI 计算（本身已支持 props，改动小） |

## 2. 目标架构

```
Client
  │  POST /api/v1/jobs (multipart: mid + 元信息)
  ▼
API 服务 (Fastify, 轻量、无状态)          ── 鉴权/限流/校验
  │  入队                                    │
  ▼                                          ▼
任务队列 (MVP: SQLite + 进程内 worker)   Render Worker
  │                                    ① fluidsynth+ffmpeg 生成 mp3
  │                                    ② @remotion/renderer renderMedia
  ▼                                    ③ 写出 mp4
存储 data/jobs/<jobId>/{input.mid,input.mp3,metadata.json,video.mp4}
```

MVP 单进程（API + 内嵌 worker，SQLite 记录任务状态），预留拆分空间。

### 目录结构调整

```
music-dance-gpt/
├── src/                    # Remotion 合成（现有，改为参数化输入）
├── shared/                 # 新增：前后端共用
│   ├── midi.ts             # 从 src/midi.ts 移出（Node 端也用它校验/算时长）
│   └── audio.ts            # 从 generate-audio.mjs 移出：mid → mp3 函数
├── server/                 # 新增：Web 服务
│   ├── index.ts            # Fastify 入口，挂载 /assets/:jobId/*
│   ├── routes.ts           # API 路由（jobs）
│   ├── soundfonts.ts       # SoundFont 注册/列表/删除 + 校验
│   ├── jobs.ts             # 任务状态机 + SQLite
│   └── worker.ts           # 渲染流水线（MVP 内嵌，Phase 2 独立进程）
├── sounds/default.sf2      # 内置默认 SoundFont（从 public/ 移出，镜像内置）
├── scripts/generate-audio.mjs  # 保留为 CLI 包装，内部调 shared/audio
└── Dockerfile / docker-compose.yml
```

运行期数据目录（挂载卷）：

```
data/
├── jobs/<jobId>/           # input.mid / input.mp3 / video.mp4
└── soundfonts/             # <name>.sf2，启动时把内置 default 复制进来
```

## 3. 关键改造

### 3.1 合成参数化（核心，其余都是配套）

#### Step 1：抽取同构模块 `shared/midi.ts`

`src/midi.ts` 是纯 ArrayBuffer 解析函数，无任何浏览器依赖，直接移动为 `shared/midi.ts`，内容零改动。更新 2 处 import（`src/Composition.tsx`、`src/MusicDanceScene.tsx` → `../shared/midi`）。此后 Node 端（提交时校验、算时长）与浏览器端（合成内）共用同一份解析器。

#### Step 2：定义 Props 与取址 helper（`src/Composition.tsx`）

```tsx
export type SceneProps = {
  assetBaseUrl: string;     // 必填：http://127.0.0.1:PORT/assets/<jobId>
  title?: string;
  fps?: number;
  width?: number;
  height?: number;
};

// 严格基于 assetBaseUrl，不回落 staticFile()——public/ 读取策略完全移除
export const assetUrl = (props: SceneProps, name: string) =>
  `${props.assetBaseUrl}/${name}`;
```

本地开发不再读 `public/`：在 `Root.tsx` 的 `defaultProps` 里固定一个 dev 地址（如 `http://127.0.0.1:9302/assets/dev`），把试验用三件套放进 `data/jobs/dev/`，照常 `npm run dev` 预览。开发流程与生产流程完全同构，不存在两套取数逻辑。

#### Step 3：`calculateMetadata` 按任务 MIDI 计算（同文件）

```tsx
const calculateMetadata: CalculateMetadataFunction<SceneProps> = async ({props}) => {
  const res = await fetch(assetUrl(props, "input.mid"));
  if (!res.ok) throw new Error(`Could not load input.mid (${res.status})`);
  const midi = parseMidi(await res.arrayBuffer());
  const fps = props.fps ?? 30;
  return {
    durationInFrames: Math.ceil((midi.durationSeconds + ANIMATION_CONFIG.audioTailSeconds) * fps),
    fps,
    width: props.width,    // 缺省时用 <Composition> 上声明的 1280/720/30
    height: props.height,
  };
};
```

Remotion 的 `calculateMetadata` 返回值可以覆盖 fps/width/height，所以输出规格无需改 `<Composition>` 声明，全靠 inputProps 驱动。

#### Step 4：`src/MusicDanceScene.tsx` 三处取值改 props

组件签名改为接收 `SceneProps`，三个数据源全部改 props：

- MIDI：`fetch(assetUrl(props, "input.mid"))`
- 音频：`<Audio src={assetUrl(props, "input.mp3")} />`
- 标题：`props.title`，缺省时显示 "Untitled nocturne"（`metadata.json` 的 fetch 一并移除）

#### Step 5：服务端约定 inputProps

worker 提交渲染时固定传：

```json
{
  "assetBaseUrl": "http://127.0.0.1:9302/assets/<jobId>",
  "title": "Flower Dance",
  "fps": 30, "width": 1280, "height": 720
}
```

API server 为每个任务提供 `GET /assets/:jobId/:file`（从 `data/jobs/<jobId>/` 读）。地址必须用 `127.0.0.1` 回环或容器内可解析地址，headless Chrome 直接访问该 HTTP 端点。

#### 验收标准

1. Studio 预览：文件放 `data/jobs/dev/` + `defaultProps` 指向 dev 地址，`npm run dev` 正常渲染（回归）
2. `npx remotion render MusicDance3D out/test.mp4 --props='{"assetBaseUrl":"http://127.0.0.1:9302/assets/<id>"}'` 渲染通过
3. 服务链路：curl 提交任务 → 轮询状态 → 下载视频

### 3.2 渲染改为编程 API

用 `@remotion/renderer`（需加为直接依赖）代替 CLI，获得进度回调和更好的错误处理：

```ts
const composition = await selectComposition({
  serveUrl: bundleResult,        // 启动时 bundle 一次，所有任务复用
  id: "MusicDance3D",
  inputProps,
});
await renderMedia({
  composition, serveUrl, codec: "h264",
  outputLocation: `data/jobs/${jobId}/video.mp4`,
  inputProps,
  onProgress: ({progress}) => updateProgress(jobId, progress),  // 0~1 写入 DB
});
```

启动时执行一次 `@remotion/bundler` bundle（`npx remotion bundle` 等价物），避免每任务重新打包。

### 3.3 音频生成参数化

`shared/audio.ts` 导出 `generateAudio({ midiPath, outputPath, soundfontPath })`，内部复用现有 fluidsynth + ffmpeg 逻辑。SoundFont 不再由用户在任务里随意指定文件，而是服务管理的资源（见 §4 SoundFont 管理接口）：镜像内置 `sounds/default.sf2`（现 public/ 下的 Salamander）作为缺省 `default`，任务通过标识名选择，worker 按名解析为 `data/soundfonts/<name>.sf2` 传入。

## 4. API 设计

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/jobs` | multipart 上传：`file`(.mid, 必填)、`title`、`fps`、`width`、`height`、`soundfont`(已注册标识名，缺省 default)。返回 `202 { jobId }` |
| GET | `/api/v1/jobs/:id` | `{ id, status: queued\|audio\|rendering\|done\|failed, progress, error?, videoUrl?, durationSeconds? }` |
| GET | `/api/v1/jobs/:id/video` | 下载 mp4（`Content-Disposition`） |
| GET | `/assets/:jobId/:file` | 任务资产（仅内网/worker 使用，或直接关闭公网访问） |
| DELETE | `/api/v1/jobs/:id` | 取消/删除任务及产物 |
| POST | `/api/v1/soundfonts` | 注册 SoundFont：multipart `file`(.sf2) + `name`。返回 `201 { name, size, sha256 }` |
| GET | `/api/v1/soundfonts` | 可用 SoundFont 列表（含内置 default） |
| DELETE | `/api/v1/soundfonts/:name` | 删除已注册 SoundFont（内置不可删） |
| GET | `/healthz` | 存活 + 队列深度 |

鉴权：`X-API-Key`（环境变量注入），Cloudflare Tunnel 出口时再加一层 Access。

提交时即用 `shared/midi.ts` 解析校验并**同步返回预估时长**，坏文件立刻 422，不进队列。

### SoundFont 管理接口

原则：**任务提交接口不接受 SoundFont 文件本身**，只接受标识名。上传/管理走独立接口，注册一次多任务复用（单个 sf2 可达数百 MB，避免每个任务重复上传）。

```http
POST /api/v1/soundfonts
X-API-Key: $KEY
Content-Type: multipart/form-data

file=ra.piano.sf2      # .sf2，≤512MB，文件头魔数 sfbk
name=flower-piano      # 标识名

→ 201 {"name":"flower-piano","size":241172484,"sha256":"a3f9...","builtin":false}
→ 409 名称已存在（先 DELETE 再重传，避免覆盖正在被任务使用的声音）
→ 409 同 sha256 已注册（提示复用现有 name）
→ 422 魔数校验失败 / name 非法
```

约束：

- `name` 正则 `^[a-z0-9][a-z0-9_-]{0,63}$`，落盘固定为 `data/soundfonts/<name>.sf2`，防路径穿越
- 校验三件套：扩展名 .sf2 + 头 4 字节 `sfbk` 魔数 + sha256（去重与完整性）
- `GET /api/v1/soundfonts` 返回内置 `default`（`builtin: true`，不可删）+ 已注册列表；任务缺省用 default
- 提交任务时 `soundfont=<name>` 未注册 → 422，不进队列
- 启动时将镜像内置的 `sounds/default.sf2` 复制到 `data/soundfonts/default.sf2`（若不存在），保证卷里始终完整

### Webhook 回调（可选，Phase 2 再加）

解决的问题：**调用方如何得知渲染完成**。两种方式：

- **轮询**（MVP 默认）：调用方自己 `GET /jobs/:id` 每隔几秒查一次，直到 `done/failed`。简单，但调用方必须活着等。
- **回调**：提交任务时多传一个 `callbackUrl`，渲染结束时服务端主动向该 URL POST 一次通知：

  ```json
  POST {"jobId": "...", "status": "done", "videoUrl": "http://.../jobs/.../video", "durationSeconds": 187}
  ```

适用场景：调用方是无人值守的流水线时才有价值。例如本项目生态里的典型用法——飞书机器人发起生成，渲染完成后回调 feishu-relay（9301）主动推送结果卡片；或 workflow/ 下的批量脚本一次提交几十个任务，靠回调汇总结果而不必挂起轮询。

实现成本很低（一次带退避重试的 POST，约 40 行），但只在确有这类调用方时再加；人手调试、单次提交的场景轮询足够。

## 5. 端到端输入输出流程（详细）

以一个 187 秒的 `flower.mid` 为例，从一条 curl 命令开始，列出每个接口边界的输入/输出。

### 5.0 总览时序

```
客户端 curl
   │ ① POST /api/v1/jobs (multipart)
   ▼
Fastify API ──② 落盘 data/jobs/<jobId>/input.mid
   │          ③ INSERT jobs (status=queued) ──▶ SQLite
   │◀─ 202 {jobId, durationSeconds}
   │
   │   （客户端随时可 ④ GET /api/v1/jobs/:id 查状态）
   ▼
Worker（进程内循环，⑤ SQLite 原子抢单）
   ├─ ⑥ audio:  input.mid ──fluidsynth──▶ render.wav ──ffmpeg──▶ input.mp3
   ├─ ⑦ render: selectComposition + renderMedia
   │              Chrome 加载合成 ──回环 HTTP──▶ ⑧ GET /assets/<jobId>/input.mid
   │              逐帧渲染 + h264 编码 ──▶ video.mp4
   └─ ⑨ UPDATE jobs (status=done, progress=1)
客户端 ⑩ GET /api/v1/jobs/:id/video ──▶ video.mp4
```

### 5.1 接口①：客户端 → API（唯一对外写入口）

```http
POST /api/v1/jobs
X-API-Key: $KEY
Content-Type: multipart/form-data

file=flower.mid         # 必填，≤5MB，Standard MIDI File
title=Flower Dance      # 可选元信息
fps=30                  # 可选，白名单 {24,30,60}
width=1280 height=720   # 可选，≤1920×1080
soundfont=flower-piano  # 可选，已注册标识名，缺省 default（422 若未注册）
```

同步处理（进队列前全部完成）：multipart 落临时目录 → `shared/midi.ts` 的 parseMidi 校验（非 SMF / SMPTE division / 时长 >5min → 422）→ 校验 soundfont 标识名已注册（未注册 → 422）→ 生成 jobId → 移入 `data/jobs/<jobId>/` → INSERT。

响应：

```json
// 202 Accepted
{
  "jobId": "01JB3K...",
  "status": "queued",
  "durationSeconds": 187.4,
  "links": {
    "status": "/api/v1/jobs/01JB3K...",
    "video": "/api/v1/jobs/01JB3K.../video"
  }
}
```

错误：401 无 key、413 超 5MB、422 坏 MIDI（`{"error":"..."}`）、429 队列满。

### 5.2 边界②③：API → 磁盘 + SQLite

```
data/jobs/<jobId>/
  input.mid    ← 上传原件
  input.mp3    ← worker 阶段⑥产物
  video.mp4    ← worker 阶段⑦产物
```

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,          -- jobId
  status TEXT NOT NULL,         -- queued | rendering | done | failed
  progress REAL DEFAULT 0,      -- 0~1，worker 写
  error TEXT,                   -- 失败原因
  title TEXT, fps INT, width INT, height INT,
  duration_seconds REAL,        -- 提交时同步算好
  render_seconds REAL,          -- 实际渲染耗时（事后统计用）
  created_at INTEGER, updated_at INTEGER
);
```

### 5.3 接口④：客户端查状态

```http
GET /api/v1/jobs/01JB3K...
→ 200 {
    "id": "01JB3K...", "status": "rendering", "progress": 0.42,
    "error": null, "videoUrl": null,
    "durationSeconds": 187.4, "expiresAt": 1761600000
  }
```

`videoUrl` 在 done 后才非空；`expiresAt = created_at + 24h TTL`。

### 5.4 接口⑤：Worker 抢单（SQLite 原子操作，替代消息队列）

```sql
UPDATE jobs SET status='rendering', updated_at=?
WHERE id IN (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1)
RETURNING *;
```

返回空 = 无活可干，sleep 2s 再查。多 worker 进程/容器共享同一 SQLite 时该语句天然互斥，这是不需要 Redis/BullMQ 的关键。

### 5.5 边界⑥：Worker → fluidsynth/ffmpeg（子进程）

```
fluidsynth -ni -q -F <tmp>/render.wav -r 48000 -g 0.7 data/soundfonts/<name>.sf2 data/jobs/<id>/input.mid
ffmpeg -y -i <tmp>/render.wav -c:a libmp3lame -q:a 2 -ar 48000 data/jobs/<id>/input.mp3
```

`<name>` 取任务记录的 soundfont 标识（缺省 default）。非零退出或产物未生成 → failed；60s 超时 kill。

### 5.6 边界⑦：Worker → Remotion 编程 API

bundle 在 server 启动时做一次，所有任务复用：

```ts
const serveUrl = await bundle({ entryPoint: "src/index.ts", webpackOverride });
```

每任务：

```ts
const inputProps = {
  assetBaseUrl: `http://127.0.0.1:${PORT}/assets/${jobId}`,  // 见接口⑧
  title, fps, width, height,
};

const composition = await selectComposition({ serveUrl, id: "MusicDance3D", inputProps });
// ↑ 内部启动 headless Chrome，执行 calculateMetadata：
//   fetch(`${assetBaseUrl}/input.mid`) → parseMidi → durationInFrames
//   返回值同时覆盖 fps/width/height

await renderMedia({
  composition, serveUrl, codec: "h264",
  outputLocation: `data/jobs/${jobId}/video.mp4`,
  inputProps,
  onProgress: ({progress}) => updateProgress(jobId, progress),  // ⑨ 持续写 progress
});
```

超时 = durationSeconds × 10，到期 kill → failed。

### 5.7 接口⑧：Chrome → API 资产路由（渲染期内部回环）

```
GET /assets/<jobId>/input.mid  → 200 audio/midi
GET /assets/<jobId>/input.mp3  → 200 audio/mpeg
```

白名单只放行这两个文件名，其余 404；从 `data/jobs/<jobId>/` 读。这是 headless Chrome 与服务的唯一数据通道，合成里 `assetUrl(props, name)` 拼出的就是这个地址。

### 5.8 边界⑨⑩：收尾与下载

Worker 成功 → `status=done, progress=1, render_seconds=?`；失败 → `status=failed, error=?`。

```http
GET /api/v1/jobs/01JB3K.../video
→ 200 video/mp4; Content-Disposition: attachment; filename="Flower-Dance.mp4"
→ 409 {"error":"job not finished","status":"rendering"}   # 未完成
→ 410                                                  # 已过 TTL 被清理
```

### CLI 调试路径（与 HTTP 同一契约）

本地调试不必走 HTTP，直接对同一接口契约渲染：

```bash
npx remotion render MusicDance3D out/test.mp4 \
  --props='{"assetBaseUrl":"http://127.0.0.1:9302/assets/<jobId>","title":"Flower Dance"}'
```

HTTP 链路和 CLI 链路在 inputProps 处汇合——参数化改造的意义就是让两条路径共用同一份合成代码和同一套资产接口。

### 状态机与写者汇总

| 状态 | 写入者 | 含义 |
|------|--------|------|
| queued | API（INSERT） | 已校验，等待 worker |
| rendering | worker（抢单） | 音频生成 + 渲染中，progress 持续更新 |
| done | worker | video.mp4 就绪，可下载 |
| failed | worker | error 字段有失败原因 |

## 6. 任务流水线与状态机

```
queued → audio（fluidsynth+ffmpeg）→ rendering（renderMedia）→ done
                                          ↘ failed（任意步骤，记录 error）
```

- 队列深度上限（如 20），满则 429
- 每步超时：音频 60s；渲染 = 视频时长 × 10 上限，杀进程标记 failed
- MVP 用 SQLite 表 `jobs(id, status, progress, error, created_at, ...)` + 进程内并发 1~2 的 worker 循环；状态写库保证 API 重启后仍可查询
- 产物保留 TTL（默认 24h），定时任务清理 `data/jobs/`

## 7. 校验与安全

- MIDI：复用 `parseMidi` 校验（拒绝非 SMF、SMPTE division）；文件 ≤ 5MB；时长 ≤ 5 分钟
- SoundFont：name 正则白名单防穿越；`sfbk` 魔数 + 大小 ≤ 512MB + sha256 去重
- 输出规格白名单：fps ∈ {24,30,60}，分辨率 ≤ 1920×1080（渲染耗时与时长×像素正相关）
- 上传文件名不落盘使用，统一用 jobId 命名，防路径穿越
- worker 渲染在独立进程（`renderMedia` 本身起 headless shell），超时 kill
- 服务以非 root 运行，`data/` 挂载卷

## 8. 部署

Docker 单镜像（API + worker 同容器，MVP）：

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    fluidsynth ffmpeg chromium \   # chromium 及字体依赖见 Remotion docs
    fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
# 复制代码 → npm ci → npx remotion browser ensure（预下载 headless shell）
# 复制内置 SoundFont：sounds/default.sf2 → 镜像 /app/sounds/default.sf2
# （服务启动时复制到 data/soundfonts/default.sf2 卷）
```

- homelab 部署：`service/` 下新增 docker-compose，端口 **9302**（应用服务网段），volume 挂 `data/`
- 资源：渲染吃 CPU/内存（每并发 headless Chrome 约 1~2GB），compose 里设 `mem_limit`，`WORKER_CONCURRENCY` 默认 1
- ⚠️ **许可**：Remotion 对个人及 ≤3 人团队免费，更大规模商用需购买 company license。本项目 homelab 自用没问题，若将来对外提供服务需评估。

## 9. 演进路线（精简版，砍掉过度设计组件）

明确**不引入**的组件及理由：

| 组件 | 结论 | 理由 |
|------|------|------|
| Redis + BullMQ | ❌ 不引入 | 单机、并发 1~2 的场景，引入 Redis 等于多一个状态存储（任务状态在 SQLite 和 Redis 各一份，需保持一致）。即使将来拆多 worker，SQLite 队列表也能胜任：worker 用 `UPDATE jobs SET status='rendering' WHERE id IN (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1) RETURNING *` 原子抢单，跨进程安全、零新依赖 |
| MinIO / S3 转存 | ❌ 不引入 | 产物 TTL 24h 自动清理，没有归档价值；NAS 已有 backup.sh 备份体系。需要长期保留的视频由调用方下载后自行归档 |
| Prometheus 指标 | ❌ 不引入 | homelab 规模不值得为此建 dashboard。任务表里记 `renderSeconds` 字段，要看吞吐/耗时直接查表；`/healthz` 输出队列深度足够运维用 |
| 独立 worker 容器 | ⏸ 暂缓 | 单进程内嵌 worker + 并发限制已够用；只有渲染任务量大到影响 API 响应时才拆 |

精简后全栈只有：**Fastify + node:sqlite（内置，无原生编译）+ @remotion/{bundler,renderer} + fluidsynth + ffmpeg**，单容器单进程。

| 阶段 | 内容 | 产出 |
|------|------|------|
| Phase 1 ✅ 已实现 | 合成参数化 + shared/ 抽取 + 单进程 API/worker + SQLite + Dockerfile | 可用的 MVP，curl 提交任务后下载视频 |
| Phase 2（按需） | webhook 完成回调；输入哈希去重（相同 mid+soundfont+配置直接返回已有视频，省一次完整渲染） | 服务无人值守流水线；省算力 |
| Phase 3（仅在单机扛不住时） | SQLite 队列 + 独立 worker 进程/容器（共享 data/ 卷，原子抢单） | 渲染与 API 隔离，加 worker 水平扩展 |

## 10. 风险

1. **并发渲染资源**：headless Chrome 多实例内存高，MVP 限并发 1~2，靠队列削峰
2. **首启 bundle 耗时**：bundle 与 browser 下载在容器构建期/启动期完成，运行期不重复
3. **fluidsynth 输出差异**：不同版本渲染结果可能有细微差异，内置 default 固定在镜像里保证可复现；用户注册的 soundfont 按 sha256 固定
4. **公网暴露**：渲染是重资源操作，必须鉴权 + 限流 + 队列上限，建议走 Cloudflare Tunnel 不直接暴露端口
