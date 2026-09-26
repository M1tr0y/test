"""Rust3D core: config, tool detection/downloads and the export pipeline.

Pipeline for one model:
  AssetStudioModCLI (splitObjects -> FBX, fallback: mesh -> OBJ)
  -> FBX2glTF (FBX -> GLB with embedded textures, Blender as fallback)
  -> After Effects: AfterFX.exe -r import.jsx (AE 24+ imports GLB natively)
  -> Premiere Pro: Blender renders a transparent turntable .mov,
     the Rust3D CEP panel inside Premiere imports it from the inbox folder.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

APP_NAME = "Rust3D"
APP_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / APP_NAME
CONFIG_PATH = APP_DIR / "config.json"
TOOLS_DIR = APP_DIR / "tools"
CACHE_DIR = APP_DIR / "cache"
PREMIERE_INBOX = APP_DIR / "premiere_inbox"
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
BLENDER_SCRIPTS = ROOT / "blender"
PREMIERE_PANEL = ROOT / "premiere_panel"

NO_WINDOW = 0x08000000 if os.name == "nt" else 0

DEFAULT_CONFIG = {
    "rust_dir": "",
    "export_dir": str(Path.home() / "Documents" / "Rust3D"),
    "assetstudio_cli": "",
    "fbx2gltf": "",
    "blender_exe": "",
    "ae_exe": "",
    "premiere_exe": "",
    "turntable_seconds": 6,
    "resolution": [1920, 1080],
    "fps": 30,
}


# ---------------------------------------------------------------- config

def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    return cfg


def save_config(cfg):
    APP_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def is_configured(cfg):
    return all(cfg.get(k) and Path(cfg[k]).exists()
               for k in ("rust_dir", "assetstudio_cli", "fbx2gltf"))


# ---------------------------------------------------------------- detection

def _natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def _latest(patterns):
    hits = [h for p in patterns for h in glob.glob(p)]
    return sorted(hits, key=_natural_key)[-1] if hits else ""


def _program_files():
    dirs = {os.environ.get("ProgramFiles", r"C:\Program Files"),
            os.environ.get("ProgramW6432", r"C:\Program Files")}
    return [d for d in dirs if d]


def detect_after_effects():
    return _latest([os.path.join(pf, "Adobe", "Adobe After Effects *", "Support Files", "AfterFX.exe")
                    for pf in _program_files()])


def detect_premiere():
    return _latest([os.path.join(pf, "Adobe", "Adobe Premiere Pro *", "Adobe Premiere Pro.exe")
                    for pf in _program_files()])


def detect_blender():
    found = _latest([os.path.join(pf, "Blender Foundation", "Blender*", "blender.exe")
                     for pf in _program_files()])
    return found or shutil.which("blender") or ""


def _steam_libraries():
    roots = []
    try:
        import winreg
        for hive, key in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
                          (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam")):
            try:
                with winreg.OpenKey(hive, key) as k:
                    for name in ("SteamPath", "InstallPath"):
                        try:
                            roots.append(winreg.QueryValueEx(k, name)[0])
                        except OSError:
                            pass
            except OSError:
                pass
    except ImportError:
        pass
    roots.append(r"C:\Program Files (x86)\Steam")
    libs = []
    for root in roots:
        libs.append(root)
        vdf = Path(root) / "steamapps" / "libraryfolders.vdf"
        if vdf.exists():
            libs += [p.replace("\\\\", "\\") for p in
                     re.findall(r'"path"\s+"([^"]+)"', vdf.read_text(encoding="utf-8", errors="ignore"))]
    return list(dict.fromkeys(libs))


def detect_rust():
    for lib in _steam_libraries():
        rust = Path(lib) / "steamapps" / "common" / "Rust"
        if (rust / "Bundles").exists():
            return str(rust)
    return ""


# ---------------------------------------------------------------- downloads

def _github_find_asset(repo, score):
    """Newest release asset with the best positive score. Scans all releases, not
    /releases/latest: FBX2glTF only has pre-releases, so "latest" is a 404 there."""
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}/releases?per_page=20",
                                 headers={"User-Agent": APP_NAME})
    with urllib.request.urlopen(req, timeout=30) as r:
        releases = json.load(r)
    for release in releases:
        scored = [(score(a["name"].lower()), a) for a in release["assets"]]
        scored = [s for s in scored if s[0] > 0]
        if scored:
            return max(scored, key=lambda s: s[0])[1]
    return None


def _download(url, dest, log):
    log(f"Скачиваю {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": APP_NAME})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    return dest


def install_assetstudio(log=print):
    """Download the Windows build of AssetStudioModCLI (prefers net472: no extra runtime needed)."""
    def score(n):
        if "assetstudiomodcli" not in n or not n.endswith(".zip") or "linux" in n or "mac" in n:
            return 0
        return 1 + (2 if "net472" in n else 0) + (1 if "win" in n else 0)

    best = _github_find_asset("aelurum/AssetStudio", score)
    if not best:
        raise RuntimeError("Не нашёл Windows-сборку AssetStudioModCLI в релизах")
    target = TOOLS_DIR / "AssetStudioModCLI"
    archive = _download(best["browser_download_url"], TOOLS_DIR / best["name"], log)
    shutil.rmtree(target, ignore_errors=True)
    with zipfile.ZipFile(archive) as z:
        z.extractall(target)
    archive.unlink()
    exe = next(target.rglob("AssetStudioModCLI.exe"), None)
    if not exe:
        raise RuntimeError("В архиве нет AssetStudioModCLI.exe")
    return str(exe)


def install_fbx2gltf(log=print):
    asset = _github_find_asset("facebookincubator/FBX2glTF",
                               lambda n: 1 if "windows" in n and n.endswith(".exe") else 0)
    if not asset:
        raise RuntimeError("Не нашёл Windows-сборку FBX2glTF")
    return str(_download(asset["browser_download_url"], TOOLS_DIR / "FBX2glTF.exe", log))


# ---------------------------------------------------------------- Premiere panel

def install_premiere_panel(log=print):
    """Copy the unsigned CEP panel and enable PlayerDebugMode so Premiere loads it."""
    ext_root = Path(os.environ["APPDATA"]) / "Adobe" / "CEP" / "extensions" / "com.rust3d.importer"
    shutil.rmtree(ext_root, ignore_errors=True)
    shutil.copytree(PREMIERE_PANEL, ext_root)
    import winreg
    for ver in range(9, 13):
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Adobe\CSXS.{ver}") as k:
            winreg.SetValueEx(k, "PlayerDebugMode", 0, winreg.REG_SZ, "1")
    PREMIERE_INBOX.mkdir(parents=True, exist_ok=True)
    log(f"Панель для Premiere установлена в {ext_root}")


# ---------------------------------------------------------------- AssetStudio

def _run(cmd, log, cwd=None):
    log("> " + " ".join(f'"{c}"' if " " in str(c) else str(c) for c in cmd))
    proc = subprocess.Popen([str(c) for c in cmd], cwd=cwd, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                            errors="replace", creationflags=NO_WINDOW)
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            log(line)
    if proc.wait() != 0:
        raise RuntimeError(f"Команда завершилась с кодом {proc.returncode}")


def bundles_dir(cfg):
    rust = Path(cfg["rust_dir"])
    return rust / "Bundles" if (rust / "Bundles").exists() else rust


def scan_models(cfg, log=print):
    """Build the model list once (slow: AssetStudio has to open every bundle) and cache it."""
    out = CACHE_DIR / "scan"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    _run([cfg["assetstudio_cli"], bundles_dir(cfg), "-m", "info", "-t", "mesh",
          "--export-asset-list", "xml", "-o", out], log)
    xml_path = out / "assets.xml"
    if not xml_path.exists():
        raise RuntimeError("AssetStudio не создал assets.xml")
    models = []
    for a in ET.parse(xml_path).getroot().iter("Asset"):
        models.append({
            "name": a.findtext("Name", ""),
            "container": a.findtext("Container", ""),
            "path_id": a.findtext("PathID", ""),
            "source": a.findtext("Source", ""),
        })
    models.sort(key=lambda m: m["name"].lower())
    (CACHE_DIR / "models.json").write_text(json.dumps(models, ensure_ascii=False), encoding="utf-8")
    log(f"Найдено моделей: {len(models)}")
    return models


def cached_models():
    p = CACHE_DIR / "models.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _input_for(cfg, model):
    """Open only the bundle that holds the model when we can find it — much faster than all of them."""
    src = Path(model.get("source") or "")
    if src.is_file():
        return src
    if src.name:
        hit = next(bundles_dir(cfg).rglob(src.name), None)
        if hit and hit.is_file():
            return hit
    return bundles_dir(cfg)


def _safe(name):
    return re.sub(r'[<>:"/\\|?*]+', "_", name).strip() or "model"


def export_model(cfg, model, log=print):
    """Export one model with textures. Returns path to FBX or OBJ."""
    dest = Path(cfg["export_dir"]) / _safe(model["name"])
    raw = dest / "raw"
    shutil.rmtree(raw, ignore_errors=True)
    raw.mkdir(parents=True)
    src = _input_for(cfg, model)

    # GameObject names usually contain the mesh name, so filter by substring and
    # prefer an exact name match, else the largest object (most complete prefab).
    _run([cfg["assetstudio_cli"], src, "-m", "splitObjects",
          "--filter-by-name", model["name"], "-o", raw], log)
    fbx = sorted(raw.rglob("*.fbx"),
                 key=lambda p: (p.stem.lower() == model["name"].lower(), p.stat().st_size), reverse=True)
    if fbx:
        return fbx[0]

    log("FBX-объект не найден, выгружаю саму сетку (OBJ)")
    _run([cfg["assetstudio_cli"], src, "-m", "export", "-t", "mesh",
          "--filter-by-pathid", model["path_id"], "-g", "none", "-o", raw], log)
    obj = next(raw.rglob("*.obj"), None)
    if not obj:
        raise RuntimeError("AssetStudio ничего не выгрузил для этой модели")
    return obj


def to_glb(cfg, source, log=print):
    glb = source.parent.parent / (_safe(source.stem) + ".glb")
    if source.suffix.lower() == ".fbx" and cfg.get("fbx2gltf"):
        try:
            _run([cfg["fbx2gltf"], "--binary", "--input", source,
                  "--output", glb.with_suffix("")], log)
            if glb.exists():
                return glb
        except RuntimeError as e:
            log(f"FBX2glTF не справился ({e}), пробую Blender")
    if not cfg.get("blender_exe"):
        raise RuntimeError("Для конвертации нужен Blender — укажи его в настройках")
    _run([cfg["blender_exe"], "-b", "--factory-startup", "-P", BLENDER_SCRIPTS / "convert.py",
          "--", source, glb], log)
    return glb


# ---------------------------------------------------------------- Adobe

def _jsx_str(p):
    return json.dumps(str(p).replace("\\", "/"))


def send_to_after_effects(cfg, glb, log=print):
    ae = cfg.get("ae_exe")
    if not ae or not Path(ae).exists():
        raise RuntimeError("After Effects не найден — укажи путь в настройках")
    w, h = cfg["resolution"]
    jsx = CACHE_DIR / "ae_import.jsx"
    jsx.parent.mkdir(parents=True, exist_ok=True)
    jsx.write_text(f"""
(function () {{
    app.beginUndoGroup("Rust3D import");
    if (!app.project) app.newProject();
    var file = new File({_jsx_str(glb)});
    var item = app.project.importFile(new ImportOptions(file));
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) {{
        comp = app.project.items.addComp(item.name.replace(/\\.glb$/i, ""), {w}, {h}, 1, 10, {cfg['fps']});
    }}
    var layer = comp.layers.add(item);
    try {{ layer.threeDLayer = true; }} catch (e) {{}}  // 3D model layers are already 3D
    try {{ layer.property("Position").setValue([comp.width / 2, comp.height / 2, 0]); }} catch (e) {{}}
    comp.openInViewer();
    app.endUndoGroup();
}})();
""", encoding="utf-8")
    # -r hands the script to the running AE instance, or starts AE first.
    subprocess.Popen([ae, "-r", str(jsx)], creationflags=NO_WINDOW)
    log("Модель отправлена в After Effects")


def render_turntable(cfg, glb, log=print):
    if not cfg.get("blender_exe"):
        raise RuntimeError("Для видео в Premiere нужен Blender — укажи его в настройках")
    mov = glb.with_name(glb.stem + "_turntable.mov")
    w, h = cfg["resolution"]
    _run([cfg["blender_exe"], "-b", "--factory-startup", "-P", BLENDER_SCRIPTS / "turntable.py",
          "--", glb, mov, w, h, cfg["fps"], cfg["turntable_seconds"]], log)
    if not mov.exists():
        raise RuntimeError("Blender не создал видео")
    return mov


def send_to_premiere(cfg, media, log=print):
    PREMIERE_INBOX.mkdir(parents=True, exist_ok=True)
    ticket = PREMIERE_INBOX / f"{int(time.time() * 1000)}.txt"
    ticket.write_text(str(media), encoding="utf-8")
    pr = cfg.get("premiere_exe")
    running = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Adobe Premiere Pro.exe"],
                             capture_output=True, text=True, creationflags=NO_WINDOW).stdout
    if "Adobe Premiere Pro.exe" not in running and pr and Path(pr).exists():
        subprocess.Popen([pr], creationflags=NO_WINDOW)
        log("Запускаю Premiere Pro — открой проект, панель Rust3D импортирует видео сама")
    else:
        log("Видео отправлено в Premiere Pro (панель Окно → Расширения → Rust3D должна быть открыта)")
