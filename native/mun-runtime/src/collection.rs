//! Runtime-owned keyed collections and item state scopes.
//!
//! The semantic IR describes `forEach` templates. Before layout, the runtime
//! materializes one instance of the template per collection item:
//!
//! * instance identity = template node identity + `[`encoded key`]` (one
//!   bracketed segment per enclosing `forEach`; `[` never occurs in compiler
//!   identities because key segments and `.id(_:)` keys are percent-encoded),
//!   for every node in the instance, so focus, editors, scroll offsets,
//!   retained identity, transitions and FLIP follow the *key*, never the index;
//! * item expressions are substituted with the item's values;
//! * View-local state declared inside the template (`UiState::scope`) is renamed
//!   to per-key instance storage, created on first appearance of the key and
//!   released when the key leaves its collection.
//!
//! Duplicate keys are rejected explicitly; they are never aliased.
use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;

use crate::ir::{UiAction, UiCollectionOperation, UiExpression, UiFilterOperator, UiNode, UiState};

/// Static facts about item-scoped state derived from the IR once at load.
#[derive(Clone, Debug, Default)]
pub(crate) struct ScopeModel {
    /// Template state name -> declaring `forEach` template id.
    scoped_states: HashMap<String, String>,
    /// Template state name -> initial value.
    initials: HashMap<String, Value>,
    /// States read by any `forEach` collection expression (structural deps).
    pub(crate) structural_states: HashSet<String>,
    /// Template states that can change retained structure: read by a
    /// conditional's condition, a `.id(_:)` identity key or a `forEach`
    /// collection. Edits to any other state cannot insert, remove, replace or
    /// reparent retained nodes.
    structure_states: HashSet<String>,
}

impl ScopeModel {
    pub(crate) fn new(states: &[UiState], template: &UiNode) -> Self {
        let mut model = Self::default();
        for state in states {
            if let Some(scope) = &state.scope {
                model
                    .scoped_states
                    .insert(state.name.clone(), scope.clone());
                model
                    .initials
                    .insert(state.name.clone(), state.initial.clone());
            }
        }
        collect_structural_states(template, &mut model.structural_states);
        model.structure_states = model.structural_states.clone();
        collect_structure_states(template, &mut model.structure_states);
        model
    }

    /// Whether a concrete state (template name or per-key instance) can change
    /// the retained node structure.
    pub(crate) fn affects_structure(&self, state: &str) -> bool {
        let template = state
            .split_once('[')
            .map_or(state, |(template, _)| template);
        self.structure_states.contains(template)
    }

    pub(crate) fn add_structure_expression(&mut self, expression: &UiExpression) {
        expression_states(expression, &mut self.structure_states);
    }

    pub(crate) fn is_scoped(&self, state: &str) -> bool {
        self.scoped_states.contains_key(state)
    }

    /// Whether a concrete state name is a per-key instance of scoped state.
    pub(crate) fn is_instance(&self, name: &str) -> bool {
        name.split_once('[')
            .is_some_and(|(template, _)| self.is_scoped(template))
    }

    pub(crate) fn has_collections(&self) -> bool {
        !self.structural_states.is_empty()
    }
}

fn collect_structural_states(node: &UiNode, output: &mut HashSet<String>) {
    if let UiNode::ForEach { collection, .. } = node {
        expression_states(collection, output);
    }
    if let UiNode::Conditional {
        then_nodes,
        otherwise,
        ..
    } = node
    {
        for child in then_nodes.iter().chain(otherwise) {
            collect_structural_states(child, output);
        }
    }
    for child in node.children() {
        collect_structural_states(child, output);
    }
}

fn collect_structure_states(node: &UiNode, output: &mut HashSet<String>) {
    if let Some(key) = &node.base().identity_key {
        expression_states(key, output);
    }
    if let UiNode::Conditional {
        condition,
        then_nodes,
        otherwise,
        ..
    } = node
    {
        expression_states(condition, output);
        for child in then_nodes.iter().chain(otherwise) {
            collect_structure_states(child, output);
        }
    }
    for child in node.children() {
        collect_structure_states(child, output);
    }
}

fn expression_states(expression: &UiExpression, output: &mut HashSet<String>) {
    match expression {
        UiExpression::State { state } => {
            output.insert(state.clone());
        }
        UiExpression::Not { value } | UiExpression::Stringify { value } => {
            expression_states(value, output)
        }
        UiExpression::Binary { left, right, .. } => {
            expression_states(left, output);
            expression_states(right, output);
        }
        UiExpression::Conditional {
            condition,
            then_value,
            otherwise,
        } => {
            expression_states(condition, output);
            expression_states(then_value, output);
            expression_states(otherwise, output);
        }
        UiExpression::Record { fields } => {
            for field in fields.values() {
                expression_states(field, output);
            }
        }
        UiExpression::Count { collection } => expression_states(collection, output),
        UiExpression::Filter {
            collection, value, ..
        } => {
            expression_states(collection, output);
            expression_states(value, output);
        }
        UiExpression::Literal { .. } | UiExpression::Item { .. } => {}
    }
}

/// Canonical, collision-free key segment: strings and finite numbers only.
pub fn key_segment(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(format!("s:{}", percent_encode(text))),
        Value::Number(number) => {
            let number = number.as_f64()?;
            if !number.is_finite() {
                return None;
            }
            let number = if number == 0.0 { 0.0 } else { number };
            Some(format!("n:{number}"))
        }
        _ => None,
    }
}

fn percent_encode(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

pub fn value_at_path<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, field| current.as_object()?.get(field))
}

/// Pure expression evaluation over a state map.
pub(crate) fn evaluate(expression: &UiExpression, state: &HashMap<String, Value>) -> Value {
    match expression {
        UiExpression::Literal { value } => value.clone(),
        UiExpression::State { state: name } => state.get(name).cloned().unwrap_or(Value::Null),
        UiExpression::Not { value } => {
            Value::Bool(!evaluate(value, state).as_bool().unwrap_or(false))
        }
        UiExpression::Stringify { value } => {
            Value::String(crate::runtime::scalar_string(&evaluate(value, state)))
        }
        UiExpression::Binary {
            operator,
            left,
            right,
        } => crate::runtime::evaluate_binary(
            *operator,
            evaluate(left, state),
            evaluate(right, state),
        ),
        UiExpression::Conditional {
            condition,
            then_value,
            otherwise,
        } => {
            if evaluate(condition, state).as_bool().unwrap_or(false) {
                evaluate(then_value, state)
            } else {
                evaluate(otherwise, state)
            }
        }
        // Materialization substitutes every item reference; one surviving here
        // is outside any forEach and has no value.
        UiExpression::Item { .. } => Value::Null,
        UiExpression::Record { fields } => Value::Object(
            fields
                .iter()
                .map(|(name, field)| (name.clone(), evaluate(field, state)))
                .collect(),
        ),
        UiExpression::Count { collection } => match evaluate(collection, state) {
            Value::Array(items) => Value::from(items.len()),
            _ => Value::from(0),
        },
        UiExpression::Filter {
            collection,
            path,
            operator,
            value,
        } => {
            let expected = evaluate(value, state);
            let Value::Array(items) = evaluate(collection, state) else {
                return Value::Array(Vec::new());
            };
            Value::Array(
                items
                    .into_iter()
                    .filter(|item| {
                        let matches = value_at_path(item, path) == Some(&expected);
                        match operator {
                            UiFilterOperator::Equal => matches,
                            UiFilterOperator::NotEqual => !matches,
                        }
                    })
                    .collect(),
            )
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CollectionError {
    /// Two items of one `forEach` (or one keyed mutation) share a key.
    DuplicateKey { collection: String, key: String },
    /// An item key is missing or not a string/finite number.
    InvalidKey { collection: String },
    /// A `forEach` collection or a mutated state is not an array.
    NotACollection { collection: String },
}

impl std::fmt::Display for CollectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateKey { collection, key } => {
                write!(
                    formatter,
                    "duplicate item key {key} in collection '{collection}'"
                )
            }
            Self::InvalidKey { collection } => write!(
                formatter,
                "collection '{collection}' has an item whose key is not a string or finite number"
            ),
            Self::NotACollection { collection } => {
                write!(
                    formatter,
                    "'{collection}' is not a collection (array) value"
                )
            }
        }
    }
}

struct Scope<'a> {
    for_each: &'a str,
    segment: String,
    item: Value,
}

/// Result of materializing the template against the current state.
pub(crate) struct Materialized {
    pub(crate) root: UiNode,
}

pub(crate) fn materialize(
    template: &UiNode,
    model: &ScopeModel,
    state: &mut HashMap<String, Value>,
) -> Result<Materialized, CollectionError> {
    let mut expander = Expander {
        model,
        state,
        live_instances: HashSet::new(),
    };
    let mut scopes = Vec::new();
    let root = expander.node(template, &mut scopes)?;
    let live_instances = expander.live_instances;
    // Release instance state for keys that left their collection.
    let stale = state
        .keys()
        .filter(|name| !live_instances.contains(*name) && model.is_instance(name))
        .cloned()
        .collect::<Vec<_>>();
    for name in stale {
        state.remove(&name);
    }
    Ok(Materialized { root })
}

struct Expander<'m, 's> {
    model: &'m ScopeModel,
    state: &'s mut HashMap<String, Value>,
    live_instances: HashSet<String>,
}

impl Expander<'_, '_> {
    fn suffix(scopes: &[Scope<'_>]) -> String {
        scopes
            .iter()
            .map(|scope| format!("[{}]", scope.segment))
            .collect()
    }

    fn rename_state(&mut self, name: &str, scopes: &[Scope<'_>]) -> String {
        let Some(declared) = self.model.scoped_states.get(name) else {
            return name.to_owned();
        };
        let Some(position) = scopes.iter().position(|scope| scope.for_each == declared) else {
            return name.to_owned();
        };
        let concrete = format!("{name}{}", Self::suffix(&scopes[..=position]));
        if !self.state.contains_key(&concrete) {
            let initial = self
                .model
                .initials
                .get(name)
                .cloned()
                .unwrap_or(Value::Null);
            self.state.insert(concrete.clone(), initial);
        }
        self.live_instances.insert(concrete.clone());
        concrete
    }

    fn expression(&mut self, expression: &UiExpression, scopes: &[Scope<'_>]) -> UiExpression {
        let boxed =
            |this: &mut Self, value: &UiExpression| Box::new(this.expression(value, scopes));
        match expression {
            UiExpression::Literal { .. } => expression.clone(),
            UiExpression::State { state } => UiExpression::State {
                state: self.rename_state(state, scopes),
            },
            UiExpression::Not { value } => UiExpression::Not {
                value: boxed(self, value),
            },
            UiExpression::Stringify { value } => UiExpression::Stringify {
                value: boxed(self, value),
            },
            UiExpression::Binary {
                operator,
                left,
                right,
            } => UiExpression::Binary {
                operator: *operator,
                left: boxed(self, left),
                right: boxed(self, right),
            },
            UiExpression::Conditional {
                condition,
                then_value,
                otherwise,
            } => UiExpression::Conditional {
                condition: boxed(self, condition),
                then_value: boxed(self, then_value),
                otherwise: boxed(self, otherwise),
            },
            UiExpression::Item { for_each, path } => {
                let value = scopes
                    .iter()
                    .rev()
                    .find(|scope| scope.for_each == for_each)
                    .and_then(|scope| value_at_path(&scope.item, path))
                    .cloned()
                    .unwrap_or(Value::Null);
                UiExpression::Literal { value }
            }
            UiExpression::Record { fields } => UiExpression::Record {
                fields: fields
                    .iter()
                    .map(|(name, field)| (name.clone(), self.expression(field, scopes)))
                    .collect::<BTreeMap<_, _>>(),
            },
            UiExpression::Count { collection } => UiExpression::Count {
                collection: boxed(self, collection),
            },
            UiExpression::Filter {
                collection,
                path,
                operator,
                value,
            } => UiExpression::Filter {
                collection: boxed(self, collection),
                path: path.clone(),
                operator: *operator,
                value: boxed(self, value),
            },
        }
    }

    fn optional(
        &mut self,
        expression: &Option<UiExpression>,
        scopes: &[Scope<'_>],
    ) -> Option<UiExpression> {
        expression
            .as_ref()
            .map(|expression| self.expression(expression, scopes))
    }

    fn action(&mut self, action: &UiAction, scopes: &[Scope<'_>]) -> UiAction {
        match action {
            UiAction::ToggleState { state, transaction } => UiAction::ToggleState {
                state: self.rename_state(state, scopes),
                transaction: transaction.clone(),
            },
            UiAction::SetState {
                state,
                value,
                transaction,
            } => UiAction::SetState {
                state: self.rename_state(state, scopes),
                value: self.expression(value, scopes),
                transaction: transaction.clone(),
            },
            UiAction::Collection {
                state,
                key_path,
                operation,
                transaction,
            } => UiAction::Collection {
                state: self.rename_state(state, scopes),
                key_path: key_path.clone(),
                operation: match operation {
                    UiCollectionOperation::Insert { index, value } => {
                        UiCollectionOperation::Insert {
                            index: self.expression(index, scopes),
                            value: self.expression(value, scopes),
                        }
                    }
                    UiCollectionOperation::Append { value } => UiCollectionOperation::Append {
                        value: self.expression(value, scopes),
                    },
                    UiCollectionOperation::Remove { key } => UiCollectionOperation::Remove {
                        key: self.expression(key, scopes),
                    },
                    UiCollectionOperation::Move { key, offset } => UiCollectionOperation::Move {
                        key: self.expression(key, scopes),
                        offset: self.expression(offset, scopes),
                    },
                    UiCollectionOperation::Update { key, path, value } => {
                        UiCollectionOperation::Update {
                            key: self.expression(key, scopes),
                            path: path.clone(),
                            value: self.expression(value, scopes),
                        }
                    }
                },
                transaction: transaction.clone(),
            },
            UiAction::Sequence {
                actions,
                transaction,
            } => UiAction::Sequence {
                actions: actions
                    .iter()
                    .map(|action| self.action(action, scopes))
                    .collect(),
                transaction: transaction.clone(),
            },
        }
    }

    fn base(&mut self, base: &crate::ir::NodeBase, scopes: &[Scope<'_>]) -> crate::ir::NodeBase {
        let mut output = base.clone();
        output.id = format!("{}{}", base.id, Self::suffix(scopes));
        output.identity_key = self.optional(&base.identity_key, scopes);
        if let Some(layout) = &mut output.layout {
            layout.width = layout
                .width
                .take()
                .map(|value| self.expression(&value, scopes));
            layout.height = layout
                .height
                .take()
                .map(|value| self.expression(&value, scopes));
        }
        if let Some(visual) = &mut output.visual {
            visual.opacity = visual
                .opacity
                .take()
                .map(|value| self.expression(&value, scopes));
            visual.translation_x = visual
                .translation_x
                .take()
                .map(|value| self.expression(&value, scopes));
            visual.translation_y = visual
                .translation_y
                .take()
                .map(|value| self.expression(&value, scopes));
        }
        if let Some(accessibility) = &mut output.accessibility {
            accessibility.enabled = accessibility
                .enabled
                .take()
                .map(|value| self.expression(&value, scopes));
        }
        for binding in &mut output.motion {
            binding.value = self.expression(&binding.value, scopes);
            binding.trigger = binding
                .trigger
                .take()
                .map(|value| self.expression(&value, scopes));
        }
        output
    }

    fn nodes<'t>(
        &mut self,
        nodes: &'t [UiNode],
        scopes: &mut Vec<Scope<'t>>,
    ) -> Result<Vec<UiNode>, CollectionError> {
        nodes.iter().map(|node| self.node(node, scopes)).collect()
    }

    fn node<'t>(
        &mut self,
        node: &'t UiNode,
        scopes: &mut Vec<Scope<'t>>,
    ) -> Result<UiNode, CollectionError> {
        Ok(match node {
            UiNode::ForEach {
                base,
                collection,
                key_path,
                children,
            } => {
                let id = format!("{}{}", base.id, Self::suffix(scopes));
                let collection_expression = self.expression(collection, scopes);
                let items = match evaluate(&collection_expression, self.state) {
                    Value::Array(items) => items,
                    Value::Null => Vec::new(),
                    _ => return Err(CollectionError::NotACollection { collection: id }),
                };
                let mut seen = HashSet::new();
                let mut instances = Vec::with_capacity(items.len() * children.len());
                for item in items {
                    let segment = value_at_path(&item, key_path)
                        .and_then(key_segment)
                        .ok_or_else(|| CollectionError::InvalidKey {
                            collection: id.clone(),
                        })?;
                    if !seen.insert(segment.clone()) {
                        return Err(CollectionError::DuplicateKey {
                            collection: id,
                            key: segment,
                        });
                    }
                    scopes.push(Scope {
                        for_each: &base.id,
                        segment,
                        item,
                    });
                    let instance = self.nodes(children, scopes);
                    scopes.pop();
                    instances.extend(instance?);
                }
                // Materialized as a transparent fragment: like a conditional's
                // active branch, it contributes children without a layout box.
                UiNode::Conditional {
                    base: crate::ir::NodeBase {
                        id,
                        ..Default::default()
                    },
                    condition: UiExpression::Literal {
                        value: Value::Bool(true),
                    },
                    then_nodes: instances,
                    otherwise: Vec::new(),
                }
            }
            UiNode::Column { base, children } => UiNode::Column {
                base: self.base(base, scopes),
                children: self.nodes(children, scopes)?,
            },
            UiNode::Row { base, children } => UiNode::Row {
                base: self.base(base, scopes),
                children: self.nodes(children, scopes)?,
            },
            UiNode::Scroll {
                base,
                axis,
                children,
            } => UiNode::Scroll {
                base: self.base(base, scopes),
                axis: *axis,
                children: self.nodes(children, scopes)?,
            },
            UiNode::Overlay {
                base,
                alignment,
                children,
            } => UiNode::Overlay {
                base: self.base(base, scopes),
                alignment: *alignment,
                children: self.nodes(children, scopes)?,
            },
            UiNode::Conditional {
                base,
                condition,
                then_nodes,
                otherwise,
            } => UiNode::Conditional {
                base: self.base(base, scopes),
                condition: self.expression(condition, scopes),
                then_nodes: self.nodes(then_nodes, scopes)?,
                otherwise: self.nodes(otherwise, scopes)?,
            },
            UiNode::Text { base, value } => UiNode::Text {
                base: self.base(base, scopes),
                value: self.expression(value, scopes),
            },
            UiNode::Panel { base, shape } => UiNode::Panel {
                base: self.base(base, scopes),
                shape: *shape,
            },
            UiNode::TextField {
                base,
                state,
                placeholder,
            } => UiNode::TextField {
                base: self.base(base, scopes),
                state: self.rename_state(state, scopes),
                placeholder: placeholder.clone(),
            },
            UiNode::RadioGroup {
                base,
                state,
                options,
            } => UiNode::RadioGroup {
                base: self.base(base, scopes),
                state: self.rename_state(state, scopes),
                options: options.clone(),
            },
            UiNode::Action {
                base,
                label,
                action,
            } => UiNode::Action {
                base: self.base(base, scopes),
                label: label.clone(),
                action: self.action(action, scopes),
            },
        })
    }
}

/// Apply one evaluated keyed mutation to a collection value. Items are found by
/// key; a mutation producing duplicate or invalid keys fails without effect.
pub(crate) fn apply_operation(
    collection_name: &str,
    collection: &Value,
    key_path: &[String],
    operation: &EvaluatedOperation,
) -> Result<Value, CollectionError> {
    let mut items = match collection {
        Value::Array(items) => items.clone(),
        Value::Null => Vec::new(),
        _ => {
            return Err(CollectionError::NotACollection {
                collection: collection_name.to_owned(),
            });
        }
    };
    let position = |items: &[Value], key: &Value| {
        let wanted = key_segment(key)?;
        items.iter().position(|item| {
            value_at_path(item, key_path)
                .and_then(key_segment)
                .as_deref()
                == Some(&wanted)
        })
    };
    match operation {
        EvaluatedOperation::Insert { index, value } => {
            let index = index.clamp(0.0, items.len() as f64) as usize;
            items.insert(index, value.clone());
        }
        EvaluatedOperation::Append { value } => items.push(value.clone()),
        EvaluatedOperation::Remove { key } => {
            if let Some(index) = position(&items, key) {
                items.remove(index);
            }
        }
        EvaluatedOperation::Move { key, offset } => {
            if let Some(index) = position(&items, key) {
                let target = (index as f64 + offset.trunc())
                    .clamp(0.0, items.len().saturating_sub(1) as f64)
                    as usize;
                let item = items.remove(index);
                items.insert(target, item);
            }
        }
        EvaluatedOperation::Update { key, path, value } => {
            if let Some(index) = position(&items, key) {
                let mut cursor = &mut items[index];
                for (depth, field) in path.iter().enumerate() {
                    let Some(object) = cursor.as_object_mut() else {
                        break;
                    };
                    if depth + 1 == path.len() {
                        object.insert(field.clone(), value.clone());
                        break;
                    }
                    cursor = object
                        .entry(field.clone())
                        .or_insert_with(|| Value::Object(Default::default()));
                }
            }
        }
    }
    let mut seen = HashSet::new();
    for item in &items {
        let segment = value_at_path(item, key_path)
            .and_then(key_segment)
            .ok_or_else(|| CollectionError::InvalidKey {
                collection: collection_name.to_owned(),
            })?;
        if !seen.insert(segment.clone()) {
            return Err(CollectionError::DuplicateKey {
                collection: collection_name.to_owned(),
                key: segment,
            });
        }
    }
    Ok(Value::Array(items))
}

pub(crate) enum EvaluatedOperation {
    Insert {
        index: f64,
        value: Value,
    },
    Append {
        value: Value,
    },
    Remove {
        key: Value,
    },
    Move {
        key: Value,
        offset: f64,
    },
    Update {
        key: Value,
        path: Vec<String>,
        value: Value,
    },
}

impl EvaluatedOperation {
    pub(crate) fn evaluate(
        operation: &UiCollectionOperation,
        state: &HashMap<String, Value>,
    ) -> Self {
        let number =
            |expression: &UiExpression| evaluate(expression, state).as_f64().unwrap_or(0.0);
        match operation {
            UiCollectionOperation::Insert { index, value } => Self::Insert {
                index: number(index),
                value: evaluate(value, state),
            },
            UiCollectionOperation::Append { value } => Self::Append {
                value: evaluate(value, state),
            },
            UiCollectionOperation::Remove { key } => Self::Remove {
                key: evaluate(key, state),
            },
            UiCollectionOperation::Move { key, offset } => Self::Move {
                key: evaluate(key, state),
                offset: number(offset),
            },
            UiCollectionOperation::Update { key, path, value } => Self::Update {
                key: evaluate(key, state),
                path: path.clone(),
                value: evaluate(value, state),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_segments_are_typed_and_collision_free() {
        assert_eq!(key_segment(&Value::from("a")).unwrap(), "s:a");
        assert_ne!(key_segment(&Value::from("1")), key_segment(&Value::from(1)));
        assert_eq!(
            key_segment(&Value::from(-0.0)),
            key_segment(&Value::from(0))
        );
        assert_eq!(
            key_segment(&Value::from("a#b/c:option:1")).unwrap(),
            "s:a%23b%2Fc%3Aoption%3A1"
        );
        assert!(key_segment(&Value::Bool(true)).is_none());
        assert!(key_segment(&Value::Null).is_none());
    }

    #[test]
    fn keyed_operations_address_items_by_key_and_reject_duplicates() {
        let path = vec!["id".to_owned()];
        let items = serde_json::json!([{"id": "a"}, {"id": "b"}, {"id": "c"}]);
        let moved = apply_operation(
            "rows",
            &items,
            &path,
            &EvaluatedOperation::Move {
                key: Value::from("c"),
                offset: -5.0,
            },
        )
        .unwrap();
        assert_eq!(
            moved,
            serde_json::json!([{"id": "c"}, {"id": "a"}, {"id": "b"}])
        );
        let duplicate = apply_operation(
            "rows",
            &items,
            &path,
            &EvaluatedOperation::Append {
                value: serde_json::json!({"id": "a"}),
            },
        );
        assert_eq!(
            duplicate,
            Err(CollectionError::DuplicateKey {
                collection: "rows".into(),
                key: "s:a".into()
            })
        );
        let missing = apply_operation(
            "rows",
            &items,
            &path,
            &EvaluatedOperation::Insert {
                index: 0.0,
                value: serde_json::json!({"title": "no key"}),
            },
        );
        assert!(matches!(missing, Err(CollectionError::InvalidKey { .. })));
    }
}
