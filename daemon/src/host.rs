use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
};

/// Keeps one capture window alive but hidden, so Alt+C only has to show it.
pub struct Popup {
    config: PathBuf,
    child: Option<(Child, ChildStdin)>,
}
impl Popup {
    pub fn new(config: &Path) -> Self {
        let mut popup = Popup { config: config.to_path_buf(), child: None };
        popup.ensure();
        popup
    }
    fn ensure(&mut self) -> bool {
        if let Some((child, _)) = &mut self.child {
            if matches!(child.try_wait(), Ok(None)) {
                return true;
            }
            self.child = None;
        }
        let spawned = std::env::current_exe().and_then(|exe| {
            Command::new(exe)
                .arg("--capture")
                .arg(&self.config)
                .stdin(Stdio::piped())
                .spawn()
        });
        match spawned {
            Ok(mut child) => match child.stdin.take() {
                Some(stdin) => {
                    self.child = Some((child, stdin));
                    true
                }
                None => false,
            },
            Err(error) => {
                eprintln!("Could not start capture window: {error}");
                false
            }
        }
    }
    pub fn show(&mut self) {
        if !self.ensure() {
            return;
        }
        if let Some((_, stdin)) = &mut self.child {
            let _ = stdin.write_all(b"show\n").and_then(|_| stdin.flush());
        }
    }
    /// Respawns a window that crashed so the next Alt+C is still instant.
    pub fn keep_alive(&mut self) {
        self.ensure();
    }
}
impl Drop for Popup {
    fn drop(&mut self) {
        if let Some((child, _)) = &mut self.child {
            let _ = child.kill();
        }
    }
}
