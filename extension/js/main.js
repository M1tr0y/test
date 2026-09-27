/* Rust3D panel for After Effects / Premiere Pro (CEP with Node.js).
 *
 * Scan:    one AssetStudioModCLI "info" run per .bundle, several in parallel; the model
 *          index is cached per bundle (size + mtime). Meshes are grouped by name without
 *          the _LODn suffix and only the best LOD is listed, named after its game folder.
 * Preview: stage 1 exports just the mesh (fast, loads only meshes) and shows it as clay;
 *          stage 2 exports the textured object and swaps it in. Selecting another model
 *          kills the running preview export.
 * Export:  splitObjects (exact LOD object) -> FBX2glTF/Blender -> GLB, cached on disk.
 * Import:  AE takes the GLB as a 3D layer; Premiere gets a Blender turntable video.
 */
(function () {
  "use strict";

  const node = window.cep_node || { require: window.require, process: window.process };
  const fs = node.require("fs");
  const path = node.require("path");
  const os = node.require("os");
  const cp = node.require("child_process");
  const { Buffer } = node.require("buffer");
  const env = node.process.env;

  const APP_DIR = path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Rust3D");
  const CONFIG = path.join(APP_DIR, "config.json");
  const INDEX = path.join(APP_DIR, "cache", "index.json");
  const LOG_FILE = path.join(APP_DIR, "rust3d.log");
  const INDEX_VERSION = 3;  // 2 cached empty lists because of the assets.xml BOM
  const SCAN_WORKERS = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));
  const LIST_LIMIT = 300;
  const LOD_RE = /[_\s.-]*lod[_\s]?(\d+)$/i;
  const CANCELLED = new Error("cancelled");

  // Folders in container paths that say nothing about what the model is.
  const NOISE_DIRS = new Set(["assets", "content", "prefabs", "prefab", "bundled", "models", "model", "meshes", "mesh",
    "fbx", "lod", "lods", "gibs", "gib", "source", "sources", "art", "resources", "common", "shared", "new"]);
  const CATEGORIES = {
    weapons: "Оружие", weapon: "Оружие", guns: "Оружие", ammo: "Патроны", attachments: "Модули оружия",
    tools: "Инструменты", tool: "Инструменты", clothing: "Одежда", attire: "Одежда", wearable: "Одежда",
    vehicles: "Техника", vehicle: "Техника", boats: "Техника", npc: "NPC", animals: "Животные",
    player: "Игрок", deployable: "Размещаемое", deployables: "Размещаемое", building: "Строительство",
    "building core": "Строительство", items: "Предметы", food: "Еда", misc: "Разное", nature: "Природа",
    environment: "Окружение", monument: "Памятники", monuments: "Памятники", props: "Декор", prop: "Декор",
    resource: "Ресурсы", resources: "Ресурсы", ores: "Ресурсы", trees: "Деревья", rocks: "Камни и скалы",
    effects: "Эффекты", fx: "Эффекты", ui: "Интерфейс", xmas: "Новый год", halloween: "Хэллоуин",
    electric: "Электрика", electrical: "Электрика", io: "Электрика", instruments: "Музыка",
  };
  // Debris, collision and helper meshes: hidden unless "show helper meshes" is on.
  const JUNK_RE = /(^|[_\s.-])(gibs?|collider|col|coll|collision|shadow|occluder|lodgroup|dummy|placeholder)([_\s.\d-]|$)/i;

  const HOST = JSON.parse(window.__adobe_cep__.getHostEnvironment()).appName;  // "AEFT" | "PPRO"
  const EXT_DIR = extensionDir();

  const DEFAULTS = {
    rustDir: "", blender: "", assetStudio: "", fbx2gltf: "", installDir: "",
    exportDir: path.join(os.homedir(), "Documents", "Rust3D"),
    width: 1920, height: 1080, fps: 30, turntableSeconds: 6, showJunk: false,
  };
  let cfg = Object.assign({}, DEFAULTS, readJson(CONFIG, {}));
  let index = { version: INDEX_VERSION, bundles: {} };
  let models = [];        // rebuilt after every scanned bundle, so compare models by idOf(), not identity
  let selected = null;
  let previewFor = null;  // idOf() of the model the preview should show
  let busy = false;
  let scanning = false;
  const logLines = [];
  const idOf = m => m.bundle + "|" + m.pathId;

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
  const fileUrl = p => "file:///" + encodeURI(p.replace(/\\/g, "/")).replace(/#/g, "%23");
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function log(line) {
    const text = new Date().toLocaleTimeString("ru") + "  " + line;
    logLines.push(text);
    if (logLines.length > 400) logLines.shift();
    try { fs.appendFileSync(LOG_FILE, text + "\n"); } catch (e) { /* log is best effort */ }
    if (drawerOpen()) renderLog();
  }

  // holder (optional) receives the child process so a stale preview export can be killed.
  function run(exe, args, label, onLine, holder) {
    return new Promise((resolve, reject) => {
      args = args.map(String);
      log("> " + [exe].concat(args).map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
      const child = cp.spawn(exe, args, { windowsHide: true });
      if (holder) holder.child = child;
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
      child.on("close", code => {
        if (holder && holder.child === child) holder.child = null;
        if (code === 0) resolve();
        else reject(new Error(`${label} завершился с ошибкой ${code}. ${tail.slice(-2).join(" | ")}`));
      });
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

  // ================================================================ names

  // "ch47" -> "CH47", "hazmat_suit" -> "Hazmat Suit".
  function prettify(s) {
    return s.replace(/[_-]+/g, " ").trim().split(/\s+/).map(w =>
      /\d/.test(w) && /[a-z]/i.test(w) && w.length <= 6 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
    ).join(" ");
  }

  // Readable name, category and junk flag from the container path, e.g.
  // assets/prefabs/npc/ch47/model/gibs/x.fbx -> label "CH47", category "NPC", junk (gibs).
  function describe(m) {
    const parts = (m.container || "").toLowerCase().split("/").filter(Boolean);
    const dirs = parts.slice(0, -1).filter(p => !NOISE_DIRS.has(p));
    const object = dirs.length ? dirs[dirs.length - 1] : "";
    const catKey = dirs.find(d => CATEGORIES[d]);
    m.label = object ? prettify(object) : prettify(m.base);
    m.category = catKey ? CATEGORIES[catKey] : (dirs[0] ? prettify(dirs[0]) : "");
    m.junk = JUNK_RE.test(m.base) || parts.includes("gibs") || parts.includes("colliders");
    m.sameName = m.label.toLowerCase().replace(/\s+/g, "") === m.base.toLowerCase().replace(/[_\s-]+/g, "");
    m.search = [m.label, m.base, m.category, m.container || ""].join(" ").toLowerCase();
  }

  // ================================================================ scan

  function bundlesRoot() {
    const b = path.join(cfg.rustDir, "Bundles");
    return exists(b) ? b : cfg.rustDir;
  }

  function parseAssetList(file) {
    if (!exists(file)) return [];
    // XDocument.Save writes a UTF-8 BOM, which DOMParser rejects as "content before the XML declaration".
    const xml = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("не удалось прочитать assets.xml");
    const text = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? n.textContent : ""; };
    return Array.from(doc.getElementsByTagName("Asset"))
      .map(a => ({ name: text(a, "Name"), container: text(a, "Container"), pathId: text(a, "PathID") }))
      .filter(m => m.name);
  }

  // One entry per model: "X_LOD0", "X_LOD1", "X_LOD2" -> just "X" backed by the best LOD.
  function rebuildModels() {
    const best = new Map();
    for (const bundle of Object.keys(index.bundles)) {
      for (const m of index.bundles[bundle].models) {
        const lod = LOD_RE.exec(m.name);
        const base = lod ? m.name.slice(0, lod.index) : m.name;
        const level = lod ? +lod[1] : 0;
        const key = bundle + "|" + base.toLowerCase() + "|" + (m.container || "").toLowerCase();
        const prev = best.get(key);
        if (prev && prev.level <= level) continue;
        best.set(key, { name: m.name, base: base || m.name, level, container: m.container, pathId: m.pathId, bundle });
      }
    }
    const list = [];
    for (const m of best.values()) {
      m.title = m.base;
      m.lname = m.name.toLowerCase();
      describe(m);
      if (cfg.showJunk || !m.junk) list.push(m);
    }
    list.sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" })
                     || a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
    list.forEach((m, i) => (m.i = i));
    const keep = selected && list.find(m => idOf(m) === idOf(selected));
    models = list;
    if (keep) selected = keep;
    else if (selected) { selected = null; hidePreview(); }
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
          const found = parseAssetList(path.join(out, "assets.xml"));
          index.bundles[job.file] = { stamp: job.stamp, models: found };
          writeJson(INDEX, index);
          log(`${path.basename(job.file)}: ${found.length} сеток`);
        } catch (e) {
          log("! " + path.basename(job.file) + ": " + e.message);  // not cached, retried on the next scan
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

  // ================================================================ export

  function modelDir(m) { return path.join(cfg.exportDir, `${safe(m.name)}_${String(m.pathId).replace("-", "n")}`); }
  function glbPath(m) { return path.join(modelDir(m), safe(m.title) + ".glb"); }
  function thumbPath(m) { return path.join(modelDir(m), "thumb.png"); }
  function hasBlender() { return exists(cfg.blender); }

  // Stage 1: only the mesh, by PathID. AssetStudio loads just meshes, so this is the fast one.
  async function exportQuick(m, holder) {
    const dir = path.join(modelDir(m), "quick");
    let obj = findFiles(dir, ".obj")[0];
    if (obj) return obj;
    rmrf(dir);
    fs.mkdirSync(dir, { recursive: true });
    await run(cfg.assetStudio, [m.bundle, "-m", "export", "-t", "mesh", "--filter-by-pathid", m.pathId,
                                "-g", "none", "-o", dir], "AssetStudio", null, holder);
    obj = findFiles(dir, ".obj")[0];
    if (!obj) throw new Error("AssetStudio не выгрузил сетку");
    return obj;
  }

  // Stage 2: the textured object. Targets the exact LOD object; the base name (the whole
  // prefab) is only a fallback because it would carry every LOD on top of each other.
  async function exportGlb(m, step, holder) {
    const glb = glbPath(m);
    if (exists(glb)) return glb;
    const raw = path.join(modelDir(m), "raw");
    rmrf(raw);
    fs.mkdirSync(raw, { recursive: true });

    step("Достаю модель с текстурами…", 12);
    const names = m.base !== m.name ? `^(?:${escapeRe(m.name)}|${escapeRe(m.base)})$` : `^${escapeRe(m.name)}$`;
    await run(cfg.assetStudio, [m.bundle, "-m", "splitObjects", "--filter-by-name", names, "--filter-with-regex",
                                "-o", raw], "AssetStudio", null, holder);
    const rank = p => {
      const stem = path.basename(p, ".fbx").toLowerCase();
      return stem === m.lname ? 2 : stem === m.base.toLowerCase() ? 1 : 0;
    };
    const fbx = findFiles(raw, ".fbx")
      .map(p => ({ p, rank: rank(p), size: fs.statSync(p).size }))
      .sort((a, b) => (b.rank - a.rank) || (b.size - a.size));
    let src = fbx.length ? fbx[0].p : null;
    if (!src) {
      log("Объект с текстурами не найден — беру сетку без текстур");
      src = await exportQuick(m, holder);
    }

    step("Конвертирую с текстурами…", 50);
    if (/\.fbx$/i.test(src) && exists(cfg.fbx2gltf)) {
      try {
        await run(cfg.fbx2gltf, ["--binary", "--input", src, "--output", glb.replace(/\.glb$/i, "")], "FBX2glTF", null, holder);
      } catch (e) { log("FBX2glTF не справился, пробую Blender"); }
    }
    if (!exists(glb)) {
      if (!hasBlender()) throw new Error("Для этой модели нужен Blender — укажи его в настройках");
      await run(cfg.blender, ["-b", "--factory-startup", "-P", path.join(EXT_DIR, "blender", "convert.py"), "--", src, glb],
                "Blender", null, holder);
    }
    if (!exists(glb)) throw new Error("Не получилось собрать GLB");
    return glb;
  }

  // One export at a time (each one loads a whole game bundle); callers share an in-flight job.
  let exportChain = Promise.resolve();
  let currentJob = null;
  const inflight = new Map();

  function enqueue(key, id, fn, wanted, preview) {
    const running = inflight.get(key);
    if (running) {
      if (!preview) running.holder.preview = false;  // someone needs the result: never kill it
      return running.promise;
    }
    const holder = { id, preview, child: null };
    const job = () => {
      if (wanted && !wanted()) throw CANCELLED;
      currentJob = holder;
      return fn(holder);
    };
    const p = exportChain.then(job, job);
    exportChain = p.catch(() => {});
    const promise = p.finally(() => {
      inflight.delete(key);
      if (currentJob === holder) currentJob = null;
    });
    inflight.set(key, { promise, holder });
    return promise;
  }

  function getQuick(m, wanted) {
    const cached = findFiles(path.join(modelDir(m), "quick"), ".obj")[0];
    if (cached) return Promise.resolve(cached);
    return enqueue("q|" + idOf(m), idOf(m), h => exportQuick(m, h), wanted, true);
  }

  function getGlb(m, step, wanted, preview) {
    if (exists(glbPath(m))) return Promise.resolve(glbPath(m));
    return enqueue("g|" + idOf(m), idOf(m), h => exportGlb(m, step, h), wanted, !!preview);
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
    step(exists(glbPath(m)) ? "Запускаю…" : "Готовлю модель с текстурами…", 8);
    try {
      const glb = await getGlb(m, step, null, false);
      if (HOST === "AEFT") {
        step("Добавляю в композицию…", 92);
        await evalHost("rust3dImportAE", [glb, cfg.width, cfg.height, cfg.fps]);
        goDone(`«${m.label}» в композиции`);
      } else {
        const mov = await turntable(glb, step);
        step("Кладу на таймлайн…", 96);
        const res = await evalHost("rust3dImportPPRO", [mov, cfg.turntableSeconds]);
        goDone(res === "ok:timeline" ? `«${m.label}» на таймлайне` : `«${m.label}» в папке Rust3D проекта`);
      }
    } catch (e) {
      log("! " + e.message);
      goFail(e.message);
    }
    busy = false;
    render(false);
  }

  // ================================================================ 3D preview

  let viewer = null;
  let previewTimer = null;

  function loadThree() {
    if (!loadThree.p) {
      loadThree.p = Promise.all([
        import("three"),
        import("three/addons/loaders/GLTFLoader.js"),
        import("three/addons/loaders/OBJLoader.js"),
        import("three/addons/controls/OrbitControls.js"),
      ]).catch(e => { loadThree.p = null; throw e; });
    }
    return loadThree.p;
  }

  async function ensureViewer() {
    if (viewer) return viewer;
    const [THREE, { GLTFLoader }, { OBJLoader }, { OrbitControls }] = await loadThree();
    const canvas = $("#view");
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xfff4e6, 0x2a1d16, 1.8));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(3, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xe8703f, 1.4);
    rim.position.set(-4, 2, -3);
    scene.add(rim);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 2.4;
    canvas.addEventListener("pointerdown", () => (controls.autoRotate = false));
    const clay = new THREE.MeshStandardMaterial({ color: 0xb8ada0, roughness: 0.85, metalness: 0.05 });
    viewer = { THREE, gltf: new GLTFLoader(), obj: new OBJLoader(), clay, renderer, scene, camera, controls, model: null, shownId: null };

    const resize = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(canvas);
    resize();
    (function loop() {
      requestAnimationFrame(loop);
      if ($("#stage").classList.contains("hidden")) return;
      controls.update();
      renderer.render(scene, camera);
    })();
    return viewer;
  }

  function disposeModel(v, obj) {
    obj.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      [].concat(o.material || []).forEach(mat => {
        if (mat === v.clay) return;
        for (const k in mat) if (mat[k] && mat[k].isTexture) mat[k].dispose();
        mat.dispose();
      });
    });
  }

  // Puts obj on stage, framed; keeps the camera when only swapping clay for the textured version.
  function presentModel(v, obj, id) {
    if (v.model) { v.scene.remove(v.model); disposeModel(v, v.model); }
    const box = new v.THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new v.THREE.Vector3());
    const radius = Math.max(box.getSize(new v.THREE.Vector3()).length() / 2, 1e-3);
    obj.position.sub(center);
    v.scene.add(obj);
    v.model = obj;
    if (v.shownId === id) return;
    v.shownId = id;
    const fov = (v.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(Math.min(fov, fov * v.camera.aspect) / 2)) * 1.05;
    v.camera.position.set(0.62, 0.38, 0.69).normalize().multiplyScalar(dist);
    v.camera.near = dist / 100;
    v.camera.far = dist * 100;
    v.camera.updateProjectionMatrix();
    v.controls.target.set(0, 0, 0);
    v.controls.autoRotate = true;
    v.controls.update();
  }

  async function showClay(objFile, id) {
    const v = await ensureViewer();
    const obj = v.obj.parse(fs.readFileSync(objFile, "utf8"));
    if (previewFor !== id) return false;
    obj.traverse(o => { if (o.isMesh) { o.material = v.clay; o.geometry.computeVertexNormals(); } });
    presentModel(v, obj, id);
    return true;
  }

  async function showTextured(glb, id) {
    const v = await ensureViewer();
    const buf = fs.readFileSync(glb);
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const gltf = await new Promise((res, rej) => v.gltf.parse(data, "", res, rej));
    if (previewFor !== id) { disposeModel(v, gltf.scene); return false; }
    presentModel(v, gltf.scene, id);
    return true;
  }

  function saveThumb(id, overwrite) {
    const m = selected;
    if (!m || previewFor !== id || idOf(m) !== id || (!overwrite && exists(thumbPath(m)))) return;
    const src = $("#view");
    const size = 96, s = Math.min(src.width, src.height);
    if (!s) return;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    c.getContext("2d").drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, size, size);
    fs.writeFileSync(thumbPath(m), Buffer.from(c.toDataURL("image/png").split(",")[1], "base64"));
    const ico = document.querySelector(`.item[data-i="${m.i}"] .ico`);
    if (ico) ico.innerHTML = `<img src="${fileUrl(thumbPath(m))}?${Date.now()}">`;
  }

  function stageState(kind, text) {
    const overlay = $("#stageOverlay");
    overlay.classList.toggle("off", kind === "ready");
    overlay.classList.toggle("err", kind === "error");
    if (text) $("#stageText").textContent = text;
  }

  function stageBadge(text, err) {
    const b = $("#stageBadge");
    b.classList.toggle("off", !text);
    b.classList.toggle("err", !!err);
    if (text) $("#stageBadgeText").textContent = text;
  }

  function hidePreview() {
    previewFor = null;
    $("#stage").classList.add("hidden");
  }

  function schedulePreview(m) {
    const id = idOf(m);
    previewFor = id;
    // A preview export for another model is useless now: stop it so this one starts right away.
    if (currentJob && currentJob.preview && currentJob.id !== id && currentJob.child) {
      try { currentJob.child.kill(); } catch (e) { /* already exited */ }
    }
    $("#stage").classList.remove("hidden");
    stageBadge(null);
    stageState("loading", exists(glbPath(m)) ? "Загружаю…" : "Достаю форму модели…");
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => runPreview(m, id), 200);
  }

  async function runPreview(m, id) {
    const wanted = () => previewFor === id;
    if (!wanted()) return;
    let clayShown = false;
    try {
      if (!exists(glbPath(m))) {
        const objFile = await getQuick(m, wanted);
        if (!wanted()) return;
        clayShown = await showClay(objFile, id);
        if (!clayShown) return;
        stageState("ready");
        stageBadge("Загружаю текстуры…");
        setTimeout(() => saveThumb(id, false), 350);
      }
      const glb = await getGlb(m, text => { if (wanted()) stageBadge(text); }, wanted, true);
      if (!wanted()) return;
      if (!(await showTextured(glb, id))) return;
      stageState("ready");
      stageBadge(null);
      setTimeout(() => saveThumb(id, true), 350);
      const row = document.querySelector(`.item[data-i="${m.i}"]`);
      if (row && !row.querySelector(".ready")) row.insertAdjacentHTML("beforeend", '<span class="ready">✓</span>');
    } catch (e) {
      if (e === CANCELLED || !wanted()) return;
      const offline = /fetch|import|module/i.test(e.message);
      const text = offline ? "Для предпросмотра нужен интернет (загрузка 3D-движка)" : e.message;
      if (clayShown) stageBadge("Текстуры не загрузились", true);
      else stageState("error", text);
      log("! предпросмотр: " + e.message);
    }
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
    return { q, hits: q ? models.filter(m => m.search.includes(q)) : models };
  }

  function icon(m) {
    return exists(thumbPath(m)) ? `<img src="${fileUrl(thumbPath(m))}">` : "3D";
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
        `<div class="item${m === selected ? " sel" : ""}" data-i="${m.i}" title="${esc(m.container || m.name)}" style="animation-delay:${Math.min(n, 16) * 14}ms">
           <span class="ico">${icon(m)}</span>
           <span class="t">
             <b>${highlight(m.label, q)}${m.sameName ? "" : ` <em>${highlight(m.title, q)}</em>`}</b>
             <small>${m.category ? `<i class="cat">${esc(m.category)}</i>` : ""}${m.junk ? '<i class="cat junk">служебная</i>' : ""}${esc(m.container || path.basename(m.bundle))}</small>
           </span>
           ${exists(glbPath(m)) ? '<span class="ready" title="Уже выгружена — вставится мгновенно">✓</span>' : ""}
         </div>`).join("") +
        (hits.length > LIST_LIMIT ? `<div class="more">Показано ${LIST_LIMIT} из ${hits.length.toLocaleString("ru")} — уточни поиск</div>` : "");
      if (!animate) list.scrollTop = scroll;
    }
    $("#selName").textContent = selected ? selName(selected) : "не выбрана";
    if (!busy) $("#go").disabled = !selected;
  }

  const selName = m => (m.sameName ? m.label : `${m.label} · ${m.title}`);

  function select(m) {
    if (!m) return;
    selected = m;
    document.querySelectorAll(".item.sel").forEach(el => el.classList.remove("sel"));
    const el = document.querySelector(`.item[data-i="${m.i}"]`);
    if (el) { el.classList.add("sel"); el.scrollIntoView({ block: "nearest" }); }
    $("#selName").textContent = selName(m);
    if (!busy) $("#go").disabled = false;
    if (previewFor !== idOf(m)) schedulePreview(m);
  }

  const EMPTY = {
    setup: ["Нужна установка", "Запусти install.bat из папки Rust3D — он скачает AssetStudio и конвертер."],
    rust: ["Укажи папку Rust", "Открой настройки (шестерёнка) и выбери папку с игрой из Steam."],
    scanning: ["Читаю файлы игры", "Модели появятся здесь по мере чтения. Это нужно только один раз."],
    none: ["Моделей не нашлось", "Открой настройки → «Перечитать игру». Если снова пусто — пришли журнал оттуда же."],
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
    $("#showJunk").checked = !!cfg.showJunk;
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

  function startUpdate() {
    const ps1 = cfg.installDir && path.join(cfg.installDir, "installer", "install.ps1");
    if (!exists(ps1)) { toast("Запусти update.bat из папки Rust3D", true); return; }
    cp.spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-File", ps1, "-Update"],
             { detached: true, windowsHide: true }).unref();
    toast("Открываю обновление… После него закрой и снова открой панель.");
  }

  // ---------------------------------------------------------------- wiring

  function init() {
    $("#host").textContent = HOST === "AEFT" ? "AE" : "PR";
    $("#host").classList.add(HOST);
    $("#goLabel").textContent = goLabel;

    let timer;
    $("#q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => render(true), 120); });
    $("#q").addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const hits = filtered().hits.slice(0, LIST_LIMIT);
        const at = selected ? hits.findIndex(h => idOf(h) === idOf(selected)) : -1;
        select(hits[Math.max(0, Math.min(hits.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]);
        e.preventDefault();
      } else if (e.key === "Enter") {
        if (selected) sendSelected();
        else select(filtered().hits[0]);
      }
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
    $("#showJunk").addEventListener("change", e => {
      cfg.showJunk = e.target.checked;
      writeJson(CONFIG, cfg);
      rebuildModels();
      render(true);
    });
    $("#rescan").addEventListener("click", () => { closeDrawer(); scan(true); });
    $("#update").addEventListener("click", startUpdate);
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
