use global_hotkey::hotkey::{Code, HotKey, Modifiers};

pub const DEFAULT: &str = "Alt+C";

/// Turns text like "Ctrl+Shift+K" into a key the system can listen for.
pub fn parse(text: &str) -> Result<HotKey, String> {
    let mut mods = Modifiers::empty();
    let parts: Vec<&str> = text.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
    let Some((key, held)) = parts.split_last() else {
        return Err("No shortcut set".into());
    };
    for m in held {
        mods |= match m.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => Modifiers::CONTROL,
            "alt" | "option" => Modifiers::ALT,
            "shift" => Modifiers::SHIFT,
            "meta" | "super" | "cmd" | "command" | "win" => Modifiers::META,
            other => return Err(format!("Unknown key \"{other}\" in the shortcut")),
        };
    }
    if mods.is_empty() {
        return Err("A shortcut needs Ctrl, Alt, Shift or Meta too".into());
    }
    let name = match key.len() {
        1 if key.chars().all(|c| c.is_ascii_alphabetic()) => format!("Key{}", key.to_ascii_uppercase()),
        1 if key.chars().all(|c| c.is_ascii_digit()) => format!("Digit{key}"),
        _ => key.to_string(),
    };
    let code: Code = name.parse().map_err(|_| format!("Can't use \"{key}\" as a shortcut key"))?;
    Ok(HotKey::new(Some(mods), code))
}

/// The same shortcut in the form Linux desktops ask for on Wayland.
pub fn for_desktop(text: &str) -> String {
    let mut out: Vec<String> = vec![];
    let parts: Vec<&str> = text.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
    for (i, p) in parts.iter().enumerate() {
        if i + 1 == parts.len() {
            out.push(if p.len() == 1 { p.to_ascii_lowercase() } else if p.eq_ignore_ascii_case("space") { "space".into() } else { p.to_string() });
        } else {
            out.push(match p.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => "CTRL",
                "alt" | "option" => "ALT",
                "shift" => "SHIFT",
                _ => "LOGO",
            }.into());
        }
    }
    out.join("+")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_shortcuts() {
        assert_eq!(parse("Alt+C").unwrap().id(), HotKey::new(Some(Modifiers::ALT), Code::KeyC).id());
        assert_eq!(parse("ctrl + shift + 7").unwrap().id(), HotKey::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Digit7).id());
        assert_eq!(parse("Alt+F5").unwrap().id(), HotKey::new(Some(Modifiers::ALT), Code::F5).id());
        assert_eq!(parse("Alt+Space").unwrap().id(), HotKey::new(Some(Modifiers::ALT), Code::Space).id());
        assert!(parse("C").is_err() && parse("").is_err() && parse("Alt+").is_err() && parse("Hyper+C").is_err());
        assert_eq!(for_desktop("Ctrl+Shift+K"), "CTRL+SHIFT+k");
    }
}
