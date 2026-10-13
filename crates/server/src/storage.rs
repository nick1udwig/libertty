use rand::{RngCore, rngs::OsRng};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{self, Write},
    path::Path,
};

pub fn random_hex(length: usize) -> String {
    let mut bytes = vec![0; length];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
pub fn random_uuid() -> String {
    let mut bytes = [0; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
pub fn private_directory(directory: &Path) -> io::Result<()> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)
}
pub fn create_private(file: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(file)?;
    output.write_all(bytes)?;
    output.sync_all()
}
pub fn atomic_write(file: &Path, bytes: &[u8]) -> io::Result<()> {
    private_directory(file.parent().expect("state file directory"))?;
    let temporary = file.with_extension(format!("json.{}", random_hex(8)));
    let result = (|| {
        create_private(&temporary, bytes)?;
        fs::rename(&temporary, file)
    })();
    let _ = fs::remove_file(&temporary);
    result
}
