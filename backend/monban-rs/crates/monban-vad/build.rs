//! macOS only: ONNX Runtime's prebuilt static library (CoreML parts) calls
//! `__isPlatformVersionAtLeast` from clang's runtime. Without LTO Rust's compiler-builtins
//! provides it, but with the workspace's `lto = "thin"` release profile the symbol is dropped and
//! the link fails, so link `libclang_rt.osx.a` explicitly. Linux (the Docker image) needs nothing.

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(output) = Command::new("xcrun")
        .args(["clang", "--print-runtime-dir"])
        .output()
    else {
        println!(
            "cargo:warning=xcrun not found; release builds with LTO may fail to link ONNX Runtime"
        );
        return;
    };
    let dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success()
        || !std::path::Path::new(&dir)
            .join("libclang_rt.osx.a")
            .exists()
    {
        println!("cargo:warning=libclang_rt.osx.a not found; release builds with LTO may fail to link ONNX Runtime");
        return;
    }
    println!("cargo:rustc-link-search=native={dir}");
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
