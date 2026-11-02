//! Wayland apps cannot read the pointer or place their own windows, but KDE can do both for us.
//! While the helper runs, a small KWin script moves the capture window to the pointer whenever it appears.
use std::{fs, path::Path, process::Command};

const NAME: &str = "notifly-place";
const SCRIPT: &str = r#"function place(w) {
  if (!w || w.caption !== "Notifly") return;
  var p = workspace.cursorPos;
  var screen = workspace.screenAt ? workspace.screenAt(p) : workspace.activeScreen;
  var a = workspace.clientArea(KWin.PlacementArea, screen, workspace.currentDesktop);
  var g = w.frameGeometry;
  var x = Math.max(a.x, Math.min(p.x, a.x + a.width - g.width));
  var y = Math.max(a.y, Math.min(p.y, a.y + a.height - g.height));
  w.frameGeometry = { x: x, y: y, width: g.width, height: g.height };
}
workspace.windowAdded.connect(place);
"#;

fn bus(args: &[&str]) -> Option<String> {
    let out = Command::new("busctl").arg("--user").arg("call").arg("org.kde.KWin").args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
fn unload() {
    let _ = bus(&["/Scripting", "org.kde.kwin.Scripting", "unloadScript", "s", NAME]);
}

/// Keeps the placement script loaded for as long as it lives.
pub struct Placement(bool);
impl Placement {
    pub fn install(dir: &Path) -> Placement {
        let kde = std::env::var("XDG_CURRENT_DESKTOP").map(|d| d.to_uppercase().contains("KDE")).unwrap_or(false);
        if !kde || std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return Placement(false);
        }
        let path = dir.join("place.js");
        if fs::write(&path, SCRIPT).is_err() {
            return Placement(false);
        }
        unload();
        let Some(id) = bus(&["/Scripting", "org.kde.kwin.Scripting", "loadScript", "ss", &path.to_string_lossy(), NAME])
            .and_then(|r| r.split_whitespace().last().and_then(|n| n.parse::<u32>().ok()))
        else {
            return Placement(false);
        };
        let loaded = bus(&[&format!("/Scripting/Script{id}"), "org.kde.kwin.Script", "run"]).is_some();
        if !loaded {
            unload();
        }
        Placement(loaded)
    }
}
impl Drop for Placement {
    fn drop(&mut self) {
        if self.0 {
            unload();
        }
    }
}
