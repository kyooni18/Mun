//! Strict Semantic UI IR validation.
//!
//! The checked-in JSON Schema (`schemas/semantic-ui-ir-v1.schema.json`) is the
//! single versioned wire contract shared by the compiler, the TypeScript
//! types and this runtime. The runtime evaluates it directly against the raw
//! JSON before deserializing, so unknown fields, unknown kinds and malformed
//! shapes are rejected instead of being silently ignored by serde. Checks the
//! schema cannot express (references between states, nodes and `forEach`
//! scopes) follow in [`validate_references`].
//!
//! Only the JSON Schema subset the contract uses is implemented; an
//! unsupported keyword is a contract error, never silently skipped.
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::OnceLock;

use serde_json::{Map, Value};

const SCHEMA_SOURCE: &str = include_str!("../../../schemas/semantic-ui-ir-v1.schema.json");

/// A contract violation located by the nearest enclosing semantic node and the
/// JSON path of the offending field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IrValidationError {
    pub node: Option<String>,
    pub path: String,
    pub message: String,
}

impl fmt::Display for IrValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.node {
            Some(node) => write!(f, "node '{node}' at {}: {}", self.path, self.message),
            None => write!(f, "{}: {}", self.path, self.message),
        }
    }
}

impl std::error::Error for IrValidationError {}

fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA
        .get_or_init(|| serde_json::from_str(SCHEMA_SOURCE).expect("bundled Semantic UI IR schema"))
}

/// Every `$ref` in the bundled schema, resolved once to its (non-reference)
/// target. `None` marks a reference that cannot be resolved; using it is a
/// contract error, reported when it is first reached as before.
fn references() -> &'static HashMap<String, Option<&'static Value>> {
    static REFERENCES: OnceLock<HashMap<String, Option<&'static Value>>> = OnceLock::new();
    REFERENCES.get_or_init(|| {
        let root = schema();
        let mut names = Vec::new();
        collect_references(root, &mut names);
        names
            .into_iter()
            .map(|reference| {
                let mut target = Some(root);
                let mut current = reference.clone();
                // Follow chains of references; give up on cycles.
                for _ in 0..64 {
                    target = current
                        .strip_prefix('#')
                        .and_then(|pointer| root.pointer(pointer));
                    match target
                        .and_then(|value| value.get("$ref"))
                        .and_then(Value::as_str)
                    {
                        Some(next) => current = next.to_owned(),
                        None => break,
                    }
                }
                let resolved = target.filter(|value| value.get("$ref").is_none());
                (reference, resolved)
            })
            .collect()
    })
}

fn collect_references(schema: &Value, names: &mut Vec<String>) {
    match schema {
        Value::Object(object) => {
            if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                names.push(reference.to_owned());
            }
            for value in object.values() {
                collect_references(value, names);
            }
        }
        Value::Array(items) => items
            .iter()
            .for_each(|item| collect_references(item, names)),
        _ => {}
    }
}

/// Validate raw IR JSON against the bundled v1 schema and reference rules.
pub fn validate_program(program: &Value) -> Result<(), IrValidationError> {
    let schema = schema();
    let mut validator = Validator { root: schema };
    validator.check(schema, program, &Context::default())?;
    validate_references(program)
}

/// One step of a JSON path. Composite segments render with their own `/`.
#[derive(Clone, Copy)]
enum Segment<'a> {
    Name(&'a str),
    Index(usize),
    /// `{name}/{index}`
    Indexed(&'a str, usize),
    /// `{name}/{index}/{field}`
    IndexedField(&'a str, usize, &'a str),
}

impl fmt::Display for Segment<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Name(name) => f.write_str(name),
            Self::Index(index) => write!(f, "{index}"),
            Self::Indexed(name, index) => write!(f, "{name}/{index}"),
            Self::IndexedField(name, index, field) => write!(f, "{name}/{index}/{field}"),
        }
    }
}

/// Where validation is: a chain of borrowed path segments up to the root and
/// the nearest enclosing semantic node. Strings are built only for errors.
#[derive(Clone, Copy, Default)]
struct Context<'a> {
    parent: Option<&'a Context<'a>>,
    segment: Option<Segment<'a>>,
    node: Option<&'a str>,
}

impl<'a> Context<'a> {
    fn error(&self, message: impl Into<String>) -> IrValidationError {
        let mut segments = Vec::new();
        let mut node = None;
        let mut current = Some(self);
        while let Some(context) = current {
            if let Some(segment) = context.segment {
                segments.push(segment);
            }
            node = node.or(context.node);
            current = context.parent;
        }
        let path = if segments.is_empty() {
            "/".into()
        } else {
            segments
                .iter()
                .rev()
                .fold(String::new(), |path, segment| format!("{path}/{segment}"))
        };
        IrValidationError {
            node: node.map(str::to_owned),
            path,
            message: message.into(),
        }
    }

    fn child(&'a self, segment: Segment<'a>) -> Context<'a> {
        Context {
            parent: Some(self),
            segment: Some(segment),
            node: None,
        }
    }

    /// Same path, reported against semantic node `id`.
    fn within(&'a self, id: &'a str) -> Context<'a> {
        Context {
            parent: Some(self),
            segment: None,
            node: Some(id),
        }
    }
}

struct Validator<'s> {
    root: &'s Value,
}

impl<'s> Validator<'s> {
    fn resolve(&self, schema: &'s Value) -> Result<&'s Value, IrValidationError> {
        let Some(reference) = schema.get("$ref").and_then(Value::as_str) else {
            return Ok(schema);
        };
        // The bundled schema's references are resolved once; anything else
        // (or an unresolvable reference, for its exact error) walks the pointer.
        if std::ptr::eq(self.root, crate::validate::schema()) {
            if let Some(Some(resolved)) = references().get(reference) {
                return Ok(resolved);
            }
        }
        let pointer = reference.strip_prefix('#').ok_or_else(|| {
            Context::default().error(format!("unsupported schema reference {reference}"))
        })?;
        let target = self.root.pointer(pointer).ok_or_else(|| {
            Context::default().error(format!("dangling schema reference {reference}"))
        })?;
        self.resolve(target)
    }

    fn check(
        &mut self,
        schema: &'s Value,
        value: &Value,
        context: &Context<'_>,
    ) -> Result<(), IrValidationError> {
        let schema = self.resolve(schema)?;
        let Some(rules) = schema.as_object() else {
            return Err(context.error("malformed schema"));
        };
        // A semantic node names itself; nested errors are reported against it.
        let scoped;
        let context = if let (Some(id), Some(_)) = (
            value.get("id").and_then(Value::as_str),
            value.get("kind").and_then(Value::as_str),
        ) {
            scoped = context.within(id);
            &scoped
        } else {
            context
        };
        for (keyword, rule) in rules {
            match keyword.as_str() {
                "$schema" | "$id" | "$defs" | "title" | "description" | "$ref" => {}
                "type" => check_type(rule, value, context)?,
                "const" => {
                    if value != rule {
                        return Err(context.error(format!("expected {rule}, found {value}")));
                    }
                }
                "enum" => {
                    let options = rule.as_array().map(Vec::as_slice).unwrap_or_default();
                    if !options.contains(value) {
                        return Err(context.error(format!("{value} is not one of {rule}")));
                    }
                }
                "minLength" => {
                    if let Some(text) = value.as_str() {
                        if (text.chars().count() as u64) < rule.as_u64().unwrap_or(0) {
                            return Err(context.error("must not be empty"));
                        }
                    }
                }
                "minimum" | "maximum" | "exclusiveMinimum" => {
                    if let (Some(number), Some(bound)) = (value.as_f64(), rule.as_f64()) {
                        let ok = match keyword.as_str() {
                            "minimum" => number >= bound,
                            "maximum" => number <= bound,
                            _ => number > bound,
                        };
                        if !ok {
                            return Err(
                                context.error(format!("{number} violates {keyword} {bound}"))
                            );
                        }
                    }
                }
                "minItems" | "maxItems" => {
                    if let (Some(items), Some(bound)) = (value.as_array(), rule.as_u64()) {
                        let ok = if keyword == "minItems" {
                            items.len() as u64 >= bound
                        } else {
                            items.len() as u64 <= bound
                        };
                        if !ok {
                            return Err(
                                context.error(format!("array length violates {keyword} {bound}"))
                            );
                        }
                    }
                }
                "required" => {
                    if let Some(object) = value.as_object() {
                        for field in rule
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                        {
                            if !object.contains_key(field) {
                                return Err(
                                    context.error(format!("missing required field '{field}'"))
                                );
                            }
                        }
                    }
                }
                "properties" | "additionalProperties" => {}
                "items" | "prefixItems" => {}
                "oneOf" => self.check_one_of(rule, value, context)?,
                other => {
                    return Err(context.error(format!("schema uses unsupported keyword '{other}'")));
                }
            }
        }
        if let Some(object) = value.as_object() {
            self.check_object(rules, object, context)?;
        }
        if let Some(items) = value.as_array() {
            let prefix = rules.get("prefixItems").and_then(Value::as_array);
            for (index, item) in items.iter().enumerate() {
                let item_schema = prefix
                    .and_then(|prefix| prefix.get(index))
                    .or_else(|| rules.get("items"));
                if let Some(item_schema) = item_schema {
                    if item_schema == &Value::Bool(false) {
                        return Err(context.error(format!("unexpected array item {index}")));
                    }
                    self.check(item_schema, item, &context.child(Segment::Index(index)))?;
                }
            }
        }
        Ok(())
    }

    fn check_object(
        &mut self,
        rules: &'s Map<String, Value>,
        object: &Map<String, Value>,
        context: &Context<'_>,
    ) -> Result<(), IrValidationError> {
        let properties = rules.get("properties").and_then(Value::as_object);
        let additional = rules.get("additionalProperties");
        for (field, value) in object {
            if let Some(schema) = properties.and_then(|properties| properties.get(field)) {
                self.check(schema, value, &context.child(Segment::Name(field)))?;
                continue;
            }
            match additional {
                Some(Value::Bool(false)) => {
                    return Err(context
                        .child(Segment::Name(field))
                        .error(format!("unknown field '{field}'")));
                }
                Some(schema @ Value::Object(_)) => {
                    self.check(schema, value, &context.child(Segment::Name(field)))?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// `oneOf` with a discriminator (`kind`, then `operation`) selects its
    /// branch by the instance's tag so the reported error is the branch's own
    /// field error, not a generic "no branch matched".
    fn check_one_of(
        &mut self,
        rule: &'s Value,
        value: &Value,
        context: &Context<'_>,
    ) -> Result<(), IrValidationError> {
        let branches = rule
            .as_array()
            .ok_or_else(|| context.error("malformed oneOf"))?
            .iter()
            .map(|branch| self.resolve(branch))
            .collect::<Result<Vec<_>, _>>()?;
        let mut candidates = branches.clone();
        // Branches whose declared JSON type cannot match are never the
        // intended form (e.g. `null` beside a motion plan).
        let typed: Vec<_> = candidates
            .iter()
            .copied()
            .filter(|branch| {
                branch
                    .get("type")
                    .is_none_or(|rule| type_matches(rule, value))
            })
            .collect();
        if !typed.is_empty() {
            candidates = typed;
        }
        for tag in ["kind", "operation"] {
            let tagged = candidates
                .iter()
                .filter(|branch| tag_constant(branch, tag).is_some())
                .count();
            if tagged == 0 {
                continue;
            }
            let Some(instance) = value.get(tag) else {
                if tagged == candidates.len() {
                    return Err(context.error(format!("missing required field '{tag}'")));
                }
                continue;
            };
            let matching: Vec<_> = candidates
                .iter()
                .copied()
                .filter(|branch| tag_constant(branch, tag) == Some(instance))
                .collect();
            if matching.is_empty() && tagged == candidates.len() {
                return Err(context
                    .child(Segment::Name(tag))
                    .error(format!("unsupported {tag} {instance}")));
            }
            if !matching.is_empty() {
                candidates = matching;
            }
        }
        let mut first_error = None;
        let mut matched = 0;
        for branch in &candidates {
            match self.check(branch, value, context) {
                Ok(()) => matched += 1,
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        match matched {
            1 => Ok(()),
            0 => Err(if candidates.len() == 1 {
                first_error.expect("error")
            } else {
                context.error(format!(
                    "value matches none of the allowed forms ({})",
                    first_error.map(|error| error.message).unwrap_or_default()
                ))
            }),
            _ => Err(context.error("value is ambiguous between several allowed forms")),
        }
    }
}

/// `/properties/{tag}/const` of a schema branch (the discriminator value).
fn tag_constant<'s>(branch: &'s Value, tag: &str) -> Option<&'s Value> {
    branch.get("properties")?.get(tag)?.get("const")
}

fn check_type(rule: &Value, value: &Value, context: &Context<'_>) -> Result<(), IrValidationError> {
    if type_matches(rule, value) {
        Ok(())
    } else {
        Err(context.error(format!("expected {rule}, found {}", type_name(value))))
    }
}

fn type_matches(rule: &Value, value: &Value) -> bool {
    let matches = |name: &str| match name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "integer" => value.is_i64() || value.is_u64(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => false,
    };
    match rule {
        Value::String(name) => matches(name),
        Value::Array(names) => names.iter().filter_map(Value::as_str).any(matches),
        _ => false,
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Cross-references the schema cannot express: declared state names, binding
/// targets, `forEach` scopes and `item` expressions. (Unique node identities
/// are checked on the typed program, see `RuntimeLoadError::DuplicateNodeIdentity`.)
fn validate_references(program: &Value) -> Result<(), IrValidationError> {
    let mut states: HashMap<&str, &Value> = HashMap::new();
    let mut scopes: Vec<(&str, &str)> = Vec::new();
    for (index, state) in program["states"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let name = state["name"].as_str().unwrap_or_default();
        if states.insert(name, &state["initial"]).is_some() {
            let root = Context::default();
            return Err(root
                .child(Segment::IndexedField("states", index, "name"))
                .error(format!("duplicate state '{name}'")));
        }
        if let Some(scope) = state["scope"].as_str() {
            scopes.push((name, scope));
        }
    }
    let mut walker = References {
        states: &states,
        for_each: Vec::new(),
        all_for_each: HashSet::new(),
    };
    let root = &program["root"];
    let top = Context::default();
    let path = top.child(Segment::Name("root"));
    let context = match root["id"].as_str() {
        Some(id) => path.within(id),
        None => path,
    };
    walker.node(&root["child"], &context.child(Segment::Name("child")))?;
    for (state, scope) in scopes {
        if !walker.all_for_each.contains(scope) {
            return Err(top.child(Segment::Name("states")).error(format!(
                "state '{state}' is scoped to unknown forEach '{scope}'"
            )));
        }
    }
    Ok(())
}

struct References<'a> {
    states: &'a HashMap<&'a str, &'a Value>,
    for_each: Vec<&'a str>,
    all_for_each: HashSet<&'a str>,
}

impl<'a> References<'a> {
    fn node(&mut self, node: &'a Value, context: &Context<'_>) -> Result<(), IrValidationError> {
        let id = node["id"].as_str().unwrap_or_default();
        let context = context.within(id);
        let kind = node["kind"].as_str().unwrap_or_default();
        match kind {
            "textField" => {
                self.state(
                    &node["state"],
                    &context.child(Segment::Name("state")),
                    Some("string"),
                )?;
            }
            "radioGroup" => {
                self.state(&node["state"], &context.child(Segment::Name("state")), None)?;
                let mut seen = HashSet::new();
                for (index, option) in node["options"].as_array().into_iter().flatten().enumerate()
                {
                    if !seen.insert(option["value"].to_string()) {
                        return Err(context
                            .child(Segment::IndexedField("options", index, "value"))
                            .error(format!("duplicate radio option value {}", option["value"])));
                    }
                }
            }
            "toggle" => {
                self.state(&node["state"], &context.child(Segment::Name("state")), None)?;
                let name = node["state"].as_str().unwrap_or_default();
                if self
                    .states
                    .get(name)
                    .is_some_and(|initial| !initial.is_boolean())
                {
                    return Err(context
                        .child(Segment::Name("state"))
                        .error(format!("toggle state '{name}' must hold a boolean")));
                }
            }
            "action" => self.action(&node["action"], &context.child(Segment::Name("action")))?,
            _ => {}
        }
        for phase in ["appear", "disappear"] {
            if let Some(action) = node["lifecycle"].get(phase) {
                let lifecycle = context.child(Segment::Name("lifecycle"));
                self.action(action, &lifecycle.child(Segment::Name(phase)))?;
            }
        }
        if let Value::Object(object) = node {
            for (field, value) in object {
                if !matches!(
                    field.as_str(),
                    "children" | "then" | "otherwise" | "child" | "action" | "lifecycle"
                ) {
                    self.expressions(value, &context.child(Segment::Name(field)))?;
                }
            }
        }
        if kind == "forEach" {
            self.all_for_each.insert(id);
            self.for_each.push(id);
        }
        for field in ["children", "then", "otherwise"] {
            for (index, child) in node[field].as_array().into_iter().flatten().enumerate() {
                self.node(child, &context.child(Segment::Indexed(field, index)))?;
            }
        }
        if kind == "forEach" {
            self.for_each.pop();
        }
        Ok(())
    }

    fn state(
        &self,
        state: &Value,
        context: &Context<'_>,
        string: Option<&str>,
    ) -> Result<(), IrValidationError> {
        let name = state.as_str().unwrap_or_default();
        let Some(initial) = self.states.get(name) else {
            return Err(context.error(format!("references undeclared state '{name}'")));
        };
        if string.is_some() && !initial.is_string() {
            return Err(context.error(format!("text binding state '{name}' must hold a string")));
        }
        Ok(())
    }

    fn action(&self, action: &Value, context: &Context<'_>) -> Result<(), IrValidationError> {
        if let Some(state) = action.get("state") {
            self.state(state, &context.child(Segment::Name("state")), None)?;
        }
        for (index, nested) in action["actions"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            self.action(nested, &context.child(Segment::Indexed("actions", index)))?;
        }
        if let Value::Object(object) = action {
            for (field, value) in object {
                if field != "actions" {
                    self.expressions(value, &context.child(Segment::Name(field)))?;
                }
            }
        }
        Ok(())
    }

    /// Every `state` and `item` expression reachable from a node field.
    fn expressions(&self, value: &Value, context: &Context<'_>) -> Result<(), IrValidationError> {
        match value {
            Value::Object(object) => {
                match object.get("kind").and_then(Value::as_str) {
                    Some("state") if object.contains_key("state") && object.len() == 2 => {
                        self.state(
                            &object["state"],
                            &context.child(Segment::Name("state")),
                            None,
                        )?;
                    }
                    Some("item") => {
                        let target = object["forEach"].as_str().unwrap_or_default();
                        if !self.for_each.iter().any(|id| *id == target) {
                            return Err(context
                                .child(Segment::Name("forEach"))
                                .error(format!("item expression outside its forEach '{target}'")));
                        }
                    }
                    _ => {}
                }
                for (field, nested) in object {
                    if field != "value"
                        || object.get("kind").and_then(Value::as_str) != Some("literal")
                    {
                        self.expressions(nested, &context.child(Segment::Name(field)))?;
                    }
                }
                Ok(())
            }
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    self.expressions(item, &context.child(Segment::Index(index)))?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}
