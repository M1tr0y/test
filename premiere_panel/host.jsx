// Imports media that Rust3D queued in %APPDATA%\Rust3D\premiere_inbox into a "Rust3D" bin.
function rust3dCheckInbox() {
    if (!app.project) return "0";
    var inbox = new Folder(Folder.userData.fsName + "/Rust3D/premiere_inbox");
    if (!inbox.exists) return "0";
    var tickets = inbox.getFiles("*.txt");
    if (!tickets.length) return "0";

    var root = app.project.rootItem;
    var bin = null;
    for (var i = 0; i < root.children.numItems; i++) {
        if (root.children[i].name === "Rust3D" && root.children[i].type === ProjectItemType.BIN) {
            bin = root.children[i];
        }
    }
    if (!bin) bin = root.createBin("Rust3D");

    var names = [];
    for (var t = 0; t < tickets.length; t++) {
        var ticket = tickets[t];
        ticket.encoding = "UTF-8";
        ticket.open("r");
        var path = ticket.read().replace(/^\s+|\s+$/g, "");
        ticket.close();
        ticket.remove();
        if (path && new File(path).exists) {
            app.project.importFiles([path], true, bin, false);
            names.push(new File(path).name);
        }
    }
    return names.length ? decodeURI(names.join(", ")) : "0";
}
