use std::collections::{HashMap, HashSet};

use thiserror::Error;

/// Framework-owned semantic node kinds. These identities intentionally do not
/// expose Taffy node handles, renderer primitives, or platform widgets.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum RetainedNodeKind {
    Window,
    Column,
    Row,
    Overlay,
    Conditional,
    Text,
    Panel,
    TextField,
    RadioGroup,
    Action,
}

impl RetainedNodeKind {
    /// Conditional and window nodes participate in the semantic tree without
    /// manufacturing visual/layout boxes of their own.
    pub fn has_layout_box(self) -> bool {
        !matches!(self, Self::Window | Self::Conditional)
    }
}

/// Finite Mün number normalized for semantic identity comparison.
#[derive(Clone, Copy, Debug)]
pub struct RetainedNumberKey(f64);

impl RetainedNumberKey {
    pub fn new(value: f64) -> Option<Self> {
        if !value.is_finite() {
            return None;
        }
        Some(Self(if value == 0.0 { 0.0 } else { value }))
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

impl PartialEq for RetainedNumberKey {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl Eq for RetainedNumberKey {}

/// Runtime value of Mün's semantic `.id(_:)` boundary.
///
/// Structural node IDs remain the stable location anchor. A changed semantic
/// identity key at that anchor replaces the retained instance without changing
/// the structural ID used by layout, focus, accessibility, or scene lookup.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RetainedIdentityKey {
    String(String),
    Number(RetainedNumberKey),
}

impl RetainedIdentityKey {
    pub fn from_value(value: &serde_json::Value) -> Option<Self> {
        match value {
            serde_json::Value::String(value) => Some(Self::String(value.clone())),
            serde_json::Value::Number(value) => value
                .as_f64()
                .and_then(RetainedNumberKey::new)
                .map(Self::Number),
            _ => None,
        }
    }
}

/// A stable runtime instance attached to one semantic UI IR identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RetainedNode {
    pub id: String,
    pub kind: RetainedNodeKind,
    pub identity_key: Option<RetainedIdentityKey>,
    pub instance_id: u64,
    pub parent: Option<String>,
    pub children: Vec<String>,
}

impl RetainedNode {
    pub fn has_layout_box(&self) -> bool {
        self.kind.has_layout_box()
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RetainedReconciliation {
    pub inserted: Vec<String>,
    pub removed: Vec<String>,
    pub retained: Vec<String>,
    pub replaced: Vec<String>,
    pub reparented: Vec<String>,
    pub children_changed: Vec<String>,
}

impl RetainedReconciliation {
    pub fn is_empty(&self) -> bool {
        self.inserted.is_empty()
            && self.removed.is_empty()
            && self.replaced.is_empty()
            && self.reparented.is_empty()
            && self.children_changed.is_empty()
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum RetainedTreeError {
    #[error("duplicate active semantic node identity '{0}'")]
    DuplicateIdentity(String),
}

#[derive(Clone, Debug)]
pub(crate) struct RetainedNodeSpec {
    pub id: String,
    pub kind: RetainedNodeKind,
    pub identity_key: Option<RetainedIdentityKey>,
    pub parent: Option<String>,
    pub children: Vec<String>,
}

impl RetainedNodeSpec {
    pub(crate) fn new(
        id: impl Into<String>,
        kind: RetainedNodeKind,
        parent: Option<String>,
        children: Vec<String>,
    ) -> Self {
        Self {
            id: id.into(),
            kind,
            identity_key: None,
            parent,
            children,
        }
    }
}

/// Active framework-owned semantic tree.
///
/// Structural Semantic UI IR node IDs are the canonical location anchors.
/// Runtime instance IDs survive reconciliation only while the node kind and
/// optional semantic identity key remain stable. Changing `.id(_:)` therefore
/// replaces the runtime instance at the same structural anchor. Taffy IDs and
/// scene primitive indices never participate in reconciliation.
#[derive(Clone, Debug, Default)]
pub struct RetainedTree {
    nodes: HashMap<String, RetainedNode>,
    order: Vec<String>,
    next_instance_id: u64,
    revision: u64,
}

impl RetainedTree {
    pub fn node(&self, id: &str) -> Option<&RetainedNode> {
        self.nodes.get(id)
    }

    pub fn root(&self) -> Option<&RetainedNode> {
        self.order.first().and_then(|id| self.nodes.get(id))
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn iter(&self) -> impl Iterator<Item = &RetainedNode> {
        self.order.iter().filter_map(|id| self.nodes.get(id))
    }

    fn allocate_instance_id(&mut self) -> u64 {
        let next = self.next_instance_id.max(1);
        self.next_instance_id = next.saturating_add(1);
        next
    }

    pub(crate) fn reconcile(
        &mut self,
        specs: Vec<RetainedNodeSpec>,
    ) -> Result<RetainedReconciliation, RetainedTreeError> {
        let mut seen = HashSet::with_capacity(specs.len());
        for spec in &specs {
            if !seen.insert(spec.id.clone()) {
                return Err(RetainedTreeError::DuplicateIdentity(spec.id.clone()));
            }
        }

        let previous_nodes = std::mem::take(&mut self.nodes);
        let previous_order = std::mem::take(&mut self.order);
        let mut next_nodes = HashMap::with_capacity(specs.len());
        let mut next_order = Vec::with_capacity(specs.len());
        let mut diff = RetainedReconciliation::default();
        let mut identity_resets = HashSet::with_capacity(specs.len());

        for spec in specs {
            let id = spec.id.clone();
            next_order.push(id.clone());
            let ancestor_reset = spec
                .parent
                .as_ref()
                .is_some_and(|parent| identity_resets.contains(parent));

            let node = match previous_nodes.get(&id) {
                Some(previous)
                    if !ancestor_reset
                        && previous.kind == spec.kind
                        && previous.identity_key == spec.identity_key =>
                {
                    diff.retained.push(id.clone());
                    if previous.parent != spec.parent {
                        diff.reparented.push(id.clone());
                    }
                    if previous.children != spec.children {
                        diff.children_changed.push(id.clone());
                    }
                    RetainedNode {
                        id: id.clone(),
                        kind: spec.kind,
                        identity_key: spec.identity_key.clone(),
                        instance_id: previous.instance_id,
                        parent: spec.parent,
                        children: spec.children,
                    }
                }
                Some(_) => {
                    diff.replaced.push(id.clone());
                    identity_resets.insert(id.clone());
                    RetainedNode {
                        id: id.clone(),
                        kind: spec.kind,
                        identity_key: spec.identity_key.clone(),
                        instance_id: self.allocate_instance_id(),
                        parent: spec.parent,
                        children: spec.children,
                    }
                }
                None => {
                    diff.inserted.push(id.clone());
                    identity_resets.insert(id.clone());
                    RetainedNode {
                        id: id.clone(),
                        kind: spec.kind,
                        identity_key: spec.identity_key.clone(),
                        instance_id: self.allocate_instance_id(),
                        parent: spec.parent,
                        children: spec.children,
                    }
                }
            };
            next_nodes.insert(id, node);
        }

        for id in previous_order {
            if !next_nodes.contains_key(&id) {
                diff.removed.push(id);
            }
        }

        self.nodes = next_nodes;
        self.order = next_order;
        if !diff.is_empty() {
            self.revision = self.revision.saturating_add(1);
        }
        Ok(diff)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(
        id: &str,
        kind: RetainedNodeKind,
        parent: Option<&str>,
        children: &[&str],
    ) -> RetainedNodeSpec {
        RetainedNodeSpec::new(
            id,
            kind,
            parent.map(str::to_owned),
            children.iter().map(|child| (*child).to_owned()).collect(),
        )
    }

    fn keyed_text_spec(id: &str, key: RetainedIdentityKey) -> RetainedNodeSpec {
        let mut spec = spec(id, RetainedNodeKind::Text, None, &[]);
        spec.identity_key = Some(key);
        spec
    }

    #[test]
    fn stable_identity_survives_sibling_insertion() {
        let mut tree = RetainedTree::default();
        tree.reconcile(vec![
            spec("window", RetainedNodeKind::Window, None, &["stack"]),
            spec("stack", RetainedNodeKind::Column, Some("window"), &["a"]),
            spec("a", RetainedNodeKind::Text, Some("stack"), &[]),
        ])
        .expect("initial reconciliation");
        let original = tree.node("a").expect("a").instance_id;

        let diff = tree
            .reconcile(vec![
                spec("window", RetainedNodeKind::Window, None, &["stack"]),
                spec(
                    "stack",
                    RetainedNodeKind::Column,
                    Some("window"),
                    &["b", "a"],
                ),
                spec("b", RetainedNodeKind::Text, Some("stack"), &[]),
                spec("a", RetainedNodeKind::Text, Some("stack"), &[]),
            ])
            .expect("insert sibling");

        assert_eq!(tree.node("a").expect("a").instance_id, original);
        assert_eq!(diff.inserted, vec!["b"]);
        assert!(diff.retained.iter().any(|id| id == "a"));
        assert_eq!(diff.children_changed, vec!["stack"]);
    }

    #[test]
    fn conditional_is_retained_without_creating_a_layout_box() {
        let mut tree = RetainedTree::default();
        tree.reconcile(vec![
            spec("window", RetainedNodeKind::Window, None, &["branch"]),
            spec(
                "branch",
                RetainedNodeKind::Conditional,
                Some("window"),
                &["collapsed"],
            ),
            spec("collapsed", RetainedNodeKind::Action, Some("branch"), &[]),
        ])
        .expect("initial branch");
        let branch_instance = tree.node("branch").expect("branch").instance_id;

        let diff = tree
            .reconcile(vec![
                spec("window", RetainedNodeKind::Window, None, &["branch"]),
                spec(
                    "branch",
                    RetainedNodeKind::Conditional,
                    Some("window"),
                    &["expanded"],
                ),
                spec("expanded", RetainedNodeKind::Action, Some("branch"), &[]),
            ])
            .expect("switch branch");

        let branch = tree.node("branch").expect("branch");
        assert_eq!(branch.instance_id, branch_instance);
        assert!(!branch.has_layout_box());
        assert_eq!(diff.inserted, vec!["expanded"]);
        assert_eq!(diff.removed, vec!["collapsed"]);
        assert_eq!(diff.children_changed, vec!["branch"]);
    }

    #[test]
    fn semantic_kind_change_is_an_explicit_replacement() {
        let mut tree = RetainedTree::default();
        tree.reconcile(vec![spec("node", RetainedNodeKind::Text, None, &[])])
            .expect("text");
        let first = tree.node("node").expect("node").instance_id;

        let diff = tree
            .reconcile(vec![spec("node", RetainedNodeKind::Action, None, &[])])
            .expect("replacement");

        assert_eq!(diff.replaced, vec!["node"]);
        assert_ne!(tree.node("node").expect("node").instance_id, first);
    }

    #[test]
    fn stable_semantic_identity_key_preserves_instance_and_revision() {
        let mut tree = RetainedTree::default();
        let key = RetainedIdentityKey::String("hero".to_owned());
        tree.reconcile(vec![keyed_text_spec("node", key.clone())])
            .expect("initial keyed identity");
        let instance = tree.node("node").expect("node").instance_id;
        let revision = tree.revision();

        let diff = tree
            .reconcile(vec![keyed_text_spec("node", key.clone())])
            .expect("same keyed identity");

        let node = tree.node("node").expect("node");
        assert_eq!(node.instance_id, instance);
        assert_eq!(node.identity_key, Some(key));
        assert_eq!(diff.retained, vec!["node"]);
        assert!(diff.is_empty());
        assert_eq!(tree.revision(), revision);
    }

    #[test]
    fn changed_semantic_identity_key_replaces_instance_at_same_anchor() {
        let mut tree = RetainedTree::default();
        tree.reconcile(vec![keyed_text_spec(
            "node",
            RetainedIdentityKey::String("alpha".to_owned()),
        )])
        .expect("initial keyed identity");
        let instance = tree.node("node").expect("node").instance_id;
        let revision = tree.revision();

        let diff = tree
            .reconcile(vec![keyed_text_spec(
                "node",
                RetainedIdentityKey::String("beta".to_owned()),
            )])
            .expect("changed keyed identity");

        let node = tree.node("node").expect("node");
        assert_ne!(node.instance_id, instance);
        assert_eq!(
            node.identity_key,
            Some(RetainedIdentityKey::String("beta".to_owned()))
        );
        assert_eq!(diff.replaced, vec!["node"]);
        assert_eq!(tree.revision(), revision + 1);
    }

    #[test]
    fn changed_parent_identity_key_replaces_descendants_but_not_siblings() {
        let mut tree = RetainedTree::default();
        let mut keyed_parent = spec(
            "keyed-parent",
            RetainedNodeKind::Column,
            Some("root"),
            &["child"],
        );
        keyed_parent.identity_key = Some(RetainedIdentityKey::String("alpha".to_owned()));
        tree.reconcile(vec![
            spec(
                "root",
                RetainedNodeKind::Window,
                None,
                &["keyed-parent", "stable-sibling"],
            ),
            keyed_parent,
            spec("child", RetainedNodeKind::Text, Some("keyed-parent"), &[]),
            spec("stable-sibling", RetainedNodeKind::Text, Some("root"), &[]),
        ])
        .expect("initial keyed subtree");

        let parent_instance = tree.node("keyed-parent").expect("keyed parent").instance_id;
        let child_instance = tree.node("child").expect("child").instance_id;
        let sibling_instance = tree
            .node("stable-sibling")
            .expect("stable sibling")
            .instance_id;

        let mut changed_parent = spec(
            "keyed-parent",
            RetainedNodeKind::Column,
            Some("root"),
            &["child"],
        );
        changed_parent.identity_key = Some(RetainedIdentityKey::String("beta".to_owned()));
        let diff = tree
            .reconcile(vec![
                spec(
                    "root",
                    RetainedNodeKind::Window,
                    None,
                    &["keyed-parent", "stable-sibling"],
                ),
                changed_parent,
                spec("child", RetainedNodeKind::Text, Some("keyed-parent"), &[]),
                spec("stable-sibling", RetainedNodeKind::Text, Some("root"), &[]),
            ])
            .expect("changed keyed subtree");

        assert_ne!(
            tree.node("keyed-parent").expect("keyed parent").instance_id,
            parent_instance
        );
        assert_ne!(
            tree.node("child").expect("child").instance_id,
            child_instance
        );
        assert_eq!(
            tree.node("stable-sibling")
                .expect("stable sibling")
                .instance_id,
            sibling_instance
        );
        assert_eq!(diff.replaced, vec!["keyed-parent", "child"]);
        assert_eq!(diff.retained, vec!["root", "stable-sibling"]);
        assert!(diff.inserted.is_empty());
        assert!(diff.removed.is_empty());
    }

    #[test]
    fn string_and_number_identity_keys_are_distinct() {
        let string =
            RetainedIdentityKey::from_value(&serde_json::json!("1")).expect("string identity key");
        let integer =
            RetainedIdentityKey::from_value(&serde_json::json!(1)).expect("integer identity key");
        let float =
            RetainedIdentityKey::from_value(&serde_json::json!(1.0)).expect("float identity key");
        let zero =
            RetainedIdentityKey::from_value(&serde_json::json!(0)).expect("zero identity key");
        let negative_zero = RetainedIdentityKey::from_value(&serde_json::json!(-0.0))
            .expect("negative zero identity key");

        assert_ne!(string, integer);
        assert_eq!(integer, float);
        assert_eq!(zero, negative_zero);
        assert!(RetainedIdentityKey::from_value(&serde_json::json!(true)).is_none());
    }

    #[test]
    fn child_reordering_preserves_instances() {
        let mut tree = RetainedTree::default();
        tree.reconcile(vec![
            spec("row", RetainedNodeKind::Row, None, &["a", "b"]),
            spec("a", RetainedNodeKind::Text, Some("row"), &[]),
            spec("b", RetainedNodeKind::Text, Some("row"), &[]),
        ])
        .expect("initial row");
        let a = tree.node("a").expect("a").instance_id;
        let b = tree.node("b").expect("b").instance_id;

        let diff = tree
            .reconcile(vec![
                spec("row", RetainedNodeKind::Row, None, &["b", "a"]),
                spec("b", RetainedNodeKind::Text, Some("row"), &[]),
                spec("a", RetainedNodeKind::Text, Some("row"), &[]),
            ])
            .expect("reordered row");

        assert_eq!(tree.node("a").expect("a").instance_id, a);
        assert_eq!(tree.node("b").expect("b").instance_id, b);
        assert_eq!(diff.children_changed, vec!["row"]);
        assert!(diff.inserted.is_empty());
        assert!(diff.removed.is_empty());
    }

    #[test]
    fn duplicate_active_semantic_identity_is_rejected() {
        let mut tree = RetainedTree::default();
        let error = tree
            .reconcile(vec![
                spec("same", RetainedNodeKind::Text, None, &[]),
                spec("same", RetainedNodeKind::Text, None, &[]),
            ])
            .expect_err("duplicate identity must fail");

        assert_eq!(
            error,
            RetainedTreeError::DuplicateIdentity("same".to_owned())
        );
    }
}
