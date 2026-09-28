use std::{env, error::Error, fs, io, path::PathBuf};

fn program_path() -> Result<PathBuf, io::Error> {
    let mut arguments = env::args_os();
    let _executable = arguments.next();
    let Some(path) = arguments.next() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: mun-native <semantic-ui-ir.json>",
        ));
    };
    if arguments.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "mun-native accepts exactly one Semantic UI IR path",
        ));
    }
    Ok(PathBuf::from(path))
}

fn main() -> Result<(), Box<dyn Error>> {
    let path = program_path()?;
    let source = fs::read_to_string(&path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "failed to read Mün Semantic UI IR from {}: {error}",
                path.display()
            ),
        )
    })?;
    mun_native::run_program(&source).map_err(|error| {
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
