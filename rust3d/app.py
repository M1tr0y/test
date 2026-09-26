"""Rust3D desktop app: pywebview window with an HTML UI, Python does the work."""
import json
import threading
import traceback
from pathlib import Path

import webview

from . import core


class Api:
    """Methods here are callable from JS as window.pywebview.api.<name>()."""

    def __init__(self):
        self._window = None
        self._cfg = core.load_config()
        self._models = core.cached_models() or []
        self._busy = False

    # -------------------------------------------------- helpers
    def _js(self, fn, *args):
        if self._window:
            self._window.evaluate_js(f"{fn}({','.join(json.dumps(a, ensure_ascii=False) for a in args)})")

    def _log(self, text):
        self._js("ui.log", str(text))

    def _task(self, name, fn):
        """Run fn in the background so the window stays smooth; report back via ui.taskDone."""
        if self._busy:
            return False
        self._busy = True

        def run():
            try:
                result = fn()
                self._js("ui.taskDone", name, True, result)
            except Exception as e:  # shown to the user, full trace goes to the log
                self._log(traceback.format_exc())
                self._js("ui.taskDone", name, False, str(e))
            finally:
                self._busy = False

        threading.Thread(target=run, daemon=True).start()
        return True

    def _step(self, text, percent):
        self._js("ui.progress", text, percent)

    # -------------------------------------------------- setup wizard
    def get_state(self):
        return {"config": self._cfg, "configured": core.is_configured(self._cfg),
                "model_count": len(self._models)}

    def detect(self):
        return {
            "rust_dir": self._cfg.get("rust_dir") or core.detect_rust(),
            "ae_exe": self._cfg.get("ae_exe") or core.detect_after_effects(),
            "premiere_exe": self._cfg.get("premiere_exe") or core.detect_premiere(),
            "blender_exe": self._cfg.get("blender_exe") or core.detect_blender(),
            "export_dir": self._cfg.get("export_dir"),
        }

    def browse(self, kind, current=""):
        folder = kind in ("rust_dir", "export_dir")
        dialog = webview.FOLDER_DIALOG if folder else webview.OPEN_DIALOG
        types = () if folder else ("Программы (*.exe)",)
        start = str(Path(current).parent if current and not folder else current or "")
        res = self._window.create_file_dialog(dialog, directory=start, file_types=types)
        return res[0] if res else None

    def finish_setup(self, values):
        self._cfg.update({k: v for k, v in values.items() if k in core.DEFAULT_CONFIG})

        def work():
            self._step("Скачиваю AssetStudio…", 10)
            if not (self._cfg.get("assetstudio_cli") and Path(self._cfg["assetstudio_cli"]).exists()):
                self._cfg["assetstudio_cli"] = core.install_assetstudio(self._log)
            self._step("Скачиваю конвертер FBX → GLB…", 45)
            if not (self._cfg.get("fbx2gltf") and Path(self._cfg["fbx2gltf"]).exists()):
                self._cfg["fbx2gltf"] = core.install_fbx2gltf(self._log)
            if self._cfg.get("premiere_exe"):
                self._step("Ставлю панель в Premiere Pro…", 75)
                core.install_premiere_panel(self._log)
            Path(self._cfg["export_dir"]).mkdir(parents=True, exist_ok=True)
            core.save_config(self._cfg)
            self._step("Готово", 100)
            return self.get_state()

        return self._task("setup", work)

    # -------------------------------------------------- models
    def scan(self):
        def work():
            self._step("Читаю файлы Rust — первый раз это долго, дальше из кэша", 30)
            self._models = core.scan_models(self._cfg, self._log)
            self._step("Список готов", 100)
            return len(self._models)

        return self._task("scan", work)

    def search(self, query, limit=400):
        q = query.lower().strip()
        hits = [dict(m, idx=i) for i, m in enumerate(self._models)
                if not q or q in m["name"].lower() or q in m["container"].lower()]
        return {"total": len(hits), "items": hits[:limit]}

    def send(self, idx, targets):
        """targets: list of 'ae', 'premiere', 'file' — the whole chain in one click."""
        model = self._models[idx]

        def work():
            self._step(f"Достаю «{model['name']}» из игры…", 10)
            raw = core.export_model(self._cfg, model, self._log)
            self._step("Конвертирую в GLB…", 40)
            glb = core.to_glb(self._cfg, raw, self._log)
            if "ae" in targets:
                self._step("Отправляю в After Effects…", 60)
                core.send_to_after_effects(self._cfg, glb, self._log)
            if "premiere" in targets:
                self._step("Рендерю вращение в Blender для Premiere…", 70)
                mov = core.render_turntable(self._cfg, glb, self._log)
                core.send_to_premiere(self._cfg, mov, self._log)
            self._step("Готово", 100)
            return str(glb)

        return self._task("send", work)


def main():
    api = Api()
    ui = core.ROOT / "ui" / "index.html"
    # Underscore attributes are private to pywebview, so the window/config are not exposed to JS.
    api._window = webview.create_window("Rust3D", str(ui), js_api=api, width=1180, height=760,
                                       min_size=(900, 600), background_color="#141210")
    webview.start()


if __name__ == "__main__":
    main()
