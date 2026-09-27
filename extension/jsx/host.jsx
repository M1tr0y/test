// ExtendScript side of the Rust3D panel. Every function returns "ok..." or "error: ...".

function rust3dImportAE(path, width, height, fps) {
    try {
        app.beginUndoGroup("Rust3D import");
        if (!app.project) app.newProject();
        var item = app.project.importFile(new ImportOptions(new File(path)));
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) {
            comp = app.project.items.addComp(item.name.replace(/\.glb$/i, ""), width, height, 1, 10, fps);
        }
        var layer = comp.layers.add(item);
        try { layer.threeDLayer = true; } catch (e1) {}  // 3D model layers are already 3D
        try { layer.property("Position").setValue([comp.width / 2, comp.height / 2, 0]); } catch (e2) {}
        comp.openInViewer();
        app.endUndoGroup();
        return "ok";
    } catch (e) {
        try { app.endUndoGroup(); } catch (e3) {}
        return "error: " + e.toString();
    }
}

// Imports the clip into a "Rust3D" bin and drops it at the playhead on the first free video track.
function rust3dImportPPRO(path, seconds) {
    try {
        if (!app.project) return "error: Открой проект Premiere";
        var root = app.project.rootItem, bin = null, i;
        for (i = 0; i < root.children.numItems; i++) {
            if (root.children[i].name === "Rust3D" && root.children[i].type === ProjectItemType.BIN) bin = root.children[i];
        }
        if (!bin) bin = root.createBin("Rust3D");

        var before = bin.children.numItems;
        app.project.importFiles([path], true, bin, false);
        var item = null, name = decodeURI(new File(path).name);
        if (bin.children.numItems > before) item = bin.children[bin.children.numItems - 1];
        for (i = bin.children.numItems - 1; !item && i >= 0; i--) {
            if (bin.children[i].name === name) item = bin.children[i];
        }

        var seq = app.project.activeSequence;
        if (!item || !seq) return "ok:bin";
        var pos = seq.getPlayerPosition();
        var start = pos.seconds, end = start + seconds;
        var order = [];
        for (i = 1; i < seq.videoTracks.numTracks; i++) order.push(i);
        order.push(0);
        for (i = 0; i < order.length; i++) {
            var track = seq.videoTracks[order[i]];
            if (rust3dTrackFree(track, start, end)) {
                track.overwriteClip(item, pos);
                return "ok:timeline";
            }
        }
        return "ok:bin";
    } catch (e) {
        return "error: " + e.toString();
    }
}

function rust3dTrackFree(track, start, end) {
    for (var i = 0; i < track.clips.numItems; i++) {
        var c = track.clips[i];
        if (c.start.seconds < end && c.end.seconds > start) return false;
    }
    return true;
}
