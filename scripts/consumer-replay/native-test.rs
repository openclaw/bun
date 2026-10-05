
#[cfg(all(test, windows))]
mod real_fork_qualification {
    use super::*;

    #[test]
    fn native_fork_materializes_reuses_and_executes_sqlite() {
        assert!(available());
        let manifest: Manifest = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(manifest.authenticode_signed, Some(false));
        assert_eq!(manifest.test_only, Some(true));
        let source = PathBuf::from(std::env::var_os("RUNTIME_SOURCE").unwrap());
        let state = PathBuf::from(std::env::var_os("RUNTIME_STATE").unwrap());
        assert!(!state.exists());
        let runtime = seed_at(&source, &state, MANIFEST, &verify_revision).unwrap();
        assert!(runtime.bun.starts_with(state.join("tools/desktop-runtime")));
        let handle = fs::File::open(&runtime.bun).unwrap();
        let reused = seed_at(&source, &state, MANIFEST, &verify_revision).unwrap();
        assert_eq!(runtime.bun, reused.bun);
        let output = Command::new(&runtime.bun)
            .args(["-e", "const {Database}=require('bun:sqlite'); const db=new Database(':memory:'); db.run('create table probe (value integer)'); db.run('insert into probe values (42)'); console.log(JSON.stringify({arch:process.arch,platform:process.platform,commit:Bun.revision,sqlite:db.query('select value from probe').get().value})); db.close();"])
            .env_clear()
            .output()
            .unwrap();
        let actual: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(actual, serde_json::json!({
            "arch": if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" },
            "platform": "win32", "commit": manifest.commit, "sqlite": 42,
        }));
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        println!("REAL_FORK_MATERIALIZER_PROOF {}", actual);
        drop(handle);
        fs::remove_dir_all(state).unwrap();
    }
}
