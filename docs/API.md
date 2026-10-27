# API 参考

服务默认监听 `http://<host>:9302`。所有响应为 JSON（视频下载除外），错误统一为 `{"error": "原因"}`。

## 鉴权

服务端设置 `API_KEY` 环境变量后，`/api/*` 接口需要携带请求头：

```
X-API-Key: <API_KEY>
```

`/healthz` 与 `/assets/*` 不需要鉴权。

## 典型流程

```bash
# 1. 提交任务
curl -F "file=@song.mid" -F "title=Flower Dance" -F "fps=24" \
     localhost:9302/api/v1/jobs
# → {"jobId":"d8b5...","status":"queued","durationSeconds":187.4,...}

# 2. 轮询状态（每几秒一次，直到 status 变为 done 或 failed）
curl localhost:9302/api/v1/jobs/d8b5...
# → {"status":"rendering","progress":0.42,...}

# 3. 下载视频
curl -OJ localhost:9302/api/v1/jobs/d8b5.../video
```

任务状态流转：`queued → rendering → done`，任一步骤出错则转 `failed`。产物保留 24 小时后自动清理。

---

## 渲染任务

### GET /api/v1/jobs — 列出全部任务

按创建时间倒序返回全部任务（默认最多 500 条）：

```json
{
  "items": [
    {"id": "d8b5ec65-...", "status": "done", "progress": 1, "title": "Flower Dance", "...": "同单任务字段"}
  ],
  "queueDepth": 0
}
```

### POST /api/v1/jobs — 提交渲染任务

`multipart/form-data` 字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `file` | ✅ | MIDI 文件（.mid），≤ 5MB，时长 ≤ 300 秒 |
| `title` | | 视频内显示的曲名，缺省显示 "Untitled nocturne" |
| `fps` | | 24 / 30 / 60，缺省 30 |
| `width` × `height` | | 320~1920 × 180~1080，缺省 1280×720 |
| `soundfont` | | 已注册的 SoundFont 标识名，缺省 `default` |

成功返回 **202**：

```json
{
  "jobId": "d8b5ec65-e747-4b91-9d5c-3702ae2e36bf",
  "status": "queued",
  "durationSeconds": 187.4,
  "links": {
    "status": "/api/v1/jobs/d8b5ec65-...",
    "video": "/api/v1/jobs/d8b5ec65-.../video"
  }
}
```

| 状态码 | 含义 |
|--------|------|
| 400 | 缺少 `file` 字段 |
| 401 | 缺少或错误的 API Key |
| 413 | 文件超过 5MB |
| 422 | MIDI 无法解析 / 无音符 / 超时长 / fps 或分辨率非法 / SoundFont 未注册 |
| 429 | 队列已满（默认 20 个待处理任务），稍后重试 |

### GET /api/v1/jobs/:id — 查询状态

```json
{
  "id": "d8b5ec65-...",
  "status": "rendering",          // queued | rendering | done | failed
  "progress": 0.42,               // 0~1，仅 rendering 阶段更新
  "error": null,                  // failed 时为失败原因
  "title": "Flower Dance",
  "fps": 24, "width": 1280, "height": 720,
  "soundfont": "default",
  "durationSeconds": 187.4,       // 视频时长（提交时同步解析得出）
  "renderSeconds": null,          // 实际渲染耗时，完成后才有值
  "videoUrl": null,               // 完成后变为 "/api/v1/jobs/<id>/video"
  "createdAt": 1793065532107,
  "expiresAt": 1793151939853      // 产物过期时间（任务最后更新 + 24h）
}
```

任务不存在返回 404。

### GET /api/v1/jobs/:id/video — 下载视频

| 状态码 | 含义 |
|--------|------|
| 200 | 返回 mp4（`video/mp4`，`Content-Disposition: attachment; filename="<曲名>.mp4"`） |
| 404 | 任务不存在 |
| 409 | 未完成（`{"status":"rendering","progress":...}`）或已失败（`{"error":"..."}`） |
| 410 | 产物已过期被清理 |

### DELETE /api/v1/jobs/:id — 删除任务及产物

返回 204。渲染中的任务拒绝删除（409）。任务不存在返回 404。

---

## SoundFont 管理

任务提交**只引用标识名**，不接受文件本身。SoundFont 通过独立接口注册一次、多任务复用。

### GET /api/v1/soundfonts — 列出可用 SoundFont

```json
{
  "items": [
    {"name": "default", "size": 1266462334, "sha256": "712d0e...", "builtin": true, "createdAt": 1793065429830},
    {"name": "my-piano", "size": 241172484, "sha256": "a3f9c2...", "builtin": false, "createdAt": 1793150000000}
  ]
}
```

### POST /api/v1/soundfonts — 注册 SoundFont

`multipart/form-data`：`file`（.sf2，≤ 512MB）+ `name`（标识名）。

成功返回 **201**：`{"name":"my-piano","size":241172484,"sha256":"a3f9...","builtin":false}`

| 状态码 | 含义 |
|--------|------|
| 400 | 缺少 `file` 或 `name` 字段 |
| 422 | `name` 含非法字符（只允许 `a-z 0-9 _ -`，须以字母数字开头，≤ 64 字符）/ 空文件 / 文件头不是 `sfbk` 魔数（不是 SoundFont） |
| 409 | `name` 已被占用（需先 DELETE 再重传）；或同一文件（sha256 相同）已注册为其他名字 |

### DELETE /api/v1/soundfonts/:name — 删除 SoundFont

返回 204。内置 `default` 不可删除（400）；正被排队/渲染中任务引用时拒绝删除（409）。

---

## 其他

### GET / — Web 管理界面

服务自带单页管理界面（`web/`，无需构建），提供：提交渲染任务、全部任务列表（含进度轮询）、音色库管理。页面本身免鉴权；若设置了 `API_KEY`，在界面左下角填入即可（浏览器本地保存，请求携带 `X-API-Key` 头）。

### GET /healthz — 存活检查

```json
{"ok": true, "queueDepth": 3}
```

### GET /assets/:jobId/:file — 任务资产（内部接口）

渲染期间 headless Chrome 用它拉取 `input.mid` / `input.mp3`，只放行这两个文件名，无需鉴权。**不要对公网暴露**（建议仅通过 Cloudflare Access 或内网访问）。
