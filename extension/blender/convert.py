# blender -b --factory-startup -P convert.py -- <input.fbx|obj> <output.glb>
import sys

import bpy

src, dst = sys.argv[sys.argv.index("--") + 1:][:2]

bpy.ops.wm.read_factory_settings(use_empty=True)
if src.lower().endswith(".fbx"):
    bpy.ops.import_scene.fbx(filepath=src)
elif hasattr(bpy.ops.wm, "obj_import"):
    bpy.ops.wm.obj_import(filepath=src)
else:
    bpy.ops.import_scene.obj(filepath=src)

bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB")
