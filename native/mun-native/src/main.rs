use std::{env, error::Error, fs, io, path::PathBuf};

enum Mode {
    Run,
    Smoke,
    /// Offscreen realization: `--render <ir> <out.png> [script.json]`.
    Render {
        output: PathBuf,
        script: Option<PathBuf>,
    },
}

fn usage(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.to_owned())
}

fn program_path() -> Result<(PathBuf, Mode), io::Error> {
    let mut arguments = env::args_os().skip(1).collect::<Vec<_>>().into_iter();
    let Some(first) = arguments.next() else {
        return Err(usage(
            "usage: mun-native [--smoke | --render <out.png> [script.json]] <semantic-ui-ir.json>",
        ));
    };
    let (path, mode) = if first == "--smoke" {
        let path = arguments
            .next()
            .ok_or_else(|| usage("--smoke requires an IR path"))?;
        (path, Mode::Smoke)
    } else if first == "--render" {
        let path = arguments
            .next()
            .ok_or_else(|| usage("--render requires an IR path"))?;
        let output = arguments
            .next()
            .ok_or_else(|| usage("--render requires an output PNG path"))?;
        let script = arguments.next().map(PathBuf::from);
        (
            path,
            Mode::Render {
                output: PathBuf::from(output),
                script,
            },
        )
    } else {
        (first, Mode::Run)
    };
    if arguments.next().is_some() {
        return Err(usage("mun-native accepts exactly one Semantic UI IR path"));
    }
    Ok((PathBuf::from(path), mode))
}

/// Machine-readable host identity used by release assembly and launchers to
/// reject a host built for another package version or IR contract.
fn host_info() -> String {
    format!(
        "{{\"name\":\"mun-native\",\"crateVersion\":\"{}\",\"semanticUiIrVersion\":{},\"os\":\"{}\",\"arch\":\"{}\",\"profile\":\"{}\"}}",
        env!("CARGO_PKG_VERSION"),
        mun_runtime::SEMANTIC_UI_IR_VERSION,
        env::consts::OS,
        env::consts::ARCH,
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
    )
}

fn main() -> Result<(), Box<dyn Error>> {
    if env::args_os()
        .nth(1)
        .is_some_and(|argument| argument == "--host-info")
    {
        println!("{}", host_info());
        return Ok(());
    }
    let (path, mode) = program_path()?;
    let source = fs::read_to_string(&path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "failed to read Mün Semantic UI IR from {}: {error}",
                path.display()
            ),
        )
    })?;
    let failed = |error: mun_native::NativeBackendError| -> Box<dyn Error> {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "failed to run Mün Semantic UI IR from {}: {error}",
                path.display()
            ),
        )
        .into()
    };
    match mode {
        Mode::Run => mun_native::run_program(&source).map_err(failed),
        Mode::Smoke => mun_native::smoke_program(&source).map_err(failed),
        Mode::Render { output, script } => {
            let script = match script {
                Some(script) => serde_json::from_str(&fs::read_to_string(script)?)?,
                None => serde_json::Value::Array(Vec::new()),
            };
            let size = |name: &str, fallback: f32| {
                env::var(name)
                    .ok()
                    .and_then(|value| value.parse::<f32>().ok())
                    .unwrap_or(fallback)
            };
            let (png, report) = mun_native::render_program_png(
                &source,
                &script,
                size("MUN_RENDER_WIDTH", 640.0),
                size("MUN_RENDER_HEIGHT", 420.0),
                size("MUN_RENDER_SCALE", 2.0),
            )
            .map_err(failed)?;
            fs::write(&output, png)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
    }
}
