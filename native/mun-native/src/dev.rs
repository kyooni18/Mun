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

pub const DEV_PROTOCOL_VERSION: u64 = 1;
/// Largest accepted frame. Semantic programs are far smaller; anything larger
/// is a protocol error, not a reason to allocate.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub enum DevCommand {
    Update {
        id: u64,
        program: String,
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

fn parse_command(message: &Value) -> Result<DevCommand, String> {
    let id = message.get("id").and_then(Value::as_u64).unwrap_or(0);
    match message.get("type").and_then(Value::as_str) {
        Some("update") => {
            let program = message
                .get("program")
                .filter(|program| program.is_object())
                .ok_or("update without program")?
                .to_string();
            let preserve = message
                .get("preserve")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            Ok(DevCommand::Update {
                id,
                program,
                preserve,
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
            "type": "update", "id": 7, "program": {"version": 1}, "preserve": ["a"]
        }))
        .unwrap();
        assert!(
            matches!(command, DevCommand::Update { id: 7, ref preserve, .. } if preserve == &["a"])
        );
        assert!(parse_command(&json!({"type": "eval"})).is_err());
        assert!(parse_command(&json!({"type": "update"})).is_err());
    }
}
