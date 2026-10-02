//! Development-only link between `mun dev` and a running native host.
//!
//! Transport: one loopback TCP connection the host opens to the toolchain,
//! framed as a 4-byte big-endian length followed by a UTF-8 JSON message.
//! Frames are bounded; the first message is a versioned, token-authenticated
//! hello. Production launches never construct a [`DevLink`]: the host enables
//! it only for the explicit `--dev` invocation.

use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream},
    sync::{Arc, Mutex},
    thread,
};

use serde_json::{Value, json};
use winit::event_loop::EventLoopProxy;

use crate::accessibility::NativeEvent;

pub const DEV_PROTOCOL_VERSION: u64 = 2;
/// Largest accepted frame. Semantic programs are far smaller; anything larger
/// is a protocol error, not a reason to allocate.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub enum DevCommand {
    Update {
        id: u64,
        base_revision: u64,
        revision: u64,
        program: Value,
        preserve: Vec<String>,
    },
    Patch {
        id: u64,
        base_revision: u64,
        revision: u64,
        operations: Vec<Value>,
        preserve: Vec<String>,
    },
    Inspect {
        id: u64,
        include_values: bool,
    },
    Disconnected(Option<String>),
}

pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Value>> {
    let mut length = [0; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("dev frame of {length} bytes exceeds {MAX_FRAME_BYTES}"),
        ));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub fn write_frame(writer: &mut impl Write, message: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(message)?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "dev frame too large",
        ));
    }
    writer.write_all(&(body.len() as u32).to_be_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}

fn revisions(message: &Value) -> Result<(u64, u64), String> {
    let base_revision = message
        .get("baseRevision")
        .and_then(Value::as_u64)
        .ok_or("dev update without baseRevision")?;
    let revision = message
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or("dev update without revision")?;
    if revision != base_revision.saturating_add(1) {
        return Err(format!(
            "dev revision must advance by one: {base_revision} -> {revision}"
        ));
    }
    Ok((base_revision, revision))
}

fn preserve_states(message: &Value) -> Vec<String> {
    message
        .get("preserve")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn patch_parent_mut<'a>(root: &'a mut Value, path: &[Value]) -> Result<&'a mut Value, String> {
    let mut current = root;
    for part in path {
        current = match part {
            Value::String(key) => current
                .as_object_mut()
                .and_then(|object| object.get_mut(key))
                .ok_or_else(|| format!("patch object path is missing: {key}"))?,
            Value::Number(index) => {
                let index = index.as_u64().ok_or("patch array index must be unsigned")? as usize;
                current
                    .as_array_mut()
                    .and_then(|array| array.get_mut(index))
                    .ok_or_else(|| format!("patch array index out of range: {index}"))?
            }
            _ => return Err("patch path segments must be strings or array indices".into()),
        };
    }
    Ok(current)
}

/// Apply a dev-only JSON path patch to a clone. The caller commits it only
/// after `Runtime::hot_update` accepts the reconstructed full program.
pub fn apply_program_patch(program: &Value, operations: &[Value]) -> Result<Value, String> {
    let mut result = program.clone();
    for operation in operations {
        let kind = operation
            .get("op")
            .and_then(Value::as_str)
            .ok_or("patch operation without op")?;
        let path = operation
            .get("path")
            .and_then(Value::as_array)
            .ok_or("patch operation without path")?;
        if path.is_empty() {
            if kind != "set" {
                return Err("cannot remove the program root".into());
            }
            result = operation
                .get("value")
                .cloned()
                .ok_or("root set without value")?;
            continue;
        }
        let (parent_path, tail) = path.split_at(path.len() - 1);
        let parent = patch_parent_mut(&mut result, parent_path)?;
        match (kind, &tail[0]) {
            ("set", Value::String(key)) => {
                let value = operation
                    .get("value")
                    .cloned()
                    .ok_or("patch set without value")?;
                parent
                    .as_object_mut()
                    .ok_or("patch object parent is invalid")?
                    .insert(key.clone(), value);
            }
            ("set", Value::Number(index)) => {
                let index = index.as_u64().ok_or("patch array index must be unsigned")? as usize;
                let array = parent
                    .as_array_mut()
                    .ok_or("patch array parent is invalid")?;
                if index >= array.len() {
                    return Err(format!("patch array index out of range: {index}"));
                }
                array[index] = operation
                    .get("value")
                    .cloned()
                    .ok_or("patch set without value")?;
            }
            ("remove", Value::String(key)) => {
                let object = parent
                    .as_object_mut()
                    .ok_or("patch object parent is invalid")?;
                if object.remove(key).is_none() {
                    return Err(format!("patch remove path is missing: {key}"));
                }
            }
            ("remove", Value::Number(_)) => {
                return Err(
                    "array element removal is unsupported; replace the array atomically".into(),
                );
            }
            (_, _) if kind != "set" && kind != "remove" => {
                return Err(format!("unsupported patch operation: {kind}"));
            }
            _ => return Err("patch path segments must be strings or array indices".into()),
        }
    }
    Ok(result)
}

fn parse_command(message: &Value) -> Result<DevCommand, String> {
    let id = message.get("id").and_then(Value::as_u64).unwrap_or(0);
    match message.get("type").and_then(Value::as_str) {
        Some("update") => {
            let (base_revision, revision) = revisions(message)?;
            let program = message
                .get("program")
                .filter(|program| program.is_object())
                .cloned()
                .ok_or("update without program")?;
            Ok(DevCommand::Update {
                id,
                base_revision,
                revision,
                program,
                preserve: preserve_states(message),
            })
        }
        Some("patch") => {
            let (base_revision, revision) = revisions(message)?;
            let operations = message
                .get("operations")
                .and_then(Value::as_array)
                .cloned()
                .ok_or("patch without operations")?;
            Ok(DevCommand::Patch {
                id,
                base_revision,
                revision,
                operations,
                preserve: preserve_states(message),
            })
        }
        Some("inspect") => Ok(DevCommand::Inspect {
            id,
            include_values: message
                .get("includeValues")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        other => Err(format!("unsupported dev message {other:?}")),
    }
}

#[derive(Clone)]
pub struct DevLink {
    writer: Arc<Mutex<TcpStream>>,
}

impl DevLink {
    /// Connect to the toolchain. Only loopback endpoints are accepted.
    pub fn connect(
        endpoint: &str,
        token: &str,
        proxy: EventLoopProxy<NativeEvent>,
    ) -> io::Result<Self> {
        let address: SocketAddr = endpoint
            .parse()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid dev endpoint"))?;
        if !address.ip().is_loopback() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "dev endpoint must be a loopback address",
            ));
        }
        let mut stream = TcpStream::connect(address)?;
        stream.set_nodelay(true)?;
        write_frame(
            &mut stream,
            &json!({
                "type": "hello",
                "protocol": DEV_PROTOCOL_VERSION,
                "token": token,
                "semanticUiIrVersion": mun_runtime::SEMANTIC_UI_IR_VERSION,
                "pid": std::process::id(),
            }),
        )?;
        let mut reader = stream.try_clone()?;
        let link = Self {
            writer: Arc::new(Mutex::new(stream)),
        };
        let replies = link.clone();
        thread::Builder::new()
            .name("mun-dev-link".into())
            .spawn(move || {
                let reason = loop {
                    match read_frame(&mut reader) {
                        Ok(Some(message)) => match parse_command(&message) {
                            Ok(command) => {
                                if proxy.send_event(NativeEvent::Dev(command)).is_err() {
                                    break None;
                                }
                            }
                            Err(error) => replies.send(&json!({
                                "type": "protocol-error",
                                "message": error,
                            })),
                        },
                        Ok(None) => break None,
                        Err(error) => break Some(error.to_string()),
                    }
                };
                let _ = proxy.send_event(NativeEvent::Dev(DevCommand::Disconnected(reason)));
            })?;
        Ok(link)
    }

    /// Best effort: a closed toolchain is reported by the reader thread.
    pub fn send(&self, message: &Value) {
        if let Ok(mut stream) = self.writer.lock() {
            let _ = write_frame(&mut *stream, message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_reject_oversized_lengths() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, &json!({"type": "inspect", "id": 3})).unwrap();
        let mut reader = buffer.as_slice();
        assert_eq!(
            read_frame(&mut reader).unwrap(),
            Some(json!({"type": "inspect", "id": 3}))
        );
        assert_eq!(read_frame(&mut reader).unwrap(), None);

        let oversized = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes();
        let error = read_frame(&mut oversized.as_slice()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn commands_parse_and_unknown_messages_are_rejected() {
        let command = parse_command(&json!({
            "type": "update", "id": 7, "baseRevision": 2, "revision": 3, "program": {"version": 1}, "preserve": ["a"]
        }))
        .unwrap();
        assert!(
            matches!(command, DevCommand::Update { id: 7, ref preserve, .. } if preserve == &["a"])
        );
        assert!(parse_command(&json!({"type": "eval"})).is_err());
        assert!(parse_command(&json!({"type": "update"})).is_err());
        assert!(
            parse_command(
                &json!({"type": "patch", "baseRevision": 2, "revision": 4, "operations": []})
            )
            .is_err()
        );
    }

    #[test]
    fn dev_patch_reconstructs_program_and_rejects_invalid_paths() {
        let program = json!({"root": {"children": [{"text": "old"}]}, "states": []});
        let patched = apply_program_patch(
            &program,
            &[json!({
                "op": "set", "path": ["root", "children", 0, "text"], "value": "new"
            })],
        )
        .unwrap();
        assert_eq!(patched["root"]["children"][0]["text"], "new");
        assert_eq!(program["root"]["children"][0]["text"], "old");
        assert!(
            apply_program_patch(
                &program,
                &[json!({"op": "set", "path": ["missing", "x"], "value": 1})]
            )
            .is_err()
        );
    }
}
