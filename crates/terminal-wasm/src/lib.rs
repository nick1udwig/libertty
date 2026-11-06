//! Browser terminal ownership over the pinned libghostty-rs bindings.
#![cfg(target_family = "wasm")]
use libghostty_vt::ffi as g;
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeMap, ffi::c_void, ptr};

type Result<T> = std::result::Result<T, String>;
fn check(code: i32) -> Result<()> {
    if code == g::Result::SUCCESS {
        Ok(())
    } else {
        Err(format!("Ghostty error {code}"))
    }
}
fn rgb(c: g::ColorRgb) -> Value {
    json!({"r":c.r,"g":c.g,"b":c.b})
}
fn color(v: &Value) -> g::ColorRgb {
    g::ColorRgb {
        r: v["r"].as_u64().unwrap_or(0) as u8,
        g: v["g"].as_u64().unwrap_or(0) as u8,
        b: v["b"].as_u64().unwrap_or(0) as u8,
    }
}
fn number(v: &Value, key: &str) -> usize {
    v[key].as_u64().unwrap_or(0) as usize
}
fn point(x: u16, y: u32) -> g::Point {
    g::Point {
        tag: g::PointTag::SCREEN,
        value: g::PointValue {
            coordinate: g::PointCoordinate { x, y },
        },
    }
}
#[derive(Default)]
struct Effects {
    events: Vec<Value>,
}
unsafe extern "C" fn reply(_: g::Terminal, user: *mut c_void, data: *const u8, len: usize) {
    unsafe {
        (*user.cast::<Effects>()).events.push(
            json!({"type":"input","source":"reply","data":std::slice::from_raw_parts(data,len)}),
        );
    }
}
unsafe extern "C" fn reset(_: g::Terminal, user: *mut c_void) {
    unsafe {
        (*user.cast::<Effects>())
            .events
            .push(json!({"type":"reset"}));
    }
}
unsafe extern "C" fn semantic(
    _: g::Terminal,
    user: *mut c_void,
    event: *const g::TerminalSemanticPrompt,
) {
    unsafe {
        let e = &*event;
        let string = |s: g::String| {
            if s.len == 0 {
                Value::Null
            } else {
                json!(String::from_utf8_lossy(std::slice::from_raw_parts(
                    s.ptr,
                    s.len.min(4096)
                )))
            }
        };
        (*user.cast::<Effects>()).events.push(json!({
            "type": "semantic",
            "kind": e.kind,
            "promptKind": e.prompt_kind,
            "command": string(e.command),
            "exitCode": e.has_exit_code.then_some(e.exit_code),
            "error": string(e.error),
        }));
    }
}
struct Terminal {
    handle: g::Terminal,
    render: g::RenderState,
    iterator: g::RenderStateRowIterator,
    key: g::KeyEncoder,
    key_event: g::KeyEvent,
    mouse: g::MouseEncoder,
    mouse_event: g::MouseEvent,
    gesture: g::SelectionGesture,
    effects: Box<Effects>,
    revision: u32,
    anchors: [g::TrackedGridRef; 2],
    previous: [Option<(usize, usize)>; 2],
}
impl Drop for Terminal {
    fn drop(&mut self) {
        unsafe {
            for a in self.anchors {
                if !a.is_null() {
                    g::ghostty_tracked_grid_ref_free(a);
                }
            }
            g::ghostty_selection_gesture_free(self.gesture, self.handle);
            g::ghostty_mouse_event_free(self.mouse_event);
            g::ghostty_mouse_encoder_free(self.mouse);
            g::ghostty_key_event_free(self.key_event);
            g::ghostty_key_encoder_free(self.key);
            g::ghostty_render_state_row_iterator_free(self.iterator);
            g::ghostty_render_state_free(self.render);
            g::ghostty_terminal_free(self.handle);
        }
    }
}
impl Terminal {
    fn new(cols: u16, rows: u16) -> Result<Self> {
        let mut t = Self {
            handle: ptr::null_mut(),
            render: ptr::null_mut(),
            iterator: ptr::null_mut(),
            key: ptr::null_mut(),
            key_event: ptr::null_mut(),
            mouse: ptr::null_mut(),
            mouse_event: ptr::null_mut(),
            gesture: ptr::null_mut(),
            effects: Box::default(),
            revision: 0,
            anchors: [ptr::null_mut(); 2],
            previous: [None; 2],
        };
        unsafe {
            check(g::ghostty_terminal_new(
                ptr::null(),
                &mut t.handle,
                cols,
                rows,
            ))?;
            check(g::ghostty_render_state_new(ptr::null(), &mut t.render))?;
        }
        unsafe {
            check(g::ghostty_render_state_row_iterator_new(
                ptr::null(),
                &mut t.iterator,
            ))?;
            check(g::ghostty_key_encoder_new(ptr::null(), &mut t.key))?;
            check(g::ghostty_key_event_new(ptr::null(), &mut t.key_event))?;
            check(g::ghostty_mouse_encoder_new(ptr::null(), &mut t.mouse))?;
            check(g::ghostty_mouse_event_new(ptr::null(), &mut t.mouse_event))?;
            check(g::ghostty_selection_gesture_new(
                ptr::null(),
                &mut t.gesture,
            ))?;
        }
        t.attach()?;
        Ok(t)
    }
    fn attach(&mut self) -> Result<()> {
        unsafe {
            check(g::ghostty_terminal_set(
                self.handle,
                g::TerminalOption::USERDATA,
                (&mut *self.effects as *mut Effects).cast(),
            ))?;
            for (key, callback) in [
                (g::TerminalOption::WRITE_PTY, reply as *const c_void),
                (
                    g::TerminalOption::SEMANTIC_PROMPT,
                    semantic as *const c_void,
                ),
                (g::TerminalOption::RESET, reset as *const c_void),
            ] {
                check(g::ghostty_terminal_set(self.handle, key, callback))?;
            }
            self.set(
                g::TerminalOption::CONTINUATION_MAX_BYTES,
                &(1024 * 1024usize),
            )?;
            self.set(g::TerminalOption::DEFAULT_CURSOR_BLINK, &false)
        }
    }
    // All query call sites pair a generated ABI key with its declared output type.
    fn get<T: Default>(&self, key: i32) -> Result<T> {
        let mut v = T::default();
        unsafe {
            check(g::ghostty_terminal_get(
                self.handle,
                key,
                (&mut v as *mut T).cast(),
            ))?;
        }
        Ok(v)
    }
    fn set<T>(&self, key: i32, value: &T) -> Result<()> {
        unsafe {
            check(g::ghostty_terminal_set(
                self.handle,
                key,
                (value as *const T).cast(),
            ))
        }
    }
    fn state(&self) -> Result<Value> {
        let b: g::TerminalScrollbar = self.get(g::TerminalData::SCROLLBAR)?;
        Ok(json!({
            "revision": self.revision,
            "screen": if self.get::<i32>(g::TerminalData::ACTIVE_SCREEN)? == 0 { "normal" } else { "alternate" },
            "totalRows": b.total,
            "scrollbackRows": b.total.saturating_sub(b.len),
            "viewportY": b.offset,
            "cursorX": self.get::<u16>(g::TerminalData::CURSOR_X)?,
            "cursorY": self.get::<u16>(g::TerminalData::CURSOR_Y)?,
            "cols": self.get::<u16>(g::TerminalData::COLS)?,
            "rows": self.get::<u16>(g::TerminalData::ROWS)?,
        }))
    }
    fn palette(&self) -> Result<[g::ColorRgb; 256]> {
        let mut p = [g::ColorRgb::default(); 256];
        unsafe {
            check(g::ghostty_terminal_get(
                self.handle,
                g::TerminalData::COLOR_PALETTE,
                p.as_mut_ptr().cast(),
            ))?;
        }
        Ok(p)
    }
    fn reference(&self, x: u16, y: u32) -> Result<g::GridRef> {
        let mut r = g::sized!(g::GridRef);
        unsafe {
            check(g::ghostty_terminal_grid_ref(
                self.handle,
                point(x, y),
                &mut r,
            ))?;
        }
        Ok(r)
    }
    fn rows(&self, start: usize, end: usize) -> Result<Value> {
        let cols = self.get::<u16>(g::TerminalData::COLS)?;
        let palette = self.palette()?;
        let mut rows = Vec::new();
        let mut chars = vec![0u32; 16];
        for y in start..end {
            let mut cells = Vec::with_capacity(cols as usize);
            let mut styles = Vec::new();
            let mut style_ids = BTreeMap::new();
            let mut text = String::new();
            let first = self.reference(0, y as u32)?;
            let mut row = 0;
            let mut wrapped = false;
            let mut continuation = false;
            unsafe {
                check(g::ghostty_grid_ref_row(&first, &mut row))?;
                check(g::ghostty_row_get(
                    row,
                    g::RowData::WRAP,
                    (&mut wrapped as *mut bool).cast(),
                ))?;
                check(g::ghostty_row_get(
                    row,
                    g::RowData::WRAP_CONTINUATION,
                    (&mut continuation as *mut bool).cast(),
                ))?;
            }
            for x in 0..cols {
                let r = self.reference(x, y as u32)?;
                let mut cell = 0;
                let mut style = g::sized!(g::Style);
                let mut wide = 0i32;
                let mut hyperlink = false;
                let mut semantic = 0i32;
                unsafe {
                    check(g::ghostty_grid_ref_cell(&r, &mut cell))?;
                    check(g::ghostty_grid_ref_style(&r, &mut style))?;
                    check(g::ghostty_cell_get(
                        cell,
                        g::CellData::WIDE,
                        (&mut wide as *mut i32).cast(),
                    ))?;
                    check(g::ghostty_cell_get(
                        cell,
                        g::CellData::HAS_HYPERLINK,
                        (&mut hyperlink as *mut bool).cast(),
                    ))?;
                    check(g::ghostty_cell_get(
                        cell,
                        g::CellData::SEMANTIC_CONTENT,
                        (&mut semantic as *mut i32).cast(),
                    ))?;
                }
                let mut count = 0;
                let mut result = unsafe {
                    g::ghostty_grid_ref_graphemes(&r, chars.as_mut_ptr(), chars.len(), &mut count)
                };
                if result == g::Result::OUT_OF_SPACE {
                    chars.resize(count, 0);
                    result = unsafe {
                        g::ghostty_grid_ref_graphemes(
                            &r,
                            chars.as_mut_ptr(),
                            chars.len(),
                            &mut count,
                        )
                    };
                }
                check(result)?;
                let s: String = chars[..count]
                    .iter()
                    .filter_map(|c| char::from_u32(*c))
                    .collect();
                if wide < 2 {
                    if s.is_empty() {
                        text.push(' ');
                    } else {
                        text.push_str(&s);
                    }
                }
                let uri = if hyperlink {
                    let mut b = vec![0u8; 256];
                    let mut len = 0;
                    let code = unsafe {
                        g::ghostty_grid_ref_hyperlink_uri(&r, b.as_mut_ptr(), b.len(), &mut len)
                    };
                    if code == g::Result::OUT_OF_SPACE {
                        b.resize(len, 0);
                        unsafe {
                            check(g::ghostty_grid_ref_hyperlink_uri(
                                &r,
                                b.as_mut_ptr(),
                                b.len(),
                                &mut len,
                            ))?;
                        }
                    } else {
                        check(code)?;
                    }
                    Some(String::from_utf8_lossy(&b[..len]).into_owned())
                } else {
                    None
                };
                let mut tag = 0i32;
                unsafe {
                    check(g::ghostty_cell_get(
                        cell,
                        g::CellData::CONTENT_TAG,
                        (&mut tag as *mut i32).cast(),
                    ))?;
                    if tag == g::CellContentTag::BG_COLOR_PALETTE {
                        let mut value = 0u8;
                        check(g::ghostty_cell_get(
                            cell,
                            g::CellData::COLOR_PALETTE,
                            (&mut value as *mut u8).cast(),
                        ))?;
                        style.bg_color = g::StyleColor {
                            tag: g::StyleColorTag::PALETTE,
                            value: g::StyleColorValue { palette: value },
                        };
                    }
                    if tag == g::CellContentTag::BG_COLOR_RGB {
                        let mut value = g::ColorRgb::default();
                        check(g::ghostty_cell_get(
                            cell,
                            g::CellData::COLOR_RGB,
                            (&mut value as *mut g::ColorRgb).cast(),
                        ))?;
                        style.bg_color = g::StyleColor {
                            tag: g::StyleColorTag::RGB,
                            value: g::StyleColorValue { rgb: value },
                        };
                    }
                }
                let encode = |c: g::StyleColor| unsafe {
                    match c.tag {
                        g::StyleColorTag::PALETTE => 1 + c.value.palette as u32,
                        g::StyleColorTag::RGB => {
                            0x1000000
                                | ((c.value.rgb.r as u32) << 16)
                                | ((c.value.rgb.g as u32) << 8)
                                | c.value.rgb.b as u32
                        }
                        _ => 0,
                    }
                };
                let flags = [
                    style.bold,
                    style.italic,
                    style.faint,
                    style.blink,
                    style.inverse,
                    style.invisible,
                    style.strikethrough,
                    style.overline,
                ]
                .iter()
                .enumerate()
                .fold(0u32, |mask, (bit, set)| mask | ((*set as u32) << bit));
                let key = [
                    flags,
                    style.underline as u32,
                    encode(style.fg_color),
                    encode(style.bg_color),
                    encode(style.underline_color),
                ];
                let id = if let Some(id) = style_ids.get(&key) {
                    *id
                } else {
                    let source = |c: g::StyleColor| unsafe {
                        match c.tag {
                            g::StyleColorTag::PALETTE => {
                                json!({"mode":"palette","value":c.value.palette})
                            }
                            g::StyleColorTag::RGB => json!({"mode":"rgb","value":rgb(c.value.rgb)}),
                            _ => json!({"mode":"default"}),
                        }
                    };
                    let resolved = |c: g::StyleColor| unsafe {
                        match c.tag {
                            g::StyleColorTag::PALETTE => rgb(palette[c.value.palette as usize]),
                            g::StyleColorTag::RGB => rgb(c.value.rgb),
                            _ => Value::Null,
                        }
                    };
                    let id = styles.len();
                    style_ids.insert(key, id);
                    styles.push(json!({
                        "foreground": resolved(style.fg_color),
                        "background": resolved(style.bg_color),
                        "foregroundSource": source(style.fg_color),
                        "backgroundSource": source(style.bg_color),
                        "underlineSource": source(style.underline_color),
                        "underlineColor": resolved(style.underline_color),
                        "style": {
                            "bold": style.bold,
                            "italic": style.italic,
                            "faint": style.faint,
                            "blink": style.blink,
                            "inverse": style.inverse,
                            "invisible": style.invisible,
                            "strikethrough": style.strikethrough,
                            "overline": style.overline,
                            "underline": style.underline,
                        },
                    }));
                    id
                };
                cells.push(json!([s, wide, id, uri, semantic]));
            }
            rows.push(json!({
                "index": y,
                "y": y - start,
                "text": text.trim_end(),
                "cells": cells,
                "styles": styles,
                "wrapped": wrapped,
                "wrapContinuation": continuation,
                "selection": null,
            }));
        }
        Ok(json!(rows))
    }
    fn snapshot(&self) -> Result<Vec<u8>> {
        let mut len = 0;
        let code =
            unsafe { g::ghostty_snapshot_encode_buf(self.handle, ptr::null_mut(), 0, &mut len) };
        if code != g::Result::OUT_OF_SPACE {
            check(code)?;
        }
        let mut bytes = vec![0; len];
        unsafe {
            check(g::ghostty_snapshot_encode_buf(
                self.handle,
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut len,
            ))?;
        }
        bytes.truncate(len);
        Ok(bytes)
    }
    fn restore(&mut self, bytes: &[u8]) -> Result<()> {
        let mut decoder = ptr::null_mut();
        let mut handle = ptr::null_mut();
        unsafe {
            check(g::ghostty_snapshot_decoder_new_buf(
                ptr::null(),
                &mut decoder,
                bytes.as_ptr(),
                bytes.len(),
            ))?;
            let code = g::ghostty_snapshot_decoder_decode(decoder, &mut handle);
            g::ghostty_snapshot_decoder_free(decoder);
            if code != 0 {
                if !handle.is_null() {
                    g::ghostty_terminal_free(handle);
                }
                return check(code);
            }
            for a in &mut self.anchors {
                if !a.is_null() {
                    g::ghostty_tracked_grid_ref_free(*a);
                    *a = ptr::null_mut();
                }
            }
            g::ghostty_selection_gesture_reset(self.gesture, self.handle);
            g::ghostty_terminal_free(self.handle);
            self.handle = handle;
        }
        self.previous = [None; 2];
        self.revision += 1;
        self.attach()?;
        self.effects.events.clear();
        Ok(())
    }
    fn selection(&self) -> Result<String> {
        let options = g::TerminalSelectionFormatOptions {
            unwrap: true,
            trim: true,
            ..g::sized!(g::TerminalSelectionFormatOptions)
        };
        let mut bytes = vec![0; 1024];
        let mut len = 0;
        let mut code = unsafe {
            g::ghostty_terminal_selection_format_buf(
                self.handle,
                options,
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut len,
            )
        };
        if code == g::Result::NO_VALUE {
            return Ok(String::new());
        }
        if code == g::Result::OUT_OF_SPACE {
            bytes.resize(len, 0);
            code = unsafe {
                g::ghostty_terminal_selection_format_buf(
                    self.handle,
                    options,
                    bytes.as_mut_ptr(),
                    bytes.len(),
                    &mut len,
                )
            };
        }
        check(code)?;
        Ok(String::from_utf8_lossy(&bytes[..len]).into_owned())
    }
    fn key(&mut self, v: &Value) -> Result<Value> {
        unsafe {
            let text = v["text"].as_str().unwrap_or("");
            g::ghostty_key_encoder_setopt_from_terminal(self.key, self.handle);
            g::ghostty_key_event_set_action(self.key_event, number(v, "action") as i32);
            g::ghostty_key_event_set_key(
                self.key_event,
                key_code(v["code"].as_str().unwrap_or("")),
            );
            g::ghostty_key_event_set_mods(self.key_event, number(v, "mods") as u16);
            g::ghostty_key_event_set_consumed_mods(self.key_event, number(v, "consumed") as u16);
            g::ghostty_key_event_set_utf8(self.key_event, text.as_ptr().cast(), text.len());
            g::ghostty_key_event_set_unshifted_codepoint(
                self.key_event,
                number(v, "unshifted") as u32,
            );
            let mut buf = vec![0u8; 256];
            let mut len = 0;
            let code = g::ghostty_key_encoder_encode(
                self.key,
                self.key_event,
                buf.as_mut_ptr().cast(),
                buf.len(),
                &mut len,
            );
            if code == g::Result::OUT_OF_SPACE {
                buf.resize(len, 0);
                check(g::ghostty_key_encoder_encode(
                    self.key,
                    self.key_event,
                    buf.as_mut_ptr().cast(),
                    buf.len(),
                    &mut len,
                ))?;
            } else {
                check(code)?;
            }
            buf.truncate(len);
            Ok(json!(buf))
        }
    }
    fn pointer(&mut self, v: &Value) -> Result<Value> {
        unsafe {
            g::ghostty_mouse_encoder_setopt_from_terminal(self.mouse, self.handle);
            g::ghostty_mouse_event_set_action(self.mouse_event, number(v, "action") as i32);
            if v["button"].is_null() {
                g::ghostty_mouse_event_clear_button(self.mouse_event);
            } else {
                g::ghostty_mouse_event_set_button(self.mouse_event, number(v, "button") as i32);
            }
            g::ghostty_mouse_event_set_mods(self.mouse_event, number(v, "mods") as u16);
            g::ghostty_mouse_event_set_position(
                self.mouse_event,
                g::MousePosition {
                    x: v["x"].as_f64().unwrap_or(0.) as f32,
                    y: v["y"].as_f64().unwrap_or(0.) as f32,
                },
            );
            let size = g::MouseEncoderSize {
                screen_width: number(v, "width") as u32,
                screen_height: number(v, "height") as u32,
                cell_width: number(v, "cellWidth") as u32,
                cell_height: number(v, "cellHeight") as u32,
                ..g::sized!(g::MouseEncoderSize)
            };
            g::ghostty_mouse_encoder_setopt(
                self.mouse,
                g::MouseEncoderOption::SIZE,
                (&size as *const g::MouseEncoderSize).cast(),
            );
            let pressed = v["pressed"] == true;
            g::ghostty_mouse_encoder_setopt(
                self.mouse,
                g::MouseEncoderOption::ANY_BUTTON_PRESSED,
                (&pressed as *const bool).cast(),
            );
            let mut buf = [0u8; 128];
            let mut len = 0;
            check(g::ghostty_mouse_encoder_encode(
                self.mouse,
                self.mouse_event,
                buf.as_mut_ptr().cast(),
                buf.len(),
                &mut len,
            ))?;
            Ok(json!(&buf[..len]))
        }
    }
    fn select(&mut self, v: &Value) -> Result<Value> {
        unsafe {
            if v["action"] == "clear" {
                check(g::ghostty_terminal_set(
                    self.handle,
                    g::TerminalOption::SELECTION,
                    ptr::null(),
                ))?;
                g::ghostty_selection_gesture_reset(self.gesture, self.handle);
                return Ok(Value::Null);
            }
            let action = match v["action"].as_str() {
                Some("press") => 0,
                Some("release") => 1,
                _ => 2,
            };
            if action == 0 {
                check(g::ghostty_terminal_set(
                    self.handle,
                    g::TerminalOption::SELECTION,
                    ptr::null(),
                ))?;
            }
            let mut event = ptr::null_mut();
            check(g::ghostty_selection_gesture_event_new(
                ptr::null(),
                &mut event,
                action,
            ))?;
            let result = (|| -> Result<()> {
                let b: g::TerminalScrollbar = self.get(g::TerminalData::SCROLLBAR)?;
                let x = number(v, "col").min(self.get::<u16>(g::TerminalData::COLS)? as usize - 1);
                let y = number(v, "row").min(b.len as usize - 1);
                let reference = self.reference(x as u16, b.offset as u32 + y as u32)?;
                check(g::ghostty_selection_gesture_event_set(
                    event,
                    g::SelectionGestureEventOption::REF,
                    (&reference as *const g::GridRef).cast(),
                ))?;
                let time = (v["time"].as_f64().unwrap_or(0.) * 1_000_000.) as u64;
                if action == 0 {
                    check(g::ghostty_selection_gesture_event_set(
                        event,
                        g::SelectionGestureEventOption::TIME_NS,
                        (&time as *const u64).cast(),
                    ))?;
                }
                if action != 1 {
                    let position = g::SurfacePosition {
                        x: v["x"].as_f64().unwrap_or(0.),
                        y: v["y"].as_f64().unwrap_or(0.),
                    };
                    check(g::ghostty_selection_gesture_event_set(
                        event,
                        g::SelectionGestureEventOption::POSITION,
                        (&position as *const g::SurfacePosition).cast(),
                    ))?;
                }
                if action == 0 {
                    let interval = 500_000_000u64;
                    let distance = v["repeatDistance"].as_f64().unwrap_or(5.);
                    check(g::ghostty_selection_gesture_event_set(
                        event,
                        g::SelectionGestureEventOption::REPEAT_INTERVAL_NS,
                        (&interval as *const u64).cast(),
                    ))?;
                    check(g::ghostty_selection_gesture_event_set(
                        event,
                        g::SelectionGestureEventOption::REPEAT_DISTANCE,
                        (&distance as *const f64).cast(),
                    ))?;
                }
                if action == 2 {
                    let geometry = g::SelectionGestureGeometry {
                        columns: self.get::<u16>(g::TerminalData::COLS)? as u32,
                        cell_width: number(v, "cellWidth") as u32,
                        padding_left: 0,
                        screen_height: number(v, "height") as u32,
                    };
                    check(g::ghostty_selection_gesture_event_set(
                        event,
                        g::SelectionGestureEventOption::GEOMETRY,
                        (&geometry as *const g::SelectionGestureGeometry).cast(),
                    ))?;
                    let rectangle = v["rectangle"] == true;
                    check(g::ghostty_selection_gesture_event_set(
                        event,
                        g::SelectionGestureEventOption::RECTANGLE,
                        (&rectangle as *const bool).cast(),
                    ))?;
                }
                let mut selection = g::sized!(g::Selection);
                let result = g::ghostty_selection_gesture_event(
                    self.gesture,
                    self.handle,
                    event,
                    &mut selection,
                );
                if result == g::Result::NO_VALUE {
                    return Ok(());
                }
                check(result)?;
                self.set(g::TerminalOption::SELECTION, &selection)
            })();
            g::ghostty_selection_gesture_event_free(event);
            result?;
            Ok(json!(self.selection()?))
        }
    }
    fn render(&mut self, full: bool) -> Result<Value> {
        unsafe {
            check(g::ghostty_render_state_update(self.render, self.handle))?;
            let mut cursor = g::sized!(g::RenderStateCursor);
            let mut dirty = 0i32;
            check(g::ghostty_render_state_get(
                self.render,
                g::RenderStateData::CURSOR,
                (&mut cursor as *mut g::RenderStateCursor).cast(),
            ))?;
            check(g::ghostty_render_state_get(
                self.render,
                g::RenderStateData::DIRTY,
                (&mut dirty as *mut i32).cast(),
            ))?;
            let b: g::TerminalScrollbar = self.get(g::TerminalData::SCROLLBAR)?;
            let mut rows = Vec::new();
            check(g::ghostty_render_state_get(
                self.render,
                g::RenderStateData::ROW_ITERATOR,
                (&mut self.iterator as *mut g::RenderStateRowIterator).cast(),
            ))?;
            let mut y = 0;
            while g::ghostty_render_state_row_iterator_next(self.iterator) {
                let mut changed = false;
                check(g::ghostty_render_state_row_get(
                    self.iterator,
                    g::RenderStateRowData::DIRTY,
                    (&mut changed as *mut bool).cast(),
                ))?;
                if full || dirty == 2 || changed {
                    let mut row = self
                        .rows(b.offset as usize + y, b.offset as usize + y + 1)?
                        .as_array_mut()
                        .unwrap()
                        .remove(0);
                    row["y"] = json!(y);
                    let mut selection = g::sized!(g::RenderStateRowSelection);
                    if g::ghostty_render_state_row_get(
                        self.iterator,
                        g::RenderStateRowData::SELECTION,
                        (&mut selection as *mut g::RenderStateRowSelection).cast(),
                    ) == 0
                    {
                        row["selection"] =
                            json!({"start":selection.start_x,"end":selection.end_x+1});
                    }
                    rows.push(row);
                }
                y += 1;
            }
            if !full {
                check(g::ghostty_render_state_clean(self.render))?;
            }
            Ok(json!({
                "dirty": (["clean", "partial", "full"][dirty as usize]),
                "changedRows": rows,
                "cursor": {
                    "x": cursor.viewport_has_value.then_some(cursor.viewport_x),
                    "y": cursor.viewport_has_value.then_some(cursor.viewport_y),
                    "visible": cursor.visible,
                    "blinking": cursor.blinking,
                    "style": (["bar", "block", "underline", "block-hollow"][cursor.visual_style as usize]),
                    "passwordInput": cursor.password_input,
                },
                "colors": {
                    "foreground": rgb(self.get(g::TerminalData::COLOR_FOREGROUND)?),
                    "background": rgb(self.get(g::TerminalData::COLOR_BACKGROUND)?),
                    "cursor": rgb(self.get(g::TerminalData::COLOR_CURSOR).unwrap_or_default()),
                },
            }))
        }
    }
    fn mode(&self, mode: u16) -> Result<bool> {
        let mut v = g::TerminalModeConfig { mode, value: false };
        unsafe {
            check(g::ghostty_terminal_get(
                self.handle,
                g::TerminalData::MODE,
                (&mut v as *mut g::TerminalModeConfig).cast(),
            ))?;
        }
        Ok(v.value)
    }
    fn changes(&mut self) -> Result<Value> {
        let state = self.state()?;
        let screen = usize::from(state["screen"] == "alternate");
        let total = number(&state, "totalRows");
        let history = number(&state, "scrollbackRows");
        let old = self.previous[screen];
        let mut p = g::PointCoordinate::default();
        let valid = !self.anchors[screen].is_null()
            && unsafe {
                g::ghostty_tracked_grid_ref_point(self.anchors[screen], g::PointTag::SCREEN, &mut p)
            } == 0;
        let trimmed =
            old.and_then(|(last, _)| valid.then(|| last.checked_sub(p.y as usize)).flatten());
        if total > 0 {
            unsafe {
                if self.anchors[screen].is_null() {
                    check(g::ghostty_terminal_grid_ref_track(
                        self.handle,
                        point(0, (total - 1) as u32),
                        &mut self.anchors[screen],
                    ))?;
                } else {
                    check(g::ghostty_tracked_grid_ref_set(
                        self.anchors[screen],
                        self.handle,
                        point(0, (total - 1) as u32),
                    ))?;
                }
            }
        }
        self.previous[screen] = Some((total.saturating_sub(1), history));
        Ok(
            json!({"state":state,"reset":trimmed.is_none(),"trimmed":trimmed.unwrap_or(0),"dirtyFrom":trimmed.map(|trim|old.unwrap().1.saturating_sub(trim)).unwrap_or(0)}),
        )
    }
}
#[derive(Default)]
struct Runtime {
    next: u32,
    terminals: BTreeMap<u32, Terminal>,
    output: Vec<u8>,
}
thread_local! {static RUNTIME:RefCell<Runtime>=RefCell::new(Runtime::default());}
impl Runtime {
    fn request(&mut self, v: Value) -> Result<Value> {
        let id = number(&v, "id") as u32;
        let op = v["op"].as_str().ok_or("Missing operation")?;
        if op == "create" {
            let t = Terminal::new(
                number(&v, "cols").clamp(1, 65535) as u16,
                number(&v, "rows").clamp(1, 65535) as u16,
            )?;
            let scrollback = number(&v, "scrollback");
            if scrollback == 0 {
                t.set(g::TerminalOption::SCROLLBACK_MAX_BYTES, &0usize)?;
            } else {
                unsafe {
                    check(g::ghostty_terminal_set(
                        t.handle,
                        g::TerminalOption::SCROLLBACK_MAX_BYTES,
                        ptr::null(),
                    ))?;
                }
            }
            t.set(g::TerminalOption::SCROLLBACK_MAX_LINES, &scrollback)?;
            self.next += 1;
            self.terminals.insert(self.next, t);
            return Ok(json!(self.next));
        }
        if op == "dispose" {
            self.terminals.remove(&id);
            return Ok(Value::Null);
        }
        let t = self.terminals.get_mut(&id).ok_or("Terminal disposed")?;
        match op {
            "state" => t.state(),
            "mode" => Ok(json!(t.mode(number(&v, "mode") as u16)?)),
            "rows" => t.rows(
                number(&v, "start"),
                number(&v, "end").min(number(&t.state()?, "totalRows")),
            ),
            "palette" => Ok(json!(t.palette()?.map(rgb).to_vec())),
            "changes" => t.changes(),
            "resize" => {
                unsafe {
                    check(g::ghostty_terminal_resize(
                        t.handle,
                        number(&v, "cols") as u16,
                        number(&v, "rows") as u16,
                        number(&v, "cellWidth") as u32,
                        number(&v, "cellHeight") as u32,
                    ))?;
                }
                t.revision += 1;
                t.previous = [None; 2];
                t.state()
            }
            "scroll" => {
                unsafe {
                    g::ghostty_terminal_scroll_viewport(
                        t.handle,
                        g::TerminalScrollViewport {
                            tag: g::TerminalScrollViewportTag::DELTA,
                            value: g::TerminalScrollViewportValue {
                                delta: v["delta"].as_i64().unwrap_or(0) as isize,
                            },
                        },
                    );
                }
                t.revision += 1;
                t.state()
            }
            "theme" => {
                for (name, key) in [
                    ("foreground", g::TerminalOption::COLOR_FOREGROUND),
                    ("background", g::TerminalOption::COLOR_BACKGROUND),
                    ("cursor", g::TerminalOption::COLOR_CURSOR),
                ] {
                    t.set(key, &color(&v[name]))?;
                }
                let mut palette = t.palette()?;
                for (i, c) in v["palette"]
                    .as_array()
                    .ok_or("Missing palette")?
                    .iter()
                    .enumerate()
                    .take(256)
                {
                    palette[i] = color(c);
                }
                let mut skip = g::ColorPaletteMask::default();
                skip.bits[0] = 0xffff;
                if let Some(indices) = v["preserved"].as_array() {
                    for index in indices {
                        if let Some(index) = index.as_u64().filter(|index| *index < 256) {
                            skip.bits[index as usize / 64] |= 1u64 << (index % 64);
                        }
                    }
                }
                let mut generated = palette;
                unsafe {
                    g::ghostty_color_palette_generate(
                        palette.as_ptr(),
                        &skip,
                        &color(&v["background"]),
                        &color(&v["foreground"]),
                        v["harmonious"] == true,
                        generated.as_mut_ptr(),
                    );
                }
                t.set(g::TerminalOption::COLOR_PALETTE, &generated)?;
                Ok(json!(generated.map(rgb).to_vec()))
            }
            "memory" => {
                let mut m = g::sized!(g::TerminalMemoryUsage);
                unsafe {
                    check(g::ghostty_terminal_get(
                        t.handle,
                        g::TerminalData::MEMORY_USAGE,
                        (&mut m as *mut g::TerminalMemoryUsage).cast(),
                    ))?;
                }
                Ok(json!({
                    "id": id,
                    "primaryBytes": m.primary_resident_bytes,
                    "alternateBytes": m.alternate_resident_bytes,
                    "imageBytes": m.primary_image_bytes + m.alternate_image_bytes,
                    "compressionSupported": m.compression_supported,
                }))
            }
            "render" => t.render(v["full"] == true),
            "paste" => {
                let mut data = v["text"].as_str().unwrap_or("").as_bytes().to_vec();
                let mut output = vec![0; data.len() + 12];
                let written = libghostty_vt::paste::encode(&mut data, t.mode(2004)?, &mut output)
                    .map_err(|error| error.to_string())?;
                output.truncate(written);
                Ok(json!(output))
            }
            "key" => t.key(&v),
            "pointer" => t.pointer(&v),
            "select" => t.select(&v),
            "selection" => Ok(json!(t.selection()?)),
            _ => Err(format!("Unknown operation {op}")),
        }
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn terminal_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()).cast()
}
/// # Safety
/// The pointer and length must describe a live allocation returned by `terminal_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn terminal_free(ptr: *mut u8, len: usize) {
    unsafe {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}
/// # Safety
/// Input must remain readable for the duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn terminal_request(ptr: *const u8, len: usize) -> *const u8 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    RUNTIME.with(|r| {
        let mut r = r.borrow_mut();
        let result = serde_json::from_slice(input)
            .map_err(|e| e.to_string())
            .and_then(|v| r.request(v));
        r.output = serde_json::to_vec(&match result {
            Ok(value) => json!({"value":value}),
            Err(error) => json!({"error":error}),
        })
        .unwrap();
        r.output.as_ptr()
    })
}
/// # Safety
/// Input must remain readable for the duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn terminal_write(id: u32, ptr: *const u8, len: usize) -> *const u8 {
    RUNTIME.with(|r| {
        let mut r = r.borrow_mut();
        let value = if let Some(t) = r.terminals.get_mut(&id) {
            unsafe { g::ghostty_terminal_vt_write(t.handle, ptr, len); }
            t.revision += 1;
            json!({"value": {"state": t.state().unwrap(), "events": std::mem::take(&mut t.effects.events)}})
        } else {
            json!({"error": "Terminal disposed"})
        };
        r.output = serde_json::to_vec(&value).unwrap();
        r.output.as_ptr()
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn terminal_output_length() -> usize {
    RUNTIME.with(|r| r.borrow().output.len())
}

fn key_code(code: &str) -> i32 {
    match code {
        "Unidentified" => g::Key::UNIDENTIFIED,
        "Backquote" => g::Key::BACKQUOTE,
        "Backslash" => g::Key::BACKSLASH,
        "BracketLeft" => g::Key::BRACKET_LEFT,
        "BracketRight" => g::Key::BRACKET_RIGHT,
        "Comma" => g::Key::COMMA,
        "Digit0" => g::Key::DIGIT_0,
        "Digit1" => g::Key::DIGIT_1,
        "Digit2" => g::Key::DIGIT_2,
        "Digit3" => g::Key::DIGIT_3,
        "Digit4" => g::Key::DIGIT_4,
        "Digit5" => g::Key::DIGIT_5,
        "Digit6" => g::Key::DIGIT_6,
        "Digit7" => g::Key::DIGIT_7,
        "Digit8" => g::Key::DIGIT_8,
        "Digit9" => g::Key::DIGIT_9,
        "Equal" => g::Key::EQUAL,
        "IntlBackslash" => g::Key::INTL_BACKSLASH,
        "IntlRo" => g::Key::INTL_RO,
        "IntlYen" => g::Key::INTL_YEN,
        "KeyA" => g::Key::A,
        "KeyB" => g::Key::B,
        "KeyC" => g::Key::C,
        "KeyD" => g::Key::D,
        "KeyE" => g::Key::E,
        "KeyF" => g::Key::F,
        "KeyG" => g::Key::G,
        "KeyH" => g::Key::H,
        "KeyI" => g::Key::I,
        "KeyJ" => g::Key::J,
        "KeyK" => g::Key::K,
        "KeyL" => g::Key::L,
        "KeyM" => g::Key::M,
        "KeyN" => g::Key::N,
        "KeyO" => g::Key::O,
        "KeyP" => g::Key::P,
        "KeyQ" => g::Key::Q,
        "KeyR" => g::Key::R,
        "KeyS" => g::Key::S,
        "KeyT" => g::Key::T,
        "KeyU" => g::Key::U,
        "KeyV" => g::Key::V,
        "KeyW" => g::Key::W,
        "KeyX" => g::Key::X,
        "KeyY" => g::Key::Y,
        "KeyZ" => g::Key::Z,
        "Minus" => g::Key::MINUS,
        "Period" => g::Key::PERIOD,
        "Quote" => g::Key::QUOTE,
        "Semicolon" => g::Key::SEMICOLON,
        "Slash" => g::Key::SLASH,
        "AltLeft" => g::Key::ALT_LEFT,
        "AltRight" => g::Key::ALT_RIGHT,
        "Backspace" => g::Key::BACKSPACE,
        "CapsLock" => g::Key::CAPS_LOCK,
        "ContextMenu" => g::Key::CONTEXT_MENU,
        "ControlLeft" => g::Key::CONTROL_LEFT,
        "ControlRight" => g::Key::CONTROL_RIGHT,
        "Enter" => g::Key::ENTER,
        "MetaLeft" => g::Key::META_LEFT,
        "MetaRight" => g::Key::META_RIGHT,
        "ShiftLeft" => g::Key::SHIFT_LEFT,
        "ShiftRight" => g::Key::SHIFT_RIGHT,
        "Space" => g::Key::SPACE,
        "Tab" => g::Key::TAB,
        "Convert" => g::Key::CONVERT,
        "KanaMode" => g::Key::KANA_MODE,
        "NonConvert" => g::Key::NON_CONVERT,
        "Delete" => g::Key::DELETE,
        "End" => g::Key::END,
        "Help" => g::Key::HELP,
        "Home" => g::Key::HOME,
        "Insert" => g::Key::INSERT,
        "PageDown" => g::Key::PAGE_DOWN,
        "PageUp" => g::Key::PAGE_UP,
        "ArrowDown" => g::Key::ARROW_DOWN,
        "ArrowLeft" => g::Key::ARROW_LEFT,
        "ArrowRight" => g::Key::ARROW_RIGHT,
        "ArrowUp" => g::Key::ARROW_UP,
        "NumLock" => g::Key::NUM_LOCK,
        "Numpad0" => g::Key::NUMPAD_0,
        "Numpad1" => g::Key::NUMPAD_1,
        "Numpad2" => g::Key::NUMPAD_2,
        "Numpad3" => g::Key::NUMPAD_3,
        "Numpad4" => g::Key::NUMPAD_4,
        "Numpad5" => g::Key::NUMPAD_5,
        "Numpad6" => g::Key::NUMPAD_6,
        "Numpad7" => g::Key::NUMPAD_7,
        "Numpad8" => g::Key::NUMPAD_8,
        "Numpad9" => g::Key::NUMPAD_9,
        "NumpadAdd" => g::Key::NUMPAD_ADD,
        "NumpadBackspace" => g::Key::NUMPAD_BACKSPACE,
        "NumpadClear" => g::Key::NUMPAD_CLEAR,
        "NumpadClearEntry" => g::Key::NUMPAD_CLEAR_ENTRY,
        "NumpadComma" => g::Key::NUMPAD_COMMA,
        "NumpadDecimal" => g::Key::NUMPAD_DECIMAL,
        "NumpadDivide" => g::Key::NUMPAD_DIVIDE,
        "NumpadEnter" => g::Key::NUMPAD_ENTER,
        "NumpadEqual" => g::Key::NUMPAD_EQUAL,
        "NumpadMemoryAdd" => g::Key::NUMPAD_MEMORY_ADD,
        "NumpadMemoryClear" => g::Key::NUMPAD_MEMORY_CLEAR,
        "NumpadMemoryRecall" => g::Key::NUMPAD_MEMORY_RECALL,
        "NumpadMemoryStore" => g::Key::NUMPAD_MEMORY_STORE,
        "NumpadMemorySubtract" => g::Key::NUMPAD_MEMORY_SUBTRACT,
        "NumpadMultiply" => g::Key::NUMPAD_MULTIPLY,
        "NumpadParenLeft" => g::Key::NUMPAD_PAREN_LEFT,
        "NumpadParenRight" => g::Key::NUMPAD_PAREN_RIGHT,
        "NumpadSubtract" => g::Key::NUMPAD_SUBTRACT,
        "NumpadSeparator" => g::Key::NUMPAD_SEPARATOR,
        "NumpadUp" => g::Key::NUMPAD_UP,
        "NumpadDown" => g::Key::NUMPAD_DOWN,
        "NumpadRight" => g::Key::NUMPAD_RIGHT,
        "NumpadLeft" => g::Key::NUMPAD_LEFT,
        "NumpadBegin" => g::Key::NUMPAD_BEGIN,
        "NumpadHome" => g::Key::NUMPAD_HOME,
        "NumpadEnd" => g::Key::NUMPAD_END,
        "NumpadInsert" => g::Key::NUMPAD_INSERT,
        "NumpadDelete" => g::Key::NUMPAD_DELETE,
        "NumpadPageUp" => g::Key::NUMPAD_PAGE_UP,
        "NumpadPageDown" => g::Key::NUMPAD_PAGE_DOWN,
        "Escape" => g::Key::ESCAPE,
        "F1" => g::Key::F1,
        "F2" => g::Key::F2,
        "F3" => g::Key::F3,
        "F4" => g::Key::F4,
        "F5" => g::Key::F5,
        "F6" => g::Key::F6,
        "F7" => g::Key::F7,
        "F8" => g::Key::F8,
        "F9" => g::Key::F9,
        "F10" => g::Key::F10,
        "F11" => g::Key::F11,
        "F12" => g::Key::F12,
        "F13" => g::Key::F13,
        "F14" => g::Key::F14,
        "F15" => g::Key::F15,
        "F16" => g::Key::F16,
        "F17" => g::Key::F17,
        "F18" => g::Key::F18,
        "F19" => g::Key::F19,
        "F20" => g::Key::F20,
        "F21" => g::Key::F21,
        "F22" => g::Key::F22,
        "F23" => g::Key::F23,
        "F24" => g::Key::F24,
        "F25" => g::Key::F25,
        "Fn" => g::Key::FN,
        "FnLock" => g::Key::FN_LOCK,
        "PrintScreen" => g::Key::PRINT_SCREEN,
        "ScrollLock" => g::Key::SCROLL_LOCK,
        "Pause" => g::Key::PAUSE,
        "BrowserBack" => g::Key::BROWSER_BACK,
        "BrowserFavorites" => g::Key::BROWSER_FAVORITES,
        "BrowserForward" => g::Key::BROWSER_FORWARD,
        "BrowserHome" => g::Key::BROWSER_HOME,
        "BrowserRefresh" => g::Key::BROWSER_REFRESH,
        "BrowserSearch" => g::Key::BROWSER_SEARCH,
        "BrowserStop" => g::Key::BROWSER_STOP,
        "Eject" => g::Key::EJECT,
        "LaunchApp1" => g::Key::LAUNCH_APP_1,
        "LaunchApp2" => g::Key::LAUNCH_APP_2,
        "LaunchMail" => g::Key::LAUNCH_MAIL,
        "MediaPlayPause" => g::Key::MEDIA_PLAY_PAUSE,
        "MediaSelect" => g::Key::MEDIA_SELECT,
        "MediaStop" => g::Key::MEDIA_STOP,
        "MediaTrackNext" => g::Key::MEDIA_TRACK_NEXT,
        "MediaTrackPrevious" => g::Key::MEDIA_TRACK_PREVIOUS,
        "Power" => g::Key::POWER,
        "Sleep" => g::Key::SLEEP,
        "AudioVolumeDown" => g::Key::AUDIO_VOLUME_DOWN,
        "AudioVolumeMute" => g::Key::AUDIO_VOLUME_MUTE,
        "AudioVolumeUp" => g::Key::AUDIO_VOLUME_UP,
        "WakeUp" => g::Key::WAKE_UP,
        "Copy" => g::Key::COPY,
        "Cut" => g::Key::CUT,
        "Paste" => g::Key::PASTE,
        _ => g::Key::UNIDENTIFIED,
    }
}

#[cfg(target_family = "wasm")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn crypto_getrandom(ptr: *mut u8, len: usize) -> bool;
}
#[unsafe(no_mangle)]
pub extern "C" fn terminal_init() {
    #[cfg(target_family = "wasm")]
    unsafe {
        libghostty_vt::sys::set_secure_random_source(Some(|bytes| {
            crypto_getrandom(bytes.as_mut_ptr(), bytes.len())
        }))
        .expect("install browser randomness");
    }
}

/// Copies a snapshot into the runtime output buffer without JSON expansion.
#[unsafe(no_mangle)]
pub extern "C" fn terminal_snapshot(id: u32) -> *const u8 {
    RUNTIME.with(|r| {
        let mut r = r.borrow_mut();
        match r
            .terminals
            .get(&id)
            .ok_or_else(|| "Terminal disposed".to_string())
            .and_then(Terminal::snapshot)
        {
            Ok(bytes) => {
                r.output = bytes;
                r.output.as_ptr()
            }
            Err(error) => {
                r.output = error.into_bytes();
                ptr::null()
            }
        }
    })
}
/// # Safety
/// Input must remain readable for the duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn terminal_restore(id: u32, ptr: *const u8, len: usize) -> *const u8 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    RUNTIME.with(|r| {
        let mut r = r.borrow_mut();
        let result = r
            .terminals
            .get_mut(&id)
            .ok_or_else(|| "Terminal disposed".to_string())
            .and_then(|t| {
                t.restore(bytes)?;
                t.state()
            });
        r.output = serde_json::to_vec(&match result {
            Ok(value) => json!({"value":value}),
            Err(error) => json!({"error":error}),
        })
        .unwrap();
        r.output.as_ptr()
    })
}
