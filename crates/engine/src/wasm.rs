use std::{cell::RefCell, collections::HashMap};
thread_local! {static BUFFERS:RefCell<HashMap<u32,Box<[u8]>>>=RefCell::new(HashMap::new());}
thread_local! {static RUNTIME:RefCell<crate::runtime::Runtime>=RefCell::new(crate::runtime::Runtime::default());}
#[unsafe(no_mangle)]
pub extern "C" fn termai_initialize() {
    crate::initialize();
}
#[derive(serde::Deserialize)]
struct PreparedContext {
    context: u32,
    catalog: crate::types::Catalog,
    environment: crate::validation::Environment,
}
#[derive(serde::Deserialize)]
struct PreparedStart {
    request: u32,
    input: String,
    context: u32,
    now: f64,
}
#[derive(serde::Deserialize)]
struct DirectoryPins {
    request: u32,
    directories: Vec<crate::runtime::DirectoryPin>,
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_directories(pointer: u32) -> u32 {
    let result = input(pointer)
        .and_then(|bytes| {
            crate::deserialize_bytes::<DirectoryPins>(&bytes).map_err(|e| e.to_string())
        })
        .and_then(|pins| {
            RUNTIME.with(|runtime| {
                runtime
                    .borrow_mut()
                    .pin_directories(pins.request, pins.directories)
            })
        });
    let reply = match result {
        Ok(()) => serde_json::json!({"ok":true,"value":null}),
        Err(error) => serde_json::json!({"ok":false,"error":error}),
    };
    retain(
        serde_json::to_vec(&reply)
            .expect("directory reply")
            .into_boxed_slice(),
    )
}
fn input(pointer: u32) -> Result<Box<[u8]>, String> {
    BUFFERS
        .with(|buffers| buffers.borrow_mut().remove(&pointer))
        .filter(|bytes| bytes.len() <= crate::INPUT_LIMIT)
        .ok_or_else(|| "Invalid engine allocation.".into())
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_context(pointer: u32) -> u32 {
    let result = input(pointer)
        .and_then(|bytes| {
            crate::deserialize_bytes::<PreparedContext>(&bytes).map_err(|e| e.to_string())
        })
        .and_then(|context| {
            RUNTIME.with(|runtime| {
                runtime.borrow_mut().prepare_context(
                    context.context,
                    context.catalog,
                    context.environment,
                )
            })
        });
    let reply = match result {
        Ok(()) => serde_json::json!({"ok":true,"value":null}),
        Err(error) => serde_json::json!({"ok":false,"error":error}),
    };
    retain(
        serde_json::to_vec(&reply)
            .expect("context reply")
            .into_boxed_slice(),
    )
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_suggest_prepared(pointer: u32) -> u32 {
    let result = input(pointer).and_then(|bytes| {
        crate::deserialize_bytes::<PreparedStart>(&bytes).map_err(|e| e.to_string())
    });
    let step = match result {
        Ok(call) => RUNTIME.with(|runtime| {
            runtime
                .borrow_mut()
                .start_prepared(call.request, call.input, call.context, call.now)
        }),
        Err(error) => crate::runtime::Step::Error { request: 0, error },
    };
    retain(
        serde_json::to_vec(&step)
            .expect("engine step")
            .into_boxed_slice(),
    )
}
fn borrowed<T>(
    pointer: u32,
    length: u32,
    read: impl FnOnce(&[u8]) -> Result<T, String>,
) -> Result<T, String> {
    BUFFERS.with(|buffers| {
        let buffers = buffers.borrow();
        let bytes = buffers
            .get(&pointer)
            .and_then(|bytes| bytes.get(..length as usize))
            .ok_or("Invalid engine buffer.")?;
        read(bytes)
    })
}
fn retain_step(step: crate::runtime::Step) -> u32 {
    retain(
        serde_json::to_vec(&step)
            .expect("engine step")
            .into_boxed_slice(),
    )
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_suggest_buffer(
    pointer: u32,
    length: u32,
    request: u32,
    context: u32,
    now: f64,
) -> u32 {
    let input = borrowed(pointer, length, |bytes| {
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|e| e.to_string())
    });
    retain_step(match input {
        Ok(input) => RUNTIME.with(|runtime| {
            runtime
                .borrow_mut()
                .start_prepared(request, input, context, now)
        }),
        Err(error) => crate::runtime::Step::Error { request, error },
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_resume_buffer(pointer: u32, length: u32) -> u32 {
    let step = borrowed(pointer, length, |bytes| {
        Ok(RUNTIME.with(|runtime| crate::runtime::message(&mut runtime.borrow_mut(), bytes, true)))
    });
    retain_step(step.unwrap_or_else(|error| crate::runtime::Step::Error { request: 0, error }))
}
fn retain(bytes: Box<[u8]>) -> u32 {
    let pointer = bytes.as_ptr() as u32;
    BUFFERS.with(|buffers| {
        let mut buffers = buffers.borrow_mut();
        if bytes.is_empty()
            || buffers.len() >= 64
            || buffers.values().map(|bytes| bytes.len()).sum::<usize>() + bytes.len()
                > 128 * 1024 * 1024
        {
            return 0;
        }
        buffers.insert(pointer, bytes);
        pointer
    })
}
fn asynchronous(pointer: u32, resume: bool) -> u32 {
    let bytes = BUFFERS.with(|buffers| buffers.borrow_mut().remove(&pointer));
    let response = bytes.map_or_else(
        || crate::runtime::Step::Error {
            request: 0,
            error: "Invalid engine allocation.".into(),
        },
        |bytes| {
            RUNTIME
                .with(|runtime| crate::runtime::message(&mut runtime.borrow_mut(), &bytes, resume))
        },
    );
    retain(
        serde_json::to_vec(&response)
            .expect("engine step")
            .into_boxed_slice(),
    )
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_start(pointer: u32) -> u32 {
    asynchronous(pointer, false)
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_resume(pointer: u32) -> u32 {
    asynchronous(pointer, true)
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_cancel(request: u32) {
    RUNTIME.with(|runtime| runtime.borrow_mut().cancel(request));
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_reset() {
    RUNTIME.with(|runtime| runtime.borrow_mut().reset());
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_alloc(length: u32) -> u32 {
    if length == 0 || length as usize > crate::INPUT_LIMIT {
        return 0;
    }
    retain(vec![0; length as usize].into_boxed_slice())
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_dispatch(pointer: u32) -> u32 {
    let bytes = BUFFERS.with(|buffers| buffers.borrow_mut().remove(&pointer));
    let response = bytes.map_or_else(
        || br#"{"ok":false,"error":"Invalid engine allocation."}"#.to_vec(),
        |bytes| crate::exchange(&bytes),
    );
    retain(response.into_boxed_slice())
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_len(pointer: u32) -> u32 {
    BUFFERS.with(|buffers| {
        buffers
            .borrow()
            .get(&pointer)
            .map_or(0, |bytes| bytes.len() as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn termai_free(pointer: u32) {
    BUFFERS.with(|buffers| {
        buffers.borrow_mut().remove(&pointer);
    });
}
