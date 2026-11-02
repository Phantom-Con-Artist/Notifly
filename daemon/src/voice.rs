//! Voice notes on Linux. The embedded web page cannot reach the microphone reliably, so the helper records
//! through whichever system recorder exists (PipeWire, PulseAudio or ALSA) and saves a WAV file Obsidian can play.
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};

/// Speech at 24 kHz mono is clear and about 3 MB a minute.
fn recorders(out: &str) -> Vec<(&'static str, Vec<String>)> {
    let o = out.to_owned();
    vec![
        ("pw-record", vec!["--rate".into(), "24000".into(), "--channels".into(), "1".into(), "--format".into(), "s16".into(), o.clone()]),
        ("parecord", vec!["--rate=24000".into(), "--channels=1".into(), "--format=s16le".into(), "--file-format=wav".into(), o.clone()]),
        ("arecord", vec!["-q".into(), "-f".into(), "S16_LE".into(), "-r".into(), "24000".into(), "-c".into(), "1".into(), "-t".into(), "wav".into(), o]),
    ]
}

pub struct Recording {
    child: Child,
    pub temp: PathBuf,
}
impl Recording {
    /// Starts the first recorder that runs. The error is written for the person, not for a log.
    pub fn start(dir: &Path) -> Result<Recording, String> {
        let temp = dir.join(".notifly-voice.wav");
        let _ = fs::remove_file(&temp);
        for (program, args) in recorders(&temp.to_string_lossy()) {
            let Ok(mut child) = Command::new(program).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { continue };
            // A recorder that cannot find a microphone exits straight away; give it a moment to show that.
            sleep(Duration::from_millis(300));
            if matches!(child.try_wait(), Ok(None)) {
                return Ok(Recording { child, temp });
            }
        }
        let _ = fs::remove_file(&temp);
        Err("Notifly couldn't start recording. Check that a microphone is plugged in and allowed.".into())
    }
    /// Ends the recording cleanly, so the file's header is finished and it plays everywhere. Returns the file if it holds sound.
    pub fn finish(mut self) -> Option<PathBuf> {
        let _ = Command::new("kill").args(["-INT", &self.child.id().to_string()]).status();
        let until = Instant::now() + Duration::from_secs(4);
        while Instant::now() < until {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                break;
            }
            sleep(Duration::from_millis(40));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let size = fs::metadata(&self.temp).map(|m| m.len()).unwrap_or(0);
        (size > 1000).then(|| self.temp.clone()).or_else(|| {
            let _ = fs::remove_file(&self.temp);
            None
        })
    }
    pub fn discard(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.temp);
    }
}
