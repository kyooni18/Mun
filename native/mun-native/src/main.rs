use std::{env, error::Error, fs, io, path::PathBuf};

fn program_path() -> Result<(PathBuf, bool), io::Error> {
    let mut arguments = env::args_os();
    let _executable = arguments.next();
    let Some(mut path) = arguments.next() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: mun-native <semantic-ui-ir.json>",
        ));
    };
    let smoke = path == "--smoke";
    if smoke {
        path = arguments.next().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "--smoke requires an IR path")
        })?;
    }
    if arguments.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "mun-native accepts exactly one Semantic UI IR path",
        ));
    }
    Ok((PathBuf::from(path), smoke))
}

fn main() -> Result<(), Box<dyn Error>> {
    let (path, smoke) = program_path()?;
    let source = fs::read_to_string(&path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "failed to read Mün Semantic UI IR from {}: {error}",
                path.display()
            ),
        )
    })?;
    let result = if smoke {
        mun_native::smoke_program(&source)
    } else {
        mun_native::run_program(&source)
    };
    result.map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "failed to run Mün Semantic UI IR from {}: {error}",
                path.display()
            ),
        )
        .into()
    })
}
