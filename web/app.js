/* music-dance-gpt console — vanilla JS, no build step */
"use strict";

const $ = (sel) => document.querySelector(sel);

const state = {
  view: "jobs",
  jobs: [],
  soundfonts: [],
  queueDepth: 0,
  apiKey: localStorage.getItem("mdg.apiKey") ?? "",
};

/* --- api --------------------------------------------------------------- */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const api = async (path, options = {}) => {
  const headers = { ...(options.headers ?? {}) };
  if (state.apiKey) headers["X-API-Key"] = state.apiKey;
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }
  return res.status === 204 ? null : res.json();
};

/* --- helpers ----------------------------------------------------------- */

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmtBytes = (n) => {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
};

const fmtSeconds = (s) => (s == null ? "-" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

const fmtTime = (ts) => {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const STATUS = {
  queued: { dot: "dot-warn", label: "queued" },
  rendering: { dot: "dot-on", label: "rendering" },
  done: { dot: "dot-on", label: "done" },
  failed: { dot: "dot-off", label: "failed" },
};

/** Appends the API key as ?key= for requests that cannot carry headers. */
const keyed = (path) => (state.apiKey ? `${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(state.apiKey)}` : path);

const toast = (message, kind = "ok") => {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = kind === "ok" ? '<span class="dot dot-on"></span>' : "";
  el.append(message);
  $("#toasts").append(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 250);
  }, 4000);
};

const handleError = (err) => {
  if (err instanceof ApiError && err.status === 401) {
    toast("401 unauthorized — 请在左侧填写 API KEY", "error");
  } else {
    toast(err instanceof Error ? err.message : String(err), "error");
  }
};

/* --- view switching ---------------------------------------------------- */

const switchView = (view) => {
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("hidden", el.id !== `view-${view}`));
  if (view === "jobs") refreshJobs();
  if (view === "soundfonts") refreshSoundfonts();
};

/* --- jobs -------------------------------------------------------------- */

const downloadJob = (job) => {
  // Direct navigation: the browser streams the file itself (instant start,
  // no full-file buffering). ?key= carries the API key (no custom headers).
  const a = document.createElement("a");
  a.href = keyed(job.videoUrl);
  a.download = "";
  a.click();
};

/* --- preview ----------------------------------------------------------- */

const openPreview = (job) => {
  const modal = $("#preview-modal");
  const video = $("#preview-video");
  $("#preview-title").textContent = job.title ?? "Untitled nocturne";
  video.src = keyed(`/api/v1/jobs/${job.id}/video?inline=1`);
  modal.classList.remove("hidden");
};

const closePreview = () => {
  const modal = $("#preview-modal");
  const video = $("#preview-video");
  video.pause();
  video.removeAttribute("src");
  video.load();
  modal.classList.add("hidden");
};

const deleteJob = async (job) => {
  if (!confirm(`删除任务 ${job.title ?? job.id}？产物将一并清除。`)) return;
  try {
    await api(`/api/v1/jobs/${job.id}`, { method: "DELETE" });
    toast("任务已删除");
    refreshJobs();
  } catch (err) {
    handleError(err);
  }
};

const renderStats = (jobs) => {
  const count = (s) => jobs.filter((j) => j.status === s).length;
  $("#jobs-stats").innerHTML = [
    `<span>${jobs.length} total</span>`,
    `<span class="stat"><span class="dot dot-on"></span>${count("rendering")} rendering</span>`,
    `<span class="stat"><span class="dot dot-warn"></span>${count("queued")} queued</span>`,
    `<span class="stat"><span class="dot dot-off"></span>${count("failed")} failed</span>`,
  ].join("");
};

/** Card preview area: 16:9. done -> click-to-play video; pending -> blurred
 * procedural noise; failed -> error text panel. */
const jobThumb = (job, queuedPosition) => {
  if (job.status === "done" && job.videoUrl) {
    return `
      <div class="thumb">
        <video src="${keyed(job.videoUrl)}" preload="none" muted playsinline></video>
        <button class="play-overlay" aria-label="播放">
          <svg viewBox="0 0 16 16"><path d="M5 3.5v9l7.5-4.5z" /></svg>
        </button>
      </div>`;
  }
  if (job.status === "failed") {
    return `
      <div class="thumb thumb-error">
        <div class="thumb-error-text" title="${esc(job.error ?? "render failed")}">${esc(job.error ?? "render failed")}</div>
      </div>`;
  }
  if (job.status === "rendering") {
    const pct = Math.round(job.progress * 100);
    return `
      <div class="thumb thumb-pending">
        <div class="thumb-center"><span class="dot dot-on"></span><span>rendering ${pct}%</span></div>
        <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>`;
  }
  return `
    <div class="thumb thumb-pending">
      <div class="thumb-center"><span class="dot dot-warn"></span><span>queued · 位置 #${queuedPosition}</span></div>
    </div>`;
};

const renderJobs = () => {
  const list = $("#jobs-list");
  const jobs = state.jobs;
  $("#nav-jobs-count").textContent = jobs.length ? String(jobs.length) : "";
  renderStats(jobs);

  if (jobs.length === 0) {
    list.innerHTML = '<div class="empty">暂无任务 — 到「新建任务」提交一个 .mid</div>';
    return;
  }

  // Worker 领取最早的 queued 任务，按创建时间升序计算排队位置
  const queuedAsc = jobs.filter((j) => j.status === "queued").sort((a, b) => a.createdAt - b.createdAt);

  list.innerHTML = jobs
    .map((job) => {
      const status = STATUS[job.status] ?? STATUS.queued;
      const meta = [
        `${job.width}×${job.height}`,
        `${job.fps}fps`,
        `sf: ${esc(job.soundfont)}`,
        `时长 ${fmtSeconds(job.durationSeconds)}`,
        job.renderSeconds != null ? `渲染 ${job.renderSeconds.toFixed(0)}s` : null,
        fmtTime(job.createdAt),
      ]
        .filter(Boolean)
        .map((t) => `<span>${t}</span>`)
        .join("");

      const actions = [
        job.videoUrl ? `<button class="btn" data-act="preview" data-id="${job.id}">预览</button>` : "",
        job.videoUrl ? `<button class="btn" data-act="download" data-id="${job.id}">下载</button>` : "",
        job.status !== "rendering" ? `<button class="btn btn-danger" data-act="delete" data-id="${job.id}">删除</button>` : "",
      ].join("");

      return `
        <article class="job-card">
          ${jobThumb(job, queuedAsc.indexOf(job) + 1)}
          <div class="card-body">
            <div class="row-title">
              <span class="dot ${status.dot}"></span>
              <span>${esc(job.title ?? "Untitled nocturne")}</span>
              <span class="id">${job.id.slice(0, 8)}</span>
            </div>
            <div class="row-meta">${meta}</div>
            <div class="row-actions">${actions}</div>
          </div>
        </article>`;
    })
    .join("");

  list.querySelectorAll("button[data-act]").forEach((btn) => {
    const job = jobs.find((j) => j.id === btn.dataset.id);
    if (!job) return;
    btn.addEventListener("click", () => {
      if (btn.dataset.act === "download") downloadJob(job);
      else if (btn.dataset.act === "preview") openPreview(job);
      else deleteJob(job);
    });
  });

  // 点击播放：overlay 消失 -> 视频流式加载，播过之后由原生控制条接管
  list.querySelectorAll(".thumb video").forEach((video) => {
    const overlay = video.parentElement.querySelector(".play-overlay");
    overlay.addEventListener("click", () => video.play());
    video.addEventListener("play", () => {
      overlay.classList.add("hidden");
      video.controls = true;
    });
  });
};

const refreshJobs = async () => {
  try {
    const data = await api("/api/v1/jobs");
    state.jobs = data.items;
    state.queueDepth = data.queueDepth;
    renderJobs();
  } catch (err) {
    handleError(err);
  }
};

/* --- soundfonts -------------------------------------------------------- */

const renderSoundfonts = () => {
  const list = $("#sf-list");
  const items = state.soundfonts;
  $("#nav-sf-count").textContent = items.length ? String(items.length) : "";

  const select = $("#job-soundfont");
  const current = select.value;
  select.innerHTML = items.map((sf) => `<option value="${esc(sf.name)}">${esc(sf.name)}${sf.builtin ? " (内置)" : ""}</option>`).join("");
  if (items.some((sf) => sf.name === current)) select.value = current;

  if (items.length === 0) {
    list.innerHTML = '<div class="empty">音色库为空</div>';
    return;
  }

  list.innerHTML = items
    .map(
      (sf) => `
        <div class="list-row">
          <span class="dot ${sf.builtin ? "dot-on" : ""}"></span>
          <div class="row-main">
            <div class="row-title">
              <span>${esc(sf.name)}</span>
              ${sf.builtin ? '<span class="tag">内置</span>' : ""}
            </div>
            <div class="row-meta">
              <span>${fmtBytes(sf.size)}</span>
              <span>sha256 ${sf.sha256.slice(0, 12)}</span>
              <span>${fmtTime(sf.createdAt)} 注册</span>
            </div>
          </div>
          <div class="row-actions">
            ${sf.builtin ? "" : `<button class="btn btn-danger" data-name="${esc(sf.name)}">删除</button>`}
          </div>
        </div>`,
    )
    .join("");

  list.querySelectorAll("button[data-name]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.name;
      if (!confirm(`删除音色 ${name}？`)) return;
      try {
        await api(`/api/v1/soundfonts/${encodeURIComponent(name)}`, { method: "DELETE" });
        toast(`音色 ${name} 已删除`);
        refreshSoundfonts();
      } catch (err) {
        handleError(err);
      }
    });
  });
};

const refreshSoundfonts = async () => {
  try {
    const data = await api("/api/v1/soundfonts");
    state.soundfonts = data.items;
    renderSoundfonts();
  } catch (err) {
    handleError(err);
  }
};

/* --- forms ------------------------------------------------------------- */

const initForms = () => {
  // 分辨率预设
  const preset = $("#job-preset");
  const width = $("#job-width");
  const height = $("#job-height");
  preset.addEventListener("change", () => {
    if (preset.value !== "custom") {
      const [w, h] = preset.value.split("x");
      width.value = w;
      height.value = h;
    }
  });
  const markCustom = () => {
    const match = `${width.value}x${height.value}`;
    if (![...preset.options].some((o) => o.value === match)) preset.value = "custom";
  };
  width.addEventListener("input", markCustom);
  height.addEventListener("input", markCustom);

  // 提交渲染任务
  $("#job-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("#job-file").files[0];
    const status = $("#job-form-status");
    status.classList.remove("error");
    if (!file) {
      status.textContent = "请选择 .mid 文件";
      status.classList.add("error");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    if ($("#job-title").value.trim()) fd.append("title", $("#job-title").value.trim());
    fd.append("fps", $("#job-fps").value);
    fd.append("width", width.value);
    fd.append("height", height.value);
    fd.append("soundfont", $("#job-soundfont").value || "default");

    const btn = $("#btn-submit");
    btn.disabled = true;
    status.textContent = "提交中…";
    try {
      const res = await api("/api/v1/jobs", { method: "POST", body: fd });
      status.textContent = `已提交 ${res.jobId.slice(0, 8)} · 时长 ${fmtSeconds(res.durationSeconds)}`;
      toast(`任务已提交（${res.durationSeconds.toFixed(1)}s）`);
      $("#job-form").reset();
      await refreshJobs();
      setTimeout(() => switchView("jobs"), 600);
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      status.classList.add("error");
    } finally {
      btn.disabled = false;
    }
  });

  // 上传音色
  $("#sf-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("#sf-file").files[0];
    const name = $("#sf-name").value.trim();
    const status = $("#sf-form-status");
    status.classList.remove("error");
    if (!file || !name) {
      status.textContent = "请填写名称并选择 .sf2 文件";
      status.classList.add("error");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", name);

    const btn = $("#btn-sf-upload");
    btn.disabled = true;
    status.textContent = `上传中… (${fmtBytes(file.size)})，大文件请耐心等待`;
    try {
      await api("/api/v1/soundfonts", { method: "POST", body: fd });
      status.textContent = "";
      toast(`音色 ${name} 已注册`);
      $("#sf-form").reset();
      refreshSoundfonts();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      status.classList.add("error");
    } finally {
      btn.disabled = false;
    }
  });
};

/* --- service status & polling ------------------------------------------ */

const checkHealth = async () => {
  const dot = $("#service-status .dot");
  const text = $("#service-text");
  try {
    const res = await fetch("/healthz");
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    dot.className = "dot dot-on";
    text.textContent = data.ok ? `online · queue ${data.queueDepth}` : "degraded";
  } catch {
    dot.className = "dot dot-off";
    text.textContent = "offline";
  }
};

const startPolling = () => {
  const tick = async () => {
    if (state.view === "jobs") await refreshJobs();
    const active = state.jobs.some((j) => j.status === "queued" || j.status === "rendering");
    setTimeout(tick, active ? 3000 : 15000);
  };
  setTimeout(tick, 15000);
};

/* --- init -------------------------------------------------------------- */

const init = () => {
  const keyInput = $("#api-key");
  keyInput.value = state.apiKey;
  keyInput.addEventListener("change", () => {
    state.apiKey = keyInput.value.trim();
    localStorage.setItem("mdg.apiKey", state.apiKey);
    refreshJobs();
    refreshSoundfonts();
  });

  $("#nav").addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item");
    if (btn) switchView(btn.dataset.view);
  });
  $("#btn-refresh-jobs").addEventListener("click", refreshJobs);
  $("#btn-refresh-sf").addEventListener("click", refreshSoundfonts);
  $("#preview-close").addEventListener("click", closePreview);
  $("#preview-modal").addEventListener("click", (e) => {
    if (e.target.id === "preview-modal") closePreview();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#preview-modal").classList.contains("hidden")) closePreview();
  });

  initForms();
  checkHealth();
  setInterval(checkHealth, 15000);
  refreshJobs();
  refreshSoundfonts();
  startPolling();
};

init();
