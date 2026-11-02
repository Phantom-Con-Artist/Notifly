// On Wayland, global shortcuts belong to the compositor rather than X11.
use ashpd::desktop::global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut};
use futures_util::StreamExt;
use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn heartbeat(dir: &std::path::Path, error: Option<&str>, shortcut: Option<&str>) {
    let updated = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let _ = fs::write(
        dir.join("status.json"),
        serde_json::json!({"updated": updated, "error": error, "shortcut": shortcut}).to_string(),
    );
}
pub fn run(config: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(run_async(config))
}
async fn run_async(config: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let dir = config.parent().ok_or("Invalid config path")?.to_path_buf();
    let setup = async {
        let trigger = crate::hotkey::for_desktop(&crate::storage::load(&config).map(|c| c.shortcut).unwrap_or_else(|_| crate::hotkey::DEFAULT.to_owned()));
        let portal = GlobalShortcuts::new().await?;
        let session = portal.create_session(Default::default()).await?;
        let shortcuts = [NewShortcut::new("capture", "Capture a thought in Notifly")
            .preferred_trigger(Some(trigger.as_str()))];
        let bound = portal
            .bind_shortcuts(&session, &shortcuts, None, BindShortcutsOptions::default())
            .await?
            .response()?;
        let shortcut = bound
            .shortcuts()
            .iter()
            .find(|s| s.id() == "capture")
            .ok_or("Desktop did not assign the capture shortcut")?
            .trigger_description()
            .to_owned();
        Ok::<_, Box<dyn std::error::Error>>((portal, session, shortcut))
    };
    tokio::pin!(setup);
    let mut ticks = tokio::time::interval(Duration::from_secs(1));
    let (portal, session, shortcut) = loop {
        tokio::select! {
            result = &mut setup => break result?,
            _ = ticks.tick() => {
                if dir.join("stop").exists() { let _ = fs::remove_file(dir.join("status.json")); return Ok(()); }
                heartbeat(&dir, Some("Waiting for desktop shortcut approval"), None);
            }
        }
    };
    let mut activated = portal.receive_activated().await?;
    let mut popup = crate::host::Popup::new(&config);
    loop {
        tokio::select! {
            event = activated.next() => {
                let Some(event) = event else { return Err("Desktop shortcut session closed".into()); };
                if event.shortcut_id() != "capture" { continue; }
                popup.show();
            }
            _ = ticks.tick() => {
                if dir.join("stop").exists() { let _ = fs::remove_file(dir.join("status.json")); break; }
                popup.keep_alive();
                heartbeat(&dir, None, Some(&shortcut));
            }
        }
    }
    session.close().await?;
    Ok(())
}
