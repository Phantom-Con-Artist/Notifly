#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
mod background;
mod hotkey;
#[cfg(target_os = "linux")]
mod kde;
#[cfg(target_os = "linux")]
mod voice;
mod host;
#[cfg(target_os = "linux")]
mod portal;
mod storage;
use base64::Engine;
use mouse_position::mouse_position::Mouse;
use serde::Deserialize;
use std::{cell::RefCell, collections::HashMap, fs, path::{Path, PathBuf}, rc::Rc};
use storage::Session;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

const PAGE: &str = include_str!("../ui/popup.html");

enum Done {
    Show,
    Hide,
    Quit,
    /// Markdown for a file that finished arriving, to put at the cursor.
    Insert(String),
    /// A line of script to run in the page, used to report back on recording.
    Eval(String),
    Error(String),
}
#[derive(Deserialize)]
struct Message {
    template: String,
    text: String,
}
#[derive(Deserialize, serde::Serialize)]
struct Draft {
    template: String,
    text: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let first = args.next().ok_or("Expected config.json path")?;
    if first != "--capture" {
        return background::run(PathBuf::from(first));
    }
    let config = PathBuf::from(args.next().ok_or("Expected capture config path")?);
    capture(config)
}

fn read_session(dir: &Path) -> Option<Session> {
    serde_json::from_slice(&fs::read(dir.join("session.json")).ok()?).ok()
}
fn set_session(dir: &Path, state: &RefCell<Option<Session>>, session: Option<Session>) {
    match &session {
        Some(s) => {
            let _ = fs::write(dir.join("session.json"), serde_json::to_vec(s).unwrap_or_default());
        }
        None => {
            let _ = fs::remove_file(dir.join("session.json"));
        }
    }
    *state.borrow_mut() = session;
}

fn capture(config: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    // Wayland clients cannot place their own windows; XWayland can, so the popup follows the pointer.
    #[cfg(target_os = "linux")]
    std::env::set_var("GDK_BACKEND", "x11");
    let dir = config.parent().ok_or("Invalid config path")?.to_path_buf();
    // The autosaved note of an unfinished capture, if the last session ended before Save or Cancel.
    let session = Rc::new(RefCell::new(read_session(&dir)));

    let event_loop = EventLoopBuilder::<Done>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let builder = WindowBuilder::new()
        .with_title("Notifly")
        .with_inner_size(LogicalSize::new(500.0, 340.0))
        .with_min_inner_size(LogicalSize::new(380.0, 240.0))
        .with_decorations(false)
        .with_transparent(true)
        .with_always_on_top(true)
        .with_visible(false);
    let window = Rc::new(builder.build(&event_loop)?);

    let handler_window = window.clone();
    let handler_config = config.clone();
    let handler_dir = dir.clone();
    let handler_session = session.clone();
    let uploads: Rc<RefCell<HashMap<String, storage::Upload>>> = Rc::default();
    #[cfg(target_os = "linux")]
    let voice: Rc<RefCell<Option<voice::Recording>>> = Rc::default();
    let webview_builder = WebViewBuilder::new()
        .with_transparent(true)
        // Served from its own address rather than a string, so WebKit treats the page as secure and allows the microphone.
        .with_custom_protocol("notifly".into(), |_, _| {
            wry::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(std::borrow::Cow::Borrowed(PAGE.as_bytes()))
                .unwrap_or_default()
        })
        .with_url("notifly://localhost/")
        // The window shows only its own page: it never navigates elsewhere or opens other windows.
        .with_navigation_handler(|url| url.starts_with("notifly://"))
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_initialization_script(if cfg!(target_os = "linux") { "window.__nativeRecord = true;" } else { "" })
        .with_ipc_handler(move |request| {
            let message = request.body();
            let (kind, text) = message.split_once('\n').unwrap_or((message, ""));
            let fail = |e: String| {
                let _ = proxy.send_event(Done::Error(e));
            };
            let draft_path = handler_dir.join("draft.json");
            match kind {
                "drag" => {
                    let _ = handler_window.drag_window();
                }
                // A file arrives as start, any number of chunks, then end, so large PDFs and recordings never sit in one message.
                "file-start" => {
                    #[derive(Deserialize)]
                    struct Start {
                        id: String,
                        name: String,
                    }
                    match serde_json::from_str::<Start>(text).map_err(|e| e.to_string()).and_then(|s| storage::Upload::start(&handler_config, &s.id, &s.name).map(|u| (s.id, u)).map_err(|e| e.to_string())) {
                        Ok((id, up)) => {
                            uploads.borrow_mut().insert(id, up);
                        }
                        Err(e) => fail(e),
                    }
                }
                "file-chunk" => {
                    let (id, data) = text.split_once('\n').unwrap_or(("", text));
                    let mut all = uploads.borrow_mut();
                    if let Some(up) = all.get_mut(id) {
                        let written = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| e.to_string()).and_then(|b| up.append(&b).map_err(|e| e.to_string()));
                        if let Err(e) = written {
                            if let Some(bad) = all.remove(id) {
                                let _ = fs::remove_file(&bad.temp);
                            }
                            fail(e);
                        }
                    }
                }
                "file-end" => {
                    if let Some(up) = uploads.borrow_mut().remove(text.trim()) {
                        match up.finish(&handler_config) {
                            Ok(snippet) => {
                                let _ = proxy.send_event(Done::Insert(snippet));
                            }
                            Err(e) => fail(e.to_string()),
                        }
                    }
                }
                // Ctrl+click on a link in the window opens it in the browser. Only web and mail links are allowed.
                "open" => {
                    let url = text.trim();
                    if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") {
                        open_link(url);
                    }
                }
                // Voice notes (Linux): the helper records, then the finished file is added like any other.
                #[cfg(target_os = "linux")]
                "record-start" => {
                    if voice.borrow().is_some() {
                        return;
                    }
                    match storage::attachments_dir(&handler_config).map_err(|e| e.to_string()).and_then(|d| voice::Recording::start(&d)) {
                        Ok(r) => *voice.borrow_mut() = Some(r),
                        Err(e) => {
                            let _ = proxy.send_event(Done::Eval(format!("window.notiflyRecordFailed({})", serde_json::Value::String(e))));
                        }
                    }
                }
                #[cfg(target_os = "linux")]
                "record-stop" => {
                    let Some(r) = voice.borrow_mut().take() else { return };
                    let saved = r.finish().ok_or_else(|| "Nothing was recorded.".to_string()).and_then(|temp| {
                        let dir = storage::attachments_dir(&handler_config).map_err(|e| e.to_string())?;
                        let name = storage::unique_name(&dir, text.trim());
                        fs::rename(&temp, dir.join(&name)).map_err(|e| e.to_string())?;
                        Ok(storage::snippet(&name))
                    });
                    match saved {
                        Ok(snippet) => {
                            let _ = proxy.send_event(Done::Insert(snippet));
                        }
                        Err(e) => {
                            let _ = proxy.send_event(Done::Eval(format!("window.notiflyRecordFailed({})", serde_json::Value::String(e))));
                        }
                    }
                }
                #[cfg(target_os = "linux")]
                "record-cancel" => {
                    if let Some(r) = voice.borrow_mut().take() {
                        r.discard();
                    }
                }
                "file-abort" => {
                    if let Some(up) = uploads.borrow_mut().remove(text.trim()) {
                        let _ = fs::remove_file(&up.temp);
                    }
                }
                // Autosave off: keep the text so the next Alt+C restores it.
                "draft" => {
                    if let Ok(m) = serde_json::from_str::<Message>(text) {
                        if m.text.trim().is_empty() {
                            let _ = fs::remove_file(&draft_path);
                        } else {
                            let _ = fs::write(&draft_path, serde_json::to_vec(&Draft { template: m.template, text: m.text }).unwrap_or_default());
                        }
                    }
                }
                // Autosave on: the text lives in a real note that later edits rewrite.
                "autosave" | "save" => {
                    let Ok(m) = serde_json::from_str::<Message>(text) else { return };
                    let current = handler_session.borrow().clone();
                    if m.text.trim().is_empty() && kind == "autosave" {
                        if let Some(old) = current {
                            let _ = fs::remove_file(&old.path);
                            set_session(&handler_dir, &handler_session, None);
                        }
                        return;
                    }
                    match storage::write_note(&handler_config, current.as_ref(), &m.template, &m.text) {
                        Ok(next) => {
                            let _ = fs::remove_file(&draft_path);
                            let _ = fs::write(handler_dir.join("last-template"), &m.template);
                            storage::touch_recent(&handler_dir, &m.template);
                            if kind == "save" {
                                set_session(&handler_dir, &handler_session, None);
                                let _ = proxy.send_event(Done::Hide);
                            } else {
                                set_session(&handler_dir, &handler_session, Some(next));
                            }
                        }
                        Err(e) => fail(e.to_string()),
                    }
                }
                "hide" => {
                    let _ = proxy.send_event(Done::Hide);
                }
                // A category made in the capture window by typing a new name.
                "category-create" => {
                    #[derive(Deserialize)]
                    struct Made {
                        id: String,
                        name: String,
                    }
                    if let Ok(made) = serde_json::from_str::<Made>(text) {
                        if let Err(e) = storage::add_category(&handler_config, &made.id, &made.name) {
                            fail(e.to_string());
                        }
                    }
                }
                "cancel" => {
                    if let Some(old) = handler_session.borrow().clone() {
                        let _ = fs::remove_file(&old.path);
                    }
                    set_session(&handler_dir, &handler_session, None);
                    let _ = fs::remove_file(&draft_path);
                    let _ = proxy.send_event(Done::Hide);
                }
                _ => {}
            }
        });
    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        webview_builder.build_gtk(window.default_vbox().ok_or("No window container")?)?
    };
    #[cfg(not(target_os = "linux"))]
    let webview = webview_builder.build(&*window)?;
    #[cfg(target_os = "linux")]
    allow_microphone(&webview);

    // The daemon writes "show" to our stdin on Alt+C; EOF means the daemon is gone.
    let stdin_proxy = event_loop.create_proxy();
    std::thread::spawn(move || {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if line == "show" {
                let _ = stdin_proxy.send_event(Done::Show);
            }
        }
        let _ = stdin_proxy.send_event(Done::Quit);
    });

    // A repeat Alt+C on an open window only brings it forward. Re-opening it would reload the page from
    // what was last saved and wipe whatever was typed since.
    let mut visible = false;
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Done::Show) if visible => window.set_focus(),
            Event::UserEvent(Done::Show) => {
                visible = true;
                let boot = boot_json(&config, &dir, &session);
                let _ = webview.evaluate_script(&format!("window.notiflyShow({boot})"));
                place_at_pointer(&window);
                window.set_visible(true);
                window.set_focus();
                // Test hook: run a script inside the window, so the whole path can be exercised without a keyboard.
                if let Some(js) = std::env::var_os("NOTIFLY_EVAL").and_then(|p| fs::read_to_string(p).ok()) {
                    let _ = webview.evaluate_script(&js);
                }
            }
            Event::UserEvent(Done::Hide) => {
                visible = false;
                window.set_visible(false);
            }
            Event::UserEvent(Done::Quit) => *flow = ControlFlow::Exit,
            Event::UserEvent(Done::Eval(js)) => {
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(Done::Insert(name)) => {
                let _ = webview.evaluate_script(&format!(
                    "window.notiflyInsert({})",
                    serde_json::Value::String(name)
                ));
            }
            Event::UserEvent(Done::Error(message)) => {
                let _ = webview.evaluate_script(&format!(
                    "window.notiflyError({})",
                    serde_json::Value::String(message)
                ));
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                visible = false;
                window.set_visible(false);
            }
            _ => {}
        }
    });
}

/// What the page needs to open: settings, plus whatever an earlier unfinished capture left behind.
/// With autosave the leftover is the autosaved note; without it, the saved draft. If the setting
/// changed in between, the leftover is converted so nothing ends up saved twice or lost.
fn boot_json(config_path: &Path, dir: &Path, session: &RefCell<Option<Session>>) -> String {
    let draft_path = dir.join("draft.json");
    let loaded = storage::load(config_path);
    let Ok(config) = &loaded else {
        let error = loaded.err().map(|e| e.to_string());
        return serde_json::json!({ "theme": {}, "notes": [], "templates": [], "numbers": {}, "autosave": false, "preview": false, "defaultTemplate": "", "folder": "", "restore": null, "error": error }).to_string();
    };
    let mut restore: Option<(String, String, Option<String>)> = None;
    let current = session.borrow().clone();
    if let Some(s) = current {
        match storage::read_body(&s.path) {
            Ok(text) => {
                restore = Some((s.template.clone(), text, s.path.file_stem().map(|n| n.to_string_lossy().into_owned())));
                if !config.autosave {
                    let _ = fs::remove_file(&s.path);
                    set_session(dir, session, None);
                }
            }
            Err(_) => set_session(dir, session, None),
        }
    }
    if restore.is_none() {
        if let Ok(d) = fs::read(&draft_path).map_err(|_| ()).and_then(|b| serde_json::from_slice::<Draft>(&b).map_err(|_| ())) {
            restore = Some((d.template, d.text, None));
        }
    }
    serde_json::json!({
        "theme": config.theme,
        "notes": config.notes,
        "templates": config.templates,
        "numbers": storage::numbers(config),
        "autosave": config.autosave,
        "preview": config.preview,
        "recent": storage::read_recent(dir),
        "defaultTemplate": fs::read_to_string(dir.join("last-template")).map(|s| s.trim().to_owned()).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "thought".into()),
        "folder": config.folder_name(),
        "restore": restore.map(|(template, text, file)| serde_json::json!({ "template": template, "text": text, "file": file })),
        "error": null,
    })
    .to_string()
}

/// Opens under the pointer, kept fully on screen.
fn place_at_pointer(window: &tao::window::Window) {
    let Mouse::Position { x, y } = Mouse::get_mouse_position() else { return };
    let (mut x, mut y) = (x, y);
    if let Some(monitor) = window.current_monitor().or_else(|| window.primary_monitor()) {
        let (screen, size, origin) = (monitor.size(), window.outer_size(), monitor.position());
        x = x.clamp(origin.x, (origin.x + screen.width as i32 - size.width as i32).max(origin.x));
        y = y.clamp(origin.y, (origin.y + screen.height as i32 - size.height as i32).max(origin.y));
    }
    window.set_outer_position(tao::dpi::PhysicalPosition::new(x, y));
}

/// Voice notes need the microphone. Only audio is allowed, and only inside this window.
#[cfg(target_os = "linux")]
fn allow_microphone(webview: &wry::WebView) {
    use webkit2gtk::glib::Cast;
    use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt};
    use wry::WebViewExtUnix;
    let view = webview.webview();
    if let Some(settings) = WebViewExt::settings(&view) {
        settings.set_enable_media_stream(true);
        settings.set_enable_mediasource(true);
    }
    view.connect_permission_request(|_, request| {
        let audio_only = request
            .downcast_ref::<UserMediaPermissionRequest>()
            .is_some_and(|r| r.is_for_audio_device() && !r.is_for_video_device());
        if audio_only {
            request.allow();
        } else {
            request.deny();
        }
        true
    });
}

fn open_link(url: &str) {
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
}
