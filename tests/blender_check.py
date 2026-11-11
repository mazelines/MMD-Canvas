# Usage: blender -b --factory-startup --python tests/blender_check.py -- <file> [more files]
# Imports each file and prints a JSON summary line prefixed with CHECK:
import bpy, sys, json, os
files = sys.argv[sys.argv.index("--") + 1:]
for f in files:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = os.path.splitext(f)[1].lower()
    info = {"file": os.path.basename(f)}
    try:
        if ext == ".fbx":
            bpy.ops.import_scene.fbx(filepath=f)
        else:
            bpy.ops.wm.usd_import(filepath=f)
        meshes = [o for o in bpy.data.objects if o.type == "MESH"]
        arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
        info["objects"] = [(o.name, o.type) for o in bpy.data.objects]
        for o in meshes:
            me = o.data
            ws = [o.matrix_world @ v.co for v in me.vertices]
            info["mesh"] = {
                "verts": len(me.vertices), "polys": len(me.polygons),
                "materials": [m.name if m else None for m in me.materials],
                "uv_layers": len(me.uv_layers),
                "vertex_groups": [g.name for g in o.vertex_groups],
                "shape_keys": [k.name for k in me.shape_keys.key_blocks] if me.shape_keys else [],
                "modifiers": [m.type for m in o.modifiers],
                "bounds_min": [round(min(v[i] for v in ws), 4) for i in range(3)],
                "bounds_max": [round(max(v[i] for v in ws), 4) for i in range(3)],
                "weighted_verts": sum(1 for v in me.vertices if len(v.groups) > 0),
                "scale": [round(s, 4) for s in o.matrix_world.to_scale()],
            }
            # outward-facing check: average dot(normal, radial) of body faces (material 0)
            dots = [p.normal.x * p.center.x + p.normal.y * p.center.y + p.normal.z * p.center.z for p in me.polygons if p.material_index == 0]
            info["mesh"]["outward"] = round(sum(1 for d in dots if d > 0) / max(len(dots), 1), 3)
            tex = []
            for m in me.materials:
                if m and m.use_nodes:
                    for n in m.node_tree.nodes:
                        if n.type == "TEX_IMAGE" and n.image:
                            tex.append((m.name, os.path.basename(n.image.filepath), n.image.size[0]))
            info["textures"] = tex
        for a in arms:
            info["armature"] = {
                "bones": [(b.name, b.parent.name if b.parent else None, [round(c, 3) for c in (a.matrix_world @ b.head_local)]) for b in a.data.bones],
            }
    except Exception as e:
        info["error"] = repr(e)
    print("CHECK:" + json.dumps(info, ensure_ascii=False))
