//! WebAssembly calling convention for the engine's cooperative runtime, used by the project site's in-browser demo.
//! JavaScript writes a JSON start or resume message into memory it allocated here, and reads back the JSON step.
use libertty_engine::runtime::{Runtime, message};
use std::cell::{Cell, RefCell};

thread_local! {
    static RUNTIME: RefCell<Runtime> = RefCell::new(Runtime::default());
    static OUTPUT_LENGTH: Cell<usize> = const { Cell::new(0) };
}

#[unsafe(no_mangle)]
pub extern "C" fn libertty_initialize() {
    libertty_engine::initialize();
}

#[unsafe(no_mangle)]
pub extern "C" fn libertty_alloc(length: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; length].into_boxed_slice()).cast()
}

/// # Safety
/// The pointer and length must come from `libertty_alloc` or `libertty_message` and be freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn libertty_free(pointer: *mut u8, length: usize) {
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length)) });
}

/// Consumes an input buffer and returns an output buffer whose length `libertty_output_length` reports.
///
/// # Safety
/// The pointer and length must come from `libertty_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn libertty_message(pointer: *mut u8, length: usize, resume: u32) -> *mut u8 {
    let input = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length)) };
    let step = RUNTIME.with(|runtime| message(&mut runtime.borrow_mut(), &input, resume != 0));
    let output = serde_json::to_vec(&step)
        .expect("engine step")
        .into_boxed_slice();
    OUTPUT_LENGTH.with(|cell| cell.set(output.len()));
    Box::into_raw(output).cast()
}

#[unsafe(no_mangle)]
pub extern "C" fn libertty_output_length() -> usize {
    OUTPUT_LENGTH.with(Cell::get)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn exchange(input: &[u8], resume: bool) -> serde_json::Value {
        let pointer = libertty_alloc(input.len());
        unsafe { std::ptr::copy_nonoverlapping(input.as_ptr(), pointer, input.len()) };
        let output = unsafe { libertty_message(pointer, input.len(), resume as u32) };
        let length = libertty_output_length();
        let value = serde_json::from_slice(unsafe { std::slice::from_raw_parts(output, length) });
        unsafe { libertty_free(output, length) };
        value.unwrap()
    }
    #[test]
    fn steps_cross_the_memory_boundary() {
        libertty_initialize();
        let intent = exchange(br#"{"request":1,"operation":"detectIntent","args":["look at readme dot md",["look at"]],"now":0}"#, false);
        assert_eq!(intent["state"], "complete");
        assert_eq!(intent["value"]["kind"], "reading-file");
        assert_eq!(intent["value"]["operand"], "readme dot md");
        let pending = exchange(br#"{"request":2,"operation":"alternatives","args":["cat readme dot md",{"kind":"shell"},{"cwd":"/r","commands":["cat"],"paths":[],"history":[]},{}],"now":0}"#, false);
        assert_eq!(pending["state"], "pending");
        let malformed = exchange(b"{", true);
        assert_eq!(malformed["state"], "error");
    }
}
