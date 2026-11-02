use fs2::FileExt;
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use winit::{
    application::ApplicationHandler,
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    window::WindowId,
};

pub fn run(config: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let dir = config.parent().ok_or("Invalid config path")?.to_path_buf();
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("lock"))?;
    lock.try_lock_exclusive()?;
    // On KDE Wayland the desktop places the capture window at the pointer; this stays loaded while we run.
    #[cfg(target_os = "linux")]
    let _placement = crate::kde::Placement::install(&dir);
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return crate::portal::run(config);
    }
    let mut builder = EventLoop::<()>::with_user_event();
    #[cfg(target_os = "linux")]
    {
        use winit::platform::x11::EventLoopBuilderExtX11;
        builder.with_x11();
    }
    let event_loop = builder.build()?;
    let proxy = event_loop.create_proxy();
    GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
        if event.state == HotKeyState::Pressed {
            let _ = proxy.send_event(());
        }
    }));
    let shortcut = crate::storage::load(&config).map(|c| c.shortcut).unwrap_or_else(|_| crate::hotkey::DEFAULT.to_owned());
    let mut listener = Listener {
        shortcut,
        config,
        dir,
        manager: None,
        popup: None,
        failure: None,
    };
    event_loop.run_app(&mut listener)?;
    let _ = fs::remove_file(listener.dir.join("status.json"));
    if let Some(error) = listener.failure {
        return Err(error.into());
    }
    drop(lock);
    Ok(())
}
struct Listener {
    shortcut: String,
    config: PathBuf,
    dir: PathBuf,
    manager: Option<GlobalHotKeyManager>,
    popup: Option<crate::host::Popup>,
    failure: Option<String>,
}
impl ApplicationHandler<()> for Listener {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.manager.is_some() {
            return;
        }
        let setup = || -> Result<GlobalHotKeyManager, Box<dyn std::error::Error>> {
            let manager = GlobalHotKeyManager::new()?;
            manager.register(crate::hotkey::parse(&self.shortcut)?)?;
            Ok(manager)
        };
        match setup() {
            Ok(manager) => {
                self.manager = Some(manager);
                self.popup = Some(crate::host::Popup::new(&self.config));
            }
            Err(error) => {
                self.failure = Some(error.to_string());
                event_loop.exit();
            }
        }
    }
    fn window_event(&mut self, _: &ActiveEventLoop, _: WindowId, _: WindowEvent) {}
    fn user_event(&mut self, _: &ActiveEventLoop, _: ()) {
        if let Some(popup) = &mut self.popup {
            popup.show();
        }
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if self.dir.join("stop").exists() {
            event_loop.exit();
            return;
        }
        if let Some(popup) = &mut self.popup {
            popup.keep_alive();
        }
        let updated = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let _ = fs::write(
            self.dir.join("status.json"),
            serde_json::json!({"updated":updated,"shortcut":self.shortcut}).to_string(),
        );
        event_loop.set_control_flow(ControlFlow::WaitUntil(
            Instant::now() + Duration::from_secs(1),
        ));
    }
}
