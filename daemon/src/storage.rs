use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};
#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub body: String,
    pub placeholder: String,
    pub prefix: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    vault: PathBuf,
    folder: String,
    #[serde(default)]
    pub theme: BTreeMap<String, String>,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub templates: Vec<Template>,
    #[serde(default = "yes")]
    pub autosave: bool,
    #[serde(default)]
    pub preview: bool,
    #[serde(default = "default_shortcut")]
    pub shortcut: String,
}
fn yes() -> bool {
    true
}
fn default_shortcut() -> String {
    crate::hotkey::DEFAULT.to_owned()
}
/// A capture in progress that autosave has already written to the vault.
#[derive(Deserialize, Serialize, Clone)]
pub struct Session {
    pub path: PathBuf,
    pub id: String,
    pub created: String,
    pub template: String,
    pub prefix: String,
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn find_markers(root: &Path, found: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with('.') || entry.file_type()?.is_symlink() {
            continue;
        }
        if entry.file_type()?.is_dir() {
            if entry.path().join(".notifly-folder").is_file() {
                found.push(entry.path());
            }
            find_markers(&entry.path(), found)?;
        }
    }
    Ok(())
}
pub fn load(config_path: &Path) -> Result<Config, Box<dyn std::error::Error>> {
    let mut config: Config = serde_json::from_slice(&fs::read(config_path)?)?;
    // Categories made in the capture window wait in categories.json until the plugin adopts them.
    for t in read_categories(config_path) {
        if !config.templates.iter().any(|c| c.id == t.id) {
            config.templates.push(t);
        }
    }
    Ok(config)
}
fn categories_path(config_path: &Path) -> PathBuf {
    config_path.with_file_name("categories.json")
}
fn read_categories(config_path: &Path) -> Vec<Template> {
    fs::read(categories_path(config_path)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
/// Remembers a category made in the capture window. Returns false if the name or id is already taken.
pub fn add_category(config_path: &Path, id: &str, name: &str) -> Result<bool, Box<dyn std::error::Error>> {
    let id: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(48).collect();
    let name: String = name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect();
    if id.is_empty() || name.is_empty() {
        return Err(invalid("A category needs a name").into());
    }
    let mut all = read_categories(config_path);
    let known = load(config_path)?.templates;
    if known.iter().chain(all.iter()).any(|t| t.id == id || t.name.eq_ignore_ascii_case(&name)) {
        return Ok(false);
    }
    let prefix: String = clean_name(&name).chars().take(60).collect();
    all.push(Template { id, name, prefix, ..Default::default() });
    let tmp = categories_path(config_path).with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec(&all)?)?;
    fs::rename(&tmp, categories_path(config_path))?;
    Ok(true)
}
/// The categories used most recently, newest first, so the capture window can put them up front.
pub fn read_recent(dir: &Path) -> Vec<String> {
    fs::read(dir.join("recent.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
pub fn touch_recent(dir: &Path, id: &str) {
    let mut ids = read_recent(dir);
    ids.retain(|i| i != id);
    ids.insert(0, id.to_owned());
    ids.truncate(100);
    let _ = fs::write(dir.join("recent.json"), serde_json::to_vec(&ids).unwrap_or_default());
}
impl Config {
    pub fn folder_name(&self) -> &str {
        self.folder.rsplit('/').next().unwrap_or(&self.folder)
    }
    pub fn template(&self, id: &str) -> Template {
        self.templates.iter().find(|t| t.id == id).cloned().unwrap_or_else(|| Template {
            id: id.to_owned(),
            name: "Thought".into(),
            prefix: "Thought".into(),
            ..Default::default()
        })
    }
    fn resolve(&self) -> Result<PathBuf, Box<dyn std::error::Error>> {
        if self.folder.is_empty()
            || self
                .folder
                .split(['/', '\\'])
                .any(|s| s.is_empty() || s.starts_with('.') || s.contains(':'))
        {
            return Err(invalid("Invalid capture folder").into());
        }
        let vault = self.vault.canonicalize()?;
        let mut folder = vault.join(&self.folder);
        if !folder.exists() {
            let mut found = vec![];
            find_markers(&vault, &mut found)?;
            if found.len() != 1 {
                return Err(invalid(
                    "Capture folder missing or ambiguous. Open Notifly in Obsidian to choose it.",
                )
                .into());
            }
            folder = found.remove(0);
        }
        let folder = folder.canonicalize()?;
        if !folder.starts_with(&vault) {
            return Err(invalid("Capture folder is outside the vault").into());
        }
        Ok(folder)
    }
}
/// Next free number per file prefix: "Task 3.md" and "Thought 7.md" count separately.
pub fn numbers(config: &Config) -> HashMap<String, u32> {
    let mut next: HashMap<String, u32> = HashMap::new();
    let Ok(folder) = config.resolve() else { return next };
    for entry in fs::read_dir(folder).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".md") else { continue };
        let Some((prefix, n)) = stem.rsplit_once(' ') else { continue };
        if let Ok(n) = n.parse::<u32>() {
            let slot = next.entry(prefix.to_owned()).or_insert(1);
            *slot = (*slot).max(n + 1);
        }
    }
    next
}
fn number_for(config: &Config, prefix: &str) -> u32 {
    numbers(config).get(prefix).copied().unwrap_or(1)
}
fn render(template: &str, id: &str, created: &str, body: &str) -> String {
    format!(
        "---\nnotifly: true\nnotifly_type: {template}\ncssclasses: notifly-thought\nnotifly_id: {id}\ncreated: {created}\n---\n\n{}\n",
        body.trim()
    )
}
/// Reads a note's text without its frontmatter.
pub fn read_body(path: &Path) -> io::Result<String> {
    let raw = fs::read_to_string(path)?;
    let rest = raw.strip_prefix("---\n").and_then(|r| r.split_once("\n---\n")).map(|(_, b)| b).unwrap_or(&raw);
    Ok(rest.trim().to_owned())
}
fn reserve(folder: &Path, prefix: &str, mut number: u32) -> io::Result<(PathBuf, fs::File)> {
    loop {
        let file = folder.join(format!("{prefix} {number}.md"));
        match fs::OpenOptions::new().create_new(true).write(true).open(&file) {
            Ok(output) => return Ok((file, output)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => number += 1,
            Err(e) => return Err(e),
        }
    }
}
/// Creates the note, or rewrites the one a previous autosave created, never overwriting anything else.
pub fn write_note(
    config_path: &Path,
    session: Option<&Session>,
    template_id: &str,
    body: &str,
) -> Result<Session, Box<dyn std::error::Error>> {
    if body.trim().is_empty() {
        return Err(invalid("Write a thought first").into());
    }
    let config = load(config_path)?;
    let folder = config.resolve()?;
    let template = config.template(template_id);
    // Names come from a config file, so make them safe as a file name and as front matter before using them.
    let prefix = if template.prefix.trim().is_empty() { "Thought".to_owned() } else { clean_name(&template.prefix) };
    let template = Template {
        id: template.id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect(),
        ..template
    };
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(old) = session.filter(|s| s.path.is_file()) {
        let mut next = old.clone();
        next.template = template.id.clone();
        if old.prefix != prefix {
            // The category changed mid-capture: move the note to the new category's numbering.
            let (path, mut slot) = reserve(&folder, &prefix, number_for(&config, &prefix))?;
            slot.write_all(b"")?;
            fs::rename(&old.path, &path)?;
            next.path = path;
            next.prefix = prefix;
        }
        let tmp = folder.join(".notifly-write.tmp");
        fs::write(&tmp, render(&next.template, &next.id, &next.created, body))?;
        fs::rename(&tmp, &next.path)?;
        return Ok(next);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (path, mut output) = reserve(&folder, &prefix, number_for(&config, &prefix))?;
    write!(output, "{}", render(&template.id, &id, &now, body))?;
    output.sync_all()?;
    Ok(Session { path, id, created: now, template: template.id, prefix })
}
/// Where files added to a capture live, next to the thoughts.
pub fn attachments_dir(config_path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = load(config_path)?.resolve()?.join("attachments");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}
/// A safe file name: no folders, nothing Obsidian links cannot hold, never hidden.
pub fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base.chars().map(|c| if c.is_control() || "\\/:*?\"<>|#^[]".contains(c) { '-' } else { c }).collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim().to_owned();
    if cleaned.is_empty() { "File".into() } else { cleaned }
}
/// The name with " 1", " 2"... added before the extension until nothing else uses it.
pub fn unique_name(dir: &Path, name: &str) -> String {
    let name = clean_name(name);
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name.as_str(), ""),
    };
    let mut candidate = name.clone();
    let mut n = 0;
    while dir.join(&candidate).exists() {
        n += 1;
        candidate = format!("{stem} {n}{ext}");
    }
    candidate
}
/// Files Obsidian can show inside a note (pictures, sound, video, PDFs).
const EMBEDDABLE: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "mp3", "wav", "m4a", "ogg", "flac", "webm", "3gp", "mp4", "mkv", "mov", "ogv", "pdf",
];
/// The Markdown that puts a file into a note: shown in place when Obsidian can, a plain link otherwise.
pub fn snippet(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if EMBEDDABLE.contains(&ext.as_str()) { format!("![[{name}]]") } else { format!("[[{name}]]") }
}
/// A file arriving in pieces. It lives under a hidden name until complete, so Obsidian never sees half a file.
pub struct Upload {
    pub name: String,
    pub temp: PathBuf,
    file: fs::File,
}
impl Upload {
    pub fn start(config_path: &Path, id: &str, name: &str) -> Result<Upload, Box<dyn std::error::Error>> {
        let dir = attachments_dir(config_path)?;
        let safe_id: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        let temp = dir.join(format!(".notifly-{safe_id}.part"));
        Ok(Upload { name: name.to_owned(), file: fs::File::create(&temp)?, temp })
    }
    pub fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.file.write_all(bytes)
    }
    /// Moves the finished file into place and returns the Markdown for it.
    pub fn finish(self, config_path: &Path) -> Result<String, Box<dyn std::error::Error>> {
        self.file.sync_all()?;
        let dir = attachments_dir(config_path)?;
        let name = unique_name(&dir, &self.name);
        fs::rename(&self.temp, dir.join(&name))?;
        Ok(snippet(&name))
    }
}
#[cfg(test)]
pub fn save(config_path: &Path, body: &str, template_id: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(write_note(config_path, None, template_id, body)?.path)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captures_markdown_recovers_renames_and_rejects_traversal() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("thoughts")).unwrap();
        fs::write(root.join("thoughts/.notifly-folder"), "").unwrap();
        let config = root.join("config.json");
        fs::write(
            &config,
            serde_json::json!({"vault":root,"folder":"thoughts","templates":[{"id":"task","name":"Task","prefix":"Task"}]}).to_string(),
        )
        .unwrap();
        let one = save(&config, "Hello [[World]]", "thought").unwrap();
        assert!(one.ends_with("Thought 1.md"));
        assert!(fs::read_to_string(one).unwrap().contains("Hello [[World]]"));
        fs::rename(root.join("thoughts"), root.join("renamed")).unwrap();
        let two = save(&config, "Second", "thought").unwrap();
        assert!(two.starts_with(root.join("renamed")));
        assert!(two.ends_with("Thought 2.md"));
        // Autosave rewrites its own note and follows a category change without leaving a copy.
        let first = write_note(&config, None, "thought", "draft").unwrap();
        let again = write_note(&config, Some(&first), "thought", "draft more").unwrap();
        assert_eq!(first.path, again.path);
        let moved = write_note(&config, Some(&again), "task", "- [ ] draft more").unwrap();
        assert!(moved.path.ends_with("Task 1.md") && !first.path.exists());
        assert_eq!(read_body(&moved.path).unwrap(), "- [ ] draft more");
        fs::write(
            &config,
            serde_json::json!({"vault":root,"folder":"../escape"}).to_string(),
        )
        .unwrap();
        assert!(save(&config, "No", "thought").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn config_names_cannot_escape_the_folder_or_front_matter() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("t")).unwrap();
        fs::write(root.join("t/.notifly-folder"), "").unwrap();
        let config = root.join("config.json");
        let evil = serde_json::json!({"vault":root,"folder":"t","templates":[{"id":"x\nevil: true","name":"X","prefix":"../../escape"}]});
        fs::write(&config, evil.to_string()).unwrap();
        let saved = write_note(&config, None, "x\nevil: true", "hello").unwrap();
        assert!(saved.path.starts_with(root.join("t")), "note stayed in the capture folder");
        let text = fs::read_to_string(&saved.path).unwrap();
        assert!(!text.contains("evil: true"), "the id cannot add front matter lines");
        assert!(!root.join("escape 1.md").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn categories_made_in_the_capture_window_are_usable_at_once() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("t")).unwrap();
        fs::write(root.join("t/.notifly-folder"), "").unwrap();
        let config = root.join("config.json");
        fs::write(&config, serde_json::json!({"vault":root,"folder":"t","templates":[{"id":"thought","name":"Thought","prefix":"Thought"}]}).to_string()).unwrap();
        assert!(add_category(&config, "lab-1", "  Lab   meetings ").unwrap());
        assert!(!add_category(&config, "other", "lab meetings").unwrap(), "the same name is not made twice");
        assert!(!add_category(&config, "thought", "Whatever").unwrap(), "an existing id is not reused");
        assert!(add_category(&config, "bad", "   ").is_err());
        assert_eq!(load(&config).unwrap().templates.len(), 2);
        let saved = write_note(&config, None, "lab-1", "agenda").unwrap();
        assert!(saved.path.ends_with("Lab meetings 1.md"));
        assert!(fs::read_to_string(&saved.path).unwrap().contains("notifly_type: lab-1"));
        touch_recent(&root, "a");
        touch_recent(&root, "b");
        touch_recent(&root, "a");
        assert_eq!(read_recent(&root), vec!["a", "b"]);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn adds_files_safely() {
        assert_eq!(clean_name("../../etc/pass:wd.pdf"), "pass-wd.pdf");
        assert_eq!(clean_name(".hidden"), "hidden");
        assert_eq!(clean_name("a [b] #c.png"), "a -b- -c.png");
        assert_eq!(snippet("Report.PDF"), "![[Report.PDF]]");
        assert_eq!(snippet("notes.docx"), "[[notes.docx]]");
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("t")).unwrap();
        fs::write(root.join("t/.notifly-folder"), "").unwrap();
        let config = root.join("config.json");
        fs::write(&config, serde_json::json!({"vault":root,"folder":"t"}).to_string()).unwrap();
        for expected in ["Plan.pdf", "Plan 1.pdf", "Plan 2.pdf"] {
            let mut up = Upload::start(&config, "abc", "Plan.pdf").unwrap();
            up.append(b"%PDF-").unwrap();
            up.append(b"1.7").unwrap();
            assert_eq!(up.finish(&config).unwrap(), format!("![[{expected}]]"));
        }
        assert_eq!(fs::read(root.join("t/attachments/Plan.pdf")).unwrap(), b"%PDF-1.7");
        assert!(fs::read_dir(root.join("t/attachments")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".part")));
        fs::remove_dir_all(root).unwrap();
    }
}
