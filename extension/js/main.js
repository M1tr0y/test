/* Rust3D panel for After Effects / Premiere Pro (CEP with Node.js).
 *
 * Scan:   one AssetStudioModCLI "info" run per .bundle, several in parallel; the model
 *         index is cached per bundle (size + mtime), so a game update rescans only
 *         what changed and the list is usable while scanning.
 * Export: splitObjects -> FBX (fallback: mesh -> OBJ) -> FBX2glTF/Blender -> GLB,
 *         cached in the export folder so the second import of a model is instant.
 * Import: AE takes the GLB as a 3D layer; Premiere gets a Blender turntable video.
 */
(function () {
  "use strict";

  const node = window.cep_node || { require: window.require, process: window.process };
  const fs = node.require("fs");
  const path = node.require("path");
  const os = node.require("os");
  const cp = node.require("child_process");
  const env = node.process.env;

  const APP_DIR = path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Rust3D");
  const CONFIG = path.join(APP_DIR, "config.json");
  const INDEX = path.join(APP_DIR, "cache", "index.json");
  const LOG_FILE = path.join(APP_DIR, "rust3d.log");
  const INDEX_VERSION = 2;
  const SCAN_WORKERS = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));
  const LIST_LIMIT = 300;

  const HOST = JSON.parse(window.__adobe_cep__.getHostEnvironment()).appName;  // "AEFT" | "PPRO"
  const EXT_DIR = extensionDir();

  const DEFAULTS = {
    rustDir: "", blender: "", assetStudio: "", fbx2gltf: "",
    exportDir: path.join(os.homedir(), "Documents", "Rust3D"),
    width: 1920, height: 1080, fps: 30, turntableSeconds: 6,
  };
  let cfg = Object.assign({}, DEFAULTS, readJson(CONFIG, {}));
  let index = { version: INDEX_VERSION, bundles: {} };
  let models = [];
  let selected = null;
  let busy = false;
  let scanning = false;
  const logLines = [];

  // ================================================================ helpers

  function extensionDir() {
    let p = decodeURIComponent(window.__adobe_cep__.getSystemPath("extension"));
    p = p.replace(/^file:\/*/i, "");
    if (/^\/[a-z]:/i.test(p)) p = p.slice(1);
    return path.normalize(p);
  }

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (e) { return fallback; }
  }

  function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }

  function rmrf(p) {
    try { (fs.rmSync || fs.rmdirSync)(p, { recursive: true, force: true }); } catch (e) { /* already gone */ }
  }

  const exists = p => !!p && fs.existsSync(p);
  const safe = n => String(n).replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim() || "model";

  function log(line) {
    const text = new Date().toLocaleTimeString("ru") + "  " + line;
    logLines.push(text);
    if (logLines.length > 400) logLines.shift();
    try { fs.appendFileSync(LOG_FILE, text + "\n"); } catch (e) { /* log is best effort */ }
    if (drawerOpen()) renderLog();
  }

  function run(exe, args, label, onLine) {
    return new Promise((resolve, reject) => {
      args = args.map(String);
      log("> " + [exe].concat(args).map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
      const child = cp.spawn(exe, args, { windowsHide: true });
      const tail = [];
      const onData = chunk => String(chunk).split(/\r?\n/).forEach(l => {
        if (!l.trim()) return;
        log(l);
        tail.push(l);
        if (tail.length > 5) tail.shift();
        if (onLine) onLine(l);
      });
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", e => reject(new Error(`${label}: ${e.message}`)));
      child.on("close", code => (code === 0 ? resolve()
        : reject(new Error(`${label} завершился с ошибкой ${code}. ${tail.slice(-2).join(" | ")}`))));
    });
  }

  function findFiles(dir, ext) {
    const out = [];
    (function walk(d) {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.toLowerCase().endsWith(ext)) out.push(p);
      }
    })(dir);
    return out;
  }

  function evalHost(fn, args) {
    return new Promise((resolve, reject) => {
      const code = `${fn}(${args.map(a => JSON.stringify(a)).join(",")})`;
      window.__adobe_cep__.evalScript(code, res => {
        if (typeof res === "string" && res.indexOf("ok") === 0) resolve(res);
        else reject(new Error(res === "EvalScript error." ? "Ошибка скрипта Adobe" : String(res).replace(/^error:\s*/, "")));
      });
    });
  }

  // ================================================================ scan

  function bundlesRoot() {
    const b = path.join(cfg.rustDir, "Bundles");
    return exists(b) ? b : cfg.rustDir;
  }

  function parseAssetList(file) {
    if (!exists(file)) return [];
    const doc = new DOMParser().parseFromString(fs.readFileSync(file, "utf8"), "text/xml");
    const text = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? n.textContent : ""; };
    return Array.from(doc.getElementsByTagName("Asset"))
      .map(a => ({ name: text(a, "Name"), container: text(a, "Container"), pathId: text(a, "PathID") }))
      .filter(m => m.name);
  }

  function rebuildModels() {
    const list = [];
    for (const bundle of Object.keys(index.bundles)) {
      for (const m of index.bundles[bundle].models) {
        list.push({ name: m.name, container: m.container, pathId: m.pathId, bundle,
                    lname: m.name.toLowerCase(), lcont: (m.container || "").toLowerCase() });
      }
    }
    list.sort((a, b) => (a.lname < b.lname ? -1 : a.lname > b.lname ? 1 : 0));
    list.forEach((m, i) => (m.i = i));
    const keep = selected && list.find(m => m.bundle === selected.bundle && m.pathId === selected.pathId);
    models = list;
    selected = keep || null;
  }

  async function scan(force) {
    if (scanning) return;
    if (!exists(cfg.rustDir)) { showEmpty("rust"); openDrawer(); return; }
    const files = findFiles(bundlesRoot(), ".bundle");
    if (!files.length) { toast("В папке Rust нет файлов .bundle — проверь путь", true); openDrawer(); return; }

    if (force || index.version !== INDEX_VERSION) index = { version: INDEX_VERSION, bundles: {} };
    const todo = [];
    for (const f of files) {
      const st = fs.statSync(f);
      const stamp = st.size + ":" + Math.round(st.mtimeMs);
      if (!index.bundles[f] || index.bundles[f].stamp !== stamp) todo.push({ file: f, stamp, size: st.size });
    }
    for (const k of Object.keys(index.bundles)) if (!files.includes(k)) delete index.bundles[k];
    scanning = todo.length > 0;
    const total = todo.length;
    if (scanning) scanProgress(0, total);
    rebuildModels();
    render(true);
    if (!scanning) return;

    todo.sort((a, b) => b.size - a.size);  // big bundles first keeps all workers busy
    let done = 0;
    const tmpRoot = path.join(APP_DIR, "cache", "scan");

    const worker = async () => {
      while (todo.length) {
        const job = todo.shift();
        const out = path.join(tmpRoot, Math.random().toString(36).slice(2));
        fs.mkdirSync(out, { recursive: true });
        try {
          await run(cfg.assetStudio, [job.file, "-m", "info", "-t", "mesh", "--export-asset-list", "xml",
                                      "-o", out, "--log-level", "warning"], "AssetStudio");
          index.bundles[job.file] = { stamp: job.stamp, models: parseAssetList(path.join(out, "assets.xml")) };
          writeJson(INDEX, index);
        } catch (e) {
          log("! " + path.basename(job.file) + ": " + e.message);  // retried on the next scan
        }
        rmrf(out);
        scanProgress(++done, total, path.basename(job.file));
        rebuildModels();
        render(false);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_WORKERS, total) }, worker));
    scanning = false;
    scanProgress(total, total);
    render(false);
    toast(`Список готов: ${models.length.toLocaleString("ru")} моделей`);
  }

  // ================================================================ export + import

  function glbPath(m) {
    const dir = path.join(cfg.exportDir, `${safe(m.name)}_${String(m.pathId).replace("-", "n")}`);
    return path.join(dir, safe(m.name) + ".glb");
  }

  function hasBlender() { return exists(cfg.blender); }

  async function exportGlb(m, step) {
    const glb = glbPath(m);
    if (exists(glb)) return glb;
    const raw = path.join(path.dirname(glb), "raw");
    rmrf(raw);
    fs.mkdirSync(raw, { recursive: true });

    step("Достаю модель из игры…", 12);
    await run(cfg.assetStudio, [m.bundle, "-m", "splitObjects", "--filter-by-name", m.name, "-o", raw], "AssetStudio");
    // GameObject names contain the mesh name: prefer an exact match, else the biggest (most complete) one.
    const fbx = findFiles(raw, ".fbx")
      .map(p => ({ p, exact: path.basename(p, ".fbx").toLowerCase() === m.lname, size: fs.statSync(p).size }))
      .sort((a, b) => (b.exact - a.exact) || (b.size - a.size));
    let src = fbx.length ? fbx[0].p : null;
    if (!src) {
      step("Объект не найден, достаю сетку…", 30);
      await run(cfg.assetStudio, [m.bundle, "-m", "export", "-t", "mesh", "--filter-by-pathid", m.pathId,
                                  "-g", "none", "-o", raw], "AssetStudio");
      src = findFiles(raw, ".obj")[0];
    }
    if (!src) throw new Error("AssetStudio ничего не выгрузил для этой модели");

    step("Конвертирую в GLB…", 50);
    if (/\.fbx$/i.test(src) && exists(cfg.fbx2gltf)) {
      try {
        await run(cfg.fbx2gltf, ["--binary", "--input", src, "--output", glb.replace(/\.glb$/i, "")], "FBX2glTF");
      } catch (e) { log("FBX2glTF не справился, пробую Blender"); }
    }
    if (!exists(glb)) {
      if (!hasBlender()) throw new Error("Для этой модели нужен Blender — укажи его в настройках");
      await run(cfg.blender, ["-b", "--factory-startup", "-P", path.join(EXT_DIR, "blender", "convert.py"), "--", src, glb], "Blender");
    }
    if (!exists(glb)) throw new Error("Не получилось собрать GLB");
    return glb;
  }

  async function turntable(glb, step) {
    const mov = glb.replace(/\.glb$/i, "_turntable.mov");
    if (exists(mov)) return mov;
    if (!hasBlender()) throw new Error("Для Premiere нужен Blender — укажи его в настройках (шестерёнка сверху)");
    const frames = cfg.fps * cfg.turntableSeconds;
    step("Рендерю вращение…", 60);
    await run(cfg.blender, ["-b", "--factory-startup", "-P", path.join(EXT_DIR, "blender", "turntable.py"), "--",
                            glb, mov, cfg.width, cfg.height, cfg.fps, cfg.turntableSeconds], "Blender", line => {
      const f = /(?:Fra:|Append frame )(\d+)/.exec(line);
      if (f) step(`Рендерю вращение: кадр ${f[1]} из ${frames}`, 60 + 32 * Math.min(1, f[1] / frames));
    });
    if (!exists(mov)) throw new Error("Blender не создал видео");
    return mov;
  }

  async function sendSelected() {
    const m = selected;
    if (!m || busy) return;
    busy = true;
    const step = (text, pct) => goProgress(text, pct);
    step("Запускаю…", 4);
    try {
      const glb = await exportGlb(m, step);
      if (HOST === "AEFT") {
        step("Добавляю в композицию…", 92);
        await evalHost("rust3dImportAE", [glb, cfg.width, cfg.height, cfg.fps]);
        goDone(`«${m.name}» в композиции`);
      } else {
        const mov = await turntable(glb, step);
        step("Кладу на таймлайн…", 96);
        const res = await evalHost("rust3dImportPPRO", [mov, cfg.turntableSeconds]);
        goDone(res === "ok:timeline" ? `«${m.name}» на таймлайне` : `«${m.name}» в папке Rust3D проекта`);
      }
    } catch (e) {
      log("! " + e.message);
      goFail(e.message);
    }
    busy = false;
    render(false);
  }

  // ================================================================ UI

  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const goLabel = HOST === "AEFT" ? "В композицию" : "На таймлайн";

  function highlight(text, q) {
    const i = q ? text.toLowerCase().indexOf(q) : -1;
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }

  function filtered() {
    const q = $("#q").value.trim().toLowerCase();
    return { q, hits: q ? models.filter(m => m.lname.includes(q) || m.lcont.includes(q)) : models };
  }

  function render(animate) {
    const { q, hits } = filtered();
    const list = $("#list");
    $("#count").textContent = models.length ? hits.length.toLocaleString("ru") : "";
    if (!models.length) {
      list.classList.add("hidden");
      showEmpty(scanning ? "scanning" : "none");
    } else {
      $("#empty").classList.add("hidden");
      list.classList.remove("hidden");
      list.classList.toggle("quiet", !animate);
      const scroll = list.scrollTop;
      list.innerHTML = hits.slice(0, LIST_LIMIT).map((m, n) =>
        `<div class="item${m === selected ? " sel" : ""}" data-i="${m.i}" style="animation-delay:${Math.min(n, 16) * 14}ms">
           <span class="ico">3D</span>
           <span class="t"><b>${highlight(m.name, q)}</b><small>${esc(m.container || path.basename(m.bundle))}</small></span>
           ${exists(glbPath(m)) ? '<span class="ready" title="Уже выгружена — вставится мгновенно">✓</span>' : ""}
         </div>`).join("") +
        (hits.length > LIST_LIMIT ? `<div class="more">Показано ${LIST_LIMIT} из ${hits.length.toLocaleString("ru")} — уточни поиск</div>` : "");
      if (!animate) list.scrollTop = scroll;
    }
    $("#selName").textContent = selected ? selected.name : "не выбрана";
    if (!busy) $("#go").disabled = !selected;
  }

  function select(m) {
    selected = m;
    document.querySelectorAll(".item.sel").forEach(el => el.classList.remove("sel"));
    const el = document.querySelector(`.item[data-i="${m.i}"]`);
    if (el) { el.classList.add("sel"); el.scrollIntoView({ block: "nearest" }); }
    $("#selName").textContent = m.name;
    if (!busy) $("#go").disabled = false;
  }

  const EMPTY = {
    setup: ["Нужна установка", "Запусти install.bat из папки Rust3D — он скачает AssetStudio и конвертер."],
    rust: ["Укажи папку Rust", "Открой настройки (шестерёнка) и выбери папку с игрой из Steam."],
    scanning: ["Читаю файлы игры", "Модели появятся здесь по мере чтения. Это нужно только один раз."],
    none: ["Моделей пока нет", "Нажми «Перечитать игру» в настройках."],
  };

  function showEmpty(kind) {
    $("#list").classList.add("hidden");
    $("#empty").classList.remove("hidden");
    $("#emptyTitle").textContent = EMPTY[kind][0];
    $("#emptyText").textContent = EMPTY[kind][1];
  }

  function scanProgress(done, total, name) {
    const bar = $("#scanbar");
    bar.classList.toggle("off", done >= total);
    bar.querySelector(".fill").style.width = Math.max(4, (done / total) * 100) + "%";
    bar.querySelector("span").textContent = done >= total ? "Готово"
      : `Читаю игру: ${done} из ${total}` + (name ? ` · ${name}` : "");
  }

  function goProgress(text, pct) {
    const go = $("#go");
    go.classList.remove("success");
    go.classList.add("working");
    go.querySelector(".fill").style.width = pct + "%";
    $("#goLabel").textContent = text;
  }

  function goReset(delay) {
    setTimeout(() => {
      const go = $("#go");
      go.classList.remove("working", "success");
      go.querySelector(".fill").style.width = "0";
      $("#goLabel").textContent = goLabel;
      go.disabled = !selected;
    }, delay);
  }

  function goDone(text) {
    const go = $("#go");
    go.querySelector(".fill").style.width = "100%";
    go.classList.remove("working");
    go.classList.add("success");
    $("#goLabel").textContent = "✓ Готово";
    toast(text);
    goReset(1400);
  }

  function goFail(text) {
    toast(text, true);
    goReset(0);
  }

  function toast(text, err) {
    const t = document.createElement("div");
    t.className = "toast" + (err ? " err" : "");
    t.textContent = text;
    $("#toasts").appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 350); }, err ? 7000 : 3500);
  }

  // ---------------------------------------------------------------- settings drawer

  const drawerOpen = () => $("#drawer").classList.contains("open");

  function renderLog() {
    const pre = $("#log");
    pre.textContent = logLines.join("\n");
    pre.scrollTop = pre.scrollHeight;
  }

  function renderFields() {
    document.querySelectorAll(".field").forEach(f => {
      const v = cfg[f.dataset.key];
      const val = f.querySelector(".val");
      val.textContent = v || "не указано";
      val.title = v || "";
      val.classList.toggle("missing", !exists(v));
    });
  }

  function openDrawer() { renderFields(); renderLog(); $("#drawer").classList.add("open"); }
  function closeDrawer() { $("#drawer").classList.remove("open"); }

  function pick(field) {
    const key = field.dataset.key, dir = !!field.dataset.dir;
    const res = window.cep.fs.showOpenDialog(false, dir, field.dataset.title, cfg[key] || "", dir ? undefined : ["exe"]);
    const picked = res && res.data && res.data[0];
    if (!picked) return;
    cfg[key] = path.normalize(picked);
    writeJson(CONFIG, cfg);
    renderFields();
    if (key === "rustDir") scan(true);
    if (key === "exportDir") render(false);
  }

  // ---------------------------------------------------------------- wiring

  function init() {
    $("#host").textContent = HOST === "AEFT" ? "AE" : "PR";
    $("#host").classList.add(HOST);
    $("#goLabel").textContent = goLabel;

    let timer;
    $("#q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => render(true), 120); });
    $("#q").addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      if (selected) sendSelected();
      else { const first = filtered().hits[0]; if (first) select(first); }
    });
    $("#list").addEventListener("click", e => {
      const el = e.target.closest(".item");
      if (el) select(models[+el.dataset.i]);
    });
    $("#list").addEventListener("dblclick", e => { if (e.target.closest(".item")) sendSelected(); });
    $("#go").addEventListener("click", sendSelected);
    $("#gear").addEventListener("click", openDrawer);
    $("#closeSettings").addEventListener("click", closeDrawer);
    $("#drawer").addEventListener("click", e => { if (e.target.id === "drawer") closeDrawer(); });
    document.querySelectorAll(".field button").forEach(b => b.addEventListener("click", () => pick(b.closest(".field"))));
    $("#rescan").addEventListener("click", () => { closeDrawer(); scan(true); });
    $("#openFolder").addEventListener("click", () => {
      fs.mkdirSync(cfg.exportDir, { recursive: true });
      cp.spawn("explorer", [cfg.exportDir], { detached: true });
    });

    if (!exists(cfg.assetStudio)) { showEmpty("setup"); return; }
    index = readJson(INDEX, index);
    if (index.version !== INDEX_VERSION || !index.bundles) index = { version: INDEX_VERSION, bundles: {} };
    rebuildModels();
    render(true);
    scan(false);
  }

  init();
})();
