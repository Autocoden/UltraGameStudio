//! UGS-owned skill packages. No model-selected filesystem roots.
mod api;
mod catalog;
mod host;
mod lifecycle;
mod management;
pub(crate) mod native_cli;
pub(crate) mod native_launch;
pub(crate) mod native_mcp;
#[cfg(test)]
mod process_tests;
mod service;
mod state;
mod transactions;
#[cfg(test)]
mod transactions_tests;
mod types;
mod validation;

pub use catalog::legacy_owned_entries;
pub use host::{SkillDesktopHost, SkillHostActor, SkillHostBindingRequest};
pub use service::SkillService;
pub use types::*;

#[cfg(test)]
mod validation_tests;

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    pub struct Fixture(pub PathBuf);
    impl Fixture {
        pub fn new(label: &str) -> Self {
            let base = PathBuf::from(
                "C:/Users/fengwei/AppData/Local/hermes/cache/scratch/ugs-autoskill-build-20261009",
            );
            let path = base.join(format!(
                "{label}-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(path.join("project")).unwrap();
            std::fs::create_dir_all(path.join("global")).unwrap();
            Self(path)
        }
        pub fn project(&self) -> PathBuf {
            self.0.join("project")
        }
        pub fn global(&self) -> PathBuf {
            self.0.join("global")
        }
        pub fn write(&self, path: impl AsRef<Path>, text: &str) {
            let path = self.0.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    pub fn link_dir(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let output = std::process::Command::new("cmd.exe")
                .args(["/C", "mklink", "/J"])
                .arg(link.to_string_lossy().replace('/', "\\"))
                .arg(target.to_string_lossy().replace('/', "\\"))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "junction fixture creation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }
    pub fn skill(name: &str, rule: &str) -> String {
        format!("---\nname: {name}\ndescription: Use when testing skills. Follow verified rules.\n---\n\n# {name}\n\n{rule}\n")
    }
}
