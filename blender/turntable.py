# blender -b --factory-startup -P turntable.py -- <model.glb> <out.mov> <width> <height> <fps> <seconds>
# Renders a 360° turntable with a transparent background (QuickTime PNG, RGBA) for Premiere Pro.
import math
import sys

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
src, dst = args[0], args[1]
width, height, fps, seconds = (int(float(a)) for a in args[2:6])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
scene = bpy.context.scene

meshes = [o for o in scene.objects if o.type == "MESH"]
if not meshes:
    raise SystemExit("no meshes in " + src)

# Parent everything to a pivot at the model's bounding-box center so it spins in place.
corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
center, radius = (lo + hi) / 2, max((hi - lo).length / 2, 1e-3)

pivot = bpy.data.objects.new("pivot", None)
scene.collection.objects.link(pivot)
pivot.location = center
for o in scene.objects:
    if o.parent is None and o is not pivot:
        o.parent = pivot
        o.matrix_parent_inverse = pivot.matrix_world.inverted()

frames = fps * seconds
scene.frame_start, scene.frame_end = 1, frames
scene.render.fps = fps
# Linear keys give a constant spin that loops seamlessly (frame frames+1 == frame 1).
bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
pivot.rotation_euler = (0, 0, 0)
pivot.keyframe_insert("rotation_euler", index=2, frame=1)
pivot.rotation_euler = (0, 0, 2 * math.pi)
pivot.keyframe_insert("rotation_euler", index=2, frame=frames + 1)

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 50
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
direction = Vector((0, -1, 0.35)).normalized()
fov_x = cam_data.angle_x
fov = min(fov_x, 2 * math.atan(math.tan(fov_x / 2) * height / width))
cam.location = center + direction * (radius / math.sin(fov / 2)) * 1.1
cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
cam_data.clip_end = radius * 100
scene.camera = cam

for name, energy, rot in (("key", 4, (0.8, 0.2, 0.6)), ("fill", 1.5, (1.0, 0, -2.2)), ("rim", 3, (-0.9, 0, 3.0))):
    light = bpy.data.objects.new(name, bpy.data.lights.new(name, "SUN"))
    light.data.energy = energy
    light.rotation_euler = rot
    scene.collection.objects.link(light)

world = bpy.data.worlds.new("world")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
scene.world = world

engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
scene.render.engine = next(e for e in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES") if e in engines)
scene.render.resolution_x, scene.render.resolution_y = width, height
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = "FFMPEG"
scene.render.ffmpeg.format = "QUICKTIME"
scene.render.ffmpeg.codec = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.filepath = dst
scene.render.use_file_extension = False

bpy.ops.render.render(animation=True)
